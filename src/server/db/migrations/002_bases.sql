-- Bases: pages that hold a typed table of rows instead of a document.

ALTER TABLE pages ADD COLUMN is_base boolean NOT NULL DEFAULT false;

CREATE TABLE base_properties (
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  -- Short opaque id; row cells are keyed by it.
  id text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}',
  is_primary boolean NOT NULL DEFAULT false,
  position text NOT NULL COLLATE "C",
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, id)
);
-- Formulas refer to properties by name, so names are unique per base.
CREATE UNIQUE INDEX base_properties_name_key ON base_properties (page_id, lower(btrim(name)));

CREATE TABLE base_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  cells jsonb NOT NULL DEFAULT '{}',
  position text NOT NULL COLLATE "C",
  creator_id uuid REFERENCES users (id) ON DELETE SET NULL,
  last_editor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX base_rows_order_idx ON base_rows (page_id, position, id);

CREATE TABLE base_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES pages (id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('table', 'kanban', 'calendar')),
  config jsonb NOT NULL DEFAULT '{}',
  position text NOT NULL COLLATE "C",
  creator_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX base_views_page_idx ON base_views (page_id, position);

-- Typed reads of a cell value for filtering and sorting; anything that does
-- not convert cleanly reads as NULL instead of failing the query.

CREATE FUNCTION cell_number(v jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'number' THEN (v #>> '{}')::numeric
    WHEN 'string' THEN CASE WHEN (v #>> '{}') ~ '^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$' THEN (v #>> '{}')::numeric END
  END
$$;

CREATE FUNCTION cell_time(v jsonb) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE s text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  s := btrim(v #>> '{}');
  -- A bare date is a calendar day; read it as midnight UTC.
  IF s ~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN (s || 'T00:00:00Z')::timestamptz; END IF;
  RETURN s::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

CREATE FUNCTION cell_flag(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'boolean' THEN v = 'true'::jsonb
    WHEN 'string' THEN CASE
      WHEN lower(btrim(v #>> '{}')) IN ('true', 'yes', 'on', '1') THEN true
      WHEN lower(btrim(v #>> '{}')) IN ('false', 'no', 'off', '0', '') THEN false
    END
    WHEN 'number' THEN (v #>> '{}')::numeric <> 0
  END
$$;

-- Cells as a JSON array: lists stay lists, a single value becomes a one-item list.
CREATE FUNCTION cell_list(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(v) WHEN 'array' THEN v WHEN 'string' THEN jsonb_build_array(v) END
$$;

-- Applies a cell patch: a JSON null removes the key, anything else sets it.
CREATE FUNCTION apply_cell_patch(cells jsonb, patch jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(key, value) FROM (
      SELECT key, value FROM jsonb_each(cells) WHERE NOT patch ? key
      UNION ALL
      SELECT key, value FROM jsonb_each(patch) WHERE jsonb_typeof(value) <> 'null'
    ) merged),
    '{}'::jsonb)
$$;
