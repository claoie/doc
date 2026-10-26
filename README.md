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
  trash retention, workspace logo, light and dark themes, mobile-friendly layout.

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

## Architecture

- `src/common/editor` — the document model, schema, change steps with position mapping, the
  collaboration algorithm, undo history, editing commands, Markdown and HTML conversion. Documents are
  stored as JSON trees.
- `src/client/editor` — the browser editing view: rendering, selection mapping, input and IME handling,
  clipboard, node views.
- `src/client/app` — the React web app.
- `src/server` — HTTP API (`docs/api.md`), WebSocket collaboration (`src/server/realtime`), Postgres
  access through `Bun.SQL`, migrations in `src/server/db/migrations`.

Collaboration uses a central authority: the server holds each open document and a version number and
accepts a batch of changes only when it was made against the current version; clients rebase their
pending changes on top of the ones they missed.

## License

[Apache License 2.0](LICENSE)
