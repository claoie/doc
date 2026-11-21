import { createHash, createHmac } from "node:crypto";

/**
 * A fake S3-compatible object store for the servers under test
 * (`STORAGE_DRIVER=s3`). Objects live in memory and every request is
 * recorded, so a test can check both what ended up stored and how the server
 * talked to the store.
 *
 * It is tolerant about how a correct client may talk to it (one PUT or a
 * multipart upload, server-side copy or read-and-write, signed or unsigned
 * payloads, `aws-chunked` bodies, single or batch deletes) and strict about
 * what S3 itself insists on: path-style addressing of the configured bucket,
 * an `Authorization: AWS4-HMAC-SHA256` header whose credential scope names the
 * configured access key, region and the `s3` service, `x-amz-date` (within 15
 * minutes of now), `x-amz-content-sha256`, a correct Signature Version 4
 * signature, a payload matching its declared hash, parts of at least 5 MiB
 * (except the last) and matching part ETags when a multipart upload is
 * completed.
 */

export interface S3Request {
  method: string;
  /** The path as sent, e.g. `/bucket/files/<id>/a%20b.txt`. */
  path: string;
  /** The decoded object key, or null for a request on the bucket itself. */
  key: string | null;
  /** Decoded query parameters. */
  query: Record<string, string>;
  /** Request headers, lower-cased names. */
  headers: Record<string, string>;
  /** Size of the request payload after decoding `aws-chunked`. */
  bodySize: number;
  /** What the request was understood as, e.g. `PutObject`, `UploadPart`, `GetObject`. */
  operation: string;
  /** The status answered. */
  status: number;
  /** The S3 error code answered, when the request failed. */
  error?: string;
}

export interface S3Object {
  body: Uint8Array;
  contentType: string | null;
  etag: string;
  lastModified: Date;
  /** How the object came to be: one PUT, a completed multipart upload or a server-side copy. */
  via: "put" | "multipart" | "copy";
}

export interface FakeS3Options {
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface FakeS3 {
  port: number;
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Environment that points a server under test at this store. */
  env: Record<string, string>;
  /** Stored objects by key. */
  objects: Map<string, S3Object>;
  /** Multipart uploads that were started and neither completed nor aborted. */
  pendingUploads(): { uploadId: string; key: string; parts: number[] }[];
  /** Every request received, in order. */
  requests: S3Request[];
  /** Keys of the stored objects, sorted. */
  keys(): string[];
  /** The bytes stored under `key`, or null. */
  read(key: string): Uint8Array | null;
  /** Forgets the recorded requests (objects stay). */
  clearRequests(): void;
  /** The next `count` requests matching `match` (default: all) fail with this status and S3 error code. */
  failNext(count: number, status?: number, code?: string, match?: (request: { method: string; key: string | null }) => boolean): void;
  stop(): Promise<void>;
}

const MIN_PART = 5 * 1024 * 1024;

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const md5 = (data: Uint8Array) => createHash("md5").update(data).digest();
const hmac = (key: Uint8Array | string, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as Signature Version 4 wants it: everything but unreserved characters, upper-case hex. */
const awsEncode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const decodeSegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const xmlUnescape = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Decodes an `aws-chunked` body: `<hex size>[;chunk-signature=…]\r\n<data>\r\n … 0…\r\n[trailers]\r\n`. */
const decodeAwsChunked = (body: Uint8Array): Uint8Array => {
  const parts: Uint8Array[] = [];
  let at = 0;
  for (;;) {
    let lineEnd = at;
    while (lineEnd + 1 < body.length && !(body[lineEnd] === 13 && body[lineEnd + 1] === 10)) lineEnd++;
    if (lineEnd + 1 >= body.length) throw new S3Error(400, "IncompleteBody", "The aws-chunked body is cut short");
    const header = new TextDecoder().decode(body.subarray(at, lineEnd));
    const size = parseInt(header.split(";")[0]!.trim(), 16);
    if (!Number.isFinite(size) || size < 0) throw new S3Error(400, "IncompleteBody", "The aws-chunked body has an invalid chunk size");
    at = lineEnd + 2;
    if (size === 0) break;
    if (at + size + 2 > body.length) throw new S3Error(400, "IncompleteBody", "The aws-chunked body is cut short");
    parts.push(body.subarray(at, at + size));
    at += size + 2;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

interface Upload {
  key: string;
  contentType: string | null;
  parts: Map<number, { body: Uint8Array; etag: string }>;
}

export const startFakeS3 = async (options: FakeS3Options = {}): Promise<FakeS3> => {
  const bucket = options.bucket ?? "doc-test-bucket";
  const region = options.region ?? "test-region-1";
  const accessKeyId = options.accessKeyId ?? "AKIDTESTDOC0000001";
  const secretAccessKey = options.secretAccessKey ?? "test+secret/Key0123456789abcdefABCDEFGH";

  const objects = new Map<string, S3Object>();
  const uploads = new Map<string, Upload>();
  const requests: S3Request[] = [];
  let failures: { count: number; status: number; code: string; match: (request: { method: string; key: string | null }) => boolean }[] = [];
  let nextUpload = 1;

  const verifySignature = (req: Request, rawPath: string, rawQuery: string, headers: Record<string, string>, body: Uint8Array) => {
    const authorization = headers.authorization;
    if (!authorization) throw new S3Error(403, "AccessDenied", "Anonymous access is forbidden for this operation");
    const match = /^AWS4-HMAC-SHA256\s+(.*)$/.exec(authorization);
    if (!match) throw new S3Error(400, "InvalidArgument", "Unsupported Authorization type; only AWS4-HMAC-SHA256 is supported");
    const fields: Record<string, string> = {};
    for (const part of match[1]!.split(",")) {
      const eq = part.indexOf("=");
      if (eq > 0) fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    const { Credential: credential, SignedHeaders: signedHeaders, Signature: signature } = fields;
    if (!credential || !signedHeaders || !signature) {
      throw new S3Error(400, "AuthorizationHeaderMalformed", "The Authorization header needs Credential, SignedHeaders and Signature");
    }
    const scope = credential.split("/");
    if (scope.length !== 5) throw new S3Error(400, "AuthorizationHeaderMalformed", "The credential scope is malformed");
    const [key, date, scopeRegion, service, terminator] = scope as [string, string, string, string, string];
    if (key !== accessKeyId) throw new S3Error(403, "InvalidAccessKeyId", "The access key id does not exist");
    if (scopeRegion !== region) {
      throw new S3Error(400, "AuthorizationHeaderMalformed", `The region '${scopeRegion}' is wrong; expecting '${region}'`);
    }
    if (service !== "s3" || terminator !== "aws4_request") {
      throw new S3Error(400, "AuthorizationHeaderMalformed", "The credential scope must end in s3/aws4_request");
    }
    const amzDate = headers["x-amz-date"];
    if (!amzDate || !/^\d{8}T\d{6}Z$/.test(amzDate)) {
      throw new S3Error(403, "AccessDenied", "A valid x-amz-date header (YYYYMMDD'T'HHMMSS'Z') is required");
    }
    if (amzDate.slice(0, 8) !== date) throw new S3Error(403, "SignatureDoesNotMatch", "The credential date does not match x-amz-date");
    const sent = Date.UTC(
      Number(amzDate.slice(0, 4)),
      Number(amzDate.slice(4, 6)) - 1,
      Number(amzDate.slice(6, 8)),
      Number(amzDate.slice(9, 11)),
      Number(amzDate.slice(11, 13)),
      Number(amzDate.slice(13, 15)),
    );
    if (Math.abs(Date.now() - sent) > 15 * 60_000) {
      throw new S3Error(403, "RequestTimeTooSkewed", "The difference between the request time and the current time is too large");
    }
    const contentHash = headers["x-amz-content-sha256"];
    if (!contentHash) throw new S3Error(400, "InvalidRequest", "Missing required header for this request: x-amz-content-sha256");
    const signed = signedHeaders.split(";").map((name) => name.trim().toLowerCase());
    if (!signed.includes("host")) throw new S3Error(403, "AccessDenied", "The host header must be signed");
    for (const name of Object.keys(headers)) {
      if (name.startsWith("x-amz-") && !signed.includes(name)) {
        throw new S3Error(403, "AccessDenied", `There were headers present in the request which were not signed: ${name}`);
      }
    }
    for (const name of signed) {
      if (headers[name] === undefined) throw new S3Error(403, "SignatureDoesNotMatch", `The signed header ${name} is missing from the request`);
    }

    const segments = rawPath.split("/").map(decodeSegment);
    if (segments.includes(null)) throw new S3Error(400, "InvalidURI", "Couldn't parse the specified URI");
    const canonicalUri = (segments as string[]).map(awsEncode).join("/");
    const canonicalQuery = rawQuery
      .split("&")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        const name = decodeSegment((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " ")) ?? "";
        const value = decodeSegment((eq < 0 ? "" : pair.slice(eq + 1)).replace(/\+/g, " ")) ?? "";
        return [awsEncode(name), awsEncode(value)] as const;
      })
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
      .map(([name, value]) => `${name}=${value}`)
      .join("&");
    const sortedSigned = [...signed].sort();
    const canonicalHeaders = sortedSigned.map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join("");
    const canonicalRequest = [req.method, canonicalUri, canonicalQuery, canonicalHeaders, sortedSigned.join(";"), contentHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, `${date}/${region}/s3/aws4_request`, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"), "aws4_request");
    const expected = hmac(signingKey, stringToSign).toString("hex");
    if (expected !== signature.toLowerCase()) {
      throw new S3Error(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided");
    }

    if (/^[0-9a-f]{64}$/i.test(contentHash)) {
      if (sha256Hex(body) !== contentHash.toLowerCase()) {
        throw new S3Error(400, "XAmzContentSHA256Mismatch", "The provided 'x-amz-content-sha256' header does not match what was computed");
      }
      return body;
    }
    if (contentHash === "UNSIGNED-PAYLOAD") return body;
    if (contentHash.startsWith("STREAMING-")) {
      const decoded = decodeAwsChunked(body);
      const declared = headers["x-amz-decoded-content-length"];
      if (declared !== undefined && Number(declared) !== decoded.length) {
        throw new S3Error(400, "IncompleteBody", "The decoded body does not have the length given in x-amz-decoded-content-length");
      }
      return decoded;
    }
    throw new S3Error(400, "InvalidArgument", "x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a STREAMING- mode or a valid sha256 value");
  };

  const xml = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { status, headers: { "Content-Type": "application/xml", ...headers } });

  const objectHeaders = (object: S3Object): Record<string, string> => ({
    ETag: object.etag,
    "Last-Modified": object.lastModified.toUTCString(),
    "Accept-Ranges": "bytes",
    ...(object.contentType ? { "Content-Type": object.contentType } : {}),
  });

  const copySource = (headers: Record<string, string>): S3Object | null => {
    const raw = headers["x-amz-copy-source"];
    if (raw === undefined) return null;
    const decoded = decodeSegment(raw.split("?")[0]!) ?? "";
    const source = decoded.replace(/^\//, "");
    if (!source.startsWith(`${bucket}/`)) throw new S3Error(404, "NoSuchBucket", "The specified source bucket does not exist");
    const object = objects.get(source.slice(bucket.length + 1));
    if (!object) throw new S3Error(404, "NoSuchKey", "The specified source key does not exist.");
    return object;
  };

  const rangeOf = (header: string | undefined, size: number): { start: number; end: number } | null => {
    if (!header) return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return null;
    let start: number;
    let end: number;
    if (!match[1]) {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) throw new S3Error(416, "InvalidRange", "The requested range is not satisfiable");
    return { start, end };
  };

  const handle = (
    method: string,
    key: string | null,
    query: Record<string, string>,
    headers: Record<string, string>,
    body: Uint8Array,
    record: S3Request,
  ): Response => {
    if (key === null) {
      if (method === "HEAD") {
        record.operation = "HeadBucket";
        return new Response(null, { status: 200, headers: { "x-amz-bucket-region": region } });
      }
      if (method === "GET") {
        record.operation = "ListObjects";
        const prefix = query.prefix ?? "";
        const contents = [...objects.keys()]
          .filter((k) => k.startsWith(prefix))
          .sort()
          .map((k) => {
            const o = objects.get(k)!;
            return `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>${xmlEscape(o.etag)}</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          });
        return xml(
          200,
          `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`,
        );
      }
      if (method === "POST" && "delete" in query) {
        record.operation = "DeleteObjects";
        const text = new TextDecoder().decode(body);
        const keys = [...text.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => xmlUnescape(m[1]!));
        for (const k of keys) objects.delete(k);
        const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(text);
        return xml(
          200,
          `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${quiet ? "" : keys.map((k) => `<Deleted><Key>${xmlEscape(k)}</Key></Deleted>`).join("")}</DeleteResult>`,
        );
      }
      throw new S3Error(405, "MethodNotAllowed", "The specified method is not allowed against this resource.");
    }

    if (method === "POST" && "uploads" in query) {
      record.operation = "CreateMultipartUpload";
      const uploadId = `upload-${nextUpload++}-${crypto.randomUUID()}`;
      uploads.set(uploadId, { key, contentType: headers["content-type"] ?? null, parts: new Map() });
      return xml(
        200,
        `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }

    if (query.uploadId !== undefined) {
      const upload = uploads.get(query.uploadId);
      if (!upload || upload.key !== key) {
        record.operation = "Multipart";
        throw new S3Error(404, "NoSuchUpload", "The specified upload does not exist. The upload ID may be invalid, or the upload may have been aborted or completed.");
      }
      if (method === "PUT" && query.partNumber !== undefined) {
        const source = copySource(headers);
        record.operation = source ? "UploadPartCopy" : "UploadPart";
        const number = Number(query.partNumber);
        if (!Number.isInteger(number) || number < 1 || number > 10_000) {
          throw new S3Error(400, "InvalidArgument", "Part number must be an integer between 1 and 10000, inclusive");
        }
        let data = body;
        if (source) {
          const range = rangeOf(headers["x-amz-copy-source-range"], source.body.length);
          data = range ? source.body.slice(range.start, range.end + 1) : source.body;
        }
        const etag = `"${md5(data).toString("hex")}"`;
        upload.parts.set(number, { body: data, etag });
        if (source) return xml(200, `<CopyPartResult><ETag>${xmlEscape(etag)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyPartResult>`);
        return new Response(null, { status: 200, headers: { ETag: etag } });
      }
      if (method === "POST") {
        record.operation = "CompleteMultipartUpload";
        const text = new TextDecoder().decode(body);
        const listed = [...text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
          number: Number(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(m[1]!)?.[1]),
          etag: xmlUnescape(/<ETag>([\s\S]*?)<\/ETag>/.exec(m[1]!)?.[1] ?? "").trim().replace(/^"|"$/g, ""),
        }));
        if (listed.length === 0) throw new S3Error(400, "MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema");
        const chosen: Uint8Array[] = [];
        let previous = 0;
        for (const [index, part] of listed.entries()) {
          if (!(part.number > previous)) throw new S3Error(400, "InvalidPartOrder", "The list of parts was not in ascending order.");
          previous = part.number;
          const stored = upload.parts.get(part.number);
          if (!stored || stored.etag.replace(/"/g, "") !== part.etag) {
            throw new S3Error(400, "InvalidPart", "One or more of the specified parts could not be found, or the entity tag did not match.");
          }
          if (index < listed.length - 1 && stored.body.length < MIN_PART) {
            throw new S3Error(400, "EntityTooSmall", "Your proposed upload is smaller than the minimum allowed size");
          }
          chosen.push(stored.body);
        }
        const whole = new Uint8Array(chosen.reduce((n, p) => n + p.length, 0));
        let offset = 0;
        for (const part of chosen) {
          whole.set(part, offset);
          offset += part.length;
        }
        const digest = createHash("md5");
        for (const part of chosen) digest.update(md5(part));
        const etag = `"${digest.digest("hex")}-${chosen.length}"`;
        objects.set(key, { body: whole, contentType: upload.contentType, etag, lastModified: new Date(), via: "multipart" });
        uploads.delete(query.uploadId);
        return xml(
          200,
          `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>http://127.0.0.1/${bucket}/${xmlEscape(key)}</Location><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(etag)}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      if (method === "DELETE") {
        record.operation = "AbortMultipartUpload";
        uploads.delete(query.uploadId);
        return new Response(null, { status: 204 });
      }
      if (method === "GET") {
        record.operation = "ListParts";
        const parts = [...upload.parts.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([number, part]) => `<Part><PartNumber>${number}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag><Size>${part.body.length}</Size></Part>`);
        return xml(200, `<ListPartsResult><Bucket>${bucket}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${query.uploadId}</UploadId>${parts.join("")}</ListPartsResult>`);
      }
      throw new S3Error(405, "MethodNotAllowed", "The specified method is not allowed against this resource.");
    }

    if (method === "PUT") {
      const source = copySource(headers);
      if (source) {
        record.operation = "CopyObject";
        const copy: S3Object = {
          body: source.body.slice(),
          contentType: headers["x-amz-metadata-directive"]?.toUpperCase() === "REPLACE" ? (headers["content-type"] ?? null) : source.contentType,
          etag: source.etag,
          lastModified: new Date(),
          via: "copy",
        };
        objects.set(key, copy);
        return xml(200, `<CopyObjectResult><LastModified>${copy.lastModified.toISOString()}</LastModified><ETag>${xmlEscape(copy.etag)}</ETag></CopyObjectResult>`);
      }
      record.operation = "PutObject";
      const etag = `"${md5(body).toString("hex")}"`;
      objects.set(key, { body, contentType: headers["content-type"] ?? null, etag, lastModified: new Date(), via: "put" });
      return new Response(null, { status: 200, headers: { ETag: etag } });
    }

    if (method === "GET" || method === "HEAD") {
      record.operation = method === "GET" ? "GetObject" : "HeadObject";
      const object = objects.get(key);
      if (!object) throw new S3Error(404, "NoSuchKey", "The specified key does not exist.");
      const range = rangeOf(headers.range, object.body.length);
      if (range) {
        return new Response(object.body.slice(range.start, range.end + 1), {
          status: 206,
          headers: { ...objectHeaders(object), "Content-Range": `bytes ${range.start}-${range.end}/${object.body.length}` },
        });
      }
      return new Response(object.body.slice(), { status: 200, headers: objectHeaders(object) });
    }

    if (method === "DELETE") {
      record.operation = "DeleteObject";
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    throw new S3Error(405, "MethodNotAllowed", "The specified method is not allowed against this resource.");
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    maxRequestBodySize: 512 * 1024 * 1024,
    async fetch(req) {
      const target = req.url.replace(/^[a-z]+:\/\/[^/]*/i, "");
      const question = target.indexOf("?");
      const rawPath = question < 0 ? target : target.slice(0, question);
      const rawQuery = question < 0 ? "" : target.slice(question + 1);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, name) => (headers[name.toLowerCase()] = value));
      const query: Record<string, string> = {};
      for (const pair of rawQuery.split("&").filter(Boolean)) {
        const eq = pair.indexOf("=");
        const name = decodeSegment((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, " ")) ?? "";
        query[name] = decodeSegment((eq < 0 ? "" : pair.slice(eq + 1)).replace(/\+/g, " ")) ?? "";
      }
      const record: S3Request = { method: req.method, path: rawPath, key: null, query, headers, bodySize: 0, operation: "Unknown", status: 0 };
      requests.push(record);
      const head = req.method === "HEAD";
      try {
        const raw = new Uint8Array(await req.arrayBuffer());
        record.bodySize = raw.length;
        const decodedPath = rawPath.split("/").map(decodeSegment);
        if (decodedPath.includes(null)) throw new S3Error(400, "InvalidURI", "Couldn't parse the specified URI");
        const [, requestBucket, ...rest] = decodedPath as string[];
        const key = rest.length && rest.join("/") !== "" ? rest.join("/") : null;
        record.key = key;
        const failure = failures.find((f) => f.match({ method: req.method, key }));
        if (failure) {
          if (--failure.count <= 0) failures = failures.filter((f) => f !== failure);
          record.operation = "Failed";
          throw new S3Error(failure.status, failure.code, "The fake store was told to fail this request");
        }
        const body = verifySignature(req, rawPath, rawQuery, headers, raw);
        record.bodySize = body.length;
        if (requestBucket !== bucket) throw new S3Error(404, "NoSuchBucket", "The specified bucket does not exist");
        const response = handle(req.method, key, query, headers, body, record);
        record.status = response.status;
        return response;
      } catch (error) {
        if (!(error instanceof S3Error)) throw error;
        record.status = error.status;
        record.error = error.code;
        if (head) return new Response(null, { status: error.status });
        return xml(
          error.status,
          `<Error><Code>${error.code}</Code><Message>${xmlEscape(error.message)}</Message><Resource>${xmlEscape(rawPath)}</Resource><RequestId>FAKE${requests.length}</RequestId></Error>`,
        );
      }
    },
  });

  const port = server.port!;
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    port,
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    env: {
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: endpoint,
      S3_BUCKET: bucket,
      S3_REGION: region,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_FORCE_PATH_STYLE: "true",
    },
    objects,
    pendingUploads: () => [...uploads].map(([uploadId, upload]) => ({ uploadId, key: upload.key, parts: [...upload.parts.keys()].sort((a, b) => a - b) })),
    requests,
    keys: () => [...objects.keys()].sort(),
    read: (key) => objects.get(key)?.body ?? null,
    clearRequests() {
      requests.length = 0;
    },
    failNext(count, status = 500, code = "InternalError", match = () => true) {
      failures.push({ count, status, code, match });
    },
    async stop() {
      await server.stop(true);
    },
  };
};
