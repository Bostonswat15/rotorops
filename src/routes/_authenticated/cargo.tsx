import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { MapPin, Package, Scale, Trash2, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompany, useCompanyRole } from "@/hooks/use-company";
import { fleetWing, type WingType } from "@/lib/game-data";
import { ratingOf, CHECKOUT_RATING } from "@/lib/ratings";
import { distanceNm, parsePlacementSites } from "@/lib/missions";
import { airfieldsNear } from "@/lib/airfields";
import {
  generateCargoJobs, checkLoad, manifestSummary, isExpired, jobWing, PAX_LB, JOB_EXPIRY_HOURS,
} from "@/lib/cargo";

export const Route = createFileRoute("/_authenticated/cargo")({
  head: () => ({ meta: [{ title: "Cargo Hub — RotorOps" }] }),
  component: CargoPage,
});

type Job = Database["public"]["Tables"]["missions"]["Row"];
type Trip = Database["public"]["Tables"]["trips"]["Row"];
type Aircraft = Database["public"]["Tables"]["aircraft"]["Row"];
type RatingRow = { user_id: string; rating: string; passed_at: string | null };

/** Jobs collected from the same place: the same ident, else the same spot. */
const pickupKey = (j: Pick<Job, "pickup_icao" | "pickup_lat" | "pickup_lon">) =>
  j.pickup_icao
    ? j.pickup_icao.toUpperCase()
    : `${Number(j.pickup_lat).toFixed(3)},${Number(j.pickup_lon).toFixed(3)}`;

/**
 * The Cargo Hub: OnAir-style work. Jobs wait at the base, nearby airfields and
 * industry sites; you tick what to take from one pickup, check it against the
 * aircraft on the load sheet, and fly it as a trip. src/lib/cargo.ts has the
 * numbers, and the server holds the load sheet to them.
 */
function CargoPage() {
  const qc = useQueryClient();
  const { data: company } = useCompany();
  const { canManage, isOwner } = useCompanyRole();
  const companyId = company?.id;

  const [pickedWing, setWing] = useState<WingType | null>(null);
  const [pickedPickup, setPickedPickup] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [aircraftId, setAircraftId] = useState("");
  const [fuelOn, setFuelOn] = useState(false);
  const [fuelLb, setFuelLb] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });
  const { data: bases } = useQuery({
    queryKey: ["bases", companyId],
    enabled: !!companyId,
    queryFn: async () => (await supabase.from("bases").select("*").eq("company_id", companyId!)).data ?? [],
  });
  const { data: fleetRows } = useQuery({
    queryKey: ["cargo-aircraft", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (
        await supabase
          .from("aircraft")
          .select("*")
          .eq("company_id", companyId!)
          .not("status", "in", "(sold,returned,destroyed)")
      ).data ?? [],
  });
  const { data: industryRows } = useQuery({
    queryKey: ["industries", companyId],
    enabled: !!companyId,
    queryFn: async () => (await supabase.from("industries").select("*").eq("company_id", companyId!)).data ?? [],
  });
  const { data: jobs } = useQuery({
    queryKey: ["cargo-jobs", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (
        await supabase
          .from("missions")
          .select("*")
          .eq("company_id", companyId!)
          .not("manifest", "is", null)
          .eq("status", "available")
          .order("generated_at", { ascending: false })
      ).data ?? [],
  });
  const { data: trips } = useQuery({
    queryKey: ["trips", companyId],
    enabled: !!companyId,
    queryFn: async () =>
      (await supabase.from("trips").select("*").eq("company_id", companyId!).eq("status", "active")).data ?? [],
  });
  const tripIds = (trips ?? []).map((t) => t.id);
  const { data: tripJobs } = useQuery({
    queryKey: ["trip-jobs", tripIds.join(",")],
    enabled: tripIds.length > 0,
    queryFn: async () =>
      (
        await supabase
          .from("missions")
          .select("id, title, drop_name, drop_icao, cargo_lb, payout, delivered_at, trip_id")
          .in("trip_id", tripIds)
      ).data ?? [],
  });
  // Null for the owner, and before the ratings migration: no gate.
  const { data: ratings } = useQuery({
    queryKey: ["pilot_ratings", companyId],
    enabled: !!companyId,
    queryFn: async () => {
      const { data, error } = await supabase.from("pilot_ratings").select("*").eq("company_id", companyId!);
      return error ? null : data;
    },
  });

  const fleet: Aircraft[] = fleetRows ?? [];
  const wing: WingType = pickedWing ?? fleetWing(fleet);
  const base = (bases ?? []).find((b) => b.latitude != null && b.longitude != null) ?? null;
  const now = Date.now();

  const waiting = (jobs ?? []).filter((j) => !isExpired(j, now) && jobWing(j) === wing);
  const pickups = [...waiting.reduce((map, j) => {
    const key = pickupKey(j);
    const entry = map.get(key) ?? {
      key,
      name: j.pickup_name ?? j.pickup_icao ?? "Pickup",
      lat: Number(j.pickup_lat),
      lon: Number(j.pickup_lon),
      jobs: [] as Job[],
    };
    entry.jobs.push(j);
    map.set(key, entry);
    return map;
  }, new Map<string, { key: string; name: string; lat: number; lon: number; jobs: Job[] }>()).values()]
    .map((p) => ({ ...p, fromBase: base ? distanceNm(Number(base.latitude), Number(base.longitude), p.lat, p.lon) : 0 }))
    .sort((a, b) => a.fromBase - b.fromBase);
  const pickup = pickups.find((p) => p.key === pickedPickup) ?? pickups[0] ?? null;
  const chosen = pickup ? pickup.jobs.filter((j) => selected.has(j.id)) : [];

  const myRatings = (ratings as RatingRow[] | null | undefined)?.filter((r) => r.user_id === me) ?? null;
  const passed = (rating: string) => isOwner || !myRatings || myRatings.some((r) => r.rating === rating && r.passed_at);
  const checkedOut = passed(CHECKOUT_RATING);
  const flyable = fleet.filter((a) => a.status === "available" && ratingOf(a).wing === wing);
  const ac = flyable.find((a) => a.id === aircraftId) ?? null;
  const fuelCap = ac?.fuel_capacity_lb != null ? Number(ac.fuel_capacity_lb) : null;
  const fuel = fuelOn && fuelCap != null && fuelLb.trim() !== "" ? Number(fuelLb) : null;
  const check = ac ? checkLoad(ac, chosen, fuel) : null;
  const blockers = [
    ...(!ac ? ["Pick an aircraft."] : []),
    ...(!checkedOut ? ["Pass your company check ride first — it's on the Mission Board."] : []),
    ...(ac && !passed(ratingOf(ac).rating) ? [`You aren't rated on the ${ratingOf(ac).label} yet.`] : []),
    ...(check?.errors ?? (chosen.length === 0 ? ["Pick at least one job to load."] : [])),
  ];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function refetchAll() {
    qc.invalidateQueries({ queryKey: ["cargo-jobs"] });
    qc.invalidateQueries({ queryKey: ["trips"] });
    qc.invalidateQueries({ queryKey: ["trip-jobs"] });
    qc.invalidateQueries({ queryKey: ["cargo-aircraft"] });
    qc.invalidateQueries({ queryKey: ["aircraft"] });
  }

  async function generate() {
    if (!company) return;
    if (!base) {
      toast.error("Set a home base with a position first: Settings, then run the sim bridge once.");
      return;
    }
    setBusy("generate");
    try {
      let industries = (industryRows ?? []).filter((i) => i.base_id === base.id);
      try {
        const { data } = await supabase.rpc("tick_base_industries", { _base_id: base.id });
        if (data) industries = data as typeof industries;
      } catch {
        // Stale stock only means a job may be refused at dispatch.
      }
      const airports = await airfieldsNear(base, wing === "fixed");
      const sites = parsePlacementSites(base.placement_sites);
      const rows = generateCargoJobs({
        wing,
        companyId: company.id,
        reputation: Number(company.reputation) || 0,
        base: {
          name: base.name ?? base.icao ?? "Base",
          icao: base.icao,
          lat: Number(base.latitude),
          lon: Number(base.longitude),
        },
        airports,
        hospitals: sites?.hospital ?? [],
        industries: industries.map((i) => ({
          id: i.id,
          kind: i.kind,
          lat: Number(i.latitude),
          lon: Number(i.longitude),
          name: i.name,
          stock: Number(i.stock),
        })),
      });

      // Jobs past their expiry make way for the new ones.
      await supabase
        .from("missions")
        .delete()
        .eq("company_id", company.id)
        .eq("status", "available")
        .not("manifest", "is", null)
        .lt("expires_at", new Date().toISOString());

      if (rows.length === 0) {
        toast.error(
          wing === "fixed"
            ? "No plane jobs this time: they run between airfields, and none came back near this base. Try again."
            : "No helicopter jobs this time: there were no airfields, sites or hospitals in range. Try again.",
        );
        return;
      }
      const { error } = await supabase.from("missions").insert(rows as never);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success(`${rows.length} ${wing === "fixed" ? "plane" : "helicopter"} jobs posted. They wait ${JOB_EXPIRY_HOURS} hours.`);
      refetchAll();
    } finally {
      setBusy(null);
    }
  }

  async function clearWaiting() {
    if (!company) return;
    const { error } = await supabase
      .from("missions")
      .delete()
      .eq("company_id", company.id)
      .eq("status", "available")
      .not("manifest", "is", null)
      .eq("manifest->>wing", wing);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSelected(new Set());
    toast.success(`Waiting ${wing === "fixed" ? "plane" : "helicopter"} jobs cleared.`);
    refetchAll();
  }

  async function dispatch() {
    if (!ac || blockers.length > 0) return;
    setBusy("dispatch");
    const { error } = await supabase.rpc("dispatch_trip", {
      _aircraft_id: ac.id,
      _job_ids: chosen.map((j) => j.id),
      _fuel_lb: fuel ?? undefined,
    });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      `Trip dispatched: ${ac.display_name} with ${chosen.length} job${chosen.length === 1 ? "" : "s"}. ` +
        `Fly to ${pickup?.name ?? "the pickup"} and hold still to load.`,
    );
    setSelected(new Set());
    refetchAll();
  }

  async function cancelTrip(trip: Trip) {
    if (!window.confirm("Cancel this trip? Jobs not yet delivered go back to where they were collected.")) return;
    setBusy(`cancel-${trip.id}`);
    const { error } = await supabase.rpc("cancel_trip", { _trip_id: trip.id });
    setBusy(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Trip cancelled.");
    refetchAll();
  }

  const pct = check && check.limitLb > 0 ? Math.min(100, (check.countedLb / check.limitLb) * 100) : 0;

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Dispatch</p>
          <h1 className="mt-1 text-3xl font-semibold">Cargo Hub</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {waiting.length} {wing === "fixed" ? "plane" : "helicopter"} job{waiting.length === 1 ? "" : "s"} waiting.
            Pick jobs at one place, load them on one aircraft, and drop each where it's going.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            {(["rotary", "fixed"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => {
                  setWing(w);
                  setSelected(new Set());
                  setAircraftId("");
                  setPickedPickup(null);
                }}
                className={`px-3 py-2 text-sm ${wing === w ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"}`}
              >
                {w === "fixed" ? "Planes" : "Helicopters"}
              </button>
            ))}
          </div>
          {canManage && waiting.length > 0 && (
            <Button variant="secondary" onClick={clearWaiting} disabled={!!busy}>
              <Trash2 className="mr-2 h-4 w-4" /> Clear waiting
            </Button>
          )}
          {canManage && (
            <Button onClick={generate} disabled={!!busy}>
              <Zap className="mr-2 h-4 w-4" />
              {busy === "generate" ? "Generating…" : `Generate ${wing === "fixed" ? "plane" : "helicopter"} jobs`}
            </Button>
          )}
        </div>
      </div>

      {(trips ?? []).length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Open trips</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {(trips ?? []).map((t) => {
              const tAc = fleet.find((a) => a.id === t.aircraft_id);
              const tj = (tripJobs ?? []).filter((j) => j.trip_id === t.id);
              const left = tj.filter((j) => !j.delivered_at);
              return (
                <div key={t.id} className="rounded-lg border border-primary/40 bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-primary">
                        {t.loaded_at ? "Loaded" : `Load at ${t.pickup_name ?? t.pickup_icao ?? "the pickup"}`}
                      </p>
                      <p className="mt-1 font-medium">
                        {tAc?.display_name ?? "Aircraft"} · {left.length} of {tj.length} to deliver ·{" "}
                        {Math.round(Number(t.cargo_lb)).toLocaleString()} lb
                        {t.fuel_lb != null ? ` · fuel ${Math.round(Number(t.fuel_lb)).toLocaleString()} lb` : ""}
                      </p>
                    </div>
                    {(t.pilot_id === me || canManage) && (
                      <Button size="sm" variant="ghost" onClick={() => cancelTrip(t)} disabled={busy === `cancel-${t.id}`}>
                        Cancel trip
                      </Button>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1 text-sm">
                    {tj.map((j) => (
                      <li key={j.id} className="flex items-center justify-between gap-3">
                        <span className={j.delivered_at ? "text-success" : ""}>
                          {j.delivered_at ? "✓ " : "• "}
                          {j.title}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          ${Number(j.payout).toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[15rem_minmax(0,1fr)_21rem]">
        <aside className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Pickups</h2>
          {pickups.length === 0 ? (
            <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
              Nothing waiting.{canManage ? " Generate jobs to fill the hub." : ""}
            </p>
          ) : (
            pickups.map((p) => {
              const lb = p.jobs.reduce((sum, j) => sum + Number(j.cargo_lb ?? 0), 0);
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    setPickedPickup(p.key);
                    setSelected(new Set());
                  }}
                  className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                    pickup?.key === p.key ? "border-primary bg-accent" : "border-border bg-card hover:bg-accent/50"
                  }`}
                >
                  <p className="flex items-center gap-1 font-medium">
                    <MapPin className="h-3 w-3 text-primary" /> {p.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {p.jobs.length} job{p.jobs.length === 1 ? "" : "s"} · {Math.round(lb).toLocaleString()} lb
                    {base && p.fromBase >= 1 ? ` · ${p.fromBase.toFixed(0)} nm from base` : " · at base"}
                  </p>
                </button>
              );
            })
          )}
        </aside>

        <section className="min-w-0 rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Package className="h-4 w-4 text-primary" />
            <h2 className="font-semibold">{pickup ? `Waiting at ${pickup.name}` : "Jobs"}</h2>
          </div>
          {pickup ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="w-8 px-4 py-2" />
                    <th className="px-2 py-2">Job</th>
                    <th className="px-2 py-2">To</th>
                    <th className="px-2 py-2 text-right">Weight</th>
                    <th className="px-2 py-2 text-right">Dist</th>
                    <th className="px-2 py-2 text-right">Pay</th>
                    <th className="px-4 py-2 text-right">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {pickup.jobs.map((j) => {
                    const hours = j.expires_at ? Math.max(0, (new Date(j.expires_at).getTime() - now) / 3600_000) : null;
                    return (
                      <tr
                        key={j.id}
                        onClick={() => toggle(j.id)}
                        className={`cursor-pointer border-t border-border ${selected.has(j.id) ? "bg-accent" : "hover:bg-accent/40"}`}
                      >
                        <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={selected.has(j.id)} onCheckedChange={() => toggle(j.id)} />
                        </td>
                        <td className="px-2 py-2">
                          <p className="font-medium">{j.title}</p>
                          <p className="text-xs text-muted-foreground">{manifestSummary(j.manifest)}</p>
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{j.drop_name ?? j.drop_icao}</td>
                        <td className="px-2 py-2 text-right font-mono">{Math.round(Number(j.cargo_lb)).toLocaleString()} lb</td>
                        <td className="px-2 py-2 text-right font-mono">{j.distance_nm} nm</td>
                        <td className="px-2 py-2 text-right font-mono text-success">${Number(j.payout).toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                          {hours == null ? "—" : `${Math.floor(hours)} h`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Pick a pickup to see what's waiting there.</p>
          )}
        </section>

        <aside className="space-y-4 rounded-lg border border-border bg-card p-5">
          <div>
            <h2 className="flex items-center gap-2 font-semibold">
              <Scale className="h-4 w-4 text-primary" /> Load sheet
            </h2>
            <p className="text-xs text-muted-foreground">
              {chosen.length} job{chosen.length === 1 ? "" : "s"} from {pickup?.name ?? "—"}
            </p>
          </div>

          <div>
            <Label>Aircraft</Label>
            <Select value={aircraftId} onValueChange={setAircraftId}>
              <SelectTrigger>
                <SelectValue placeholder={flyable.length ? "Pick an aircraft" : "No available aircraft"} />
              </SelectTrigger>
              <SelectContent>
                {flyable.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.display_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {ac && (
            <div className="space-y-2">
              <Label>Fuel</Label>
              {fuelCap != null ? (
                <>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={fuelOn} onCheckedChange={(v) => setFuelOn(v === true)} />
                    Set the fuel at pickup
                  </label>
                  {fuelOn && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Input
                          inputMode="numeric"
                          value={fuelLb}
                          onChange={(e) => setFuelLb(e.target.value.replace(/[^\d.]/g, ""))}
                          placeholder="lb"
                        />
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          of {Math.round(fuelCap).toLocaleString()} lb
                        </span>
                      </div>
                      <div className="flex gap-1">
                        {[25, 50, 75, 100].map((p) => (
                          <Button
                            key={p}
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => setFuelLb(String(Math.round((fuelCap * p) / 100)))}
                          >
                            {p}%
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Stays as set in the sim. Load this aircraft in MSFS once with the app running and it
                  learns its tanks and weight limits.
                </p>
              )}
            </div>
          )}

          {check && (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Cargo</dt>
                <dd className="font-mono">{(check.cargoLb - check.pax * PAX_LB).toLocaleString()} lb</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">
                  Passengers {check.pax}/{check.seats}
                </dt>
                <dd className="font-mono">{(check.pax * PAX_LB).toLocaleString()} lb</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Fuel</dt>
                <dd className="font-mono">{fuel != null ? `${Math.round(fuel).toLocaleString()} lb` : "as in the sim"}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-1">
                <dt className="text-muted-foreground">
                  {check.limitSource === "sim" ? "Load + fuel" : "Load"}
                </dt>
                <dd className={`font-mono ${check.overLb > 0 ? "text-destructive" : ""}`}>
                  {check.countedLb.toLocaleString()} / {check.limitLb.toLocaleString()} lb
                </dd>
              </div>
              <div className="h-2 overflow-hidden rounded bg-muted">
                <div
                  className={`h-full ${check.overLb > 0 ? "bg-destructive" : "bg-primary"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {check.limitSource === "sim"
                  ? "Limit: max gross less empty weight, as the sim reports them."
                  : "Limit: catalogue payload, cargo and passengers only, until the sim reports this aircraft's weights."}
              </p>
            </dl>
          )}

          {blockers.length > 0 && (
            <ul className="space-y-1 text-xs text-destructive">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}

          <Button className="w-full" onClick={dispatch} disabled={blockers.length > 0 || !!busy}>
            {busy === "dispatch" ? "Dispatching…" : "Validate and dispatch"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Fly to the pickup and hold still for 8 seconds: the bridge puts the weight aboard
            {fuel != null ? " and sets the fuel" : ""}. Hold still 8 seconds at each drop to unload it
            and get paid.
          </p>
        </aside>
      </div>
    </div>
  );
}
