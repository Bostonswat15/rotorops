import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Plane, Briefcase, BookOpen, TrendingUp, AlertTriangle, DollarSign, Star } from "lucide-react";
import { FlightMap } from "@/components/flight-map";
import { useLiveFlight, useBridgeObjectives } from "@/hooks/use-live-flight";
import { searchAreaOf } from "@/lib/missions";
import { useState, useEffect } from "react";
import { desktop, type BridgeStatus } from "@/lib/desktop";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — RotorOps" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { flight, track, isDesktop } = useLiveFlight();
  const objectives = useBridgeObjectives();
  const [simAircraft, setSimAircraft] = useState<BridgeStatus["simAircraft"]>(null);

  // Only needed to explain why objectives are not arming, so it rides along
  // with the status stream rather than getting its own poll.
  useEffect(() => {
    const app = desktop();
    if (!app) return;
    let live = true;
    app.status().then((st) => live && setSimAircraft(st?.simAircraft ?? null)).catch(() => {});
    const off = app.onStatus((st) => live && setSimAircraft(st?.simAircraft ?? null));
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const { data } = useQuery({
    queryKey: ["dashboard"],
    // While a flight is live the map wants fresh scene data to draw against.
    refetchInterval: flight ? 15000 : false,
    queryFn: async () => {
      const c = await fetchCurrentCompany();
      if (!c) return null;
      const [aircraft, missions, logs, maint, txns, active, bases] = await Promise.all([
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
        supabase.from("missions").select("*").eq("company_id", c.id).in("status", ["available", "accepted"]),
        supabase.from("flight_logs").select("*").eq("company_id", c.id).order("flown_at", { ascending: false }).limit(5),
        supabase.from("maintenance_events").select("*").eq("company_id", c.id).eq("status", "in_progress"),
        supabase.from("economy_transactions").select("*").eq("company_id", c.id).gte("created_at", new Date(Date.now() - 7 * 86400000).toISOString()),
        supabase.from("missions").select("*").eq("company_id", c.id).eq("status", "in_progress"),
        supabase.from("bases").select("*").eq("company_id", c.id),
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
  const weeklyProfit = data.txns.reduce((s: number, t: any) => s + Number(t.amount), 0);
  const alerts = data.aircraft.filter((a: any) => Number(a.wear) > 60);

  // The contract being flown right now, so the map can show where the job is.
  const activeMission = data.active[0] ?? null;
  const homeBase = data.bases.find((b: any) => b.latitude != null && b.longitude != null) ?? null;
  // Public half of a SAR tasking: where they were last seen, and how far they
  // could have got. Never where they are.
  const searchArea = activeMission ? searchAreaOf(activeMission.objectives) : null;
  const sceneRange =
    flight && activeMission?.scene_lat != null
      ? nmBetween(flight.lat, flight.lon, Number(activeMission.scene_lat), Number(activeMission.scene_lon))
      : null;

  // Every objective that has a place on the map, married up with whether the
  // bridge has ticked it. Drawn so a multi-point contract shows all of its
  // points and how close counts as reaching one -- a line patrol previously
  // drew only its first point, with no radius anywhere.
  const mapWaypoints = (() => {
    const raw = activeMission?.objectives;
    if (!Array.isArray(raw)) return [];
    const doneById = new Map<string, boolean>(
      (objectives?.items ?? []).map((o) => [o.id, !!o.done] as [string, boolean]),
    );
    return raw
      .map((o: any) => {
        const lat = Number(o?.lat ?? o?.datum_lat);
        const lon = Number(o?.lon ?? o?.datum_lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          id: String(o.id),
          lat,
          lon,
          // Mirrors ZONE_TOLERANCE in the bridge: the drawn ring has to be the
          // ring that actually counts, or the map is lying about the job.
          radiusNm: Math.max(0.25, (Number(o.radius_nm) || 0.5) * 1.35),
          label: typeof o.label === "string" ? o.label : undefined,
          done: doneById.get(String(o.id)) ?? false,
        };
      })
      .filter((w): w is NonNullable<typeof w> => w !== null);
  })();

  return (
    <div className="space-y-6 p-6 md:p-8">
      {flight && (
        <div className="rounded-lg border border-primary/40 bg-card p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-widest text-primary">
                {flight.hours != null ? "In flight" : flight.onGround ? "On the ground" : "Airborne"}
              </p>
              <p className="mt-1 font-medium">
                {flight.simTitle ?? "Aircraft"}
                {activeMission ? ` · ${activeMission.title}` : " · positioning"}
              </p>
            </div>
            <div className="flex flex-wrap gap-4 font-mono text-sm">
              <Readout label="GS" value={`${Math.round(flight.groundSpeed)} kt`} />
              <Readout label="AGL" value={`${Math.round(flight.agl)} ft`} />
              {flight.hours != null && <Readout label="Time" value={`${flight.hours.toFixed(2)} h`} />}
              {flight.fuelUsed != null && <Readout label="Fuel" value={`${Math.round(flight.fuelUsed)} lb`} />}
              {flight.distance != null && <Readout label="Track" value={`${flight.distance.toFixed(1)} nm`} />}
              {sceneRange != null && <Readout label="To scene" value={`${sceneRange.toFixed(1)} nm`} />}
            </div>
          </div>
          {/*
            The map draws its rings from the database, so a contract whose
            objectives never armed in the bridge looks entirely normal here
            and simply never ticks. The usual cause is the loaded aircraft
            not being linked to the fleet, which is invisible from this
            screen -- worth saying plainly rather than leaving someone to
            fly a whole patrol that was never being watched.
          */}
          {activeMission && !objectives && (
            <p className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-sm text-warning">
              "{activeMission.title}" is in progress, but the sim bridge is not
              tracking it, so nothing will tick.{" "}
              {simAircraft && !simAircraft.matchedName
                ? `The aircraft loaded in the sim ("${simAircraft.simTitle}") is not in your fleet — link it on Settings → Sim Link.`
                : "Check that the contract is dispatched to the aircraft you are flying."}
            </p>
          )}
          <LiveObjectives state={objectives} />

          <FlightMap
            aircraft={{ lat: flight.lat, lon: flight.lon, heading: flight.heading }}
            scene={
              activeMission?.scene_lat != null
                ? {
                    lat: Number(activeMission.scene_lat),
                    lon: Number(activeMission.scene_lon),
                    label: searchArea
                      ? `Datum — ${activeMission.scene_name ?? "search"}`
                      : (activeMission.scene_name ?? "Scene"),
                  }
                : null
            }
            waypoints={mapWaypoints}
            search={searchArea}
            sighted={objectives?.sighted ?? null}
            base={
              homeBase
                ? { lat: Number(homeBase.latitude), lon: Number(homeBase.longitude), label: homeBase.name }
                : null
            }
            track={track}
            className="h-96 w-full rounded-lg border border-border"
          />
        </div>
      )}

      {flight && activeMission && activeMission.scene_lat == null && (
        <p className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-sm text-warning">
          "{activeMission.title}" has no scene coordinates, so there is nothing to
          draw a line to and no objectives to track. It was generated before
          scene contracts existed — clear the board and generate a fresh batch.
        </p>
      )}

      {!flight && isDesktop && (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          The moving map appears here once MSFS 2024 is running with a flight loaded.
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

        <Panel icon={Plane} title="Aircraft on contract">
          {onContract.length === 0 && <Empty text="Every aircraft is at base." />}
          {onContract.map((a: any) => (
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
function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p>{value}</p>
    </div>
  );
}

const NM_R = 3440.065;
function nmBetween(aLat: number, aLon: number, bLat: number, bLon: number) {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLon = r(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * NM_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * What the bridge is currently waiting for.
 *
 * Objectives complete in order, so the useful thing on screen is the current
 * one and its hint -- "descend below 90 ft AGL", "12.4 nm to run". Without
 * that, arriving at a scene and having nothing happen is indistinguishable
 * from the tracking being broken.
 */
function LiveObjectives({ state }: { state: BridgeStatus["objectives"] }) {
  if (!state || state.items.length === 0) return null;
  const nextIdx = state.items.findIndex((o) => !o.done);

  return (
    <div className="mb-3 rounded-md border border-border bg-background p-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {state.missionTitle}
      </p>
      <ol className="mt-2 space-y-1">
        {state.items.map((o, i) => {
          const isNext = i === nextIdx;
          return (
            <li
              key={o.id}
              className={`flex items-center gap-2 text-sm ${
                o.done ? "text-success" : isNext ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <span className="font-mono">{o.done ? "✓" : isNext ? "▸" : "·"}</span>
              <span className={isNext ? "font-medium" : ""}>{o.label}</span>
              {isNext && o.hint && (
                <span className="ml-auto font-mono text-xs text-warning">{o.hint}</span>
              )}
              {isNext && o.progress > 0 && o.progress < 1 && (
                <span className="h-1 w-16 overflow-hidden rounded bg-muted">
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.round(o.progress * 100)}%` }}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
