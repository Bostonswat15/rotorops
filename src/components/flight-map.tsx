import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type MapPosition = { lat: number; lon: number; heading?: number };

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
  /** Home field. */
  base?: { lat: number; lon: number; label?: string } | null;
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
export function FlightMap({ aircraft, scene, base, track = [], className }: FlightMapProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{
    aircraft?: L.Marker;
    scene?: L.CircleMarker;
    base?: L.CircleMarker;
    track?: L.Polyline;
    legTo?: L.Polyline;
  }>({});
  // Stop recentring once the user has panned somewhere deliberately.
  const followed = useRef(true);

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

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(m);

    m.on("dragstart", () => {
      followed.current = false;
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
  }, [scene?.lat, scene?.lon, base?.lat, base?.lon, scene?.label, base?.label]);

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
    <div
      ref={holder}
      className={className ?? "h-80 w-full rounded-lg border border-border"}
      // Leaflet paints its own background; without this the panel flashes white
      // in dark mode before the first tiles arrive.
      style={{ background: "#0b1220" }}
    />
    </>
  );
}
