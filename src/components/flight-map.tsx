import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapPosition = { lat: number; lon: number; heading?: number };

/**
 * Base layers.
 *
 * Satellite matters here in a way it doesn't on a road map: a scene is
 * usually a clearing, a ridge or a stretch of water with no road near it,
 * and the drawn map shows none of that. Esri's imagery is the same service
 * Leaflet's own examples use and needs no key.
 */
const BASEMAPS = {
  map: {
    label: "Map",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 17,
  },
  satellite: {
    label: "Satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
    maxZoom: 18,
  },
} as const;

type BaseMapId = keyof typeof BASEMAPS;

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;

function haversineNm(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing, degrees true. */
function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dLon = rad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(rad(bLat));
  const x =
    Math.cos(rad(aLat)) * Math.sin(rad(bLat)) -
    Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export type FlightMapProps = {
  /** Live aircraft position from the sim bridge. */
  aircraft: MapPosition | null;
  /** Where the job is. */
  scene?: { lat: number; lon: number; label?: string } | null;
  /**
   * A SAR search area: the datum and how far the casualty might have got.
   *
   * Only the circle is drawn, because only the circle is known -- the real
   * position lives in the sim bridge and is never sent here.
   */
  search?: { lat: number; lon: number; radiusNm: number } | null;
  /** The casualty, once the search has actually turned them up. */
  sighted?: { lat: number; lon: number } | null;
  /** Home field. */
  base?: { lat: number; lon: number; label?: string } | null;
  /**
   * Every objective that has a position, with the radius that actually
   * counts as reaching it.
   *
   * A multi-point contract -- a line patrol especially -- used to draw only
   * its first point, so five of six inspection sections were invisible and
   * the acceptance radius was invisible everywhere. Flying to an unmarked
   * point and guessing how close is close enough is what "the zone is too
   * small" actually feels like from the cockpit.
   */
  waypoints?: {
    id: string;
    lat: number;
    lon: number;
    radiusNm: number;
    label?: string;
    done?: boolean;
  }[];
  /** Breadcrumb of where the aircraft has been this flight. */
  track?: [number, number][];
  className?: string;
};

/**
 * Moving map for the flight in progress.
 *
 * Tiles come from OpenStreetMap. If they can't load -- no network, or the tile
 * server is unhappy -- the aircraft, scene, base and track still draw over the
 * background, so the display degrades to a usable tactical plot rather than a
 * blank panel.
 */
export function FlightMap({
  aircraft, scene, search, sighted, base, waypoints = [], track = [], className,
}: FlightMapProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{
    aircraft?: L.Marker;
    scene?: L.CircleMarker;
    search?: L.Circle;
    sighted?: L.CircleMarker;
    base?: L.CircleMarker;
    track?: L.Polyline;
    legTo?: L.Polyline;
    waypoints?: L.LayerGroup;
    route?: L.Polyline;
  }>({});
  const tiles = useRef<L.TileLayer | null>(null);
  // Stop recentring once the user has panned somewhere deliberately. Mirrored
  // into state as well so the Follow control can show whether it is currently
  // on, rather than being a button with no visible effect.
  const followed = useRef(true);
  const [following, setFollowing] = useState(true);
  const [basemap, setBasemap] = useState<BaseMapId>("map");

  useEffect(() => {
    if (!holder.current || map.current) return;

    const start: [number, number] = aircraft
      ? [aircraft.lat, aircraft.lon]
      : scene
        ? [scene.lat, scene.lon]
        : base
          ? [base.lat, base.lon]
          : [0, 0];

    const m = L.map(holder.current, {
      center: start,
      zoom: 11,
      zoomControl: true,
      attributionControl: true,
    });

    const first = BASEMAPS.map;
    tiles.current = L.tileLayer(first.url, {
      maxZoom: first.maxZoom,
      attribution: first.attribution,
    }).addTo(m);

    // Dragging means you want to look at something specific; stop pulling the
    // view back to the aircraft until Follow is asked for again.
    m.on("dragstart", () => {
      followed.current = false;
      setFollowing(false);
    });

    map.current = m;
    // Leaflet measures its container on creation; in a panel that was still
    // laying out, that comes back zero and the tiles never paint.
    setTimeout(() => m.invalidateSize(), 0);

    return () => {
      m.remove();
      map.current = null;
      layers.current = {};
    };
    // Built once; everything after is imperative updates below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swapping the base layer leaves every overlay -- aircraft, track, scene,
  // search ring -- exactly where it is: only the tile layer is replaced.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const next = BASEMAPS[basemap];
    tiles.current?.remove();
    tiles.current = L.tileLayer(next.url, {
      maxZoom: next.maxZoom,
      attribution: next.attribution,
    }).addTo(m);
    tiles.current.bringToBack();
  }, [basemap]);

  // Objective markers: redrawn as a group whenever the set or their done
  // state changes, which is cheap at these counts and far simpler than
  // diffing individual circles.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layers.current.waypoints?.remove();
    layers.current.route?.remove();
    layers.current.waypoints = undefined;
    layers.current.route = undefined;
    if (waypoints.length === 0) return;

    const group = L.layerGroup().addTo(m);
    // The order they must be flown, so a line patrol reads as a route
    // rather than a scatter of rings.
    if (waypoints.length > 1) {
      layers.current.route = L.polyline(
        waypoints.map((w) => [w.lat, w.lon] as [number, number]),
        { color: "#f5a623", weight: 2, opacity: 0.45, dashArray: "4 8" },
      ).addTo(m);
    }

    waypoints.forEach((w, i) => {
      const colour = w.done ? "#4ade80" : "#f5a623";
      // One ring, drawn at the real acceptance distance so you can judge from
      // the map whether you are inside it. A centre dot was tried as well and
      // read as a second, tighter zone you had to hit -- two rings around one
      // point invite the question of which one counts.
      L.circle([w.lat, w.lon], {
        radius: w.radiusNm * 1852,
        color: colour,
        weight: 2,
        opacity: w.done ? 0.5 : 0.9,
        fillColor: colour,
        fillOpacity: w.done ? 0.05 : 0.12,
      })
        .addTo(group)
        .bindTooltip(w.label ?? `Point ${i + 1}`, { direction: "top" });
    });
    layers.current.waypoints = group;
  }, [waypoints]);

  // Scene and base are fixed for the duration of a contract.
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    if (scene) {
      const pos: [number, number] = [scene.lat, scene.lon];
      if (!layers.current.scene) {
        // A halo underneath gives the site presence at low zoom.
        L.circleMarker(pos, {
          radius: 26,
          color: "#f5a623",
          weight: 1,
          opacity: 0.5,
          fillColor: "#f5a623",
          fillOpacity: 0.12,
        }).addTo(m);
        layers.current.scene = L.circleMarker(pos, {
          radius: 16,
          color: "#f5a623",
          weight: 4,
          fillColor: "#f5a623",
          fillOpacity: 0.45,
        })
          .addTo(m)
          .bindTooltip(scene.label ?? "Scene", {
            permanent: true,
            direction: "top",
            offset: [0, -8],
            className: "rotorops-scene-label",
          });
      } else {
        layers.current.scene.setLatLng(pos);
      }
    }

    // The tasked area. Radius is real distance, so it scales with the map and
    // you can judge a search pattern against it.
    if (search) {
      const pos: [number, number] = [search.lat, search.lon];
      if (!layers.current.search) {
        layers.current.search = L.circle(pos, {
          radius: search.radiusNm * 1852,
          color: "#f5a623",
          weight: 2,
          dashArray: "6 6",
          fillColor: "#f5a623",
          fillOpacity: 0.06,
        }).addTo(m);
      } else {
        layers.current.search.setLatLng(pos);
        layers.current.search.setRadius(search.radiusNm * 1852);
      }
    } else if (layers.current.search) {
      layers.current.search.remove();
      layers.current.search = undefined;
    }

    if (base) {
      const pos: [number, number] = [base.lat, base.lon];
      if (!layers.current.base) {
        layers.current.base = L.circleMarker(pos, {
          radius: 11,
          color: "#4ade80",
          weight: 3,
          fillColor: "#4ade80",
          fillOpacity: 0.6,
        })
          .addTo(m)
          .bindTooltip(base.label ?? "Base", { permanent: false });
      } else {
        layers.current.base.setLatLng(pos);
      }
    }

    // Drawn only once the bridge reports a sighting -- before that the app has
    // no idea where the casualty is, which is the whole point of the search.
    if (sighted) {
      const pos: [number, number] = [sighted.lat, sighted.lon];
      if (!layers.current.sighted) {
        layers.current.sighted = L.circleMarker(pos, {
          radius: 9,
          color: "#ef4444",
          weight: 4,
          fillColor: "#ef4444",
          fillOpacity: 0.85,
        })
          .addTo(m)
          .bindTooltip("Casualty", {
            permanent: true,
            direction: "top",
            offset: [0, -8],
            className: "rotorops-scene-label",
          });
      } else {
        layers.current.sighted.setLatLng(pos);
      }
    } else if (layers.current.sighted) {
      layers.current.sighted.remove();
      layers.current.sighted = undefined;
    }
  }, [
    scene?.lat, scene?.lon, scene?.label,
    search?.lat, search?.lon, search?.radiusNm,
    sighted?.lat, sighted?.lon,
    base?.lat, base?.lon, base?.label,
  ]);

  // Aircraft, track and the leg to the scene move every sample.
  useEffect(() => {
    const m = map.current;
    if (!m || !aircraft) return;
    const pos: [number, number] = [aircraft.lat, aircraft.lon];

    if (!layers.current.aircraft) {
      layers.current.aircraft = L.marker(pos, {
        icon: L.divIcon({
          className: "rotorops-aircraft",
          html: `<div style="
            width:0;height:0;
            border-left:13px solid transparent;
            border-right:13px solid transparent;
            border-bottom:32px solid #38bdf8;
            transform: rotate(${aircraft.heading ?? 0}deg);
            transform-origin: 50% 65%;
            filter: drop-shadow(0 0 4px rgba(0,0,0,.9));
          "></div>`,
          iconSize: [26, 32],
          iconAnchor: [13, 21],
        }),
      }).addTo(m);
    } else {
      layers.current.aircraft.setLatLng(pos);
      const el = layers.current.aircraft.getElement()?.firstElementChild as HTMLElement | null;
      if (el) el.style.transform = `rotate(${aircraft.heading ?? 0}deg)`;
    }

    if (track.length > 1) {
      if (!layers.current.track) {
        layers.current.track = L.polyline(track, {
          color: "#38bdf8",
          weight: 3,
          opacity: 0.75,
        }).addTo(m);
      } else {
        layers.current.track.setLatLngs(track);
      }
    }

    // The leg to the job: a clear line you can follow, labelled with range.
    if (scene) {
      const leg: [number, number][] = [pos, [scene.lat, scene.lon]];
      if (!layers.current.legTo) {
        layers.current.legTo = L.polyline(leg, {
          color: "#f5a623",
          weight: 3,
          opacity: 0.9,
          dashArray: "10 7",
        }).addTo(m);
      } else {
        layers.current.legTo.setLatLngs(leg);
      }

      const rangeNm = haversineNm(pos[0], pos[1], scene.lat, scene.lon);
      const brg = bearingDeg(pos[0], pos[1], scene.lat, scene.lon);
      layers.current.legTo.bindTooltip(
        `${scene.label ?? "Scene"} · ${rangeNm.toFixed(1)} nm · ${Math.round(brg)}°`,
        { sticky: true },
      );
    }

    if (followed.current) m.panTo(pos, { animate: true, duration: 0.5 });
  }, [aircraft?.lat, aircraft?.lon, aircraft?.heading, track.length, scene?.lat, scene?.lon]);

  return (
    <>
      <style>{`
        .rotorops-scene-label {
          background: rgba(12,18,28,.9);
          border: 1px solid #f5a623;
          color: #f5a623;
          font-weight: 600;
          font-size: 13px;
          padding: 3px 8px;
          box-shadow: 0 2px 8px rgba(0,0,0,.6);
        }
        .rotorops-scene-label::before { border-top-color: #f5a623 !important; }
      `}</style>
    <div className="relative isolate">
      <div
        ref={holder}
        className={className ?? "h-80 w-full rounded-lg border border-border"}
        // Leaflet paints its own background; without this the panel flashes white
        // in dark mode before the first tiles arrive.
        style={{ background: "#0b1220" }}
      />
      {/*
        Above the map, so z-index is relative to the isolate wrapper rather
        than fighting Leaflet's own panes (which run to 1000+).
      */}
      <div className="pointer-events-none absolute right-2 top-2 z-[500] flex gap-1">
        <button
          type="button"
          onClick={() => {
            followed.current = true;
            setFollowing(true);
            if (aircraft && map.current) {
              map.current.panTo([aircraft.lat, aircraft.lon], { animate: true });
            }
          }}
          className={`pointer-events-auto rounded px-2 py-1 text-xs font-medium shadow-md transition-colors ${
            following
              ? "bg-primary text-primary-foreground"
              : "bg-card/95 text-muted-foreground hover:text-foreground"
          }`}
          title={following ? "Following the aircraft — drag the map to stop" : "Recentre and follow the aircraft"}
        >
          {following ? "Following" : "Follow"}
        </button>
        {(Object.keys(BASEMAPS) as BaseMapId[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setBasemap(id)}
            className={`pointer-events-auto rounded px-2 py-1 text-xs font-medium shadow-md transition-colors ${
              basemap === id
                ? "bg-primary text-primary-foreground"
                : "bg-card/95 text-muted-foreground hover:text-foreground"
            }`}
          >
            {BASEMAPS[id].label}
          </button>
        ))}
      </div>
    </div>
    </>
  );
}
