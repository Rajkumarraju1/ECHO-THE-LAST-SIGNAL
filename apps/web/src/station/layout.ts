/**
 * Station geometry — the single source of truth for every renderer.
 *
 * World space: 640×660 units. Rooms leave a 20px corridor gap so a room's
 * south wall extrusion (WALL_S = 14px) never touches the north lip of the
 * room below. Pixel mapping: px = world units * PX_PER_UNIT.
 *
 * Presentational only: every value here is display data. Nothing in this file
 * is consulted by the server, core, or protocol packages.
 */

export const PX_PER_UNIT = 1;
export const WALL_S = 14; // south face depth (px)
export const WALL_E = 10; // east face width (px)

export type StationRoomId = "command" | "engineering" | "communications" | "navigation" | "medical";

export interface RoomBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  accent: string;
}

/** Floor plates in world units. Layout mirrors the real adjacency graph: command hub, four departments. */
export const ROOMS: Record<StationRoomId, RoomBox> = {
  engineering:    { x: 30,  y: 30,  w: 275, h: 160, label: "Engineering",    accent: "#f0b429" },
  communications: { x: 335, y: 30,  w: 275, h: 160, label: "Communications", accent: "#b48ee8" },
  command:        { x: 30,  y: 250, w: 275, h: 160, label: "Command",        accent: "#f2a35c" },
  navigation:     { x: 335, y: 250, w: 275, h: 160, label: "Navigation",     accent: "#5ad1e6" },
  medical:        { x: 182, y: 470, w: 275, h: 155, label: "Medical",        accent: "#6fe3a5" }
};

/** Doorways: rectangles bridging two rooms, matching the server's station graph exactly. */
export interface DoorBox {
  a: StationRoomId;
  b: StationRoomId;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const DOORS: DoorBox[] = [
  { a: "engineering",    b: "communications", x: 289, y: 95,  w: 62, h: 34 }, // crosses eng east face + comms west lip
  { a: "engineering",    b: "command",        x: 145, y: 174, w: 44, h: 92 }, // crosses eng south face + command north lip
  { a: "communications", b: "navigation",     x: 435, y: 174, w: 44, h: 92 },
  { a: "command",        b: "navigation",     x: 289, y: 315, w: 62, h: 34 },
  { a: "command",        b: "medical",        x: 275, y: 394, w: 44, h: 92 }
];

/** Server adjacency, restated for renderers (move validation always happens server-side). */
export const NEIGHBORS: Record<StationRoomId, StationRoomId[]> = {
  command: ["engineering", "communications", "navigation", "medical"],
  engineering: ["command", "communications"],
  communications: ["command", "engineering", "navigation"],
  navigation: ["command", "communications"],
  medical: ["command"]
};

/** Machinery silhouettes in world units (base plate at x,y; each prop carries its room accent). */
export interface PropBox {
  kind: "console" | "coil" | "dish" | "holo" | "pod";
  x: number;
  y: number;
  w: number;
  h: number;
  accent: string;
}

export const PROPS: PropBox[] = [
  { kind: "console", x: 60,  y: 70,  w: 86, h: 30, accent: "#f0b429" }, // engineering power console
  { kind: "coil",    x: 220, y: 105, w: 34, h: 52, accent: "#f0b429" }, // K-7 relay coil
  { kind: "console", x: 360, y: 70,  w: 92, h: 30, accent: "#b48ee8" }, // comms signal console
  { kind: "dish",    x: 530, y: 95,  w: 34, h: 30, accent: "#b48ee8" }, // antenna base
  { kind: "holo",    x: 130, y: 320, w: 82, h: 40, accent: "#f2a35c" }, // command holo table
  { kind: "console", x: 360, y: 285, w: 98, h: 30, accent: "#5ad1e6" }, // navigation console
  { kind: "pod",     x: 205, y: 495, w: 26, h: 52, accent: "#6fe3a5" }, // medical cryo pods
  { kind: "pod",     x: 245, y: 495, w: 26, h: 52, accent: "#6fe3a5" },
  { kind: "console", x: 370, y: 520, w: 80, h: 30, accent: "#6fe3a5" }  // medical console
];

/** Default world point per room (50,50 in authoritative coords maps here unless overridden below). */
export const ROOM_CENTER: Record<StationRoomId, { x: number; y: number }> = (() => {
  const out = {} as Record<StationRoomId, { x: number; y: number }>;
  for (const [id, box] of Object.entries(ROOMS)) {
    out[id as StationRoomId] = { x: box.x + box.w / 2, y: box.y + box.h * 0.62 };
  }
  return out;
})();

/**
 * Maps an authoritative position to a scene point. position.x/y are 0–100
 * percentages of the room's usable floor; today's client always sends 50/50,
 * so a deterministic per-room spread keeps multiple crew in one room legible.
 * The mapping is pure: when the crew starts sending real coordinates, they
 * land in the right spot with no protocol or renderer change.
 */
export function positionToPoint(roomId: string, x: number, y: number, seatIndex: number, seatCount: number): { x: number; y: number } {
  const room = ROOMS[roomId as StationRoomId];
  if (!room) return { x: 0, y: 0 };
  const floorTop = room.y + 24;
  const floorLeft = room.x + 20;
  const floorW = room.w - 40;
  const floorH = room.h - 44;
  if (x !== 50 || y !== 50) {
    return { x: floorLeft + (x / 100) * floorW, y: floorTop + (y / 100) * floorH };
  }
  // Neutral 50/50: deterministic arc spread, evenly across the back of the room.
  const spread = Math.min(seatCount, 4);
  const offset = spread > 1 ? (seatIndex - (spread - 1) / 2) * (floorW / 4) : 0;
  const row = seatIndex >= 4 ? 26 : 0;
  return { x: room.x + room.w / 2 + offset, y: floorTop + floorH * 0.62 + row };
}

/** Crew accent palette — same hues the HUD panels already use. */
export const ROLE_COLORS: Record<string, string> = {
  engineering: "#f0b429",
  navigation: "#5ad1e6",
  medical: "#6fe3a5",
  communications: "#b48ee8",
  command: "#f2a35c",
  security: "#9db8c3",
  science: "#9db8c3",
  logistics: "#9db8c3"
};

/** Role glyphs matching the HUD's identity language (presentation only). */
export const ROLE_GLYPHS: Record<string, string> = {
  engineering: "\u2699",
  navigation: "\u2726",
  medical: "\u271a",
  communications: "\u25c9",
  command: "\u272a",
  security: "\u25a0",
  science: "\u25c6",
  logistics: "\u25ac"
};

/** Marker walk speed in world units/second (presentational interpolation). */
export const WALK_SPEED = 175;

/** Finds the door joining two rooms, if any (must match the server's graph). */
export function connectingDoor(a: StationRoomId, b: StationRoomId): DoorBox | null {
  return DOORS.find((door) => (door.a === a && door.b === b) || (door.a === b && door.b === a)) ?? null;
}

/** Department room that carries each crisis system's spatial alert (presentation mapping). */
export const SYSTEM_ROOMS: Record<string, StationRoomId> = {
  power: "engineering",
  hull: "engineering",
  lifeSupport: "medical",
  navigation: "navigation"
};

/** Corridor band drawn when the authoritative grid-isolation state is active. */
export const ISOLATION_SEAM = { x: 30, y: 232, w: 580, h: 36 };

export const WORLD = { w: 640, h: 660 };
