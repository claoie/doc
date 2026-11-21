# Doc

A self-hosted, real-time collaborative wiki that fits in a small machine. Write pages together with live
cursors, organize them in spaces and nested trees, comment inline, and publish pages to the web.

The server is a single Bun process with no runtime dependencies beyond Bun itself and Postgres. It idles
at well under 128 MB of memory.

## Features

- **Editor**: headings, lists and to-do lists, quotes, code blocks with syntax highlighting, tables (merge,
  split, header rows, cell colors, column widths), callouts, toggles, columns, dividers and page breaks,
  math (rendered natively as MathML), Mermaid, draw.io and Excalidraw diagrams, images, video, audio,
  PDFs, file attachments, embeds (YouTube, Vimeo, Loom, Figma, Miro, Airtable, Typeform, Framer, Google
  Drive and Sheets, any iframe), mentions of people and pages, status badges, footnotes, synced blocks,
  subpage lists, emoji, text colors and highlights, alignment.
- **Typing**: slash commands, Markdown shortcuts, smart typography, find and replace, undo and redo,
  paste from the web, Word, Google Docs or Markdown. IME input (Korean, Japanese, Chinese) is supported.
- **Collaboration**: real-time co-editing with live cursors and selections, inline comment threads with
  replies and resolve, mentions with notifications, page watching and update emails.
- **Organization**: spaces with members and roles (admin, writer, reader), groups, a drag-and-drop page
  tree, favorites, labels, backlinks, recent pages, full-text search, trash with restore, page history
  with restore, duplicate and move (also between spaces).
- **Sharing**: publish a page (optionally with its subpages) at a public link, with search-engine indexing
  as an opt-in.
- **Import and export**: Markdown and HTML files or zip folders in; Markdown or HTML (single file or zip
  with attachments) out.
- **Administration**: invitations by email or link, member roles and deactivation, allowed email domains,
  trash retention, workspace logo, light and dark themes, mobile-friendly layout, optional single sign-on.

## Running with Docker

```yaml
services:
  doc:
    image: <registry>/doc:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      APP_URL: https://docs.example.com
      DATABASE_URL: postgres://doc:secret@postgres:5432/doc
      MAIL_DRIVER: smtp
      SMTP_HOST: smtp.example.com
      SMTP_USERNAME: docs@example.com
      SMTP_PASSWORD: secret
      MAIL_FROM_ADDRESS: docs@example.com
    volumes:
      - ./data:/app/data
    depends_on:
      - postgres
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: doc
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: doc
    volumes:
      - ./postgres:/var/lib/postgresql/data
```

Open the app and create the first account; it becomes the workspace owner. Database migrations run
automatically on start. All settings are listed in [`.env.example`](.env.example).

Put the app behind a reverse proxy that terminates TLS and forwards WebSocket upgrades on `/api/ws`, and
set `TRUST_PROXY=true` so rate limiting sees real client IPs.

### Rolling deploys

Two copies of the server can run side by side on one database while a new version replaces an old one.
One copy at a time leads realtime editing, through a lease in the database. The others serve the rest of
the API and close sockets on `/api/ws` as they open, and clients reconnect until they reach the leader.

A leader that receives SIGTERM closes its sockets, saves every open page and releases the lease, and the
next copy takes over within a second. Give it time to stop before a SIGKILL: a leader that dies without
stopping keeps the lease for up to 10 seconds, and loses edits not saved yet.

Both versions run against the same database for a while, so migrations have to keep working with the
previous version of the code: add to the schema, and only remove what it no longer uses.

## Single sign-on (optional)

Doc can let people sign in through an OpenID Connect identity provider whose access tokens carry the person's
`role` for doc and their provider session (`sid`), and that pushes signed security event tokens (RFC 8417) when
a session ends or a person's access changes. It is off unless `AUTH_ISSUER` is set, and doc never contacts the
provider before someone signs in with it.

| Variable | Meaning |
|---|---|
| `AUTH_ISSUER` | Issuer URL of the provider, e.g. `https://auth.example.com`. Setting it turns single sign-on on. |
| `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` | Required with `AUTH_ISSUER`: the confidential client registered for doc. |
| `AUTH_REDIRECT_URI` | Callback registered for the client. Default: `APP_URL` + `/api/auth/callback`. |
| `AUTH_BACKCHANNEL_URL` | Private-network URL of the same issuer, used for every server-to-server call. |
| `AUTH_AUDIENCE` | The service name in tokens' `aud`, when it differs from the client id. |
| `AUTH_LOCAL_LOGIN` | `true` keeps password sign-in, password resets and invitations alongside single sign-on, for a migration period; accounts linked to the provider still sign in only through it. Default `false`. |
| `AUTH_LINK_USERS` | `<local email>=<provider username>` pairs, comma-separated, e.g. `alice@example.com=alice,bob@example.com=bob`: links existing accounts on their first sign-in. |

The server checks these at start and refuses to start, listing every problem, when one is missing or malformed.
Sign-in needs https (or `localhost`): the login cookie is `Secure`.

Register doc with the provider as a service whose roles are `member`, `admin` and `owner`, with a confidential
client (the `mfa_roles` and `signup` policy are the deployment's choice). Where the provider registers services on
its admin page, do it there: once the client's secret is made, the page lists the `AUTH_*` lines to paste into
doc's environment. A provider configured by a services file takes the same definition there:

```json
{
  "name": "doc",
  "roles": ["member", "admin", "owner"],
  "mfa_roles": ["admin", "owner"],
  "signup": "invite",
  "clients": [{
    "id": "doc",
    "type": "confidential",
    "redirect_uris": ["https://docs.example.com/api/auth/callback"],
    "post_logout_redirect_uris": ["https://docs.example.com/"]
  }],
  "events_url": "https://docs.example.com/api/auth/events"
}
```

`events_url` can be a private address the provider reaches directly. The post-logout address is the origin of
the redirect URI followed by `/`.

**Who is who.** At the callback doc uses, in order: the account already linked to the provider's subject; the
account `AUTH_LINK_USERS` names for the provider username, if it is not linked yet; the one unlinked account with
the ID token's email, whether or not the provider marked it verified; otherwise a new account, added to the default
group. Matching an unverified email relies on the provider setting an address a person chose only after they
confirm it: one it hasn't verified was then entered by its administrator, at account creation or import, and is as
trustworthy as `AUTH_LINK_USERS`. **Don't use single sign-on with a provider that lets people claim an address they
haven't confirmed**: anyone could then claim an address there and take over the account here that has it. Linking
leaves an account's activation as it is. A new account needs an email, and one whose email belongs to an account
linked to someone else is refused. The name, and a verified email, are copied from the provider at each sign-in.

**What changes.**

- The sign-in page shows **Sign in with SSO**. Unless `AUTH_LOCAL_LOGIN` is on, password sign-in, first-run setup
  with a password, password reset and change, and doc's own invitations are refused and hidden; people appear as
  members the first time they sign in. Password sessions that already exist end at their next request.
- An account linked to the provider signs in only through it, even with `AUTH_LOCAL_LOGIN` on, so a person the
  provider disabled can't come back with a password: password sign-in fails for it as for an unknown address,
  **Forgot password?** sends it nothing, a reset link sent before it was linked no longer works, and a password
  session it already had ends at its next request.
- On an empty database, the first person to sign in sets up the workspace and gets the provider's role: give
  them `owner` in the provider.
- The provider decides who may sign in through it. Its role (`owner`, `admin`, `member`; anything else counts as
  `member`) becomes the workspace role at each sign-in and re-check, and admins can't change the role of members
  linked to it. Activation stays doc's: admins deactivate, reactivate and remove linked members as any other, and a
  deactivated member's sign-in through the provider is refused until an admin reactivates them. Space roles and
  groups stay in doc. The workspace's allowed email domains apply to doc's own invitations and email changes, not
  to these sign-ins.
- A session started through the provider is re-checked with it every 10 minutes, with the refresh token the
  provider issued at sign-in (a session without one ends at its first re-check). When the provider is
  unreachable, the session is served for up to an hour past its re-check, then ends; after a re-check the provider
  couldn't answer, the session's requests don't ask it again for a minute. A session the provider ended, or a user
  it removed, disabled or deleted, is signed out at once, and their open sockets close within a minute on every copy
  of the server. Doc doesn't deactivate them: the provider refuses their sign-in itself. Doc never deletes a user's
  data on its own: a deleted user's pages and comments stay, and an admin can remove the member in
  **Settings → Members**.
- A linked person's name comes from the provider, and so does their email when the provider verified it at their
  last sign-in: **Profile & security** shows those read-only, and `/me/update` refuses to change them. An email
  the provider hasn't verified stays the person's own to change in doc; someone single sign-on created has no
  password here, so they change it without one.
- Signing out also revokes doc's refresh token and signs the browser out of the provider.

**Turning it off.** Unset `AUTH_ISSUER` and restart. Password sign-in, invitations and member management work
as before; accounts that had a password, linked or not, sign in with it again, and accounts created by single
sign-on can set one with **Forgot password?**. Sessions started through the provider end at their next request,
since nothing can re-check them any more.

## Development

Requirements: [Bun](https://bun.sh) and a local Postgres.

```sh
bun install
cp .env.example .env        # point DATABASE_URL at a local database
bun run dev                 # API on :3000, web app on :5173
```

Set `APP_URL=http://localhost:5173` while developing through the Vite dev server.

```sh
bun run lint
bun run typecheck
TEST_DATABASE_URL=postgres://localhost:5432/doc_test bun run test   # the test database is wiped
bun run build && bun run start
```

The API suite in `src/api-tests` starts a built server as a process of its own and tests every endpoint
through HTTP and WebSocket only. The same files run against the Bun server and against the Rust server
(below); they wipe the test database too:

```sh
TEST_DATABASE_URL=postgres://localhost:5432/doc_test bun run test:api        # the Bun server
TEST_DATABASE_URL=postgres://localhost:5432/doc_test bun run test:api:rust   # the Rust server (needs cargo)
```

## The Rust server

`src/server-rs` is the same backend written in Rust, side by side with `src/server`: the same API, database,
migrations, storage and environment variables. It is held to the Bun server's behaviour by the API suite and
by fixtures generated from the TypeScript; `src/server-rs/README.md` says how, and lists the few known
differences (the main one: it cannot connect to Postgres over TLS).

```sh
bun run build-client && bun run build-server-rs
./target/release/doc-server                      # or: docker build -f Dockerfile.rust .
```

The binary reads the environment only; unlike Bun it does not load `.env` (`set -a; . ./.env; set +a` first).

## Architecture

- `src/common/editor` — the document model, schema, change steps with position mapping, the
  collaboration algorithm, undo history, editing commands, Markdown and HTML conversion. Documents are
  stored as JSON trees.
- `src/client/editor` — the browser editing view: rendering, selection mapping, input and IME handling,
  clipboard, node views.
- `src/client/app` — the React web app.
- `src/server` — HTTP API (`docs/api.md`), WebSocket collaboration (`src/server/realtime`), Postgres
  access through `Bun.SQL`, migrations in `src/server/db/migrations`.
- `src/server-rs` — the same server in Rust (see above).
- `src/api-tests` — the API suite both servers pass.

Collaboration uses a central authority: the server holds each open document and a version number and
accepts a batch of changes only when it was made against the current version; clients rebase their
pending changes on top of the ones they missed. Only the copy of the server that holds the realtime lease
(`src/server/realtime/leader.ts`) does this, so a document never has two authorities. As a backstop, a
save applies only on top of the version it loaded; otherwise the page's editors restart from what is stored.

## License

[Apache License 2.0](LICENSE)
