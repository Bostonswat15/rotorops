-- =============================================================================
-- Cliff placement sites.
--
-- A cliff rescue was placed by stepping a random 0.6-3.6 nm off an airfield,
-- which on a coast like Howe Sound is open water half the time -- "Black Point"
-- put a climber, their quad and an orange smoke plume in the middle of the
-- Sound. Scans now collect mapped OSM cliffs, and cliff scenes are placed on
-- them.
--
-- set_base_sites rebuilds the cached sites from a list of known keys and drops
-- anything else, so without this the new cliff points would be discarded on
-- the way in. Same function otherwise, key added -- and a missing cliff key is
-- stored as missing, not as an empty list. A failed cliff lookup sends none,
-- and "we could not ask" must not be cached as "there are no cliffs here".
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_base_sites(_base_id UUID, _sites JSONB)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_company UUID;
  v_clean   JSONB := '{}'::JSONB;
  v_key     TEXT;
BEGIN
  SELECT company_id INTO v_company FROM public.bases WHERE id = _base_id;
  IF v_company IS NULL THEN RAISE EXCEPTION 'base not found'; END IF;
  IF NOT public.is_company_member(v_company) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;
  IF jsonb_typeof(_sites) <> 'object' THEN
    RAISE EXCEPTION 'sites must be an object';
  END IF;

  -- Rebuild from scratch rather than trusting what arrived: known keys only,
  -- well-formed [lat, lon] pairs only, and a hard cap per key.
  FOREACH v_key IN ARRAY ARRAY['offshore', 'lake', 'shore', 'river', 'road', 'cliff'] LOOP
    -- Unknown stays unknown, so the app looks the cliffs up again next time.
    CONTINUE WHEN v_key = 'cliff' AND NOT (_sites ? 'cliff');
    v_clean := v_clean || jsonb_build_object(v_key, COALESCE((
      SELECT jsonb_agg(p)
        FROM (
          SELECT jsonb_build_array(round((e->>0)::NUMERIC, 5),
                                   round((e->>1)::NUMERIC, 5)) AS p
            FROM jsonb_array_elements(COALESCE(_sites->v_key, '[]'::JSONB)) e
           WHERE jsonb_typeof(e) = 'array'
             AND (e->>0) ~ '^-?[0-9.]+$'
             AND (e->>1) ~ '^-?[0-9.]+$'
             AND (e->>0)::NUMERIC BETWEEN -90 AND 90
             AND (e->>1)::NUMERIC BETWEEN -180 AND 180
           LIMIT 150
        ) s), '[]'::JSONB));
  END LOOP;

  -- Hospitals carry a name as well as a position, so they are shaped
  -- differently from the placement points and validated separately.
  v_clean := v_clean || jsonb_build_object('hospital', COALESCE((
    SELECT jsonb_agg(h)
      FROM (
        SELECT jsonb_build_object(
                 'lat',  round((e->>'lat')::NUMERIC, 5),
                 'lon',  round((e->>'lon')::NUMERIC, 5),
                 'name', left(COALESCE(e->>'name', 'hospital'), 80),
                 'emergency', COALESCE((e->>'emergency')::BOOLEAN, false)) AS h
          FROM jsonb_array_elements(COALESCE(_sites->'hospital', '[]'::JSONB)) e
         WHERE jsonb_typeof(e) = 'object'
           AND (e->>'lat') ~ '^-?[0-9.]+$'
           AND (e->>'lon') ~ '^-?[0-9.]+$'
           AND (e->>'lat')::NUMERIC BETWEEN -90 AND 90
           AND (e->>'lon')::NUMERIC BETWEEN -180 AND 180
         LIMIT 60
      ) s), '[]'::JSONB));

  UPDATE public.bases
     SET placement_sites = v_clean, sites_scanned_at = now()
   WHERE id = _base_id;

  RETURN now();
END;$fn$;

GRANT EXECUTE ON FUNCTION public.set_base_sites(UUID, JSONB) TO authenticated;

-- No rescan is forced. A scan cached before this has no cliff key, which reads
-- as "cliffs unknown", and the next Generate looks up just the cliffs -- a
-- fraction of a full rescan -- without touching the roads, water and hospitals
-- already cached.
