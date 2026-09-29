export const STATION_ROOMS = ["command", "engineering", "communications", "navigation", "medical"] as const;
export type StationRoomId = (typeof STATION_ROOMS)[number];

const CONNECTIONS: Record<StationRoomId, readonly StationRoomId[]> = {
  command: ["engineering", "communications", "navigation", "medical"],
  engineering: ["command", "communications"],
  communications: ["command", "engineering", "navigation"],
  navigation: ["command", "communications"],
  medical: ["command"]
};

export function isStationRoom(value: string): value is StationRoomId {
  return STATION_ROOMS.includes(value as StationRoomId);
}

export function canTransition(from: StationRoomId, to: StationRoomId): boolean {
  return from === to || CONNECTIONS[from].includes(to);
}
