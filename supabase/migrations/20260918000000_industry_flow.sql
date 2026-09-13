-- =============================================================================
-- Industry flow, and more aeroplane work.
--
-- Hauls now move real stock. A haul contract names the site its goods come from
-- and, when it is one of your own, the site they go to:
--
--   dispatched  the goods leave the source (ticked up to date, then checked
--               against its stock)
--   delivered   they arrive: input for a mill goes into its input_stock, a
--               finished good onto the buyer's shelf; a market sale just leaves
--   failed      they go back to the source, as they do when a dispatch is
--               cancelled or the contract is deleted before it is flown
--   crashed     the contract resets and keeps its load for the restart
--
-- A processing site now works through flown-in input (input_stock) at its full
-- rate first, then pulls straight from its own camp at half its rate. Before
-- this it pulled everything straight from the camp, so a haul changed nothing.
--
-- Trade runs already took their stock when created; now they deliver it too,
-- and give it back if they fail.
--
-- Regional markets (40-200 nm, pay x(1 + nm/200)) and aeroplane hauls are built
-- in the browser (src/lib/industries.ts) and need nothing here beyond the haul
-- columns. Floatplanes get a 'floats' tag for the floatplane contracts.
--
-- Carried forward: industry_tick from 20260910120000_industry_staffing.sql,
-- dispatch_mission from 20260916000000_crash_restart.sql, cancel_dispatch from
-- 20260830120000_mission_scenes.sql, dispatch_trade_run from
-- 20260903000000_industries.sql, rotorops_resolve_flight from
-- 20260917000000_flight_score.sql.
--
-- Run 20260913 through 20260917 first. Safe to re-run.
-- =============================================================================

ALTER TABLE public.industries
  ADD COLUMN IF NOT EXISTS input_stock NUMERIC NOT NULL DEFAULT 0 CHECK (input_stock >= 0);

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS haul_from_industry_id UUID REFERENCES public.industries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS haul_to_industry_id UUID REFERENCES public.industries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS haul_units NUMERIC CHECK (haul_units IS NULL OR haul_units > 0);

CREATE TABLE IF NOT EXISTS public.industry_deliveries (
  mission_id       UUID PRIMARY KEY REFERENCES public.missions(id) ON DELETE CASCADE,
  company_id       UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  from_industry_id UUID REFERENCES public.industries(id) ON DELETE SET NULL,
  -- NULL for a sale at a market rather than a delivery to one of your sites.
  to_industry_id   UUID REFERENCES public.industries(id) ON DELETE SET NULL,
  good             TEXT NOT NULL,
  units            NUMERIC NOT NULL CHECK (units > 0),
  -- NULL while the load is out; set when the flight resolves.
  outcome          TEXT CHECK (outcome IN ('delivered', 'failed')),
  settled_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS industry_deliveries_pending_idx
  ON public.industry_deliveries (from_industry_id)
  WHERE outcome IS NULL;

-- Readable by members; every write goes through the functions below.
ALTER TABLE public.industry_deliveries ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.industry_deliveries TO authenticated;
GRANT ALL ON public.industry_deliveries TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.industry_deliveries FROM authenticated;

DROP POLICY IF EXISTS "industry deliveries read" ON public.industry_deliveries;
CREATE POLICY "industry deliveries read" ON public.industry_deliveries
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- --------------------------------------------------------------------------
-- A load never flown (dispatch cancelled, board cleared) goes back to its source.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refund_undelivered_haul()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- When the whole company is being deleted its industries are going too.
  IF OLD.outcome IS NULL AND OLD.from_industry_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
    UPDATE public.industries SET stock = stock + OLD.units WHERE id = OLD.from_industry_id;
  END IF;
  RETURN OLD;
END;$fn$;

DROP TRIGGER IF EXISTS refund_undelivered_haul ON public.industry_deliveries;
CREATE TRIGGER refund_undelivered_haul
  BEFORE DELETE ON public.industry_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.refund_undelivered_haul();

-- --------------------------------------------------------------------------
-- Settle a haul when its flight resolves. Returns the units delivered.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_industry_delivery(_mission_id UUID, _delivered BOOLEAN)
RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_d   public.industry_deliveries%ROWTYPE;
  v_to  public.industries%ROWTYPE;
  v_def public.industry_defs%ROWTYPE;
BEGIN
  SELECT * INTO v_d FROM public.industry_deliveries
   WHERE mission_id = _mission_id AND outcome IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RETURN 0; END IF;

  IF _delivered THEN
    IF v_d.to_industry_id IS NOT NULL THEN
      -- Bring the buyer up to date first, so the delivery isn't counted as
      -- having been there for the hours before it landed.
      PERFORM public.industry_tick(v_d.to_industry_id);
      SELECT * INTO v_to FROM public.industries WHERE id = v_d.to_industry_id FOR UPDATE;
      IF FOUND THEN
        SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_to.kind;
        IF v_def.input_good = v_d.good THEN
          UPDATE public.industries SET input_stock = LEAST(capacity, input_stock + v_d.units)
           WHERE id = v_to.id;
        ELSIF v_def.output_good = v_d.good THEN
          UPDATE public.industries SET stock = LEAST(capacity, stock + v_d.units)
           WHERE id = v_to.id;
        END IF;
      END IF;
    END IF;
  ELSIF v_d.from_industry_id IS NOT NULL THEN
    UPDATE public.industries SET stock = stock + v_d.units WHERE id = v_d.from_industry_id;
  END IF;

  UPDATE public.industry_deliveries
     SET outcome = CASE WHEN _delivered THEN 'delivered' ELSE 'failed' END,
         settled_at = now()
   WHERE mission_id = _mission_id;
  RETURN CASE WHEN _delivered THEN v_d.units ELSE 0 END;
END;$fn$;

REVOKE EXECUTE ON FUNCTION public.settle_industry_delivery(UUID, BOOLEAN)
  FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- Floatplanes already in a fleet get the tag new purchases carry.
-- --------------------------------------------------------------------------
UPDATE public.aircraft
   SET tags = array_append(tags, 'floats')
 WHERE internal_id IN ('C208-FLOATS', 'DHC2-FLOATS')
   AND NOT ('floats' = ANY(tags));

-- --------------------------------------------------------------------------
-- Production: flown-in input at full rate, the camp at half.
-- Carried forward from 20260910120000_industry_staffing.sql.
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

-- --------------------------------------------------------------------------
-- Dispatch: an industry haul takes its load out of stock.
-- Carried forward from 20260916000000_crash_restart.sql.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_mission(_mission_id UUID, _aircraft_id UUID)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_m     public.missions%ROWTYPE;
  v_from  public.industries%ROWTYPE;
  v_def   public.industry_defs%ROWTYPE;
  v_units NUMERIC;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_m.company_id) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  IF v_m.status <> 'available' THEN
    RAISE EXCEPTION 'mission is not available (status: %)', v_m.status;
  END IF;
  -- A contract reset by a crash is still that pilot's to restart. A manager
  -- can hand it to someone else.
  IF v_m.assigned_pilot_id IS NOT NULL
     AND v_m.assigned_pilot_id <> auth.uid()
     AND NOT public.can_manage_company(v_m.company_id) THEN
    RAISE EXCEPTION 'this contract is reserved for the pilot who has to restart it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.aircraft
                 WHERE id = _aircraft_id AND company_id = v_m.company_id
                   AND status = 'available') THEN
    RAISE EXCEPTION 'aircraft unavailable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.aircraft
              WHERE id = _aircraft_id AND hours - hours_at_inspection > 110) THEN
    RAISE EXCEPTION 'aircraft is overdue its 100-hour inspection -- service it on the Maintenance page';
  END IF;

  -- An industry haul takes its goods out of stock now, so two contracts can't
  -- both fly the same load. One already holding its load -- a trade run, or a
  -- haul reset by a crash -- keeps what it has.
  IF v_m.haul_from_industry_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.industry_deliveries
        WHERE mission_id = _mission_id AND outcome IS NULL) THEN
    PERFORM public.industry_tick(v_m.haul_from_industry_id);
    SELECT * INTO v_from FROM public.industries
     WHERE id = v_m.haul_from_industry_id FOR UPDATE;
    IF NOT FOUND OR v_from.company_id <> v_m.company_id THEN
      RAISE EXCEPTION 'the site this haul collects from is gone -- clear it from the board';
    END IF;
    IF v_m.haul_to_industry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.industries
          WHERE id = v_m.haul_to_industry_id AND company_id = v_m.company_id) THEN
      RAISE EXCEPTION 'the site this haul delivers to is gone -- clear it from the board';
    END IF;
    SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_from.kind;
    v_units := FLOOR(COALESCE(v_m.haul_units, 0));
    IF v_units <= 0 THEN RAISE EXCEPTION 'this haul has nothing to carry'; END IF;
    IF v_units > v_from.stock THEN
      RAISE EXCEPTION '% has only % units of % left -- clear the board and generate again',
        COALESCE(v_from.name, v_def.kind), FLOOR(v_from.stock), v_def.output_good;
    END IF;
    -- Contracts are written in the browser, so the weight the pilot has to
    -- carry is held to what the goods actually weigh.
    IF COALESCE(v_m.min_payload, 0) < FLOOR(v_units * v_def.good_unit_lb * 0.85) - 1 THEN
      RAISE EXCEPTION 'this haul''s payload doesn''t match its load -- clear it and generate again';
    END IF;
    INSERT INTO public.industry_deliveries (
      mission_id, company_id, from_industry_id, to_industry_id, good, units)
    VALUES (_mission_id, v_m.company_id, v_from.id, v_m.haul_to_industry_id,
            v_def.output_good, v_units);
    UPDATE public.industries SET stock = stock - v_units WHERE id = v_from.id;
  END IF;

  -- Claiming a contract assigns it to you; nobody else can fly it.
  UPDATE public.missions
     SET status = 'in_progress', aircraft_id = _aircraft_id,
         dispatched_at = now(), assigned_pilot_id = auth.uid()
   WHERE id = _mission_id RETURNING * INTO v_m;
  UPDATE public.aircraft SET status = 'on_mission' WHERE id = _aircraft_id;
  RETURN v_m;
END;$fn$;

-- --------------------------------------------------------------------------
-- Cancel: the load goes back.
-- Carried forward from 20260830120000_mission_scenes.sql.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_dispatch(_mission_id UUID)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_m public.missions%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM public.missions WHERE id = _mission_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_m.company_id) THEN
    RAISE EXCEPTION 'mission not found';
  END IF;
  IF v_m.status <> 'in_progress' THEN
    RAISE EXCEPTION 'mission is not dispatched';
  END IF;
  IF v_m.assigned_pilot_id <> auth.uid()
     AND NOT public.can_manage_company(v_m.company_id) THEN
    RAISE EXCEPTION 'this contract belongs to another pilot';
  END IF;

  -- A haul's goods go back to where they came from until someone flies it.
  DELETE FROM public.industry_deliveries
   WHERE mission_id = _mission_id AND outcome IS NULL;

  UPDATE public.aircraft SET status = 'available'
   WHERE id = v_m.aircraft_id AND status = 'on_mission';
  UPDATE public.missions
     SET status = 'available', aircraft_id = NULL, dispatched_at = NULL,
         assigned_pilot_id = NULL, objectives_state = '{}'::JSONB
   WHERE id = _mission_id RETURNING * INTO v_m;
  RETURN v_m;
END;$fn$;

-- --------------------------------------------------------------------------
-- Trade runs deliver their goods.
-- Carried forward from 20260903000000_industries.sql.
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
-- Flight resolution settles the haul.
-- Carried forward from 20260917000000_flight_score.sql.
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
  v_wrong_start    BOOLEAN := false;
  v_reset          BOOLEAN := false;
  v_restart_from   TEXT;
  v_score          INTEGER;
  v_grade          TEXT;
  v_xp_mult        NUMERIC := 1.0;
  v_haul_units     NUMERIC := 0;
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

  -- Flight score from the bridge, graded A-F. Absent (a manual log, an older
  -- bridge), the landing quality prices the flight as it always did.
  IF jsonb_typeof(_t->'score') = 'number' THEN
    v_score := LEAST(100, GREATEST(0, ROUND((_t->>'score')::NUMERIC)))::INTEGER;
    v_grade := CASE
      WHEN v_score >= 90 THEN 'A'
      WHEN v_score >= 75 THEN 'B'
      WHEN v_score >= 60 THEN 'C'
      WHEN v_score >= 40 THEN 'D'
      ELSE 'F'
    END;
    v_xp_mult := CASE v_grade
      WHEN 'A' THEN 1.1 WHEN 'C' THEN 0.9 WHEN 'D' THEN 0.75 WHEN 'F' THEN 0.5 ELSE 1.0
    END;
  END IF;

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

  -- A contract reset by an earlier crash only counts when this flight took off
  -- from where it has to restart. Flown from anywhere else it resets again.
  IF _mission_id IS NOT NULL AND v_m.restart_from IS NOT NULL AND NOT v_crashed
     AND upper(trim(COALESCE(_t->>'departure', ''))) <> upper(trim(v_m.restart_from)) THEN
    v_wrong_start := true;
    v_success := false;
  END IF;
  v_reset := _mission_id IS NOT NULL AND (v_crashed OR v_wrong_start);

  IF NOT v_arrived THEN v_incidents := v_incidents || 'off-contract landing'; END IF;
  IF v_quality = 'hard' THEN v_incidents := v_incidents || 'hard landing'; END IF;
  IF v_quality = 'severe' THEN v_incidents := v_incidents || 'skid damage on touchdown'; END IF;
  IF v_crashed THEN v_incidents := v_incidents || 'heavy crash damage'; END IF;
  IF v_wrong_start THEN
    v_incidents := v_incidents || format('not restarted from %s', v_m.restart_from);
  END IF;

  v_wear := v_hours * (COALESCE(v_m.difficulty, 1) * 0.8) * v_ac.maintenance_factor * v_wear_mult
            + (CASE v_quality WHEN 'hard' THEN 3 WHEN 'severe' THEN 12 ELSE 0 END) * v_hardwear_mult
            + (CARDINALITY(v_incidents) * 1.5);

  -- Breakdowns: the condition it took off in against its reliability. A crash
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

  -- A crash leaves the airframe at 100% wear until it is repaired.
  v_new_wear := CASE WHEN v_crashed THEN 100 ELSE LEAST(100, v_ac.wear + v_wear) END;

  -- Only pump fuel is paid in cash now; tank fuel was paid for when it was bought.
  v_fuel_cost := (v_fuel - v_tank_lb) * fuel_price_per_lb;
  v_op_cost   := v_hours * v_ac.op_cost_hr;
  v_op_billed := (CASE WHEN v_success THEN v_op_cost ELSE v_op_cost * 0.5 END)
                 * v_op_mult * v_wear_cost_mult;
  -- Lease is owed on every hour flown, successful contract or not.
  v_lease := v_hours * COALESCE(v_ac.lease_cost, 0) * v_lease_mult;

  -- The grade prices a scored flight; an unscored one keeps the landing rule.
  v_mult := CASE
    WHEN v_grade IS NOT NULL THEN CASE v_grade
      WHEN 'A' THEN 1.05 WHEN 'B' THEN 1.0 WHEN 'C' THEN 0.95 WHEN 'D' THEN 0.9 ELSE 0.8 END
    ELSE CASE v_quality WHEN 'excellent' THEN 1.05 WHEN 'hard' THEN 0.9 ELSE 1.0 END
  END;
  v_payout := CASE WHEN v_success THEN COALESCE(v_m.payout, 0) * v_mult * v_payout_mult ELSE 0 END;
  -- A check ride pays no contract fee -- the rating is the payout -- whatever
  -- the row's own payout column happens to hold.
  IF v_checkride THEN v_payout := 0; END IF;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

  v_rep_delta := CASE
    WHEN _mission_id IS NULL THEN 0
    -- Taking off from the wrong place wastes the flight, but isn't a failure.
    WHEN v_wrong_start THEN 0
    WHEN v_success AND v_grade = 'A' THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success AND v_grade = 'F' THEN COALESCE(v_m.difficulty, 1) - 1
    WHEN v_success AND v_grade IS NULL AND v_quality = 'excellent'
      THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success THEN COALESCE(v_m.difficulty, 1)
    ELSE -COALESCE(v_m.difficulty, 1) * 2
  END;

  INSERT INTO public.flight_logs (
    company_id, aircraft_id, mission_id, pilot_id, departure, arrival,
    duration_hr, fuel_used, payload, landing_quality, incidents,
    weather_difficulty, success, source, telemetry, score, grade, score_items
  ) VALUES (
    _company_id, _aircraft_id, _mission_id,
    v_pilot,
    COALESCE(_t->>'departure', v_m.origin),
    COALESCE(_t->>'arrival', v_m.destination),
    ROUND(v_hours, 2), ROUND(v_fuel), v_payload,
    CASE WHEN v_quality = 'severe' THEN 'hard' ELSE v_quality END,
    NULLIF(array_to_string(v_incidents, ', '), ''),
    COALESCE(v_m.weather_factor, COALESCE((_t->>'weather_factor')::INTEGER, 1)),
    v_success, _source, _t,
    v_score, v_grade,
    CASE WHEN jsonb_typeof(_t->'score_items') = 'array' THEN _t->'score_items' ELSE '[]'::JSONB END
  ) RETURNING id INTO v_log_id;

  -- A crash is heavy damage, not a write-off: grounded, and remembering the
  -- wear it had so the crash repair can put it back. In SET, the column names
  -- on the right still read the row as it was before this update.
  UPDATE public.aircraft SET
    hours  = hours + v_hours,
    wear   = v_new_wear,
    crash_damaged = crash_damaged OR v_crashed,
    wear_before_crash = CASE WHEN v_crashed AND NOT crash_damaged THEN v_ac.wear
                             ELSE wear_before_crash END,
    broken_down_at = CASE WHEN v_breakdown OR v_crashed THEN now() ELSE broken_down_at END,
    status = CASE WHEN v_crashed OR v_breakdown OR v_new_wear >= 85
                       OR broken_down_at IS NOT NULL
                    THEN 'grounded'
                  ELSE 'available' END
  WHERE id = _aircraft_id;

  IF v_reset THEN
    -- Back on the board, objectives cleared, still this pilot's to restart --
    -- from its origin, or the home base when it has none.
    v_restart_from := COALESCE(
      NULLIF(upper(trim(v_m.restart_from)), ''),
      NULLIF(upper(trim(v_m.origin)), ''),
      (SELECT upper(trim(icao)) FROM public.bases
        WHERE company_id = _company_id AND icao IS NOT NULL
        ORDER BY is_primary DESC, created_at LIMIT 1));
    UPDATE public.missions SET
      status = 'available',
      aircraft_id = NULL,
      dispatched_at = NULL,
      assigned_pilot_id = COALESCE(assigned_pilot_id, v_pilot),
      objectives_state = '{}'::JSONB,
      restart_from = v_restart_from,
      crash_count = crash_count + CASE WHEN v_crashed THEN 1 ELSE 0 END
    WHERE id = _mission_id;
  ELSIF _mission_id IS NOT NULL THEN
    UPDATE public.missions SET
      status = CASE WHEN v_success THEN 'completed' ELSE 'failed' END,
      completed_at = now(),
      aircraft_id = _aircraft_id
    WHERE id = _mission_id;
  END IF;

  -- Fuel runs: fill the tank on a successful delivery; otherwise the avgas
  -- goes back to the refinery it came from. A reset run keeps its avgas
  -- reserved for the restart.
  IF COALESCE(v_m.role, '') = 'fuel_run' AND NOT v_reset THEN
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

  -- Industry hauls and trade runs: a delivered load reaches the buyer, a
  -- failed one goes back to its source. A reset haul keeps its load reserved
  -- for the restart.
  IF _mission_id IS NOT NULL AND NOT v_reset THEN
    v_haul_units := public.settle_industry_delivery(_mission_id, v_success);
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

  -- XP: real contracts pay by hours and difficulty, scaled by the grade;
  -- positioning flights and failed contracts pay nothing, so grinding empty
  -- circuits doesn't level a pilot up. A check ride passed is worth a flat
  -- bonus on top of the ordinary flight.
  v_xp_gain := 0;
  IF v_pilot IS NOT NULL AND _mission_id IS NOT NULL AND v_success AND NOT v_checkride THEN
    v_xp_gain := ROUND((10 + ROUND(v_hours * 12) + COALESCE(v_m.difficulty, 1) * 5) * v_xp_mult);
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
    'fuel_delivered_lb', ROUND(v_delivered_lb),
    'crashed', v_crashed,
    'restart_required', v_reset,
    'restart_from', v_restart_from,
    'score', v_score,
    'grade', v_grade,
    'haul_delivered_units', ROUND(v_haul_units)
  );
END;$fn$;

REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
