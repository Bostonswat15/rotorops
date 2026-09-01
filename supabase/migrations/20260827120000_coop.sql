-- =============================================================================
-- Co-op: one company, many pilots.
--
-- The schema was single-owner throughout -- `companies.user_id` plus an
-- `owns_company()` check on every policy. This replaces that with membership
-- and roles:
--
--   owner    runs the company, manages the roster, can delete it
--   manager  spends money: aircraft, certifications, maintenance, contracts
--   pilot    claims contracts and flies them
--
-- Two consequences drive most of what follows:
--   1. Anything that moves cash has to leave the browser. With more than one
--      member, a client-side `UPDATE companies SET cash` is a permission hole,
--      so purchases/maintenance/certs become SECURITY DEFINER functions.
--   2. Flights need attribution, so logs and contracts carry a pilot.
-- =============================================================================

-- --------------------------------------------------------------------------
-- Membership
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.company_members (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'pilot' CHECK (role IN ('owner', 'manager', 'pilot')),
  callsign   TEXT,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

GRANT SELECT ON public.company_members TO authenticated;
GRANT ALL ON public.company_members TO service_role;
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS company_members_user_idx ON public.company_members(user_id);

-- Existing companies: the founder becomes the owner.
INSERT INTO public.company_members (company_id, user_id, role)
SELECT id, user_id, 'owner' FROM public.companies
ON CONFLICT (company_id, user_id) DO NOTHING;

-- Keep membership in step when a company is created by the app.
CREATE OR REPLACE FUNCTION public.handle_new_company()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (NEW.id, NEW.user_id, 'owner')
  ON CONFLICT (company_id, user_id) DO NOTHING;
  -- Founding a company makes it the one you're looking at.
  UPDATE public.profiles SET active_company_id = NEW.id WHERE id = NEW.user_id;
  RETURN NEW;
END;$fn$;

-- --------------------------------------------------------------------------
-- Which company am I looking at?
--
-- A player can own one company and fly for a friend's, so "the" company is no
-- longer implied by the user. Every screen reads through current_company().
-- --------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS active_company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- Role helpers.
--
-- SECURITY DEFINER matters here: these are called from company_members' own
-- policies, and without it the policy would recurse into itself.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.company_role(_company_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT role FROM public.company_members
   WHERE company_id = _company_id AND user_id = auth.uid();
$fn$;

CREATE OR REPLACE FUNCTION public.is_company_member(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.company_members
                  WHERE company_id = _company_id AND user_id = auth.uid());
$fn$;

CREATE OR REPLACE FUNCTION public.can_manage_company(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.company_role(_company_id) IN ('owner', 'manager');
$fn$;

CREATE OR REPLACE FUNCTION public.is_company_owner(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.company_role(_company_id) = 'owner';
$fn$;

-- Retained because the earlier migration's policies referenced it. Now means
-- "is a member"; anything that needs authority calls can_manage_company().
CREATE OR REPLACE FUNCTION public.owns_company(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.is_company_member(_company_id);
$fn$;

REVOKE EXECUTE ON FUNCTION public.company_role(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_company_member(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_company(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_company_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_role(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_company(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_owner(UUID) TO authenticated;

DROP TRIGGER IF EXISTS on_company_created ON public.companies;
CREATE TRIGGER on_company_created
  AFTER INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_company();

-- --------------------------------------------------------------------------
-- Pilot attribution
-- --------------------------------------------------------------------------

ALTER TABLE public.flight_logs
  ADD COLUMN IF NOT EXISTS pilot_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.missions
  ADD COLUMN IF NOT EXISTS assigned_pilot_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS flight_logs_pilot_idx ON public.flight_logs(company_id, pilot_id);

-- --------------------------------------------------------------------------
-- Row-level security, rewritten.
--
-- Read is company-wide: every member sees the same books. Write authority is
-- role-gated, and anything touching cash is routed through a function instead
-- of being granted at all.
-- --------------------------------------------------------------------------

DROP POLICY IF EXISTS "own company all" ON public.companies;
DROP POLICY IF EXISTS "own bases all" ON public.bases;
DROP POLICY IF EXISTS "own aircraft all" ON public.aircraft;
DROP POLICY IF EXISTS "own missions all" ON public.missions;
DROP POLICY IF EXISTS "own logs all" ON public.flight_logs;
DROP POLICY IF EXISTS "own maint all" ON public.maintenance_events;
DROP POLICY IF EXISTS "own econ all" ON public.economy_transactions;

-- companies -----------------------------------------------------------------
CREATE POLICY "company read" ON public.companies
  FOR SELECT TO authenticated USING (public.is_company_member(id));
CREATE POLICY "company create" ON public.companies
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
-- Cash and reputation are not writable from a client; settings are.
CREATE POLICY "company settings" ON public.companies
  FOR UPDATE TO authenticated
  USING (public.can_manage_company(id)) WITH CHECK (public.can_manage_company(id));
CREATE POLICY "company delete" ON public.companies
  FOR DELETE TO authenticated USING (public.is_company_owner(id));

-- company_members -----------------------------------------------------------
CREATE POLICY "roster read" ON public.company_members
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

-- bases ---------------------------------------------------------------------
CREATE POLICY "bases read" ON public.bases
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "bases write" ON public.bases
  FOR ALL TO authenticated
  USING (public.can_manage_company(company_id))
  WITH CHECK (public.can_manage_company(company_id));

-- aircraft ------------------------------------------------------------------
CREATE POLICY "aircraft read" ON public.aircraft
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "aircraft manage" ON public.aircraft
  FOR UPDATE TO authenticated
  USING (public.can_manage_company(company_id))
  WITH CHECK (public.can_manage_company(company_id));
CREATE POLICY "aircraft retire" ON public.aircraft
  FOR DELETE TO authenticated USING (public.can_manage_company(company_id));
-- INSERT is deliberately absent: buying goes through purchase_aircraft().

-- missions ------------------------------------------------------------------
CREATE POLICY "missions read" ON public.missions
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "missions generate" ON public.missions
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_company(company_id));
CREATE POLICY "missions clear" ON public.missions
  FOR DELETE TO authenticated USING (public.can_manage_company(company_id));
-- UPDATE is absent: dispatch and resolution go through functions.

-- flight_logs, maintenance_events, economy_transactions ---------------------
-- Read-only to clients. Every write is a function that also moves money.
CREATE POLICY "logs read" ON public.flight_logs
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "maint read" ON public.maintenance_events
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "econ read" ON public.economy_transactions
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

REVOKE INSERT, UPDATE, DELETE ON public.flight_logs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.maintenance_events FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.economy_transactions FROM authenticated;
REVOKE INSERT ON public.aircraft FROM authenticated;

-- sim_devices ---------------------------------------------------------------
-- A device belongs to a person, not the company, so this stays user-scoped.

-- --------------------------------------------------------------------------
-- Invites
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.company_invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'pilot' CHECK (role IN ('manager', 'pilot')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses   INTEGER NOT NULL DEFAULT 1,
  uses       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON public.company_invites TO authenticated;
GRANT ALL ON public.company_invites TO service_role;
ALTER TABLE public.company_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invites read" ON public.company_invites
  FOR SELECT TO authenticated USING (public.can_manage_company(company_id));

CREATE OR REPLACE FUNCTION public.create_invite(
  _company_id UUID, _role TEXT DEFAULT 'pilot', _max_uses INTEGER DEFAULT 1)
RETURNS public.company_invites
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $fn$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code TEXT := '';
  v_row  public.company_invites%ROWTYPE;
  i INTEGER;
BEGIN
  IF NOT public.can_manage_company(_company_id) THEN
    RAISE EXCEPTION 'only owners and managers can invite';
  END IF;
  IF _role NOT IN ('manager', 'pilot') THEN
    RAISE EXCEPTION 'invalid role: %', _role;
  END IF;
  -- Only an owner can hand out authority over the treasury.
  IF _role = 'manager' AND NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can invite managers';
  END IF;

  FOR i IN 1..8 LOOP
    v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::INT, 1);
  END LOOP;

  INSERT INTO public.company_invites (company_id, code, role, created_by, expires_at, max_uses)
  VALUES (_company_id, v_code, _role, auth.uid(), now() + INTERVAL '7 days',
          GREATEST(1, LEAST(_max_uses, 50)))
  RETURNING * INTO v_row;
  RETURN v_row;
END;$fn$;

CREATE OR REPLACE FUNCTION public.revoke_invite(_invite_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_company UUID;
BEGIN
  SELECT company_id INTO v_company FROM public.company_invites WHERE id = _invite_id;
  IF v_company IS NULL OR NOT public.can_manage_company(v_company) THEN
    RAISE EXCEPTION 'invite not found';
  END IF;
  DELETE FROM public.company_invites WHERE id = _invite_id;
END;$fn$;

CREATE OR REPLACE FUNCTION public.join_company(_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_inv  public.company_invites%ROWTYPE;
  v_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;

  SELECT * INTO v_inv FROM public.company_invites
    WHERE code = upper(trim(_code)) AND expires_at > now() AND uses < max_uses
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invite code invalid, expired, or fully used'; END IF;

  IF EXISTS (SELECT 1 FROM public.company_members
              WHERE company_id = v_inv.company_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'you are already a member of this company';
  END IF;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_inv.company_id, auth.uid(), v_inv.role);

  UPDATE public.company_invites SET uses = uses + 1 WHERE id = v_inv.id;
  UPDATE public.profiles SET active_company_id = v_inv.company_id WHERE id = auth.uid();

  SELECT name INTO v_name FROM public.companies WHERE id = v_inv.company_id;
  RETURN jsonb_build_object(
    'company_id', v_inv.company_id, 'company_name', v_name, 'role', v_inv.role);
END;$fn$;

-- Roster management ---------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_member_role(
  _company_id UUID, _user_id UUID, _role TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can change roles';
  END IF;
  IF _role NOT IN ('owner', 'manager', 'pilot') THEN
    RAISE EXCEPTION 'invalid role: %', _role;
  END IF;
  IF _user_id = auth.uid() AND _role <> 'owner' THEN
    RAISE EXCEPTION 'transfer ownership before demoting yourself';
  END IF;

  UPDATE public.company_members SET role = _role
   WHERE company_id = _company_id AND user_id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'not a member of this company'; END IF;

  -- One owner at a time: promoting someone hands over the company.
  IF _role = 'owner' THEN
    UPDATE public.company_members SET role = 'manager'
     WHERE company_id = _company_id AND user_id = auth.uid();
    UPDATE public.companies SET user_id = _user_id WHERE id = _company_id;
  END IF;
END;$fn$;

CREATE OR REPLACE FUNCTION public.remove_member(_company_id UUID, _user_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- Anyone may leave; only the owner may remove someone else.
  IF _user_id <> auth.uid() AND NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can remove members';
  END IF;
  IF public.company_role(_company_id) = 'owner' AND _user_id = auth.uid() THEN
    RAISE EXCEPTION 'transfer ownership before leaving';
  END IF;

  DELETE FROM public.company_members
   WHERE company_id = _company_id AND user_id = _user_id;
  UPDATE public.profiles SET active_company_id = NULL
   WHERE id = _user_id AND active_company_id = _company_id;
END;$fn$;

CREATE OR REPLACE FUNCTION public.set_active_company(_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'not a member of this company';
  END IF;
  UPDATE public.profiles SET active_company_id = _company_id WHERE id = auth.uid();
END;$fn$;

GRANT EXECUTE ON FUNCTION public.create_invite(UUID, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invite(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_company(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_member_role(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_active_company(UUID) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_invite(UUID, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.revoke_invite(UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.join_company(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_member_role(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.remove_member(UUID, UUID) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.set_active_company(UUID) FROM PUBLIC, anon;
