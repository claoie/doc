import { useState } from "react";
import type { Space } from "common/api-types";
import type { Node } from "common/editor/model";
import { markdownToDoc } from "common/editor/markdown";
import { readZip, type ZipEntry } from "common/unzip";
import { schema } from "common/editor/doc-schema";
import { HtmlParser } from "../../editor/parse-html";
import { api } from "../api";
import { navigate, pageUrl } from "../router";
import { treeCache } from "../store";
import { Button, Modal, errorMessage, useToast } from "../components/ui";
import { mapNodes } from "./import-utils";

interface Source {
  path: string;
  title: string;
  kind: "md" | "html" | "folder";
  text?: string;
}

const EXPORT_ID_SUFFIX = /\s+[0-9a-f]{32}$/i;

const cleanName = (name: string) =>
  name
    .replace(/\.(md|markdown|html?)$/i, "")
    .replace(EXPORT_ID_SUFFIX, "")
    .trim() || "Untitled";

const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const resolvePath = (base: string, rel: string) => {
  const parts = (base ? base.split("/") : []).concat(decodeURIComponent(rel.split(/[?#]/)[0]!).split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};

/** Parses a file into a document, taking a leading H1 as the title. */
const parseDoc = (source: Source): { title: string; doc: Node } => {
  const doc = source.kind === "md" ? markdownToDoc(source.text ?? "") : { type: "doc", content: new HtmlParser(schema).parse(source.text ?? "") };
  const content = doc.content ?? [];
  let title = source.title;
  const first = content[0];
  if (first?.type === "heading" && Number(first.attrs?.level) === 1) {
    title = (first.content ?? []).map((c) => c.text ?? "").join("").trim() || title;
    content.shift();
  }
  if (!content.length) content.push(schema.node("paragraph"));
  return { title, doc: { type: "doc", content } };
};

export const ImportDialog = ({ space, onClose }: { space: Space; onClose: () => void }) => {
  const toast = useToast();
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (files: File[]) => {
    setBusy(true);
    try {
      const sources: Source[] = [];
      const assets = new Map<string, ZipEntry | File>();
      for (const file of files) {
        if (/\.zip$/i.test(file.name)) {
          const entries = readZip(await file.arrayBuffer());
          for (const entry of entries) {
            if (/\.(md|markdown|html?)$/i.test(entry.name)) {
              const text = new TextDecoder().decode(await entry.read());
              sources.push({ path: entry.name, title: cleanName(entry.name.split("/").pop()!), kind: /\.html?$/i.test(entry.name) ? "html" : "md", text });
            } else if (!entry.name.endsWith(".json")) {
              assets.set(entry.name, entry);
            }
          }
        } else if (/\.(md|markdown|html?|txt)$/i.test(file.name)) {
          sources.push({ path: file.name, title: cleanName(file.name), kind: /\.html?$/i.test(file.name) ? "html" : "md", text: await file.text() });
        } else {
          assets.set(file.name, file);
        }
      }
      if (!sources.length) {
        toast("No Markdown or HTML files found", "error");
        return;
      }

      // Drop a single wrapping folder that every file shares.
      const firstSegments = new Set(sources.map((s) => s.path.split("/")[0]));
      const strip = firstSegments.size === 1 && sources.every((s) => s.path.includes("/")) ? `${[...firstSegments][0]}/` : "";
      const norm = (p: string) => (strip && p.startsWith(strip) ? p.slice(strip.length) : p);

      // Folders without a matching file become placeholder pages.
      const pagePaths = new Map<string, Source>();
      const keyOfFile = new Map<string, string>();
      for (const s of sources) {
        const stem = norm(s.path).replace(/\.(md|markdown|html?)$/i, "");
        // name.md and name.html both import; only the first one owns the folder name.
        const key = pagePaths.has(stem) ? norm(s.path) : stem;
        pagePaths.set(key, s);
        keyOfFile.set(norm(s.path), key);
      }
      for (const s of sources) {
        let dir = dirname(norm(s.path));
        while (dir) {
          if (!pagePaths.has(dir)) pagePaths.set(dir, { path: dir, title: cleanName(dir.split("/").pop()!), kind: "folder" });
          dir = dirname(dir);
        }
      }
      const keys = [...pagePaths.keys()].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      const created = new Map<string, { id: string; slugId: string; title: string }>();
      const docs = new Map<string, Node>();
      let first: { slugId: string; title: string } | null = null;
      let done = 0;
      for (const key of keys) {
        const source = pagePaths.get(key)!;
        const parent = created.get(dirname(key));
        const parsed = source.kind === "folder" ? { title: source.title, doc: undefined } : parseDoc(source);
        setProgress(`Importing ${++done} of ${keys.length}: ${parsed.title}`);
        const { page } = await api.createPage({ spaceId: space.id, parentId: parent?.id ?? null, title: parsed.title });
        created.set(key, { id: page.id, slugId: page.slugId, title: parsed.title });
        if (!first) first = { slugId: page.slugId, title: parsed.title };
        if (!parsed.doc) continue;
        // Upload referenced files and rewrite their URLs.
        const base = dirname(source.path);
        const doc = await mapNodes(parsed.doc, async (node) => {
          const attr = node.type === "attachment" ? "url" : "src";
          const src = node.attrs?.[attr];
          if (typeof src !== "string" || !src || /^(https?:|data:|\/api\/)/.test(src)) return node;
          const asset = assets.get(resolvePath(base, src)) ?? assets.get(resolvePath("", src));
          if (!asset) return node;
          const file = asset instanceof File ? asset : new File([(await asset.read()) as BlobPart], asset.name.split("/").pop()!);
          const uploaded = await api.uploadFile(file, page.id);
          return { ...node, attrs: { ...node.attrs, [attr]: uploaded.url, attachmentId: uploaded.id, size: uploaded.size } };
        });
        await api.setPageContent(page.id, doc);
        docs.set(key, doc);
      }
      // Second pass: point relative links between imported pages at the new pages.
      for (const [key, info] of created) {
        const source = pagePaths.get(key)!;
        const doc = docs.get(key);
        if (!doc) continue;
        const base = dirname(source.path);
        let changed = false;
        const linked = await mapNodes(doc, async (node) => {
          if (node.type !== "text" || !node.marks?.some((m) => m.type === "link")) return node;
          const marks = node.marks.map((m) => {
            const href = String(m.attrs?.href ?? "");
            if (m.type !== "link" || /^(https?:|mailto:|#|\/)/.test(href)) return m;
            const path = norm(resolvePath(base, href));
            const target = created.get(keyOfFile.get(path) ?? path.replace(/\.(md|markdown|html?)$/i, ""));
            if (!target) return m;
            changed = true;
            return { ...m, attrs: { ...m.attrs, href: pageUrl(space.slug, { slugId: target.slugId, title: target.title }), internal: true } };
          });
          return { ...node, marks };
        });
        if (changed) await api.setPageContent(info.id, linked).catch(() => undefined);
      }
      treeCache.invalidate(space.id);
      toast(`Imported ${keys.length} page${keys.length === 1 ? "" : "s"}`, "success");
      onClose();
      if (first) navigate(pageUrl(space.slug, first));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Modal title={`Import into ${space.name}`} onClose={busy ? () => undefined : onClose}>
      <p>Import Markdown (.md) or HTML files, or a .zip export containing folders of them. Folders become nested pages, and images referenced by the files are uploaded.</p>
      {progress ? (
        <p className="muted">{progress}</p>
      ) : (
        <label className="dropzone">
          <input
            type="file"
            multiple
            accept=".md,.markdown,.html,.htm,.txt,.zip"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void run(files);
            }}
          />
          <span>Choose files</span>
        </label>
      )}
      {!busy && (
        <div className="modal-foot-inline">
          <Button onClick={onClose}>Close</Button>
        </div>
      )}
    </Modal>
  );
};
