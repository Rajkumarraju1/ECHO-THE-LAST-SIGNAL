import {
  PROCEDURE_HULL_RECOVERY,
  PROCEDURE_LIFE_SUPPORT_RECOVERY,
  PROCEDURE_NAVIGATION_RECOVERY,
  PROCEDURE_POWER_RECOVERY
} from "./balance.js";
import { type MatchState, type SystemId } from "./types.js";
import { addCrisisLog, requireConnectedSpecialist, setSystemStability } from "./crisis.js";

interface Procedure {
  id: string;
  label: string;
  role: "engineering" | "medical" | "navigation";
  room: string;
  resource: keyof MatchState["sharedResources"];
  cost: number;
  resourceLabel: string;
  system: SystemId;
  recovery: number;
  log: string;
}

const RESOURCE_LABELS: Record<keyof MatchState["sharedResources"], string> = {
  reservePower: "reserve power",
  lifeSupportReserve: "life-support reserve",
  repairMaterials: "repair materials",
  medicalSupplies: "medical supplies"
};

export const PROCEDURES: Procedure[] = [
  {
    id: "reroute-power",
    label: "Reroute grid power",
    role: "engineering",
    room: "engineering",
    resource: "reservePower",
    cost: 1,
    resourceLabel: "reserve power",
    system: "power",
    recovery: PROCEDURE_POWER_RECOVERY,
    log: "Engineering rerouted feeders around the fault. Power is recovering."
  },
  {
    id: "recycle-atmosphere",
    label: "Recycle atmosphere",
    role: "medical",
    room: "medical",
    resource: "lifeSupportReserve",
    resourceLabel: "life-support reserve",
    cost: 1,
    system: "lifeSupport",
    recovery: PROCEDURE_LIFE_SUPPORT_RECOVERY,
    log: "Medical recycled the atmosphere scrubbers from reserve tanks. Life support is recovering."
  },
  {
    id: "patch-hull",
    label: "Patch hull breach",
    role: "engineering",
    room: "engineering",
    resource: "repairMaterials",
    cost: 1,
    resourceLabel: "repair materials",
    system: "hull",
    recovery: PROCEDURE_HULL_RECOVERY,
    log: "Engineering sealed the stress fractures with patch plating. Hull integrity is recovering."
  },
  {
    id: "replot-course",
    label: "Replot on dead-reckoning",
    role: "navigation",
    room: "navigation",
    resource: "reservePower",
    cost: 1,
    resourceLabel: "reserve power",
    system: "navigation",
    recovery: PROCEDURE_NAVIGATION_RECOVERY,
    log: "Navigation replotted the route by dead-reckoning on raw beacon bearings, bypassing the corrupted chart feed. Navigation is recovering."
  }
];

export function procedureFor(id: string): Procedure | undefined {
  return PROCEDURES.find((procedure) => procedure.id === id);
}

export function procedureResourceLabel(key: keyof MatchState["sharedResources"]): string {
  return RESOURCE_LABELS[key];
}

/**
 * Executes a role-gated stabilization procedure. Requires: connected crew
 * member holding the right seat, present in the right room, and the shared
 * reserve to be affordable. Spends the resource and recovers the system —
 * including pulling it back out of an open failure window.
 */
export function runProcedure(match: MatchState, playerId: string, procedureId: string, nowMs: number): void {
  const procedure = procedureFor(procedureId);
  if (!procedure) throw new Error("Unknown station procedure.");
  const player = requireConnectedSpecialist(match, procedure.role);
  if (player.id !== playerId) throw new Error(`Only the ${procedure.role} specialist can run this procedure.`);
  if (player.position.roomId !== procedure.room) {
    throw new Error(`${procedure.label} must be run from ${procedure.room}.`);
  }
  const available = match.sharedResources[procedure.resource];
  if (available < procedure.cost) {
    throw new Error(`Not enough ${procedure.resourceLabel} in the shared reserve.`);
  }
  match.sharedResources[procedure.resource] = available - procedure.cost;
  setSystemStability(match, procedure.system, match.systems[procedure.system].stability + procedure.recovery, nowMs);
  addCrisisLog(match, {
    kind: "log",
    roomId: procedure.room,
    systemId: procedure.system,
    description: `${procedure.log} (−${procedure.cost} ${procedure.resourceLabel})`
  }, nowMs);
  match.revision += 1;
}

/**
 * Synchronized station drain: while any system sits in failure, every player
 * strains — the same consequence for the whole crew at the same moment.
 * Returns the callsigns of players who collapsed in this drain.
 */
export function applyStationDrain(match: MatchState, drainPerSystem: number): string[] {
  const failed = Object.values(match.systems).filter((system) => system.condition === "failure");
  if (failed.length === 0) return [];
  const collapsed: string[] = [];
  for (const player of Object.values(match.players)) {
    if (player.connection !== "connected" || player.incapacitated) continue;
    player.strain = Math.min(100, player.strain + drainPerSystem * failed.length);
    if (player.strain >= 100) {
      player.incapacitated = true;
      match.assistanceRequests = match.assistanceRequests.filter((request) => request.senderPlayerId !== player.id);
      match.pings = match.pings.filter((ping) => ping.senderPlayerId !== player.id);
      addCrisisLog(match, {
        kind: "log",
        roomId: player.position.roomId,
        systemId: null,
        description: `${player.callsign} has collapsed under station strain and needs rescue in ${player.position.roomId}.`
      }, Date.now());
      collapsed.push(player.callsign);
    }
  }
  match.revision += 1;
  return collapsed;
}
