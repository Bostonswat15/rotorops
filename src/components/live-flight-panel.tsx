import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchCurrentCompany } from "@/lib/company";
import { FlightMap } from "@/components/flight-map";
import { useLiveFlight, useBridgeObjectives, useBridgeScore, useBridgeTrip } from "@/hooks/use-live-flight";
import { searchAreaOf } from "@/lib/missions";
import { INDUSTRY_DEFS, type IndustryKind } from "@/lib/industries";
import { desktop, type BridgeStatus, type TripStatus } from "@/lib/desktop";

/**
 * The live flight readout: telemetry, objective list, and the map.
 *
 * Extracted from the dashboard so the same panel can fill a screen of its own.
 * Reading a hint off a 384 px map while flying is not realistic; on a second
 * monitor the full-screen version is the point of having a bridge at all.
 *
 * Self-contained on purpose. It fetches the contract being flown and the base
 * rather than taking them as props, so a route can drop it in and get a working
 * panel -- the dashboard's own query is for the cards around it, and the two
 * have no reason to stay coupled.
 */
export function LiveFlightPanel({ fill = false }: { fill?: boolean }) {
  const { flight, track } = useLiveFlight();
  const objectives = useBridgeObjectives();
  const trip = useBridgeTrip();
  const [bridge, setBridge] = useState<Pick<BridgeStatus, "simAircraft" | "paired" | "simConnected"> | null>(
    null,
  );
  const simAircraft = bridge?.simAircraft ?? null;
  // A camp picked on the map; the guide line points there until cleared.
  const [flyTo, setFlyTo] = useState<string | null>(null);

  // Only needed to explain why objectives are not arming, or why there is no
  // map at all, so it rides along with the status stream rather than getting
  // its own poll.
  useEffect(() => {
    const app = desktop();
    if (!app) return;
    let live = true;
    const apply = (st: BridgeStatus | null) =>
      live &&
      setBridge(
        st ? { simAircraft: st.simAircraft ?? null, paired: !!st.paired, simConnected: !!st.simConnected } : null,
      );
    app.status().then(apply).catch(() => {});
    const off = app.onStatus(apply);
    return () => {
      live = false;
      off?.();
    };
  }, []);

  const { data } = useQuery({
    queryKey: ["live-flight-context"],
    // The scene only moves when a contract is dispatched or finished, so this
    // is slow polling to catch those. The aircraft position arrives on the
    // bridge's own stream and does not wait for it.
    refetchInterval: flight ? 15000 : false,
    queryFn: async () => {
      const c = await fetchCurrentCompany();
      if (!c) return null;
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return null;
      const [active, bases, fleet, camps] = await Promise.all([
        // Only your own contracts. Another pilot's flight is theirs to watch
        // on their own In Flight -- dispatch stamps assigned_pilot_id with
        // whoever dispatched it. Cargo jobs fly as a trip, shown from the
        // bridge's own status.
        supabase
          .from("missions")
          .select("*")
          .eq("company_id", c.id)
          .eq("status", "in_progress")
          .eq("assigned_pilot_id", u.user.id)
          .is("trip_id", null),
        supabase.from("bases").select("*").eq("company_id", c.id),
        supabase.from("aircraft").select("id, display_name").eq("company_id", c.id),
        // Industry camps, drawn on the map to fly to.
        supabase.from("industries").select("id, kind, name, latitude, longitude").eq("company_id", c.id),
      ]);
      return {
        active: active.data ?? [],
        bases: bases.data ?? [],
        fleet: fleet.data ?? [],
        camps: (camps.data ?? []).filter((i) => i.latitude != null && i.longitude != null),
      };
    },
  });

  // The contract the bridge is actually tracking, not whichever in-progress
  // row came back first. With two dispatched at once the panel drew one
  // contract's search datum over another contract's objective list.
  //
  // A contract dispatched to a different aircraft is that aircraft's flight,
  // not this one: sitting in the 206 with the Cub's type rating in progress
  // drew the Cub's check ride over the 206 as if the 206 were flying it.
  const loadedId = simAircraft?.matchedId ?? null;
  const forLoaded = (m: { aircraft_id: string | null }) =>
    !loadedId || !m.aircraft_id || m.aircraft_id === loadedId;
  const activeMission =
    data?.active.find((m) => m.id === objectives?.missionId) ?? data?.active.find(forLoaded) ?? null;
  const elsewhere = activeMission ? [] : (data?.active ?? []).filter((m) => !forLoaded(m));
  const aircraftName = (id: string | null) =>
    data?.fleet.find((a) => a.id === id)?.display_name ?? "another aircraft";
  const homeBase =
    data?.bases.find((b: any) => b.latitude != null && b.longitude != null) ?? null;
  const campPlaces = (data?.camps ?? []).map((c) => ({
    id: c.id,
    lat: Number(c.latitude),
    lon: Number(c.longitude),
    label: c.name ?? INDUSTRY_DEFS[c.kind as IndustryKind]?.label ?? "Camp",
    selected: c.id === flyTo,
  }));
  const flyToCamp = campPlaces.find((p) => p.selected) ?? null;

  if (!flight) {
    // On the dashboard this panel simply is not there when nothing is flying.
    // On a screen of its own, an empty screen would read as broken -- and one
    // message for every cause left a pilot with no bridge running at all
    // looking for a fault in MSFS. Say which step is missing.
    if (!fill) return null;
    const [headline, detail] = !desktop()
      ? ["In Flight needs the RotorOps desktop app.", "The browser version can't talk to the sim."]
      : !bridge?.paired
        ? [
            "The sim bridge isn't linked yet.",
            "It links itself when the app opens. If this stays, open Settings → Sim Link.",
          ]
        : !bridge.simConnected
          ? ["MSFS isn't connected.", "Start MSFS 2024 and get past the main menu — this connects by itself."]
          : ["Connected to MSFS — waiting for a position.", "Load into a flight and the map fills in by itself."];
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        <div>
          <p>{headline}</p>
          <p className="mt-1">{detail}</p>
        </div>
      </div>
    );
  }

  // Public half of a SAR tasking: where they were last seen, and how far they
  // could have got. Never where they are.
  const searchArea = activeMission ? searchAreaOf(activeMission.objectives) : null;

  // Where to fly next: the objective the bridge is working on, not the scene.
  // A line patrol's scene is its first tower, so with every section ticked
  // the leg still pointed back up the line instead of home. A landing with no
  // position of its own ("Return to base") is placed at the base it names.
  // Once everything is done there is nowhere left to point.
  const live = objectives?.missionId === activeMission?.id ? objectives : null;
  const allDone = !!live && live.items.length > 0 && live.items.every((o) => o.done);
  const legTarget: { lat: number; lon: number; label: string; kind: "next" | "base" | "scene" | "camp" } | null =
    (() => {
      // A camp you picked on the map wins until you clear it.
      if (flyToCamp) return { lat: flyToCamp.lat, lon: flyToCamp.lon, label: flyToCamp.label, kind: "camp" };
      if (!activeMission) return tripTarget(trip, flight);
      if (allDone) return null;
      const raw = (Array.isArray(activeMission.objectives) ? activeMission.objectives : []) as Record<
        string,
        unknown
      >[];
      const currentId = live?.items.find((o) => !o.done)?.id;
      const current = currentId ? raw.find((o) => String(o?.id) === currentId) : null;
      if (current) {
        const lat = current.lat ?? current.datum_lat;
        const lon = current.lon ?? current.datum_lon;
        if (lat != null && lon != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
          return {
            lat: Number(lat),
            lon: Number(lon),
            label: typeof current.label === "string" ? current.label : "Next",
            kind: "next",
          };
        }
        if (current.kind === "land") {
          const icao = String(current.icao ?? "").toUpperCase();
          const named = icao
            ? (data?.bases ?? []).find(
                (b) => b.latitude != null && b.longitude != null && String(b.icao ?? "").toUpperCase() === icao,
              )
            : null;
          const field = named ?? (!icao ? homeBase : null);
          if (field) {
            return {
              lat: Number(field.latitude),
              lon: Number(field.longitude),
              label: field.name ?? "Base",
              kind: "base",
            };
          }
        }
      }
      return activeMission.scene_lat != null
        ? {
            lat: Number(activeMission.scene_lat),
            lon: Number(activeMission.scene_lon),
            label: activeMission.scene_name ?? "Scene",
            kind: "scene",
          }
        : null;
    })();
  const legRange = legTarget ? nmBetween(flight.lat, flight.lon, legTarget.lat, legTarget.lon) : null;
  const legLabel =
    legTarget?.kind === "camp"
      ? "To camp"
      : legTarget?.kind === "base"
        ? "To base"
        : legTarget?.kind === "next"
          ? "To next"
          : "To scene";

  // Every objective that has a place on the map, married up with whether the
  // bridge has ticked it.
  const mapWaypoints = (() => {
    const raw = activeMission?.objectives;
    if (!Array.isArray(raw)) return [];
    // Only this contract's progress. Every medevac shares objective ids --
    // reach, hover, land_scene, load, deliver -- so a finished contract's
    // ticks, still held by the bridge, used to paint the next contract's
    // waypoints as done before it had been flown.
    const live = objectives?.missionId === activeMission?.id ? objectives : null;
    const doneById = new Map<string, boolean>(
      (live?.items ?? []).map((o) => [o.id, !!o.done] as [string, boolean]),
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
    <div
      className={
        fill
          // min-w-0 and overflow-hidden together: a flex child refuses to
          // shrink below its content by default, so the readout row -- six
          // items that only wrap if they are allowed to -- pushed the panel
          // wider than the window and clipped the last one.
          ? "flex h-full min-w-0 flex-col gap-3 overflow-hidden p-3"
          : "rounded-lg border border-primary/40 bg-card p-4"
      }
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-primary">
            {flight.hours != null ? "In flight" : flight.onGround ? "On the ground" : "Airborne"}
          </p>
          <p className={`mt-1 font-medium ${fill ? "text-lg" : ""}`}>
            {flight.simTitle ?? "Aircraft"}
            {activeMission ? ` · ${activeMission.title}` : " · positioning"}
          </p>
        </div>
        <div className={`flex flex-wrap justify-end font-mono ${fill ? "gap-x-6 gap-y-1 text-base" : "gap-4 text-sm"}`}>
          <Readout label="GS" value={`${Math.round(flight.groundSpeed)} kt`} />
          <Readout label="AGL" value={`${Math.round(flight.agl)} ft`} />
          {flight.hours != null && <Readout label="Time" value={`${flight.hours.toFixed(2)} h`} />}
          {flight.fuelUsed != null && (
            <Readout label="Fuel" value={`${Math.round(flight.fuelUsed)} lb`} />
          )}
          {flight.distance != null && (
            <Readout label="Track" value={`${flight.distance.toFixed(1)} nm`} />
          )}
          {legRange != null && <Readout label={legLabel} value={`${legRange.toFixed(1)} nm`} />}
        </div>
      </div>

      {/*
        The map draws its rings from the database, so a contract whose
        objectives never armed in the bridge looks entirely normal here and
        simply never ticks. Worth saying plainly rather than leaving someone to
        fly a whole patrol that was never being watched.
      */}
      {activeMission && !objectives && (
        <p className="rounded-lg border border-warning/40 bg-card px-4 py-3 text-sm text-warning">
          "{activeMission.title}" is in progress, but the sim bridge is not tracking it,
          so nothing will tick.{" "}
          {simAircraft && !simAircraft.matchedName
            ? `The aircraft loaded in the sim ("${simAircraft.simTitle}") is not in your fleet — link it on Settings → Sim Link.`
            : "Check that the contract is dispatched to the aircraft you are flying."}
        </p>
      )}

      {elsewhere.length > 0 && (
        <p className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          {elsewhere.map((m) => `"${m.title}" is dispatched to ${aircraftName(m.aircraft_id)}`).join("; ")}, not
          the aircraft loaded in the sim. This flight doesn't count toward it — load that aircraft in MSFS
          to fly it.
        </p>
      )}

      <LiveScore />

      <LiveObjectives state={objectives} fill={fill} />

      {trip && <TripCard trip={trip} />}

      {/*
        Every objective ticked is not the same as the contract being logged.
        The bridge closes it out once the aircraft is down and still -- but
        after a restart it has no flown segment to submit, and said so only
        in a log file nobody reads mid-flight. Say it where the pilot is
        looking, including the way out.
      */}
      {objectives && objectives.items.length > 0 && objectives.items.every((o) => o.done) && (
        <p className="rounded-lg border border-success/40 bg-card px-4 py-3 text-sm text-success">
          All objectives complete. Set down and hold still for a few seconds and the flight is
          logged. If the contract is still on the board after that, use{" "}
          <span className="font-medium">Log manually</span> on the Mission Board.
        </p>
      )}

      {/*
        Picking a camp from a list, nearest first. A marker is a few pixels at
        the zoom a 40 nm leg needs, so clicking the map alone meant hunting for
        it before you could head there.
      */}
      {campPlaces.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2 text-sm">
          <label className="flex items-center gap-2">
            <span className="text-muted-foreground">Fly to camp</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={flyTo ?? ""}
              onChange={(e) => setFlyTo(e.target.value || null)}
            >
              <option value="">— none —</option>
              {campPlaces
                .map((p) => ({ p, nm: nmBetween(flight.lat, flight.lon, p.lat, p.lon) }))
                .sort((a, b) => a.nm - b.nm)
                .map(({ p, nm }) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {nm.toFixed(0)} nm
                  </option>
                ))}
            </select>
          </label>
          {flyToCamp ? (
            <span className="flex items-center gap-3">
              <span>
                Guide line to <span className="font-medium">{flyToCamp.label}</span>
              </span>
              <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setFlyTo(null)}>
                Clear
              </button>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">or click a camp on the map</span>
          )}
        </div>
      )}

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
        next={legTarget}
        waypoints={activeMission ? mapWaypoints : tripWaypoints(trip)}
        search={searchArea}
        sighted={objectives?.sighted ?? null}
        base={
          homeBase
            ? { lat: Number(homeBase.latitude), lon: Number(homeBase.longitude), label: homeBase.name }
            : null
        }
        track={track}
        places={campPlaces}
        onPlaceClick={(id) => setFlyTo((cur) => (cur === id ? null : id))}
        // Filling the screen means the map takes whatever is left after the
        // readouts and the objective list, rather than a fixed 384 px. min-h-0
        // matters: without it a flex child refuses to shrink below its content
        // and the map pushes the page into a scroll instead of fitting.
        className={
          fill
            ? "min-h-0 w-full flex-1 rounded-lg border border-border"
            : "h-96 w-full rounded-lg border border-border"
        }
      />
    </div>
  );
}

/**
 * Where a cargo trip goes next: the pickup until it is loaded, then the
 * nearest drop still to make.
 */
function tripTarget(
  trip: TripStatus | null,
  at: { lat: number; lon: number },
): { lat: number; lon: number; label: string; kind: "next" } | null {
  if (!trip) return null;
  if (!trip.loaded) {
    return trip.pickupLat != null && trip.pickupLon != null
      ? { lat: trip.pickupLat, lon: trip.pickupLon, label: `Load at ${trip.pickup ?? "the pickup"}`, kind: "next" }
      : null;
  }
  let best: { lat: number; lon: number; label: string; kind: "next" } | null = null;
  let bestNm = Infinity;
  for (const j of trip.jobs) {
    if (j.delivered || j.lat == null || j.lon == null) continue;
    const d = nmBetween(at.lat, at.lon, j.lat, j.lon);
    if (d < bestNm) {
      bestNm = d;
      best = { lat: j.lat, lon: j.lon, label: `Drop at ${j.drop ?? "the next stop"}`, kind: "next" };
    }
  }
  return best;
}

/** A trip's pickup and drops as map rings, sized as the bridge counts them. */
function tripWaypoints(trip: TripStatus | null) {
  if (!trip) return [];
  const ring = (r: number | null, fallback: number) => Math.max(0.25, (r ?? fallback) * 1.35);
  const points = [];
  if (trip.pickupLat != null && trip.pickupLon != null) {
    points.push({
      id: `pickup-${trip.id}`,
      lat: trip.pickupLat,
      lon: trip.pickupLon,
      radiusNm: ring(trip.pickupRadiusNm, 2),
      label: `Load at ${trip.pickup ?? "the pickup"}`,
      done: trip.loaded,
    });
  }
  for (const j of trip.jobs) {
    if (j.lat == null || j.lon == null) continue;
    points.push({
      id: `drop-${j.id}`,
      lat: j.lat,
      lon: j.lon,
      radiusNm: ring(j.radiusNm, 2),
      label: `${j.title}`,
      done: j.delivered,
    });
  }
  return points;
}

/** The cargo trip being flown: what is aboard, what is left, and what to do now. */
function TripCard({ trip }: { trip: TripStatus }) {
  const left = trip.jobs.filter((j) => !j.delivered).length;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Cargo trip ·{" "}
          {trip.loaded
            ? `${trip.aboardLb.toLocaleString()} lb aboard · ${left} of ${trip.jobs.length} to deliver`
            : `load at ${trip.pickup ?? "the pickup"}`}
        </p>
        <p className="text-xs text-warning">{trip.hint}</p>
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {trip.jobs.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-3">
            <span className={j.delivered ? "text-success" : ""}>
              {j.delivered ? "✓ " : "• "}
              {j.title}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{j.drop}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The flight score as it stands. Each deduction is listed the moment it lands,
 * so a lost point is explained while the pilot can still see why.
 */
function LiveScore() {
  const s = useBridgeScore();
  if (!s) return null;
  const tone =
    s.grade === "A"
      ? "text-success"
      : s.grade === "C"
        ? "text-warning"
        : s.grade === "D" || s.grade === "F"
          ? "text-destructive"
          : "text-foreground";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Score</span>
        <span className={`text-2xl font-semibold ${tone}`}>{s.grade}</span>
        <span className="font-mono text-sm text-muted-foreground">{s.score}/100</span>
      </div>
      {s.items.length === 0 ? (
        <span className="text-xs text-muted-foreground">Clean so far</span>
      ) : (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {s.items.map((i) => (
            <li key={i.code}>
              {i.label}{" "}
              <span className={`font-mono ${i.points < 0 ? "text-destructive" : "text-success"}`}>
                {i.points > 0 ? "+" : ""}
                {i.points}
              </span>
            </li>
          ))}
        </ul>
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

/** What the bridge is currently waiting for. */
function LiveObjectives({
  state,
  fill = false,
}: {
  state: BridgeStatus["objectives"];
  fill?: boolean;
}) {
  if (!state || state.items.length === 0) return null;
  const nextIdx = state.items.findIndex((o) => !o.done);

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {state.missionTitle}
      </p>
      <ol className="mt-2 space-y-1">
        {state.items.map((o, i) => {
          const isNext = i === nextIdx;
          return (
            <li
              key={o.id}
              className={`flex items-center gap-2 ${fill ? "text-base" : "text-sm"} ${
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
