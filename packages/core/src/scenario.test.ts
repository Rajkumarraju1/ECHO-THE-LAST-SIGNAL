import { describe, expect, it } from "vitest";
import {
  ACT_TITLES,
  addPlayer,
  advanceConnectionDeadlines,
  applyResonanceRelief,
  assignRole,
  authorizeEchoDecision,
  createMatch,
  investigate,
  launchMatch,
  makeEchoDecision,
  movePlayer,
  performDeepListen,
  performVentTheBand,
  projectClientView,
  proposeEchoDecision,
  runProcedure,
  setSystemStability,
  shareEvidence,
  type MatchState
} from "./index.js";
import { DEEP_LISTEN_RESONANCE_PRESSURE, ECHO_VENT_DURATION_MS, ECHO_VENT_RESONANCE_RELIEF, SCENARIO_ACT_SWEEPS } from "./balance.js";

/** Two-crew (Command + Engineering) scenario match, launched and placed. */
function scenarioCrew(roomId: string = "command") {
  const match = createMatch(`ECHO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, 9);
  addPlayer(match, "cmd", "Rhea");
  addPlayer(match, "eng", "Vale");
  assignRole(match, "cmd", "command");
  assignRole(match, "eng", "engineering");
  launchMatch(match);
  movePlayer(match, "cmd", "command", 40, 40);
  movePlayer(match, "eng", roomId, 40, 40);
  return { match, command: "cmd", engineer: "eng" };
}

/** Command + Engineering + Communications + Navigation crew for the quorum flow. */
function quorumCrew() {
  const match = createMatch(`ECHO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, 9);
  addPlayer(match, "cmd", "Rhea");
  addPlayer(match, "eng", "Vale");
  addPlayer(match, "com", "Lyris");
  addPlayer(match, "nav", "Pilot");
  assignRole(match, "cmd", "command");
  assignRole(match, "eng", "engineering");
  assignRole(match, "com", "communications");
  assignRole(match, "nav", "navigation");
  launchMatch(match);
  movePlayer(match, "cmd", "command", 40, 40);
  movePlayer(match, "eng", "engineering", 40, 40);
  movePlayer(match, "com", "communications", 40, 40);
  movePlayer(match, "nav", "navigation", 40, 40);
  return { match, command: "cmd", engineer: "eng", comms: "com", navigator: "nav" };
}

function labScenarioCrew() {
  return scenarioCrew("engineering");
}

/**
 * Drives `sweeps` crisis sweeps with realistic Engineering maintenance so the
 * seeded critical power stays above the failure line — the crew must keep the
 * station alive to reach Act IV, exactly as in play.
 */
function driveSweeps(match: MatchState, engineer: string, t0: number, sweeps: number): number {
  let now = t0;
  advanceConnectionDeadlines(match, now); // stamp the sweep clock (no sweep runs yet)
  for (let index = 0; index < sweeps; index += 1) {
    now += 61_000;
    // The server path: connection deadlines advance the crisis clock, acts, and manifestations.
    advanceConnectionDeadlines(match, now);
    if (match.systems.power.condition !== "stable") {
      if (match.sharedResources.reservePower > 0) {
        runProcedure(match, engineer, "reroute-power", now + 1);
      } else {
        setSystemStability(match, "power", Math.min(100, match.systems.power.stability + 20), now + 1);
      }
    }
    if (match.systems.hull.condition === "failure") {
      setSystemStability(match, "hull", 60, now + 1);
    }
    if (match.systems.navigation.condition === "failure") {
      setSystemStability(match, "navigation", 60, now + 1);
    }
    if (match.phase === "ended") break;
  }
  return now;
}

describe("phase 5: the impossible distress call", () => {
  it("delivers the distress call at launch and starts Act I", () => {
    const { match } = scenarioCrew();
    expect(match.scenario.distressCallAtMs).toBeGreaterThan(0);
    expect(match.scenario.act).toBe(1);
    expect(match.scenario.actStartedAtMs[1]).toBe(match.scenario.distressCallAtMs);
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("IMPOSSIBLE DISTRESS CALL"))).toBe(true);
  });

  it("gates Echo decision and private lead evidence behind role, room, and availability", () => {
    const { match, command, engineer } = scenarioCrew();
    // Decision unavailable before Act IV: proposing is refused, and execution
    // is refused for want of any co-authorization.
    expect(() => makeEchoDecision(match, command, "isolate", 1_000)).toThrow("co-authorization");
    expect(() => proposeEchoDecision(match, command, "isolate", 1_000)).toThrow("not available yet");
    // Investigation requires the right specialist in the right room.
    expect(() => investigate(match, engineer, "signal-origin", 1_100)).toThrow("navigation authorization");
    expect(match.scenario.confirmedLeads).toHaveLength(0);
  });

  it("advances through all four acts as sweeps accumulate, with visible telegraphs", () => {
    const { match, engineer } = labScenarioCrew();
    const end = driveSweeps(match, engineer, 5_000_000, SCENARIO_ACT_SWEEPS.act4);
    expect(match.phase).toBe("active");
    expect(match.scenario.act).toBe(4);
    expect(match.scenario.actStartedAtMs[2]).not.toBeNull();
    expect(match.scenario.actStartedAtMs[3]).not.toBeNull();
    expect(match.scenario.actStartedAtMs[4]).toBe(end);
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("Act II"))).toBe(true);
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("Act III"))).toBe(true);
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("Act IV"))).toBe(true);
    // A manifestation has fired by the Act III window.
    expect(match.scenario.manifestationIds.length).toBeGreaterThanOrEqual(1);
    const manifestation = match.scenario.manifestationIds[0];
    expect(manifestation).toBeDefined();
    expect(match.evidence[manifestation as string]?.origin).toBe("echo-manifestation");
  });

  it("requires propose → co-authorize → execute, with the domain seat co-authorizing from its own department", () => {
    const { match, command, engineer, comms } = quorumCrew();
    const t0 = 5_500_000;
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act4);
    expect(match.scenario.act).toBe(4);

    // Execution without a co-authorization is refused.
    expect(() => makeEchoDecision(match, command, "isolate", t0 + 500_000)).toThrow("co-authorization");
    // A non-Command player cannot propose.
    expect(() => proposeEchoDecision(match, engineer, "isolate", t0 + 500_000)).toThrow("Only Command");
    // Command must propose from the console.
    movePlayer(match, command, "engineering", 40, 40);
    expect(() => proposeEchoDecision(match, command, "isolate", t0 + 500_000)).toThrow("command console");
    movePlayer(match, command, "command", 50, 50);

    // The right proposal from the right place is only authorization-in-principle.
    proposeEchoDecision(match, command, "isolate", t0 + 500_000);
    expect(match.scenario.pendingEchoDecision?.status).toBe("pending");
    expect(match.scenario.pendingEchoDecision?.requiredRole).toBe("engineering");
    expect(match.phase).toBe("active");
    // Command cannot execute its own proposal.
    expect(() => makeEchoDecision(match, command, "isolate", t0 + 500_001)).toThrow("co-authorization");

    // The domain seat co-authorizes from its own department.
    expect(() => authorizeEchoDecision(match, comms, t0 + 500_100)).toThrow("engineering seat");
    movePlayer(match, engineer, "command", 40, 40); // Engineering must act from its own department:
    expect(() => authorizeEchoDecision(match, engineer, t0 + 500_100)).toThrow("its own department");
    movePlayer(match, engineer, "engineering", 50, 50);
    authorizeEchoDecision(match, engineer, t0 + 500_100);
    expect(match.scenario.pendingEchoDecision?.status).toBe("authorized");
    expect(match.scenario.pendingEchoDecision?.authorizedByPlayerId).toBe("eng");
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("co-authorized"))).toBe(true);

    // Explicit execution by Command ends the match exactly once.
    movePlayer(match, command, "command", 50, 50);
    makeEchoDecision(match, command, "isolate", t0 + 500_200);
    expect(match.phase).toBe("ended");
    expect(match.scenario.echoDecision?.choice).toBe("isolate");
    expect(match.scenario.debrief).not.toBeNull();
  });

  it("expires a co-authorization that is never exercised — nothing runs automatically", () => {
    const { match, command, engineer, comms } = quorumCrew();
    const t0 = 6_000_000;
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act4);
    proposeEchoDecision(match, command, "amplify", t0 + 500_000);
    movePlayer(match, comms, "communications", 50, 50);
    authorizeEchoDecision(match, comms, t0 + 500_100);
    expect(match.scenario.pendingEchoDecision?.status).toBe("authorized");
    // Command hesitates past the expiry: execution is refused, the proposal lapses visibly.
    expect(() => makeEchoDecision(match, command, "amplify", t0 + 500_100 + 45_001)).toThrow("expired");
    expect(match.scenario.pendingEchoDecision?.status).toBe("expired");
    expect(match.phase).toBe("active");
    expect(match.scenario.echoDecision).toBeNull();
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("expired before Command executed"))).toBe(true);
    // Command may propose again after a lapse.
    proposeEchoDecision(match, command, "isolate", t0 + 546_000);
    expect(match.scenario.pendingEchoDecision?.choice).toBe("isolate");
  });

  it("resolves all four Echo decisions into grounded, distinct debriefs", () => {
    const choices = ["isolate", "sever", "amplify", "follow"] as const;
    for (const choice of choices) {
      const { match, command, engineer, comms, navigator } = quorumCrew();
      driveSweeps(match, engineer, 7_000_000, SCENARIO_ACT_SWEEPS.act4);
      expect(match.scenario.act).toBe(4);
      // Give the amplify/follow resource outcomes a deterministic footing.
      match.sharedResources.reservePower = choice === "follow" ? 3 : 2;
      const t0 = 7_000_000 + 500_000;
      proposeEchoDecision(match, command, choice, t0);
      // The domain seat for this choice co-authorizes from its own department.
      if (choice === "amplify") authorizeEchoDecision(match, comms, t0 + 100);
      else if (choice === "follow") authorizeEchoDecision(match, navigator, t0 + 100);
      else authorizeEchoDecision(match, engineer, t0 + 100);
      makeEchoDecision(match, command, choice, t0 + 200);
      expect(match.phase).toBe("ended");
      expect(match.scenario.echoDecision?.choice).toBe(choice);
      const debrief = match.scenario.debrief;
      expect(debrief).not.toBeNull();
      expect(debrief?.title).toContain("Debrief");
      expect(debrief?.outcomeLines.length ?? 0).toBeGreaterThan(1);
      expect(debrief?.confirmedLeads).toBeDefined();
      expect(debrief?.missedLeads.length).toBeGreaterThan(0); // unconfirmed leads are named as gaps
      expect(debrief?.stationLine).toContain("Station condition:");
      expect(debrief?.crewLine).toContain("finished the shift standing");
      expect(ACT_TITLES[match.scenario.act]).toContain("Act IV");
    }
  });

  it("grounds decision consequences in actual play: containment, leads, resonance, and reserves", () => {
    const { match, command, engineer, comms } = quorumCrew();
    const t0 = 8_000_000;
    // The crew actually investigates and shares; leads are logged.
    investigate(match, engineer, "power-relay", t0 + 500);
    shareEvidence(match, "power-relay-readout", engineer);
    expect(match.scenario.confirmedLeads).toContain("power-relay-readout");
    // Command tries before Act IV and is refused; nothing is committed.
    expect(() => proposeEchoDecision(match, command, "amplify", t0 + 600)).toThrow("not available yet");
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act4);
    // AMPLIFY without reserve is refused visibly, consumes the co-authorization, and is not committed.
    match.sharedResources.reservePower = 0;
    proposeEchoDecision(match, command, "amplify", t0 + 500_000);
    movePlayer(match, comms, "communications", 50, 50);
    authorizeEchoDecision(match, comms, t0 + 500_050);
    makeEchoDecision(match, command, "amplify", t0 + 500_100);
    expect(match.scenario.echoDecision).toBeNull();
    expect(match.scenario.pendingEchoDecision).toBeNull();
    expect(match.phase).toBe("active");
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("AMPLIFY failed"))).toBe(true);
    // ISOLATE after real relief work: the seal scales with pressure already bled off.
    match.sharedResources.reservePower = 2;
    applyResonanceRelief(match, 30, null, t0 + 500_100);
    const pressureBefore = match.resonance.pressure;
    proposeEchoDecision(match, command, "isolate", t0 + 500_200);
    authorizeEchoDecision(match, engineer, t0 + 500_250);
    makeEchoDecision(match, command, "isolate", t0 + 500_300);
    expect(match.resonance.pressure).toBe(pressureBefore - Math.round(pressureBefore / 2));
    expect(match.scenario.debrief?.choiceLine).toContain("isolation lattice");
    // The debrief honestly reflects which leads were confirmed vs. missed.
    expect(match.scenario.debrief?.confirmedLeads).toContain("The K-7 load trace");
    expect(match.scenario.debrief?.missedLeads).toContain("The origin triangulation");
  });

  it("makes the deep listen a real trade: a confirmed lead for genuine resonance pressure", () => {
    const { match, engineer, comms, command } = quorumCrew();
    const t0 = 8_500_000;
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act2);
    expect(match.scenario.act).toBe(2);
    const pressureBefore = match.resonance.pressure;
    // Seat, room, and availability gates.
    expect(() => performDeepListen(match, command, t0 + 500_000)).toThrow("Only Communications");
    movePlayer(match, comms, "command", 40, 40); // the listen happens at the array, in Communications:
    expect(() => performDeepListen(match, comms, t0 + 500_000)).toThrow("Communications room");
    movePlayer(match, comms, "communications", 50, 50);
    performDeepListen(match, comms, t0 + 500_100);
    expect(match.resonance.pressure).toBe(Math.min(100, pressureBefore + DEEP_LISTEN_RESONANCE_PRESSURE));
    expect(match.evidence["echo-pulse-log"]?.visibility).toBe("private");
    expect(match.scenario.confirmedLeads).toContain("echo-pulse-log");
    // The deliberate listen cannot be repeated for free pressure.
    expect(() => performDeepListen(match, comms, t0 + 500_200)).toThrow("already been documented");
  });

  it("vents the band for real relief at a real cost, and deafens the array while it runs", () => {
    const { match, engineer, comms } = quorumCrew();
    const t0 = 8_600_000;
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act2);
    movePlayer(match, comms, "communications", 50, 50);
    performDeepListen(match, comms, t0 + 500_000);
    const listenedPressure = match.resonance.pressure;
    const materialsBefore = match.sharedResources.repairMaterials;
    performVentTheBand(match, engineer, t0 + 500_100);
    expect(match.sharedResources.repairMaterials).toBe(materialsBefore - 1);
    expect(match.crisis.isolation.reason).toBe("echo-vent");
    expect(match.crisis.isolation.activeUntilMs).toBe(t0 + 500_100 + ECHO_VENT_DURATION_MS);
    expect(match.resonance.pressure).toBe(Math.max(0, listenedPressure - ECHO_VENT_RESONANCE_RELIEF));
    // While the vent runs, the array is deaf: the listen is refused.
    expect(() => performDeepListen(match, comms, t0 + 500_200)).toThrow("vented to space");
    // A second vent is refused while one is already running.
    expect(() => performVentTheBand(match, engineer, t0 + 500_300)).toThrow("already vented");
    // After the vent cycle the array hears again: the refusal below is the
    // "already documented" gate, which sits *after* the vent gate.
    advanceConnectionDeadlines(match, t0 + 500_100 + ECHO_VENT_DURATION_MS + 61_000);
    expect(match.crisis.isolation.reason).toBeNull();
    expect(() => performDeepListen(match, comms, t0 + 600_000)).toThrow("already been documented");
  });

  it("exposes the act ladder, pending decision, and debrief in every client view", () => {
    const { match, command, engineer, comms } = quorumCrew();
    const t0 = 9_000_000;
    const early = projectClientView(match, engineer).scenario;
    expect(early.echoDecisionAvailable).toBe(false);
    expect(early.act).toBe(1);
    expect(early.pendingEchoDecision).toBeNull();
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act4);
    const lateEngineer = projectClientView(match, engineer).scenario;
    const lateCommand = projectClientView(match, command).scenario;
    expect(lateEngineer.echoDecisionAvailable).toBe(true);
    expect(lateCommand.echoDecisionAvailable).toBe(true);
    proposeEchoDecision(match, command, "sever", t0 + 500_000);
    const pendingEngineer = projectClientView(match, engineer).scenario;
    expect(pendingEngineer.pendingEchoDecision?.status).toBe("pending");
    expect(pendingEngineer.pendingEchoDecision?.requiredRole).toBe("engineering");
    expect(pendingEngineer.pendingEchoDecision?.choice).toBe("sever");
    authorizeEchoDecision(match, engineer, t0 + 500_100);
    const authorizedNav = projectClientView(match, comms).scenario;
    expect(authorizedNav.pendingEchoDecision?.status).toBe("authorized");
    makeEchoDecision(match, command, "sever", t0 + 500_200);
    const endedView = projectClientView(match, engineer).scenario;
    expect(endedView.debrief?.title).toContain("Debrief");
    expect(endedView.echoDecision?.choice).toBe("sever");
    expect(match.endReason).toContain("severed the antenna feeds");
  });

  it("keeps decision authority with Command alone, and the commitment is irreversible", () => {
    const { match, command, engineer, comms } = quorumCrew();
    const t0 = 10_000_000;
    driveSweeps(match, engineer, t0, SCENARIO_ACT_SWEEPS.act4);
    expect(() => makeEchoDecision(match, engineer, "sever", t0 + 400_000)).toThrow("Only Command");
    proposeEchoDecision(match, command, "sever", t0 + 400_000);
    authorizeEchoDecision(match, engineer, t0 + 400_100);
    expect(() => makeEchoDecision(match, command, "sever", t0 + 400_200)).not.toThrow();
    expect(match.phase).toBe("ended");
    expect(match.scenario.echoDecision?.choice).toBe("sever");
    // Even after the end, nothing can unmake it.
    expect(() => proposeEchoDecision(match, command, "isolate", t0 + 400_300)).toThrow("already been made");
  });
});
