-- =============================================================================
-- Fuel farms.
--
-- A tank at a base. Fill it by buying bulk fuel or by flying avgas in from your
-- own refinery, and every flight that departs that base's airport burns tank
-- fuel before it pays the pump.
--
--   build     $25,000, holds 10,000 lb
--   expand    $15,000 per extra 10,000 lb
--   bulk      $0.65/lb, charged when bought (the pump is $0.90/lb)
--   refinery  avgas at 46 lb a unit, carried by a fuel run; it costs nothing
--             beyond the refinery's wages, which are already paid
--
-- Accounting. Cash moves when fuel is bought, not when it is burned, so a tank
-- carries a cost basis (fuel_value) and a flight drawing from it books that fuel
-- at the tank's average cost: a 'fuel' row (an operating cost, attributed to the
-- aircraft) plus an equal 'fuel_from_tank' row (the stock drawn down) that nets
-- the cash to zero. Operating profit and profit per aircraft stay honest, and the
-- Finance page's cash line is untouched.
--
-- Fuel runs. dispatch_fuel_run takes the avgas out of the refinery at dispatch,
-- exactly as dispatch_trade_run does, and reserves room in the tank so two runs
-- can't both count on the same space. The tank is filled when the flight
-- resolves successfully. A failed run, or one deleted from the board before
-- anyone flew it, puts the avgas back.
--
-- rotorops_resolve_flight is carried forward from
-- 20260914000000_maintenance_and_loans.sql with the tank draw and the fuel run
-- delivery added. company_balance_sheet gains fuel in tanks as an asset.
--
-- Run 20260913000000_transaction_aircraft.sql and
-- 20260914000000_maintenance_and_loans.sql first. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.fuel_farms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  base_id     UUID NOT NULL UNIQUE REFERENCES public.bases(id) ON DELETE CASCADE,
  capacity_lb NUMERIC NOT NULL CHECK (capacity_lb > 0),
  fuel_lb     NUMERIC NOT NULL DEFAULT 0 CHECK (fuel_lb >= 0),
  -- What the fuel now in the tank cost, so a flight can book it at average cost.
  fuel_value  NUMERIC NOT NULL DEFAULT 0 CHECK (fuel_value >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fuel_farm_deliveries (
  mission_id   UUID PRIMARY KEY REFERENCES public.missions(id) ON DELETE CASCADE,
  company_id   UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fuel_farm_id UUID NOT NULL REFERENCES public.fuel_farms(id) ON DELETE CASCADE,
  industry_id  UUID REFERENCES public.industries(id) ON DELETE SET NULL,
  units        NUMERIC NOT NULL CHECK (units > 0),
  fuel_lb      NUMERIC NOT NULL CHECK (fuel_lb > 0),
  -- NULL while the run is waiting to be flown; set when it resolves.
  outcome      TEXT CHECK (outcome IN ('delivered', 'failed')),
  settled_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fuel_farm_deliveries_pending_idx
  ON public.fuel_farm_deliveries (fuel_farm_id)
  WHERE outcome IS NULL;

-- Readable by members; every write goes through the functions below.
ALTER TABLE public.fuel_farms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fuel_farm_deliveries ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.fuel_farms, public.fuel_farm_deliveries TO authenticated;
GRANT ALL ON public.fuel_farms, public.fuel_farm_deliveries TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.fuel_farms, public.fuel_farm_deliveries FROM authenticated;

DROP POLICY IF EXISTS "fuel farms read" ON public.fuel_farms;
CREATE POLICY "fuel farms read" ON public.fuel_farms
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "fuel deliveries read" ON public.fuel_farm_deliveries;
CREATE POLICY "fuel deliveries read" ON public.fuel_farm_deliveries
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- --------------------------------------------------------------------------
-- A run deleted before it was flown (Clear board) gives its avgas back.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_undelivered_fuel_run()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- When the whole company is being deleted its industries are going too, and
  -- the parent row is already gone by the time this cascade fires: skip it.
  IF OLD.outcome IS NULL AND OLD.industry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
    UPDATE public.industries SET stock = stock + OLD.units WHERE id = OLD.industry_id;
  END IF;
  RETURN OLD;
END;$fn$;

DROP TRIGGER IF EXISTS refund_undelivered_fuel_run ON public.fuel_farm_deliveries;
CREATE TRIGGER refund_undelivered_fuel_run
  BEFORE DELETE ON public.fuel_farm_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.refund_undelivered_fuel_run();

-- --------------------------------------------------------------------------
-- Building, expanding, buying
-- --------------------------------------------------------------------------

-- Tank space already promised to fuel runs that haven't been flown.
CREATE OR REPLACE FUNCTION public.fuel_farm_reserved_lb(_fuel_farm_id UUID)
RETURNS NUMERIC LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT COALESCE(SUM(fuel_lb), 0) FROM public.fuel_farm_deliveries
   WHERE fuel_farm_id = _fuel_farm_id AND outcome IS NULL;
$fn$;

CREATE OR REPLACE FUNCTION public.build_fuel_farm(_base_id UUID)
RETURNS public.fuel_farms
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_base public.bases%ROWTYPE;
  v_co   public.companies%ROWTYPE;
  v_farm public.fuel_farms%ROWTYPE;
BEGIN
  SELECT * INTO v_base FROM public.bases WHERE id = _base_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'base not found'; END IF;
  IF NOT public.can_manage_company(v_base.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can build a fuel farm';
  END IF;
  -- Flights find the tank by departure airport, so a base without one can't use it.
  IF v_base.icao IS NULL THEN
    RAISE EXCEPTION 'give this base an ICAO in Settings first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fuel_farms WHERE base_id = _base_id) THEN
    RAISE EXCEPTION 'this base already has a fuel farm';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_base.company_id FOR UPDATE;
  IF v_co.cash < 25000 THEN RAISE EXCEPTION 'insufficient cash'; END IF;

  INSERT INTO public.fuel_farms (company_id, base_id, capacity_lb)
  VALUES (v_base.company_id, _base_id, 10000)
  RETURNING * INTO v_farm;

  UPDATE public.companies SET cash = cash - 25000 WHERE id = v_base.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_base.company_id, 'fuel_farm_build', -25000,
          format('Fuel farm built at %s', v_base.icao));
  RETURN v_farm;
END;$fn$;

CREATE OR REPLACE FUNCTION public.expand_fuel_farm(_fuel_farm_id UUID)
RETURNS public.fuel_farms
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_farm public.fuel_farms%ROWTYPE;
  v_co   public.companies%ROWTYPE;
  v_icao TEXT;
BEGIN
  SELECT * INTO v_farm FROM public.fuel_farms WHERE id = _fuel_farm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fuel farm not found'; END IF;
  IF NOT public.can_manage_company(v_farm.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can expand a fuel farm';
  END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = v_farm.company_id FOR UPDATE;
  IF v_co.cash < 15000 THEN RAISE EXCEPTION 'insufficient cash'; END IF;
  SELECT icao INTO v_icao FROM public.bases WHERE id = v_farm.base_id;

  UPDATE public.fuel_farms SET capacity_lb = capacity_lb + 10000
   WHERE id = _fuel_farm_id RETURNING * INTO v_farm;
  UPDATE public.companies SET cash = cash - 15000 WHERE id = v_farm.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_farm.company_id, 'fuel_farm_expand', -15000,
          format('Fuel farm at %s expanded to %s lb', v_icao, ROUND(v_farm.capacity_lb)));
  RETURN v_farm;
END;$fn$;

CREATE OR REPLACE FUNCTION public.buy_bulk_fuel(_fuel_farm_id UUID, _lb NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_farm public.fuel_farms%ROWTYPE;
  v_co   public.companies%ROWTYPE;
  v_lb   NUMERIC := FLOOR(COALESCE(_lb, 0));
  v_free NUMERIC;
  v_cost NUMERIC;
  v_icao TEXT;
BEGIN
  IF v_lb <= 0 THEN RAISE EXCEPTION 'enter how many pounds to buy'; END IF;

  SELECT * INTO v_farm FROM public.fuel_farms WHERE id = _fuel_farm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fuel farm not found'; END IF;
  IF NOT public.can_manage_company(v_farm.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can buy fuel';
  END IF;

  v_free := v_farm.capacity_lb - v_farm.fuel_lb - public.fuel_farm_reserved_lb(_fuel_farm_id);
  IF v_lb > v_free THEN
    RAISE EXCEPTION 'the tank only has room for % lb', GREATEST(0, FLOOR(v_free));
  END IF;

  v_cost := ROUND(v_lb * 0.65);
  SELECT * INTO v_co FROM public.companies WHERE id = v_farm.company_id FOR UPDATE;
  IF v_co.cash < v_cost THEN RAISE EXCEPTION 'insufficient cash'; END IF;
  SELECT icao INTO v_icao FROM public.bases WHERE id = v_farm.base_id;

  UPDATE public.fuel_farms
     SET fuel_lb = fuel_lb + v_lb, fuel_value = fuel_value + v_cost
   WHERE id = _fuel_farm_id;
  UPDATE public.companies SET cash = cash - v_cost WHERE id = v_farm.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_farm.company_id, 'fuel_bulk_purchase', -v_cost,
          format('Bulk fuel for %s: %s lb', v_icao, v_lb));

  RETURN jsonb_build_object('lb', v_lb, 'cost', v_cost, 'fuel_lb', v_farm.fuel_lb + v_lb);
END;$fn$;

-- --------------------------------------------------------------------------
-- Fuel runs: avgas from your refinery to a fuel farm.
-- The same reach / payload / land_off contract a trade run uses, so the sim
-- bridge arms and tracks it with no changes.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_fuel_run(
  _industry_id UUID, _fuel_farm_id UUID, _units NUMERIC)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_farm  public.fuel_farms%ROWTYPE;
  v_base  public.bases%ROWTYPE;
  v_ind   public.industries%ROWTYPE;
  v_def   public.industry_defs%ROWTYPE;
  v_units NUMERIC := FLOOR(COALESCE(_units, 0));
  v_lb    NUMERIC;
  v_free  NUMERIC;
  v_dist  NUMERIC;
  v_from  TEXT;
  v_row   public.missions%ROWTYPE;
BEGIN
  IF v_units <= 0 THEN RAISE EXCEPTION 'enter how many units of avgas to send'; END IF;

  SELECT * INTO v_farm FROM public.fuel_farms WHERE id = _fuel_farm_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'fuel farm not found'; END IF;
  IF NOT public.can_manage_company(v_farm.company_id) THEN
    RAISE EXCEPTION 'only owners and managers can dispatch a fuel run';
  END IF;

  SELECT * INTO v_base FROM public.bases WHERE id = v_farm.base_id;
  IF v_base.latitude IS NULL OR v_base.longitude IS NULL THEN
    RAISE EXCEPTION 'this base has no position yet -- run the sim bridge once so it can locate the airport';
  END IF;

  PERFORM public.industry_tick(_industry_id);
  SELECT * INTO v_ind FROM public.industries WHERE id = _industry_id FOR UPDATE;
  IF NOT FOUND OR v_ind.company_id <> v_farm.company_id THEN
    RAISE EXCEPTION 'refinery not found';
  END IF;
  SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_ind.kind;
  IF v_def.output_good IS DISTINCT FROM 'avgas' THEN
    RAISE EXCEPTION 'only avgas from a refinery can fill a fuel farm';
  END IF;
  IF v_units > v_ind.stock THEN
    RAISE EXCEPTION 'only % units of avgas in stock', FLOOR(v_ind.stock);
  END IF;

  v_lb := v_units * v_def.good_unit_lb;
  v_free := v_farm.capacity_lb - v_farm.fuel_lb - public.fuel_farm_reserved_lb(_fuel_farm_id);
  IF v_lb > v_free THEN
    RAISE EXCEPTION 'that is % lb, and the tank only has room for % lb',
      v_lb, GREATEST(0, FLOOR(v_free));
  END IF;

  v_dist := public.great_circle_nm(v_ind.latitude, v_ind.longitude, v_base.latitude, v_base.longitude);
  v_from := COALESCE(v_ind.name, 'your refinery');

  INSERT INTO public.missions (
    company_id, role, title, description, origin, destination, distance_nm,
    required_tags, required_certs, min_payload, payout, difficulty, weather_factor,
    scene_lat, scene_lon, scene_type, scene_name, status, objectives
  ) VALUES (
    v_farm.company_id, 'fuel_run',
    format('Fuel Run — avgas to %s', v_base.icao),
    format('Collect %s units of avgas (%s lb) from %s and fly it to the fuel farm at %s. '
           'No contract fee: the fuel is the payoff.',
           v_units, v_lb, v_from, v_base.icao),
    v_base.icao, v_base.icao, GREATEST(2, ROUND(v_dist)),
    ARRAY['cargo', 'medium_utility', 'heavy_lift']::TEXT[], ARRAY[]::TEXT[],
    ROUND(v_lb * 0.85), 0, 2, 2,
    v_base.latitude, v_base.longitude, 'industry', v_base.icao,
    'available',
    jsonb_build_array(
      jsonb_build_object(
        'id', 'reach', 'kind', 'reach', 'label', format('Reach %s', v_from),
        'lat', v_ind.latitude, 'lon', v_ind.longitude, 'radius_nm', 0.7),
      jsonb_build_object(
        'id', 'load', 'kind', 'payload', 'label', format('Load %s lb of avgas', v_lb),
        'min_delta_lb', ROUND(v_lb * 0.85)),
      jsonb_build_object(
        'id', 'deliver', 'kind', 'land_off',
        'label', format('Deliver to the fuel farm at %s', v_base.icao),
        'lat', v_base.latitude, 'lon', v_base.longitude, 'radius_nm', 1.0)
    )
  ) RETURNING * INTO v_row;

  INSERT INTO public.fuel_farm_deliveries (
    mission_id, company_id, fuel_farm_id, industry_id, units, fuel_lb)
  VALUES (v_row.id, v_farm.company_id, _fuel_farm_id, _industry_id, v_units, v_lb);

  -- Taken now, as a trade run does, so the same avgas can't be sent twice.
  UPDATE public.industries SET stock = stock - v_units WHERE id = _industry_id;
  RETURN v_row;
END;$fn$;

-- --------------------------------------------------------------------------
-- Balance sheet: fuel in tanks is an asset, at what it cost.
-- Carried forward from 20260914000000_maintenance_and_loans.sql.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.company_balance_sheet(_company_id UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_co    public.companies%ROWTYPE;
  v_fleet NUMERIC;
  v_count INTEGER;
  v_fuel  NUMERIC;
  v_limit NUMERIC;
BEGIN
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;
  SELECT * INTO v_co FROM public.companies WHERE id = _company_id;

  SELECT COALESCE(SUM(public.aircraft_resale(acquisition_cost, hours, wear)), 0), COUNT(*)
    INTO v_fleet, v_count
    FROM public.aircraft
   WHERE company_id = _company_id
     AND NOT is_leased
     AND status NOT IN ('destroyed', 'sold', 'returned');
  SELECT COALESCE(SUM(fuel_value), 0) INTO v_fuel
    FROM public.fuel_farms WHERE company_id = _company_id;
  v_limit := public.company_loan_limit(_company_id);

  RETURN jsonb_build_object(
    'cash', v_co.cash,
    'aircraft_value', v_fleet,
    'aircraft_count', v_count,
    'fuel_value', v_fuel,
    'assets', v_co.cash + v_fleet + v_fuel,
    'loan_balance', v_co.loan_balance,
    'liabilities', v_co.loan_balance,
    'company_value', v_co.cash + v_fleet + v_fuel - v_co.loan_balance,
    'loan_limit', v_limit,
    'available_credit', GREATEST(0, v_limit - v_co.loan_balance));
END;$fn$;

-- --------------------------------------------------------------------------
-- Flight resolution: burn tank fuel first, deliver fuel runs.
-- Carried forward from 20260914000000_maintenance_and_loans.sql.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotorops_resolve_flight(
  _company_id UUID,
  _mission_id UUID,
  _aircraft_id UUID,
  _t JSONB,
  _source TEXT DEFAULT 'manual',
  _pilot_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  fuel_price_per_lb CONSTANT NUMERIC := 0.9;
  v_ac        public.aircraft%ROWTYPE;
  v_m         public.missions%ROWTYPE;
  v_co        public.companies%ROWTYPE;
  v_hours     NUMERIC;
  v_fuel      NUMERIC;
  v_fpm       NUMERIC;
  v_quality   TEXT;
  v_payload   INTEGER;
  v_crashed   BOOLEAN;
  v_arrived   BOOLEAN;
  v_success   BOOLEAN;
  v_incidents TEXT[];
  v_wear      NUMERIC;
  v_new_wear  NUMERIC;
  v_fuel_cost NUMERIC;
  v_op_cost   NUMERIC;
  v_op_billed NUMERIC;
  v_lease     NUMERIC;
  v_payout    NUMERIC;
  v_mult      NUMERIC;
  v_net       NUMERIC;
  v_rep_delta INTEGER;
  v_log_id    UUID;
  v_checkride BOOLEAN;
  v_pilot     UUID;
  v_perks     TEXT[];
  v_fuel_mult NUMERIC;
  v_wear_mult NUMERIC;
  v_hardwear_mult NUMERIC;
  v_op_mult   NUMERIC;
  v_lease_mult NUMERIC;
  v_payout_mult NUMERIC;
  v_rep_bonus INTEGER;
  v_xp_gain   INTEGER;
  v_wear_cost_mult NUMERIC;
  v_break_chance   NUMERIC;
  v_breakdown      BOOLEAN := false;
  v_repay          NUMERIC := 0;
  v_dep            TEXT;
  v_farm           public.fuel_farms%ROWTYPE;
  v_tank_lb        NUMERIC := 0;
  v_tank_cost      NUMERIC := 0;
  v_delivery       public.fuel_farm_deliveries%ROWTYPE;
  v_delivered_lb   NUMERIC := 0;
BEGIN
  SELECT * INTO v_co FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company not found'; END IF;

  SELECT * INTO v_ac FROM public.aircraft
    WHERE id = _aircraft_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'aircraft not found for this company'; END IF;

  IF _mission_id IS NOT NULL THEN
    SELECT * INTO v_m FROM public.missions
      WHERE id = _mission_id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'mission not found for this company'; END IF;
    IF v_m.status NOT IN ('available', 'in_progress') THEN
      RAISE EXCEPTION 'mission already resolved (status: %)', v_m.status;
    END IF;
    -- A contract belongs to whoever claimed it.
    IF v_m.assigned_pilot_id IS NOT NULL
       AND _pilot_id IS NOT NULL
       AND v_m.assigned_pilot_id <> _pilot_id THEN
      RAISE EXCEPTION 'this contract is assigned to another pilot';
    END IF;
  END IF;

  v_checkride := COALESCE(v_m.role, '') = 'checkride';
  v_pilot := COALESCE(_pilot_id, v_m.assigned_pilot_id);

  -- Perks belong to whoever is actually flying. No pilot attributed (an old
  -- bridge build, or a positioning flight with nobody claimed) means no
  -- perks apply -- every multiplier below defaults to 1.0 in that case.
  SELECT unlocked_perks INTO v_perks FROM public.pilot_skills
    WHERE company_id = _company_id AND user_id = v_pilot;
  v_perks := COALESCE(v_perks, ARRAY[]::TEXT[]);

  v_fuel_mult := 1.0
    * (CASE WHEN 'fuel_discipline' = ANY(v_perks) THEN 0.92 ELSE 1.0 END)
    * (CASE WHEN 'master_of_type'  = ANY(v_perks) THEN 0.92 ELSE 1.0 END);
  v_wear_mult := 1.0
    * (CASE WHEN 'veteran_wear'    = ANY(v_perks) THEN 0.85 ELSE 1.0 END)
    * (CASE WHEN 'iron_airframe'   = ANY(v_perks) THEN 0.8  ELSE 1.0 END);
  v_hardwear_mult := CASE WHEN 'easy_hands' = ANY(v_perks) THEN 0.7 ELSE 1.0 END;
  v_op_mult := 1.0
    * (CASE WHEN 'lean_ops'        = ANY(v_perks) THEN 0.9  ELSE 1.0 END)
    * (CASE WHEN 'master_of_type'  = ANY(v_perks) THEN 0.92 ELSE 1.0 END);
  v_lease_mult := CASE WHEN 'trusted_lessee' = ANY(v_perks) THEN 0.8 ELSE 1.0 END;
  v_payout_mult := CASE WHEN 'ace_pilot' = ANY(v_perks) THEN 1.05 ELSE 1.0 END;
  v_rep_bonus := CASE WHEN 'field_reputation' = ANY(v_perks) THEN 1 ELSE 0 END;

  -- A worn airframe costs more to run: +0.5% operating cost per wear point
  -- above 40, judged on the condition it took off in.
  v_wear_cost_mult := 1 + GREATEST(0, LEAST(v_ac.wear, 100) - 40) * 0.005;

  -- Prefer measured values; fall back to the aircraft's book figures.
  v_hours := COALESCE(NULLIF((_t->>'duration_hr')::NUMERIC, 0),
                      COALESCE(v_m.distance_nm, 0)::NUMERIC / NULLIF(v_ac.cruise_kts, 0));
  v_hours := GREATEST(COALESCE(v_hours, 0), 0);
  v_fuel  := GREATEST(COALESCE((_t->>'fuel_used')::NUMERIC,
                               v_hours * v_ac.fuel_burn_pph), 0) * v_fuel_mult;
  v_payload := COALESCE((_t->>'payload')::INTEGER, COALESCE(v_m.min_payload, 0));
  v_fpm     := (_t->>'touchdown_fpm')::NUMERIC;
  v_crashed := COALESCE((_t->>'crashed')::BOOLEAN, false);
  v_incidents := COALESCE(
    ARRAY(SELECT jsonb_array_elements_text(_t->'incidents')), ARRAY[]::TEXT[]);

  -- Fuel farm: a flight departing a base with fuel in its tank burns that
  -- first, at the tank's average cost. The pump covers whatever is left.
  v_dep := upper(trim(COALESCE(_t->>'departure', v_m.origin, '')));
  IF v_dep <> '' AND v_fuel > 0 THEN
    SELECT f.* INTO v_farm
      FROM public.fuel_farms f
      JOIN public.bases b ON b.id = f.base_id
     WHERE f.company_id = _company_id
       AND upper(trim(b.icao)) = v_dep
       AND f.fuel_lb > 0
     ORDER BY f.fuel_lb DESC
     LIMIT 1
     FOR UPDATE OF f;
    IF FOUND THEN
      v_tank_lb := LEAST(v_farm.fuel_lb, v_fuel);
      v_tank_cost := v_farm.fuel_value * v_tank_lb / v_farm.fuel_lb;
      UPDATE public.fuel_farms
         SET fuel_lb = fuel_lb - v_tank_lb,
             fuel_value = CASE WHEN fuel_lb - v_tank_lb <= 0 THEN 0
                               ELSE GREATEST(0, fuel_value - v_tank_cost) END
       WHERE id = v_farm.id;
    END IF;
  END IF;

  v_quality := CASE
    WHEN v_fpm IS NULL THEN COALESCE(_t->>'landing_quality', 'normal')
    WHEN v_fpm >= -60  THEN 'excellent'
    WHEN v_fpm >= -240 THEN 'normal'
    WHEN v_fpm >= -600 THEN 'hard'
    ELSE 'severe'
  END;

  v_arrived := CASE
    WHEN _mission_id IS NULL THEN true
    WHEN _t->>'arrival' IS NULL OR v_m.destination IS NULL THEN true
    ELSE upper(trim(_t->>'arrival')) = upper(trim(v_m.destination))
  END;

  v_success := _mission_id IS NOT NULL
               AND NOT v_crashed
               AND v_quality <> 'severe'
               AND v_arrived
               AND v_payload >= COALESCE(v_m.min_payload, 0);

  IF v_checkride THEN
    v_success := v_success AND public.mission_objectives_met(_mission_id);
  END IF;

  IF NOT v_arrived THEN v_incidents := v_incidents || 'off-contract landing'; END IF;
  IF v_quality = 'hard' THEN v_incidents := v_incidents || 'hard landing'; END IF;
  IF v_quality = 'severe' THEN v_incidents := v_incidents || 'skid damage on touchdown'; END IF;
  IF v_crashed THEN v_incidents := v_incidents || 'airframe loss'; END IF;

  v_wear := v_hours * (COALESCE(v_m.difficulty, 1) * 0.8) * v_ac.maintenance_factor * v_wear_mult
            + (CASE v_quality WHEN 'hard' THEN 3 WHEN 'severe' THEN 12 ELSE 0 END) * v_hardwear_mult
            + (CARDINALITY(v_incidents) * 1.5);

  -- Breakdowns: the condition it took off in against its reliability. A loss
  -- is already the worst outcome, so a crashed flight doesn't roll. Decided
  -- here, after the fact -- it never fails the contract that was just flown.
  IF NOT v_crashed THEN
    v_break_chance := (LEAST(GREATEST(v_ac.wear, 0), 100) / 100.0)
                      * ((100 - LEAST(GREATEST(v_ac.reliability, 0), 100)) / 100.0)
                      * 0.25;
    IF random() < v_break_chance THEN
      v_breakdown := true;
      v_wear := v_wear + 20;
      v_incidents := v_incidents || 'mechanical breakdown';
    END IF;
  END IF;

  v_new_wear := LEAST(100, v_ac.wear + v_wear);

  -- Only pump fuel is paid in cash now; tank fuel was paid for when it was bought.
  v_fuel_cost := (v_fuel - v_tank_lb) * fuel_price_per_lb;
  v_op_cost   := v_hours * v_ac.op_cost_hr;
  v_op_billed := (CASE WHEN v_success THEN v_op_cost ELSE v_op_cost * 0.5 END)
                 * v_op_mult * v_wear_cost_mult;
  -- Lease is owed on every hour flown, successful contract or not.
  v_lease := v_hours * COALESCE(v_ac.lease_cost, 0) * v_lease_mult;

  v_mult := CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult * v_payout_mult ELSE 0 END;
  -- A check ride pays no contract fee -- the rating is the payout -- whatever
  -- the row's own payout column happens to hold.
  IF v_checkride THEN v_payout := 0; END IF;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

  v_rep_delta := CASE
    WHEN _mission_id IS NULL THEN 0
    WHEN v_success AND v_quality = 'excellent' THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success THEN COALESCE(v_m.difficulty, 1)
    ELSE -COALESCE(v_m.difficulty, 1) * 2
  END;

  INSERT INTO public.flight_logs (
    company_id, aircraft_id, mission_id, pilot_id, departure, arrival,
    duration_hr, fuel_used, payload, landing_quality, incidents,
    weather_difficulty, success, source, telemetry
  ) VALUES (
    _company_id, _aircraft_id, _mission_id,
    v_pilot,
    COALESCE(_t->>'departure', v_m.origin),
    COALESCE(_t->>'arrival', v_m.destination),
    ROUND(v_hours, 2), ROUND(v_fuel), v_payload,
    CASE WHEN v_quality = 'severe' THEN 'hard' ELSE v_quality END,
    NULLIF(array_to_string(v_incidents, ', '), ''),
    COALESCE(v_m.weather_factor, COALESCE((_t->>'weather_factor')::INTEGER, 1)),
    v_success, _source, _t
  ) RETURNING id INTO v_log_id;

  UPDATE public.aircraft SET
    hours  = hours + v_hours,
    wear   = v_new_wear,
    broken_down_at = CASE WHEN v_breakdown THEN now() ELSE broken_down_at END,
    status = CASE WHEN v_crashed THEN 'destroyed'
                  WHEN v_new_wear >= 85 OR v_breakdown OR broken_down_at IS NOT NULL
                    THEN 'grounded'
                  ELSE 'available' END
  WHERE id = _aircraft_id;

  IF _mission_id IS NOT NULL THEN
    UPDATE public.missions SET
      status = CASE WHEN v_success THEN 'completed' ELSE 'failed' END,
      completed_at = now(),
      aircraft_id = _aircraft_id
    WHERE id = _mission_id;
  END IF;

  -- Fuel runs: fill the tank on a successful delivery; otherwise the avgas
  -- goes back to the refinery it came from.
  IF COALESCE(v_m.role, '') = 'fuel_run' THEN
    SELECT * INTO v_delivery FROM public.fuel_farm_deliveries
     WHERE mission_id = _mission_id AND outcome IS NULL
     FOR UPDATE;
    IF FOUND THEN
      IF v_success THEN
        UPDATE public.fuel_farms
           SET fuel_lb = LEAST(capacity_lb, fuel_lb + v_delivery.fuel_lb)
         WHERE id = v_delivery.fuel_farm_id;
        v_delivered_lb := v_delivery.fuel_lb;
      ELSIF v_delivery.industry_id IS NOT NULL THEN
        UPDATE public.industries SET stock = stock + v_delivery.units
         WHERE id = v_delivery.industry_id;
      END IF;
      UPDATE public.fuel_farm_deliveries
         SET outcome = CASE WHEN v_success THEN 'delivered' ELSE 'failed' END,
             settled_at = now()
       WHERE mission_id = _mission_id;
    END IF;
  END IF;

  IF v_fuel_cost > 0 OR v_tank_lb = 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'fuel', -ROUND(v_fuel_cost),
            format('Fuel: %s', COALESCE(v_m.title, 'positioning flight')));
  END IF;
  IF v_tank_lb > 0 THEN
    -- Booked at cost as an operating expense, and the same amount back as the
    -- tank stock drawn down: no cash moves, but the flight still carries its fuel.
    INSERT INTO public.economy_transactions (company_id, type, amount, description) VALUES
      (_company_id, 'fuel', -ROUND(v_tank_cost),
       format('Fuel from tank at %s: %s lb', v_dep, ROUND(v_tank_lb))),
      (_company_id, 'fuel_from_tank', ROUND(v_tank_cost),
       format('Tank stock used at %s: %s lb', v_dep, ROUND(v_tank_lb)));
  END IF;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (_company_id, 'operating', -ROUND(v_op_billed),
          format('Op cost: %s', v_ac.display_name));
  IF v_lease > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'lease', -ROUND(v_lease),
            format('Lease: %s (%s hrs)', v_ac.display_name, ROUND(v_hours, 1)));
  END IF;
  IF v_payout > 0 THEN
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'mission_payout', ROUND(v_payout), v_m.title);
  END IF;

  UPDATE public.companies SET
    cash = cash + v_net,
    reputation = GREATEST(0, LEAST(100, reputation + v_rep_delta))
  WHERE id = _company_id;

  -- Loans: a tenth of contract pay goes to the balance until it's cleared.
  IF v_payout > 0 AND COALESCE(v_co.loan_balance, 0) > 0 THEN
    v_repay := LEAST(v_co.loan_balance, ROUND(v_payout * 0.10));
    UPDATE public.companies
       SET cash = cash - v_repay, loan_balance = loan_balance - v_repay
     WHERE id = _company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (_company_id, 'loan_repayment', -v_repay,
            format('Loan repayment from %s', v_m.title));
  END IF;

  -- The one thing a check ride does that no other mission does: pass it, and
  -- the rating is yours. scene_name carries which cert -- see book_checkride
  -- above for why that column rather than a new one.
  IF v_checkride AND v_success THEN
    UPDATE public.companies
       SET certifications = array_append(certifications, v_m.scene_name)
     WHERE id = _company_id
       AND NOT (v_m.scene_name = ANY(certifications));
  END IF;

  -- XP: real contracts pay by hours and difficulty; positioning flights and
  -- failed contracts pay nothing, so grinding empty circuits doesn't level a
  -- pilot up. A check ride passed is worth a flat bonus on top of the
  -- ordinary flight -- it's usually short, but it's a real accomplishment.
  v_xp_gain := 0;
  IF v_pilot IS NOT NULL AND _mission_id IS NOT NULL AND v_success AND NOT v_checkride THEN
    v_xp_gain := 10 + ROUND(v_hours * 12) + COALESCE(v_m.difficulty, 1) * 5;
  END IF;
  IF v_pilot IS NOT NULL AND v_checkride AND v_success THEN
    v_xp_gain := v_xp_gain + 150;
  END IF;

  IF v_pilot IS NOT NULL AND v_xp_gain > 0 THEN
    INSERT INTO public.pilot_skills (company_id, user_id, xp)
    VALUES (_company_id, v_pilot, v_xp_gain)
    ON CONFLICT (company_id, user_id) DO UPDATE
      SET xp = pilot_skills.xp + EXCLUDED.xp, updated_at = now();
  END IF;

  RETURN jsonb_build_object(
    'flight_log_id', v_log_id,
    'success', v_success,
    'landing_quality', v_quality,
    'duration_hr', ROUND(v_hours, 2),
    'fuel_used', ROUND(v_fuel),
    'fuel_cost', ROUND(v_fuel_cost),
    'op_cost', ROUND(v_op_billed),
    'lease_cost', ROUND(v_lease),
    'payout', ROUND(v_payout),
    'net', ROUND(v_net),
    'wear_added', ROUND(v_wear, 1),
    'aircraft_wear', ROUND(v_new_wear, 1),
    'reputation_delta', v_rep_delta,
    'incidents', to_jsonb(v_incidents),
    'checkride', v_checkride,
    'checkride_passed', CASE WHEN v_checkride THEN v_success ELSE NULL END,
    'xp_gained', v_xp_gain,
    'breakdown', v_breakdown,
    'loan_repayment', v_repay,
    'inspection_due_in_hr',
      ROUND(100 - (v_ac.hours + v_hours - COALESCE(v_ac.hours_at_inspection, 0)), 1),
    'fuel_from_tank_lb', ROUND(v_tank_lb),
    'fuel_tank_cost', ROUND(v_tank_cost),
    'fuel_delivered_lb', ROUND(v_delivered_lb)
  );
END;$fn$;

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.build_fuel_farm(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.expand_fuel_farm(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.buy_bulk_fuel(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_fuel_run(UUID, UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.company_balance_sheet(UUID) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.build_fuel_farm(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.expand_fuel_farm(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.buy_bulk_fuel(UUID, NUMERIC) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.dispatch_fuel_run(UUID, UUID, NUMERIC) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.company_balance_sheet(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.fuel_farm_reserved_lb(UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_undelivered_fuel_run() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
