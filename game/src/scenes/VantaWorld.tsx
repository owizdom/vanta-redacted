/**
 * VANTA — full hex-tile fantasy world.
 *
 * Three kingdoms (one per VANTA) packed onto a hex map ~16 hexes
 * across, surrounded by ocean. Each kingdom has 10+ buildings, its
 * own terrain biome, multiple NPC characters walking the paths,
 * carts on the roads, scattered props, and a banner-coloured aura.
 *
 * Built entirely on Kenney CC0 packs:
 *   /hex/    ← kenney_hexagon-kit
 *   /town/   ← kenney_fantasy-town-kit_2.0
 *   /chars/  ← kenney_blocky-characters_20
 *   /models/ ← kenney_platformer-kit
 *
 * The plaza at the centre is a meeting ground; each kingdom's
 * capital sits 2-3 hexes out, with farms / docks / mines further
 * out, and a water rim.
 */

import { Suspense, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import * as THREE from "three";

import type { V3AgentSummary } from "../lib/runtime";

// ----------- hex math -----------

const HEX_SIZE = 0.577;
const HEX_X_STEP = HEX_SIZE * Math.sqrt(3);
const HEX_Z_STEP = HEX_SIZE * 1.5;

function hexToWorld(q: number, r: number): { x: number; z: number } {
  return {
    x: HEX_X_STEP * (q + r / 2),
    z: HEX_Z_STEP * r,
  };
}

// ----------- world layout -----------

interface HexCell {
  readonly q: number;
  readonly r: number;
  readonly tile: string;
  readonly building?: string;
  readonly buildingRotY?: number;
  readonly tint?: string;
}

interface WalkerSpec {
  readonly model: string;
  readonly path: readonly { x: number; z: number }[];
  readonly speed: number;
  readonly tint?: string;
}

interface PropSpec {
  readonly model: string;
  readonly x: number;
  readonly z: number;
  readonly y?: number;
  readonly rotY?: number;
}

interface World {
  readonly cells: readonly HexCell[];
  readonly walkers: readonly WalkerSpec[];
  readonly props: readonly PropSpec[];
}

/**
 * Procedurally generate a much larger world. ~200 hexes spread
 * across a 14-hex-radius circle, divided into 3 wedge-sectors by
 * angle. Each kingdom gets a dense capital + farms/forests/mountains
 * stretching toward the rim. Water surrounds everything.
 *
 * Sector assignment by polar angle (atan2(z, x), 0 = +x):
 *   gpt:    -π/2 < θ < -π/6     (NE quadrant)
 *   gemini: -7π/6 < θ < -π/2    (NW quadrant)
 *   opus:   π/6 < θ < 5π/6      (south half)
 */
function buildWorld(buckets: AgentByStrip): World {
  const opusColor = buckets.opus?.color_hex ?? "#9b6bff";
  const gptColor = buckets.gpt?.color_hex ?? "#4fae5a";
  const geminiColor = buckets.gemini?.color_hex ?? "#4287f5";

  const cells: HexCell[] = [];
  const walkers: WalkerSpec[] = [];
  const props: PropSpec[] = [];

  // Deterministic PRNG so re-renders match.
  let seed = 1337;
  const rand = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;

  // Track placed cells so we don't double-place.
  const placed = new Set<string>();
  const place = (q: number, r: number, tile: string, opts: Partial<HexCell> = {}): void => {
    const key = `${String(q)},${String(r)}`;
    if (placed.has(key)) return;
    placed.add(key);
    cells.push({ q, r, tile, ...opts });
  };

  // Hex distance from origin (axial distance).
  const dist = (q: number, r: number): number =>
    (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;

  const RADIUS = 14;
  const WATER_RADIUS_INNER = 11;
  const WATER_RADIUS_OUTER = 14;

  // Classify a hex into sector + biome.
  function sectorOf(q: number, r: number): "opus" | "gpt" | "gemini" | "plaza" {
    if (dist(q, r) <= 1) return "plaza";
    const w = hexToWorld(q, r);
    const theta = Math.atan2(w.z, w.x);
    // South (opus): θ in (π/6, 5π/6)
    if (theta > Math.PI / 6 && theta < (5 * Math.PI) / 6) return "opus";
    // NE (gpt): θ in (-π/2, π/6)
    if (theta > -Math.PI / 2 && theta <= Math.PI / 6) return "gpt";
    // Else NW (gemini)
    return "gemini";
  }

  // ============= GENERATE BASE TERRAIN =============
  // Three concentric zones for clarity:
  //   • plaza core (d ≤ 1)        — paths, portal — no buildings
  //   • clear buffer (2 ≤ d ≤ 3)   — neutral grass — no buildings
  //   • kingdom land (4 ≤ d ≤ 9)   — sector terrain + buildings
  //   • outer wilds (10 ≤ d ≤ 11) — mountainous / forest / desert
  //   • water rim (12 ≤ d ≤ 14)   — ocean
  for (let q = -RADIUS; q <= RADIUS; ++q) {
    for (let r = -RADIUS; r <= RADIUS; ++r) {
      const d = dist(q, r);
      if (d > WATER_RADIUS_OUTER) continue;
      // Outer ring: water
      if (d > WATER_RADIUS_INNER) {
        place(q, r, "/hex/water.glb");
        continue;
      }

      const sector = sectorOf(q, r);
      if (sector === "plaza") continue; // handled below

      // Inner buffer (2–3): always neutral grass, no tint, no buildings.
      // This gives each kingdom a clear "approach lane" to the plaza.
      if (d <= 3) {
        place(q, r, "/hex/grass.glb");
        continue;
      }

      const baseTiles: Record<string, readonly string[]> = {
        opus: ["/hex/stone.glb", "/hex/stone.glb", "/hex/stone-hill.glb", "/hex/stone-rocks.glb", "/hex/stone-mountain.glb"],
        gpt: ["/hex/grass.glb", "/hex/grass.glb", "/hex/grass-forest.glb", "/hex/grass-hill.glb", "/hex/grass-forest.glb"],
        gemini: ["/hex/sand.glb", "/hex/sand.glb", "/hex/sand-desert.glb", "/hex/sand-rocks.glb", "/hex/sand-desert.glb"],
      };

      // No tile tinting — natural Kenney terrain colours (stone /
      // grass / sand) read better than a coloured wash.
      const tilePool = baseTiles[sector] ?? ["/hex/grass.glb"];
      const pickIndex = d > 9 ? 4 : d > 7 ? Math.floor(rand() * 5) : Math.floor(rand() * 2);
      const tile = tilePool[pickIndex] ?? "/hex/grass.glb";
      place(q, r, tile);
    }
  }

  // ============= CENTRE PLAZA =============
  cells.push({ q: 0, r: 0, tile: "/hex/path-square.glb" });
  cells.push({ q: 1, r: 0, tile: "/hex/path-straight.glb" });
  cells.push({ q: -1, r: 0, tile: "/hex/path-straight.glb" });
  cells.push({ q: 0, r: 1, tile: "/hex/path-straight.glb", buildingRotY: Math.PI / 3 });
  cells.push({ q: 0, r: -1, tile: "/hex/path-straight.glb", buildingRotY: Math.PI / 3 });
  cells.push({ q: 1, r: -1, tile: "/hex/grass.glb" });
  cells.push({ q: -1, r: 1, tile: "/hex/grass.glb" });
  for (const cell of cells) {
    if (dist(cell.q, cell.r) <= 1) placed.add(`${String(cell.q)},${String(cell.r)}`);
  }

  // Plaza centre is INTENTIONALLY empty — just the portal renders there.
  // No carts, no stalls, no fountain — keeps the visual focus clean.

  // ============= LANDMARK BUILDINGS =============
  // All kingdom buildings sit at distance 5-9 from the centre, well
  // OUTSIDE the buffer zone, so each kingdom occupies its own corner
  // of the map with breathing room between them.
  const placeBuilding = (q: number, r: number, building: string, rotY?: number): void => {
    const idx = cells.findIndex((c) => c.q === q && c.r === r);
    if (idx >= 0) {
      cells[idx] = { ...cells[idx]!, building, buildingRotY: rotY };
    }
  };

  // -- Opus capital cluster (south, stone city) --
  // Wizard tower at (0, 6) is the centrepiece. Buildings spread thinly
  // across d=5..9 with deliberate empty hexes between them so the
  // stone kingdom doesn't read as one undifferentiated cluster.
  // Inner ring (d=5) — leave most hexes empty, just a few houses
  placeBuilding(-1, 5, "/hex/building-mine.glb");
  placeBuilding(1, 5, "/hex/building-smelter.glb");
  placeBuilding(-3, 5, "/hex/building-cabin.glb");
  placeBuilding(3, 5, "/hex/building-cabin.glb");
  // Capital ring (d=6) — heart of the kingdom (still dense)
  placeBuilding(-1, 6, "/hex/building-castle.glb");
  placeBuilding(0, 6, "/hex/building-wizard-tower.glb");
  placeBuilding(1, 6, "/hex/building-mill.glb");
  placeBuilding(-3, 6, "/hex/building-tower.glb");
  placeBuilding(3, 6, "/hex/building-tower.glb");
  // Outer ring (d=7) — sparse workshops
  placeBuilding(-2, 7, "/hex/building-house.glb");
  placeBuilding(0, 7, "/hex/building-walls.glb");
  placeBuilding(2, 7, "/hex/building-house.glb");
  // Far ring (d=8-9) — mansions + scattered estates
  placeBuilding(-1, 8, "/hex/unit-mansion.glb");
  placeBuilding(0, 8, "/hex/unit-house.glb");
  placeBuilding(2, 8, "/hex/building-walls.glb");
  placeBuilding(0, 9, "/hex/unit-tower.glb");
  placeBuilding(-2, 9, "/hex/building-cabin.glb");

  // -- Gpt capital cluster (NE, dense farming city of grass) --
  // Market at (5,-3) is the heart; surrounded by farms, watermills,
  // sheep pastures and villages. ~26 buildings across d=4..9.
  // Inner ring (d=4-5)
  placeBuilding(4, -3, "/hex/building-house.glb");
  placeBuilding(5, -3, "/hex/building-market.glb");
  placeBuilding(6, -3, "/hex/building-farm.glb");
  placeBuilding(7, -3, "/hex/building-tower.glb");
  placeBuilding(5, -2, "/hex/building-house.glb");
  placeBuilding(3, -4, "/hex/building-house.glb");
  placeBuilding(4, -4, "/hex/building-watermill.glb");
  placeBuilding(5, -4, "/hex/building-house.glb");
  placeBuilding(6, -4, "/hex/building-village.glb");
  placeBuilding(7, -4, "/hex/building-village.glb");
  placeBuilding(8, -4, "/hex/building-farm.glb");
  // Mid ring (d=5-6)
  placeBuilding(3, -5, "/hex/building-cabin.glb");
  placeBuilding(4, -5, "/hex/building-tower.glb");
  placeBuilding(5, -5, "/hex/building-sheep.glb");
  placeBuilding(6, -5, "/hex/building-tower.glb");
  placeBuilding(7, -5, "/hex/building-house.glb");
  placeBuilding(8, -5, "/hex/building-sheep.glb");
  placeBuilding(4, -6, "/hex/building-mill.glb");
  placeBuilding(5, -6, "/hex/unit-house.glb");
  placeBuilding(6, -6, "/hex/building-cabin.glb");
  placeBuilding(7, -6, "/hex/building-cabin.glb");
  placeBuilding(8, -6, "/hex/unit-mansion.glb");
  // Outer (d=7-8)
  placeBuilding(5, -7, "/hex/unit-house.glb");
  placeBuilding(6, -7, "/hex/unit-house.glb");
  placeBuilding(7, -7, "/hex/building-cabin.glb");
  placeBuilding(8, -7, "/hex/unit-tower.glb");

  // -- Gemini capital cluster (NW, dense desert port city of sand) --
  // Port at (-5,-3) opens onto the sea; archery towers + walls guard
  // the sand interior. ~30 buildings spread wide across d=4..9 so the
  // sand kingdom feels populated rather than empty between cacti.
  // Inner ring (d=4-5)
  placeBuilding(-4, -3, "/hex/building-house.glb");
  placeBuilding(-5, -3, "/hex/building-port.glb");
  placeBuilding(-6, -3, "/hex/building-dock.glb");
  placeBuilding(-7, -3, "/hex/building-tower.glb");
  placeBuilding(-5, -2, "/hex/building-house.glb");
  placeBuilding(-3, -4, "/hex/building-cabin.glb");
  placeBuilding(-4, -4, "/hex/building-tower.glb");
  placeBuilding(-5, -4, "/hex/building-cabin.glb");
  placeBuilding(-6, -4, "/hex/building-walls.glb");
  placeBuilding(-7, -4, "/hex/building-walls.glb");
  placeBuilding(-8, -4, "/hex/building-archery.glb");
  // Mid ring (d=5-6)
  placeBuilding(-3, -5, "/hex/building-house.glb");
  placeBuilding(-4, -5, "/hex/building-house.glb");
  placeBuilding(-5, -5, "/hex/building-house.glb");
  placeBuilding(-6, -5, "/hex/building-tower.glb");
  placeBuilding(-7, -5, "/hex/building-cabin.glb");
  placeBuilding(-8, -5, "/hex/building-archery.glb");
  placeBuilding(-3, -6, "/hex/building-cabin.glb");
  placeBuilding(-4, -6, "/hex/building-house.glb");
  placeBuilding(-5, -6, "/hex/unit-house.glb");
  placeBuilding(-6, -6, "/hex/building-cabin.glb");
  placeBuilding(-7, -6, "/hex/building-mill.glb");
  placeBuilding(-8, -6, "/hex/unit-mansion.glb");
  // Outer (d=7-8) — extended sand frontier
  placeBuilding(-4, -7, "/hex/unit-house.glb");
  placeBuilding(-5, -7, "/hex/unit-house.glb");
  placeBuilding(-6, -7, "/hex/unit-house.glb");
  placeBuilding(-7, -7, "/hex/building-cabin.glb");
  placeBuilding(-8, -7, "/hex/unit-tower.glb");
  placeBuilding(-2, -5, "/hex/building-cabin.glb");
  placeBuilding(-2, -6, "/hex/unit-house.glb");
  // Far rim — frontier outposts and watchtowers
  placeBuilding(-3, -7, "/hex/unit-tower.glb");
  placeBuilding(-3, -8, "/hex/building-cabin.glb");

  // ============= SHIPS + ISLANDS scattered in water =============
  // Find some water hexes and add ship/island units.
  const shipPositions = [
    [-9, 1], [-10, 3], [10, -7], [11, -8], [-3, 9], [3, 7], [-7, -2],
  ] as const;
  for (const [q, r] of shipPositions) {
    placeBuilding(q, r, "/hex/unit-ship.glb");
  }
  const islandPositions = [
    [11, -10], [-11, 0], [-9, 9], [9, -2], [-2, 12],
  ] as const;
  for (const [q, r] of islandPositions) {
    placeBuilding(q, r, "/hex/water-island.glb");
  }

  // ============= RIVER cutting through =============
  // a winding river from NW corner → plaza-adjacent → SE corner
  const riverHexes: { q: number; r: number }[] = [
    { q: -1, r: 1 }, { q: 1, r: 1 },
  ];
  for (const r of riverHexes) {
    const idx = cells.findIndex((c) => c.q === r.q && c.r === r.r);
    if (idx >= 0) {
      cells[idx] = { ...cells[idx]!, tile: "/hex/river-straight.glb" };
    } else {
      cells.push({ q: r.q, r: r.r, tile: "/hex/river-straight.glb" });
    }
  }

  // ============= VANTA AGENTS — patrol kingdom boundary =============
  // Each VANTA's "agent" walks the perimeter of their kingdom in a
  // closed loop. They never cross into another kingdom. The portal
  // at the centre is the only place where the 3 agents meet (handled
  // separately by the convergence animation in the renderer).
  //
  // Boundary loops trace ~12 waypoints around each kingdom's outer
  // edge so the agent walks the *border* of their territory.
  // Boundary loops trace the OUTER edge of each kingdom (ring at
  // distance ~6-9), not the inner edge — so the agent walks the
  // perimeter visible from the camera.
  const opusBoundary: { q: number; r: number }[] = [
    { q: -3, r: 5 }, { q: -3, r: 7 }, { q: -2, r: 8 },
    { q: 0, r: 8 }, { q: 2, r: 7 }, { q: 3, r: 5 },
    { q: 2, r: 5 }, { q: 0, r: 6 }, { q: -2, r: 6 },
  ];
  const gptBoundary: { q: number; r: number }[] = [
    { q: 4, r: -3 }, { q: 5, r: -4 }, { q: 6, r: -5 },
    { q: 7, r: -6 }, { q: 8, r: -6 }, { q: 7, r: -4 },
    { q: 6, r: -3 }, { q: 5, r: -3 },
  ];
  const geminiBoundary: { q: number; r: number }[] = [
    { q: -4, r: -3 }, { q: -5, r: -4 }, { q: -6, r: -5 },
    { q: -7, r: -5 }, { q: -8, r: -5 }, { q: -7, r: -3 },
    { q: -6, r: -3 }, { q: -5, r: -3 },
  ];

  // The PRIMARY VANTA agent for each kingdom — walks the boundary.
  walkers.push({
    model: "/chars/character-a.glb",
    tint: opusColor,
    speed: 0.7,
    path: opusBoundary.map((p) => hexToWorld(p.q, p.r)),
  });
  walkers.push({
    model: "/chars/character-c.glb",
    tint: gptColor,
    speed: 0.7,
    path: gptBoundary.map((p) => hexToWorld(p.q, p.r)),
  });
  walkers.push({
    model: "/chars/character-h.glb",
    tint: geminiColor,
    speed: 0.7,
    path: geminiBoundary.map((p) => hexToWorld(p.q, p.r)),
  });

  // Plain NPCs — villagers/citizens. NO tint (neutral colour).
  // They live in a kingdom but they're not "the agent" — just
  // background residents giving the world life. ~6 per kingdom for
  // a populated city feel.
  const npcWanders: { model: string; loop: { q: number; r: number }[]; speed: number }[] = [
    // ===== Opus citizens — south, stone city around (0, 6) =====
    { model: "/chars/character-b.glb", speed: 0.4,
      loop: [{ q: -1, r: 6 }, { q: 0, r: 6 }, { q: 1, r: 6 }, { q: 0, r: 7 }] },
    { model: "/chars/character-f.glb", speed: 0.35,
      loop: [{ q: -2, r: 7 }, { q: -1, r: 8 }, { q: 0, r: 8 }, { q: -1, r: 7 }] },
    { model: "/chars/character-k.glb", speed: 0.32,
      loop: [{ q: 2, r: 5 }, { q: 1, r: 6 }, { q: 2, r: 6 }, { q: 3, r: 6 }] },
    { model: "/chars/character-e.glb", speed: 0.36,
      loop: [{ q: -2, r: 5 }, { q: -1, r: 5 }, { q: 0, r: 5 }, { q: -1, r: 6 }] },
    { model: "/chars/character-n.glb", speed: 0.3,
      loop: [{ q: 1, r: 7 }, { q: 2, r: 7 }, { q: 1, r: 8 }, { q: 0, r: 8 }] },
    { model: "/chars/character-o.glb", speed: 0.34,
      loop: [{ q: -2, r: 8 }, { q: -2, r: 9 }, { q: 0, r: 9 }, { q: -1, r: 8 }] },
    // ===== Gpt citizens — NE, grass farming city around (6, -4) =====
    { model: "/chars/character-d.glb", speed: 0.4,
      loop: [{ q: 5, r: -3 }, { q: 6, r: -3 }, { q: 6, r: -4 }, { q: 5, r: -3 }] },
    { model: "/chars/character-g.glb", speed: 0.35,
      loop: [{ q: 6, r: -5 }, { q: 7, r: -5 }, { q: 7, r: -4 }, { q: 6, r: -4 }] },
    { model: "/chars/character-l.glb", speed: 0.32,
      loop: [{ q: 7, r: -6 }, { q: 8, r: -6 }, { q: 8, r: -5 }, { q: 7, r: -5 }] },
    { model: "/chars/character-p.glb", speed: 0.36,
      loop: [{ q: 4, r: -4 }, { q: 5, r: -4 }, { q: 4, r: -3 }, { q: 4, r: -5 }] },
    { model: "/chars/character-q.glb", speed: 0.3,
      loop: [{ q: 5, r: -6 }, { q: 6, r: -6 }, { q: 6, r: -7 }, { q: 5, r: -7 }] },
    { model: "/chars/character-r.glb", speed: 0.34,
      loop: [{ q: 7, r: -3 }, { q: 8, r: -4 }, { q: 7, r: -4 }, { q: 6, r: -3 }] },
    // ===== Gemini citizens — NW, sand port city around (-6, -4) =====
    { model: "/chars/character-i.glb", speed: 0.4,
      loop: [{ q: -5, r: -3 }, { q: -6, r: -3 }, { q: -6, r: -4 }, { q: -5, r: -3 }] },
    { model: "/chars/character-j.glb", speed: 0.35,
      loop: [{ q: -6, r: -5 }, { q: -7, r: -5 }, { q: -7, r: -4 }, { q: -6, r: -4 }] },
    { model: "/chars/character-m.glb", speed: 0.32,
      loop: [{ q: -7, r: -6 }, { q: -8, r: -5 }, { q: -7, r: -4 }, { q: -7, r: -5 }] },
    { model: "/chars/character-d.glb", speed: 0.36,
      loop: [{ q: -4, r: -4 }, { q: -5, r: -4 }, { q: -4, r: -3 }, { q: -4, r: -5 }] },
    { model: "/chars/character-g.glb", speed: 0.3,
      loop: [{ q: -5, r: -6 }, { q: -6, r: -6 }, { q: -6, r: -7 }, { q: -5, r: -7 }] },
    { model: "/chars/character-l.glb", speed: 0.34,
      loop: [{ q: -7, r: -3 }, { q: -8, r: -4 }, { q: -7, r: -4 }, { q: -6, r: -3 }] },
  ];
  for (const w of npcWanders) {
    walkers.push({
      model: w.model,
      speed: w.speed,
      path: w.loop.map((p) => hexToWorld(p.q, p.r)),
    });
  }

  // ============= KINGDOM DECORATIONS at each capital =============
  // Banners + carts + stalls placed AT each kingdom's capital, well
  // away from the plaza so they don't clutter the centre.
  const opusCap = hexToWorld(0, 6);
  props.push({ model: "/town/banner-red.glb", x: opusCap.x + 0.4, z: opusCap.z + 0.4, y: 0.4, rotY: Math.PI / 4 });
  props.push({ model: "/town/lantern.glb", x: opusCap.x - 0.4, z: opusCap.z - 0.4, y: 0.2 });

  const gptCap = hexToWorld(6, -4);
  props.push({ model: "/town/stall-red.glb", x: gptCap.x, z: gptCap.z + 0.4, y: 0.4 });
  props.push({ model: "/town/banner-green.glb", x: gptCap.x - 0.4, z: gptCap.z, y: 0.4, rotY: Math.PI / 3 });
  props.push({ model: "/town/cart.glb", x: gptCap.x + 0.4, z: gptCap.z, y: 0.4 });

  const geminiCap = hexToWorld(-6, -4);
  props.push({ model: "/town/banner-green.glb", x: geminiCap.x - 0.4, z: geminiCap.z + 0.4, y: 0.4, rotY: -Math.PI / 3 });
  props.push({ model: "/town/stall-green.glb", x: geminiCap.x + 0.4, z: geminiCap.z - 0.4, y: 0.4 });
  props.push({ model: "/town/lantern.glb", x: geminiCap.x, z: geminiCap.z + 0.5, y: 0.2 });

  return { cells, walkers, props };
}

// ----------- props / types -----------

export interface VantaWorldProps {
  readonly agents: readonly V3AgentSummary[];
  /** Click handler for the floating kingdom rings (agent_id passed). */
  readonly onAgentClick?: (agentId: number) => void;
  /** When true, OrbitControls will auto-rotate (used for menu preview). */
  readonly autoOrbit?: boolean;
  /** When true, hide the BannerOverlay + Legend HTML overlays. */
  readonly hideOverlays?: boolean;
  /** Per-agent normalised activity (0..1). Drives ring pulse + kingdom
   * light. Map keyed by agent_id, missing → 0. */
  readonly activity?: Record<number, number>;
}

interface AgentByStrip {
  readonly opus: V3AgentSummary | undefined;
  readonly gpt: V3AgentSummary | undefined;
  readonly gemini: V3AgentSummary | undefined;
}

function bucket(agents: readonly V3AgentSummary[]): AgentByStrip {
  return {
    opus: agents.find((a) => a.agent_id === 0),
    gpt: agents.find((a) => a.agent_id === 1),
    gemini: agents.find((a) => a.agent_id === 2),
  };
}

// ----------- top-level export -----------

export function VantaWorld({
  agents,
  onAgentClick,
  autoOrbit = false,
  hideOverlays = false,
  activity = {},
}: VantaWorldProps): JSX.Element {
  const buckets = useMemo(() => bucket(agents), [agents]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#bcd9f5]">
      <Canvas
        shadows
        camera={{ position: [22, 18, 22], fov: 42 }}
        gl={{ antialias: true, logarithmicDepthBuffer: true }}
      >
        <Suspense fallback={null}>
          <Scene
            buckets={buckets}
            onAgentClick={onAgentClick}
            autoOrbit={autoOrbit}
            activity={activity}
          />
        </Suspense>
      </Canvas>
      {!hideOverlays ? <BannerOverlay buckets={buckets} /> : null}
      {!hideOverlays ? <Legend /> : null}
      {!hideOverlays ? (
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-md bg-ink-950/80 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-chalk-400">
          drag to orbit · scroll to zoom · CC0 by Kenney
        </div>
      ) : null}
    </div>
  );
}

// ----------- scene -----------

interface SceneProps {
  readonly buckets: AgentByStrip;
  readonly onAgentClick?: (agentId: number) => void;
  readonly autoOrbit: boolean;
  readonly activity: Record<number, number>;
}

function Scene({ buckets, onAgentClick, autoOrbit, activity }: SceneProps): JSX.Element {
  const world = useMemo(() => buildWorld(buckets), [buckets]);
  const totalActivity =
    (activity[0] ?? 0) + (activity[1] ?? 0) + (activity[2] ?? 0);

  return (
    <>
      <SkyAndLights activity={totalActivity / 3} />
      <DistantSea />

      {/* Hex base map */}
      {world.cells.map((c, i) => (
        <HexCellRender key={`hc-${String(i)}`} cell={c} />
      ))}

      {/* Town props placed on top of the hex base */}
      {world.props.map((p, i) => (
        <Glb
          key={`p-${String(i)}`}
          path={p.model}
          x={p.x}
          y={p.y ?? 0.2}
          z={p.z}
          rotY={p.rotY}
        />
      ))}

      {/* Walking NPCs */}
      {world.walkers.map((w, i) => (
        <Walker key={`w-${String(i)}`} spec={w} />
      ))}

      {/* Plaza portal — the only place where the 3 VANTAs converge */}
      <Portal x={0} y={0.2} z={0} buckets={buckets} />

      {/* Floating kingdom rings — each is the click target for opening
        * that VANTA's detail card. Activity (events/30s) modulates
        * the pulse rate + emissive intensity, so a busy agent's ring
        * literally glows brighter and pulses faster. */}
      {buckets.opus ? (
        <FloatingRing
          {...hexToWorld(0, 6)}
          y={2.4}
          color={buckets.opus.color_hex}
          activity={activity[0] ?? 0}
          onClick={onAgentClick ? () => onAgentClick(0) : undefined}
        />
      ) : null}
      {buckets.gpt ? (
        <FloatingRing
          {...hexToWorld(6, -4)}
          y={2.4}
          color={buckets.gpt.color_hex}
          activity={activity[1] ?? 0}
          onClick={onAgentClick ? () => onAgentClick(1) : undefined}
        />
      ) : null}
      {buckets.gemini ? (
        <FloatingRing
          {...hexToWorld(-6, -4)}
          y={2.4}
          color={buckets.gemini.color_hex}
          activity={activity[2] ?? 0}
          onClick={onAgentClick ? () => onAgentClick(2) : undefined}
        />
      ) : null}

      <OrbitControls
        target={[0, 0.5, 0]}
        maxPolarAngle={Math.PI / 2.05}
        minDistance={8}
        maxDistance={60}
        enableDamping
        autoRotate={autoOrbit}
        autoRotateSpeed={0.6}
        enabled={!autoOrbit}
      />
    </>
  );
}

// ----------- atoms -----------

function SkyAndLights({ activity }: { readonly activity: number }): JSX.Element {
  // Boost the sun a notch when the world is "busy" — subtle warm
  // pulse so a hot reasoning streak visually lifts the scene.
  const intensity = 1.5 + Math.min(0.4, activity * 0.5);
  return (
    <>
      <color attach="background" args={["#bcd9f5"]} />
      <fog attach="fog" args={["#bcd9f5", 35, 90]} />
      <hemisphereLight args={["#fff5e0", "#446b3a", 0.65]} />
      <directionalLight
        position={[10, 14, 8]}
        intensity={intensity}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
      />
    </>
  );
}

function DistantSea(): JSX.Element {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.5, 0]} receiveShadow>
      <planeGeometry args={[160, 160]} />
      <meshStandardMaterial color="#5b89bf" roughness={0.7} metalness={0.1} />
    </mesh>
  );
}

interface HexCellRenderProps {
  readonly cell: HexCell;
}

function HexCellRender({ cell }: HexCellRenderProps): JSX.Element {
  const { x, z } = hexToWorld(cell.q, cell.r);
  return (
    <group position={[x, 0, z]}>
      <Glb path={cell.tile} x={0} y={0} z={0} tint={cell.tint} />
      {cell.building ? (
        <Glb
          path={cell.building}
          x={0}
          y={0.2}
          z={0}
          rotY={cell.buildingRotY}
        />
      ) : null}
    </group>
  );
}

interface GlbProps {
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotY?: number;
  readonly tint?: string;
}

function Glb({ path, x, y, z, rotY, tint }: GlbProps): JSX.Element {
  const { scene } = useGLTF(path);
  const cloned = useMemo(() => {
    const root = scene.clone(true);
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (tint) {
          const mat = mesh.material as THREE.MeshStandardMaterial;
          const m = mat.clone();
          if ("color" in m) {
            m.color = new THREE.Color(tint).lerp(new THREE.Color("#ffffff"), 0.65);
          }
          mesh.material = m;
        }
      }
    });
    return root;
  }, [scene, tint]);
  return <primitive object={cloned} position={[x, y, z]} rotation={[0, rotY ?? 0, 0]} />;
}

interface WalkerProps {
  readonly spec: WalkerSpec;
}

/** Walking NPC — interpolates along a closed-loop path. */
function Walker({ spec }: WalkerProps): JSX.Element {
  const { scene } = useGLTF(spec.model);
  const ref = useRef<THREE.Group>(null);
  const cloned = useMemo(() => {
    const root = scene.clone(true);
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        const m = mat.clone();
        if (spec.tint && "color" in m) {
          m.color = new THREE.Color(spec.tint).lerp(new THREE.Color("#ffffff"), 0.65);
        }
        mesh.material = m;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return root;
  }, [scene, spec.tint]);

  const path = spec.path;
  useFrame((state) => {
    if (!ref.current || path.length < 2) return;
    const t = state.clock.elapsedTime * spec.speed;
    const segCount = path.length;
    const segIdx = Math.floor(t) % segCount;
    const local = t - Math.floor(t);
    const a = path[segIdx];
    const b = path[(segIdx + 1) % segCount];
    if (!a || !b) return;
    const x = a.x + (b.x - a.x) * local;
    const z = a.z + (b.z - a.z) * local;
    // walking bob
    const bob = Math.abs(Math.sin(t * Math.PI * 4)) * 0.04;
    ref.current.position.set(x, 0.2 + bob, z);
    ref.current.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
  });

  return (
    <group ref={ref}>
      <primitive object={cloned} scale={0.18} />
    </group>
  );
}

interface FloatingCharacterProps {
  readonly model: string;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly tint: string;
}

function FloatingCharacter({ model, x, y, z, tint }: FloatingCharacterProps): JSX.Element {
  const { scene } = useGLTF(model);
  const ref = useRef<THREE.Group>(null);
  const cloned = useMemo(() => {
    const root = scene.clone(true);
    root.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
        const m = mat.clone();
        if (tint && tint !== "#ffffff" && "color" in m) {
          m.color = new THREE.Color(tint).lerp(new THREE.Color("#ffffff"), 0.65);
        }
        mesh.material = m;
        mesh.castShadow = true;
      }
    });
    return root;
  }, [scene, tint]);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    ref.current.position.y = y + Math.abs(Math.sin(t * 2 + x)) * 0.06;
    ref.current.rotation.y = Math.sin(t * 0.7 + x) * 0.5;
  });
  return (
    <group ref={ref} position={[x, y, z]}>
      <primitive object={cloned} scale={0.18} />
    </group>
  );
}

interface PortalProps {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly buckets: AgentByStrip;
}

/**
 * Central PORTAL — the only place the 3 VANTAs converge. Visually:
 *   - A flat glowing disc on the ground (the gateway floor)
 *   - A vertical beam of light shooting up
 *   - Three orbiting energy spheres (one tinted per kingdom)
 *   - A floating purple core crystal that pulses
 *   - A ring of sparkles around the base
 */
function Portal({ x, y, z, buckets }: PortalProps): JSX.Element {
  const opusColor = buckets.opus?.color_hex ?? "#9b6bff";
  const gptColor = buckets.gpt?.color_hex ?? "#4fae5a";
  const geminiColor = buckets.gemini?.color_hex ?? "#4287f5";
  return (
    <group position={[x, y, z]}>
      {/* Glowing disc on the ground */}
      <PortalDisc />
      {/* Vertical beam */}
      <PortalBeam />
      {/* Floating core crystal */}
      <PortalCore />
      {/* Three orbiting agent-emblems */}
      <OrbitOrb radius={1.2} color={opusColor} angleOffset={0} speed={0.6} y={0.6} />
      <OrbitOrb radius={1.2} color={gptColor} angleOffset={(Math.PI * 2) / 3} speed={0.6} y={0.6} />
      <OrbitOrb radius={1.2} color={geminiColor} angleOffset={(Math.PI * 4) / 3} speed={0.6} y={0.6} />
    </group>
  );
}

function PortalDisc(): JSX.Element {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    const mat = ref.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 1.4 + Math.sin(t * 1.8) * 0.6;
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
      <ringGeometry args={[0.5, 1.0, 64]} />
      <meshStandardMaterial
        color="#a37cff"
        emissive="#9255ff"
        emissiveIntensity={1.4}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function PortalBeam(): JSX.Element {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    ref.current.scale.set(1 + Math.sin(t * 2) * 0.08, 1, 1 + Math.sin(t * 2) * 0.08);
    const mat = ref.current.material as THREE.MeshStandardMaterial;
    mat.opacity = 0.55 + Math.sin(t * 2.4) * 0.2;
  });
  return (
    <mesh ref={ref} position={[0, 1.6, 0]}>
      <cylinderGeometry args={[0.35, 0.5, 3.2, 24, 1, true]} />
      <meshStandardMaterial
        color="#c9a8ff"
        emissive="#9255ff"
        emissiveIntensity={1.0}
        transparent
        opacity={0.6}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function PortalCore(): JSX.Element {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    ref.current.rotation.y = t * 1.2;
    ref.current.rotation.x = Math.sin(t * 0.6) * 0.3;
    ref.current.position.y = 1.0 + Math.sin(t * 1.6) * 0.2;
  });
  return (
    <group ref={ref} position={[0, 1.0, 0]}>
      <mesh castShadow>
        <octahedronGeometry args={[0.32, 0]} />
        <meshStandardMaterial
          color="#dac8ff"
          emissive="#a37cff"
          emissiveIntensity={1.4}
          roughness={0.15}
          metalness={0.5}
        />
      </mesh>
    </group>
  );
}

interface OrbitOrbProps {
  readonly radius: number;
  readonly color: string;
  readonly angleOffset: number;
  readonly speed: number;
  readonly y: number;
}

function OrbitOrb({ radius, color, angleOffset, speed, y }: OrbitOrbProps): JSX.Element {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime * speed + angleOffset;
    ref.current.position.x = Math.cos(t) * radius;
    ref.current.position.z = Math.sin(t) * radius;
    ref.current.position.y = y + Math.sin(t * 2) * 0.15;
  });
  return (
    <mesh ref={ref} position={[radius, y, 0]} castShadow>
      <sphereGeometry args={[0.18, 16, 16]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={1.2}
        roughness={0.2}
        metalness={0.4}
      />
    </mesh>
  );
}

interface FloatingCrystalProps {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function FloatingCrystal({ x, y, z }: FloatingCrystalProps): JSX.Element {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    ref.current.rotation.y = t * 1.0;
    ref.current.rotation.x = Math.sin(t * 0.7) * 0.2;
    ref.current.position.y = y + Math.sin(t * 1.6) * 0.15;
  });
  return (
    <group ref={ref} position={[x, y, z]}>
      <mesh castShadow>
        <octahedronGeometry args={[0.22, 0]} />
        <meshStandardMaterial
          color="#a37cff"
          emissive="#7445ff"
          emissiveIntensity={1.1}
          roughness={0.2}
          metalness={0.4}
        />
      </mesh>
    </group>
  );
}

interface FloatingRingProps {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: string;
  /** 0..1 — events/30s normalised. Faster pulse + brighter glow at 1. */
  readonly activity?: number;
  readonly onClick?: () => void;
}

function FloatingRing({ x, y, z, color, activity = 0, onClick }: FloatingRingProps): JSX.Element {
  const ref = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    // Rotation speed scales with activity: idle 1.2 rad/s, busy 3.0
    const spinRate = 1.2 + activity * 1.8;
    ref.current.rotation.x = Math.PI / 2;
    ref.current.rotation.z = t * spinRate;
    // Bob amplitude grows slightly when busy
    const bobAmp = 0.18 + activity * 0.08;
    ref.current.position.y = y + Math.sin(t * 1.2 + x) * bobAmp;

    // Heartbeat pulse modulates emissive intensity. Period shrinks
    // with activity — a hot agent's ring breathes fast.
    if (matRef.current) {
      const period = 1.6 - activity * 1.0; // 1.6s idle → 0.6s busy
      const phase = (t / period) * Math.PI * 2;
      const baseGlow = 0.85 + activity * 0.6;
      const pulse = (Math.sin(phase) * 0.5 + 0.5) * (0.4 + activity * 0.4);
      matRef.current.emissiveIntensity = baseGlow + pulse;
    }
  });

  // Scale the visible ring slightly with activity so a chatty
  // kingdom is more visible from the orbit camera.
  const scale = 1 + activity * 0.18;

  return (
    <mesh
      ref={ref}
      position={[x, y, z]}
      scale={scale}
      castShadow
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      onPointerOver={
        onClick ? () => (document.body.style.cursor = "pointer") : undefined
      }
      onPointerOut={
        onClick ? () => (document.body.style.cursor = "auto") : undefined
      }
    >
      <torusGeometry args={[0.42, 0.11, 14, 28]} />
      <meshStandardMaterial
        ref={matRef}
        color={color}
        emissive={color}
        emissiveIntensity={0.95}
        metalness={0.55}
        roughness={0.25}
      />
    </mesh>
  );
}

// ----------- preload -----------

const PRELOAD_PATHS: readonly string[] = [
  // Hex tiles
  "/hex/grass.glb",
  "/hex/grass-forest.glb",
  "/hex/grass-hill.glb",
  "/hex/sand.glb",
  "/hex/sand-desert.glb",
  "/hex/sand-rocks.glb",
  "/hex/stone.glb",
  "/hex/stone-hill.glb",
  "/hex/stone-mountain.glb",
  "/hex/stone-rocks.glb",
  "/hex/water.glb",
  "/hex/water-island.glb",
  "/hex/path-square.glb",
  "/hex/path-straight.glb",
  "/hex/river-straight.glb",
  "/hex/dirt-lumber.glb",
  // Hex buildings
  "/hex/building-castle.glb",
  "/hex/building-wizard-tower.glb",
  "/hex/building-mill.glb",
  "/hex/building-tower.glb",
  "/hex/building-house.glb",
  "/hex/building-market.glb",
  "/hex/building-farm.glb",
  "/hex/building-village.glb",
  "/hex/building-sheep.glb",
  "/hex/building-port.glb",
  "/hex/building-dock.glb",
  "/hex/building-cabin.glb",
  "/hex/building-walls.glb",
  "/hex/building-archery.glb",
  "/hex/building-mine.glb",
  "/hex/building-smelter.glb",
  "/hex/building-watermill.glb",
  "/hex/unit-mill.glb",
  "/hex/unit-house.glb",
  "/hex/unit-mansion.glb",
  "/hex/unit-tower.glb",
  "/hex/unit-ship.glb",
  // Town close-ups
  "/town/fountain-center.glb",
  "/town/lantern.glb",
  "/town/cart.glb",
  "/town/cart-high.glb",
  "/town/stall-red.glb",
  "/town/stall-green.glb",
  "/town/banner-red.glb",
  "/town/banner-green.glb",
  // Characters
  "/chars/character-a.glb",
  "/chars/character-b.glb",
  "/chars/character-c.glb",
  "/chars/character-d.glb",
  "/chars/character-e.glb",
  "/chars/character-f.glb",
  "/chars/character-g.glb",
  "/chars/character-h.glb",
  "/chars/character-i.glb",
  "/chars/character-j.glb",
  "/chars/character-k.glb",
  "/chars/character-l.glb",
  "/chars/character-m.glb",
  "/chars/character-n.glb",
  "/chars/character-o.glb",
  "/chars/character-p.glb",
  "/chars/character-q.glb",
  "/chars/character-r.glb",
];
for (const p of PRELOAD_PATHS) useGLTF.preload(p);

// ----------- HTML overlays -----------

function BannerOverlay({ buckets }: { readonly buckets: AgentByStrip }): JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center gap-12 font-mono text-xs">
      {buckets.gemini ? <BannerPill agent={buckets.gemini} /> : null}
      {buckets.opus ? <BannerPill agent={buckets.opus} /> : null}
      {buckets.gpt ? <BannerPill agent={buckets.gpt} /> : null}
    </div>
  );
}

function BannerPill({ agent }: { readonly agent: V3AgentSummary }): JSX.Element {
  return (
    <div className="flex items-center gap-2 rounded-full bg-ink-950/80 px-3 py-1.5 text-chalk-100 ring-1 ring-ink-700">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: agent.color_hex }}
        aria-hidden
      />
      <span>{agent.name}</span>
      <span className="text-chalk-500">id #{String(agent.agent_id)}</span>
    </div>
  );
}

function Legend(): JSX.Element {
  return (
    <div className="pointer-events-none absolute right-3 top-3 rounded-2xl bg-ink-950/80 p-3 text-[10px] font-mono text-chalk-300 ring-1 ring-ink-800">
      <div className="mb-1.5 uppercase tracking-[0.22em] text-chalk-500">kingdoms</div>
      <ul className="space-y-1">
        <li>
          <span className="inline-block h-2 w-2 rounded-full bg-[#9b6bff] align-middle" />{" "}
          opus · stone · wizard tower (S)
        </li>
        <li>
          <span className="inline-block h-2 w-2 rounded-full bg-[#4fae5a] align-middle" />{" "}
          gpt · grass · farms + market (NE)
        </li>
        <li>
          <span className="inline-block h-2 w-2 rounded-full bg-[#4287f5] align-middle" />{" "}
          gemini · sand · ports + ships (NW)
        </li>
      </ul>
      <div className="mt-3 text-chalk-500">plaza at centre · meeting ground</div>
    </div>
  );
}
