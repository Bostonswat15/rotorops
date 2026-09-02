import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useState } from "react";
import { toast } from "sonner";
import { Briefcase, Zap, AlertTriangle, Radio, PlaneTakeoff, Trash2, MapPin } from "lucide-react";
import {
  MISSION_TEMPLATES,
  generateMissionFromTemplate,
  isAircraftEligible,
  companyHasCerts,
  TAG_LABELS,
} from "@/lib/game-data";
import { useCompanyRole } from "@/hooks/use-company";
import {
  SCENE_TEMPLATES, SCENE_LABELS, generateSceneMission, generatePowerlinePatrol,
  waterAvailability, sceneIsFlyable, summariseWater, parseWaterSites,
  type SceneType, type WaterSites,
} from "@/lib/missions";
import { findAerodromes, findWater } from "@/lib/osm";

export const Route = createFileRoute("/_authenticated/missions")({
  head: () => ({ meta: [{ title: "Mission Board — RotorOps" }] }),
  component: MissionsPage,
});

function MissionsPage() {
  const qc = useQueryClient();
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [manualFor, setManualFor] = useState<any | null>(null);
  const { canManage } = useCompanyRole();

  const { data: company } = useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });
  const { data: missions } = useQuery({
    queryKey: ["missions"],
    queryFn: async () => (await supabase.from("missions").select("*").order("generated_at", { ascending: false })).data ?? [],
  });
  const { data: aircraft } = useQuery({
    queryKey: ["aircraft"],
    queryFn: async () => (await supabase.from("aircraft").select("*")).data ?? [],
  });
  const { data: bases } = useQuery({
    queryKey: ["bases"],
    queryFn: async () => (await supabase.from("bases").select("*")).data ?? [],
  });

  const locatedBase = (bases ?? []).find((b: any) => b.latitude != null && b.longitude != null) ?? null;
  // Even without coordinates we know which field is home.
  const homeIcao =
    locatedBase?.icao ??
    (bases ?? []).find((b: any) => b.is_primary)?.icao ??
    (bases ?? [])[0]?.icao ??
    null;

  // Scene contracts need a real position to build objectives around. The sim
  // bridge fills that in the first time it sees the base airport, so until it
  // has run once we fall back to plain point-to-point work.
  async function generateBatch() {
    if (!company) return;
    const base = locatedBase;

    let rows: any[];
    let droppedForWater = 0;
    if (base) {
      // What water is actually near this base? Without asking, the board offered
      // vessel and beach work from landlocked fields.
      //
      // The Overpass lookup is a 15-20 second area query, so it runs once per
      // base and is cached on the row. Everyone in the company benefits from
      // whoever generated first.
      // `water_scanned_at`, not the contents, decides whether we've looked: a
      // base with genuinely no water caches an empty result, and that is an
      // answer worth keeping.
      let water: WaterSites | null = base.water_scanned_at
        ? parseWaterSites(base.water_sites)
        : null;
      if (!water) {
        const scanning = toast.loading("Scanning the area for water — this takes a moment.");
        try {
          const raw = await findWater(
            { lat: Number(base.latitude), lon: Number(base.longitude) },
            50,
          );
          if (raw) {
            water = summariseWater(
              raw,
              { lat: Number(base.latitude), lon: Number(base.longitude) },
              50,
            );
            const { error: wErr } = await supabase.rpc("set_base_water", {
              _base_id: base.id,
              _sites: water as unknown as never,
            });
            // A failed cache write is not a failed generation -- the sites are
            // already in hand for this batch, we just pay for them again next
            // time.
            if (!wErr) qc.invalidateQueries({ queryKey: ["bases"] });
          }
        } catch {
          // Leave it null: unknown, not absent. Everything stays on the board.
        } finally {
          toast.dismiss(scanning);
        }
      }
      const avail = waterAvailability(water);

      const certified = SCENE_TEMPLATES.filter((t) =>
        companyHasCerts(company.certifications, t.required_certs),
      );
      if (certified.length === 0) {
        return toast.error("No contracts match your certifications yet.");
      }

      const pool = certified.filter((t) => sceneIsFlyable(t.scene_type, avail));
      droppedForWater = certified.length - pool.length;
      if (pool.length === 0) {
        return toast.error(
          "Every contract you're certified for needs water, and there's none near this base.",
        );
      }

      // Airfields come from two places: the sim's facility cache (reported by
      // the bridge) and OSM. Either alone can be empty -- the cache before the
      // bridge has run, OSM in poorly-mapped regions -- so merge them and
      // de-duplicate. One query per batch, not one per contract.
      const fromBridge = ((base.nearby_airports ?? []) as any[]).filter(
        (a) => a && Number.isFinite(a.lat) && Number.isFinite(a.lon),
      );
      let fromOsm: any[] = [];
      try {
        fromOsm = await findAerodromes(
          { lat: Number(base.latitude), lon: Number(base.longitude) },
          60,
        );
      } catch {
        // Overpass unavailable; the bridge's list still stands.
      }
      const seen = new Set(fromBridge.map((a) => String(a.icao).toUpperCase()));
      const airports = [
        ...fromBridge,
        ...fromOsm.filter((a) => !seen.has(String(a.icao).toUpperCase())),
      ];

      const site = {
        lat: Number(base.latitude),
        lon: Number(base.longitude),
        icao: base.icao,
        airports,
        water,
      };

      rows = Array.from({ length: 6 }, () => {
        const t = pool[Math.floor(Math.random() * pool.length)];
        return { company_id: company.id, ...generateSceneMission(t, company.reputation, site) };
      });

      // One contract follows a real transmission line, when OSM knows of one
      // nearby. MSFS draws its powerlines from the same data, so it's a line
      // you can actually see and follow.
      try {
        const patrol = await generatePowerlinePatrol(company.reputation, site);
        if (patrol) rows[rows.length - 1] = { company_id: company.id, ...patrol };
      } catch {
        // Overpass unavailable -- the synthetic contract already in the slot stands.
      }
    } else {
      const pool = MISSION_TEMPLATES.filter((t) =>
        companyHasCerts(company.certifications, t.required_certs),
      );
      rows = Array.from({ length: 6 }, () => {
        const t = pool[Math.floor(Math.random() * pool.length)];
        return {
          company_id: company.id,
          ...generateMissionFromTemplate(t, company.reputation, homeIcao),
        };
      });
    }

    const { error } = await supabase.from("missions").insert(rows);
    if (error) return toast.error(error.message);

    if (!base) {
      toast.success("Generated 6 contracts. Run the sim bridge once to unlock scene missions.");
    } else {
      const withField = rows.filter((r) => r.nearest_airport_icao).length;
      const notes: string[] = [];
      if (withField < rows.length) {
        notes.push(`${withField} of 6 have a nearest field — no airfield data near the rest`);
      }
      if (droppedForWater > 0) {
        notes.push(
          `${droppedForWater} water contract type${droppedForWater === 1 ? "" : "s"} withheld — no suitable water near this base`,
        );
      }
      toast.success(
        notes.length === 0
          ? "Generated 6 scene contracts."
          : `Generated 6 scene contracts. ${notes.join(". ")}.`,
      );
    }
    qc.invalidateQueries({ queryKey: ["missions"] });
  }

  // Assign the aircraft and hand the flight over to the sim. The bridge picks
  // it up from here; resolution happens server-side from real telemetry.
  async function dispatch(mission: any, ac: any) {
    const { error } = await supabase.rpc("dispatch_mission", {
      _mission_id: mission.id,
      _aircraft_id: ac.id,
    });
    if (error) return toast.error(error.message);
    toast.success(
      mission.scene_name
        ? `${ac.display_name} dispatched — ${mission.scene_name} and back to ${mission.origin}.`
        : `${ac.display_name} dispatched — fly ${routeLabel(mission)} in MSFS.`,
    );
    qc.invalidateQueries();
  }

  /**
   * Wipe the unclaimed board.
   *
   * Contracts are written at generation time, so changing how they're generated
   * doesn't touch ones already on the board. Dispatched and completed work is
   * left alone -- this only clears what nobody has taken.
   */
  async function clearBoard() {
    if (!company) return;
    const { error } = await supabase
      .from("missions")
      .delete()
      .eq("company_id", company.id)
      .eq("status", "available");
    if (error) return toast.error(error.message);
    toast.success("Board cleared.");
    qc.invalidateQueries({ queryKey: ["missions"] });
  }

  async function cancelDispatch(mission: any) {
    const { error } = await supabase.rpc("cancel_dispatch", { _mission_id: mission.id });
    if (error) return toast.error(error.message);
    toast.success("Dispatch cancelled.");
    qc.invalidateQueries();
  }

  const available = missions?.filter((m: any) => m.status === "available") ?? [];
  const inProgress = missions?.filter((m: any) => m.status === "in_progress") ?? [];
  const completed = missions?.filter((m: any) => m.status === "completed" || m.status === "failed").slice(0, 10) ?? [];
  const filtered = roleFilter === "all" ? available : available.filter((m: any) => m.role === roleFilter);
  const roles = [...new Set(available.map((m: any) => m.role))];
  const fleet = aircraft ?? [];

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Dispatch</p>
          <h1 className="mt-1 text-3xl font-semibold">Mission Board</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {available.length} contracts available
            {homeIcao ? <> · operating from <span className="font-mono">{homeIcao}</span></> : " · no home base set"}
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {roles.map((r) => <SelectItem key={r as string} value={r as string}>{r as string}</SelectItem>)}
            </SelectContent>
          </Select>
          {canManage && available.length > 0 && (
            <Button variant="secondary" onClick={clearBoard}>
              <Trash2 className="mr-2 h-4 w-4" /> Clear board
            </Button>
          )}
          {canManage && (
            <Button onClick={generateBatch}><Zap className="mr-2 h-4 w-4" /> Generate</Button>
          )}
        </div>
      </div>

      {inProgress.length > 0 && (
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            <Radio className="h-3.5 w-3.5 text-primary" /> In progress
          </h2>
          <div className="grid gap-3 lg:grid-cols-2">
            {inProgress.map((m: any) => {
              const ac = fleet.find((a: any) => a.id === m.aircraft_id);
              return (
                <div key={m.id} className="rounded-lg border border-primary/40 bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{m.title}</p>
                      <p className="text-sm text-muted-foreground">
                        {m.scene_name
                          ? `${m.origin} ⟳ ${m.scene_name}`
                          : routeLabel(m)}
                        {" · "}{m.distance_nm}nm round trip · min {m.min_payload}lb
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {ac ? ac.display_name : "aircraft unassigned"}
                        {ac?.sim_title ? ` · fly "${ac.sim_title}" in MSFS` : ""}
                      </p>
                      {m.nearest_airport_icao && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Diversion field: <span className="font-mono text-foreground">{m.nearest_airport_icao}</span> · {Number(m.nearest_airport_nm).toFixed(1)}nm from scene
                        </p>
                      )}
                    </div>
                    <p className="shrink-0 font-mono text-lg font-semibold text-success">
                      ${Number(m.payout).toLocaleString()}
                    </p>
                  </div>

                  <Objectives mission={m} />
                  <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                    <PlaneTakeoff className="h-3.5 w-3.5 text-primary" />
                    <span className="flex-1 text-xs text-muted-foreground">Awaiting flight — the bridge will log it on engine shutdown.</span>
                    <Button size="sm" variant="secondary" onClick={() => setManualFor(m)}>Log manually</Button>
                    <Button size="sm" variant="ghost" onClick={() => cancelDispatch(m)}>Cancel</Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {filtered.length === 0 && (
          <div className="col-span-2 rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
            No available missions. {canManage ? <>Click <strong>Generate</strong> to pull new contracts.</> : <>Ask a manager to generate new contracts.</>}
          </div>
        )}
        {filtered.map((m: any) => (
          <MissionCard
            key={m.id}
            mission={m}
            aircraft={fleet}
            certs={company?.certifications ?? []}
            onDispatch={(ac: any) => dispatch(m, ac)}
          />
        ))}
      </div>

      {completed.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">Recent contracts</h2>
          <div className="rounded-lg border border-border bg-card">
            {completed.map((m: any) => (
              <div key={m.id} className="flex items-center justify-between border-b border-border px-4 py-2 last:border-0 text-sm">
                <div>
                  <p className="font-medium">{m.title}</p>
                  <p className="text-xs text-muted-foreground">{m.origin} → {m.destination}</p>
                </div>
                <span className={`text-xs ${m.status === "completed" ? "text-success" : "text-destructive"}`}>{m.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <ManualLogDialog
        mission={manualFor}
        aircraft={fleet.find((a: any) => a.id === manualFor?.aircraft_id)}
        onClose={() => setManualFor(null)}
        onDone={() => { setManualFor(null); qc.invalidateQueries(); }}
      />
    </div>
  );
}

/**
 * The contract's objective list and how far through it the pilot is.
 *
 * State comes from the database, not the local bridge, so everyone in the
 * company watches the same rescue unfold -- not just whoever is flying.
 */
function Objectives({ mission }: { mission: any }) {
  const list: any[] = Array.isArray(mission.objectives) ? mission.objectives : [];
  if (list.length === 0) return null;
  const state = (mission.objectives_state ?? {}) as Record<string, { done?: boolean }>;
  const doneCount = list.filter((o) => state[o.id]?.done).length;
  const nextIdx = list.findIndex((o) => !state[o.id]?.done);

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between text-xs">
        <span className="uppercase tracking-wider text-muted-foreground">
          {mission.scene_name
            ? `${mission.scene_name}${mission.scene_type ? ` · ${SCENE_LABELS[mission.scene_type as SceneType] ?? mission.scene_type}` : ""}`
            : "Objectives"}
        </span>
        <span className="font-mono text-muted-foreground">{doneCount}/{list.length}</span>
      </div>

      {mission.scene_lat != null && (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {Number(mission.scene_lat).toFixed(4)}, {Number(mission.scene_lon).toFixed(4)}
        </p>
      )}

      <ol className="mt-2 space-y-1">
        {list.map((o, i) => {
          const done = !!state[o.id]?.done;
          const isNext = i === nextIdx;
          return (
            <li
              key={o.id}
              className={`flex items-start gap-2 text-xs ${
                done ? "text-success" : isNext ? "text-foreground" : "text-muted-foreground"
              }`}
            >
              <span className="mt-[2px] font-mono">{done ? "✓" : isNext ? "▸" : "·"}</span>
              <span className={isNext ? "font-medium" : ""}>{o.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Fallback for flying without the bridge running. Feeds the same server-side
 * resolver the bridge uses, just with hand-entered numbers.
 */
function ManualLogDialog({ mission, aircraft, onClose, onDone }: any) {
  const [duration, setDuration] = useState("");
  const [fuel, setFuel] = useState("");
  const [arrival, setArrival] = useState("");
  const [quality, setQuality] = useState("normal");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!mission || !aircraft) return;
    setBusy(true);
    const telemetry: Record<string, unknown> = { landing_quality: quality };
    if (duration) telemetry.duration_hr = Number(duration);
    if (fuel) telemetry.fuel_used = Number(fuel);
    if (arrival) telemetry.arrival = arrival.trim().toUpperCase();

    const { data, error } = await supabase.rpc("complete_mission_manual", {
      _mission_id: mission.id,
      _aircraft_id: aircraft.id,
      _telemetry: telemetry as any,
    });
    setBusy(false);
    if (error) return toast.error(error.message);

    const r = data as any;
    toast[r?.success ? "success" : "error"](
      r?.success
        ? `Contract complete. ${r.net >= 0 ? "+" : "-"}$${Math.abs(Math.round(r.net)).toLocaleString()}`
        : "Contract failed — incident logged.",
    );
    setDuration(""); setFuel(""); setArrival(""); setQuality("normal");
    onDone();
  }

  return (
    <Dialog open={!!mission} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log flight manually</DialogTitle>
          <DialogDescription>
            {mission?.title} · {mission?.origin} → {mission?.destination}
            <br />
            Leave a field blank to use the aircraft's book figures.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ml-dur">Flight time (hours)</Label>
              <Input id="ml-dur" inputMode="decimal" placeholder="0.8" value={duration} onChange={(e) => setDuration(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="ml-fuel">Fuel used (lb)</Label>
              <Input id="ml-fuel" inputMode="decimal" placeholder="180" value={fuel} onChange={(e) => setFuel(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="ml-arr">Landed at (ICAO)</Label>
              <Input id="ml-arr" placeholder={mission?.destination ?? ""} value={arrival} onChange={(e) => setArrival(e.target.value)} />
            </div>
            <div>
              <Label>Landing</Label>
              <Select value={quality} onValueChange={setQuality}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="excellent">Excellent</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="hard">Hard</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !aircraft}>{busy ? "Filing…" : "File flight"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MissionCard({ mission, aircraft, certs, onDispatch }: any) {
  const certsOk = companyHasCerts(certs, mission.required_certs);
  const eligibleAircraft = aircraft.map((a: any) => ({ a, e: isAircraftEligible(a, mission) })).filter((x: any) => x.e.eligible);
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Briefcase className="h-4 w-4 text-primary" />
            <span className="text-xs uppercase tracking-widest text-muted-foreground">{mission.role}</span>
          </div>
          <h3 className="mt-1 text-lg font-semibold">{mission.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{mission.description}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xl font-semibold text-success">${Number(mission.payout).toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">payout</p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-4 gap-2 text-xs">
        <S l="Route" v={routeLabel(mission)} />
        <S l="Round trip" v={`${mission.distance_nm}nm`} />
        <S l="Payload" v={`${mission.min_payload}lb`} />
        <S l="Difficulty" v={"●".repeat(mission.difficulty)} />
      </dl>
      {mission.scene_name && (
        <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="h-3 w-3 text-primary" />
          Scene: <span className="text-foreground">{mission.scene_name}</span>
          {mission.scene_type && (
            <> · {SCENE_LABELS[mission.scene_type as SceneType] ?? mission.scene_type}</>
          )}
          {mission.nearest_airport_icao && (
            <> · nearest field <span className="font-mono text-foreground">{mission.nearest_airport_icao}</span> {Number(mission.nearest_airport_nm).toFixed(1)}nm</>
          )}
        </p>
      )}
      {mission.required_tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {mission.required_tags.map((t: string) => (
            <span key={t} className="rounded bg-secondary px-2 py-0.5 text-[11px]">{TAG_LABELS[t as keyof typeof TAG_LABELS] ?? t}</span>
          ))}
        </div>
      )}
      <div className="mt-4 border-t border-border pt-3">
        {!certsOk && (
          <div className="flex items-center gap-2 text-xs text-warning">
            <AlertTriangle className="h-3 w-3" /> Requires cert: {mission.required_certs.join(", ")}
          </div>
        )}
        {certsOk && eligibleAircraft.length === 0 && (
          <p className="text-xs text-muted-foreground">No eligible aircraft in fleet.</p>
        )}
        {certsOk && eligibleAircraft.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {eligibleAircraft.map(({ a }: any) => (
              <Button key={a.id} size="sm" variant="secondary" onClick={() => onDispatch(a)}>
                Dispatch · {a.display_name}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Helicopter contracts launch from base, work a scene, and come home -- so
 * origin and destination are the same field. Rendering that as "KFMH→KFMH"
 * says nothing; the round-trip marker plus the scene line below carries the
 * information that actually matters.
 */
function routeLabel(m: any) {
  if (!m.origin && !m.destination) return "—";
  if (m.origin && m.origin === m.destination) return `${m.origin} ⟳`;
  return `${m.origin ?? "?"}→${m.destination ?? "?"}`;
}

function S({ l, v }: { l: string; v: any }) {
  return <div><dt className="text-muted-foreground">{l}</dt><dd className="font-mono">{v}</dd></div>;
}
