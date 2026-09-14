-- =============================================================================
-- Half-real economy (user approved 2026-09-14).
--
-- Aircraft prices were the sim's own figures: planes near real life, helicopters
-- a fifth to a fifteenth of it. The catalogue (src/lib/aircraft-catalog.ts) now
-- prices every aircraft at about half its real-world value, and contract pay is
-- doubled (PAY_SCALE in src/lib/economy.ts) so growing still takes tens of
-- contracts, not hundreds. Here, the parts the server owns:
--
--   * Starting cash: Easy $1,000,000, Normal $500,000, Hard $250,000
--     (was $500k / $250k / $120k).
--   * A free starter aircraft can cost at most $175,000; planes offered every
--     airframe, a $28.5M Citation included.
--   * Loan credit limit: $250k plus half the owned fleet's resale (was $100k).
--   * Trade runs pay twice the locked margin, like every other contract.
--   * Aircraft already owned are repriced to the new catalogue, so resale value,
--     repair costs and the loan limit follow. Leased aircraft keep their price
--     and lease rate; sold, returned and destroyed airframes stay as history.
--
-- Contracts already on a board keep the payout they were generated with.
--
-- Carried forward whole: create_company from 20260827120300_create_company.sql,
-- company_loan_limit from 20260914000000_maintenance_and_loans.sql, dispatch_trade_run from 20260918000000_industry_flow.sql.
-- Run after 20260925000000_lease_rate.sql. Safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_company(
  _name       TEXT,
  _difficulty TEXT DEFAULT 'normal',
  _realism    TEXT DEFAULT 'balanced',
  _base_name  TEXT DEFAULT 'Main Heliport',
  _icao       TEXT DEFAULT NULL,
  _starter    JSONB DEFAULT NULL
) RETURNS public.companies
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_cash NUMERIC;
  v_co   public.companies%ROWTYPE;
  v_base UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  IF coalesce(trim(_name), '') = '' THEN RAISE EXCEPTION 'company name required'; END IF;
  IF _difficulty NOT IN ('easy', 'normal', 'hard') THEN
    RAISE EXCEPTION 'invalid difficulty: %', _difficulty;
  END IF;
  IF _realism NOT IN ('strict', 'balanced', 'sandbox') THEN
    RAISE EXCEPTION 'invalid realism mode: %', _realism;
  END IF;

  -- Opening capital is a rule of the game, not a client input.
  v_cash := CASE _difficulty
    WHEN 'hard' THEN 250000
    WHEN 'easy' THEN 1000000
    ELSE 500000
  END;

  INSERT INTO public.companies (user_id, name, cash, difficulty, realism_mode)
  VALUES (auth.uid(), trim(_name), v_cash, _difficulty, _realism)
  RETURNING * INTO v_co;
  -- on_company_created has already added the owner membership row.

  INSERT INTO public.bases (company_id, name, icao, is_primary)
  VALUES (v_co.id, COALESCE(NULLIF(trim(_base_name), ''), 'Main Heliport'),
          NULLIF(upper(trim(_icao)), ''), true)
  RETURNING id INTO v_base;

  IF _starter IS NOT NULL THEN
    -- A free starter, not a free jet. Mirrors STARTER_MAX_COST in src/lib/economy.ts.
    IF COALESCE((_starter->>'acquisition_cost')::NUMERIC, 0) > 175000 THEN
      RAISE EXCEPTION 'a starter aircraft can cost at most $175,000';
    END IF;
    INSERT INTO public.aircraft (
      company_id, base_id, internal_id, display_name, sim_title, category,
      engine_type, cruise_kts, max_range_nm, fuel_burn_pph, payload_lbs,
      pax_seats, sling_load, hoist, footprint, reliability,
      maintenance_factor, acquisition_cost, op_cost_hr, tags
    )
    SELECT
      v_co.id, v_base,
      COALESCE(_starter->>'internal_id', 'CUSTOM'),
      COALESCE(_starter->>'display_name', 'Starter helicopter'),
      _starter->>'sim_title',
      COALESCE(_starter->>'category', 'light_utility'),
      COALESCE(_starter->>'engine_type', 'turbine'),
      COALESCE((_starter->>'cruise_kts')::INTEGER, 110),
      COALESCE((_starter->>'max_range_nm')::INTEGER, 300),
      COALESCE((_starter->>'fuel_burn_pph')::INTEGER, 400),
      COALESCE((_starter->>'payload_lbs')::INTEGER, 1500),
      COALESCE((_starter->>'pax_seats')::INTEGER, 4),
      COALESCE((_starter->>'sling_load')::BOOLEAN, false),
      COALESCE((_starter->>'hoist')::BOOLEAN, false),
      COALESCE(_starter->>'footprint', 'medium'),
      COALESCE((_starter->>'reliability')::INTEGER, 80),
      COALESCE((_starter->>'maintenance_factor')::NUMERIC, 1.0),
      COALESCE((_starter->>'acquisition_cost')::NUMERIC, 0),
      COALESCE((_starter->>'op_cost_hr')::NUMERIC, 600),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(_starter->'tags')), ARRAY[]::TEXT[]);
  END IF;

  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_co.id, 'starting_capital', v_cash, 'Initial operating capital');

  RETURN v_co;
END;$fn$;

GRANT EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated;
REVOKE EXECUTE ON FUNCTION
  public.create_company(TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon;

-- $250k plus half of what the owned fleet would sell for.
CREATE OR REPLACE FUNCTION public.company_loan_limit(_company_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT 250000 + 0.5 * COALESCE(SUM(public.aircraft_resale(acquisition_cost, hours, wear)), 0)
    FROM public.aircraft
   WHERE company_id = _company_id
     AND NOT is_leased
     AND status NOT IN ('destroyed', 'sold', 'returned');
$fn$;

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

-- --------------------------------------------------------------------------
-- Reprice owned aircraft to the new catalogue.
-- --------------------------------------------------------------------------
UPDATE public.aircraft a
   SET acquisition_cost = p.price
  FROM (VALUES
  ('CABRI-G2', 175000),
  ('R66', 475000),
  ('R66-SPRAY', 500000),
  ('EC135', 750000),
  ('EC135-AMB', 825000),
  ('EC135-SAR', 875000),
  ('EC135-SIGHT', 725000),
  ('B206B', 325000),
  ('B206L', 550000),
  ('MD530F', 800000),
  ('H500CD', 300000),
  ('H500E', 425000),
  ('SA315B', 275000),
  ('ALOUETTE-III', 250000),
  ('H125', 1300000),
  ('H125-CARGO', 1325000),
  ('H125-RESCUE', 1550000),
  ('H125-RESCUE-NH', 1425000),
  ('H125-PAX', 1350000),
  ('H125-AERIAL', 1450000),
  ('EC130', 1000000),
  ('B407', 1100000),
  ('WESTLAND-SCOUT', 150000),
  ('OH58', 200000),
  ('BO105', 325000),
  ('MI2', 125000),
  ('MI2-HOPLITE', 150000),
  ('H135', 2250000),
  ('H135-EXT', 2400000),
  ('B222B', 425000),
  ('B429', 2500000),
  ('H145', 4250000),
  ('H145-CIVILIAN', 4750000),
  ('H145-EMS', 4900000),
  ('H145-FIRE', 4600000),
  ('H145-GEND', 4500000),
  ('H145-LUX', 5500000),
  ('H145-MIL', 4500000),
  ('AS365', 1100000),
  ('AS365-SAR', 1300000),
  ('AS365-VIP', 1250000),
  ('AS365-PAX', 1150000),
  ('AS365FN-SAR', 1200000),
  ('H160', 7000000),
  ('S76', 2250000),
  ('UH1', 600000),
  ('UH1H', 550000),
  ('SH60', 3500000),
  ('MH60', 6000000),
  ('MH60R', 7000000),
  ('MH60T', 6500000),
  ('HH65B-SAR', 2000000),
  ('HH65A-SAR', 1800000),
  ('HH65B-HITRON', 2100000),
  ('UH60', 2750000),
  ('UH60-LR', 2500000),
  ('H225', 4500000),
  ('MI17', 2500000),
  ('S64', 9000000),
  ('S64-FIRE', 10000000),
  ('S64-LIFT', 9500000),
  ('CH47', 12500000),
  ('V22', 42500000),
  ('C152', 30000),
  ('SAVAGE', 75000),
  ('C172', 150000),
  ('DA40', 200000),
  ('XCUB', 200000),
  ('SR22', 350000),
  ('G36', 400000),
  ('DHC2', 450000),
  ('DHC2-FLOATS', 500000),
  ('DA62', 650000),
  ('BE58', 750000),
  ('C208-CARGO', 1350000),
  ('C208-SKYDIVE', 1350000),
  ('C208', 1400000),
  ('C208-PAX', 1400000),
  ('C208-MEDIC', 1450000),
  ('C208-SCI', 1500000),
  ('C208-FLOATS', 1550000),
  ('SF50', 1700000),
  ('DHC6', 2000000),
  ('TBM930', 2100000),
  ('PC12NGX', 2500000),
  ('B350', 4000000),
  ('CJ4', 5500000),
  ('LONGITUDE', 14250000)
  ) AS p(internal_id, price)
 WHERE a.internal_id = p.internal_id
   AND NOT a.is_leased
   AND a.status NOT IN ('sold', 'returned', 'destroyed');
