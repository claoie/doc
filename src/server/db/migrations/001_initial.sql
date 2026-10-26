CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE workspace (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name text NOT NULL DEFAULT 'My workspace',
  description text,
  logo text,
  email_domains text[] NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}',
  default_space_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  password_hash text,
  avatar text,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  locale text,
  timezone text,
  preferences jsonb NOT NULL DEFAULT '{}',
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  last_login_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE user_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX groups_name_key ON groups (lower(name));

CREATE TABLE group_members (
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members (user_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  group_ids uuid[] NOT NULL DEFAULT '{}',
  token_hash text NOT NULL,
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitations_email_key ON invitations (lower(email));

CREATE TABLE spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  icon text,
  settings jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX spaces_slug_key ON spaces (lower(slug));

CREATE TABLE space_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  user_id uuid REFERENCES users (id) ON DELETE CASCADE,
  group_id uuid REFERENCES groups (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'writer', 'reader')),
  added_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NULL) <> (group_id IS NULL))
);
CREATE UNIQUE INDEX space_members_user_key ON space_members (space_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX space_members_group_key ON space_members (space_id, group_id) WHERE group_id IS NOT NULL;
CREATE INDEX space_members_user_idx ON space_members (user_id);
CREATE INDEX space_members_group_idx ON space_members (group_id);

CREATE TABLE pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug_id text NOT NULL UNIQUE,
  space_id uuid NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  parent_id uuid REFERENCES pages (id) ON DELETE CASCADE,
  position text NOT NULL COLLATE "C",
  title text,
  icon text,
  cover text,
  content jsonb,
  text_content text,
  -- Version of the live document: the number of collaborative steps applied.
  doc_version bigint NOT NULL DEFAULT 0,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', left(coalesce(text_content, ''), 1000000)), 'B')
  ) STORED,
  creator_id uuid REFERENCES users (id) ON DELETE SET NULL,
  last_editor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  contributor_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX pages_tree_idx ON pages (space_id, parent_id, position);
CREATE INDEX pages_parent_idx ON pages (parent_id);
CREATE INDEX pages_search_idx ON pages USING gin (search);
CREATE INDEX pages_title_trgm_idx ON pages USING gin (lower(title) gin_trgm_ops);
CREATE INDEX pages_updated_idx ON pages (updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX pages_deleted_idx ON pages (space_id, deleted_at) WHERE deleted_at IS NOT NULL;

ALTER TABLE workspace
  ADD CONSTRAINT workspace_default_space_fkey FOREIGN KEY (default_space_id) REFERENCES spaces (id) ON DELETE SET NULL;

CREATE TABLE page_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  title text,
  icon text,
  content jsonb,
  editor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  contributor_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX page_versions_page_idx ON page_versions (page_id, created_at DESC);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  parent_id uuid REFERENCES comments (id) ON DELETE CASCADE,
  author_id uuid REFERENCES users (id) ON DELETE SET NULL,
  body jsonb NOT NULL,
  quote text,
  anchored boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX comments_page_idx ON comments (page_id, created_at);

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose text NOT NULL DEFAULT 'page' CHECK (purpose IN ('page', 'avatar', 'workspace-logo', 'space-icon')),
  page_id uuid REFERENCES pages (id) ON DELETE SET NULL,
  space_id uuid REFERENCES spaces (id) ON DELETE SET NULL,
  uploader_id uuid REFERENCES users (id) ON DELETE SET NULL,
  name text NOT NULL,
  mime text NOT NULL DEFAULT 'application/octet-stream',
  size bigint NOT NULL DEFAULT 0,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_page_idx ON files (page_id);

CREATE TABLE shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  page_id uuid NOT NULL UNIQUE REFERENCES pages (id) ON DELETE CASCADE,
  include_children boolean NOT NULL DEFAULT false,
  search_indexing boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  page_id uuid REFERENCES pages (id) ON DELETE CASCADE,
  space_id uuid REFERENCES spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((page_id IS NULL) <> (space_id IS NULL))
);
CREATE UNIQUE INDEX favorites_page_key ON favorites (user_id, page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX favorites_space_key ON favorites (user_id, space_id) WHERE space_id IS NOT NULL;

CREATE TABLE watchers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  page_id uuid REFERENCES pages (id) ON DELETE CASCADE,
  space_id uuid REFERENCES spaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((page_id IS NULL) <> (space_id IS NULL))
);
CREATE UNIQUE INDEX watchers_page_key ON watchers (user_id, page_id) WHERE page_id IS NOT NULL;
CREATE UNIQUE INDEX watchers_space_key ON watchers (user_id, space_id) WHERE space_id IS NOT NULL;
CREATE INDEX watchers_page_idx ON watchers (page_id);
CREATE INDEX watchers_space_idx ON watchers (space_id);

CREATE TABLE labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE page_labels (
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, label_id)
);
CREATE INDEX page_labels_label_idx ON page_labels (label_id);

CREATE TABLE page_links (
  source_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_id)
);
CREATE INDEX page_links_target_idx ON page_links (target_id);

CREATE TABLE synced_blocks (
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  block_id text NOT NULL,
  content jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, block_id)
);
CREATE INDEX synced_blocks_block_idx ON synced_blocks (block_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  page_id uuid REFERENCES pages (id) ON DELETE CASCADE,
  comment_id uuid REFERENCES comments (id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  emailed_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
