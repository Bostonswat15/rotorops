-- =============================================================================
-- Pilot ratings: check rides inside a company.
--
--   company check ride   everyone the owner invites, before taking contracts
--   type rating          per aircraft type in the fleet, before flying one;
--                        one rating covers a family (every H125, every Caravan)
--
-- The owner is exempt from both. Managers are not.
--
-- Rides are booked automatically and reserved for their pilot: when someone
-- joins (or stops being the owner), when the company buys or leases an aircraft
-- of a type they aren't rated on, and here for every current non-owner member
-- against the current fleet. A ride is a mission with role 'rating_ride':
--
--   helicopter  hover below 50 ft AGL for 30 s, reach a point 3 nm out, land
--   aeroplane   reach a point 5 nm out, land
--   pass        every objective done and a flight score of 60 or better
--   fail        back on the board for the same pilot; no reputation either way
--   fee         $1,000, charged on the first dispatch; retakes are free
--   XP          150 on a pass, like a certification check ride
--
-- dispatch_mission enforces it. The type of an aircraft comes from
-- aircraft_type_families, a copy of src/lib/aircraft-catalog.ts: an aircraft
-- not listed there is its own type. Add new catalogue aircraft to it.
--
-- Carried forward from 20260918000000_industry_flow.sql: dispatch_mission,
-- cancel_dispatch, rotorops_resolve_flight.
--
-- Run 20260913 through 20260918 first. Safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.aircraft_type_families (
  internal_id TEXT PRIMARY KEY,
  rating      TEXT NOT NULL,
  label       TEXT NOT NULL,
  wing        TEXT NOT NULL CHECK (wing IN ('rotary', 'fixed'))
);

ALTER TABLE public.aircraft_type_families ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.aircraft_type_families TO authenticated;
GRANT ALL ON public.aircraft_type_families TO service_role;
DROP POLICY IF EXISTS "aircraft families read" ON public.aircraft_type_families;
CREATE POLICY "aircraft families read" ON public.aircraft_type_families
  FOR SELECT TO authenticated USING (true);

INSERT INTO public.aircraft_type_families (internal_id, rating, label, wing) VALUES
  ('CABRI-G2', 'CABRI-G2', 'Guimbal Cabri G2', 'rotary'),
  ('R66', 'Robinson R66', 'Robinson R66', 'rotary'),
  ('EC135', 'Eurocopter EC-135T1', 'Eurocopter EC-135T1', 'rotary'),
  ('B206B', 'B206B', 'Bell 206B JetRanger', 'rotary'),
  ('B206L', 'B206L', 'Bell 206 LongRanger', 'rotary'),
  ('MD530F', 'MD530F', 'MD 530F', 'rotary'),
  ('H500CD', 'H500CD', 'Hughes 500C/D', 'rotary'),
  ('H500E', 'H500E', 'Hughes 500E', 'rotary'),
  ('SA315B', 'SA315B', 'Eurocopter SA315B Lama', 'rotary'),
  ('ALOUETTE-III', 'ALOUETTE-III', 'Alouette III', 'rotary'),
  ('H125', 'Airbus H125', 'Airbus H125', 'rotary'),
  ('H125-CARGO', 'Airbus H125', 'Airbus H125', 'rotary'),
  ('H125-RESCUE', 'Airbus H125', 'Airbus H125', 'rotary'),
  ('H125-RESCUE-NH', 'Airbus H125', 'Airbus H125', 'rotary'),
  ('H125-PAX', 'Airbus H125', 'Airbus H125', 'rotary'),
  ('H125-AERIAL', 'Airbus H125', 'Airbus H125', 'rotary'),
  ('EC130', 'EC130', 'Eurocopter EC130', 'rotary'),
  ('B407', 'B407', 'Bell 407', 'rotary'),
  ('WESTLAND-SCOUT', 'WESTLAND-SCOUT', 'Westland Scout', 'rotary'),
  ('OH58', 'OH58', 'Bell OH-58 Kiowa', 'rotary'),
  ('BO105', 'BO105', 'MBB Bo 105', 'rotary'),
  ('MI2', 'Mil Mi-2', 'Mil Mi-2', 'rotary'),
  ('MI2-HOPLITE', 'Mil Mi-2', 'Mil Mi-2', 'rotary'),
  ('H135', 'Airbus H135', 'Airbus H135', 'rotary'),
  ('H135-EXT', 'Airbus H135', 'Airbus H135', 'rotary'),
  ('B222B', 'B222B', 'Bell 222B', 'rotary'),
  ('B429', 'B429', 'Bell 429 GlobalRanger', 'rotary'),
  ('H145', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('H145-CIVILIAN', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('H145-EMS', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('H145-FIRE', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('H145-GEND', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('H145-LUX', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('H145-MIL', 'Airbus H145', 'Airbus H145', 'rotary'),
  ('AS365', 'Eurocopter AS365 Dauphin', 'Eurocopter AS365 Dauphin', 'rotary'),
  ('H160', 'H160', 'Airbus H160', 'rotary'),
  ('S76', 'S76', 'Sikorsky S-76', 'rotary'),
  ('UH1', 'Bell UH-1 Iroquois', 'Bell UH-1 Iroquois', 'rotary'),
  ('UH1H', 'Bell UH-1 Iroquois', 'Bell UH-1 Iroquois', 'rotary'),
  ('SH60', 'SH60', 'Sikorsky SH-60 Seahawk', 'rotary'),
  ('MH60', 'Sikorsky MH-60', 'Sikorsky MH-60', 'rotary'),
  ('HH65B-SAR', 'Aerospatiale HH-65 Dolphin', 'Aerospatiale HH-65 Dolphin', 'rotary'),
  ('HH65A-SAR', 'Aerospatiale HH-65 Dolphin', 'Aerospatiale HH-65 Dolphin', 'rotary'),
  ('HH65B-HITRON', 'Aerospatiale HH-65 Dolphin', 'Aerospatiale HH-65 Dolphin', 'rotary'),
  ('MH60R', 'Sikorsky MH-60', 'Sikorsky MH-60', 'rotary'),
  ('MH60T', 'Sikorsky MH-60', 'Sikorsky MH-60', 'rotary'),
  ('R66-SPRAY', 'Robinson R66', 'Robinson R66', 'rotary'),
  ('AS365-SAR', 'Eurocopter AS365 Dauphin', 'Eurocopter AS365 Dauphin', 'rotary'),
  ('AS365-VIP', 'Eurocopter AS365 Dauphin', 'Eurocopter AS365 Dauphin', 'rotary'),
  ('AS365-PAX', 'Eurocopter AS365 Dauphin', 'Eurocopter AS365 Dauphin', 'rotary'),
  ('AS365FN-SAR', 'Eurocopter AS365 Dauphin', 'Eurocopter AS365 Dauphin', 'rotary'),
  ('EC135-AMB', 'Eurocopter EC-135T1', 'Eurocopter EC-135T1', 'rotary'),
  ('EC135-SAR', 'Eurocopter EC-135T1', 'Eurocopter EC-135T1', 'rotary'),
  ('EC135-SIGHT', 'Eurocopter EC-135T1', 'Eurocopter EC-135T1', 'rotary'),
  ('UH60', 'Sikorsky UH-60 Black Hawk', 'Sikorsky UH-60 Black Hawk', 'rotary'),
  ('UH60-LR', 'Sikorsky UH-60 Black Hawk', 'Sikorsky UH-60 Black Hawk', 'rotary'),
  ('H225', 'H225', 'Airbus H225', 'rotary'),
  ('MI17', 'MI17', 'Mil Mi-17', 'rotary'),
  ('S64', 'Sikorsky S-64 Skycrane', 'Sikorsky S-64 Skycrane', 'rotary'),
  ('S64-FIRE', 'Sikorsky S-64 Skycrane', 'Sikorsky S-64 Skycrane', 'rotary'),
  ('S64-LIFT', 'Sikorsky S-64 Skycrane', 'Sikorsky S-64 Skycrane', 'rotary'),
  ('CH47', 'CH47', 'Boeing CH-47 Chinook', 'rotary'),
  ('V22', 'V22', 'Bell Boeing V-22 Osprey', 'rotary'),
  ('C152', 'C152', 'Cessna 152', 'fixed'),
  ('C172', 'C172', 'Cessna 172 Skyhawk', 'fixed'),
  ('DA40', 'DA40', 'Diamond DA40 NG', 'fixed'),
  ('SR22', 'SR22', 'Cirrus SR22', 'fixed'),
  ('G36', 'G36', 'Beechcraft Bonanza G36', 'fixed'),
  ('XCUB', 'XCUB', 'CubCrafters XCub', 'fixed'),
  ('SAVAGE', 'SAVAGE', 'Zlin Savage Cub', 'fixed'),
  ('DHC2', 'De Havilland DHC-2 Beaver', 'De Havilland DHC-2 Beaver', 'fixed'),
  ('PC12NGX', 'PC12NGX', 'Pilatus PC-12 NGX', 'fixed'),
  ('DHC6', 'DHC6', 'DHC-6 Twin Otter', 'fixed'),
  ('BE58', 'BE58', 'Beechcraft Baron G58', 'fixed'),
  ('DA62', 'DA62', 'Diamond DA62', 'fixed'),
  ('C208', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('C208-CARGO', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('C208-MEDIC', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('C208-FLOATS', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('C208-PAX', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('C208-SKYDIVE', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('C208-SCI', 'Cessna 208B Caravan', 'Cessna 208B Caravan', 'fixed'),
  ('DHC2-FLOATS', 'De Havilland DHC-2 Beaver', 'De Havilland DHC-2 Beaver', 'fixed'),
  ('TBM930', 'TBM930', 'Daher TBM 930', 'fixed'),
  ('B350', 'B350', 'Beechcraft King Air 350i', 'fixed'),
  ('SF50', 'SF50', 'Cirrus Vision Jet SF50', 'fixed'),
  ('CJ4', 'CJ4', 'Cessna Citation CJ4', 'fixed'),
  ('LONGITUDE', 'LONGITUDE', 'Cessna Citation Longitude', 'fixed')
ON CONFLICT (internal_id) DO UPDATE
  SET rating = EXCLUDED.rating, label = EXCLUDED.label, wing = EXCLUDED.wing;

-- Which rating an aircraft needs.
CREATE OR REPLACE FUNCTION public.rating_info(_internal_id TEXT, _sim_title TEXT, _display_name TEXT)
RETURNS TABLE (rating TEXT, label TEXT, wing TEXT)
LANGUAGE sql STABLE SET search_path = public AS $fn$
  SELECT COALESCE(f.rating,
                  CASE WHEN COALESCE(_internal_id, 'CUSTOM') = 'CUSTOM'
                       THEN 'custom:' || COALESCE(_sim_title, _display_name, 'aircraft')
                       ELSE _internal_id END),
         COALESCE(f.label, _display_name, _internal_id, 'aircraft'),
         COALESCE(f.wing, 'rotary')
    FROM (SELECT 1) AS one
    LEFT JOIN public.aircraft_type_families f ON f.internal_id = _internal_id;
$fn$;

CREATE TABLE IF NOT EXISTS public.pilot_ratings (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 'checkout' for the company check ride, otherwise aircraft_type_families.rating.
  rating     TEXT NOT NULL,
  label      TEXT NOT NULL,
  wing       TEXT NOT NULL DEFAULT 'rotary',
  passed_at  TIMESTAMPTZ,
  fee_paid   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id, rating)
);

ALTER TABLE public.pilot_ratings ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.pilot_ratings TO authenticated;
GRANT ALL ON public.pilot_ratings TO service_role;
REVOKE INSERT, UPDATE, DELETE ON public.pilot_ratings FROM authenticated;
DROP POLICY IF EXISTS "pilot ratings read" ON public.pilot_ratings;
CREATE POLICY "pilot ratings read" ON public.pilot_ratings
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- --------------------------------------------------------------------------
-- Book one check ride, if it isn't passed and isn't already on the board.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.book_rating_ride(
  _company_id UUID, _user_id UUID, _rating TEXT, _label TEXT, _wing TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_passed TIMESTAMPTZ;
  v_base   public.bases%ROWTYPE;
  v_name   TEXT;
  v_fixed  BOOLEAN := _wing = 'fixed';
  v_nm     NUMERIC := CASE WHEN _wing = 'fixed' THEN 5 ELSE 3 END;
  v_brg    DOUBLE PRECISION := random() * 2 * pi();
  v_lat    NUMERIC;
  v_lon    NUMERIC;
  v_obj    JSONB := '[]'::JSONB;
BEGIN
  INSERT INTO public.pilot_ratings (company_id, user_id, rating, label, wing)
  VALUES (_company_id, _user_id, _rating, _label, _wing)
  ON CONFLICT (company_id, user_id, rating) DO NOTHING;

  SELECT passed_at INTO v_passed FROM public.pilot_ratings
   WHERE company_id = _company_id AND user_id = _user_id AND rating = _rating;
  IF v_passed IS NOT NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.missions
              WHERE company_id = _company_id AND role = 'rating_ride'
                AND assigned_pilot_id = _user_id AND scene_name = _rating
                AND status IN ('available', 'in_progress')) THEN
    RETURN;
  END IF;

  SELECT * INTO v_base FROM public.bases
   WHERE company_id = _company_id
   ORDER BY (latitude IS NOT NULL) DESC, is_primary DESC, created_at
   LIMIT 1;
  SELECT COALESCE(NULLIF(cm.callsign, ''), p.display_name, 'pilot') INTO v_name
    FROM public.company_members cm
    LEFT JOIN public.profiles p ON p.id = cm.user_id
   WHERE cm.company_id = _company_id AND cm.user_id = _user_id;

  IF v_base.latitude IS NOT NULL THEN
    v_lat := v_base.latitude + (v_nm / 60.0) * cos(v_brg)::NUMERIC;
    v_lon := v_base.longitude + (v_nm / 60.0) * sin(v_brg)::NUMERIC
             / GREATEST(0.01, cos(radians(v_base.latitude::DOUBLE PRECISION)))::NUMERIC;
  END IF;

  IF NOT v_fixed THEN
    v_obj := v_obj || jsonb_build_array(jsonb_build_object(
      'id', 'hover', 'kind', 'hover', 'label', 'Hold a hover below 50 ft AGL for 30 seconds',
      'max_agl_ft', 50, 'max_gs_kts', 10, 'hold_seconds', 30));
  END IF;
  IF v_lat IS NOT NULL THEN
    v_obj := v_obj || jsonb_build_array(jsonb_build_object(
      'id', 'reach', 'kind', 'reach', 'label', format('Fly to the check point %s nm out', v_nm),
      'lat', ROUND(v_lat, 5), 'lon', ROUND(v_lon, 5),
      'radius_nm', CASE WHEN v_fixed THEN 1.0 ELSE 0.6 END));
  END IF;
  v_obj := v_obj || jsonb_build_array(jsonb_build_object(
    'id', 'return', 'kind', 'land', 'label', format('Land back at %s', COALESCE(v_base.icao, 'base')),
    'icao', v_base.icao, 'radius_nm', CASE WHEN v_fixed THEN 2 ELSE 1.5 END));

  INSERT INTO public.missions (
    company_id, role, title, description, origin, destination, distance_nm,
    required_tags, required_certs, min_payload, payout, difficulty, weather_factor,
    scene_lat, scene_lon, scene_type, scene_name, status, objectives, assigned_pilot_id
  ) VALUES (
    _company_id, 'rating_ride',
    CASE WHEN _rating = 'checkout'
         THEN format('Company Check Ride — %s', v_name)
         ELSE format('Type Rating — %s (%s)', _label, v_name) END,
    CASE WHEN _rating = 'checkout'
         THEN format('%s has to pass a check ride before taking contracts. Fly it in any company aircraft.', v_name)
         ELSE format('%s has to be rated on the %s before flying one. Fly it in a %s.', v_name, _label, _label) END
      || ' Every step done and a flight score of 60 or better to pass; a failed ride goes back on the board.',
    v_base.icao, v_base.icao, GREATEST(2, ROUND(v_nm * 2)),
    ARRAY[]::TEXT[], ARRAY[]::TEXT[], 0, 0, 2, 1,
    ROUND(v_lat, 5), ROUND(v_lon, 5),
    -- The bridge stages nothing for either; 'airport' files it with the aeroplane work.
    CASE WHEN v_fixed THEN 'airport' ELSE 'checkride' END,
    _rating, 'available', v_obj, _user_id
  );
END;$fn$;

-- Every ride a member is missing: the company check ride and each type in the fleet.
CREATE OR REPLACE FUNCTION public.book_member_rating_rides(_company_id UUID, _user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_type RECORD;
  v_wing TEXT;
BEGIN
  IF COALESCE((SELECT role FROM public.company_members
                WHERE company_id = _company_id AND user_id = _user_id), 'owner') = 'owner' THEN
    RETURN;
  END IF;

  -- The company check ride is a helicopter ride unless the fleet is all aeroplanes.
  SELECT CASE WHEN COUNT(*) > 0 AND bool_and(ri.wing = 'fixed') THEN 'fixed' ELSE 'rotary' END
    INTO v_wing
    FROM public.aircraft a
    CROSS JOIN LATERAL public.rating_info(a.internal_id, a.sim_title, a.display_name) ri
   WHERE a.company_id = _company_id AND a.status NOT IN ('sold', 'returned', 'destroyed');
  PERFORM public.book_rating_ride(_company_id, _user_id, 'checkout', 'Company check ride', v_wing);

  FOR v_type IN
    SELECT DISTINCT ON (ri.rating) ri.rating, ri.label, ri.wing
      FROM public.aircraft a
      CROSS JOIN LATERAL public.rating_info(a.internal_id, a.sim_title, a.display_name) ri
     WHERE a.company_id = _company_id AND a.status NOT IN ('sold', 'returned', 'destroyed')
     ORDER BY ri.rating
  LOOP
    PERFORM public.book_rating_ride(_company_id, _user_id, v_type.rating, v_type.label, v_type.wing);
  END LOOP;
END;$fn$;

REVOKE EXECUTE ON FUNCTION public.book_rating_ride(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.book_member_rating_rides(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Puts back any of your own rides that went missing. Idempotent; the Mission
-- Board calls it on load.
CREATE OR REPLACE FUNCTION public.ensure_my_rating_rides(_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;
  PERFORM public.book_member_rating_rides(_company_id, auth.uid());
END;$fn$;

GRANT EXECUTE ON FUNCTION public.ensure_my_rating_rides(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.ensure_my_rating_rides(UUID) FROM PUBLIC, anon;

-- --------------------------------------------------------------------------
-- Triggers: joining, role changes, leaving, and new aircraft.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rating_rides_on_member()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  PERFORM public.book_member_rating_rides(NEW.company_id, NEW.user_id);
  RETURN NEW;
END;$fn$;

DROP TRIGGER IF EXISTS rating_rides_on_member ON public.company_members;
CREATE TRIGGER rating_rides_on_member
  AFTER INSERT OR UPDATE OF role ON public.company_members
  FOR EACH ROW WHEN (NEW.role <> 'owner')
  EXECUTE FUNCTION public.rating_rides_on_member();

CREATE OR REPLACE FUNCTION public.rating_rides_on_leave()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- When the whole company is being deleted, everything below is going too.
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id) THEN
    RETURN OLD;
  END IF;
  UPDATE public.aircraft SET status = 'available'
   WHERE status = 'on_mission'
     AND id IN (SELECT aircraft_id FROM public.missions
                 WHERE company_id = OLD.company_id AND role = 'rating_ride'
                   AND assigned_pilot_id = OLD.user_id AND status = 'in_progress');
  DELETE FROM public.missions
   WHERE company_id = OLD.company_id AND role = 'rating_ride'
     AND assigned_pilot_id = OLD.user_id AND status IN ('available', 'in_progress');
  DELETE FROM public.pilot_ratings
   WHERE company_id = OLD.company_id AND user_id = OLD.user_id;
  RETURN OLD;
END;$fn$;

DROP TRIGGER IF EXISTS rating_rides_on_leave ON public.company_members;
CREATE TRIGGER rating_rides_on_leave
  AFTER DELETE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.rating_rides_on_leave();

CREATE OR REPLACE FUNCTION public.rating_rides_on_aircraft()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_info   RECORD;
  v_member RECORD;
BEGIN
  SELECT * INTO v_info FROM public.rating_info(NEW.internal_id, NEW.sim_title, NEW.display_name);
  FOR v_member IN
    SELECT user_id FROM public.company_members
     WHERE company_id = NEW.company_id AND role <> 'owner'
  LOOP
    PERFORM public.book_rating_ride(NEW.company_id, v_member.user_id,
                                    v_info.rating, v_info.label, v_info.wing);
  END LOOP;
  RETURN NEW;
END;$fn$;

DROP TRIGGER IF EXISTS rating_rides_on_aircraft ON public.aircraft;
CREATE TRIGGER rating_rides_on_aircraft
  AFTER INSERT ON public.aircraft
  FOR EACH ROW EXECUTE FUNCTION public.rating_rides_on_aircraft();

-- --------------------------------------------------------------------------
-- Dispatch enforces it.
-- Carried forward from 20260918000000_industry_flow.sql.
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_mission(_mission_id UUID, _aircraft_id UUID)
RETURNS public.missions
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_m     public.missions%ROWTYPE;
  v_from  public.industries%ROWTYPE;
  v_def   public.industry_defs%ROWTYPE;
  v_units NUMERIC;
  v_ac    public.aircraft%ROWTYPE;
  v_info  RECORD;
  v_rate  public.pilot_ratings%ROWTYPE;
  v_cash  NUMERIC;
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

  -- A check ride is only ever flown by the pilot it was booked for.
  IF v_m.role = 'rating_ride' AND v_m.assigned_pilot_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'this check ride is booked for another pilot';
  END IF;

  -- Check rides. The owner is exempt. Everyone else has to pass the company
  -- check ride before taking contracts, and be rated on an aircraft's type
  -- before flying it.
  IF COALESCE(public.company_role(v_m.company_id), '') <> 'owner' THEN
    SELECT * INTO v_ac FROM public.aircraft WHERE id = _aircraft_id;
    SELECT * INTO v_info FROM public.rating_info(v_ac.internal_id, v_ac.sim_title, v_ac.display_name);

    IF v_m.role = 'rating_ride' THEN
      SELECT * INTO v_rate FROM public.pilot_ratings
       WHERE company_id = v_m.company_id AND user_id = auth.uid() AND rating = v_m.scene_name
       FOR UPDATE;
      IF v_m.scene_name <> 'checkout' AND v_m.scene_name <> v_info.rating THEN
        RAISE EXCEPTION 'this check ride has to be flown in a %', COALESCE(v_rate.label, v_m.scene_name);
      END IF;
      -- The examiner is paid once per rating, on the first dispatch; a retake
      -- is free. Charged here rather than when booked, because rides are booked
      -- automatically -- on joining, on a purchase -- when the cash may not be there.
      IF v_rate.rating IS NOT NULL AND NOT v_rate.fee_paid THEN
        SELECT cash INTO v_cash FROM public.companies WHERE id = v_m.company_id FOR UPDATE;
        IF v_cash < 1000 THEN
          RAISE EXCEPTION 'the company needs $1,000 for the examiner';
        END IF;
        UPDATE public.companies SET cash = cash - 1000 WHERE id = v_m.company_id;
        INSERT INTO public.economy_transactions (company_id, type, amount, description)
        VALUES (v_m.company_id, 'checkride_fee', -1000, format('Examiner fee: %s', v_m.title));
        UPDATE public.pilot_ratings SET fee_paid = true
         WHERE company_id = v_m.company_id AND user_id = auth.uid() AND rating = v_m.scene_name;
      END IF;
    ELSE
      IF NOT EXISTS (SELECT 1 FROM public.pilot_ratings
                      WHERE company_id = v_m.company_id AND user_id = auth.uid()
                        AND rating = 'checkout' AND passed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'pass your company check ride before taking contracts -- it''s on the Mission Board';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.pilot_ratings
                      WHERE company_id = v_m.company_id AND user_id = auth.uid()
                        AND rating = v_info.rating AND passed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'you aren''t rated on the % yet -- fly its check ride on the Mission Board first',
          v_info.label;
      END IF;
    END IF;
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
-- Cancelling a check ride keeps it booked for its pilot.
-- Carried forward from 20260918000000_industry_flow.sql.
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
         -- A check ride stays booked for its pilot.
         assigned_pilot_id = CASE WHEN role = 'rating_ride' THEN assigned_pilot_id END,
         objectives_state = '{}'::JSONB
   WHERE id = _mission_id RETURNING * INTO v_m;
  RETURN v_m;
END;$fn$;

-- --------------------------------------------------------------------------
-- Resolution: pass on every objective and a score of 60; retake on a fail.
-- Carried forward from 20260918000000_industry_flow.sql.
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
  v_rating_ride    BOOLEAN;
  v_rating_passed  BOOLEAN := false;
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
    'rating_passed', v_rating_passed
  );
END;$fn$;

REVOKE EXECUTE ON FUNCTION
  public.rotorops_resolve_flight(UUID, UUID, UUID, JSONB, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;

-- --------------------------------------------------------------------------
-- Everyone already in a company except the owner flies them too.
-- --------------------------------------------------------------------------
DO $do$
DECLARE v RECORD;
BEGIN
  FOR v IN SELECT company_id, user_id FROM public.company_members WHERE role <> 'owner' LOOP
    PERFORM public.book_member_rating_rides(v.company_id, v.user_id);
  END LOOP;
END $do$;
