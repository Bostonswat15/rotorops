-- =============================================================================
-- Deleting a company.
--
-- Every table a company owns already cascades from companies, and the triggers
-- that fire on those deletes (fuel run and haul refunds, check-ride cleanup when
-- a member leaves) skip once the company row is gone. What was missing:
--
--   - A safe way in. The "company delete" policy let an owner delete the row
--     straight from the client: no confirmation, and nothing stopping it
--     mid-flight. Deletion now only goes through delete_company().
--   - Paired bridges. sim_devices cascades from the company it was paired to,
--     but since 20260920 a device flies for whichever company its owner has
--     open. A member who belongs to another company keeps their device, moved
--     to that company; only a device whose owner has nowhere else goes.
--
-- Re-runnable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.delete_company(_company_id UUID, _confirm_name TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_co       public.companies%ROWTYPE;
  v_flying   TEXT;
  v_members  INTEGER;
  v_unlinked INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not signed in'; END IF;

  SELECT * INTO v_co FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company not found'; END IF;
  IF NOT public.is_company_owner(_company_id) THEN
    RAISE EXCEPTION 'only the owner can delete a company';
  END IF;
  IF lower(trim(coalesce(_confirm_name, ''))) <> lower(trim(v_co.name)) THEN
    RAISE EXCEPTION 'type the company name to confirm';
  END IF;

  -- Someone may be in the air with it. Their flight would have nowhere to land.
  SELECT title INTO v_flying FROM public.missions
   WHERE company_id = _company_id AND status = 'in_progress'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '"%" is dispatched. Finish or cancel every flight before deleting the company.',
      v_flying;
  END IF;

  SELECT count(*) - 1 INTO v_members
    FROM public.company_members WHERE company_id = _company_id;

  -- A bridge belongs to a person. Move each one to its owner's oldest other
  -- company, so the cascade below only takes devices with nowhere else to go.
  UPDATE public.sim_devices d
     SET company_id = o.company_id
    FROM (SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.company_id
            FROM public.company_members cm
           WHERE cm.company_id <> _company_id
           ORDER BY cm.user_id, cm.joined_at) o
   WHERE d.company_id = _company_id
     AND d.user_id = o.user_id;

  SELECT count(*) INTO v_unlinked
    FROM public.sim_devices
   WHERE company_id = _company_id
     AND user_id = auth.uid()
     AND token_hash IS NOT NULL
     AND revoked_at IS NULL;

  -- Fleet, bases, contracts, books, logs, skills, industries, fuel farms,
  -- loans, invites and memberships all cascade. Anyone who had it open falls
  -- back to their next company (profiles.active_company_id is SET NULL).
  DELETE FROM public.companies WHERE id = _company_id;

  RETURN jsonb_build_object(
    'deleted', v_co.name,
    'members_removed', GREATEST(v_members, 0),
    'bridges_unlinked', v_unlinked
  );
END;$fn$;

GRANT EXECUTE ON FUNCTION public.delete_company(UUID, TEXT) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_company(UUID, TEXT) FROM PUBLIC, anon;

-- The only way in is the function above.
DROP POLICY IF EXISTS "company delete" ON public.companies;
REVOKE DELETE ON public.companies FROM authenticated;
