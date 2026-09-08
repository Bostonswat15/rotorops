-- =============================================================================
-- Industries: extraction and processing sites your company can haul for,
-- trade with, or invest in.
--
-- Every table here is company-scoped, the same as everything else in the app
-- -- your industries are the ones sited near your bases, not a single global
-- economy shared with every other company on the platform. That is a
-- deliberate scope decision: sharing one mutable market across every company
-- in the app is a materially different, much larger multiplayer problem, and
-- nothing about this feature request asked for it.
--
-- Stock and price are never trusted from a client. Every quoted number the
-- app shows is a preview computed the same way client-side (industries.ts) as
-- here; every action that spends or earns money re-derives the real number
-- from last_tick_at before touching a cent, the same discipline
-- aircraft_sale_value already holds to for the fleet.
-- =============================================================================

CREATE TABLE public.industries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  base_id UUID REFERENCES public.bases(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'forest', 'sawmill', 'farmland', 'grain_mill',
    'oil_well', 'refinery', 'quarry', 'steel_works'
  )),
  name TEXT,
  latitude NUMERIC NOT NULL,
  longitude NUMERIC NOT NULL,
  -- 'named' came straight from OSM's own tag or name. 'synthesised' is a
  -- processing site placed near its raw-material supplier because OSM had no
  -- confidently-named plant nearby -- shown to the player as such, not
  -- presented as a fact the way a named site is.
  confidence TEXT NOT NULL DEFAULT 'named' CHECK (confidence IN ('named', 'synthesised')),
  stock NUMERIC NOT NULL DEFAULT 0,
  capacity NUMERIC NOT NULL,
  base_rate NUMERIC NOT NULL,
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, base_id, kind)
);

ALTER TABLE public.industries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "industries read" ON public.industries
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- No direct INSERT/UPDATE/DELETE policy: every write goes through
-- site_industries / industry_tick / invest_in_industry below, all
-- SECURITY DEFINER. A client cannot set its own stock or capacity.
REVOKE INSERT, UPDATE, DELETE ON public.industries FROM authenticated;
GRANT SELECT ON public.industries TO authenticated;
GRANT ALL ON public.industries TO service_role;

CREATE TABLE public.company_industry_investments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  industry_id UUID NOT NULL REFERENCES public.industries(id) ON DELETE CASCADE,
  invested_total NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, industry_id)
);

ALTER TABLE public.company_industry_investments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "investments read" ON public.company_industry_investments
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

REVOKE INSERT, UPDATE, DELETE ON public.company_industry_investments FROM authenticated;
GRANT SELECT ON public.company_industry_investments TO authenticated;
GRANT ALL ON public.company_industry_investments TO service_role;

-- --------------------------------------------------------------------------
-- Chain table, mirrored from src/lib/industries.ts.
--
-- Kept in SQL as a lookup rather than hardcoded into every function below, so
-- there is one place to change a rate rather than six.
-- --------------------------------------------------------------------------
CREATE TABLE public.industry_defs (
  kind TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2)),
  output_good TEXT NOT NULL,
  input_good TEXT,
  default_capacity NUMERIC NOT NULL,
  base_rate NUMERIC NOT NULL,
  capacity_per_dollar NUMERIC NOT NULL,
  good_unit_lb NUMERIC NOT NULL,
  good_base_value NUMERIC NOT NULL
);
GRANT SELECT ON public.industry_defs TO authenticated, anon;

INSERT INTO public.industry_defs
  (kind, chain, tier, output_good, input_good, default_capacity, base_rate, capacity_per_dollar, good_unit_lb, good_base_value)
VALUES
  ('forest',      'timber', 1, 'timber', NULL,      4000, 60, 0.60, 45, 6),
  ('sawmill',     'timber', 2, 'lumber', 'timber',   2500, 40, 0.40, 38, 19),
  ('farmland',    'grain',  1, 'grain',  NULL,       5000, 70, 0.80, 50, 4),
  ('grain_mill',  'grain',  2, 'flour',  'grain',    3000, 45, 0.50, 50, 12),
  ('oil_well',    'fuel',   1, 'crude',  NULL,       3500, 35, 0.25, 55, 9),
  ('refinery',    'fuel',   2, 'avgas',  'crude',    2200, 28, 0.20, 46, 25),
  ('quarry',      'steel',  1, 'ore',    NULL,       4500, 50, 0.30, 62, 7),
  ('steel_works', 'steel',  2, 'steel',  'ore',      2000, 30, 0.15, 60, 34);

-- --------------------------------------------------------------------------
-- Site industries at a base from the client's OSM scan.
--
-- The scan itself (Overpass) has to happen client-side -- Postgres cannot
-- reach out to the internet -- so this function's job is to validate what
-- comes back rather than trust it outright: known kinds only, coordinates in
-- range, and idempotent (ON CONFLICT DO NOTHING) so re-scanning a base never
-- resets stock a company has already built up.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.site_industries(_base_id UUID, _sites JSONB)
RETURNS SETOF public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_company UUID;
  v_site    JSONB;
  v_kind    TEXT;
  v_def     public.industry_defs%ROWTYPE;
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
    IF (v_site->>'lat')::NUMERIC NOT BETWEEN -90 AND 90 THEN CONTINUE; END IF;
    IF (v_site->>'lon')::NUMERIC NOT BETWEEN -180 AND 180 THEN CONTINUE; END IF;

    INSERT INTO public.industries
      (company_id, base_id, kind, name, latitude, longitude, confidence, stock, capacity, base_rate)
    VALUES (
      v_company, _base_id, v_kind,
      NULLIF(left(COALESCE(v_site->>'name', ''), 80), ''),
      (v_site->>'lat')::NUMERIC, (v_site->>'lon')::NUMERIC,
      CASE WHEN v_site->>'confidence' = 'synthesised' THEN 'synthesised' ELSE 'named' END,
      -- New sites start half-stocked: neither an instant surplus to exploit
      -- nor a shortage nobody can service on day one.
      v_def.default_capacity * 0.5, v_def.default_capacity, v_def.base_rate
    )
    ON CONFLICT (company_id, base_id, kind) DO NOTHING;
  END LOOP;

  RETURN QUERY SELECT * FROM public.industries WHERE base_id = _base_id AND company_id = v_company;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.site_industries(UUID, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.site_industries(UUID, JSONB) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Advance one industry's stock to now, and settle its passive royalty.
--
-- Tier 1 produces from nothing, capped by capacity. Tier 2 consumes its
-- paired tier-1 site's stock at the same rate it produces its own good,
-- capped by whichever is scarcer: its own headroom, or the input actually on
-- hand. This is the same formula projectStock() runs client-side for the
-- instant preview; this copy is the one that is ever trusted to move money.
--
-- Any company invested in a site earns a trickle of royalty proportional to
-- its ownership share and how much the site actually produced this tick,
-- representing the site selling its surplus into the wider economy this app
-- does not otherwise model. Credited straight to economy_transactions.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.industry_tick(_industry_id UUID)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind      public.industries%ROWTYPE;
  v_def      public.industry_defs%ROWTYPE;
  v_input    public.industries%ROWTYPE;
  v_hours    NUMERIC;
  v_made     NUMERIC;
  v_consumed NUMERIC;
  v_price    NUMERIC;
  v_inv      RECORD;
  v_royalty  NUMERIC;
  v_total_invested NUMERIC;
BEGIN
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'industry not found'; END IF;
  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;

  v_hours := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_ind.last_tick_at)) / 3600.0);
  IF v_hours < (1.0 / 60) THEN RETURN v_ind; END IF; -- nothing meaningful happened

  IF v_def.tier = 1 THEN
    v_made := LEAST(v_def.base_rate * v_hours, GREATEST(0, v_ind.capacity - v_ind.stock));
    v_ind.stock := v_ind.stock + v_made;
  ELSE
    SELECT * INTO v_input FROM public.industries
      WHERE company_id = v_ind.company_id AND base_id = v_ind.base_id
        AND kind = (SELECT kind FROM public.industry_defs WHERE chain = v_def.chain AND tier = 1)
      FOR UPDATE;
    v_made := LEAST(
      v_def.base_rate * v_hours,
      GREATEST(0, v_ind.capacity - v_ind.stock),
      COALESCE(v_input.stock, 0)
    );
    IF FOUND THEN
      UPDATE public.industries SET stock = stock - v_made WHERE id = v_input.id;
    END IF;
    v_ind.stock := v_ind.stock + v_made;
  END IF;

  -- Royalty: base value at a balanced market times what was actually made,
  -- split across every company invested in proportion to their stake.
  IF v_made > 0 THEN
    SELECT SUM(invested_total) INTO v_total_invested
      FROM public.company_industry_investments WHERE industry_id = _industry_id;
    IF v_total_invested > 0 THEN
      v_price := v_def.good_base_value;
      FOR v_inv IN
        SELECT company_id, invested_total FROM public.company_industry_investments
         WHERE industry_id = _industry_id AND invested_total > 0
      LOOP
        -- A gentle royalty, not the sale price itself -- investors are
        -- paid a cut of throughput, not the full market value of every unit,
        -- or owning a stake would simply be a better contract than flying one.
        v_royalty := ROUND(v_made * v_price * 0.06 * (v_inv.invested_total / v_total_invested), 2);
        IF v_royalty >= 0.01 THEN
          UPDATE public.companies SET cash = cash + v_royalty WHERE id = v_inv.company_id;
          INSERT INTO public.economy_transactions (company_id, type, amount, description)
          VALUES (v_inv.company_id, 'industry_royalty', v_royalty,
                  format('Royalty from %s (%s)', COALESCE(v_ind.name, v_def.chain), v_def.kind));
        END IF;
      END LOOP;
    END IF;
  END IF;

  UPDATE public.industries SET stock = v_ind.stock, last_tick_at = now()
   WHERE id = _industry_id RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.industry_tick(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.industry_tick(UUID) FROM PUBLIC, anon;

-- Bring every industry at a base up to date in one call, so opening the
-- Trading Hall shows current numbers without one round trip per site.
CREATE OR REPLACE FUNCTION public.tick_base_industries(_base_id UUID)
RETURNS SETOF public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_id UUID;
BEGIN
  -- Tier 1 first, so a tier-2 site's tick always sees this cycle's freshly
  -- produced input rather than whatever was left over from last time.
  FOR v_id IN
    SELECT i.id FROM public.industries i
      JOIN public.industry_defs d ON d.kind = i.kind
     WHERE i.base_id = _base_id
     ORDER BY d.tier ASC
  LOOP
    PERFORM public.industry_tick(v_id);
  END LOOP;
  RETURN QUERY SELECT * FROM public.industries WHERE base_id = _base_id;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.tick_base_industries(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.tick_base_industries(UUID) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Invest in an industry: buy a durable stake, and a permanent bump to its
-- capacity -- your capital paying for a bigger silo or a faster line, not a
-- one-off boost that evaporates.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invest_in_industry(_industry_id UUID, _amount NUMERIC)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind public.industries%ROWTYPE;
  v_def public.industry_defs%ROWTYPE;
  v_co  public.companies%ROWTYPE;
BEGIN
  IF _amount <= 0 THEN RAISE EXCEPTION 'investment must be positive'; END IF;

  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'industry not found'; END IF;
  IF NOT public.can_manage_company(v_ind.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can invest company funds';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_ind.company_id FOR UPDATE;
  IF v_co.cash < _amount THEN
    RAISE EXCEPTION 'insufficient cash for a $% investment', _amount;
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;

  UPDATE public.companies SET cash = cash - _amount WHERE id = v_ind.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_ind.company_id, 'industry_investment', -_amount,
          format('Invested in %s', COALESCE(v_ind.name, v_def.kind)));

  INSERT INTO public.company_industry_investments (company_id, industry_id, invested_total)
  VALUES (v_ind.company_id, _industry_id, _amount)
  ON CONFLICT (company_id, industry_id)
  DO UPDATE SET invested_total = public.company_industry_investments.invested_total + _amount;

  UPDATE public.industries
     SET capacity = capacity + (_amount * v_def.capacity_per_dollar)
   WHERE id = _industry_id
   RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.invest_in_industry(UUID, NUMERIC) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.invest_in_industry(UUID, NUMERIC) FROM PUBLIC, anon;

-- Great-circle distance in nautical miles, for pricing a trade run's leg.
CREATE OR REPLACE FUNCTION public.great_circle_nm(
  _lat1 NUMERIC, _lon1 NUMERIC, _lat2 NUMERIC, _lon2 NUMERIC)
RETURNS NUMERIC LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 2 * 3440.065 * asin(least(1, sqrt(
    sin(radians(_lat2 - _lat1) / 2) ^ 2 +
    cos(radians(_lat1)) * cos(radians(_lat2)) * sin(radians(_lon2 - _lon1) / 2) ^ 2
  )));
$fn$;

-- --------------------------------------------------------------------------
-- Dispatch a player-chosen trade run: buy from one site, sell to another.
--
-- Unlike a procedurally generated contract, the player picks the quantity and
-- the destination from the Trading Hall. The margin is locked in at dispatch
-- from the live (ticked) price at both ends, then paid out through the
-- existing flight-resolution pipeline exactly like any other contract --
-- dispatch_mission and rotorops_resolve_flight are untouched, this only
-- builds the missions row they already know how to run.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_trade_run(
  _from_industry_id UUID, _to_industry_id UUID, _quantity NUMERIC)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_from public.industries%ROWTYPE;
  v_to   public.industries%ROWTYPE;
  v_def  public.industry_defs%ROWTYPE;
  v_buy  NUMERIC;
  v_sell NUMERIC;
  v_weight NUMERIC;
  v_dist NUMERIC;
  v_icao TEXT;
  v_row  public.missions%ROWTYPE;
BEGIN
  IF _quantity <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;

  PERFORM public.industry_tick(_from_industry_id);
  PERFORM public.industry_tick(_to_industry_id);

  SELECT * INTO v_from FROM public.industries WHERE id = _from_industry_id;
  SELECT * INTO v_to   FROM public.industries WHERE id = _to_industry_id;
  IF NOT FOUND OR v_from.company_id IS NULL THEN RAISE EXCEPTION 'industry not found'; END IF;
  IF v_from.company_id <> v_to.company_id THEN
    RAISE EXCEPTION 'both industries must belong to your company';
  END IF;
  IF NOT public.can_manage_company(v_from.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can dispatch a trade run';
  END IF;
  IF _quantity > v_from.stock THEN
    RAISE EXCEPTION 'only %s units available to buy', ROUND(v_from.stock);
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_from.kind;

  -- Same curve as the client preview: cheap where there is a surplus,
  -- expensive as stock runs toward empty.
  v_buy  := v_def.good_base_value * (2.4 - 1.85 * LEAST(1, v_from.stock / NULLIF(v_from.capacity, 0)));
  v_sell := v_def.good_base_value * (2.1 - 1.6  * LEAST(1, v_to.stock   / NULLIF(v_to.capacity, 0)));
  v_weight := _quantity * v_def.good_unit_lb;
  v_dist := public.great_circle_nm(v_from.latitude, v_from.longitude, v_to.latitude, v_to.longitude);

  -- The precise pickup and delivery points are enforced by the objectives
  -- below (land_off against real coordinates); this is only the loose
  -- accounting ICAO resolve_flight checks arrival against, same convention
  -- every scene-based contract already uses -- a SAR delivery to a hospital
  -- still records destination = base.icao, not the hospital.
  SELECT icao INTO v_icao FROM public.bases
   WHERE company_id = v_from.company_id AND icao IS NOT NULL
   ORDER BY (id = v_from.base_id) DESC, (id = v_to.base_id) DESC
   LIMIT 1;

  INSERT INTO public.missions (
    company_id, role, title, description, origin, destination, distance_nm,
    required_tags, required_certs, min_payload, payout, difficulty, weather_factor,
    scene_lat, scene_lon, scene_type, scene_name, status, objectives
  ) VALUES (
    v_from.company_id, 'trade',
    format('Trade Run — %s', v_def.output_good),
    format('Buy %s units at %s, deliver to %s. Margin locked at dispatch.',
           ROUND(_quantity), COALESCE(v_from.name, v_from.kind), COALESCE(v_to.name, v_to.kind)),
    v_icao, v_icao, GREATEST(2, ROUND(v_dist)),
    ARRAY['cargo', 'medium_utility', 'heavy_lift']::TEXT[], ARRAY[]::TEXT[],
    ROUND(v_weight * 0.85),
    GREATEST(0, ROUND(_quantity * (v_sell - v_buy))),
    2, 2,
    v_to.latitude, v_to.longitude, 'industry', COALESCE(v_to.name, v_def.kind),
    'available',
    -- The same reach / payload / land_off shape every logistics contract
    -- already uses, so the sim bridge needs no changes to arm and track this.
    jsonb_build_array(
      jsonb_build_object(
        'id', 'reach', 'kind', 'reach', 'label',
        format('Reach %s', COALESCE(v_from.name, v_def.kind)),
        'lat', v_from.latitude, 'lon', v_from.longitude, 'radius_nm', 0.7),
      jsonb_build_object(
        'id', 'load', 'kind', 'payload', 'label',
        format('Load %s units', ROUND(_quantity)),
        'min_delta_lb', ROUND(v_weight * 0.85)),
      jsonb_build_object(
        'id', 'deliver', 'kind', 'land_off', 'label',
        format('Deliver to %s', COALESCE(v_to.name, v_def.kind)),
        'lat', v_to.latitude, 'lon', v_to.longitude, 'radius_nm', 0.5)
    )
  ) RETURNING * INTO v_row;

  -- Buying draws the stock down immediately -- it is committed the moment
  -- the run is dispatched, not on delivery, so two trade runs can't both
  -- claim the same surplus.
  UPDATE public.industries SET stock = stock - _quantity WHERE id = _from_industry_id;

  RETURN v_row;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.dispatch_trade_run(UUID, UUID, NUMERIC) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_trade_run(UUID, UUID, NUMERIC) FROM PUBLIC, anon;

