-- A bare date is a calendar day in the viewer's zone, so filters and sorts
-- read it as local midnight; `offset_minutes` is the zone's offset east of UTC.
CREATE FUNCTION cell_time(v jsonb, offset_minutes integer) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE s text;
BEGIN
  IF jsonb_typeof(v) IS DISTINCT FROM 'string' THEN RETURN NULL; END IF;
  s := btrim(v #>> '{}');
  IF s ~ '^\d{4}-\d{2}-\d{2}$' THEN
    RETURN (s || 'T00:00:00Z')::timestamptz - make_interval(mins => offset_minutes);
  END IF;
  RETURN s::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END
$$;

DROP FUNCTION cell_time(jsonb);
