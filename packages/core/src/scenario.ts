import {
  addCrisisLog,
  addStrain,
  applyResonancePressure,
  applyResonanceRelief,
  endMatch,
  setSystemStability
} from "./crisis.js";
import { debriefChoiceLine, makeDebrief } from "./debrief.js";
import {
  DEEP_LISTEN_RESONANCE_PRESSURE,
  ECHO_DECISION_EXPIRY_MS,
  ECHO_VENT_DURATION_MS,
  ECHO_VENT_REPAIR_MATERIALS_COST,
  ECHO_VENT_RESONANCE_RELIEF,
  SCENARIO_ACT_SWEEPS
} from "./balance.js";
import { addEvidence } from "./match.js";
import { type EchoDecisionChoice, type MatchState, type Role } from "./types.js";

/**
 * Act III second-wave investigations: fuller versions of the Act I leads,
 * discovered by walking back to the department and reading deeper.
 */
export const NEW_SCENARIO_LEADS: Array<{
  target: string;
  role: Role;
  roomId: string;
  evidenceId: string;
  title: string;
  observation: string;
}> = [
  {
    target: "echo-pulse-log",
    role: "communications",
    roomId: "communications",
    evidenceId: "echo-pulse-log",
    title: "The Echo pulse log",
    observation: "Re-collated with the deeper archive, the interference pulses form a repeating schedule — and it is counted in this station's sweep seconds. The call is keeping station time."
  },
  {
    target: "grid-resonance-history",
    role: "engineering",
    roomId: "engineering",
    evidenceId: "grid-resonance-history",
    title: "Grid resonance history",
    observation: "The feeder logs show every resonance spike coupling into the grid through the same relay: K-7. Whatever the band is doing, it is using the crew's own infrastructure as its antenna."
  }
];

/** True while the array is physically open to space and cannot listen. */
export function isVentActive(match: MatchState): boolean {
  return (match.crisis.isolation.activeUntilMs ?? 0) > 0 && match.crisis.isolation.reason === "echo-vent";
}

/**
 * DEEP LISTEN (Communications, from Communications, Act II+): studies the
 * band deliberately. Produces a real confirmed lead — and feeds the band
 * exactly what a listener gives it: attention.
 */
export function performDeepListen(match: MatchState, playerId: string, nowMs: number): void {
  const player = requireCrew(match, playerId);
  if (player.role !== "communications") throw new Error("Only Communications can study the Echo band directly.");
  if (player.position.roomId !== "communications") throw new Error("Deep listening requires the Communications room.");
  if (match.scenario.act < 2) throw new Error("The band has nothing legible to study before the first prediction comes true.");
  if (isVentActive(match)) throw new Error("The array is vented to space. There is nothing to listen to until the vent cycle completes.");
  if (match.evidence["echo-pulse-log"]) throw new Error("The deep listen has already been documented.");
  const pulseLogLead = NEW_SCENARIO_LEADS[0];
  if (!pulseLogLead) throw new Error("The Echo pulse log lead is not configured.");
  applyResonancePressure(match, DEEP_LISTEN_RESONANCE_PRESSURE, "Deep listen: Communications studied the band deliberately — and the band studied back.", nowMs);
  addEvidence(match, {
    id: "echo-pulse-log",
    title: "The Echo pulse log",
    observation: pulseLogLead.observation,
    reliability: "confirmed",
    reporterId: playerId,
    discoveredAtMs: nowMs,
    origin: "role-instrument",
    visibility: "private",
    recipientPlayerId: playerId,
    sharedByPlayerId: null,
    sharedAtMs: null,
    annotations: [],
    linkedEvidenceIds: []
  });
  if (!match.scenario.confirmedLeads.includes("echo-pulse-log")) match.scenario.confirmedLeads.push("echo-pulse-log");
}

/**
 * VENT THE BAND (Engineering, from Engineering, Act II+): cracks the array
 * shutters to space, dumping resonance pressure at the cost of a repair
 * material — and the station's ability to listen while the vent runs.
 */
export function performVentTheBand(match: MatchState, playerId: string, nowMs: number): void {
  const player = requireCrew(match, playerId);
  if (player.role !== "engineering") throw new Error("Only Engineering can vent the band to space.");
  if (player.position.roomId !== "engineering") throw new Error("Venting requires the Engineering room.");
  if (match.scenario.act < 2) throw new Error("The band has not built enough pressure to justify venting.");
  if (isVentActive(match)) throw new Error("The array is already vented.");
  if (match.sharedResources.repairMaterials < ECHO_VENT_REPAIR_MATERIALS_COST) {
    throw new Error("Venting needs 1 repair material for the shutter seals.");
  }
  match.sharedResources.repairMaterials -= ECHO_VENT_REPAIR_MATERIALS_COST;
  match.crisis.isolation.activeUntilMs = nowMs + ECHO_VENT_DURATION_MS;
  match.crisis.isolation.reason = "echo-vent";
  applyResonanceRelief(match, ECHO_VENT_RESONANCE_RELIEF, "Vent cycle: the array is open to space. Resonance pressure is bleeding away — and nothing on the band can be heard until it closes.", nowMs);
  addCrisisLog(match, {
    kind: "log",
    roomId: "engineering",
    systemId: null,
    description: "Engineering cracked the array shutters to space. The vent cycle runs 75 seconds."
  }, nowMs);
}

/** Launch beat: the impossible distress call arrives during the launch sweep. */
export function deliverDistressCall(match: MatchState, nowMs: number): void {
  match.scenario.distressCallAtMs = nowMs;
  match.scenario.actStartedAtMs[1] = nowMs;
  addCrisisLog(match, {
    kind: "interference",
    roomId: null,
    systemId: null,
    description: "IMPOSSIBLE DISTRESS CALL: the station's own voices warn of a reactor failure that has not happened. No ship answers the array. (Act I — Functional)"
  }, nowMs);
}

/**
 * Advances the act ladder from completed crisis sweeps. Acts telegraph before
 * they change: the crew sees the banner and keeps all earlier tools.
 */
export function advanceScenarioActs(match: MatchState, nowMs: number): void {
  const sweep = match.crisis.sweepCount;
  if (match.scenario.act === 1 && sweep >= SCENARIO_ACT_SWEEPS.act2) {
    match.scenario.act = 2;
    match.scenario.actStartedAtMs[2] = nowMs;
    addCrisisLog(match, {
      kind: "log",
      roomId: null,
      systemId: null,
      description: "The distress call's first prediction comes true. The crew starts to investigate. (Act II — Uneasy)"
    }, nowMs);
  }
  if (match.scenario.act === 2 && sweep >= SCENARIO_ACT_SWEEPS.act3) {
    match.scenario.act = 3;
    match.scenario.actStartedAtMs[3] = nowMs;
    addCrisisLog(match, {
      kind: "interference",
      roomId: null,
      systemId: null,
      description: "The Echo band floods with events that have not happened. Evidence gets harder to read. (Act III — Wrong)"
    }, nowMs);
  }
  if (match.scenario.act === 3 && sweep >= SCENARIO_ACT_SWEEPS.act4) {
    match.scenario.act = 4;
    match.scenario.actStartedAtMs[4] = nowMs;
    addCrisisLog(match, {
      kind: "strain",
      roomId: null,
      systemId: null,
      description: "Systems are failing faster than the crew can stabilize them. The final Echo decision is available at the command console. (Act IV — Failing)"
    }, nowMs);
  }
}

/** Act III Echo manifestations — honest but reality-bending; never hidden misinformation. */
const MANIFESTATIONS: Array<{ id: string; title: string; observation: string }> = [
  {
    id: "manifestation-echo-band",
    title: "The band answered",
    observation: "The Echo band carried the crew's own voices back with a half-second lead — they answered questions before anyone asked them. The words are real; the timing is not."
  },
  {
    id: "manifestation-airlock",
    title: "The inner door cycled",
    observation: "The medical-bay inner door completed a full pressure cycle with no one at the panel. The log records it as a scheduled test that is not on any schedule."
  },
  {
    id: "manifestation-duplicates",
    title: "Two of everyone",
    observation: "For eleven seconds the sensor net tracked two of every crew member, walking mirror routes. Both traces end at the same coordinates."
  }
];

/**
 * Fires at most one manifestation per act-3 sweep window, varying by seed so
 * different rooms see different manifestations in a different order.
 */
export function maybeRunManifestation(match: MatchState, nowMs: number): void {
  if (match.scenario.act < 3) return;
  const dueSweep = SCENARIO_ACT_SWEEPS.act3 + match.scenario.manifestationIds.length;
  if (match.crisis.sweepCount < dueSweep) return;
  const remaining = MANIFESTATIONS.filter((manifestation) => !match.scenario.manifestationIds.includes(manifestation.id));
  if (remaining.length === 0) return;
  const chosen = remaining[match.seed % remaining.length];
  if (!chosen) return;
  match.scenario.manifestationIds.push(chosen.id);
  addEvidence(match, {
    id: chosen.id,
    title: chosen.title,
    observation: chosen.observation,
    reliability: "corrupted",
    reporterId: firstConnectedPlayerId(match),
    discoveredAtMs: nowMs,
    origin: "echo-manifestation",
    visibility: "shared",
    recipientPlayerId: null,
    sharedByPlayerId: null,
    sharedAtMs: null,
    annotations: [],
    linkedEvidenceIds: []
  });
  addCrisisLog(match, {
    kind: "interference",
    roomId: null,
    systemId: null,
    description: `Echo manifestation: ${chosen.title}. The record is on the shared board, tagged corrupted.`
  }, nowMs);
}

function firstConnectedPlayerId(match: MatchState): string {
  const player = Object.values(match.players).find((candidate) => candidate.connection === "connected");
  return player?.id ?? Object.keys(match.players)[0] ?? "station";
}

/**
 * The final decision is a deliberate Act IV act: Command can *propose* it at
 * the console, but a domain seat must co-authorize before anything executes.
 */
export function isEchoDecisionAvailable(match: MatchState): boolean {
  return match.phase === "active" && match.scenario.act >= 4;
}

/** The seat whose domain makes it the natural co-authorizer for each choice. */
export const ECHO_DECISION_DOMAINS: Record<EchoDecisionChoice, Role> = {
  isolate: "engineering",
  sever: "engineering",
  amplify: "communications",
  follow: "navigation"
};

const DOMAIN_ACTION: Record<EchoDecisionChoice, string> = {
  isolate: "hold the isolation lattice closed through the sealing pulse",
  sever: "physically cut and cap the antenna feeds",
  amplify: "key the full-power broadcast through the signal chain",
  follow: "fly the burn on the helm"
};

/**
 * Command proposes a final Echo decision from the command console. This is
 * authorization-in-principle only: nothing executes until the domain seat
 * co-authorizes from its own department.
 */
export function proposeEchoDecision(match: MatchState, playerId: string, choice: EchoDecisionChoice, nowMs: number): void {
  const player = requireCrew(match, playerId);
  if (player.role !== "command") throw new Error("Only Command can propose the final Echo decision.");
  if (player.position.roomId !== "command") throw new Error("Propose the final Echo decision from the command console.");
  if (match.scenario.echoDecision) throw new Error("The Echo decision has already been made. It cannot be unmade.");
  if (!isEchoDecisionAvailable(match)) throw new Error("The final Echo decision is not available yet. Survive to Act IV.");
  if (match.scenario.pendingEchoDecision && match.scenario.pendingEchoDecision.status === "pending") {
    throw new Error("A final Echo decision is already proposed and awaiting co-authorization.");
  }
  match.scenario.pendingEchoDecision = {
    choice,
    status: "pending",
    proposedByPlayerId: playerId,
    proposedAtMs: nowMs,
    requiredRole: ECHO_DECISION_DOMAINS[choice],
    expiresAtMs: nowMs + ECHO_DECISION_EXPIRY_MS
  };
  addCrisisLog(match, {
    kind: "log",
    roomId: "command",
    systemId: null,
    description: `ECHO DECISION PROPOSED — ${DECISION_LABELS[choice]} Awaiting the ${ECHO_DECISION_DOMAINS[choice]} seat's co-authorization before anything executes.`
  }, nowMs);
  match.revision += 1;
}

/**
 * The domain seat co-authorizes from its own department. Only then does the
 * crew's decision become real — Command executes it at the console.
 */
export function authorizeEchoDecision(match: MatchState, playerId: string, nowMs: number): void {
  const player = requireCrew(match, playerId);
  const pending = match.scenario.pendingEchoDecision;
  if (!pending || pending.status !== "pending") throw new Error("No Echo decision is awaiting co-authorization.");
  if (player.role !== pending.requiredRole) throw new Error(`The ${pending.requiredRole} seat must co-authorize this decision.`);
  if (player.position.roomId !== domainRoom(pending.requiredRole)) {
    throw new Error(`Co-authorize from ${domainRoom(pending.requiredRole)} — the ${pending.requiredRole} seat must act from its own department.`);
  }
  if (nowMs >= pending.expiresAtMs) {
    pending.status = "expired";
    addCrisisLog(match, {
      kind: "log",
      roomId: null,
      systemId: null,
      description: "The proposed Echo decision expired without co-authorization. Nothing was executed. Command may propose again."
    }, nowMs);
    match.revision += 1;
    return;
  }
  pending.status = "authorized";
  pending.authorizedByPlayerId = playerId;
  addCrisisLog(match, {
    kind: "log",
    roomId: null,
    systemId: null,
    description: `The ${pending.requiredRole} seat has co-authorized the ${pending.choice.toUpperCase()} decision. Command can now execute it at the console.`
  }, nowMs);
  match.revision += 1;
}

function domainRoom(role: Role): string {
  switch (role) {
    case "engineering": return "engineering";
    case "communications": return "communications";
    case "navigation": return "navigation";
    case "medical": return "medical";
    default: return "command";
  }
}

/**
 * Explicit execution by Command from the console — the only step that ends
 * the match, and only after a domain seat has co-authorized the choice.
 */
export function makeEchoDecision(match: MatchState, playerId: string, choice: EchoDecisionChoice, nowMs: number): void {
  const player = requireCrew(match, playerId);
  if (player.role !== "command") throw new Error("Only Command can execute the final Echo decision.");
  if (player.position.roomId !== "command") throw new Error("Execute the final Echo decision from the command console.");
  if (match.scenario.echoDecision) throw new Error("The Echo decision has already been made. It cannot be unmade.");
  const pending = match.scenario.pendingEchoDecision;
  if (!pending || pending.status !== "authorized") {
    throw new Error("That decision needs the domain seat's co-authorization before it can be executed.");
  }
  if (pending.choice !== choice) throw new Error("Execute the decision that was proposed and co-authorized.");
  if (nowMs >= pending.expiresAtMs) {
    pending.status = "expired";
    addCrisisLog(match, {
      kind: "log",
      roomId: "command",
      systemId: null,
      description: "The co-authorization expired before Command executed. Nothing was executed. Command may propose again."
    }, nowMs);
    throw new Error("The co-authorization expired before Command executed. Propose the decision again.");
  }
  match.scenario.echoDecision = { choice, atMs: nowMs };
  addCrisisLog(match, {
    kind: "log",
    roomId: "command",
    systemId: null,
    description: `FINAL ECHO DECISION — ${DECISION_LABELS[choice]}`
  }, nowMs);
  switch (choice) {
    case "isolate": resolveIsolate(match, nowMs); break;
    case "sever": resolveSever(match, nowMs); break;
    case "amplify": resolveAmplify(match, nowMs); break;
    case "follow": resolveFollow(match, nowMs); break;
  }
}

const DECISION_LABELS: Record<EchoDecisionChoice, string> = {
  isolate: "ISOLATE — seal the Echo band inside the isolation lattice and wait it out.",
  sever: "SEVER — cut the antenna feeds; the station stops listening, and stops calling.",
  amplify: "AMPLIFY — answer the impossible call at full power, voice for voice.",
  follow: "FOLLOW — plot the distress route and burn the reserves to fly it."
};

/**
 * ISOLATE. Grounding: the station's own grid-isolation operation is proven
 * technology; sealing the band is an extension of it. Effect scales with how
 * much resonance pressure the crew has already bled off.
 */
function resolveIsolate(match: MatchState, nowMs: number): void {
  const relief = Math.round(match.resonance.pressure / 2);
  applyResonanceRelief(match, relief, null, nowMs);
  setSystemStability(match, "power", match.systems.power.stability + 10, nowMs);
  const lines: string[] = [
    "The isolation lattice closed on the Echo band and held. Inside the lattice, the pressure the crew had already bled off made the seal survivable.",
    `Resonance pressure fell by ${relief} points; the power grid steadied.`
  ];
  if (match.systems.power.condition === "stable") {
    lines.push("With the grid stable and the band sealed, the impossible call faded from the array. The station kept its silence — and its crew.");
  } else {
    lines.push("The band is sealed, but the station is still wounded. The silence holds only as long as the grid does.");
  }
  endMatch(match, "The crew sealed the Echo band away. The signal remains, unanswered, on the other side of the lattice.");
  match.scenario.debrief = makeDebrief(match, "isolate", debriefChoiceLine("isolate"), lines);
}

/**
 * SEVER. Grounding: the antenna feeds are real infrastructure; cutting them
 * is immediate and total, but it is also the choice that discards the most
 * information. The Signal goes out mid-word.
 */
function resolveSever(match: MatchState, nowMs: number): void {
  applyResonanceRelief(match, 25, null, nowMs);
  const lines: string[] = [
    "The antenna feeds parted under the cutter charges. Every trace of the Echo band dropped to noise floor at once.",
    "Resonance pressure fell sharply. Whatever the call still wanted to say, it will never say it to this crew.",
    match.scenario.manifestationIds.length >= 2
      ? "The manifestations stopped mid-pattern. The crew will never know what the eleventh second of the duplicates meant."
      : "Without the array, the crew's confirmed leads are all that remains of the mystery."
  ];
  endMatch(match, "The crew severed the antenna feeds. The Last Signal ended mid-word, and the Echo went quiet forever.");
  match.scenario.debrief = makeDebrief(match, "sever", debriefChoiceLine("sever"), lines);
}

/**
 * AMPLIFY. Grounding: amplification rides the same band the interference
 * pulses ride; the cost is drawn from the proven reserve-power economy.
 * The outcome depends on whether the crew contained the K-7 relay.
 */
function resolveAmplify(match: MatchState, nowMs: number): void {
  if (match.sharedResources.reservePower >= 2) {
    match.sharedResources.reservePower -= 2;
    applyResonancePressure(match, 20, null, nowMs);
    const contained = match.evidence["relay-containment-record"] !== undefined;
    const lines: string[] = [
      "The crew answered at full power. For nine seconds the array carried every voice aboard, and the Echo band carried them somewhere else.",
      contained
        ? "K-7 held. The containment pulse the crew engineered kept the feedback from arcing into the life-support buses, and the answered call resolved into a coherent handshake."
        : "Without the K-7 containment, the feedback arced into the life-support buses. The crew sang to the dark and paid for it in stability.",
      contained
        ? "The handshake completes with a station that identifies itself with this station's name and a date seventeen hours in the future."
        : "Life support takes the arc hard. The crew answers again anyway — the band is open now, and it is not going quiet."
    ];
    if (match.systems.lifeSupport.condition === "failure" || match.systems.lifeSupport.condition === "critical") {
      lines.push("The answer is still transmitting. Life support is not going to hold through another verse.");
    }
    endMatch(match, "The crew answered the impossible call at full power. Somewhere on the band, the station hears itself reply.");
    match.scenario.debrief = makeDebrief(match, "amplify", debriefChoiceLine("amplify"), lines);
    return;
  }
  // No reserve left: the amplify fails as a physical action, visibly, and the
  // crew must choose again. This is not a hidden punishment; it is the same
  // refusal any empty reserve gives.
  addCrisisLog(match, {
    kind: "log",
    roomId: "command",
    systemId: null,
    description: "AMPLIFY failed: the reserve power cells are empty. The array cannot carry a full-power answer. Choose again."
  }, nowMs);
  match.scenario.echoDecision = null;
  // The co-authorization was consumed by the failed attempt: the domain seat
  // approved an action that turned out to be physically impossible, so the
  // crew must re-propose and re-authorize whatever they choose instead.
  match.scenario.pendingEchoDecision = null;
}

/** FOLLOW. Grounding: the distress route is the Navigation role's own brief. */
function resolveFollow(match: MatchState, nowMs: number): void {
  const hasChart = match.evidence["signal-origin-readout"] !== undefined || match.scenario.manifestationIds.length >= 2;
  if (match.sharedResources.reservePower >= 3) {
    match.sharedResources.reservePower -= 3;
    setSystemStability(match, "navigation", Math.min(100, match.systems.navigation.stability + 8), nowMs);
    addStrain(match, firstConnectedPlayer(match), 20, "the follow burn");
    const lines: string[] = [
      "The crew burned the reserves and turned the station onto the impossible route. The distress call grew stronger with every degree of the turn.",
      hasChart
        ? "With the origin triangulation or a manifestation route to check against, the crew flew the corridor awake: the route existed, and it had been waiting to be plotted."
        : "Flying blind on raw bearings, the crew found the corridor the hard way: the route exists, but the chart that explains it is still missing."
    ];
    endMatch(match, "The crew followed the impossible route out of the dark. The distress call walked them in by hand.");
    match.scenario.debrief = makeDebrief(match, "follow", debriefChoiceLine("follow"), lines);
    return;
  }
  addCrisisLog(match, {
    kind: "log",
    roomId: "command",
    systemId: null,
    description: "FOLLOW failed: the follow burn needs 3 reserve power. The station cannot make the turn. Choose again."
  }, nowMs);
  match.scenario.echoDecision = null;
  // Same as AMPLIFY: a failed execution consumes the co-authorization.
  match.scenario.pendingEchoDecision = null;
}

function firstConnectedPlayer(match: MatchState) {
  const player = Object.values(match.players).find((candidate) => candidate.connection === "connected" && !candidate.incapacitated);
  if (!player) throw new Error("No crew member is able to act.");
  return player;
}

function requireCrew(match: MatchState, playerId: string) {
  const player = match.players[playerId];
  if (!player) throw new Error("Unknown player.");
  if (player.incapacitated) throw new Error("Incapacitated players cannot perform this action.");
  if (player.connection !== "connected") throw new Error("Disconnected players cannot perform this action.");
  return player;
}

/**
 * Maps a choice onto the station's physical state for the debrief "what
 * actually happened" block. Kept deterministic and honest: it reads only
 * state the crew could see.
 */
export function outcomeSummary(match: MatchState): string {
  const decision = match.scenario.echoDecision;
  if (!decision) return "No final Echo decision was made.";
  const leads = match.scenario.confirmedLeads.length;
  const leadLine = leads === 0
    ? "The crew decided with no confirmed leads — pure instinct, logged as such."
    : `The crew decided with ${leads} confirmed lead${leads === 1 ? "" : "s"} on the board.`;
  return `${leadLine} Resonance ended at ${match.resonance.pressure} on the ${match.resonance.condition} band.`;
}
