-- =============================================================================
-- Which aircraft a transaction belongs to.
--
-- The Finance page can say what the company made, but not which airframe made
-- it: economy_transactions has never carried an aircraft. Adding the column is
-- the easy half. The hard half is filling it without rewriting the functions
-- that write transactions -- rotorops_resolve_flight alone is 250 lines, and a
-- CREATE OR REPLACE copied forward from a stale file has rolled functions back
-- before.
--
-- So nothing here touches those functions. Each of them writes its transaction
-- in the same database transaction as the row the money is about, and now() is
-- fixed for the length of a transaction, so the two share a timestamp exactly:
--
--   fuel, operating, lease, mission_payout   flight_logs.flown_at
--   maintenance                              maintenance_events.completed_at
--   aircraft_purchase, lease_deposit         aircraft.created_at
--   aircraft_sale                            aircraft.retired_at
--   lease_penalty                            aircraft.retired_at -- but
--                                            return_aircraft writes the penalty
--                                            *before* setting retired_at, so
--                                            that one is filled from the
--                                            aircraft side instead
--
-- A match only counts when it is unique; anything ambiguous stays NULL rather
-- than being pinned on the wrong airframe. Company-level money (certs,
-- industries, starting capital) has no aircraft and stays NULL by design.
--
-- Safe to re-run.
-- =============================================================================

ALTER TABLE public.economy_transactions
  ADD COLUMN IF NOT EXISTS aircraft_id UUID REFERENCES public.aircraft(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS economy_transactions_aircraft_idx
  ON public.economy_transactions (aircraft_id)
  WHERE aircraft_id IS NOT NULL;

-- The one aircraft a transaction belongs to, or NULL when there isn't exactly one.
CREATE OR REPLACE FUNCTION public.transaction_aircraft(
  _company_id UUID, _type TEXT, _at TIMESTAMPTZ)
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_ids UUID[];
BEGIN
  IF _type IN ('fuel', 'operating', 'lease', 'mission_payout') THEN
    SELECT array_agg(DISTINCT aircraft_id) INTO v_ids FROM public.flight_logs
     WHERE company_id = _company_id AND flown_at = _at;
  ELSIF _type = 'maintenance' THEN
    SELECT array_agg(DISTINCT aircraft_id) INTO v_ids FROM public.maintenance_events
     WHERE company_id = _company_id AND completed_at = _at;
  ELSIF _type IN ('aircraft_purchase', 'lease_deposit') THEN
    SELECT array_agg(id) INTO v_ids FROM public.aircraft
     WHERE company_id = _company_id AND created_at = _at;
  ELSIF _type IN ('aircraft_sale', 'lease_penalty') THEN
    SELECT array_agg(id) INTO v_ids FROM public.aircraft
     WHERE company_id = _company_id AND retired_at = _at;
  END IF;
  RETURN CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1] END;
END;$fn$;

-- New transactions: the row the money is about already exists (all but the
-- lease penalty), so look it up on the way in. Column defaults are applied
-- before BEFORE triggers run, so NEW.created_at is already now().
CREATE OR REPLACE FUNCTION public.fill_transaction_aircraft()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  IF NEW.aircraft_id IS NULL THEN
    NEW.aircraft_id := public.transaction_aircraft(NEW.company_id, NEW.type, NEW.created_at);
  END IF;
  RETURN NEW;
END;$fn$;

DROP TRIGGER IF EXISTS fill_transaction_aircraft ON public.economy_transactions;
CREATE TRIGGER fill_transaction_aircraft
  BEFORE INSERT ON public.economy_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fill_transaction_aircraft();

-- The lease penalty: written first, then the aircraft is retired. Catch it when
-- retired_at lands.
CREATE OR REPLACE FUNCTION public.fill_retirement_transactions()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  UPDATE public.economy_transactions
     SET aircraft_id = NEW.id
   WHERE company_id = NEW.company_id
     AND aircraft_id IS NULL
     AND type IN ('aircraft_sale', 'lease_penalty')
     AND created_at = NEW.retired_at
     AND public.transaction_aircraft(company_id, type, created_at) = NEW.id;
  RETURN NULL;
END;$fn$;

DROP TRIGGER IF EXISTS fill_retirement_transactions ON public.aircraft;
CREATE TRIGGER fill_retirement_transactions
  AFTER UPDATE OF retired_at ON public.aircraft
  FOR EACH ROW
  WHEN (NEW.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at)
  EXECUTE FUNCTION public.fill_retirement_transactions();

-- Internal plumbing: nobody should be able to probe other companies' aircraft
-- ids by guessing timestamps.
REVOKE EXECUTE ON FUNCTION public.transaction_aircraft(UUID, TEXT, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fill_transaction_aircraft() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fill_retirement_transactions() FROM PUBLIC, anon, authenticated;

-- History: the same timestamp match works for everything already in the ledger.
UPDATE public.economy_transactions t
   SET aircraft_id = public.transaction_aircraft(t.company_id, t.type, t.created_at)
 WHERE t.aircraft_id IS NULL
   AND t.type IN ('fuel', 'operating', 'lease', 'mission_payout', 'maintenance',
                  'aircraft_purchase', 'lease_deposit', 'aircraft_sale', 'lease_penalty');
