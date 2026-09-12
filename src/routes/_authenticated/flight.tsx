import { createFileRoute } from "@tanstack/react-router";
import { LiveFlightPanel } from "@/components/live-flight-panel";

export const Route = createFileRoute("/_authenticated/flight")({
  head: () => ({ meta: [{ title: "In Flight — RotorOps" }] }),
  component: FlightPage,
});

/**
 * The live flight panel with the whole screen to itself.
 *
 * Same data as the dashboard card, no cards around it: the map takes every
 * pixel left after the readouts and the objective list. Meant for a second
 * monitor beside the sim, where a 384 px map and a hint you have to lean in to
 * read are the difference between the bridge being useful and being ignored.
 *
 * h-full rather than min-h-screen -- the layout's <main> is already the height
 * of the viewport, so asking for a screen inside it would add a scrollbar
 * exactly one header tall.
 */
function FlightPage() {
  return (
    <div className="h-full">
      <LiveFlightPanel fill />
    </div>
  );
}
