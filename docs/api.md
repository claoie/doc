# HTTP and realtime API

All endpoints live under `/api`. Requests and responses are JSON unless noted.

- Success: HTTP 2xx with `{ "data": <payload> }`.
- Failure: HTTP 4xx/5xx with `{ "error": { "code": "<snake_case>", "message": "<human readable>" } }`.
- Authentication: an HttpOnly `session` cookie (`SameSite=Lax`, `Secure` when `APP_URL` is https). The cookie
  holds a random token; the database stores only its SHA-256 hash. Sessions last 30 days and slide on use.
- Every endpoint requires a session unless marked **public**.
- IDs are UUIDs. Pages also have a `slugId` (10 base-62 chars); endpoints taking `:page` accept either.
- Timestamps are ISO strings.

## Roles and permissions

Workspace roles: `owner`, `admin`, `member`. Owners and admins manage settings, members, groups and all
spaces. An admin can never change, deactivate or delete an owner. Users cannot deactivate or delete themselves.

Space roles: `admin`, `writer`, `reader`, granted to users directly or through groups. A user's role in a space
is the highest of their direct and group grants. Workspace owners/admins can see every space in admin views but
need membership to read pages.

| action | space role needed |
|---|---|
| read pages, comments, versions; export a page | reader |
| create, edit, move, duplicate, trash, restore pages; upload files; share pages; comment | writer |
| permanently delete pages; edit space settings and members; delete or export the space | admin |
| edit or delete a comment | its author (space admins may also delete) |

## Setup and auth

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/setup` **public** | | `{ needsSetup }` |
| POST | `/setup` **public** | `{ workspaceName, name, email, password }` | `{ user }`; creates the owner, the workspace, the default group `Everyone`, and a `General` space with the owner as admin; signs in. Fails with 403 once a user exists. |
| POST | `/auth/login` **public** | `{ email, password }` | `{ user }`. Rate limited (10/min per IP). Deactivated users get the same error as a wrong password, and so do accounts linked to the identity provider while single sign-on is on. |
| POST | `/auth/logout` | | `{}`; for a session started through single sign-on, `{ logoutUrl }`: the browser goes there to end the identity provider's session too. |
| POST | `/auth/forgot-password` **public** | `{ email }` | `{}` always; emails a 30-minute reset link `/reset-password?token=…` if the user exists, is active and, while single sign-on is on, isn't linked to the identity provider. |
| POST | `/auth/reset-password` **public** | `{ token, password }` | `{ user }`; revokes all sessions, signs in. Fails with 400 when the link is invalid or expired, its user is deactivated, or, while single sign-on is on, its user is linked to the identity provider. |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | `{}`; revokes other sessions, emails a notice. |
| GET | `/auth/sessions` | | `[{ id, userAgent, ip, createdAt, lastSeenAt, current }]` |
| POST | `/auth/sessions/revoke` | `{ id }` | `{}` |
| GET | `/auth/config` **public** | | `{ sso: { enabled, localLogin } }`; without single sign-on `{ enabled: false, localLogin: true }`. |

Passwords: 8–70 characters. Names: 1–50 characters.

### Single sign-on

Only when `AUTH_ISSUER` is set (README, "Single sign-on (optional)"); otherwise these answer 404 like unknown endpoints.

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/auth/login` **public** | `?returnTo=<local path>` | `302` to the identity provider, with a 5-minute `__Host-login` cookie. Rate limited (60/min per IP). |
| GET | `/auth/callback` **public** | the provider's `code` and `state` | `302` to `returnTo`, signed in. On failure `302` to `/login?sso_error=<reason>`: `login_failed`, `access_denied`, `unavailable`, `no_email`, `account_exists` (the email belongs to an account linked to someone else), `deactivated` (the account is deactivated here), `rate_limited`. Rate limited (60/min per IP). |
| POST | `/auth/events` **public** | a signed event (`application/secevent+jwt`, read whatever the content type) | `202 {}`; `400` when it doesn't verify; `503` when the provider's keys can't be fetched, so it is sent again. No origin check. |

With single sign-on on and `AUTH_LOCAL_LOGIN` off, `POST /setup`, `/auth/login`, `/auth/forgot-password`,
`/auth/reset-password` and `/auth/change-password` fail with 403 `local_login_disabled`, and so do invitations
(below). With `AUTH_LOCAL_LOGIN` on, an account linked to the provider still signs in only through it: `/auth/login`
answers it as an unknown address (401 `invalid_credentials`), `/auth/forgot-password` sends it nothing, and
`/auth/reset-password` refuses its links. The first person to sign in through the provider sets up an empty
workspace as `POST /setup` would, with the provider's role.

## Current user

| method | path | body | returns |
|---|---|---|---|
| GET | `/me` | | `{ user, workspace }`. With single sign-on on, `user.ssoManaged` says whether this person is linked to the identity provider (which then sets their name and role, and is their only way to sign in), and `user.ssoManagedEmail` whether it manages their email too (it verified it at their last sign-in), and `user.hasPassword` whether they have a password here (people single sign-on created have none). `/me/update` and the avatar routes answer `user` the same way. |
| POST | `/me/update` | `{ name?, email?, currentPassword?, locale?, timezone?, preferences? }` | `{ user }`. Changing email requires `currentPassword`, except, with single sign-on on, for a linked person with no password (`hasPassword: false`). With single sign-on on, changing a linked person's name, or an email the provider manages (`ssoManagedEmail`), fails with 403 `sso_managed`. `preferences` merges keys: `fullPageWidth`, `pageEditMode` (`read`/`edit`), `editorToolbar`, `theme`, and notification switches `notifyPageUpdates`, `notifyPageMentions`, `notifyCommentMentions`, `notifyComments`. |
| POST | `/me/avatar` | multipart `file` (png/jpeg/webp/gif ≤ 10 MB) | `{ user }` |
| POST | `/me/avatar/remove` | | `{ user }` |

`user` shape: `{ id, email, name, avatarUrl, role, locale, timezone, preferences, createdAt, lastLoginAt }`.

## Workspace

| method | path | body | returns |
|---|---|---|---|
| GET | `/workspace/public` **public** | | `{ name, logoUrl }` |
| POST | `/workspace/update` (admin) | `{ name?, description?, emailDomains?, settings? }` | `{ workspace }`. `settings` keys: `sharingDisabled`, `trashRetentionDays` (≥ 1, default 30), `defaultPageEditMode`. |
| POST | `/workspace/logo` (admin) | multipart `file` | `{ workspace }` |
| POST | `/workspace/logo/remove` (admin) | | `{ workspace }` |

`workspace` shape: `{ name, description, logoUrl, emailDomains, settings, defaultSpaceId, createdAt }`.

### Members

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/members` | `?query&limit&offset` | `{ items: [user + { deactivatedAt, ssoManaged? }], total }`; `ssoManaged` is present only with single sign-on on. |
| POST | `/members/role` (admin) | `{ userId, role }` | `{ user }`; only an owner can grant or remove `owner`; the last owner cannot be demoted. |
| POST | `/members/deactivate` (admin) | `{ userId }` | `{}`; revokes their sessions. |
| POST | `/members/activate` (admin) | `{ userId }` | `{}` |
| POST | `/members/delete` (admin) | `{ userId }` | `{}` |

With single sign-on on, the identity provider sets the role of members linked to it (`ssoManaged`): `/members/role`
fails with 403 `sso_managed` for them. Their activation stays the workspace's: `/members/deactivate` and
`/members/activate` work for them as for anyone, and a deactivated member's sign-in through the provider is refused
(`sso_error=deactivated`).

### Invitations

| method | path | body | returns |
|---|---|---|---|
| GET | `/invitations` (admin) | | `[{ id, email, role, groupIds, invitedBy, createdAt }]` |
| POST | `/invitations` (admin) | `{ emails[], role, groupIds? }` | `[{ id, email, url }]`; skips existing members; emails each invitee. If `emailDomains` is set, only those domains may be invited. |
| POST | `/invitations/resend` (admin) | `{ id }` | `{ url }`; rotates the token and re-sends. |
| POST | `/invitations/link` (admin) | `{ id }` | `{ url }`; rotates the token without emailing. |
| POST | `/invitations/revoke` (admin) | `{ id }` | `{}` |
| GET | `/invitations/:id` **public** | `?token` | `{ email, workspaceName }` |
| POST | `/invitations/accept` **public** | `{ id, token, name, password }` | `{ user }`; creates the user with the invited role, adds them to `Everyone` and the invited groups, emails the inviter, signs in. |

Invitation URL: `/invites/:id?token=…`. With single sign-on as the only way in, invitations create no accounts:
`POST /invitations`, `/invitations/resend`, `/invitations/link`, `GET /invitations/:id` and `POST /invitations/accept`
fail with 403 `local_login_disabled`, and people appear as members when they first sign in.

### Groups

| method | path | body | returns |
|---|---|---|---|
| GET | `/groups` | | `[{ id, name, description, isDefault, memberCount }]` |
| POST | `/groups` (admin) | `{ name, description? }` | `{ group }` |
| POST | `/groups/:id/update` (admin) | `{ name?, description? }` | `{ group }`; the default group cannot be renamed. |
| POST | `/groups/:id/delete` (admin) | | `{}`; not the default group. |
| GET | `/groups/:id/members` | `?limit&offset` | `{ items: [user], total }` |
| POST | `/groups/:id/members/add` (admin) | `{ userIds[] }` | `{}` |
| POST | `/groups/:id/members/remove` (admin) | `{ userId }` | `{}`; not from the default group. |

Every user belongs to the default group.

## Spaces

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/spaces` | | `[space]` the user is a member of, with `role` |
| GET | `/spaces/all` (workspace admin) | | `[space]` |
| POST | `/spaces` | `{ name, slug, description? }` | `{ space }`; any member may create; creator becomes space admin. Slug: `[a-z0-9-]`, 2–50 chars, unique. |
| GET | `/spaces/:space` | `:space` = id or slug | `{ space }` (members, or workspace admins) |
| POST | `/spaces/:id/update` (space admin) | `{ name?, slug?, description?, settings? }` | `{ space }`; `settings.sharingDisabled` removes existing shares in the space. |
| POST | `/spaces/:id/delete` (space admin) | | `{}`; deletes pages and files. |
| POST | `/spaces/:id/icon` (space admin) | multipart `file` | `{ space }` |
| POST | `/spaces/:id/icon/remove` (space admin) | | `{ space }` |
| GET | `/spaces/:id/members` | | `[{ id, role, user?, group? }]` |
| POST | `/spaces/:id/members/add` (space admin) | `{ role, userIds?, groupIds? }` (≤ 25 each) | `{}` |
| POST | `/spaces/:id/members/role` (space admin) | `{ memberId, role }` | `{}`; the last admin cannot be demoted. |
| POST | `/spaces/:id/members/remove` (space admin) | `{ memberId }` | `{}`; not the last admin. |
| GET | `/spaces/:id/export` (space admin) | `?format=markdown|html&files=1` | zip download |

`space` shape: `{ id, name, slug, description, iconUrl, settings, role, memberCount, createdAt }`.

## Pages

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/spaces/:id/pages` | `?parentId` (omit for root) | `[treeItem]` ordered by position |
| GET | `/pages/:page` | | `{ page, space, breadcrumbs: [treeItem], canEdit }` with `content` and `docVersion` |
| POST | `/pages` (writer) | `{ spaceId, parentId?, title?, icon?, content?, afterId? }` | `{ page }`; placed after `afterId` or last among siblings. |
| POST | `/pages/:id/update` (writer) | `{ title?, icon?, cover? }` | `{ page }` |
| POST | `/pages/:id/move` (writer) | `{ parentId: id|null, afterId: id|null }` | `{ page }`; `afterId: null` = first. Rejects moving under itself or a descendant. |
| POST | `/pages/:id/move-to-space` (writer in both) | `{ spaceId }` | `{ page }`; moves the subtree, becomes a root page at the end. |
| POST | `/pages/:id/duplicate` (writer) | `{ spaceId? }` | `{ page }`; copies the subtree (titles get `Copy of `), copies files, strips comment marks. |
| POST | `/pages/:id/delete` (writer) | | `{}`; moves the page and its descendants to trash, removes their shares. |
| POST | `/pages/:id/restore` (writer) | | `{ page }`; restores the subtree; becomes a root page if its parent is still in trash. |
| POST | `/pages/:id/delete-permanently` (space admin) | | `{}` |
| GET | `/spaces/:id/trash` | | `[treeItem + { deletedAt, deletedBy }]` roots of trashed subtrees |
| GET | `/pages/recent` | `?spaceId&creatorId&limit&offset` | `[treeItem + { updatedAt, space, lastEditor }]` |
| GET | `/pages/:id/versions` | | `[{ id, title, editor, createdAt }]` newest first |
| GET | `/versions/:id` | | `{ id, pageId, title, icon, content, editor, contributors, createdAt }` |
| GET | `/pages/:id/backlinks` | | `[treeItem + { space }]` |
| GET | `/pages/:id/files` | | `[{ id, name, mime, size, url, uploader, createdAt }]` files uploaded to the page, newest first |
| GET | `/pages/:id/export` | `?format=markdown|html&children=1&files=1` | a `.md`/`.html` file, or a zip with children or files |
| GET | `/pages/:id/labels` | | `[{ id, name }]` |
| POST | `/pages/:id/labels` (writer) | `{ names[] }` | `[{ id, name }]`; names are trimmed, lower-cased, spaces become `-`. |
| POST | `/pages/:id/labels/remove` (writer) | `{ labelId }` | `{}` |
| GET | `/labels` | `?query` | `[{ id, name, pageCount }]` |
| GET | `/labels/:id/pages` | | `[treeItem + { space }]` |
| POST | `/synced-blocks/lookup` | `{ refs: [{ pageId, blockId }] }` | `[{ pageId, blockId, content|null }]` (null when missing or not readable) |

`treeItem`: `{ id, slugId, title, icon, parentId, spaceId, position, hasChildren }`.
`page`: treeItem + `{ cover, content, docVersion, creator, lastEditor, contributors, createdAt, updatedAt, deletedAt }`.

Page URL: `/s/:spaceSlug/p/:titleSlug-:slugId`; the slugId is the last `-`-separated segment.

### Favorites and watching

| method | path | body | returns |
|---|---|---|---|
| GET | `/favorites` | | `{ pages: [treeItem + { space }], spaces: [space] }` |
| POST | `/favorites` | `{ pageId } | { spaceId }` | `{}` |
| POST | `/favorites/remove` | `{ pageId } | { spaceId }` | `{}` |
| GET | `/pages/:id/watch` | | `{ watching }` |
| POST | `/pages/:id/watch` | `{ watching }` | `{}` |
| GET | `/spaces/:id/watch` | | `{ watching }` |
| POST | `/spaces/:id/watch` | `{ watching }` | `{}` |

## Comments

| method | path | body | returns |
|---|---|---|---|
| GET | `/pages/:id/comments` | | `[comment]` oldest first |
| POST | `/comments` (writer) | `{ pageId, parentId?, body, quote?, anchored? }` | `{ comment }`; replies are one level deep. The client adds the `comment` mark to the document itself. |
| POST | `/comments/:id/update` (author) | `{ body }` | `{ comment }` |
| POST | `/comments/:id/resolve` (writer) | `{ resolved }` | `{ comment }` (top-level only) |
| POST | `/comments/:id/delete` (author or space admin) | | `{}`; deletes replies too. |

`comment`: `{ id, pageId, parentId, author, body, quote, anchored, createdAt, editedAt, resolvedAt, resolvedBy }`.
`body` is a document in the editor's JSON format.

## Files

| method | path | body | returns |
|---|---|---|---|
| POST | `/files` (writer on the page) | `?pageId&name&replaceId?`; the body is the file's bytes, `Content-Type` its type | `{ id, name, mime, size, url }`; ≤ `FILE_SIZE_LIMIT` (default 50 MB), streamed to storage. `replaceId` replaces a file's content (diagrams). |
| GET | `/files/:id/:name` | | the file, with range support; readers of the page's space (or anyone holding a share key for it via `?share=`). Inline for images, PDF, audio and video; download otherwise. |
| GET | `/images/:name` **public** | | avatars, workspace logo, space icons |

File URLs inside documents are `/api/files/:id/:name`.

## Search

| method | path | query | returns |
|---|---|---|---|
| GET | `/search` | `?q&spaceId&titleOnly&limit&offset` | `[treeItem + { space, highlight, updatedAt }]`; prefix matching on title and text; only spaces the user can read. `highlight` contains `<mark>` around matches; all other text is escaped. |
| GET | `/search/suggest` | `?q&spaceId&users=1&pages=1&limit` | `{ users: [user], pages: [treeItem + { space }] }` for mentions |

## Sharing

| method | path | body | returns |
|---|---|---|---|
| GET | `/pages/:id/share` | | `{ share|null, inheritedFrom|null }` |
| POST | `/pages/:id/share` (writer) | `{ includeChildren?, searchIndexing? }` | `{ share }`; creates or updates. Fails when sharing is disabled for the workspace or space. |
| POST | `/pages/:id/share/delete` (writer) | | `{}` |
| GET | `/spaces/:id/shares` | | `[share + { page: treeItem }]` |
| GET | `/public/shares/:key` **public** | | `{ share, page, tree }`; `tree` is present when `includeChildren` |
| GET | `/public/shares/:key/pages/:page` **public** | | `{ page, breadcrumbs }` when the page is the shared page or (with `includeChildren`) a descendant |
| GET | `/public/shares/:key/search` **public** | `?q` | search limited to the shared pages |

`share`: `{ id, key, pageId, includeChildren, searchIndexing, url, createdAt }`. Public pages have comment marks
removed and file URLs carry `?share=<key>`. Public page URL: `/share/:key/p/:titleSlug-:slugId`.

## Notifications

| method | path | query / body | returns |
|---|---|---|---|
| GET | `/notifications` | `?limit&offset&unread` | `[{ id, kind, actor, page, comment, data, createdAt, readAt }]` |
| GET | `/notifications/unread-count` | | `{ count }` |
| POST | `/notifications/read` | `{ ids[] }` | `{}` |
| POST | `/notifications/read-all` | | `{}` |

Kinds: `comment.created`, `comment.reply`, `comment.mention`, `page.mention`, `page.updated`.
Emails follow the user's notification preferences. Page update notifications go to watchers other than the
editors, at most once per page per user every 7 hours.

## Client errors

| method | path | body | returns |
|---|---|---|---|
| POST | `/client-error` | `{ message, url?, stack? }` | `{}`; logs the report as an error line `client error` with the reporter's `userId`. Rate limited (10/min per IP). |

`message` and `url` are trimmed, at most 1000 characters each; `stack` is kept as sent, at most 4000. The web
app reports each error it did not handle (an uncaught error with an error object, or an unhandled rejection)
once per page load, at most five per page load, with the page's path but not its query string.

Every error log line, these reports included, is posted to `DISCORD_ALARM_WEBHOOK` when it is set: the message
as an embed title (`doc: <message>`, at most 256 characters) and the line's other fields as `key: value` lines
in a code block (at most 4000 characters; adjacent backticks are split by a zero-width space, so no text closes
the block). Each message is posted at most once a minute, and at most ten posts go out a minute in all. A post
the webhook refuses or that can't be delivered is logged as a warning, `sending an alarm failed`, never as
another error.

## Realtime

One WebSocket per tab at `/api/ws` (session cookie). Messages are JSON objects with a `t` field.

When two copies of the server run side by side, only the one that leads realtime keeps sockets open. Any other
closes them with `1013`, and clients reconnect until they reach the leader. A server shutting down closes its
sockets with `1001`. A socket whose session ends (sign-out, revocation, deactivation) is closed with `4001`, at once
on the leader and within a minute when that happened on another copy.

Client → server:

| t | fields | meaning |
|---|---|---|
| `join` | `pageId, version` | open a page for live editing/viewing |
| `leave` | `pageId` | |
| `steps` | `pageId, version, steps, clientId` | local changes made against `version` |
| `presence` | `pageId, selection: { anchor, head } | null` | caret position |
| `ping` | | keepalive |

Server → client:

| t | fields | meaning |
|---|---|---|
| `joined` | `pageId, version, doc?, readOnly` | `doc` is included when the client's version is too old to catch up step by step |
| `steps` | `pageId, version, steps, clientIds` | confirmed steps after `version - steps.length`; a client's own steps confirm its pending ones |
| `rejected` | `pageId` | steps were not applied (stale version or invalid); the client waits for `steps` and resends |
| `presence` | `pageId, users: [{ clientId, userId, name, color, selection }]` | |
| `event` | `kind, ...` | `tree` (`spaceId`), `page` (`pageId`, title/icon change), `comments` (`pageId`), `notification` |
| `pong` | | |
