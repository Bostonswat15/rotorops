-- =============================================================================
-- Cached water near a base.
--
-- The mission board offered "Vessel in Distress" and "Beach Extraction" from
-- landlocked fields, because nothing checked whether water existed -- water
-- scenes simply took the bearing with the fewest airports on the theory that
-- empty means sea. Inland, empty means farmland.
--
-- OSM knows where the water is, and MSFS renders its coastlines, lakes and
-- rivers from that same data, so OSM water is water you can actually ditch a
-- boat in. But the query is a broad area lookup that takes 15-20 seconds
-- against the public Overpass instance -- far too slow to run every time
-- someone hits Generate.
--
-- So it is scanned once per base and cached here, the same way nearby_airports
-- already is. Geometry is reduced to a short list of usable positions before it
-- is stored; the full OSM geometry is megabytes and none of it is needed after
-- placement points have been derived.
-- =============================================================================

ALTER TABLE public.bases
  ADD COLUMN IF NOT EXISTS water_sites JSONB,
  ADD COLUMN IF NOT EXISTS water_scanned_at TIMESTAMPTZ;

-- --------------------------------------------------------------------------
-- Written by the app rather than the bridge: the lookup is an HTTP call to
-- Overpass, which the browser makes and the sim bridge has no reason to.
--
-- Any company member may fill the cache. It is derived public map data, not a
-- spending decision, and a pilot generating contracts needs it as much as an
-- owner does.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_base_water(_base_id UUID, _sites JSONB)
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

  -- Rebuild the object from scratch rather than trusting what arrived: only
  -- the four known keys, only well-formed [lat, lon] pairs, and a hard cap so
  -- a bug in the client cannot push an unbounded blob into the row.
  FOREACH v_key IN ARRAY ARRAY['offshore', 'lake', 'shore', 'river'] LOOP
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

  UPDATE public.bases
     SET water_sites = v_clean, water_scanned_at = now()
   WHERE id = _base_id;

  RETURN now();
END;$fn$;

GRANT EXECUTE ON FUNCTION public.set_base_water(UUID, JSONB) TO authenticated;
