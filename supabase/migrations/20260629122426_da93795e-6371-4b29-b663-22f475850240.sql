
-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);

-- Auto create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name) VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)));
  RETURN NEW;
END;$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Companies
CREATE TABLE public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cash NUMERIC NOT NULL DEFAULT 250000,
  reputation INTEGER NOT NULL DEFAULT 50,
  realism_mode TEXT NOT NULL DEFAULT 'balanced',
  difficulty TEXT NOT NULL DEFAULT 'normal',
  certifications TEXT[] NOT NULL DEFAULT ARRAY['basic_utility','training'],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own company all" ON public.companies FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Helper: does user own company?
CREATE OR REPLACE FUNCTION public.owns_company(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.companies WHERE id = _company_id AND user_id = auth.uid());
$$;

-- Bases
CREATE TABLE public.bases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icao TEXT,
  region TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bases TO authenticated;
GRANT ALL ON public.bases TO service_role;
ALTER TABLE public.bases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own bases all" ON public.bases FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Aircraft
CREATE TABLE public.aircraft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  base_id UUID REFERENCES public.bases(id) ON DELETE SET NULL,
  internal_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sim_title TEXT,
  category TEXT NOT NULL DEFAULT 'light_utility',
  engine_type TEXT NOT NULL DEFAULT 'turbine',
  cruise_kts INTEGER NOT NULL DEFAULT 110,
  max_range_nm INTEGER NOT NULL DEFAULT 300,
  fuel_burn_pph INTEGER NOT NULL DEFAULT 400,
  payload_lbs INTEGER NOT NULL DEFAULT 1500,
  pax_seats INTEGER NOT NULL DEFAULT 4,
  sling_load BOOLEAN NOT NULL DEFAULT false,
  hoist BOOLEAN NOT NULL DEFAULT false,
  footprint TEXT NOT NULL DEFAULT 'medium',
  reliability INTEGER NOT NULL DEFAULT 80,
  maintenance_factor NUMERIC NOT NULL DEFAULT 1.0,
  acquisition_cost NUMERIC NOT NULL DEFAULT 500000,
  lease_cost NUMERIC NOT NULL DEFAULT 0,
  op_cost_hr NUMERIC NOT NULL DEFAULT 600,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  hours NUMERIC NOT NULL DEFAULT 0,
  wear NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  is_modded BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.aircraft TO authenticated;
GRANT ALL ON public.aircraft TO service_role;
ALTER TABLE public.aircraft ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own aircraft all" ON public.aircraft FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Missions
CREATE TABLE public.missions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id UUID REFERENCES public.aircraft(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  origin TEXT,
  destination TEXT,
  distance_nm INTEGER NOT NULL DEFAULT 50,
  required_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  required_certs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  min_payload INTEGER NOT NULL DEFAULT 0,
  payout NUMERIC NOT NULL DEFAULT 1000,
  difficulty INTEGER NOT NULL DEFAULT 1,
  weather_factor INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'available',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.missions TO authenticated;
GRANT ALL ON public.missions TO service_role;
ALTER TABLE public.missions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own missions all" ON public.missions FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Flight Logs
CREATE TABLE public.flight_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id UUID NOT NULL REFERENCES public.aircraft(id) ON DELETE CASCADE,
  mission_id UUID REFERENCES public.missions(id) ON DELETE SET NULL,
  departure TEXT,
  arrival TEXT,
  duration_hr NUMERIC NOT NULL DEFAULT 1,
  fuel_used NUMERIC NOT NULL DEFAULT 0,
  payload INTEGER NOT NULL DEFAULT 0,
  landing_quality TEXT NOT NULL DEFAULT 'normal',
  incidents TEXT,
  weather_difficulty INTEGER NOT NULL DEFAULT 1,
  success BOOLEAN NOT NULL DEFAULT true,
  flown_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flight_logs TO authenticated;
GRANT ALL ON public.flight_logs TO service_role;
ALTER TABLE public.flight_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own logs all" ON public.flight_logs FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Maintenance Events
CREATE TABLE public.maintenance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  aircraft_id UUID NOT NULL REFERENCES public.aircraft(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT,
  cost NUMERIC NOT NULL DEFAULT 0,
  wear_removed NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maintenance_events TO authenticated;
GRANT ALL ON public.maintenance_events TO service_role;
ALTER TABLE public.maintenance_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own maint all" ON public.maintenance_events FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

-- Economy
CREATE TABLE public.economy_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.economy_transactions TO authenticated;
GRANT ALL ON public.economy_transactions TO service_role;
ALTER TABLE public.economy_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own econ all" ON public.economy_transactions FOR ALL TO authenticated USING (public.owns_company(company_id)) WITH CHECK (public.owns_company(company_id));

CREATE INDEX ON public.aircraft(company_id);
CREATE INDEX ON public.missions(company_id, status);
CREATE INDEX ON public.flight_logs(company_id, flown_at DESC);
CREATE INDEX ON public.maintenance_events(aircraft_id);
CREATE INDEX ON public.economy_transactions(company_id, created_at DESC);
