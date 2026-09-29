import {
  CRITICAL_THRESHOLD,
  DEFAULT_SWEEP_INTERVAL_MS,
  DETERIORATION_PER_SWEEP,
  ISOLATION_DURATION_MS,
  ISOLATION_POWER_RECOVERY,
  ISOLATION_RESONANCE_RELIEF,
  LINKED_FAILURE_DRAIN,
  OPERATION_EXPIRY_MS,
  OVERRIDE_STRAIN_COST,
  PULSE_DELAY_MS,
  RESONANCE_CRITICAL_POWER_DRAIN,
  RESCUE_STRAIN_REDUCTION,
  RESONANCE_CRITICAL_PRESSURE,
  RESONANCE_INTERFERENCE_PULSE,
  RESONANCE_SPIKE_INJECT,
  RESONANCE_UNSTABLE_PRESSURE,
  RECOVERY_WINDOW_MS,
  STRAIN_LIMIT,
  STRAIN_PER_FAILED_SYSTEM,
  STRAIN_PER_ISOLATED_SWEEP,
  STRAIN_PER_SWEEP,
  STRAIN_PULSE_HULL_DAMAGE,
  SURGE_POWER_DAMAGE
} from  "./balance.js";
import {
  type CoordinatedOperationId,
  type CrisisPulseKind,
  type MatchState,
  type PendingOperation,
  type PlayerState,
  type Role,
  type SystemId,
  SYSTEM_IDS
} from "./types.js";

// Re-exported so engine consumers can import balance values from the crisis
// module exactly as before; balance.ts remains the single source of truth.
export {
  CRITICAL_THRESHOLD,
  DETERIORATION_PER_SWEEP,
  LINKED_FAILURE_DRAIN,
  RECOVERY_WINDOW_MS,
  STRAIN_LIMIT,
  STRAIN_PER_SWEEP,
  STRAIN_PER_ISOLATED_SWEEP,
  RESCUE_STRAIN_REDUCTION,
  OVERRIDE_STRAIN_COST,
  OPERATION_EXPIRY_MS,
  PULSE_DELAY_MS,
  RESONANCE_CRITICAL_PRESSURE,
  RESONANCE_UNSTABLE_PRESSURE,
  STRAIN_PER_FAILED_SYSTEM
} from "./balance.js";

const SYSTEM_LABELS: Record<SystemId, string> = {
  power: "Power",
  lifeSupport: "Life support",
  hull: "Hull integrity",
  navigation: "Navigation"
};

/** Which systems each system depends on. Deterioration flows dependency → dependent. */
const SYSTEM_DEPENDENCIES: Record<SystemId, readonly SystemId[]> = {
  power: [],
  lifeSupport: ["power"],
  hull: [],
  navigation: ["power"]
};

function dependentsOf(id: SystemId): SystemId[] {
  return SYSTEM_IDS.filter((candidate) => SYSTEM_DEPENDENCIES[candidate].includes(id));
}

export function systemLabel(id: SystemId): string {
  return SYSTEM_LABELS[id];
}

/**
 * The single choke point for every station-stability change in the game.
 * Enforces the condition ladder, recovery windows, telegraphs, and the
 * terminal end state. Recovery windows are stamped with server time only.
 */
export function setSystemStability(match: MatchState, id: SystemId, stability: number, nowMs: number): "stable" | "critical" | "failure" | "terminal" {
  const system = match.systems[id];
  const clamped = Math.max(0, Math.min(100, Math.round(stability)));
  const wasFailure = system.condition === "failure";
  system.stability = clamped;
  system.condition = clamped === 0 ? "terminal" : clamped <= 20 ? "failure" : clamped <= CRITICAL_THRESHOLD ? "critical" : "stable";

  if (system.condition === "failure") {
    if (!wasFailure) {
      system.recoveryWindow = { openedAtMs: nowMs, expiresAtMs: nowMs + RECOVERY_WINDOW_MS };
      addCrisisLog(match, {
        kind: "strain",
        roomId: null,
        systemId: id,
        description: `${SYSTEM_LABELS[id]} has failed. Recovery window open — stabilize ${SYSTEM_LABELS[id]} before it runs out.`
      }, nowMs);
    }
  } else if (system.condition !== "terminal") {
    system.recoveryWindow = { openedAtMs: null, expiresAtMs: null };
  }

  if (system.condition === "terminal") {
    addCrisisLog(match, {
      kind: "strain",
      roomId: null,
      systemId: id,
      description: `${SYSTEM_LABELS[id]} reached terminal failure. The Last Signal went silent.`
    }, nowMs);
    endMatch(match, `${SYSTEM_LABELS[id]} reached terminal failure. The Last Signal went silent.`);
  }
  match.revision += 1;
  return system.condition;
}

/** Explicitly telegraphed end state; never entered silently. */
export function endMatch(match: MatchState, reason: string): void {
  if (match.phase === "ended") return;
  match.phase = "ended";
  match.endReason = reason;
}

export function addCrisisLog(match: MatchState, entry: { kind: CrisisPulseKind; roomId: string | null; systemId: SystemId | null; description: string }, nowMs: number): void {
  match.crisis.pulseSeq += 1;
  match.crisis.pulses.push({
    id: `pulse-${match.crisis.pulseSeq}`,
    kind: entry.kind,
    roomId: entry.roomId,
    systemId: entry.systemId,
    description: entry.description,
    atMs: nowMs
  });
  match.crisis.pulses = match.crisis.pulses.slice(-12);
  match.revision += 1;
}

export interface CrisisSweepResult {
  pulses: Array<{ id: string; kind: CrisisPulseKind; description: string }>;
  isolationStarted: boolean;
  collapsedPlayers: string[];
}

/**
 * Advances the crisis clock by one sweep (~60s of station time).
 * Sweeps never spend reserves, never open overrides, and never execute
 * anything irreversible — they only move meters and open recovery windows.
 * All changes are deterministic given (match, nowMs).
 */
export function advanceCrisisClock(match: MatchState, nowMs: number, sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): CrisisSweepResult {
  if (match.phase !== "active") return { pulses: [], isolationStarted: false, collapsedPlayers: [] };
  const SWEEP_INTERVAL_MS = sweepIntervalMs;
  if (match.crisis.lastSweepAtMs === null) {
    // First tick after launch: stamp the clock, schedule the first pulse, change nothing.
    match.crisis.lastSweepAtMs = nowMs;
    match.crisis.nextPulseAtMs = nowMs + PULSE_DELAY_MS;
    return { pulses: [], isolationStarted: false, collapsedPlayers: [] };
  }
  if (nowMs - match.crisis.lastSweepAtMs < SWEEP_INTERVAL_MS) {
    return { pulses: [], isolationStarted: false, collapsedPlayers: [] };
  }
  match.crisis.lastSweepAtMs = nowMs;
  match.crisis.sweepCount += 1;

  const firedPulse = runScheduledPulse(match, nowMs);
  applyResonanceSweep(match, nowMs);
  applyDeteriorationSweep(match, nowMs);
  applyStrainSweep(match);
  const isolationStarted = advanceIsolation(match, nowMs);
  expireStaleOperations(match, nowMs);
  expireStaleEchoDecision(match, nowMs);
  updateResonanceCondition(match);
  const collapsedPlayers = applyFailureDrain(match);
  // Schedule the next pulse only after one actually fired (or before the first):
  // revising this timer on every sweep would starve the pulse schedule forever.
  if (firedPulse || match.crisis.nextPulseAtMs === null) {
    match.crisis.nextPulseAtMs = nowMs + PULSE_DELAY_MS;
  }
  return { pulses: firedPulse ? match.crisis.pulses.slice(-1) : [], isolationStarted, collapsedPlayers };
}

/** Deterministic pulse plan derived from the match seed (small controlled crisis set). */
const PULSE_SCHEDULE: Array<{ atSweep: number; kind: CrisisPulseKind; description: string }> = [
  { atSweep: 2, kind: "surge", description: "Grid surge: volatile draw spikes across the power distribution grid." },
  { atSweep: 3, kind: "interference", description: "Signal interference: comms harmonics distort the Echo band." },
  { atSweep: 4, kind: "strain", description: "Conduit strain: thermal cycling stresses the cooling network." },
  { atSweep: 6, kind: "surge", description: "Grid surge: the distribution grid lurches again." },
  { atSweep: 7, kind: "interference", description: "Signal interference: the Echo band floods with static." },
  { atSweep: 8, kind: "strain", description: "Structural flex: the hull frame groans under uneven load." },
  { atSweep: 10, kind: "surge", description: "Grid surge: cascading draw across two feeders at once." },
  { atSweep: 12, kind: "interference", description: "Signal interference: the band answers ambient noise in kind." },
  { atSweep: 13, kind: "strain", description: "Conduit strain: coolant lines hammer against loose brackets." },
  { atSweep: 14, kind: "surge", description: "Grid surge: the distribution grid lurches without warning." },
  { atSweep: 15, kind: "interference", description: "Signal interference: the Echo band resonates against the hull itself." },
  { atSweep: 17, kind: "strain", description: "Structural flex: deck plating flexes under uneven thermal load." },
  { atSweep: 19, kind: "surge", description: "Grid surge: the grid rides the edge of its tolerance." }
];

function runScheduledPulse(match: MatchState, nowMs: number): boolean {
  if (match.crisis.nextPulseAtMs === null) {
    match.crisis.nextPulseAtMs = nowMs + PULSE_DELAY_MS;
    return false;
  }
  if (nowMs < match.crisis.nextPulseAtMs) return false;
  const planned = PULSE_SCHEDULE.find((entry) => entry.atSweep === match.crisis.sweepCount);
  const pulse = planned ?? { kind: "log" as CrisisPulseKind, description: "Ambient sweep: station readings hold steady." };
  addCrisisLog(match, { kind: pulse.kind, roomId: null, systemId: null, description: pulse.description }, nowMs);
  if (pulse.kind === "surge") {
    setSystemStability(match, "power", match.systems.power.stability - SURGE_POWER_DAMAGE, nowMs);
  } else if (pulse.kind === "strain") {
    setSystemStability(match, "hull", match.systems.hull.stability - STRAIN_PULSE_HULL_DAMAGE, nowMs);
  } else if (pulse.kind === "interference") {
    applyResonancePressure(match, RESONANCE_INTERFERENCE_PULSE, "Signal interference pushes the Echo band toward resonance.", nowMs);
  }
  return true;
}

function applyDeteriorationSweep(match: MatchState, nowMs: number): void {
  for (const system of Object.values(match.systems)) {
    if (system.condition === "stable") continue;
    if (system.condition === "critical") {
      setSystemStability(match, system.id, system.stability - DETERIORATION_PER_SWEEP, nowMs);
      if (match.phase === "ended") return;
      continue;
    }
    if (system.condition === "failure") {
      if (system.recoveryWindow.expiresAtMs !== null && nowMs >= system.recoveryWindow.expiresAtMs) {
        setSystemStability(match, system.id, 0, nowMs);
        if (match.phase === "ended") return;
      }
    }
  }
  // Linked-failure drain: a failed dependency drags its dependents down faster.
  for (const system of Object.values(match.systems)) {
    if (match.phase === "ended") break;
    if (system.condition !== "failure") continue;
    for (const dependentId of dependentsOf(system.id)) {
      const dependent = match.systems[dependentId];
      if (dependent.condition === "stable" || dependent.condition === "critical") {
        setSystemStability(match, dependentId, dependent.stability - LINKED_FAILURE_DRAIN, nowMs);
      }
    }
  }
}

/**
 * Synchronized crew consequence: while any system is in failure, every
 * connected crew member accumulates strain at the same moment. Collapsed crew
 * members become rescue targets (they are never removed from the match).
 */
function applyFailureDrain(match: MatchState): string[] {
  const failedCount = Object.values(match.systems).filter((system) => system.condition === "failure").length;
  if (failedCount === 0) return [];
  const collapsed: string[] = [];
  for (const player of Object.values(match.players)) {
    if (player.incapacitated || player.connection !== "connected") continue;
    const collapsedNow = addStrain(match, player, STRAIN_PER_FAILED_SYSTEM * failedCount, "station failure strain");
    if (collapsedNow) collapsed.push(player.callsign);
  }
  return collapsed;
}

function applyStrainSweep(match: MatchState): void {
  const isolated = match.crisis.isolation.activeUntilMs !== null
    && match.crisis.isolation.activeUntilMs > 0
    && match.crisis.isolation.reason === "grid-isolation";
  for (const player of Object.values(match.players)) {
    addStrain(match, player, isolated ? STRAIN_PER_ISOLATED_SWEEP : STRAIN_PER_SWEEP, null);
  }
}

/**
 * Resonance as strategic pressure: while the band sits at critical, its
 * coupling bleeds the power grid every sweep. Strong engineering mitigates
 * this (reroutes, isolation), but the drain is not erasable — engaging or
 * ignoring the Echo both carry visible costs.
 */
function applyResonanceSweep(match: MatchState, nowMs: number): void {
  if (match.resonance.condition !== "critical") return;
  setSystemStability(match, "power", match.systems.power.stability - RESONANCE_CRITICAL_POWER_DRAIN, nowMs);
  addCrisisLog(match, {
    kind: "interference",
    roomId: null,
    systemId: null,
    description: "Resonance coupling: the critical band is bleeding the power grid. Vent the band or contain it before the feeders go down."
  }, nowMs);
}

function advanceIsolation(match: MatchState, nowMs: number): boolean {
  const until = match.crisis.isolation.activeUntilMs;
  if (until === null || until === 0) return false;
  if (nowMs >= until) {
    const wasVent = match.crisis.isolation.reason === "echo-vent";
    match.crisis.isolation.activeUntilMs = 0;
    match.crisis.isolation.reason = null;
    addCrisisLog(match, { kind: "log", roomId: null, systemId: null, description: wasVent ? "Vent cycle complete. The array shutters are sealed — the band can be heard again." : "Grid isolation ended. Station sections are reconnected." }, nowMs);
    return false;
  }
  return true;
}

/** Resource consumption is explicit and intentional; empty reserves simply do nothing. */
export function spendReserve(match: MatchState, key: keyof MatchState["sharedResources"], amount: number, reason?: string): void {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Spending requires a positive amount.");
  const available = match.sharedResources[key];
  if (available <= 0) return;
  match.sharedResources[key] = Math.max(0, available - amount);
  if (reason) {
    addCrisisLog(match, { kind: "log", roomId: null, systemId: null, description: reason }, Date.now());
  }
  match.revision += 1;
}

/** Adds strain to a player and collapses them at the limit. */
export function addStrain(match: MatchState, player: PlayerState, amount: number, reason: string | null): boolean {
  if (player.connection !== "connected" || player.incapacitated) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;
  player.strain = Math.min(STRAIN_LIMIT, player.strain + amount);
  if (player.strain >= STRAIN_LIMIT) {
    collapsePlayer(match, player, reason);
    return true;
  }
  match.revision += 1;
  return false;
}

function collapsePlayer(match: MatchState, player: PlayerState, reason: string | null): void {
  if (player.incapacitated) return;
  player.incapacitated = true;
  match.assistanceRequests = match.assistanceRequests.filter((request) => request.senderPlayerId !== player.id);
  match.pings = match.pings.filter((ping) => ping.senderPlayerId !== player.id);
  addCrisisLog(match, {
    kind: "log",
    roomId: player.position.roomId,
    systemId: null,
    description: `${player.callsign} has collapsed${reason ? ` — ${reason}` : ""} and needs rescue in ${player.position.roomId}.`
  }, Date.now());
  match.revision += 1;
}

/**
 * Rescue: Medical (co-located) ends the collapse directly; Command can order a
 * stretcher evacuation from Command at the cost of medical supplies.
 */
export function rescuePlayer(match: MatchState, rescuerId: string, targetId: string): void {
  const rescuer = requireConnectedCrew(match, rescuerId);
  const target = requirePlayerAt(match, targetId);
  if (rescuer.id === target.id) throw new Error("You cannot rescue yourself.");
  if (rescuer.role === "medical") {
    if (rescuer.position.roomId !== target.position.roomId) {
      throw new Error("Reach the collapsed crew member before administering aid.");
    }
    target.strain = Math.max(0, target.strain - RESCUE_STRAIN_REDUCTION);
    target.incapacitated = false;
    addCrisisLog(match, { kind: "log", roomId: target.position.roomId, systemId: null, description: `${rescuer.callsign} stabilized ${target.callsign}. They are back on their feet.` }, Date.now());
    match.revision += 1;
    return;
  }
  if (rescuer.role === "command") {
    if (rescuer.position.roomId !== "command") throw new Error("Command orders stretcher evacuation from Command.");
    if (match.sharedResources.medicalSupplies <= 0) {
      throw new Error("No medical supplies remain for a stretcher evacuation.");
    }
    match.sharedResources.medicalSupplies -= 1;
    target.strain = Math.max(0, target.strain - RESCUE_STRAIN_REDUCTION);
    target.incapacitated = false;
    addCrisisLog(match, { kind: "log", roomId: target.position.roomId, systemId: null, description: `${rescuer.callsign} ordered a stretcher evacuation (−1 medical supply). ${target.callsign} is back on their feet.` }, Date.now());
    match.revision += 1;
    return;
  }
  throw new Error("Only Medical can stabilize a collapse; Command can order an evacuation.");
}

/**
 * The single choke point for every Echo-band resonance pressure change in the
 * game. Pressure is clamped to 0–100, the condition ladder is re-derived from
 * the thresholds, and the revision moves so views stay synchronized.
 */
export function applyResonancePressure(match: MatchState, delta: number, reason: string | null, nowMs: number): number {
  const before = match.resonance.condition;
  const clamped = Math.max(0, Math.min(100, match.resonance.pressure + delta));
  match.resonance.pressure = clamped;
  updateResonanceCondition(match);
  if (reason) {
    addCrisisLog(match, { kind: "interference", roomId: null, systemId: null, description: reason }, nowMs);
  }
  // Tier-crossing telegraphs: resonance is never an opaque fifth health bar —
  // every change of band state names its physical consequence.
  if (before !== "critical" && match.resonance.condition === "critical") {
    addCrisisLog(match, {
      kind: "interference",
      roomId: null,
      systemId: null,
      description: "The Echo band has gone critical: its coupling now bleeds the power grid every sweep."
    }, nowMs);
  } else if (before === "stable" && match.resonance.condition === "unstable") {
    addCrisisLog(match, {
      kind: "interference",
      roomId: null,
      systemId: null,
      description: "The Echo band has gone unstable: every interference source now pushes it harder."
    }, nowMs);
  }
  match.revision += 1;
  return clamped;
}

/** Relief variant: resonance pressure drops (containment, isolation). */
export function applyResonanceRelief(match: MatchState, amount: number, reason: string | null, nowMs: number): number {
  return applyResonancePressure(match, -amount, reason, nowMs);
}

function updateResonanceCondition(match: MatchState): void {
  const pressure = match.resonance.pressure;
  match.resonance.condition = pressure >= RESONANCE_CRITICAL_PRESSURE ? "critical" : pressure >= RESONANCE_UNSTABLE_PRESSURE ? "unstable" : "stable";
}

/** Finds the connected player currently holding a specialist seat. */
export function requireConnectedSpecialist(match: MatchState, role: "engineering" | "medical" | "navigation"): PlayerState {
  const player = Object.values(match.players).find((candidate) => candidate.role === role);
  if (!player) throw new Error(`No crew member holds the ${role} seat.`);
  if (player.incapacitated) throw new Error(`The ${role} specialist is incapacitated and cannot act.`);
  if (player.connection !== "connected") throw new Error(`The ${role} specialist is not connected.`);
  return player;
}

function requirePlayerAt(match: MatchState, playerId: string): PlayerState {
  const player = match.players[playerId];
  if (!player) throw new Error("Unknown player.");
  if (!player.incapacitated) throw new Error("That crew member does not need rescue.");
  return player;
}

function requireConnectedCrew(match: MatchState, playerId: string): PlayerState {
  const player = match.players[playerId];
  if (!player) throw new Error("Unknown player.");
  if (player.incapacitated) throw new Error("Incapacitated players cannot perform this action.");
  if (player.connection !== "connected") throw new Error("Disconnected players cannot perform this action.");
  return player;
}

/** Every pending authorization older than its expiry becomes an explicit visible lapse. */
export function expireStaleOperations(match: MatchState, nowMs: number): void {
  for (const operation of Object.values(match.crisis.pendingOperations)) {
    if (operation.status === "pending" && nowMs >= operation.expiresAtMs) {
      operation.status = "expired";
      addCrisisLog(match, {
        kind: "log",
        roomId: null,
        systemId: null,
        description: `Authorization for ${operationTitle(operation.id)} expired without quorum. Nothing was executed.`
      }, nowMs);
    }
  }
}

/**
 * A proposed final Echo decision that lapses without co-authorization (or
 * without execution) becomes an explicit visible lapse at the next sweep.
 * Nothing ever executes automatically.
 */
export function expireStaleEchoDecision(match: MatchState, nowMs: number): void {
  const pending = match.scenario.pendingEchoDecision;
  if (!pending || pending.status !== "pending" || nowMs < pending.expiresAtMs) return;
  pending.status = "expired";
  addCrisisLog(match, {
    kind: "log",
    roomId: null,
    systemId: null,
    description: `The proposed ${pending.choice.toUpperCase()} decision expired without co-authorization. Nothing was executed. Command may propose again.`
  }, nowMs);
  match.revision += 1;
}

/** Proposes a quorum operation; each required seat must confirm before execution. */
export function proposeCoordinatedOperation(match: MatchState, playerId: string, id: CoordinatedOperationId, nowMs: number): void {
  const player = requireConnectedCrew(match, playerId);
  const existing = match.crisis.pendingOperations[id];
  if (existing && existing.status === "pending") throw new Error("That operation already awaits confirmation.");
  if (id === "grid-isolation") {
    if (player.role !== "engineering") throw new Error("Grid isolation must be proposed by Engineering.");
    if (player.position.roomId !== "engineering") throw new Error("Propose grid isolation from Engineering.");
  }
  const requiredRoles: Role[] = id === "grid-isolation" ? ["engineering", "command"] : [];
  match.crisis.pendingOperations[id] = {
    id,
    status: "pending",
    proposedByPlayerId: playerId,
    proposedAtMs: nowMs,
    expiresAtMs: nowMs + OPERATION_EXPIRY_MS,
    requiredRoles,
    confirmedByPlayerIds: [playerId]
  };
  match.revision += 1;
}

/** Confirms a pending quorum operation as a holder of one of its required seats. */
export function confirmCoordinatedOperation(match: MatchState, playerId: string, id: CoordinatedOperationId, nowMs: number): void {
  const player = requireConnectedCrew(match, playerId);
  const operation = match.crisis.pendingOperations[id];
  if (!operation || operation.status !== "pending") throw new Error("No pending authorization for that operation.");
  if (nowMs >= operation.expiresAtMs) {
    operation.status = "expired";
    throw new Error("That authorization expired before it gathered quorum.");
  }
  if (!operation.requiredRoles.includes(player.role as Role)) {
    throw new Error(`This operation also needs the ${operation.requiredRoles.join(" and ")} seat to confirm.`);
  }
  if (!operation.confirmedByPlayerIds.includes(playerId)) operation.confirmedByPlayerIds.push(playerId);
  const satisfied = operation.requiredRoles.every((role) => operation.confirmedByPlayerIds.some((confirmerId) => match.players[confirmerId]?.role === role));
  if (!satisfied) {
    match.revision += 1;
    return;
  }
  if (id === "grid-isolation") executeGridIsolation(match, operation, nowMs);
}

/** One station operation: split the grid for a fixed window, then auto-reconnect. */
function executeGridIsolation(match: MatchState, operation: PendingOperation, nowMs: number): void {
  operation.status = "executed";
  match.crisis.isolation.activeUntilMs = nowMs + ISOLATION_DURATION_MS;
  match.crisis.isolation.reason = "grid-isolation";
  setSystemStability(match, "power", Math.min(100, match.systems.power.stability + ISOLATION_POWER_RECOVERY), nowMs);
  applyResonanceRelief(match, ISOLATION_RESONANCE_RELIEF, null, nowMs);
  addCrisisLog(match, {
    kind: "log",
    roomId: "engineering",
    systemId: "power",
    description: "Grid isolation executed: station sections split for 90 seconds. Power stabilizes and resonance pressure drops, but strain rises faster while isolated."
  }, nowMs);
  match.revision += 1;
}

/** An emergency override is a costly, player-confirmed alternative to full quorum. */
export function proposeEmergencyOverride(match: MatchState, playerId: string, id: CoordinatedOperationId, nowMs: number): void {
  const player = requireConnectedCrew(match, playerId);
  const pending = match.crisis.pendingOperations[id];
  if (!pending || pending.status !== "pending") throw new Error("An emergency override needs an operation awaiting quorum.");
  if (nowMs >= pending.expiresAtMs) {
    pending.status = "expired";
    throw new Error("That authorization expired before the override could be declared.");
  }
  if (player.role !== "command") throw new Error("Only Command can declare an emergency override.");
  if (player.position.roomId !== "command") throw new Error("Declare emergency overrides from Command.");
  pending.status = "executed";
  if (id === "grid-isolation") executeGridIsolation(match, pending, nowMs);
  addStrain(match, player, OVERRIDE_STRAIN_COST, "emergency override");
  addCrisisLog(match, {
    kind: "log",
    roomId: null,
    systemId: null,
    description: `${player.callsign} declared an emergency override for ${operationTitle(id)}: it executed now, but Command is under strain and the quorum protocol was bypassed.`
  }, nowMs);
}

function operationTitle(id: CoordinatedOperationId): string {
  return id === "grid-isolation" ? "grid isolation" : id;
}

/**
 * Emergency fallback: one allowed substitute action per role for when the
 * natural specialist is missing. None of these reveal another role's private
 * evidence — they produce their own, weaker information.
 */
export type EmergencyFallbackRole = "medical" | "engineering" | "navigation";
export const EMERGENCY_FALLBACK_COSTS: Record<EmergencyFallbackRole, { resource: keyof MatchState["sharedResources"]; amount: number }> = {
  medical: { resource: "medicalSupplies", amount: 2 },
  engineering: { resource: "repairMaterials", amount: 2 },
  navigation: { resource: "reservePower", amount: 2 }
};

export function canUseEmergencyFallback(match: MatchState, role: EmergencyFallbackRole): boolean {
  const seatHeld = Object.values(match.players).some((player) => player.role === role);
  if (seatHeld) return false;
  const cost = EMERGENCY_FALLBACK_COSTS[role];
  return match.sharedResources[cost.resource] >= cost.amount;
}

/**
 * Command performs a slower, costlier emergency procedure in place of a
 * missing specialist. It spends shared reserves and reports degraded-quality
 * information from the command console itself.
 */
export function performEmergencyFallback(match: MatchState, playerId: string, role: EmergencyFallbackRole, nowMs: number): { evidenceId: string; title: string; observation: string } {
  const player = requireConnectedCrew(match, playerId);
  if (player.role !== "command") throw new Error("Only Command can run emergency specialist procedures.");
  if (player.position.roomId !== "command") throw new Error("Emergency specialist procedures run from Command.");
  if (!canUseEmergencyFallback(match, role)) {
    throw new Error(`The ${role} seat is occupied, or the reserve cost is not available.`);
  }
  const cost = EMERGENCY_FALLBACK_COSTS[role];
  match.sharedResources[cost.resource] -= cost.amount;
  const evidenceId = `emergency-${role}-triage`;
  const existing = match.evidence[evidenceId];
  if (existing) {
    existing.visibility = "shared";
    existing.recipientPlayerId = null;
    existing.sharedByPlayerId = playerId;
    existing.sharedAtMs = nowMs;
    match.revision += 1;
    return { evidenceId, title: existing.title, observation: existing.observation };
  }
  const title = role === "medical"
    ? "Emergency triage sweep"
    : role === "engineering"
      ? "Emergency load audit"
      : "Emergency heading reconstruction";
  const observation = role === "medical"
    ? "Command rerouted the medical console through the command deck. Bioreadings are coarse and delayed, but no immediate life-threatening pattern stands out. A trained medic would extract far more from the same data."
    : role === "engineering"
      ? "Command audited the grid through the emergency bus. The readout is coarse: one feeder is trending hot and margins are thin. A proper Engineering instrument would resolve the exact relay."
      : "Command rebuilt an approximate heading from raw beacon bearings. The route is coarse and unverified against the current chart: it is safe enough for short maneuvers, but a Navigator would have caught the drift the chart cannot explain.";
  addEvidenceRecord(match, {
    id: evidenceId,
    title,
    observation,
    reliability: "lowConfidence",
    reporterId: playerId,
    discoveredAtMs: nowMs,
    origin: "role-instrument",
    visibility: "shared",
    recipientPlayerId: null,
    annotations: [],
    linkedEvidenceIds: []
  });
  match.revision += 1;
  return { evidenceId, title, observation };
}

function addEvidenceRecord(match: MatchState, record: Pick<import("./types.js").EvidenceRecord, "id" | "title" | "observation" | "reliability" | "reporterId" | "discoveredAtMs" | "origin" | "visibility" | "recipientPlayerId" | "annotations" | "linkedEvidenceIds">): void {
  if (match.evidence[record.id]) throw new Error("Evidence ID already exists.");
  match.evidence[record.id] = {
    ...record,
    sharedByPlayerId: null,
    sharedAtMs: null
  };
}

/** Laboratory harness: applies a controlled crisis effect for tests and drills. */
export function injectCrisisEffect(match: MatchState, effect: "power-drain" | "life-support-drain" | "hull-drain" | "resonance-spike" | "strain-shock" | "targeted-shock", nowMs: number): void {
  if (!match.id.startsWith("LAB")) throw new Error("Crisis injection is only available in laboratory rooms.");
  switch (effect) {
    case "power-drain":
      setSystemStability(match, "power", match.systems.power.stability - 30, nowMs);
      break;
    case "life-support-drain":
      setSystemStability(match, "lifeSupport", match.systems.lifeSupport.stability - 30, nowMs);
      break;
    case "hull-drain":
      setSystemStability(match, "hull", match.systems.hull.stability - 40, nowMs);
      break;
    case "resonance-spike":
      applyResonancePressure(match, RESONANCE_SPIKE_INJECT, null, nowMs);
      break;
    case "strain-shock":
      for (const player of Object.values(match.players)) {
        addStrain(match, player, 100, "lab strain shock");
      }
      break;
    case "targeted-shock":
      // Drill variant that spares Command so a live rescue can be exercised.
      for (const player of Object.values(match.players)) {
        if (player.role !== "command") addStrain(match, player, 100, "lab targeted strain shock");
      }
      break;
  }
}
