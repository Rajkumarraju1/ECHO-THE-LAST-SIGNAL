/**
 * Pixi renderer for the 2.5D station — presentation only.
 *
 * Phase 2 scope: persistent crew markers that glide between authoritative
 * positions (position.roomId/x/y) through door waypoints, y-sorted against
 * room machinery, with role-identity badges and clear incapacitated /
 * reserved / handoff states. Movement is presentational interpolation of
 * authoritative state: server positions always win, paths are cosmetic.
 * Reduced motion snaps every transition instantly and disables idle animation.
 */
import { Application, Container, Graphics, Text, Ticker } from "pixi.js";
import {
  DOORS,
  ISOLATION_SEAM,
  PROPS,
  ROOMS,
  ROLE_COLORS,
  ROLE_GLYPHS,
  SYSTEM_ROOMS,
  WALK_SPEED,
  WALL_E,
  WALL_S,
  WORLD,
  connectingDoor,
  positionToPoint,
  type DoorBox,
  type PropBox,
  type StationRoomId
} from "./layout";

const hex = (value: string): number => parseInt(value.slice(1), 16);

const COLORS = {
  floorBase: hex("#10242d"),
  floorEdgeLight: 0xffffff,
  floorEdgeDark: 0x000000,
  seam: 0x000000,
  wallSouth: hex("#0a161d"),
  wallEast: hex("#060f14"),
  wallLip: hex("#1b333d"),
  label: hex("#d6e8ef"),
  threshold: hex("#6ae8df"),
  markerBody: hex("#28505e"),
  markerLabel: hex("#c7d8e2"),
  markerGlyph: hex("#071018"),
  down: hex("#ef7d7d"),
  currentRing: hex("#74f2df"),
  hoverRing: 0xffffff,
  alertAmber: hex("#eab56e"),
  alertRed: hex("#ef7d7d"),
  echoViolet: hex("#b48ee8"),
  strainOrange: hex("#ef9d7d")
};

/** Presentation-level snapshot of authoritative crisis/Echo state for the scene. */
export interface SceneFxSnapshot {
  /** systemId → condition, from public.systems. */
  alerts: Record<string, string>;
  resonance: { condition: string; pressure: number };
  isolation: { activeUntilMs: number | null; reason: string | null };
  /** Authoritative crisis log entries; new ids spawn spatial shockwaves. */
  pulses: Array<{ id: string; kind: string; roomId: string | null }>;
  /** True while the Echo decision window is open (existing scenario state). */
  echoActive: boolean;
  /** Evidence ids with echo-manifestation origin currently visible to this client. */
  echoEvidenceIds: string[];
}

export interface PlayerMarkerData {
  id: string;
  callsign: string;
  role: string | null;
  roomId: string;
  x: number;
  y: number;
  connection: "connected" | "reserved" | "handoff";
  incapacitated: boolean;
}

export interface StationSceneHandle {
  /** Reconciles crew markers with a new match view (authoritative state wins). */
  update(players: PlayerMarkerData[], currentRoom: string, fx?: SceneFxSnapshot): void;
  /** Fully tears down the Pixi application. */
  destroy(): void;
}

type Vec2 = { x: number; y: number };

/** True when the user prefers minimal motion (presentation-level only). */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Subtracts door openings from a wall band, returning drawable segments. */
function cutSegments(min: number, max: number, cuts: Array<[number, number]>): Array<[number, number]> {
  const segments: Array<[number, number]> = [];
  let cursor = min;
  for (const [from, to] of cuts.slice().sort((a, b) => a[0] - b[0])) {
    if (from > cursor) segments.push([cursor, Math.min(from, max)]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < max) segments.push([cursor, max]);
  return segments;
}

function southCuts(room: StationRoomId): Array<[number, number]> {
  const box = ROOMS[room];
  const faceTop = box.y + box.h;
  return DOORS
    .filter((door) => door.x + door.w > box.x && door.x < box.x + box.w && door.y < faceTop + WALL_S && door.y + door.h > faceTop)
    .map((door) => [Math.max(door.x, box.x), Math.min(door.x + door.w, box.x + box.w)]);
}

function eastCuts(room: StationRoomId): Array<[number, number]> {
  const box = ROOMS[room];
  const faceLeft = box.x + box.w;
  return DOORS
    .filter((door) => door.y + door.h > box.y && door.y < box.y + box.h && door.x < faceLeft + WALL_E && door.x + door.w > faceLeft)
    .map((door) => [Math.max(door.y, box.y), Math.min(door.y + door.h, box.y + box.h)]);
}

function northCuts(room: StationRoomId): Array<[number, number]> {
  const box = ROOMS[room];
  return DOORS
    .filter((door) => door.x + door.w > box.x && door.x < box.x + box.w && door.y < box.y && door.y + door.h > box.y - 6)
    .map((door) => [Math.max(door.x, box.x), Math.min(door.x + door.w, box.x + box.w)]);
}

function westCuts(room: StationRoomId): Array<[number, number]> {
  const box = ROOMS[room];
  return DOORS
    .filter((door) => door.y + door.h > box.y && door.y < box.y + box.h && door.x < box.x && door.x + door.w > box.x - 6)
    .map((door) => [Math.max(door.y, box.y), Math.min(door.y + door.h, box.y + box.h)]);
}

function drawFloor(g: Graphics, roomId: StationRoomId): void {
  const room = ROOMS[roomId];
  g.roundRect(room.x + 5, room.y + 10, room.w, room.h + WALL_S + 4, 8).fill({ color: 0x000000, alpha: 0.22 });
  g.roundRect(room.x + 2, room.y + 5, room.w, room.h + WALL_S + 2, 8).fill({ color: 0x000000, alpha: 0.25 });
  g.roundRect(room.x, room.y, room.w, room.h, 6).fill({ color: COLORS.floorBase, alpha: 1 });
  g.moveTo(room.x + 3, room.y + room.h - 3).lineTo(room.x + 3, room.y + 3).lineTo(room.x + room.w - 3, room.y + 3)
    .stroke({ color: COLORS.floorEdgeLight, width: 2, alpha: 0.06 });
  g.moveTo(room.x + 3, room.y + room.h - 3).lineTo(room.x + room.w - 3, room.y + room.h - 3).lineTo(room.x + room.w - 3, room.y + 3)
    .stroke({ color: COLORS.floorEdgeDark, width: 2, alpha: 0.45 });
  for (let i = 1; i <= 2; i++) {
    const sx = room.x + (room.w * i) / 3;
    g.moveTo(sx, room.y + 6).lineTo(sx, room.y + room.h - 6).stroke({ color: COLORS.seam, width: 1, alpha: 0.22 });
  }
  g.moveTo(room.x + 8, room.y + room.h * 0.62).lineTo(room.x + room.w - 8, room.y + room.h * 0.62)
    .stroke({ color: COLORS.seam, width: 1, alpha: 0.22 });
}

function drawWalls(g: Graphics, roomId: StationRoomId): void {
  const room = ROOMS[roomId];
  for (const [a, b] of cutSegments(room.x, room.x + room.w, northCuts(roomId))) {
    g.rect(a, room.y - 5, b - a, 5).fill({ color: COLORS.wallLip, alpha: 1 });
  }
  for (const [a, b] of cutSegments(room.y, room.y + room.h, westCuts(roomId))) {
    g.rect(room.x - 4, a, 4, b - a).fill({ color: COLORS.wallLip, alpha: 1 });
  }
  for (const [a, b] of cutSegments(room.x, room.x + room.w, southCuts(roomId))) {
    g.rect(a, room.y + room.h, b - a, WALL_S).fill({ color: COLORS.wallSouth, alpha: 1 });
    for (let sx = a + 17; sx < b; sx += 34) {
      g.moveTo(sx, room.y + room.h + 2).lineTo(sx, room.y + room.h + WALL_S - 2)
        .stroke({ color: COLORS.floorEdgeLight, width: 1, alpha: 0.05 });
    }
  }
  for (const [a, b] of cutSegments(room.y, room.y + room.h, eastCuts(roomId))) {
    g.rect(room.x + room.w, a - 5, WALL_E, b - a + 5 + WALL_S).fill({ color: COLORS.wallEast, alpha: 1 });
  }
}

function drawDoor(g: Graphics, door: DoorBox): void {
  g.rect(door.x, door.y, door.w, door.h).fill({ color: COLORS.floorBase, alpha: 1 });
  const vertical = door.h > door.w;
  if (vertical) {
    for (const jx of [door.x + 2, door.x + door.w - 4]) {
      g.moveTo(jx, door.y).lineTo(jx, door.y + door.h).stroke({ color: COLORS.threshold, width: 2, alpha: 0.45 });
    }
  } else {
    for (const jy of [door.y + 2, door.y + door.h - 4]) {
      g.moveTo(door.x, jy).lineTo(door.x + door.w, jy).stroke({ color: COLORS.threshold, width: 2, alpha: 0.45 });
    }
  }
}

function drawProp(g: Graphics, prop: PropBox): void {
  const accent = hex(prop.accent);
  g.rect(prop.x + 3, prop.y + prop.h - 4, prop.w, 8).fill({ color: 0x000000, alpha: 0.3 });
  switch (prop.kind) {
    case "console": {
      g.roundRect(prop.x, prop.y, prop.w, prop.h, 4).fill({ color: hex("#173039"), alpha: 1 });
      g.roundRect(prop.x, prop.y, prop.w, prop.h, 4).stroke({ color: COLORS.wallSouth, width: 2, alpha: 1 });
      g.rect(prop.x + 5, prop.y + 5, prop.w - 10, 12).fill({ color: accent, alpha: 0.8 });
      g.rect(prop.x + 5, prop.y + 20, prop.w - 10, 4).fill({ color: 0x000000, alpha: 0.35 });
      break;
    }
    case "coil": {
      g.roundRect(prop.x, prop.y, prop.w, prop.h, 8).fill({ color: hex("#1d3a44"), alpha: 1 });
      g.roundRect(prop.x, prop.y, prop.w, prop.h, 8).stroke({ color: COLORS.wallSouth, width: 2, alpha: 1 });
      g.moveTo(prop.x + 8, prop.y + 8).lineTo(prop.x + prop.w - 8, prop.y + prop.h - 14)
        .stroke({ color: accent, width: 2, alpha: 0.8 });
      g.moveTo(prop.x + prop.w - 8, prop.y + 8).lineTo(prop.x + 8, prop.y + prop.h - 14)
        .stroke({ color: accent, width: 2, alpha: 0.8 });
      break;
    }
    case "dish": {
      g.circle(prop.x + prop.w / 2, prop.y + prop.h / 2, prop.w / 2).fill({ color: hex("#1d3a44"), alpha: 1 });
      g.circle(prop.x + prop.w / 2, prop.y + prop.h / 2, prop.w / 2).stroke({ color: COLORS.wallSouth, width: 2, alpha: 1 });
      g.arc(prop.x + prop.w / 2, prop.y + prop.h / 2, prop.w / 3.2, 0.4, 2.6).stroke({ color: accent, width: 2, alpha: 0.8 });
      break;
    }
    case "holo": {
      g.ellipse(prop.x + prop.w / 2, prop.y + prop.h / 2, prop.w / 2, prop.h / 2)
        .fill({ color: hex("#1d3a44"), alpha: 1 });
      g.ellipse(prop.x + prop.w / 2, prop.y + prop.h / 2, prop.w / 2, prop.h / 2)
        .stroke({ color: COLORS.wallSouth, width: 2, alpha: 1 });
      g.ellipse(prop.x + prop.w / 2, prop.y + prop.h / 2 - 6, prop.w / 2.9, prop.h / 3.4)
        .fill({ color: accent, alpha: 0.45 });
      break;
    }
    case "pod": {
      g.roundRect(prop.x, prop.y, prop.w, prop.h, 10).fill({ color: hex("#1d3a44"), alpha: 1 });
      g.roundRect(prop.x, prop.y, prop.w, prop.h, 10).stroke({ color: COLORS.wallSouth, width: 2, alpha: 1 });
      g.roundRect(prop.x + 4, prop.y + 6, prop.w - 8, prop.h * 0.42, 5).fill({ color: accent, alpha: 0.7 });
      break;
    }
  }
}

function doorCenter(door: DoorBox): Vec2 {
  return { x: door.x + door.w / 2, y: door.y + door.h / 2 };
}

/**
 * Cosmetically plausible waypoints between two authoritative positions:
 * current point → my room's door mouth → their room's door mouth → target.
 * Pure presentation; server validation is untouched.
 */
function travelPath(from: Vec2, fromRoom: string, toRoom: string, to: Vec2): Vec2[] {
  const points: Vec2[] = [{ ...from }];
  if (fromRoom === toRoom) {
    points.push({ ...to });
    return points;
  }
  const door = connectingDoor(fromRoom as StationRoomId, toRoom as StationRoomId);
  if (door) {
    const mouth = doorCenter(door);
    points.push({ ...mouth }, { ...mouth }, { ...to });
  } else {
    // No direct door on the render graph: glide directly (server still validates).
    points.push({ ...to });
  }
  return points;
}

interface MarkerParts {
  root: Container;
  bobNode: Container;
  body: Graphics;
  badge: Text | null;
  label: Text;
  halo: Graphics;
  shadow: Graphics;
}

/** Grounded figure with role badge, state halo, blob shadow, and callsign label. */
function buildMarker(player: PlayerMarkerData, world: Vec2): MarkerParts {
  const root = new Container();
  root.position.set(world.x, world.y);

  const shadow = new Graphics();
  shadow.ellipse(0, 2, player.incapacitated ? 16 : 10, 4.5).fill({ color: 0x000000, alpha: 0.45 });
  root.addChild(shadow);

  const bobNode = new Container();
  root.addChild(bobNode);

  const color = hex(ROLE_COLORS[player.role ?? ""] ?? "#9db8c3");
  const faded = player.connection !== "connected";
  const body = new Graphics();
  body.alpha = faded ? 0.55 : 1;

  const halo = new Graphics();
  if (faded) {
    // Dashed state ring: reserved = longer dashes, handoff = fine dashes.
    const [on, off] = player.connection === "reserved" ? [5, 4] : [2, 5];
    let angle = 0;
    while (angle < Math.PI * 2) {
      halo.arc(0, 2, 13, angle, Math.min(angle + (on / 13), Math.PI * 2));
      halo.stroke({ color, width: 1.5, alpha: 0.7 });
      angle += (on + off) / 13;
    }
  }

  let badge: Text | null = null;
  if (player.incapacitated) {
    body.roundRect(-13, -9, 26, 10, 5).fill({ color, alpha: 1 });
    body.circle(17, -4, 5).fill({ color, alpha: 1 });
    const bang = new Text({ text: "!", style: { fontFamily: "Inter, sans-serif", fontSize: 12, fontWeight: "700", fill: COLORS.down } });
    bang.anchor.set(0.5);
    bang.position.set(0, -24);
    const pulse = new Graphics();
    pulse.circle(0, -24, 15).fill({ color: COLORS.down, alpha: 0.16 });
    bobNode.addChild(pulse, body, bang);
  } else {
    body.roundRect(-7, -24, 14, 22, 6).fill({ color, alpha: 1 });
    body.circle(0, -27, 6.5).fill({ color, alpha: 1 });
    body.rect(-4, -29, 8, 2.5).fill({ color: COLORS.markerGlyph, alpha: 0.85 });
    const glyph = ROLE_GLYPHS[player.role ?? ""];
    if (glyph) {
      badge = new Text({ text: glyph, style: { fontFamily: "Inter, sans-serif", fontSize: 9, fontWeight: "700", fill: COLORS.markerGlyph } });
      badge.anchor.set(0.5);
      badge.position.set(0, -14);
      bobNode.addChild(badge);
    }
    bobNode.addChild(body);
  }

  const label = new Text({
    text: (faded ? "\u29b6 " : "") + player.callsign,
    style: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 10, fontWeight: "600", fill: player.incapacitated ? COLORS.down : COLORS.markerLabel }
  });
  label.anchor.set(0.5);
  label.position.set(0, player.incapacitated ? -44 : -40);
  label.alpha = faded ? 0.7 : 1;
  root.addChild(halo, label);
  return { root, bobNode, body, badge, label, halo, shadow };
}

export async function createStationScene(
  host: HTMLElement,
  onRoomClick: (roomId: StationRoomId) => void
): Promise<StationSceneHandle> {
  const app = new Application();
  await app.init({
    background: hex("#050b10"),
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    autoDensity: true,
    // Dev-only: keeps the drawing buffer readable for pixel-level QA probes.
    preserveDrawingBuffer: import.meta.env.DEV,
    width: Math.max(320, host.clientWidth || 640),
    height: Math.max(240, host.clientHeight || 420)
  });
  app.canvas.style.width = "100%";
  app.canvas.style.display = "block";
  host.appendChild(app.canvas);

  const reduced = { enabled: prefersReducedMotion() };
  const applyMotionPreference = () => {
    reduced.enabled = prefersReducedMotion();
    if (reduced.enabled) {
      // Reduced motion: pin the camera to the static fit framing.
      cam.emphasis = 0;
      cam.panX = cam.panY = cam.tPanX = cam.tPanY = 0;
      cam.zoom = cam.tZoom = 1;
    }
  };
  try {
    window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", applyMotionPreference);
  } catch {
    /* older engines: snapshot taken once above */
  }

  // Camera rig: sits between the stage and the world so every existing
  // coordinate stays world-space. Presentation-only framing (Phase 4).
  const rig = new Container();
  app.stage.addChild(rig);
  const world = new Container();
  rig.addChild(world);

  // ——— Phase 4: restrained cinematic camera ———
  // Base framing is the fit-to-viewport transform (with a small inset that
  // reserves a margin budget), so the whole station always stays in frame at
  // any viewport size (mobile-safe). Emphasis only eases a small pan and a
  // small zoom toward the point of interest, hard-capped by the reserved
  // margin per axis — the station can never leave the playable frame. Targets
  // decay on their own and exponential smoothing cannot overshoot, so the
  // camera never shakes.
  const CAM = { panEase: 0.18, panClampWorld: 40, zoomEase: 0.07, decayPerSec: 0.82, settle: 3.5, fitInset: 0.94 };
  const rigBase = { x: 0, y: 0, scale: 1, w: 640, h: 660 };
  const cam = { panX: 0, panY: 0, zoom: 1, tPanX: 0, tPanY: 0, tZoom: 1, emphasis: 0, poi: { x: WORLD.w / 2, y: WORLD.h / 2 } };
  /** Gentle pull toward a world point; strength 0..1 decays on its own. */
  const emphasize = (worldX: number, worldY: number, strength = 0.5) => {
    if (reduced.enabled) return;
    cam.poi = { x: worldX, y: worldY };
    cam.emphasis = Math.min(1, cam.emphasis + strength);
  };
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
  const stepCamera = (ticker: Ticker) => {
    const dt = Math.min(0.05, ticker.deltaMS / 1000);
    cam.emphasis = Math.max(0, cam.emphasis * Math.pow(CAM.decayPerSec, dt));
    if (reduced.enabled) cam.emphasis = 0;
    // Margin budget reserved by the fit inset, per axis (≥ 0 by construction).
    const scaledW = WORLD.w * rigBase.scale;
    const scaledH = WORLD.h * rigBase.scale;
    const budget = Math.max(0, Math.min(
      Math.min(rigBase.x, rigBase.w - rigBase.x - scaledW),
      Math.min(rigBase.y, rigBase.h - rigBase.y - scaledH)
    ));
    // Pan and zoom split the budget; neither can push the station out of frame.
    const maxPanScreen = Math.min(CAM.panClampWorld * rigBase.scale, 0.5 * budget);
    const halfMax = Math.max(scaledW, scaledH) / 2;
    const maxZoomExtra = Math.min(CAM.zoomEase, (0.5 * budget) / halfMax);
    // Targets from the current emphasis (pan in screen px around the pivot).
    const centerX = (rigBase.w / 2 - rigBase.x) / rigBase.scale;
    const centerY = (rigBase.h / 2 - rigBase.y) / rigBase.scale;
    cam.tPanX = clamp((cam.poi.x - centerX) * CAM.panEase * cam.emphasis * rigBase.scale, maxPanScreen * cam.emphasis);
    cam.tPanY = clamp((cam.poi.y - centerY) * CAM.panEase * cam.emphasis * rigBase.scale, maxPanScreen * cam.emphasis);
    cam.tZoom = 1 + maxZoomExtra * cam.emphasis;
    // Exponential settle toward targets — smooth, overshoot-free.
    const k = 1 - Math.exp(-CAM.settle * dt);
    cam.panX += (cam.tPanX - cam.panX) * k;
    cam.panY += (cam.tPanY - cam.panY) * k;
    cam.zoom += (cam.tZoom - cam.zoom) * k;
    // Pivot at the viewport center: scale/pan around the middle of the frame.
    rig.pivot.set(rigBase.w / 2, rigBase.h / 2);
    rig.position.set(rigBase.w / 2 + cam.panX, rigBase.h / 2 + cam.panY);
    rig.scale.set(cam.zoom);
  };

  const staticLayer = new Container();
  for (const roomId of Object.keys(ROOMS) as StationRoomId[]) drawFloor(staticLayer.addChild(new Graphics()), roomId);
  for (const door of DOORS) drawDoor(staticLayer.addChild(new Graphics()), door);
  for (const roomId of Object.keys(ROOMS) as StationRoomId[]) drawWalls(staticLayer.addChild(new Graphics()), roomId);
  for (const prop of PROPS) drawProp(staticLayer.addChild(new Graphics()), prop);
  world.addChild(staticLayer);

  for (const [roomId, room] of Object.entries(ROOMS)) {
    const label = new Text({
      text: room.label.toUpperCase(),
      style: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 13, fontWeight: "600", fill: COLORS.label, letterSpacing: 2 }
    });
    label.anchor.set(0.5);
    label.position.set(room.x + room.w / 2, room.y + 22);
    label.alpha = 0.85;
    staticLayer.addChild(label);
  }

  const hoverRing = new Graphics();
  const hitAreas = new Map<StationRoomId, Graphics>();
  for (const [roomId, room] of Object.entries(ROOMS) as Array<[StationRoomId, (typeof ROOMS)[StationRoomId]]>) {
    const hit = new Graphics();
    hit.rect(room.x, room.y, room.w, room.h).fill({ color: 0xffffff, alpha: 0.0001 });
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.on("pointertap", () => onRoomClick(roomId));
    hit.on("pointerover", () => {
      hoverRing.clear();
      hoverRing.roundRect(room.x + 1, room.y + 1, room.w - 2, room.h - 2, 5)
        .stroke({ color: COLORS.hoverRing, width: 2, alpha: 0.3 });
    });
    hit.on("pointerout", () => {
      hoverRing.clear();
    });
    hitAreas.set(roomId, hit);
    world.addChild(hit);
  }
  world.addChild(hoverRing);

  const currentRing = new Graphics();
  // Depth layer: markers and machinery silhouettes share one y-sorted pass.
  const depthLayer = new Container();
  world.addChild(currentRing, depthLayer);

  // Prop silhouettes as sortable stand-ins so markers pass in front/behind.
  const propNodes = PROPS.map((prop) => {
    const node = new Container();
    node.zIndex = prop.y + prop.h - 4;
    node.position.set(prop.x, prop.y);
    node.visible = false; // geometry already drawn statically; node only orders depth
    const ghost = new Graphics();
    ghost.rect(0, 0, prop.w, prop.h).fill({ color: 0xffffff, alpha: 0.0001 });
    node.addChild(ghost);
    depthLayer.addChild(node);
    return { prop, node };
  });

  // ——— Phase 3: spatial crisis & Echo effects (presentation only) ———
  const fxLayer = new Container();
  world.addChild(fxLayer);

  // Room-level alert tints: one translucent wash per department room.
  const alertTints: Partial<Record<StationRoomId, Graphics>> = {};
  for (const roomId of Object.keys(ROOMS) as StationRoomId[]) {
    const room = ROOMS[roomId];
    const tint = new Graphics();
    tint.visible = false;
    fxLayer.addChild(tint);
    alertTints[roomId] = tint;
  }
  const seam = new Graphics();
  seam.visible = false;
  fxLayer.addChild(seam);
  const shimmer = new Graphics();
  fxLayer.addChild(shimmer);
  const ventRing = new Graphics();
  fxLayer.addChild(ventRing);

  const alertColor = (condition: string): number | null => {
    if (condition === "critical") return COLORS.alertAmber;
    if (condition === "failure" || condition === "terminal") return COLORS.alertRed;
    return null;
  };

  interface Shockwave { ring: Graphics; x: number; y: number; radius: number; max: number; color: number; width: number; ttl: number }
  interface Afterimage { root: Container; age: number; ttl: number; seed: number; drift: Vec2 }
  const waves: Shockwave[] = [];
  const afterimages: Afterimage[] = [];

  const spawnShockwave = (roomId: string, color: number, max = 240, width = 6) => {
    const room = ROOMS[roomId as StationRoomId];
    if (!room) return;
    const ring = new Graphics();
    fxLayer.addChild(ring);
    waves.push({ ring, x: room.x + room.w / 2, y: room.y + room.h * 0.62, radius: 10, max, color, width, ttl: 1 });
  };

  /** Presentation mapping: a band-wide pulse's affected room, from its existing kind. */
  const roomForPulse = (pulse: { kind: string; roomId: string | null }): string | null => {
    if (pulse.roomId) return pulse.roomId;
    if (pulse.kind === "surge") return "engineering";   // power grid hit
    if (pulse.kind === "strain") return "engineering";  // hull/cooling hit
    if (pulse.kind === "interference") return "communications"; // the band
    return null;
  };

  /** Violet alternate-state figures: offset, desyncing, fading — never mistaken for crew. */
  const spawnAfterimages = (roomId: string, count = 3) => {
    const room = ROOMS[roomId as StationRoomId];
    if (!room || afterimages.length > 12) return;
    const anchor = { x: room.x + room.w / 2, y: room.y + room.h * 0.62 };
    for (let i = 0; i < count; i++) {
      const offset = i - (count - 1) / 2;
      const root = new Container();
      root.position.set(anchor.x + offset * 16 + (Math.random() * 8 - 4), anchor.y + offset * 7);
      const ghost = new Graphics();
      const alpha = 0.34 - i * 0.07;
      ghost.roundRect(-7, -24, 14, 22, 6).fill({ color: COLORS.echoViolet, alpha });
      ghost.circle(0, -27, 6.5).fill({ color: COLORS.echoViolet, alpha: alpha * 0.9 });
      ghost.roundRect(-13, -36, 26, 38, 8).stroke({ color: COLORS.echoViolet, width: 1, alpha: 0.3 });
      root.addChild(ghost);
      const tag = new Text({
        text: "ECHO",
        style: { fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif", fontSize: 8, fontWeight: "700", fill: COLORS.echoViolet, letterSpacing: 2 }
      });
      tag.anchor.set(0.5);
      tag.position.set(0, -44);
      tag.alpha = 0.55;
      root.addChild(tag);
      root.alpha = reduced.enabled ? 0.5 : 0.9;
      fxLayer.addChild(root);
      afterimages.push({ root, age: 0, ttl: 3.2 + i * 0.4, seed: Math.random() * Math.PI * 2, drift: { x: offset * 6 + 3, y: -13 - i * 4 } });
    }
    spawnShockwave(roomId, COLORS.echoViolet, 150, 4);
  };

  interface FxState {
    alerts: Record<string, string>;
    resonanceCondition: string;
    seamActive: boolean;
    ventActive: boolean;
    echoActive: boolean;
    seenPulses: Set<string>;
    seenEchoEvidence: Set<string>;
  }
  const fx: FxState = { alerts: {}, resonanceCondition: "stable", seamActive: false, ventActive: false, echoActive: false, seenPulses: new Set(), seenEchoEvidence: new Set() };

  /** Ambient pass: tints, seam, resonance shimmer, vent rings — redrawn per tick. */
  const applyTint = (t: number) => {
    for (const [roomId, tint] of Object.entries(alertTints) as Array<[StationRoomId, Graphics]>) {
      const condition = fx.alerts[roomId];
      const color = condition ? alertColor(condition) : null;
      if (!color) {
        tint.visible = false;
        continue;
      }
      const room = ROOMS[roomId];
      const base = condition === "failure" || condition === "terminal" ? 0.15 : 0.09;
      const flicker = reduced.enabled ? 0 : condition === "failure" || condition === "terminal" ? 0.05 * Math.sin(t * 6) : 0.03 * Math.sin(t * 3.1);
      tint.visible = true;
      tint.clear();
      tint.roundRect(room.x, room.y, room.w, room.h, 6).fill({ color, alpha: Math.max(0.04, base + flicker) });
    }
    seam.visible = fx.seamActive;
    if (fx.seamActive) {
      seam.clear();
      seam.roundRect(ISOLATION_SEAM.x, ISOLATION_SEAM.y, ISOLATION_SEAM.w, ISOLATION_SEAM.h, 10)
        .fill({ color: COLORS.alertRed, alpha: reduced.enabled ? 0.05 : 0.05 + 0.02 * Math.sin(t * 2.4) });
      for (let sx = ISOLATION_SEAM.x; sx < ISOLATION_SEAM.x + ISOLATION_SEAM.w; sx += 30) {
        seam.moveTo(sx, ISOLATION_SEAM.y + ISOLATION_SEAM.h).lineTo(sx + 22, ISOLATION_SEAM.y)
          .stroke({ color: COLORS.alertRed, width: 2, alpha: 0.28 });
      }
    }
    shimmer.clear();
    ventRing.clear();
    if (fx.resonanceCondition === "unstable" || fx.resonanceCondition === "critical") {
      const room = ROOMS.communications;
      const cx = room.x + room.w / 2;
      const cy = room.y + room.h * 0.62;
      const phase = reduced.enabled ? 0.5 : (t * 0.22) % 1;
      const count = fx.resonanceCondition === "critical" ? 4 : 3;
      for (let i = 0; i < count; i++) {
        const p = (phase + i / count) % 1;
        shimmer.circle(cx, cy, 18 + p * 300).stroke({ color: COLORS.echoViolet, width: 2, alpha: (1 - p) * 0.15 });
      }
    }
    if (fx.ventActive) {
      const dish = PROPS.find((entry) => entry.kind === "dish");
      if (dish) {
        const dcx = dish.x + dish.w / 2;
        const dcy = dish.y + dish.h / 2;
        for (let i = 0; i < 2; i++) {
          const p = reduced.enabled ? 0.5 : ((t * 0.5 + i / 2) % 1);
          ventRing.circle(dcx, dcy, 10 + p * 36).stroke({ color: COLORS.echoViolet, width: 1.5, alpha: (1 - p) * 0.4 });
        }
      }
    }
  };

  const updateFx = (dt: number, t: number) => {
    for (let i = waves.length - 1; i >= 0; i--) {
      const wave = waves[i];
      if (!wave) continue;
      let waveAlpha: number;
      if (reduced.enabled) {
        // Reduced motion: one static ring, brief hold, no expansion.
        wave.radius = wave.max * 0.55;
        wave.ttl -= dt;
        waveAlpha = wave.ttl > 0 ? 0.5 : 0;
      } else {
        wave.radius += 260 * dt;
        waveAlpha = Math.max(0, 1 - wave.radius / wave.max);
      }
      if (waveAlpha <= 0.01) {
        wave.ring.destroy();
        waves.splice(i, 1);
        continue;
      }
      wave.ring.clear();
      wave.ring.circle(wave.x, wave.y, wave.radius)
        .stroke({ color: wave.color, width: Math.max(1, wave.width * waveAlpha), alpha: waveAlpha * 0.8 });
    }
    for (let i = afterimages.length - 1; i >= 0; i--) {
      const ghost = afterimages[i];
      if (!ghost) continue;
      ghost.age += dt;
      const life = ghost.age / ghost.ttl;
      if (life >= 1) {
        ghost.root.destroy({ children: true });
        afterimages.splice(i, 1);
        continue;
      }
      if (reduced.enabled) {
        ghost.root.alpha = 0.5 * (1 - life);
      } else {
        ghost.root.x += ghost.drift.x * dt;
        ghost.root.y += ghost.drift.y * dt;
        ghost.root.x += Math.sin(t * 7 + ghost.seed) * life * 0.6;
        ghost.root.alpha = 0.9 * (1 - life) * (0.75 + 0.25 * Math.sin(t * 2 + ghost.seed));
      }
    }
  };
  app.ticker.add((ticker) => applyTint(performance.now() / 1000));
  app.ticker.add((ticker) => updateFx(Math.min(0.05, ticker.deltaMS / 1000), performance.now() / 1000));
  app.ticker.add(stepCamera);

  interface MarkerState {
    id: string;
    parts: MarkerParts;
    world: Vec2;
    path: Vec2[] | null;
    segment: number;
    roomId: string;
  }
  const markers = new Map<string, MarkerState>();

  const place = (state: MarkerState, world2: Vec2) => {
    state.world = { ...world2 };
    state.parts.root.position.set(world2.x, world2.y);
    state.parts.root.zIndex = world2.y;
  };

  const stepMarkers = (ticker: Ticker) => {
    const dt = Math.min(0.05, ticker.deltaMS / 1000);
    const t = performance.now() / 1000;
    for (const state of markers.values()) {
      if (state.path) {
        const last = state.path[state.path.length - 1];
        const target = state.path[state.segment];
        if (!last || !target) {
          state.path = null;
        } else if (reduced.enabled) {
          state.path = null;
          place(state, last);
        } else {
          const dx = target.x - state.world.x;
          const dy = target.y - state.world.y;
          const dist = Math.hypot(dx, dy);
          const pace = (state.segment === 1 || state.segment === state.path.length - 2) ? WALK_SPEED * 0.75 : WALK_SPEED;
          const stepLen = pace * dt;
          if (dist <= stepLen) {
            place(state, target);
            state.segment += 1;
            if (state.segment >= state.path.length) state.path = null;
          } else {
            place(state, { x: state.world.x + (dx / dist) * stepLen, y: state.world.y + (dy / dist) * stepLen });
          }
        }
      }
      const { parts } = state;
      const walking = Boolean(state.path);
      parts.bobNode.y = walking || reduced.enabled ? 0 : Math.sin(t * 2.2 + state.world.x * 0.05) * 1.2;
      parts.label.visible = !walking;
    }
    depthLayer.children.sort((a, b) => a.zIndex - b.zIndex);
  };
  app.ticker.add(stepMarkers);

  const applySize = () => {
    const w = Math.max(320, host.clientWidth || 640);
    const h = Math.max(240, host.clientHeight || 420);
    app.renderer.resize(w, h);
    // Base fit: whole station visible and centered, with a small inset that
    // reserves margin for camera emphasis (viewport bounds guarantee).
    const scale = Math.min(w / WORLD.w, h / WORLD.h) * CAM.fitInset;
    rigBase.x = (w - WORLD.w * scale) / 2;
    rigBase.y = (h - WORLD.h * scale) / 2;
    rigBase.scale = scale;
    rigBase.w = w;
    rigBase.h = h;
    world.scale.set(scale);
    world.position.set(rigBase.x, rigBase.y);
  };
  const observer = new ResizeObserver(applySize);
  observer.observe(host);
  applySize();

  // Dev-only debug hook for pixel-QA probes; stripped from production builds.
  if (import.meta.env.DEV) {
    (globalThis as { __echoScene?: unknown }).__echoScene = { markers, depthLayer, world, fx, spawnShockwave, spawnAfterimages, waves, afterimages, alertTints, app, reduced, cam, rig, rigBase, emphasize, stepCamera };
  }

  /** Applies an authoritative fx snapshot; new pulse ids spawn spatial shockwaves. */
  const applyFxSnapshot = (snapshot: SceneFxSnapshot) => {
    // Per-system alert state → the department room that carries it.
    const roomAlerts: Record<string, string> = {};
    for (const [systemId, condition] of Object.entries(snapshot.alerts)) {
      const roomId = SYSTEM_ROOMS[systemId];
      if (roomId && (condition === "critical" || condition === "failure" || condition === "terminal")) {
        roomAlerts[roomId] = roomAlerts[roomId] === "failure" ? "failure" : condition;
      }
    }
    fx.alerts = roomAlerts;
    fx.resonanceCondition = snapshot.resonance.condition;
    fx.seamActive = snapshot.isolation.reason === "grid-isolation" && (snapshot.isolation.activeUntilMs ?? 0) > Date.now();
    fx.ventActive = snapshot.isolation.reason === "echo-vent" && (snapshot.isolation.activeUntilMs ?? 0) > Date.now();
    for (const pulse of snapshot.pulses) {
      if (fx.seenPulses.has(pulse.id)) continue;
      fx.seenPulses.add(pulse.id);
      const roomId = roomForPulse(pulse);
      if (!roomId) continue;
      const color = pulse.kind === "interference" ? COLORS.echoViolet : pulse.kind === "strain" ? COLORS.strainOrange : pulse.kind === "surge" ? COLORS.alertAmber : COLORS.threshold;
      spawnShockwave(roomId, color, pulse.kind === "interference" ? 300 : 240, pulse.kind === "log" ? 3 : 6);
      if (pulse.kind === "interference") spawnAfterimages(roomId, 3);
      // Major pulses only: log entries never move the camera.
      if (pulse.kind !== "log") {
        const room2 = ROOMS[roomId as StationRoomId];
        if (room2) emphasize(room2.x + room2.w / 2, room2.y + room2.h * 0.62, pulse.kind === "interference" ? 0.6 : 0.5);
      }
    }
    if (fx.seenPulses.size > 64) fx.seenPulses = new Set([...fx.seenPulses].slice(-32));
    // Echo-manifestation evidence surfacing → afterimages + restrained
    // emphasis at the band's room.
    for (const id of snapshot.echoEvidenceIds) {
      if (!fx.seenEchoEvidence.has(id)) {
        fx.seenEchoEvidence.add(id);
        spawnAfterimages("communications", 3);
        const comms = ROOMS.communications;
        emphasize(comms.x + comms.w / 2, comms.y + comms.h * 0.62, 0.45);
      }
    }
    // Decision-window opening edge: one burst, one gentle pull — not a loop.
    if (snapshot.echoActive && !fx.echoActive) {
      spawnAfterimages("communications", 4);
      const comms = ROOMS.communications;
      emphasize(comms.x + comms.w / 2, comms.y + comms.h * 0.62, 0.55);
    }
    fx.echoActive = snapshot.echoActive;
  };

  const reconcileMarker = (player: PlayerMarkerData, target: Vec2) => {
    const existing = markers.get(player.id);
    if (!existing) {
      const parts = buildMarker(player, target);
      const state: MarkerState = { id: player.id, parts, world: { ...target }, path: null, segment: 0, roomId: player.roomId };
      parts.root.zIndex = target.y;
      depthLayer.addChild(parts.root);
      markers.set(player.id, state);
      return;
    }
    const movedRoom = existing.roomId !== player.roomId;
    const movedPoint = Math.hypot(existing.world.x - target.x, existing.world.y - target.y) > 1;
    if (reduced.enabled || (!movedRoom && !movedPoint)) {
      if (movedRoom || movedPoint) place(existing, target);
    } else if (movedRoom || movedPoint) {
      existing.path = travelPath(existing.world, existing.roomId, player.roomId, target);
      existing.segment = 1;
    }
    existing.roomId = player.roomId;
    // Rebuild only when identity visuals change (role/state), not every revision.
    const identityKey = `${player.role}|${player.connection}|${player.incapacitated}`;
    const parts = existing.parts as MarkerParts & { identity?: string };
    if (parts.identity !== identityKey) {
      const fresh = buildMarker(player, existing.world) as MarkerParts & { identity?: string };
      fresh.identity = identityKey;
      fresh.root.zIndex = existing.parts.root.zIndex;
      depthLayer.removeChild(existing.parts.root);
      existing.parts.root.destroy({ children: true });
      existing.parts = fresh;
      depthLayer.addChild(fresh.root);
    }
  };

  return {
    update(players, currentRoom, fxSnapshot?: SceneFxSnapshot) {
      if (fxSnapshot) applyFxSnapshot(fxSnapshot);
      const seen = new Set<string>();
      // Per-room seat spread: occupants of a room share its arc.
      const byRoom = new Map<string, PlayerMarkerData[]>();
      for (const player of players.slice().sort((a, b) => a.id.localeCompare(b.id))) {
        seen.add(player.id);
        const list = byRoom.get(player.roomId) ?? [];
        list.push(player);
        byRoom.set(player.roomId, list);
      }
      for (const [roomId, occupants] of byRoom) {
        occupants.forEach((player, index) => {
          const target = positionToPoint(roomId, player.x, player.y, index, occupants.length);
          reconcileMarker(player, target);
        });
      }
      for (const [id, state] of [...markers]) {
        if (!seen.has(id)) {
          depthLayer.removeChild(state.parts.root);
          state.parts.root.destroy({ children: true });
          markers.delete(id);
        }
      }
      currentRing.clear();
      const room = ROOMS[currentRoom as StationRoomId];
      if (room) {
        currentRing.roundRect(room.x + 1, room.y + 1, room.w - 2, room.h - 2, 5)
          .stroke({ color: COLORS.currentRing, width: 2.5, alpha: 0.9 });
      }
    },
    destroy() {
      app.ticker.remove(stepMarkers);
      app.ticker.remove(stepCamera);
      observer.disconnect();
      try {
        window.matchMedia("(prefers-reduced-motion: reduce)").removeEventListener("change", applyMotionPreference);
      } catch {
        /* ignore */
      }
      markers.clear();
      app.destroy(true, { children: true, texture: false });
    }
  };
}
