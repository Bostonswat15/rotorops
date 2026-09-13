-- =============================================================================
-- Several companies from one account.
--
-- Memberships in several companies already worked server-side (my_companies,
-- set_active_company), but the app gave no way to start or switch to another
-- once you had one, and the sim bridge stayed with whichever company its device
-- was paired to. Three changes:
--
--   1. bridge_device() answers with the company the device's owner is looking
--      at -- the same choice current_company() makes. Every bridge wrapper
--      (bridge_state, bridge_submit_flight, bridge_complete_objective,
--      bridge_set_base_position, bridge_set_base_airports) takes its company
--      from that row, so they all follow a switch with no re-pairing. An owner
--      who belongs to no company keeps the company the device was paired to.
--   2. create_pairing_code() pairs to that same company. It used to take the
--      first company you OWN, so a pilot flying only for someone else's company
--      could not pair a bridge at all.
--   3. Changing your active company -- switching, founding one, or joining one
--      -- is refused while you have a contract dispatched in another company.
--      The bridge would otherwise submit that flight against the new company.
--
-- Carried forward whole from 20260826120000_sim_bridge.sql: bridge_device,
-- create_pairing_code. Re-runnable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.bridge_device(_token TEXT)
RETURNS public.sim_devices
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_dev    public.sim_devices%ROWTYPE;
  v_active UUID;
BEGIN
  IF _token IS NULL OR length(_token) < 32 THEN
    RAISE EXCEPTION 'invalid device token';
  END IF;
  SELECT * INTO v_dev FROM public.sim_devices
    WHERE token_hash = encode(digest(_token, 'sha256'), 'hex')
      AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid device token'; END IF;

  -- Fly for the company the owner has open in the app: their active company
  -- while they still belong to it, else their oldest membership. Mirrors
  -- current_company(), which can't be called here -- auth.uid() is the
  -- anonymous bridge, not the device's owner.
  SELECT cm.company_id INTO v_active
    FROM public.company_members cm
   WHERE cm.user_id = v_dev.user_id
   ORDER BY (cm.company_id = (SELECT p.active_company_id
                                FROM public.profiles p
                               WHERE p.id = v_dev.user_id)) DESC NULLS LAST,
            cm.joined_at
   LIMIT 1;
  IF v_active IS NOT NULL THEN v_dev.company_id := v_active; END IF;

  RETURN v_dev;
END;$fn$;

REVOKE EXECUTE ON FUNCTION public.bridge_device(TEXT) FROM PUBLIC, anon, authenticated;

-- Issue a short pairing code for a new bridge install. Valid for 15 minutes.
CREATE OR REPLACE FUNCTION public.create_pairing_code(_name TEXT DEFAULT 'MSFS 2024 Bridge')
RETURNS TABLE (code TEXT, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  -- No 0/O/1/I: these get read aloud and retyped.
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_company UUID;
  v_code    TEXT := '';
  i INTEGER;
BEGIN
  -- The company open in the app, owned or not.
  v_company := (public.current_company()).id;
  IF v_company IS NULL THEN RAISE EXCEPTION 'create or join a company first'; END IF;

  FOR i IN 1..8 LOOP
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::INT, 1);
  END LOOP;

  -- Drop any unredeemed codes so only the newest is live.
  DELETE FROM public.sim_devices
    WHERE user_id = auth.uid() AND token_hash IS NULL;

  INSERT INTO public.sim_devices (user_id, company_id, name, pairing_code, pairing_expires_at)
  VALUES (auth.uid(), v_company, _name, v_code, now() + INTERVAL '15 minutes');

  RETURN QUERY SELECT v_code, now() + INTERVAL '15 minutes';
END;$fn$;

GRANT EXECUTE ON FUNCTION public.create_pairing_code(TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_pairing_code(TEXT) FROM PUBLIC, anon;

-- No switching away from a flight in progress. A trigger rather than a check in
-- each function, so set_active_company, create_company (via
-- handle_new_company) and join_company are all covered without carrying them.
CREATE OR REPLACE FUNCTION public.guard_active_company_switch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_title   TEXT;
  v_company TEXT;
BEGIN
  -- Cleared by a company being deleted, or not actually changing.
  IF NEW.active_company_id IS NULL
     OR NEW.active_company_id IS NOT DISTINCT FROM OLD.active_company_id THEN
    RETURN NEW;
  END IF;

  SELECT m.title, c.name INTO v_title, v_company
    FROM public.missions m
    JOIN public.companies c ON c.id = m.company_id
   WHERE m.assigned_pilot_id = NEW.id
     AND m.status = 'in_progress'
     AND m.company_id <> NEW.active_company_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'You have "%" dispatched for %. Finish or cancel it before switching companies.',
      v_title, v_company;
  END IF;

  RETURN NEW;
END;$fn$;

REVOKE EXECUTE ON FUNCTION public.guard_active_company_switch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_active_company_switch ON public.profiles;
CREATE TRIGGER guard_active_company_switch
  BEFORE UPDATE OF active_company_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_active_company_switch();
