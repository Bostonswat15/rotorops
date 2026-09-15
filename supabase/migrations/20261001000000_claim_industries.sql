-- =============================================================================
-- Industry mode: a site is yours once you build or claim it (user chose this,
-- 2026-09-15: Industry mode only; claiming costs the site's full build cost).
--
-- A scan hands a company every nearby chain for free, which made Industry
-- mode's single free camp meaningless. In Industry mode a scanned site now
-- stays unclaimed until claim_industry buys it at industry_defs.build_cost.
-- An unclaimed site can't be staffed, invested in or traded with, a mill
-- doesn't draw on an unclaimed camp, and the bridge doesn't dress it. Career
-- companies own every site, exactly as before.
--
--   industries.claimed_at        when it was claimed; built sites are owned anyway
--   industry_is_owned(id)        Career, built, or claimed
--   claim_industry(id)           Industry mode, owners and managers
--
-- Carried forward whole: set_industry_workers from 20260910120000_industry_staffing.sql,
-- invest_in_industry from 20260903000000_industries.sql, dispatch_trade_run from 20260926000000_half_real_economy.sql,
-- industry_tick from 20260918000000_industry_flow.sql, bridge_state from 20260928000000_camps_on_bridge.sql.
-- Run after 20260930000000_industry_mode.sql. Safe to re-run.
-- =============================================================================

ALTER TABLE public.industries ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.industry_is_owned(_industry_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE((
    SELECT c.play_mode <> 'industry' OR i.source = 'built' OR i.claimed_at IS NOT NULL
      FROM public.industries i
      JOIN public.companies c ON c.id = i.company_id
     WHERE i.id = _industry_id), false);
$fn$;
GRANT EXECUTE ON FUNCTION public.industry_is_owned(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.industry_is_owned(UUID) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.claim_industry(_industry_id UUID)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind public.industries%ROWTYPE;
  v_def public.industry_defs%ROWTYPE;
  v_co  public.companies%ROWTYPE;
BEGIN
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'site not found'; END IF;
  IF NOT public.can_manage_company(v_ind.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can claim a site';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_ind.company_id FOR UPDATE;
  IF v_co.play_mode <> 'industry' THEN
    RAISE EXCEPTION 'claiming is part of Industry mode -- in Career every site is already yours';
  END IF;
  IF v_ind.source = 'built' OR v_ind.claimed_at IS NOT NULL THEN
    RAISE EXCEPTION 'this site is already yours';
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;
  IF v_co.cash < v_def.build_cost THEN
    RAISE EXCEPTION 'claiming this site costs $% -- insufficient cash', v_def.build_cost;
  END IF;

  UPDATE public.companies SET cash = cash - v_def.build_cost WHERE id = v_co.id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_co.id, 'industry_claim', -v_def.build_cost,
          format('Claimed %s (%s)', COALESCE(v_ind.name, v_def.kind), v_def.kind));

  -- Its clock starts now: nothing was produced or paid while it wasn't yours.
  UPDATE public.industries SET claimed_at = now(), last_tick_at = now()
   WHERE id = _industry_id RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;
GRANT EXECUTE ON FUNCTION public.claim_industry(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_industry(UUID) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.set_industry_workers(_industry_id UUID, _workers INTEGER)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind public.industries%ROWTYPE;
  v_def public.industry_defs%ROWTYPE;
BEGIN
  IF _workers < 0 THEN RAISE EXCEPTION 'workers cannot be negative'; END IF;

  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'industry not found'; END IF;
  IF NOT public.can_manage_company(v_ind.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can staff a site';
  END IF;
  IF _workers > 0 AND NOT public.industry_is_owned(_industry_id) THEN
    RAISE EXCEPTION 'claim this site on the Trading Hall before staffing it';
  END IF;

  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;
  IF _workers > v_def.max_workers THEN
    RAISE EXCEPTION 'this site can only usefully staff % workers', v_def.max_workers;
  END IF;

  UPDATE public.industries SET workers = _workers WHERE id = _industry_id
  RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

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
  IF NOT public.industry_is_owned(_industry_id) THEN
    RAISE EXCEPTION 'claim this site on the Trading Hall before investing in it';
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
  IF NOT public.industry_is_owned(_from_industry_id) OR NOT public.industry_is_owned(_to_industry_id) THEN
    RAISE EXCEPTION 'both sites have to be yours -- claim them on the Trading Hall';
  END IF;
  IF _quantity > v_from.stock THEN
    RAISE EXCEPTION 'only % units available to buy', ROUND(v_from.stock);
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
    scene_lat, scene_lon, scene_type, scene_name, status, objectives,
    haul_from_industry_id, haul_to_industry_id, haul_units
  ) VALUES (
    v_from.company_id, 'trade',
    format('Trade Run — %s', v_def.output_good),
    format('Buy %s units at %s, deliver to %s. Margin locked at dispatch.',
           ROUND(_quantity), COALESCE(v_from.name, v_from.kind), COALESCE(v_to.name, v_to.kind)),
    v_icao, v_icao, GREATEST(2, ROUND(v_dist)),
    ARRAY['cargo', 'medium_utility', 'heavy_lift']::TEXT[], ARRAY[]::TEXT[],
    ROUND(v_weight * 0.85),
    -- Contract pay is doubled in the half-real economy (PAY_SCALE in src/lib/economy.ts).
    GREATEST(0, ROUND(_quantity * (v_sell - v_buy) * 2)),
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
    ),
    _from_industry_id, _to_industry_id, _quantity
  ) RETURNING * INTO v_row;

  -- Recorded so the goods reach the buyer when the run is delivered, and go
  -- back if it fails or is deleted before it's flown.
  INSERT INTO public.industry_deliveries (
    mission_id, company_id, from_industry_id, to_industry_id, good, units)
  VALUES (v_row.id, v_from.company_id, _from_industry_id, _to_industry_id,
          v_def.output_good, _quantity);

  -- Buying draws the stock down immediately -- it is committed the moment
  -- the run is dispatched, not on delivery, so two trade runs can't both
  -- claim the same surplus.
  UPDATE public.industries SET stock = stock - _quantity WHERE id = _from_industry_id;

  RETURN v_row;
END;$fn$;

CREATE OR REPLACE FUNCTION public.industry_tick(_industry_id UUID)
RETURNS public.industries
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ind      public.industries%ROWTYPE;
  v_def      public.industry_defs%ROWTYPE;
  v_input    public.industries%ROWTYPE;
  v_hours    NUMERIC;
  v_made     NUMERIC;
  v_want     NUMERIC;
  v_room     NUMERIC;
  v_from_buffer NUMERIC := 0;
  v_from_camp   NUMERIC := 0;
  v_wage     NUMERIC;
  v_staff_frac NUMERIC;
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

  -- Wages: billed for the labor on shift regardless of whether it produced
  -- anything sellable this tick (capacity full, or no input to work with).
  IF v_ind.workers > 0 THEN
    v_wage := v_ind.workers * v_def.wage_per_hour * v_hours;
    UPDATE public.companies SET cash = cash - v_wage WHERE id = v_ind.company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (v_ind.company_id, 'industry_wages', -ROUND(v_wage),
            format('Wages: %s (%s workers)', COALESCE(v_ind.name, v_def.kind), v_ind.workers));
  END IF;

  v_staff_frac := LEAST(1.0, v_ind.workers::NUMERIC / NULLIF(v_def.max_workers, 0));
  v_staff_frac := COALESCE(v_staff_frac, 0);

  IF v_def.tier = 1 THEN
    v_made := LEAST(v_def.base_rate * v_staff_frac * v_hours, GREATEST(0, v_ind.capacity - v_ind.stock));
    v_ind.stock := v_ind.stock + v_made;
  ELSE
    -- Flown-in input first, at the full rate; then straight from the camp at
    -- half the rate. Pulling everything from the camp meant a delivered haul
    -- changed nothing.
    v_want := v_def.base_rate * v_staff_frac * v_hours;
    v_room := GREATEST(0, v_ind.capacity - v_ind.stock);
    v_from_buffer := LEAST(v_want, v_room, GREATEST(0, v_ind.input_stock));
    SELECT * INTO v_input FROM public.industries
      WHERE company_id = v_ind.company_id AND base_id = v_ind.base_id
        AND kind = (SELECT kind FROM public.industry_defs WHERE chain = v_def.chain AND tier = 1)
        -- A mill only draws on a camp the company owns (Industry mode).
        AND public.industry_is_owned(id)
      LIMIT 1
      FOR UPDATE;
    IF FOUND THEN
      v_from_camp := GREATEST(0, LEAST(
        LEAST(v_want, v_room) - v_from_buffer,
        v_want * 0.5,
        v_input.stock
      ));
      UPDATE public.industries SET stock = stock - v_from_camp WHERE id = v_input.id;
    END IF;
    v_made := v_from_buffer + v_from_camp;
    v_ind.input_stock := v_ind.input_stock - v_from_buffer;
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

  UPDATE public.industries
     SET stock = v_ind.stock, input_stock = v_ind.input_stock, last_tick_at = now()
   WHERE id = _industry_id RETURNING * INTO v_ind;
  RETURN v_ind;
END;$fn$;

CREATE OR REPLACE FUNCTION public.bridge_state(_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_dev public.sim_devices%ROWTYPE;
  v_out JSONB;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.sim_devices SET last_seen_at = now() WHERE id = v_dev.id;

  SELECT jsonb_build_object(
    'company', (SELECT to_jsonb(c) - 'user_id' FROM public.companies c
                 WHERE c.id = v_dev.company_id),
    'role', (SELECT role FROM public.company_members
              WHERE company_id = v_dev.company_id AND user_id = v_dev.user_id),
    'aircraft', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'internal_id', a.internal_id, 'display_name', a.display_name,
        'sim_title', a.sim_title, 'sim_title_aliases', a.sim_title_aliases,
        'status', a.status, 'hours', a.hours, 'wear', a.wear,
        'cruise_kts', a.cruise_kts, 'fuel_burn_pph', a.fuel_burn_pph,
        'empty_weight_lb', a.empty_weight_lb, 'max_gross_lb', a.max_gross_lb,
        'fuel_capacity_lb', a.fuel_capacity_lb
      )) FROM public.aircraft a
      WHERE a.company_id = v_dev.company_id
        AND a.status NOT IN ('destroyed', 'sold', 'returned')), '[]'::JSONB),
    'dispatched', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', m.id, 'title', m.title, 'role', m.role,
        'origin', m.origin, 'destination', m.destination,
        'distance_nm', m.distance_nm, 'min_payload', m.min_payload,
        'payout', m.payout, 'difficulty', m.difficulty,
        'aircraft_id', m.aircraft_id, 'dispatched_at', m.dispatched_at,
        'scene_lat', m.scene_lat, 'scene_lon', m.scene_lon,
        'scene_name', m.scene_name, 'scene_type', m.scene_type,
        'objectives', m.objectives, 'objectives_state', m.objectives_state,
        'restart_from', m.restart_from, 'crash_count', m.crash_count
      )) FROM public.missions m
      WHERE m.company_id = v_dev.company_id
        AND m.status = 'in_progress'
        -- Cargo jobs fly as trips, below.
        AND m.trip_id IS NULL
        AND (m.assigned_pilot_id IS NULL OR m.assigned_pilot_id = v_dev.user_id)),
      '[]'::JSONB),
    -- Open trips this pilot is flying: where they load, and each job's drop.
    'trips', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'aircraft_id', t.aircraft_id, 'fuel_lb', t.fuel_lb,
        'cargo_lb', t.cargo_lb, 'pax', t.pax,
        'pickup_name', t.pickup_name, 'pickup_icao', t.pickup_icao,
        'pickup_lat', t.pickup_lat, 'pickup_lon', t.pickup_lon,
        'pickup_radius_nm', t.pickup_radius_nm, 'loaded_at', t.loaded_at,
        'jobs', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', j.id, 'title', j.title, 'cargo_lb', j.cargo_lb, 'payout', j.payout,
            'drop_name', j.drop_name, 'drop_icao', j.drop_icao,
            'drop_lat', j.drop_lat, 'drop_lon', j.drop_lon,
            'drop_radius_nm', j.drop_radius_nm,
            'delivered', j.delivered_at IS NOT NULL
          ) ORDER BY j.generated_at, j.id) FROM public.missions j WHERE j.trip_id = t.id), '[]'::JSONB)
      )) FROM public.trips t
      WHERE t.company_id = v_dev.company_id
        AND t.status = 'active'
        AND (t.pilot_id IS NULL OR t.pilot_id = v_dev.user_id)), '[]'::JSONB),
    'bases_needing_position', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao
      )) FROM public.bases b
      WHERE b.company_id = v_dev.company_id
        AND b.icao IS NOT NULL AND b.latitude IS NULL), '[]'::JSONB),
    -- Company industry sites, so the bridge can dress a camp whenever you fly near it.
    'industries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', i.id, 'kind', i.kind, 'name', i.name,
        'latitude', i.latitude, 'longitude', i.longitude
      )) FROM public.industries i
      WHERE i.company_id = v_dev.company_id
        AND i.latitude IS NOT NULL AND i.longitude IS NOT NULL
        -- Only the company's own camps get dressed (Industry mode).
        AND public.industry_is_owned(i.id)), '[]'::JSONB),
    'bases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao, 'name', b.name,
        'latitude', b.latitude, 'longitude', b.longitude,
        'airport_count', jsonb_array_length(b.nearby_airports),
        'airports_updated_at', b.airports_updated_at
      )) FROM public.bases b WHERE b.company_id = v_dev.company_id), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;
