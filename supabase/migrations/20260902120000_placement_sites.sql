-- =============================================================================
-- Roads and hospitals, alongside the water.
--
-- The same fix that stopped vessels appearing in wheat fields applies to the
-- land: a "Highway RTC" whose briefing says the police have closed the road for
-- you was being placed a couple of miles from a random airfield, in a paddock.
-- And every casualty, however critical, was delivered back to your own hangar.
--
-- So the cached scan now also holds real carriageways to crash on and real
-- hospitals to deliver to. The column is renamed to match what it holds; it was
-- only ever water for one day.
--
-- Safe to run whether or not 20260901140000_base_water.sql has been applied.
-- =============================================================================

ALTER TABLE public.bases
  ADD COLUMN IF NOT EXISTS water_sites JSONB,
  ADD COLUMN IF NOT EXISTS water_scanned_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bases'
                AND column_name = 'water_sites') THEN
    ALTER TABLE public.bases RENAME COLUMN water_sites TO placement_sites;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'bases'
                AND column_name = 'water_scanned_at') THEN
    ALTER TABLE public.bases RENAME COLUMN water_scanned_at TO sites_scanned_at;
  END IF;
END$$;

-- Belt and braces if this runs on a database that never saw the first migration.
ALTER TABLE public.bases
  ADD COLUMN IF NOT EXISTS placement_sites JSONB,
  ADD COLUMN IF NOT EXISTS sites_scanned_at TIMESTAMPTZ;

DROP FUNCTION IF EXISTS public.set_base_water(UUID, JSONB);

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
  FOREACH v_key IN ARRAY ARRAY['offshore', 'lake', 'shore', 'river', 'road'] LOOP
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

-- The scan is wider than it was, so anything cached under the old shape is
-- missing roads and hospitals. Clear it and let the next Generate refill it.
UPDATE public.bases SET sites_scanned_at = NULL WHERE placement_sites IS NOT NULL;
