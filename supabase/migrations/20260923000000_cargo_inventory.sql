-- =============================================================================
-- Cargo and passengers: jobs waiting at places, a load sheet, and trips.
--
-- OnAir-style work, approved by the user 2026-09-14 (all three stages).
--
--   Jobs      Rows in missions with a `manifest` -- the items and passengers
--             they carry -- a pickup and a drop place, and an expiry. Built in
--             the browser (src/lib/cargo.ts), like every other contract.
--   Trips     One aircraft, the jobs loaded into it at one pickup, and the
--             fuel chosen on the load sheet. A trip stays open across flights
--             until every job is delivered or it is cancelled.
--   Legs      Each flight of a trip logs as a positioning flight (hours, fuel,
--             wear, score) through rotorops_resolve_flight, which now keeps the
--             aircraft on_mission while its trip is open, and cancels the trip
--             on a crash.
--   Delivery  bridge_deliver_job pays one job the moment it is set down at its
--             drop: payout, reputation by difficulty, a little XP, and goods
--             into the buyer's stock for an industry load.
--
-- Weights: cargo is the manifest's items at their unit weights plus 190 lb a
-- passenger. The limit is the aircraft's max gross less its empty weight, as
-- the sim reports them (bridge_set_aircraft_limits); until it has, cargo alone
-- is held to the catalogue payload. Passengers are held to the seats behind
-- the pilot. dispatch_trip enforces both, so the load sheet's Validate can't
-- be talked past.
--
-- Carried forward whole: bridge_state from 20260916000000_crash_restart.sql,
-- rotorops_resolve_flight from 20260922000000_fix_incident_lists.sql. Any later
-- change to either starts from this copy. Re-runnable.
-- =============================================================================

-- Limits the sim reports for an aircraft ---------------------------------------

ALTER TABLE public.aircraft
  ADD COLUMN IF NOT EXISTS empty_weight_lb NUMERIC,
  ADD COLUMN IF NOT EXISTS max_gross_lb NUMERIC,
  ADD COLUMN IF NOT EXISTS fuel_capacity_lb NUMERIC,
  ADD COLUMN IF NOT EXISTS limits_reported_at TIMESTAMPTZ;

-- Trips ------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.trips (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id      UUID NOT NULL REFERENCES public.aircraft(id) ON DELETE CASCADE,
  pilot_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  -- Fuel to put in the tanks at pickup. NULL leaves it as set in the sim.
  fuel_lb          NUMERIC CHECK (fuel_lb IS NULL OR fuel_lb >= 0),
  cargo_lb         NUMERIC NOT NULL DEFAULT 0,
  pax              INTEGER NOT NULL DEFAULT 0,
  pickup_name      TEXT,
  pickup_icao      TEXT,
  pickup_lat       DOUBLE PRECISION,
  pickup_lon       DOUBLE PRECISION,
  pickup_radius_nm NUMERIC NOT NULL DEFAULT 2,
  -- Set by the bridge when the weight went aboard at the pickup.
  loaded_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);

-- One open trip per aircraft.
CREATE UNIQUE INDEX IF NOT EXISTS trips_one_active_per_aircraft
  ON public.trips (aircraft_id) WHERE status = 'active';

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.trips TO authenticated;
GRANT ALL ON public.trips TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.trips FROM authenticated;
DROP POLICY IF EXISTS "trips read" ON public.trips;
CREATE POLICY "trips read" ON public.trips
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- Jobs -------------------------------------------------------------------------

ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS manifest JSONB,
  ADD COLUMN IF NOT EXISTS cargo_lb NUMERIC,
  ADD COLUMN IF NOT EXISTS pickup_name TEXT,
  ADD COLUMN IF NOT EXISTS pickup_icao TEXT,
  ADD COLUMN IF NOT EXISTS pickup_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pickup_lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS pickup_radius_nm NUMERIC,
  ADD COLUMN IF NOT EXISTS drop_name TEXT,
  ADD COLUMN IF NOT EXISTS drop_icao TEXT,
  ADD COLUMN IF NOT EXISTS drop_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS drop_lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS drop_radius_nm NUMERIC,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS missions_trip_idx ON public.missions (trip_id) WHERE trip_id IS NOT NULL;

ALTER TABLE public.flight_logs
  ADD COLUMN IF NOT EXISTS trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL;

-- Helpers ----------------------------------------------------------------------

-- What a manifest weighs: every item at its unit weight, and 190 lb a
-- passenger with a bag. Mirrors manifestWeight in src/lib/cargo.ts.
CREATE OR REPLACE FUNCTION public.manifest_weight(_manifest JSONB)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public AS $fn$
  SELECT COALESCE((
           SELECT SUM(GREATEST(COALESCE((i->>'qty')::NUMERIC, 0), 0)
                      * GREATEST(COALESCE((i->>'unit_lb')::NUMERIC, 0), 0))
             FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(_manifest->'items') = 'array'
                         THEN _manifest->'items' ELSE '[]'::JSONB END) i
         ), 0)
       + GREATEST(COALESCE((_manifest->>'pax')::INTEGER, 0), 0) * 190;
$fn$;

CREATE OR REPLACE FUNCTION public.cargo_nm_between(
  _lat1 DOUBLE PRECISION, _lon1 DOUBLE PRECISION,
  _lat2 DOUBLE PRECISION, _lon2 DOUBLE PRECISION)
RETURNS DOUBLE PRECISION
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 3440.065 * 2 * asin(LEAST(1, sqrt(
           power(sin(radians(_lat2 - _lat1) / 2), 2)
           + cos(radians(_lat1)) * cos(radians(_lat2)) * power(sin(radians(_lon2 - _lon1) / 2), 2))));
$fn$;

-- Put a trip's undelivered jobs back where they were collected. Goods go back
-- to their site through the industry_deliveries delete trigger.
CREATE OR REPLACE FUNCTION public.release_trip_jobs(_trip_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_n INTEGER;
BEGIN
  DELETE FROM public.industry_deliveries d
   USING public.missions m
   WHERE d.mission_id = m.id
     AND m.trip_id = _trip_id
     AND m.delivered_at IS NULL
     AND d.outcome IS NULL;

  UPDATE public.missions
     SET status = 'available', trip_id = NULL, aircraft_id = NULL,
         dispatched_at = NULL, assigned_pilot_id = NULL
   WHERE trip_id = _trip_id AND delivered_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;$fn$;

REVOKE EXECUTE ON FUNCTION public.release_trip_jobs(UUID) FROM PUBLIC, anon, authenticated;

-- The load sheet ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dispatch_trip(
  _aircraft_id UUID,
  _job_ids     UUID[],
  _fuel_lb     NUMERIC DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ac    public.aircraft%ROWTYPE;
  v_info  RECORD;
  v_first public.missions%ROWTYPE;
  v_m     public.missions%ROWTYPE;
  v_from  public.industries%ROWTYPE;
  v_def   public.industry_defs%ROWTYPE;
  v_units NUMERIC;
  v_cargo NUMERIC := 0;
  v_pax   INTEGER := 0;
  v_seats INTEGER;
  v_count INTEGER := 0;
  v_limit NUMERIC;
  v_trip  UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;
  IF _job_ids IS NULL OR cardinality(_job_ids) = 0 THEN
    RAISE EXCEPTION 'pick at least one job to load';
  END IF;

  SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_ac.company_id) THEN
    RAISE EXCEPTION 'aircraft not found';
  END IF;
  IF v_ac.status <> 'available' THEN RAISE EXCEPTION 'aircraft unavailable'; END IF;
  IF v_ac.hours - v_ac.hours_at_inspection > 110 THEN
    RAISE EXCEPTION 'aircraft is overdue its 100-hour inspection -- service it on the Maintenance page';
  END IF;
  IF EXISTS (SELECT 1 FROM public.trips WHERE aircraft_id = _aircraft_id AND status = 'active') THEN
    RAISE EXCEPTION 'this aircraft already has a trip open -- deliver or cancel it first';
  END IF;

  -- The same check rides a contract needs. The owner is exempt.
  IF COALESCE(public.company_role(v_ac.company_id), '') <> 'owner' THEN
    SELECT * INTO v_info FROM public.rating_info(v_ac.internal_id, v_ac.sim_title, v_ac.display_name);
    IF NOT EXISTS (SELECT 1 FROM public.pilot_ratings
                    WHERE company_id = v_ac.company_id AND user_id = auth.uid()
                      AND rating = 'checkout' AND passed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'pass your company check ride before taking work -- it''s on the Mission Board';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pilot_ratings
                    WHERE company_id = v_ac.company_id AND user_id = auth.uid()
                      AND rating = v_info.rating AND passed_at IS NOT NULL) THEN
      RAISE EXCEPTION 'you aren''t rated on the % yet -- fly its check ride on the Mission Board first',
        v_info.label;
    END IF;
  END IF;

  FOR v_m IN
    SELECT * FROM public.missions WHERE id = ANY(_job_ids) ORDER BY generated_at, id FOR UPDATE
  LOOP
    v_count := v_count + 1;
    IF v_m.company_id <> v_ac.company_id THEN RAISE EXCEPTION 'job not found'; END IF;
    IF v_m.manifest IS NULL THEN
      RAISE EXCEPTION '"%" is a contract, not a cargo job -- dispatch it from the Mission Board', v_m.title;
    END IF;
    IF v_m.status <> 'available' THEN
      RAISE EXCEPTION '"%" is no longer available', v_m.title;
    END IF;
    IF v_m.expires_at IS NOT NULL AND v_m.expires_at < now() THEN
      RAISE EXCEPTION '"%" has expired', v_m.title;
    END IF;
    IF v_m.assigned_pilot_id IS NOT NULL AND v_m.assigned_pilot_id <> auth.uid()
       AND NOT public.can_manage_company(v_m.company_id) THEN
      RAISE EXCEPTION '"%" is reserved for another pilot', v_m.title;
    END IF;

    -- Everything on a trip is collected in one place.
    IF v_first.id IS NULL THEN
      v_first := v_m;
    ELSIF NOT (
      (v_first.pickup_icao IS NOT NULL AND v_m.pickup_icao IS NOT NULL
         AND upper(v_first.pickup_icao) = upper(v_m.pickup_icao))
      OR (v_first.pickup_lat IS NOT NULL AND v_m.pickup_lat IS NOT NULL
         AND public.cargo_nm_between(v_first.pickup_lat, v_first.pickup_lon,
                                     v_m.pickup_lat, v_m.pickup_lon) <= 1)
    ) THEN
      RAISE EXCEPTION 'every job on a trip is collected from the same place -- "%" is waiting at %',
        v_m.title, COALESCE(v_m.pickup_name, v_m.pickup_icao, 'somewhere else');
    END IF;

    v_cargo := v_cargo + public.manifest_weight(v_m.manifest);
    v_pax := v_pax + GREATEST(COALESCE((v_m.manifest->>'pax')::INTEGER, 0), 0);

    -- An industry load leaves the site's stock now, so two jobs can't both
    -- fly it. As dispatch_mission does for a haul contract.
    IF v_m.haul_from_industry_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.industry_deliveries
          WHERE mission_id = v_m.id AND outcome IS NULL) THEN
      PERFORM public.industry_tick(v_m.haul_from_industry_id);
      SELECT * INTO v_from FROM public.industries
       WHERE id = v_m.haul_from_industry_id FOR UPDATE;
      IF NOT FOUND OR v_from.company_id <> v_m.company_id THEN
        RAISE EXCEPTION 'the site "%" collects from is gone -- clear it and generate again', v_m.title;
      END IF;
      IF v_m.haul_to_industry_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.industries
            WHERE id = v_m.haul_to_industry_id AND company_id = v_m.company_id) THEN
        RAISE EXCEPTION 'the site "%" delivers to is gone -- clear it and generate again', v_m.title;
      END IF;
      SELECT * INTO v_def FROM public.industry_defs WHERE kind = v_from.kind;
      v_units := FLOOR(COALESCE(v_m.haul_units, 0));
      IF v_units <= 0 THEN RAISE EXCEPTION '"%" has nothing to carry', v_m.title; END IF;
      IF v_units > v_from.stock THEN
        RAISE EXCEPTION '% has only % units of % left -- clear the job and generate again',
          COALESCE(v_from.name, v_def.kind), FLOOR(v_from.stock), v_def.output_good;
      END IF;
      -- Jobs are written in the browser, so the weight is held to what the goods weigh.
      IF public.manifest_weight(v_m.manifest) < FLOOR(v_units * v_def.good_unit_lb * 0.85) - 1 THEN
        RAISE EXCEPTION '"%" weighs less than its goods -- clear it and generate again', v_m.title;
      END IF;
      INSERT INTO public.industry_deliveries (
        mission_id, company_id, from_industry_id, to_industry_id, good, units)
      VALUES (v_m.id, v_m.company_id, v_from.id, v_m.haul_to_industry_id,
              v_def.output_good, v_units);
      UPDATE public.industries SET stock = stock - v_units WHERE id = v_from.id;
    END IF;
  END LOOP;

  IF v_count <> cardinality(_job_ids) THEN
    RAISE EXCEPTION 'one of those jobs is gone -- refresh the Cargo Hub';
  END IF;

  -- Seats behind the pilot.
  v_seats := GREATEST(COALESCE(v_ac.pax_seats, 0) - 1, 0);
  IF v_pax > v_seats THEN
    RAISE EXCEPTION '% passengers won''t fit: the % has % seats behind the pilot',
      v_pax, v_ac.display_name, v_seats;
  END IF;

  IF _fuel_lb IS NOT NULL THEN
    IF _fuel_lb < 0 THEN RAISE EXCEPTION 'fuel can''t be negative'; END IF;
    IF v_ac.fuel_capacity_lb IS NOT NULL AND _fuel_lb > v_ac.fuel_capacity_lb + 1 THEN
      RAISE EXCEPTION 'the % holds % lb of fuel', v_ac.display_name, ROUND(v_ac.fuel_capacity_lb);
    END IF;
  END IF;

  IF v_ac.max_gross_lb IS NOT NULL AND v_ac.empty_weight_lb IS NOT NULL
     AND v_ac.max_gross_lb > v_ac.empty_weight_lb THEN
    v_limit := v_ac.max_gross_lb - v_ac.empty_weight_lb;
    IF v_cargo + COALESCE(_fuel_lb, 0) > v_limit THEN
      RAISE EXCEPTION 'over weight: % lb of cargo and passengers and % lb of fuel is more than the % lb the % can lift',
        ROUND(v_cargo), ROUND(COALESCE(_fuel_lb, 0)), ROUND(v_limit), v_ac.display_name;
    END IF;
  ELSIF v_cargo > COALESCE(v_ac.payload_lbs, 0) THEN
    RAISE EXCEPTION 'over weight: % lb of cargo and passengers is more than the % lb the % can carry',
      ROUND(v_cargo), COALESCE(v_ac.payload_lbs, 0), v_ac.display_name;
  END IF;

  INSERT INTO public.trips (
    company_id, aircraft_id, pilot_id, fuel_lb, cargo_lb, pax,
    pickup_name, pickup_icao, pickup_lat, pickup_lon, pickup_radius_nm)
  VALUES (
    v_ac.company_id, _aircraft_id, auth.uid(), _fuel_lb, v_cargo, v_pax,
    v_first.pickup_name, v_first.pickup_icao, v_first.pickup_lat, v_first.pickup_lon,
    COALESCE(v_first.pickup_radius_nm, 2))
  RETURNING id INTO v_trip;

  UPDATE public.missions
     SET status = 'in_progress', trip_id = v_trip, aircraft_id = _aircraft_id,
         dispatched_at = now(), assigned_pilot_id = auth.uid(),
         cargo_lb = public.manifest_weight(manifest)
   WHERE id = ANY(_job_ids);
  UPDATE public.aircraft SET status = 'on_mission' WHERE id = _aircraft_id;
  RETURN v_trip;
END;$fn$;

CREATE OR REPLACE FUNCTION public.cancel_trip(_trip_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_t public.trips%ROWTYPE;
  v_n INTEGER;
BEGIN
  SELECT * INTO v_t FROM public.trips WHERE id = _trip_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_company_member(v_t.company_id) THEN
    RAISE EXCEPTION 'trip not found';
  END IF;
  IF v_t.status <> 'active' THEN RAISE EXCEPTION 'this trip is already %', v_t.status; END IF;
  IF v_t.pilot_id IS DISTINCT FROM auth.uid() AND NOT public.can_manage_company(v_t.company_id) THEN
    RAISE EXCEPTION 'this trip belongs to another pilot';
  END IF;

  v_n := public.release_trip_jobs(_trip_id);
  UPDATE public.trips
     SET status = CASE WHEN EXISTS (SELECT 1 FROM public.missions
                                     WHERE trip_id = _trip_id AND delivered_at IS NOT NULL)
                       THEN 'completed' ELSE 'cancelled' END,
         completed_at = now()
   WHERE id = _trip_id;
  UPDATE public.aircraft SET status = 'available'
   WHERE id = v_t.aircraft_id AND status = 'on_mission';
  RETURN v_n;
END;$fn$;

GRANT EXECUTE ON FUNCTION public.dispatch_trip(UUID, UUID[], NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_trip(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.dispatch_trip(UUID, UUID[], NUMERIC) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cancel_trip(UUID) FROM PUBLIC, anon;

-- The bridge -------------------------------------------------------------------

-- What the sim says an aircraft weighs empty, may weigh at most, and holds in
-- fuel. Values outside any real helicopter or aeroplane are ignored.
CREATE OR REPLACE FUNCTION public.bridge_set_aircraft_limits(
  _token TEXT, _aircraft_id UUID,
  _empty_lb NUMERIC, _max_gross_lb NUMERIC, _fuel_capacity_lb NUMERIC)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE v_dev public.sim_devices%ROWTYPE;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.aircraft SET
    empty_weight_lb = CASE WHEN _empty_lb > 100 AND _empty_lb < 600000
                           THEN ROUND(_empty_lb) ELSE empty_weight_lb END,
    max_gross_lb = CASE WHEN _max_gross_lb > COALESCE(_empty_lb, 0) AND _max_gross_lb < 1000000
                        THEN ROUND(_max_gross_lb) ELSE max_gross_lb END,
    fuel_capacity_lb = CASE WHEN _fuel_capacity_lb > 0 AND _fuel_capacity_lb < 500000
                            THEN ROUND(_fuel_capacity_lb) ELSE fuel_capacity_lb END,
    limits_reported_at = now()
  WHERE id = _aircraft_id AND company_id = v_dev.company_id;
  RETURN FOUND;
END;$fn$;

-- The weight went aboard at the pickup.
CREATE OR REPLACE FUNCTION public.bridge_trip_loaded(_token TEXT, _trip_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE v_dev public.sim_devices%ROWTYPE;
BEGIN
  v_dev := public.bridge_device(_token);
  UPDATE public.trips SET loaded_at = COALESCE(loaded_at, now())
   WHERE id = _trip_id AND company_id = v_dev.company_id AND status = 'active';
  RETURN FOUND;
END;$fn$;

-- One job set down at its drop.
CREATE OR REPLACE FUNCTION public.bridge_deliver_job(_token TEXT, _job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  v_dev    public.sim_devices%ROWTYPE;
  v_m      public.missions%ROWTYPE;
  v_t      public.trips%ROWTYPE;
  v_co     public.companies%ROWTYPE;
  v_perks  TEXT[];
  v_payout NUMERIC;
  v_rep    INTEGER;
  v_xp     INTEGER := 0;
  v_repay  NUMERIC := 0;
  v_units  NUMERIC;
  v_left   INTEGER;
BEGIN
  v_dev := public.bridge_device(_token);

  SELECT * INTO v_m FROM public.missions
   WHERE id = _job_id AND company_id = v_dev.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'job not found for this company'; END IF;
  IF v_m.delivered_at IS NOT NULL THEN RAISE EXCEPTION 'job already delivered'; END IF;
  IF v_m.trip_id IS NULL OR v_m.status <> 'in_progress' THEN
    RAISE EXCEPTION 'job is not on a trip';
  END IF;

  SELECT * INTO v_t FROM public.trips WHERE id = v_m.trip_id FOR UPDATE;
  IF v_t.status <> 'active' THEN RAISE EXCEPTION 'this trip is %', v_t.status; END IF;
  IF v_t.pilot_id IS NOT NULL AND v_t.pilot_id <> v_dev.user_id THEN
    RAISE EXCEPTION 'this trip belongs to another pilot';
  END IF;
  IF v_t.loaded_at IS NULL THEN RAISE EXCEPTION 'this trip was never loaded'; END IF;

  SELECT unlocked_perks INTO v_perks FROM public.pilot_skills
   WHERE company_id = v_m.company_id AND user_id = v_t.pilot_id;
  v_perks := COALESCE(v_perks, ARRAY[]::TEXT[]);

  v_payout := ROUND(COALESCE(v_m.payout, 0)
                    * (CASE WHEN 'ace_pilot' = ANY(v_perks) THEN 1.05 ELSE 1.0 END));
  v_rep := COALESCE(v_m.difficulty, 1);

  v_units := public.settle_industry_delivery(_job_id, true);

  UPDATE public.missions
     SET status = 'completed', delivered_at = now(), completed_at = now()
   WHERE id = _job_id;

  SELECT * INTO v_co FROM public.companies WHERE id = v_m.company_id FOR UPDATE;
  UPDATE public.companies
     SET cash = cash + v_payout,
         reputation = GREATEST(0, LEAST(100, reputation + v_rep))
   WHERE id = v_m.company_id;
  INSERT INTO public.economy_transactions (company_id, type, amount, description)
  VALUES (v_m.company_id, 'mission_payout', v_payout, v_m.title);

  -- Loans: a tenth of contract pay goes to the balance until it's cleared.
  IF v_payout > 0 AND COALESCE(v_co.loan_balance, 0) > 0 THEN
    v_repay := LEAST(v_co.loan_balance, ROUND(v_payout * 0.10));
    UPDATE public.companies
       SET cash = cash - v_repay, loan_balance = loan_balance - v_repay
     WHERE id = v_m.company_id;
    INSERT INTO public.economy_transactions (company_id, type, amount, description)
    VALUES (v_m.company_id, 'loan_repayment', -v_repay,
            format('Loan repayment from %s', v_m.title));
  END IF;

  -- Hours earn their XP on the leg's flight log; a delivery earns the job's.
  IF v_t.pilot_id IS NOT NULL THEN
    v_xp := 10 + COALESCE(v_m.difficulty, 1) * 5;
    INSERT INTO public.pilot_skills (company_id, user_id, xp)
    VALUES (v_m.company_id, v_t.pilot_id, v_xp)
    ON CONFLICT (company_id, user_id) DO UPDATE
      SET xp = pilot_skills.xp + EXCLUDED.xp, updated_at = now();
  END IF;

  SELECT count(*) INTO v_left FROM public.missions
   WHERE trip_id = v_t.id AND delivered_at IS NULL;
  IF v_left = 0 THEN
    UPDATE public.trips SET status = 'completed', completed_at = now() WHERE id = v_t.id;
    UPDATE public.aircraft SET status = 'available'
     WHERE id = v_t.aircraft_id AND status = 'on_mission';
  END IF;

  RETURN jsonb_build_object(
    'job_id', _job_id,
    'title', v_m.title,
    'payout', v_payout,
    'reputation_delta', v_rep,
    'xp_gained', v_xp,
    'loan_repayment', v_repay,
    'haul_delivered_units', ROUND(COALESCE(v_units, 0)),
    'jobs_left', v_left,
    'trip_completed', v_left = 0
  );
END;$fn$;

GRANT EXECUTE ON FUNCTION public.bridge_set_aircraft_limits(TEXT, UUID, NUMERIC, NUMERIC, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_trip_loaded(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_deliver_job(TEXT, UUID) TO anon, authenticated;

-- bridge_state, carried forward from 20260916000000_crash_restart.sql: trips,
-- the aircraft's reported limits, and trip jobs kept out of `dispatched`.
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
    'bases', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'icao', b.icao, 'name', b.name,
        'latitude', b.latitude, 'longitude', b.longitude,
        'airport_count', jsonb_array_length(b.nearby_airports),
        'airports_updated_at', b.airports_updated_at
      )) FROM public.bases b WHERE b.company_id = v_dev.company_id), '[]'::JSONB)
  ) INTO v_out;

  RETURN v_out;
END;$fn$;

-- rotorops_resolve_flight, carried forward from
-- 20260922000000_fix_incident_lists.sql: a flight of an aircraft with an open
-- trip keeps it on_mission and records the trip; a crash cancels the trip.
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
  v_rating_ride    BOOLEAN;
  v_rating_passed  BOOLEAN := false;
  v_trip           public.trips%ROWTYPE;
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
  v_rating_ride := COALESCE(v_m.role, '') = 'rating_ride';
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

  -- A rating check ride passes on every objective done and a score of 60 or
  -- better. No score (a manual log) is no pass: the score is the examiner.
  IF v_rating_ride THEN
    v_success := v_success AND public.mission_objectives_met(_mission_id)
                 AND COALESCE(v_score, 0) >= 60;
  END IF;

  -- A contract reset by an earlier crash only counts when this flight took off
  -- from where it has to restart. Flown from anywhere else it resets again.
  IF _mission_id IS NOT NULL AND v_m.restart_from IS NOT NULL AND NOT v_crashed
     AND upper(trim(COALESCE(_t->>'departure', ''))) <> upper(trim(v_m.restart_from)) THEN
    v_wrong_start := true;
    v_success := false;
  END IF;
  v_reset := _mission_id IS NOT NULL AND (v_crashed OR v_wrong_start);

  IF NOT v_arrived THEN v_incidents := array_append(v_incidents, 'off-contract landing'); END IF;
  IF v_quality = 'hard' THEN v_incidents := array_append(v_incidents, 'hard landing'); END IF;
  IF v_quality = 'severe' THEN v_incidents := array_append(v_incidents, 'skid damage on touchdown'); END IF;
  IF v_crashed THEN v_incidents := array_append(v_incidents, 'heavy crash damage'); END IF;
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
      v_incidents := array_append(v_incidents, 'mechanical breakdown');
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
  IF v_checkride OR v_rating_ride THEN v_payout := 0; END IF;
  v_net := v_payout - v_fuel_cost - v_op_billed - v_lease;

  v_rep_delta := CASE
    WHEN _mission_id IS NULL THEN 0
    -- Taking off from the wrong place wastes the flight, but isn't a failure.
    WHEN v_wrong_start THEN 0
    -- A check ride, passed or failed, is between the pilot and the examiner.
    WHEN v_rating_ride THEN 0
    WHEN v_success AND v_grade = 'A' THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success AND v_grade = 'F' THEN COALESCE(v_m.difficulty, 1) - 1
    WHEN v_success AND v_grade IS NULL AND v_quality = 'excellent'
      THEN COALESCE(v_m.difficulty, 1) + 1 + v_rep_bonus
    WHEN v_success THEN COALESCE(v_m.difficulty, 1)
    ELSE -COALESCE(v_m.difficulty, 1) * 2
  END;

  -- A leg of an open cargo trip: the aircraft stays on the trip afterwards.
  SELECT * INTO v_trip FROM public.trips
   WHERE aircraft_id = _aircraft_id AND status = 'active'
   ORDER BY created_at DESC LIMIT 1
   FOR UPDATE;

  INSERT INTO public.flight_logs (
    company_id, aircraft_id, mission_id, pilot_id, departure, arrival,
    duration_hr, fuel_used, payload, landing_quality, incidents,
    weather_difficulty, success, source, telemetry, score, grade, score_items, trip_id
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
    CASE WHEN jsonb_typeof(_t->'score_items') = 'array' THEN _t->'score_items' ELSE '[]'::JSONB END,
    v_trip.id
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
                  WHEN v_trip.id IS NOT NULL THEN 'on_mission'
                  ELSE 'available' END
  WHERE id = _aircraft_id;

  -- A crash ends the trip: whatever was still aboard goes back to where it
  -- was collected, and the aircraft is grounded above.
  IF v_crashed AND v_trip.id IS NOT NULL THEN
    PERFORM public.release_trip_jobs(v_trip.id);
    UPDATE public.trips SET status = 'cancelled', completed_at = now() WHERE id = v_trip.id;
  END IF;

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
  ELSIF v_rating_ride AND NOT v_success THEN
    -- A failed check ride goes back on the board for the same pilot to retake.
    UPDATE public.missions SET
      status = 'available',
      aircraft_id = NULL,
      dispatched_at = NULL,
      objectives_state = '{}'::JSONB
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

  IF v_rating_ride AND v_success AND v_pilot IS NOT NULL THEN
    UPDATE public.pilot_ratings SET passed_at = now()
     WHERE company_id = _company_id AND user_id = v_pilot AND rating = v_m.scene_name;
    v_rating_passed := FOUND;
  END IF;

  -- XP: real contracts pay by hours and difficulty, scaled by the grade;
  -- positioning flights and failed contracts pay nothing, so grinding empty
  -- circuits doesn't level a pilot up. A check ride passed is worth a flat
  -- bonus on top of the ordinary flight.
  v_xp_gain := 0;
  IF v_pilot IS NOT NULL AND _mission_id IS NOT NULL AND v_success
     AND NOT v_checkride AND NOT v_rating_ride THEN
    v_xp_gain := ROUND((10 + ROUND(v_hours * 12) + COALESCE(v_m.difficulty, 1) * 5) * v_xp_mult);
  END IF;
  IF v_pilot IS NOT NULL AND (v_checkride OR v_rating_ride) AND v_success THEN
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
    'haul_delivered_units', ROUND(v_haul_units),
    'rating_ride', v_rating_ride,
    'rating_passed', v_rating_passed,
    'trip_id', v_trip.id
  );
END;$fn$;
