# The Rust server

`src/server-rs` is the whole backend of `src/server` written again in Rust: the same HTTP API
(`docs/api.md`), the same WebSocket collaboration, the same database (it embeds and applies the very
migration files of `src/server/db/migrations`), the same files on disk or in S3, the same environment
variables. Either server can run a deployment. They claim the same realtime lease in the same way, so one
can take over from the other on the same database; the test suite runs pairs of the same server, not a
mixed pair.

```sh
cargo build --release -p doc-server        # or: bun run build-server-rs
bun run build-client                       # the web app, served from build/client
./target/release/doc-server                # the same environment variables as the Bun server
```

The binary reads its settings from the environment only. Bun loads a `.env` file by itself; for this server
export it first (`set -a; . ./.env; set +a`), or it starts on the defaults.

`Dockerfile.rust` builds the image with this server in place of the Bun one. The binary is about 14 MB and
idles at about 3 MiB of memory.

## How it is kept the same

The Bun server is the reference. What it answers is in many places defined by what JavaScript does, so the
port goes through `src/jsutil.rs` instead of the nearest Rust equivalent: string lengths and cuts in UTF-16
units, `String(x)` and `Number(x)`, number formatting, `JSON.stringify` (key order included), `Date.parse`,
and half surrogate pairs (carried in private-use code points, see `jsutil.rs`). Documents stay JSON trees
(`serde_json::Value`), never typed structs, so unknown keys survive as they do in TypeScript.

Two sets of tests hold the port to the reference:

- **The API suite, `src/api-tests`** (Bun test files). It starts the server under test as a process of its
  own on an empty database and talks to it only as a client would: HTTP, WebSocket, the database, the files
  on disk, a stand-in SMTP server, S3 store and OpenID Connect provider. Nothing in it imports server code and
  expected values are literals, so the same files run against both servers:

  ```sh
  TEST_DATABASE_URL=postgres://localhost:5432/doc_test bun run test:api        # the Bun server
  TEST_DATABASE_URL=postgres://localhost:5432/doc_test bun run test:api:rust   # the Rust server
  ```

  `API_TEST_SKIP_SLOW=1` leaves out the files that wait a minute for a timer; `API_TEST_ECHO_LOGS=1` prints
  what the server under test logs. A behaviour of the Bun server that looks unintended but is observable is
  pinned too, marked `// Accident:` in the test, and the Rust server reproduces it.

- **Fixtures for the shared logic, `tests/`**. `tests/fixtures/gen-*.ts` run the TypeScript of `src/common`
  (schema, text, HTML and Markdown, formulas, base cells, dates, numbers, ordering keys, the OpenID Connect
  client) over tables and seeded random inputs and write what it answers to JSON; `cargo test -p doc-server`
  (`bun run test:rs`) compares the Rust ports with it. Regenerate a fixture with
  `bun src/server-rs/tests/fixtures/gen-<name>.ts` after changing the TypeScript.

A change to the API is made in both servers and pinned once in `src/api-tests`.

## Layout

| Rust | Port of |
|---|---|
| `src/main.rs`, `src/app.rs`, `src/http.rs` | `start.ts`, `app.ts`, `lib/http.ts` (hyper 1 with a router of its own) |
| `src/db.rs` | `db/index.ts`: `sql!` builds a query from fragments and text parameters, as `Bun.SQL`'s tagged templates do |
| `src/routes/*.rs`, `src/*.rs` | `routes/*.ts`, `lib/*.ts`, file by file |
| `src/realtime/*.rs` | `realtime/*.ts`: sockets, page sessions, the leader lease |
| `src/common/**` | `src/common/**` (the parts the server uses) |
| `src/auth_client.rs` | `lib/auth-client.ts` |
| `src/storage_s3.rs` | Bun's `S3Client` as `lib/storage.ts` uses it (Signature Version 4, multipart uploads) |

## Known differences

Deliberate, small, and none reachable by the web client in normal use:

- **It cannot reach Postgres over TLS.** With `sslmode=require` in `DATABASE_URL` it refuses to start (the
  handshake fails) rather than connect unencrypted, and `verify-ca` or `verify-full` are refused as an invalid
  connection string. Without `sslmode`, or with `prefer` or `disable`, it connects without TLS, over TCP or a
  Unix socket. Use the Bun server where Postgres requires TLS.
- An edit that would nest the document more than 100 levels deep is refused, which is the limit for a document
  that arrives whole. The Bun server takes such an edit as long as its stack holds (some thousands of levels).
- An edit that would cut a surrogate pair in half is refused as invalid. The Bun server accepts it and then
  fails every save of that page.
- JSON nested more than 512 levels deep is refused as malformed (a document may be 100 nodes deep, about 200
  levels).
- A number too large for a double (`1e400`) is read as the text `"Infinity"`, which converts like the number
  it is in JavaScript; where the Bun server would store `null` for it (inside a document), this stores the text.
- The private-use code points U+10D800 to U+10DFFF stand for half surrogate pairs and are treated as such.
- Zip archives hold the same entries with the same contents, but the compressed bytes differ (another deflate
  implementation), and an entry within a few bytes of not compressing may be stored instead.
- S3: a failed request is not retried (Bun's client retries a PUT up to three times), and an upload that
  passes the size limit is aborted rather than completed and deleted. The outcome in the bucket is the same.
- A multipart upload sent without a `Content-Length` is refused with 413 as soon as it has passed the size of
  a form; the Bun server reads it to its end (up to the limit for any body) and then refuses the image, with
  another message.
- A socket whose client has stopped reading is closed (1008) once 16 MiB wait to be written to it. The Bun
  server keeps the socket and drops what would go past that.
- A stopping server refuses new connections at once; the Bun server accepts them until it has saved what it
  holds, and turns sockets away with 1013.
- Letters, case and normalization come from the Unicode tables of the Rust standard library and crates, the
  Bun server's from JavaScriptCore; they agree up to Unicode 16.0 (`tests/text.rs` lists what differs after
  it). That is why `rust-toolchain.toml` pins the toolchain: a newer standard library knows case pairs the
  pinned Bun does not, and `cargo test` fails on it until both move.
- The `error` text of a log line comes from the runtime where it is not the database's or the server's own
  message.

`tests/*.rs` name the few further edge cases of the shared logic where the port knowingly answers
differently (each with its reason).
