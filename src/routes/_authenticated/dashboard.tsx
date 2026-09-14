import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Plane, Briefcase, BookOpen, TrendingUp, AlertTriangle, DollarSign, Star } from "lucide-react";
import { useLiveFlight } from "@/hooks/use-live-flight";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — RotorOps" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { flight } = useLiveFlight();


  const { data } = useQuery({
    queryKey: ["dashboard"],
    // A live flight means these cards are changing under you -- an aircraft
    // goes on contract, hours accrue, the payout lands. Idle otherwise.
    refetchInterval: flight ? 15000 : false,
    queryFn: async () => {
      const c = await fetchCurrentCompany();
      if (!c) return null;
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const me = u.user.id;
      // Company numbers (cash, fleet, maintenance, profit) are shared. Jobs,
      // flights and what's on contract are yours only -- another pilot's work
      // belongs on their own dashboard.
      const [aircraft, missions, logs, maint, txns, active, bases, trips] = await Promise.all([
        // Sold, returned and destroyed airframes stay in the table as
        // history -- a flight log has to keep pointing at the aircraft that
        // flew it. They are not the fleet, though, and counting them made
        // the dashboard report hours, wear and a fleet size for machines the
        // company no longer owns. Matches the Aircraft and Maintenance pages.
        supabase
          .from("aircraft")
          .select("*")
          .eq("company_id", c.id)
          .not("status", "in", "(sold,returned,destroyed)"),
        // Open jobs, plus any reserved for you -- not another pilot's check ride.
        supabase
          .from("missions")
          .select("*")
          .eq("company_id", c.id)
          .in("status", ["available", "accepted"])
          .is("manifest", null)
          .or(`assigned_pilot_id.is.null,assigned_pilot_id.eq.${me}`),
        supabase.from("flight_logs").select("*").eq("company_id", c.id).eq("pilot_id", me).order("flown_at", { ascending: false }).limit(5),
        supabase.from("maintenance_events").select("*").eq("company_id", c.id).eq("status", "in_progress"),
        supabase.from("economy_transactions").select("*").eq("company_id", c.id).gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString()),
        supabase.from("missions").select("*").eq("company_id", c.id).eq("status", "in_progress").eq("assigned_pilot_id", me).is("trip_id", null),
        supabase.from("bases").select("*").eq("company_id", c.id),
        supabase.from("trips").select("aircraft_id").eq("company_id", c.id).eq("status", "active").eq("pilot_id", me),
      ]);
      return {
        company: c,
        aircraft: aircraft.data ?? [],
        missions: missions.data ?? [],
        logs: logs.data ?? [],
        maint: maint.data ?? [],
        txns: txns.data ?? [],
        active: active.data ?? [],
        bases: bases.data ?? [],
        myAircraftIds: new Set<string>([
          ...(active.data ?? []).map((m) => m.aircraft_id).filter((id): id is string => !!id),
          ...(trips.data ?? []).map((t) => t.aircraft_id),
        ]),
      };
    },
  });

  if (!data) return <div className="p-8 text-muted-foreground">Loading operations data…</div>;

  const totalHours = data.aircraft.reduce((s: number, a: any) => s + Number(a.hours), 0);
  // An aircraft is either at base or out on a contract; there is no
  // maintenance status on the airframe itself, so "not available" only ever
  // means on_mission. Calling that grounded was wrong twice over: the
  // aircraft is working, and the rest of the list was disposed airframes.
  const onContract = data.aircraft.filter((a: any) => a.status === "on_mission");
  // The panel lists only what you're flying; the fleet count stays company-wide.
  const myOnContract = onContract.filter((a: any) => data.myAircraftIds.has(a.id));
  const weeklyProfit = data.txns.reduce((s: number, t: any) => s + Number(t.amount), 0);
  const alerts = data.aircraft.filter((a: any) => Number(a.wear) > 60);

  // The contract being flown right now, so the map can show where the job is.
  const activeMission = data.active[0] ?? null;
  return (
    <div className="space-y-6 p-6 md:p-8">
      {/*
        The live flight lives on its own page now. What stays here is the one
        thing about a flight that is a data problem rather than a map: a
        contract with no scene can never be tracked, and the In Flight page
        would show it as a normal flight with an objective list that never
        moves.
      */}
      {flight && activeMission && activeMission.scene_lat == null && (
        <p className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-sm text-warning">
          "{activeMission.title}" has no scene coordinates, so there is nothing to
          fly to and no objectives to track. It was generated before scene
          contracts existed — clear the board and generate a fresh batch.
        </p>
      )}

      <div>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">Operations overview</p>
        <h1 className="mt-1 text-3xl font-semibold">{data.company.name}</h1>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Stat icon={DollarSign} label="Cash" value={`$${Number(data.company.cash).toLocaleString()}`} tone="success" />
        <Stat icon={Star} label="Reputation" value={`${data.company.reputation}/100`} />
        <Stat icon={Plane} label="Fleet" value={`${data.aircraft.length - onContract.length}/${data.aircraft.length} avail.`} tone={onContract.length ? "warn" : undefined} />
        <Stat icon={BookOpen} label="Total Hours" value={totalHours.toFixed(1)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel icon={Briefcase} title="Today's jobs">
          {data.missions.length === 0 && <Empty cta={{ to: "/missions", label: "Generate missions" }} text="No active missions." />}
          {data.missions.slice(0, 5).map((m: any) => (
            <Link key={m.id} to="/missions" className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-accent">
              <div>
                <p className="text-sm font-medium">{m.title}</p>
                <p className="text-xs text-muted-foreground">{m.role} · {m.distance_nm}nm</p>
              </div>
              <span className="font-mono text-sm text-success">${Number(m.payout).toLocaleString()}</span>
            </Link>
          ))}
        </Panel>

        <Panel icon={Plane} title="Your aircraft on contract">
          {myOnContract.length === 0 && <Empty text="You have no aircraft out on a contract." />}
          {myOnContract.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between rounded-md px-3 py-2">
              <p className="text-sm">{a.display_name}</p>
              <span className="text-xs text-warning">on contract</span>
            </div>
          ))}
        </Panel>

        <Panel icon={AlertTriangle} title="Maintenance alerts">
          {alerts.length === 0 && <Empty text="Wear levels nominal." />}
          {alerts.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between rounded-md px-3 py-2">
              <p className="text-sm">{a.display_name}</p>
              <span className="text-xs font-mono text-warning">{Number(a.wear).toFixed(0)}% wear</span>
            </div>
          ))}
        </Panel>

        <Panel icon={BookOpen} title="Recent flights" wide>
          {data.logs.length === 0 && <Empty text="No logged flights yet." />}
          {data.logs.map((l: any) => (
            <div key={l.id} className="flex items-center justify-between rounded-md px-3 py-2 text-sm">
              <div>
                <p className="font-medium">{l.departure || "—"} → {l.arrival || "—"}</p>
                <p className="text-xs text-muted-foreground">{Number(l.duration_hr).toFixed(1)}h · landing: {l.landing_quality}</p>
              </div>
              <span className={l.success ? "text-success text-xs" : "text-destructive text-xs"}>
                {l.success ? "completed" : "failed"}
              </span>
            </div>
          ))}
        </Panel>

        <Panel icon={TrendingUp} title="Profit this week">
          <div className="px-3 py-4">
            <p className={`font-mono text-3xl font-semibold ${weeklyProfit >= 0 ? "text-success" : "text-destructive"}`}>
              {weeklyProfit >= 0 ? "+" : ""}${Math.abs(weeklyProfit).toLocaleString()}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">{data.txns.length} transactions in last 7 days</p>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, tone }: { icon: any; label: string; value: string; tone?: "success" | "warn" }) {
  const color = tone === "success" ? "text-success" : tone === "warn" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className={`mt-2 font-mono text-2xl font-semibold ${color}`}>{value}</p>
    </div>
  );
}

function Panel({ icon: Icon, title, children, wide }: { icon: any; title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`rounded-lg border border-border bg-card p-4 ${wide ? "lg:col-span-2" : ""}`}>
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Empty({ text, cta }: { text: string; cta?: { to: string; label: string } }) {
  return (
    <div className="px-3 py-4 text-sm text-muted-foreground">
      {text}
      {cta && (
        <Link to={cta.to as any} className="ml-2 text-primary hover:underline">
          {cta.label} →
        </Link>
      )}
    </div>
  );
}
