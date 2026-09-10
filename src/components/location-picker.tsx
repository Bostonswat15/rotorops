import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export type LocationPickerProps = {
  /** Current picked position, or null before anything has been placed. */
  value: { lat: number; lon: number } | null;
  onChange: (lat: number, lon: number) => void;
  /** Where to center the map before anything is picked -- usually the home base. */
  center?: { lat: number; lon: number } | null;
  /** Existing sites to show for context, so a new camp isn't dropped on top of one. */
  markers?: { lat: number; lon: number; label?: string }[];
  className?: string;
};

/**
 * Click-anywhere map for picking a lat/lon, used wherever a site gets placed
 * by hand (building a camp, and anywhere else that grows the same need).
 *
 * Typing coordinates by hand invites transposed digits that silently put a
 * camp in the wrong hemisphere; clicking a map can't do that.
 */
export function LocationPicker({ value, onChange, center, markers = [], className }: LocationPickerProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const pin = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!holder.current || map.current) return;

    const start: [number, number] = value
      ? [value.lat, value.lon]
      : center
        ? [center.lat, center.lon]
        : [0, 0];

    const m = L.map(holder.current, {
      center: start,
      zoom: value || center ? 10 : 2,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(m);

    m.on("click", (e: L.LeafletMouseEvent) => {
      onChangeRef.current(Number(e.latlng.lat.toFixed(5)), Number(e.latlng.lng.toFixed(5)));
    });

    for (const site of markers) {
      L.circleMarker([site.lat, site.lon], {
        radius: 6,
        color: "#8b98ab",
        weight: 2,
        fillColor: "#8b98ab",
        fillOpacity: 0.5,
      })
        .addTo(m)
        .bindTooltip(site.label ?? "Existing site", { direction: "top", offset: [0, -6] });
    }

    map.current = m;
    setTimeout(() => m.invalidateSize(), 0);

    return () => {
      m.remove();
      map.current = null;
      pin.current = null;
    };
    // Built once; markers/center are context for the initial view only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The pin itself: draggable, and re-syncs if the coordinate boxes are
  // edited by hand instead of clicked.
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    if (!value) {
      pin.current?.remove();
      pin.current = null;
      return;
    }

    const pos: [number, number] = [value.lat, value.lon];
    if (!pin.current) {
      pin.current = L.marker(pos, { draggable: true })
        .addTo(m)
        .on("dragend", () => {
          const p = pin.current!.getLatLng();
          onChangeRef.current(Number(p.lat.toFixed(5)), Number(p.lng.toFixed(5)));
        });
    } else {
      pin.current.setLatLng(pos);
    }
  }, [value?.lat, value?.lon]);

  return (
    <div
      ref={holder}
      className={className ?? "h-56 w-full rounded-lg border border-border"}
      style={{ background: "#0b1220" }}
    />
  );
}
