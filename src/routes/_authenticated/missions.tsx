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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Briefcase, Zap, AlertTriangle, Radio, PlaneTakeoff, PlaneLanding, Trash2, MapPin, GraduationCap } from "lucide-react";
import {
  ratingOf, isRatingRide, CHECKOUT_RATING, RATING_FEE, RATING_PASS_SCORE,
} from "@/lib/ratings";
import {
  MISSION_TEMPLATES,
  generateMissionFromTemplate,
  isAircraftEligible,
  companyHasCerts,
  fleetWing,
  isFixedWingAircraft,
  TAG_LABELS,
} from "@/lib/game-data";
import { useCompanyRole } from "@/hooks/use-company";
import {
  SCENE_TEMPLATES, SCENE_LABELS, generateSceneMission, generatePowerlinePatrol,
  siteAvailability, sceneIsFlyable, summariseSites, parsePlacementSites,
  type SceneType, type PlacementSites,
} from "@/lib/missions";
import { findSites, findIndustrySites, findCliffs } from "@/lib/osm";
import { airfieldsNear } from "@/lib/airfields";
import { isCargoJob } from "@/lib/cargo";
import { isPlaneCheckride } from "@/lib/checkrides";
import { isIndustryMode, showsInIndustryMode, withFreight, ownsIndustry, INDUSTRY_MODE_HAULS } from "@/lib/play-mode";
import { cliffSitesFrom } from "@/lib/missions";
import {
  FIXED_WING_TEMPLATES, generateFixedWingMission, isFixedWingMission, stripOf, fleetCanFly,
} from "@/lib/fixed-wing";
import { CHARTER_TEMPLATES, generateCharterMission } from "@/lib/charter";
import {
  siteIndustries, generateIndustryHaul, generateMarketHaul, generatePlaneHaul, pickMarket,
  INDUSTRY_DEFS,
  type IndustryRow,
} from "@/lib/industries";


export const Route = createFileRoute("/_authenticated/missions")({
  head: () => ({ meta: [{ title: "Mission Board — RotorOps" }] }),
  component: MissionsPage,
});

function MissionsPage() {
  const qc = useQueryClient();
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [generating, setGenerating] = useState(false);
  // Helicopters and aeroplanes fly completely different work, so the board is
  // split rather than mixed -- you are usually shopping for one or the other.
  // Null until someone picks a tab; the fleet decides until then.
  const [pickedWing, setWing] = useState<"rotary" | "fixed" | null>(null);
  const [manualFor, setManualFor] = useState<any | null>(null);
  const { canManage, isOwner, role } = useCompanyRole();

  const { data: company } = useQuery({
    queryKey: ["company"],
    queryFn: fetchCurrentCompany,
  });
  // RLS returns every company you belong to, so scope to the one that's open.
  const { data: missions } = useQuery({
    queryKey: ["missions", company?.id],
    enabled: !!company?.id,
    queryFn: async () =>
      (
        await supabase
          .from("missions")
          .select("*")
          .eq("company_id", company!.id)
          .order("generated_at", { ascending: false })
      ).data ?? [],
  });
  const { data: aircraft } = useQuery({
    queryKey: ["aircraft", company?.id],
    enabled: !!company?.id,
    queryFn: async () => (await supabase.from("aircraft").select("*").eq("company_id", company!.id)).data ?? [],
  });
  // A plane company shouldn't land on the helicopter half of its own board.
  const wing = pickedWing ?? fleetWing(aircraft);
  const { data: bases } = useQuery({
    queryKey: ["bases", company?.id],
    enabled: !!company?.id,
    queryFn: async () => (await supabase.from("bases").select("*").eq("company_id", company!.id)).data ?? [],
  });
  const { data: industries } = useQuery({
    queryKey: ["industries", company?.id],
    enabled: !!company?.id,
    queryFn: async () =>
      (await supabase.from("industries").select("*").eq("company_id", company!.id)).data ?? [],
  });

  // Check rides. Ratings are null until the pilot ratings migration is run,
  // which leaves the board as it was rather than locking everyone out.
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
  });
  const { data: ratings } = useQuery({
    queryKey: ["pilot_ratings", company?.id],
    enabled: !!company?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pilot_ratings")
        .select("*")
        .eq("company_id", company!.id);
      return error ? null : data;
    },
  });
  // The server books rides on joining and on every purchase; this puts back
  // any that went missing. Idempotent, and the owner has none.
  useEffect(() => {
    if (!company?.id || !role || role === "owner") return;
    supabase.rpc("ensure_my_rating_rides", { _company_id: company.id }).then(({ error }) => {
      if (error) return;
      qc.invalidateQueries({ queryKey: ["missions"] });
      qc.invalidateQueries({ queryKey: ["pilot_ratings"] });
    });
  }, [company?.id, role, qc]);
  const myRatings = ratings && me ? ratings.filter((r) => r.user_id === me) : null;
  const myPending = isOwner || !myRatings ? [] : myRatings.filter((r) => !r.passed_at);

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
  /**
   * Generate one half of the board: the tab you're looking at.
   *
   * Both halves used to generate together, so every click waited on every
   * Overpass lookup either side needs -- the site scan and cliffs for
   * helicopters, airfields and their runways for planes, the power lines
   * twice -- to fill a tab you weren't looking at.
   */
  async function generateBatch() {
    if (!company || generating) return;
    setGenerating(true);
    try {
      await generateFor(wing === "rotary");
    } finally {
      setGenerating(false);
    }
  }

  async function generateFor(heli: boolean) {
    if (!company) return;
    const base = locatedBase;
    // Industry mode: only goods work for the company's own sites.
    const industryMode = isIndustryMode(company);

    let rows: any[] = [];
    // Where the patrols already on the board start, so a new one follows another line.
    const patrolStarts = (missions ?? [])
      .filter(
        (m) =>
          m.role === "patrol" &&
          (m.status === "available" || m.status === "in_progress") &&
          m.scene_lat != null &&
          m.scene_lon != null,
      )
      .map((m) => ({ lat: Number(m.scene_lat), lon: Number(m.scene_lon) }));
    let droppedForSites = 0;
    let rotaryNote: string | null = null;
    if (base) {
      const centre = { lat: Number(base.latitude), lon: Number(base.longitude) };

      // What is actually around this base -- water to ditch a boat in, roads to
      // close, hospitals to deliver to. Without asking, the board offered vessel
      // work from landlocked fields and put motorway pile-ups in paddocks.
      //
      // The Overpass lookup runs to the best part of a minute, so it happens
      // once per base and is cached on the row. Everyone in the company
      // benefits from whoever generated first.
      //
      // `sites_scanned_at`, not the contents, decides whether we've looked: a
      // base with genuinely no water caches an empty result, and that is an
      // answer worth keeping.
      //
      // Only helicopter work scans. Planes use the cached result when there is
      // one (a floatplane's water, a hopper's coastal title) and do without
      // otherwise, rather than wait a minute for it.
      let sites: PlacementSites | null = base.sites_scanned_at
        ? parsePlacementSites(base.placement_sites)
        : null;
      if (heli && !sites && !industryMode) {
        const scanning = toast.loading("Scanning the area — roads, water, cliffs and hospitals. This takes a moment.");
        try {
          const raw = await findSites(centre, 50);
          if (raw) {
            sites = summariseSites(raw, centre, 50);
            const { error: wErr } = await supabase.rpc("set_base_sites", {
              _base_id: base.id,
              _sites: sites as unknown as never,
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
      // Cliffs were added to the scan after most bases had been scanned, and a
      // cliff lookup can fail on its own. Either way the cached sites carry no
      // cliff key -- unknown, not absent -- so fill in just the cliffs: one
      // lookup is a fraction of a full rescan, and it leaves the roads, water
      // and hospitals already cached alone. A failure stays unknown and is
      // tried again on the next batch.
      if (heli && sites && sites.cliff === undefined && !industryMode) {
        const finding = toast.loading("Finding cliffs for rescue scenes…");
        try {
          const cliffs = await findCliffs(centre, 50);
          if (cliffs) {
            sites = { ...sites, cliff: cliffSitesFrom(cliffs, centre) };
            const { error: cErr } = await supabase.rpc("set_base_sites", {
              _base_id: base.id,
              _sites: sites as unknown as never,
            });
            if (!cErr) qc.invalidateQueries({ queryKey: ["bases"] });
          }
        } catch {
          // Unknown stays unknown; the next batch tries again.
        } finally {
          toast.dismiss(finding);
        }
      }

      // The sim's airfields and OSM's, merged (src/lib/airfields.ts). Planes
      // need each field's runways; a helicopter lands beside them.
      const airports = await airfieldsNear(base, !heli);

      const site = {
        lat: centre.lat,
        lon: centre.lon,
        icao: base.icao,
        airports,
        sites,
      };

      if (industryMode) {
        // No scene, charter, patrol or aeroplane contracts -- only the goods work below.
      } else if (heli) {
        // Certification or siting coming up short for scene work skips only
        // the scenes and records why; charters, the line patrol and hauls
        // still generate.
        const avail = siteAvailability(sites);
        const certified = SCENE_TEMPLATES.filter((t) =>
          companyHasCerts(company.certifications, t.required_certs),
        );
        const pool = certified.filter((t) => sceneIsFlyable(t.scene_type, avail));
        droppedForSites = certified.length - pool.length;
        if (certified.length === 0) {
          rotaryNote = "no rotary contracts match your certifications yet";
        } else if (pool.length === 0) {
          rotaryNote = "every rotary contract you're certified for needs water or a road, and there's neither near this base";
        }

        if (pool.length > 0) {
          rows.push(
            ...Array.from({ length: 6 }, () => {
              const t = pool[Math.floor(Math.random() * pool.length)];
              return { company_id: company.id, ...generateSceneMission(t, company.reputation, site) };
            }),
          );
        }

        // Charter work: plain cargo/passenger runs to a real nearby field, no
        // scene involved.
        const charterPool = CHARTER_TEMPLATES.filter((t) =>
          companyHasCerts(company.certifications, t.required_certs),
        );
        if (charterPool.length > 0 && airports.length > 0) {
          for (let i = 0; i < 3; i++) {
            const t = charterPool[Math.floor(Math.random() * charterPool.length)];
            const ch = generateCharterMission(t, company.reputation, site);
            if (ch) rows.push({ company_id: company.id, ...ch });
          }
        }

        // One contract follows a real transmission line, when OSM knows of one
        // nearby. MSFS draws its powerlines from the same data, so it's a line
        // you can actually see and follow. Replaces the last scene slot when
        // there is one; otherwise it's appended rather than lost.
        const sceneSlots = pool.length > 0 ? 6 : 0;
        try {
          const patrol = await generatePowerlinePatrol(company.reputation, site, "rotary", patrolStarts);
          if (patrol) {
            const row = { company_id: company.id, ...patrol };
            if (sceneSlots > 0) rows[sceneSlots - 1] = row;
            else rows.push(row);
          }
        } catch {
          // Overpass unavailable -- the synthetic contract already in the slot stands.
        }
      } else {
        // Aeroplane work, built from real airfields. Skipped when the base has
        // no airport data, since a fixed-wing contract is nothing but its
        // destination and there is no honest way to invent one.
        const certified = FIXED_WING_TEMPLATES.filter((t) =>
          companyHasCerts(company.certifications, t.required_certs),
        );
        // Only work a plane in the fleet can take -- a Savage Cub was offered
        // 1,500 lb freight runs. With no plane that fits any, offer them all.
        const planes = (aircraft ?? []).filter(
          (a) => isFixedWingAircraft(a) && !["sold", "returned", "destroyed"].includes(a.status),
        );
        const flyable = certified.filter((t) => fleetCanFly(t, planes));
        const fwPool = flyable.length > 0 ? flyable : certified;
        let fwCount = 0;
        if (fwPool.length > 0 && airports.length > 0) {
          // A template can come up empty -- no lake near this base for a
          // floatplane, not enough fields in a row for a mail run -- so a few
          // spare tries keep the count honest.
          for (let tries = 0; tries < 18 && fwCount < 6; tries++) {
            const t = fwPool[Math.floor(Math.random() * fwPool.length)];
            const fw = generateFixedWingMission(t, company.reputation, site);
            if (fw) {
              rows.push({ company_id: company.id, ...fw });
              fwCount++;
            }
          }
        }

        // One line patrol for the aeroplanes, in place of the last contract.
        try {
          const patrol = await generatePowerlinePatrol(company.reputation, site, "fixed", patrolStarts);
          if (patrol) {
            const row = { company_id: company.id, ...patrol };
            if (fwCount > 0) rows[rows.length - 1] = row;
            else rows.push(row);
          }
        } catch {
          // Overpass unavailable -- the contracts already generated stand.
        }
      }

      // Industries: sited once per base from real OSM land use (forests,
      // farmland, quarries, wells) and cached as rows rather than a JSON blob
      // -- unlike water and roads, industries have their own ongoing state
      // (stock, capacity) that has to persist and accumulate, not just a
      // position to remember.
      let baseIndustries = (industries ?? []).filter((i: any) => i.base_id === base.id);
      if (baseIndustries.length === 0) {
        try {
          const rawInd = await findIndustrySites(centre, 50);
          if (rawInd && rawInd.length > 0) {
            const sited = siteIndustries(rawInd);
            if (sited.length > 0) {
              const { data: placed, error: indErr } = await supabase.rpc("site_industries", {
                _base_id: base.id,
                _sites: sited as unknown as never,
              });
              if (!indErr && placed) {
                baseIndustries = placed as any[];
                qc.invalidateQueries({ queryKey: ["industries"] });
              }
            }
          }
        } catch {
          // Overpass unavailable -- no industries this batch, nothing else affected.
        }
      } else {
        // Already sited: bring stock up to date rather than re-scanning.
        try {
          const { data: ticked } = await supabase.rpc("tick_base_industries", { _base_id: base.id });
          if (ticked) baseIndustries = ticked as any[];
        } catch {
          // Stale stock numbers are a worse Generate, not a broken one.
        }
      }

      // Industry mode hauls only from sites the company owns.
      baseIndustries = baseIndustries.filter((i: any) => ownsIndustry(company, i));
      if (baseIndustries.length > 0) {
        const byKind = new Map<string, any>(baseIndustries.map((i: any) => [i.kind, i]));
        // Two hauls for this half of the board, drawn from every candidate.
        const hauls: Record<string, unknown>[] = [];
        const add = (haul: Record<string, unknown> | null) => {
          if (haul) hauls.push({ company_id: company.id, ...haul });
        };
        // Industry mode goes round the sites a few times, so there are enough
        // candidates for its larger batch. Dispatch still checks each against stock.
        for (let round = 0; round < (industryMode ? 3 : 1); round++) for (const ind of baseIndustries) {
          const def = INDUSTRY_DEFS[ind.kind as keyof typeof INDUSTRY_DEFS];
          if (!def) continue;
          const from: IndustryRow = {
            id: ind.id, kind: def.kind, lat: Number(ind.latitude), lon: Number(ind.longitude),
            name: ind.name, stock: Number(ind.stock), capacity: Number(ind.capacity),
          };
          if (def.tier === 1) {
            // Raw material goes to the paired processor, when one is sited.
            const pairKind = Object.values(INDUSTRY_DEFS).find(
              (d) => d.chain === def.chain && d.tier === 2,
            )?.kind;
            const pair = pairKind ? byKind.get(pairKind) : null;
            if (!pair) continue;
            const to = {
              lat: Number(pair.latitude), lon: Number(pair.longitude), icao: null,
              name: (pair.name as string | null) ?? INDUSTRY_DEFS[pair.kind as keyof typeof INDUSTRY_DEFS]?.label ?? null,
              industryId: pair.id as string,
            };
            add(heli
              ? generateIndustryHaul(from, to, company.reputation, site)
              : generatePlaneHaul(from, to, company.reputation, site));
          } else {
            // Finished goods: the market at base, or a regional market further
            // out that pays for the distance.
            const market = pickMarket(from, airports);
            if (heli) {
              add(generateIndustryHaul(
                from,
                { lat: centre.lat, lon: centre.lon, icao: base.icao, name: `${base.icao ?? "base"} market` },
                company.reputation, site,
              ));
              if (market) add(generateMarketHaul(from, market, company.reputation, site));
            } else if (market) {
              add(generatePlaneHaul(
                from,
                { lat: market.lat, lon: market.lon, icao: market.icao, name: null },
                company.reputation, site,
              ));
            }
          }
        }
        for (let i = hauls.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [hauls[i], hauls[j]] = [hauls[j], hauls[i]];
        }
        rows.push(
          ...hauls
            .slice(0, industryMode ? INDUSTRY_MODE_HAULS : 2)
            // Goods alone paid a few hundred dollars a flight; Industry mode adds freight.
            .map((h) => (industryMode ? withFreight(h, heli ? "rotary" : "fixed", Number(company.reputation) || 0) : h)),
        );
      }
    } else if (heli && !industryMode) {
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

    // Every category can independently come up empty -- only when all of
    // them do is this actually a failed Generate.
    if (rows.length === 0) {
      return toast.error(
        industryMode
          ? "No hauls this time. Industry mode only offers goods work: build or claim camps on the Trading Hall, staff them, and give their stock somewhere to go (a mill, or a market airport for finished goods)."
          : !base
          ? heli
            ? "Nothing to generate yet."
            : "Plane work needs a home base with a position. Set one in Settings, or run the sim bridge once."
          : heli
            ? `No helicopter contracts this time${rotaryNote ? ` — ${rotaryNote}` : ""}.`
            : "No plane contracts this time. They're built from airfields near this base and none came back — try again, or fly around a bit so the sim reports some.",
      );
    }

    const { error } = await supabase.from("missions").insert(rows);
    if (error) return toast.error(error.message);

    if (!base) {
      toast.success(`Generated ${rows.length} contracts. Run the sim bridge once to unlock scene missions.`);
    } else {
      const withField = rows.filter((r) => r.nearest_airport_icao).length;
      const notes: string[] = [];
      if (withField < rows.length) {
        notes.push(`${withField} of ${rows.length} have a nearest field — no airfield data near the rest`);
      }
      if (droppedForSites > 0) {
        notes.push(
          `${droppedForSites} rotary contract type${droppedForSites === 1 ? "" : "s"} withheld — no suitable water or road near this base`,
        );
      }
      if (rotaryNote) notes.push(`no rotary scene contracts this batch — ${rotaryNote}`);
      const charter = rows.filter((r) => r.scene_type === "charter").length;
      const summary = heli
        ? [rows.length - charter > 0 ? `${rows.length - charter} helicopter` : null, charter > 0 ? `${charter} charter` : null]
            .filter(Boolean)
            .join(" and ")
        : `${rows.length} plane`;
      toast.success(
        `Generated ${summary} contract${rows.length === 1 ? "" : "s"}.` +
          (notes.length ? ` ${notes.join(". ")}.` : ""),
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
      isRatingRide(mission)
        ? `${ac.display_name} dispatched — fly the check ride from ${mission.origin ?? "base"}.`
        : mission.scene_name
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
    const fixed = wing === "fixed";
    const all = supabase
      .from("missions")
      .delete()
      .eq("company_id", company.id)
      .eq("status", "available")
      // A contract reset by a crash is still someone's to restart; leave it.
      .is("assigned_pilot_id", null)
      // Cargo jobs are cleared from the Cargo Hub.
      .is("manifest", null);
    // Only the tab you're looking at, as Generate does. `airport` is what
    // marks plane work (isFixedWingMission); anything else is helicopter work,
    // including an old contract with no scene type at all.
    const { error } = await (fixed
      ? all.eq("scene_type", "airport")
      : all.or("scene_type.is.null,scene_type.neq.airport"));
    if (error) return toast.error(error.message);
    toast.success(fixed ? "Plane contracts cleared." : "Helicopter contracts cleared.");
    qc.invalidateQueries({ queryKey: ["missions"] });
  }

  async function cancelDispatch(mission: any) {
    const { error } = await supabase.rpc("cancel_dispatch", { _mission_id: mission.id });
    if (error) return toast.error(error.message);
    toast.success("Dispatch cancelled.");
    qc.invalidateQueries();
  }

  // Cargo and passenger jobs live on the Cargo Hub.
  // Industry mode shows only goods work and the check rides that gate aircraft.
  const contracts =
    missions?.filter((m) => !isCargoJob(m) && (!isIndustryMode(company) || showsInIndustryMode(m))) ?? [];
  const available = contracts.filter((m: any) => m.status === "available");
  const inProgress = contracts.filter((m: any) => m.status === "in_progress");
  const completed = contracts.filter((m: any) => m.status === "completed" || m.status === "failed").slice(0, 10);
  // Split first, then filter by role: the role lists differ between the two
  // halves, so offering "freight" while looking at helicopters is just noise.
  // The company check ride is flown in any company aircraft, and its steps
  // follow the one it's dispatched to, so it belongs on both tabs.
  const onBothTabs = (m: any) => m.role === "rating_ride" && m.scene_name === CHECKOUT_RATING;
  // A plane check ride is plane work, though it isn't an airport contract.
  const isPlaneWork = (m: any) => isFixedWingMission(m) || isPlaneCheckride(m);
  const forWing = available.filter((m: any) =>
    onBothTabs(m) || (wing === "fixed" ? isPlaneWork(m) : !isPlaneWork(m)),
  );
  const rotaryCount = available.length - available.filter(isPlaneWork).length;
  const fixedCount = available.length - rotaryCount;
  const filtered = roleFilter === "all" ? forWing : forWing.filter((m: any) => m.role === roleFilter);
  const roles = [...new Set(forWing.map((m: any) => m.role))];
  const fleet = aircraft ?? [];

  return (
    <div className="space-y-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Dispatch</p>
          <h1 className="mt-1 text-3xl font-semibold">Mission Board</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {forWing.length} {wing === "fixed" ? "fixed-wing" : "rotary"} contract
            {forWing.length === 1 ? "" : "s"} available
            {homeIcao ? <> · operating from <span className="font-mono">{homeIcao}</span></> : " · no home base set"}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            <button
              type="button"
              onClick={() => { setWing("rotary"); setRoleFilter("all"); }}
              className={`px-3 py-2 text-sm ${
                wing === "rotary" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"
              }`}
            >
              Helicopters ({rotaryCount})
            </button>
            <button
              type="button"
              onClick={() => { setWing("fixed"); setRoleFilter("all"); }}
              className={`px-3 py-2 text-sm ${
                wing === "fixed" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground"
              }`}
            >
              Planes ({fixedCount})
            </button>
          </div>
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {roles.map((r) => <SelectItem key={r as string} value={r as string}>{r as string}</SelectItem>)}
            </SelectContent>
          </Select>
          {canManage && forWing.length > 0 && (
            <Button variant="secondary" onClick={clearBoard} disabled={generating}>
              <Trash2 className="mr-2 h-4 w-4" /> Clear {wing === "fixed" ? "planes" : "helicopters"}
            </Button>
          )}
          {canManage && (
            <Button onClick={generateBatch} disabled={generating}>
              <Zap className="mr-2 h-4 w-4" />
              {generating ? "Generating…" : `Generate ${wing === "fixed" ? "plane" : "helicopter"} jobs`}
            </Button>
          )}
        </div>
      </div>

      {myPending.length > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium">
            <GraduationCap className="h-4 w-4 text-warning" /> Check rides to fly
          </p>
          <p className="mt-1 text-muted-foreground">
            {myPending.some((r) => r.rating === CHECKOUT_RATING)
              ? "You can't take contracts until you pass your company check ride."
              : "You can take contracts, but only in aircraft types you're rated on."}{" "}
            Each ride passes with every step done and a score of {RATING_PASS_SCORE} or better.
            They're on the board, reserved for you.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {myPending.map((r) => (
              <span key={r.rating} className="rounded bg-secondary px-2 py-0.5 text-xs">{r.label}</span>
            ))}
          </div>
        </div>
      )}

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
                        {isRatingRide(m)
                          ? `Check ride · ${m.origin ?? "base"} ⟳`
                          : m.scene_name
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
                    <span className="flex-1 text-xs text-muted-foreground">Awaiting flight — logged once every objective is done and you're down and stopped, or on engine shutdown.</span>
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
            No {wing === "fixed" ? "fixed-wing" : "rotary"} contracts available.{" "}
            {canManage ? <>Click <strong>Generate</strong> to pull new ones.</> : <>Ask a manager to generate new contracts.</>}
          </div>
        )}
        {filtered.map((m: any) => (
          <MissionCard
            key={m.id}
            mission={m}
            aircraft={fleet}
            certs={company?.certifications ?? []}
            onDispatch={(ac: any) => dispatch(m, ac)}
            me={me}
            ratings={isOwner ? null : myRatings}
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

type RatingRow = { rating: string; passed_at: string | null; fee_paid: boolean };

function MissionCard({ mission, aircraft, certs, onDispatch, me, ratings: ratingRows }: any) {
  const certsOk = companyHasCerts(certs, mission.required_certs);
  const ratingRide = isRatingRide(mission);
  const strip = isFixedWingMission(mission) ? stripOf(mission.objectives) : null;
  // Null for the owner, and before the ratings migration: no gate.
  const ratings = ratingRows as RatingRow[] | null;
  const passed = (rating: string) =>
    !ratings || ratings.some((r) => r.rating === rating && r.passed_at);
  const checkedOut = passed(CHECKOUT_RATING);
  const eligibleAircraft = aircraft
    .map((a: any) => ({ a, e: isAircraftEligible(a, mission), rated: passed(ratingOf(a).rating) }))
    .filter((x: any) => x.e.eligible)
    // A type rating ride has to be flown in that type.
    .filter((x: { a: { internal_id?: string; sim_title?: string; display_name?: string } }) =>
      !ratingRide || mission.scene_name === CHECKOUT_RATING || ratingOf(x.a).rating === mission.scene_name,
    )
    // A certification check ride is flown in its own kind: the plane version in a
    // plane, the helicopter version in a helicopter.
    .filter((x: { a: { internal_id?: string } }) =>
      mission.role !== "checkride" || isFixedWingAircraft(x.a) === isPlaneCheckride(mission),
    );
  const reservedForSomeoneElse = ratingRide && mission.assigned_pilot_id !== me;
  const canFly = certsOk && !reservedForSomeoneElse && (ratingRide || checkedOut);
  const feePaid = !!ratings?.some((r) => r.rating === mission.scene_name && r.fee_paid);
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
          {mission.restart_from && (
            <p className="mt-2 flex items-center gap-1 text-xs text-warning">
              <AlertTriangle className="h-3 w-3" />
              Crashed {mission.crash_count > 1 ? `${mission.crash_count} times` : "once"} — restart
              from <span className="font-mono">{mission.restart_from}</span>. It only counts if you
              take off from there.
            </p>
          )}
          {ratingRide && (
            <p className="mt-2 flex items-center gap-1 text-xs text-primary">
              <GraduationCap className="h-3 w-3" />
              Check ride · pass with every step done and a score of {RATING_PASS_SCORE}+ ·{" "}
              {feePaid
                ? "examiner paid, retakes free"
                : `$${RATING_FEE.toLocaleString()} examiner fee on first dispatch, retakes free`}
            </p>
          )}
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
      {mission.scene_name && !ratingRide && (
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
      {strip && (
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          <PlaneLanding className="h-3 w-3 text-primary" />
          <span className={strip.unpaved ? "text-foreground" : undefined}>{strip.label}</span>
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
        {certsOk && reservedForSomeoneElse && (
          <p className="text-xs text-muted-foreground">Booked for another pilot — only they can fly it.</p>
        )}
        {certsOk && !reservedForSomeoneElse && !ratingRide && !checkedOut && (
          <p className="flex items-center gap-2 text-xs text-warning">
            <GraduationCap className="h-3 w-3" /> Pass your company check ride before taking contracts.
          </p>
        )}
        {canFly && eligibleAircraft.length === 0 && (
          <p className="text-xs text-muted-foreground">No eligible aircraft in fleet.</p>
        )}
        {canFly && eligibleAircraft.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {eligibleAircraft.map(({ a, rated }: any) => {
              const ok = ratingRide || rated;
              return (
                <Button
                  key={a.id} size="sm" variant="secondary" disabled={!ok} onClick={() => onDispatch(a)}
                  title={ok ? undefined : `Not rated on the ${ratingOf(a).label} yet — fly its check ride first`}
                >
                  Dispatch · {a.display_name}{ok ? "" : " (not rated)"}
                </Button>
              );
            })}
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
