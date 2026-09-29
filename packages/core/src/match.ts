import { applyResonanceRelief, setSystemStability } from "./crisis.js";
import { deliverDistressCall, NEW_SCENARIO_LEADS, performDeepListen } from "./scenario.js";
import {
  type ClientMatchView,
  type EvidenceAnnotation,
  type EvidenceOrigin,
  type EvidenceRecord,
  type EvidenceView,
  type MatchState,
  type PingKind,
  type PlayerState,
  type Role,
  SYSTEM_IDS,
  type SystemId
} from "./types.js";
import { canTransition, isStationRoom, type StationRoomId } from "./station.js";
import { SEED_POWER_STABILITY, SEED_RESONANCE_PRESSURE, RELAY_CONTAINMENT_RESONANCE_RELIEF } from "./balance.js";
import type { ScenarioInvestigation } from "./types.js";
import { advanceScenarioActs, isEchoDecisionAvailable, maybeRunManifestation } from "./scenario.js";
import { advanceCrisisClock } from "./crisis.js";

const INITIAL_ROOM = "command";

function makeSystems(): MatchState["systems"] {
  return Object.fromEntries(
    SYSTEM_IDS.map((id) => [id, { id, condition: "stable", stability: 100, recoveryWindow: { openedAtMs: null, expiresAtMs: null } }])
  ) as MatchState["systems"];
}

export function createMatch(id: string, seed: number): MatchState {
  return {
    id,
    seed,
    revision: 0,
    phase: "lobby",
    players: {},
    systems: makeSystems(),
    resonance: { condition: "stable", pressure: 0 },
    sharedResources: { reservePower: 6, lifeSupportReserve: 4, repairMaterials: 6, medicalSupplies: 4 },
    crisis: { nextPulseAtMs: null, pulseSeq: 0, pulses: [], isolation: { activeUntilMs: null, reason: null }, pendingOperations: {}, lastSweepAtMs: null, sweepCount: 0 },
    endReason: null,
    evidence: {},
    pings: [],
    assistanceRequests: [],
    scenario: {
      seeded: false,
      distressCallAtMs: null,
      act: 1,
      actStartedAtMs: { 1: null, 2: null, 3: null, 4: null },
      confirmedLeads: [],
      manifestationIds: [],
      echoDecision: null,
      pendingEchoDecision: null,
      debrief: null,
      distressOrigin: "derelict-hull"
    },
    cooperativeOperation: { id: "relay-containment", status: "unresolved", proposedByPlayerId: null, confirmedByPlayerId: null }
  };
}

export function addPlayer(match: MatchState, id: string, callsign: string): PlayerState {
  if (match.phase !== "lobby") throw new Error("The roster is locked.");
  if (match.players[id]) throw new Error("Player already exists.");
  if (Object.keys(match.players).length >= 8) throw new Error("The room is full.");

  const player: PlayerState = {
    id,
    callsign,
    role: null,
    position: { roomId: INITIAL_ROOM, x: 50, y: 50 },
    connection: "connected",
    reconnectDeadlineMs: null,
    incapacitated: false,
    strain: 0
  };
  match.players[id] = player;
  match.revision += 1;
  return player;
}

export function assignRole(match: MatchState, playerId: string, role: Role): void {
  const player = requirePlayer(match, playerId);
  if (match.phase !== "lobby") throw new Error("Roles cannot change after launch.");
  if (Object.values(match.players).some((candidate) => candidate.id !== playerId && candidate.role === role)) {
    throw new Error("That specialist seat is already occupied.");
  }
  player.role = role;
  match.revision += 1;
}

export function launchMatch(match: MatchState): void {
  const players = Object.values(match.players);
  if (players.length < 2) throw new Error("At least two players are required.");
  if (players.some((player) => player.role === null)) throw new Error("Every player needs a role.");
  match.phase = "active";
  seedStationScenario(match);
  match.revision += 1;
}

/** Establishes the shared physical situation the asymmetric briefings describe. */
function seedStationScenario(match: MatchState): void {
  if (match.scenario.seeded) return;
  match.scenario.seeded = true;
  changeSystemCondition(match, "power", SEED_POWER_STABILITY);
  match.resonance = { condition: "unstable", pressure: SEED_RESONANCE_PRESSURE };
  deliverDistressCall(match, Date.now());
}

export function addEvidence(match: MatchState, evidence: EvidenceRecord): void {
  if (match.evidence[evidence.id]) throw new Error("Evidence ID already exists.");
  requirePlayer(match, evidence.reporterId);
  if (evidence.visibility === "private" && !evidence.recipientPlayerId) {
    throw new Error("Private evidence requires an authorized recipient.");
  }
  if (evidence.visibility === "shared" && evidence.recipientPlayerId) {
    throw new Error("Shared evidence cannot have a private recipient.");
  }
  match.evidence[evidence.id] = evidence;
  match.revision += 1;
}

export function shareEvidence(match: MatchState, evidenceId: string, actorId: string): void {
  const evidence = match.evidence[evidenceId];
  if (!evidence) throw new Error("Evidence does not exist.");
  if (evidence.recipientPlayerId !== actorId && evidence.reporterId !== actorId) {
    throw new Error("Only an authorized player can share this evidence.");
  }
  if (evidence.visibility === "shared") {
    throw new Error("This evidence is already on the shared crew board.");
  }
  evidence.visibility = "shared";
  evidence.recipientPlayerId = null;
  evidence.sharedByPlayerId = actorId;
  evidence.sharedAtMs = Date.now();
  match.revision += 1;
}

export function annotateEvidence(match: MatchState, evidenceId: string, actorId: string, content: string, nowMs: number): void {
  const evidence = requireSharedEvidence(match, evidenceId);
  requirePlayer(match, actorId);
  const annotation: EvidenceAnnotation = { id: `annotation-${match.revision + 1}`, authorPlayerId: actorId, content: content.trim(), createdAtMs: nowMs };
  if (!annotation.content) throw new Error("Annotations cannot be empty.");
  evidence.annotations.push(annotation);
  match.revision += 1;
}

export function linkEvidence(match: MatchState, sourceEvidenceId: string, targetEvidenceId: string, actorId: string): void {
  const source = requireSharedEvidence(match, sourceEvidenceId);
  const target = requireSharedEvidence(match, targetEvidenceId);
  requirePlayer(match, actorId);
  if (source.id === target.id) throw new Error("Evidence cannot link to itself.");
  if (!source.linkedEvidenceIds.includes(target.id)) source.linkedEvidenceIds.push(target.id);
  if (!target.linkedEvidenceIds.includes(source.id)) target.linkedEvidenceIds.push(source.id);
  match.revision += 1;
}

export function addPing(match: MatchState, playerId: string, kind: PingKind, roomId: string, message: string, nowMs: number): void {
  const player = requireActivePlayer(match, playerId);
  const target = requireStationRoom(roomId, "Unknown station room.");
  if (message.trim().length > 80) throw new Error("Ping message is too long.");
  if (!isAdjacentRoom(player.position.roomId as StationRoomId, target)) {
    throw new Error("You can only ping rooms you occupy or that adjoin your position.");
  }
  match.pings.push({ id: `ping-${match.revision + 1}`, senderPlayerId: player.id, kind, roomId: target, message: message.trim(), createdAtMs: nowMs });
  match.pings = match.pings.slice(-12);
  match.revision += 1;
}

export function requestAssistance(match: MatchState, playerId: string, requestedRole: Role, message: string, nowMs: number): void {
  const player = requireActivePlayer(match, playerId);
  if (message.trim().length > 80) throw new Error("Request message is too long.");
  const specialist = Object.values(match.players).find((candidate) => candidate.role === requestedRole);
  if (!specialist) throw new Error(`No crew member holds the ${requestedRole} seat.`);
  if (specialist.id === player.id) throw new Error("You already hold that specialist seat.");
  match.assistanceRequests.push({ id: `request-${match.revision + 1}`, senderPlayerId: player.id, requestedRole, roomId: player.position.roomId, message: message.trim(), createdAtMs: nowMs });
  match.assistanceRequests = match.assistanceRequests.slice(-12);
  match.revision += 1;
}

/**
 * Role-gated investigations. Each requires the specialist in their own
 * department; marked entries count as confirmed leads for the Echo decision
 * and the debrief. Leads are honest facts the crew actually extracted.
 */
const INVESTIGATION_TARGETS: ScenarioInvestigation[] = [
  {
    target: "signal-array",
    role: "communications",
    roomId: "communications",
    evidenceId: "signal-array-readout",
    title: "K-7 signal phase",
    observation: "The Echo predicts a relay K-7 containment pulse. The pulse preserves life support only if Engineering counterbalances the power load.",
    lead: true
  },
  {
    target: "power-relay",
    role: "engineering",
    roomId: "engineering",
    evidenceId: "power-relay-readout",
    title: "K-7 load trace",
    observation: "K-7's bus is running an asymmetric load: the fourth cell draws 31% above baseline and its thermal margin is nearly spent. The relay can pass exactly one containment pulse per synchronization cycle, and the counterbalance window spans the entire pulse transit — a manual offset must hold through it or the feedback arcs into the life-support buses.",
    lead: true
  },
  {
    target: "signal-origin",
    role: "navigation",
    roomId: "navigation",
    evidenceId: "signal-origin-readout",
    title: "Origin triangulation",
    observation: "The distress call's bearing folds back onto the station's own coordinates. Measured three times, the origin is this station — displaced by a route that does not exist on the current chart. The route is flyable; the chart cannot explain it.",
    lead: true
  },
  {
    target: "vital-pattern",
    role: "medical",
    roomId: "medical",
    evidenceId: "vital-pattern-readout",
    title: "Impossible vital pattern",
    observation: "The distress transmission's injury signature matches no crew member's history — yet the pattern is typed in this station's medical biometric format, to full resolution, with this shift's duty roster attached.",
    lead: true
  }
];

export function investigate(match: MatchState, playerId: string, target: string, nowMs: number): void {
  // The Echo pulse log exists only through the deep-listen operation — a
  // client asking to "investigate" it still performs the deliberate listen,
  // paying its resonance cost. There is no free path to this lead.
  if (target === "echo-pulse-log") {
    performDeepListen(match, playerId, nowMs);
    return;
  }
  const expected = INVESTIGATION_TARGETS.find((entry) => entry.target === target)
    ?? SECOND_WAVE_TARGETS.find((entry) => entry.target === target);
  if (!expected) throw new Error("Unknown investigation target.");
  const player = requireActivePlayer(match, playerId);
  if (player.role !== expected.role) throw new Error(`${expected.role} authorization is required for this investigation.`);
  if (player.position.roomId !== expected.roomId) throw new Error(`This investigation requires presence in ${expected.roomId}.`);
  if (match.evidence[expected.evidenceId]) throw new Error("This station readout has already been documented.");
  addEvidence(match, { id: expected.evidenceId, title: expected.title, observation: expected.observation, reliability: "confirmed", reporterId: playerId, discoveredAtMs: nowMs, origin: "role-instrument", visibility: "private", recipientPlayerId: playerId, sharedByPlayerId: null, sharedAtMs: null, annotations: [], linkedEvidenceIds: [] });
  if (expected.lead && !match.scenario.confirmedLeads.includes(expected.evidenceId)) match.scenario.confirmedLeads.push(expected.evidenceId);
}

/** Act II/III second-wave leads: fuller readings found by walking back to the department. */
const SECOND_WAVE_TARGETS: ScenarioInvestigation[] = NEW_SCENARIO_LEADS.map((lead) => ({ ...lead, lead: true }));

export function proposeRelayContainment(match: MatchState, playerId: string): void {
  const player = requireActivePlayer(match, playerId);
  if (player.role !== "communications") throw new Error("Communications must propose relay containment.");
  if (player.position.roomId !== "communications") throw new Error("Relay containment must be proposed from Communications.");
  const signal = requireSharedEvidence(match, "signal-array-readout");
  const load = requireSharedEvidence(match, "power-relay-readout");
  if (!signal.linkedEvidenceIds.includes(load.id)) throw new Error("Link the signal phase and load trace before proposing containment.");
  if (match.cooperativeOperation.status !== "unresolved") throw new Error("Relay containment is already in progress or complete.");
  match.cooperativeOperation.status = "proposed";
  match.cooperativeOperation.proposedByPlayerId = playerId;
  match.revision += 1;
}

export function confirmRelayContainment(match: MatchState, playerId: string): void {
  const player = requireActivePlayer(match, playerId);
  if (player.role !== "engineering") throw new Error("Engineering must confirm the load counterbalance.");
  if (player.position.roomId !== "engineering") throw new Error("Engineering must confirm containment from Engineering.");
  if (match.cooperativeOperation.status !== "proposed") throw new Error("Relay containment has not been proposed.");
  match.cooperativeOperation.status = "stabilized";
  match.cooperativeOperation.confirmedByPlayerId = playerId;
  applyResonanceRelief(match, RELAY_CONTAINMENT_RESONANCE_RELIEF, null, Date.now());
  if (!match.scenario.confirmedLeads.includes("relay-containment-record")) match.scenario.confirmedLeads.push("relay-containment-record");
  addEvidence(match, {
    id: "relay-containment-record",
    title: "Relay K-7 contained",
    observation: "Communications synchronized the Echo phase while Engineering counterbalanced the K-7 load. The containment pulse held and relay K-7 is stable.",
    reliability: "confirmed",
    reporterId: playerId,
    discoveredAtMs: Date.now(),
    origin: "operation-outcome",
    visibility: "shared",
    recipientPlayerId: null,
    sharedByPlayerId: null,
    sharedAtMs: null,
    annotations: [],
    linkedEvidenceIds: []
  });
  match.revision += 1;
}

/** Stability changes flow through the crisis module's single choke point. */
export function changeSystemCondition(match: MatchState, id: SystemId, stability: number, nowMs: number = Date.now()): void {
  setSystemStability(match, id, stability, nowMs);
}

/** Validates a movement request against the currently available placeholder station graph. */
export function movePlayer(match: MatchState, playerId: string, roomId: string, x: number, y: number): void {
  const player = requireActivePlayer(match, playerId);
  if (!isStationRoom(roomId)) throw new Error("Unknown station room.");
  if (!canTransition(player.position.roomId as Parameters<typeof canTransition>[0], roomId)) {
    throw new Error("That room is not connected to the player’s current location.");
  }
  if (x < 0 || x > 100 || y < 0 || y > 100) throw new Error("Movement is outside room bounds.");
  player.position = { roomId, x, y };
  match.revision += 1;
}

export function reserveDisconnectedPlayer(match: MatchState, playerId: string, nowMs: number): void {
  const player = requirePlayer(match, playerId);
  if (match.phase !== "active") return;
  player.connection = "reserved";
  player.reconnectDeadlineMs = nowMs + 90_000;
  match.revision += 1;
}

export function reconnectPlayer(match: MatchState, playerId: string): void {
  const player = requirePlayer(match, playerId);
  // A browser refresh can establish the replacement socket before the old one
  // closes. The server supersedes that old socket, so this is still a valid
  // reconnect rather than a second crew member.
  player.connection = "connected";
  player.reconnectDeadlineMs = null;
  match.revision += 1;
}

/** Promotes expired reserved seats to costly emergency-handoff coverage, then advances the crisis clock. */
export function advanceConnectionDeadlines(match: MatchState, nowMs: number, sweepIntervalMs?: number): void {
  for (const player of Object.values(match.players)) {
    if (player.connection === "reserved" && player.reconnectDeadlineMs !== null && nowMs >= player.reconnectDeadlineMs) {
      player.connection = "handoff";
      player.reconnectDeadlineMs = null;
      match.revision += 1;
    }
  }
  // The crisis clock ticks with the connection clock; only the server calls this.
  advanceCrisisClock(match, nowMs, sweepIntervalMs);
  advanceScenarioActs(match, nowMs);
  maybeRunManifestation(match, nowMs);
}

export function projectClientView(match: MatchState, playerId: string): ClientMatchView {
  const player = requirePlayer(match, playerId);
  const toView = (evidence: EvidenceRecord): EvidenceView => ({
    id: evidence.id,
    title: evidence.title,
    observation: evidence.observation,
    reliability: evidence.reliability,
    origin: evidence.origin,
    reporterId: evidence.reporterId,
    discoveredAtMs: evidence.discoveredAtMs,
    visibility: evidence.visibility,
    sharedByPlayerId: evidence.sharedByPlayerId,
    sharedAtMs: evidence.sharedAtMs,
    annotations: evidence.annotations.map((annotation) => ({ ...annotation })),
    linkedEvidenceIds: [...evidence.linkedEvidenceIds]
  });
  const allEvidence = Object.values(match.evidence);

  return {
    revision: match.revision,
    phase: match.phase,
    endReason: match.endReason,
    scenario: {
      act: match.scenario.act,
      distressCallAtMs: match.scenario.distressCallAtMs,
      actStartedAtMs: { ...match.scenario.actStartedAtMs },
      echoDecisionAvailable: isEchoDecisionAvailable(match),
      echoDecision: match.scenario.echoDecision ? { ...match.scenario.echoDecision } : null,
      pendingEchoDecision: match.scenario.pendingEchoDecision ? structuredClone(match.scenario.pendingEchoDecision) : null,
      debrief: match.scenario.debrief ? structuredClone(match.scenario.debrief) : null,
      confirmedLeadCount: match.scenario.confirmedLeads.length,
      distressOrigin: match.scenario.distressOrigin
    },
    public: {
      players: Object.values(match.players).map((candidate) => ({
        id: candidate.id,
        callsign: candidate.callsign,
        role: candidate.role,
        position: { ...candidate.position },
        connection: candidate.connection,
        incapacitated: candidate.incapacitated,
        strain: candidate.strain
      })),
      systems: structuredClone(match.systems),
      resonance: { ...match.resonance },
      sharedResources: { ...match.sharedResources },
      crisis: structuredClone(match.crisis)
    },
    sharedEvidence: allEvidence.filter((evidence) => evidence.visibility === "shared").map(toView),
    coordination: {
      pings: match.pings.map((ping) => ({ ...ping })),
      assistanceRequests: match.assistanceRequests.map((request) => ({ ...request })),
      cooperativeOperation: { ...match.cooperativeOperation }
    },
    private: {
      role: player.role,
      evidence: allEvidence
        .filter((evidence) => evidence.visibility === "private" && evidence.recipientPlayerId === playerId)
        .map(toView)
    }
  };
}

function requireSharedEvidence(match: MatchState, evidenceId: string): EvidenceRecord {
  const evidence = match.evidence[evidenceId];
  if (!evidence || evidence.visibility !== "shared") throw new Error("That evidence has not been shared with the crew.");
  return evidence;
}

function requireStationRoom(roomId: string, message: string): StationRoomId {
  if (!isStationRoom(roomId)) throw new Error(message);
  return roomId;
}

function isAdjacentRoom(from: StationRoomId, to: StationRoomId): boolean {
  return canTransition(from, to);
}

function requireActivePlayer(match: MatchState, playerId: string): PlayerState {
  const player = requirePlayer(match, playerId);
  if (match.phase !== "active") throw new Error("The station is not active.");
  if (player.connection !== "connected") throw new Error("Disconnected players cannot perform this action.");
  if (player.incapacitated) throw new Error("Incapacitated players cannot perform this action.");
  return player;
}

function requirePlayer(match: MatchState, playerId: string): PlayerState {
  const player = match.players[playerId];
  if (!player) throw new Error("Unknown player.");
  return player;
}
