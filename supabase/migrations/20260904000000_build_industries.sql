-- =============================================================================
-- Build a camp wherever you like.
--
-- Until now every industry came from scanning real OSM land use -- a forest,
-- a farm, a quarry. That's still how a site with a genuine real-world anchor
-- gets found. But a company should also be able to build a camp of its own
-- choosing, anywhere, the same way it buys an aircraft: spend real capital,
-- get a durable asset.
--
-- Two schema changes make room for that:
--
--   - `kind` moves from a hardcoded CHECK list to a foreign key against
--     industry_defs. A CHECK list needs a migration every time a new chain is
--     added (as this file already needs, for fishing); a foreign key extends
--     itself the moment a new row lands in industry_defs.
--   - the UNIQUE(company_id, base_id, kind) constraint is dropped. It existed
--     to stop a re-scan from duplicating a site, which is fine when there is
--     only ever one of each kind -- but a company building its own camps
--     might reasonably want two lumber camps in different valleys. The
--     re-scan's duplicate guard moves to a proximity check instead: found
--     again within 3 nm of a site you already have, skip it; found somewhere
--     else, it's a different site.
-- =============================================================================

ALTER TABLE public.industries DROP CONSTRAINT IF EXISTS industries_kind_check;
ALTER TABLE public.industries DROP CONSTRAINT IF EXISTS industries_company_id_base_id_kind_key;

ALTER TABLE public.industries
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'scanned' CHECK (source IN ('scanned', 'built'));

ALTER TABLE public.industries
  ADD CONSTRAINT industries_kind_fkey FOREIGN KEY (kind) REFERENCES public.industry_defs(kind);

-- --------------------------------------------------------------------------
-- Fishing joins the four land chains: raw Fresh Catch from a camp you place
-- on the coast, processed into Packed Seafood at a cannery. Nothing in OSM
-- tags a "fishing camp" reliably enough to auto-site one the way a forest or
-- a quarry can be, so this chain is build-only -- which is exactly the chain
-- to prove that path works.
-- --------------------------------------------------------------------------
ALTER TABLE public.industry_defs
  ADD COLUMN IF NOT EXISTS build_cost NUMERIC NOT NULL DEFAULT 50000;

UPDATE public.industry_defs SET build_cost = v.cost FROM (VALUES
  ('forest', 55000), ('sawmill', 130000),
  ('farmland', 40000), ('grain_mill', 100000),
  ('oil_well', 200000), ('refinery', 420000),
  ('quarry', 70000), ('steel_works', 380000)
) AS v(kind, cost) WHERE public.industry_defs.kind = v.kind;

INSERT INTO public.industry_defs
  (kind, chain, tier, output_good, input_good, default_capacity, base_rate, capacity_per_dollar, good_unit_lb, good_base_value, build_cost)
VALUES
  ('fishing_camp', 'fishing', 1, 'fish',    NULL,     3800, 55, 0.35, 40, 5,  60000),
  ('cannery',      'fishing', 2, 'seafood', 'fish',   2400, 35, 0.25, 35, 17, 140000)
ON CONFLICT (kind) DO NOTHING;

-- --------------------------------------------------------------------------
-- Build a new site from nothing.
--
-- Costs real capital -- without a cost, a company could carpet the map in
-- free tier-1 extraction sites and print money forever, since a scanned site
-- costs nothing precisely because it already existed before you found it. A
-- built one starts at zero stock, not the 50% a scanned site opens with: you
-- just broke ground, there is nothing sitting in the yard yet.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.place_industry(
  _base_id UUID, _kind TEXT, _lat NUMERIC, _lon NUMERIC, _name TEXT DEFAULT NULL)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_company UUID;
  v_def     public.industry_defs%ROWTYPE;
  v_co      public.companies%ROWTYPE;
  v_row     public.industries%ROWTYPE;
BEGIN
  SELECT company_id INTO v_company FROM public.bases WHERE id = _base_id;
  IF v_company IS NULL THEN RAISE EXCEPTION 'base not found'; END IF;
  IF NOT public.can_manage_company(v_company) THEN
    RAISE EXCEPTION 'only owners and managers can build a new site';
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = _kind;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown industry kind: %', _kind; END IF;

  IF _lat NOT BETWEEN -90 AND 90 OR _lon NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'invalid coordinates';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_company FOR UPDATE;
  IF v_co.cash < v_def.build_cost THEN
    RAISE EXCEPTION 'building a %s costs $%s -- insufficient cash', v_def.kind, v_def.build_cost;
  END IF;

  UPDATE public.companies SET cash = cash - v_def.build_cost WHERE id = v_company;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_company, 'industry_construction', -v_def.build_cost,
          format('Built %s (%s)', COALESCE(NULLIF(trim(_name), ''), v_def.kind), v_def.kind));

  INSERT INTO public.industries
    (company_id, base_id, kind, name, latitude, longitude, confidence, source, stock, capacity, base_rate)
  VALUES (
    v_company, _base_id, _kind, NULLIF(left(COALESCE(_name, ''), 80), ''),
    _lat, _lon, 'named', 'built',
    0, v_def.default_capacity, v_def.base_rate
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.place_industry(UUID, TEXT, NUMERIC, NUMERIC, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.place_industry(UUID, TEXT, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Re-scanning no longer relies on the dropped unique constraint to avoid
-- duplicating a site -- it checks for one of the same kind within 3 nm
-- instead, close enough to be "the same real forest again" without also
-- swallowing a deliberately separate camp you built nearby.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.site_industries(_base_id UUID, _sites JSONB)
RETURNS SETOF public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_company UUID;
  v_site    JSONB;
  v_kind    TEXT;
  v_def     public.industry_defs%ROWTYPE;
  v_lat     NUMERIC;
  v_lon     NUMERIC;
BEGIN
  SELECT company_id INTO v_company FROM public.bases WHERE id = _base_id;
  IF v_company IS NULL THEN RAISE EXCEPTION 'base not found'; END IF;
  IF NOT public.is_company_member(v_company) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;
  IF jsonb_typeof(_sites) <> 'array' THEN
    RAISE EXCEPTION 'sites must be an array';
  END IF;

  FOR v_site IN SELECT * FROM jsonb_array_elements(_sites) LOOP
    v_kind := v_site->>'kind';
    SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_kind;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF (v_site->>'lat') !~ '^-?[0-9.]+$' OR (v_site->>'lon') !~ '^-?[0-9.]+$' THEN CONTINUE; END IF;
    v_lat := (v_site->>'lat')::NUMERIC;
    v_lon := (v_site->>'lon')::NUMERIC;
    IF v_lat NOT BETWEEN -90 AND 90 OR v_lon NOT BETWEEN -180 AND 180 THEN CONTINUE; END IF;

    IF EXISTS (
      SELECT 1 FROM public.industries
       WHERE company_id = v_company AND base_id = _base_id AND kind = v_kind
         AND public.great_circle_nm(latitude, longitude, v_lat, v_lon) < 3
    ) THEN
      CONTINUE;
    END IF;

    INSERT INTO public.industries
      (company_id, base_id, kind, name, latitude, longitude, confidence, source, stock, capacity, base_rate)
    VALUES (
      v_company, _base_id, v_kind,
      NULLIF(left(COALESCE(v_site->>'name', ''), 80), ''),
      v_lat, v_lon,
      CASE WHEN v_site->>'confidence' = 'synthesised' THEN 'synthesised' ELSE 'named' END,
      'scanned',
      -- New sites start half-stocked: neither an instant surplus to exploit
      -- nor a shortage nobody can service on day one.
      v_def.default_capacity * 0.5, v_def.default_capacity, v_def.base_rate
    );
  END LOOP;

  RETURN QUERY SELECT * FROM public.industries WHERE base_id = _base_id AND company_id = v_company;
END;$fn$;
