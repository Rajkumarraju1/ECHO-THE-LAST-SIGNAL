import { describe, expect, it } from "vitest";
import {
  addPlayer,
  advanceCrisisClock,
  applyResonancePressure,
  assignRole,
  confirmCoordinatedOperation,
  createMatch,
  injectCrisisEffect,
  launchMatch,
  LINKED_FAILURE_DRAIN,
  movePlayer,
  OPERATION_EXPIRY_MS,
  performEmergencyFallback,
  projectClientView,
  proposeCoordinatedOperation,
  proposeEmergencyOverride,
  rescuePlayer,
  RECOVERY_WINDOW_MS,
  RESONANCE_CRITICAL_POWER_DRAIN,
  runProcedure,
  setSystemStability,
  STRAIN_LIMIT,
  type MatchState,
  type SystemId
} from "./index.js";

/** Engineering + Command + Navigation crew (optionally Medical) in a laboratory room. */
function labCrew(withMedic: boolean = true, withNavigator: boolean = true): { match: MatchState; engineer: string; command: string; medic: string; navigator: string } {
  const match = createMatch(`LAB-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, 7);
  addPlayer(match, "eng", "Vale");
  addPlayer(match, "cmd", "Rhea");
  assignRole(match, "eng", "engineering");
  assignRole(match, "cmd", "command");
  if (withMedic) {
    addPlayer(match, "med", "Sage");
    assignRole(match, "med", "medical");
  }
  if (withNavigator) {
    addPlayer(match, "nav", "Pilot");
    assignRole(match, "nav", "navigation");
  }
  launchMatch(match);
  movePlayer(match, "eng", "engineering", 40, 40);
  movePlayer(match, "cmd", "command", 40, 40);
  if (withMedic) movePlayer(match, "med", "medical", 40, 40);
  if (withNavigator) movePlayer(match, "nav", "navigation", 40, 40);
  return { match, engineer: "eng", command: "cmd", medic: "med", navigator: "nav" };
}

function setTier(match: MatchState, id: SystemId, stability: number): void {
  setSystemStability(match, id, stability, Date.now());
}

describe("station crisis loop", () => {
  it("propagates deterioration along linked systems with a synchronized crew drain", () => {
    const { match, engineer, command } = labCrew();
    const t0 = 1_000_000;
    advanceCrisisClock(match, t0 - 30_000); // stamps the sweep clock only
    setTier(match, "lifeSupport", 60);
    // Power fails with a recovery window stamped at t0 (explicit server time).
    injectCrisisEffect(match, "power-drain", t0);
    expect(match.systems.power.condition).toBe("failure");
    expect(match.systems.power.recoveryWindow.openedAtMs).toBe(t0);

    // Sweep while the window is still open: the dependency drags life support down.
    advanceCrisisClock(match, t0 + 30_000);
    expect(match.systems.power.condition).toBe("failure");
    expect(match.systems.lifeSupport.stability).toBe(60 - LINKED_FAILURE_DRAIN);
    // Synchronized crew drain: the whole crew strains at the same moment.
    expect(match.players.eng?.strain).toBeGreaterThan(0);
    expect(match.players.cmd?.strain).toBeGreaterThan(0);
    expect(match.players.eng?.strain).toBe(match.players.cmd?.strain);
  });

  it("walks Stable → Critical → Failure → Terminal and telegraphs each tier", () => {
    const { match } = labCrew();
    setTier(match, "hull", 55);
    expect(match.systems.hull.condition).toBe("stable");
    setTier(match, "hull", 50);
    expect(match.systems.hull.condition).toBe("critical");
    setTier(match, "hull", 20);
    expect(match.systems.hull.condition).toBe("failure");
    expect(match.systems.hull.recoveryWindow.expiresAtMs).toBeGreaterThan(0);
    setTier(match, "hull", 0);
    expect(match.systems.hull.condition).toBe("terminal");
    expect(match.phase).toBe("ended");
    expect(match.endReason).toContain("Hull integrity");
  });

  it("expires a lapsed recovery window into terminal failure", () => {
    const { match } = labCrew();
    const t0 = 2_000_000;
    advanceCrisisClock(match, t0);
    injectCrisisEffect(match, "hull-drain", t0 + 1_000);
    injectCrisisEffect(match, "hull-drain", t0 + 1_001); // 100 - 80 = 20 → failure
    expect(match.systems.hull.condition).toBe("failure");
    expect(match.systems.hull.recoveryWindow.expiresAtMs).toBe(t0 + 1_001 + RECOVERY_WINDOW_MS);
    // No recovery before the window lapses → terminal.
    advanceCrisisClock(match, t0 + 1_001 + RECOVERY_WINDOW_MS + 60_000);
    expect(match.systems.hull.condition).toBe("terminal");
    expect(match.phase).toBe("ended");
  });

  it("recovers failing systems through role-gated procedures that spend reserves", () => {
    const { match, engineer, medic } = labCrew();
    const t0 = 3_000_000;
    advanceCrisisClock(match, t0);
    setTier(match, "hull", 15);
    const materialsBefore = match.sharedResources.repairMaterials;
    runProcedure(match, engineer, "patch-hull", t0 + 1_000);
    expect(match.sharedResources.repairMaterials).toBe(materialsBefore - 1);
    expect(match.systems.hull.stability).toBe(30);
    expect(match.systems.hull.condition).toBe("critical"); // partial recovery, out of failure
    expect(match.systems.hull.recoveryWindow.expiresAtMs).toBeNull();

    setTier(match, "lifeSupport", 18);
    const reserveBefore = match.sharedResources.lifeSupportReserve;
    runProcedure(match, medic, "recycle-atmosphere", t0 + 2_000);
    expect(match.sharedResources.lifeSupportReserve).toBe(reserveBefore - 1);
    expect(match.systems.lifeSupport.condition).toBe("critical");
    // Procedures are role- and room-gated.
    expect(() => runProcedure(match, commandPlayer(match), "patch-hull", t0 + 3_000)).toThrow("Only the engineering specialist");
  });

  it("refuses procedures when the shared reserve is empty — resources cannot go negative", () => {
    const { match, engineer } = labCrew();
    const t0 = 4_000_000;
    advanceCrisisClock(match, t0);
    match.sharedResources.repairMaterials = 0;
    setTier(match, "hull", 15);
    expect(() => runProcedure(match, engineer, "patch-hull", t0 + 1_000)).toThrow("Not enough repair materials");
    expect(match.systems.hull.condition).toBe("failure");
    expect(match.sharedResources.repairMaterials).toBe(0);
  });

  it("expires quorum authorizations visibly and never executes them silently", () => {
    const { match, engineer } = labCrew();
    const t0 = 5_000_000;
    advanceCrisisClock(match, t0);
    proposeCoordinatedOperation(match, engineer, "grid-isolation", t0);
    const operation = match.crisis.pendingOperations["grid-isolation"];
    expect(operation?.status).toBe("pending");
    expect(operation?.expiresAtMs).toBe(t0 + OPERATION_EXPIRY_MS);
    advanceCrisisClock(match, t0 + OPERATION_EXPIRY_MS + 61_000);
    expect(match.crisis.pendingOperations["grid-isolation"]?.status).toBe("expired");
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("expired without quorum"))).toBe(true);
    expect(match.crisis.isolation.activeUntilMs).toBeFalsy();
  });

  it("executes grid isolation at quorum with its effects and costs", () => {
    const { match, engineer, command } = labCrew();
    const t0 = 6_000_000;
    advanceCrisisClock(match, t0);
    match.resonance.pressure = 40;
    proposeCoordinatedOperation(match, engineer, "grid-isolation", t0);
    confirmCoordinatedOperation(match, command, "grid-isolation", t0 + 1_000);
    expect(match.crisis.pendingOperations["grid-isolation"]?.status).toBe("executed");
    expect(match.crisis.isolation.activeUntilMs).toBe(t0 + 1_000 + 90_000);
    expect(match.systems.power.stability).toBe(44); // 34 seeded + 10
    expect(match.resonance.pressure).toBe(32);
  });

  it("lets Command declare a costly emergency override of a pending authorization", () => {
    const { match, engineer, command } = labCrew();
    const t0 = 7_000_000;
    advanceCrisisClock(match, t0);
    match.resonance.pressure = 40;
    proposeCoordinatedOperation(match, engineer, "grid-isolation", t0);
    proposeEmergencyOverride(match, command, "grid-isolation", t0 + 2_000);
    expect(match.crisis.pendingOperations["grid-isolation"]?.status).toBe("executed");
    expect(match.players.cmd?.strain).toBeGreaterThanOrEqual(10);
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("emergency override"))).toBe(true);
  });

  it("collapses crew under strain, keeps them in the match, and requires physical rescue", () => {
    const { match, engineer, medic } = labCrew();
    const t0 = 8_000_000;
    advanceCrisisClock(match, t0);
    // Push the engineer to the brink; the next failure drain collapses exactly them,
    // leaving the medic standing to perform the rescue.
    match.players.eng!.strain = 89;
    injectCrisisEffect(match, "hull-drain", t0 + 1_000);
    injectCrisisEffect(match, "hull-drain", t0 + 1_001);
    advanceCrisisClock(match, t0 + 61_000); // failure drain collapses the engineer
    expect(match.players.eng?.incapacitated).toBe(true);
    expect(match.players.cmd?.incapacitated).toBe(false);
    expect(match.players.eng?.connection).toBe("connected"); // never removed
    expect(() => proposeCoordinatedOperation(match, engineer, "grid-isolation", t0 + 62_000)).toThrow("Incapacitated players cannot perform this action.");
    // Medical rescue is physical: wrong room is rejected, and the medic must
    // physically walk to the collapsed crew member (medical → command → engineering).
    expect(() => rescuePlayer(match, medic, engineer)).toThrow("Reach the collapsed crew member");
    movePlayer(match, medic, "command", 40, 40);
    movePlayer(match, medic, "engineering", 40, 40);
    rescuePlayer(match, medic, engineer);
    expect(match.players.eng?.incapacitated).toBe(false);
    expect(match.players.eng?.strain).toBe(STRAIN_LIMIT - 35); // strain capped at 100 before collapse
  });

  it("covers a missing specialist through a costly, degraded emergency fallback", () => {
    const occupied = labCrew(true);
    expect(() => performEmergencyFallback(occupied.match, occupied.command, "medical", 1_000)).toThrow("seat is occupied");

    const { match, command } = labCrew(false); // no medic holds the seat
    const t0 = 9_000_000;
    advanceCrisisClock(match, t0);
    const suppliesBefore = match.sharedResources.medicalSupplies;
    const result = performEmergencyFallback(match, command, "medical", t0 + 1_000);
    expect(match.sharedResources.medicalSupplies).toBe(suppliesBefore - 2);
    expect(result.evidenceId).toBe("emergency-medical-triage");
    expect(result.observation).toContain("coarse");
    const evidence = match.evidence["emergency-medical-triage"];
    expect(evidence?.visibility).toBe("shared");
    expect(evidence?.reliability).toBe("lowConfidence");
    // Depleted reserves close the fallback too.
    match.sharedResources.medicalSupplies = 1;
    expect(() => performEmergencyFallback(match, command, "medical", t0 + 2_000)).toThrow("reserve cost is not available");
  });

  it("fires scheduled crisis pulses and reacts to actual station state", () => {
    const { match } = labCrew();
    const t0 = 10_000_000;
    advanceCrisisClock(match, t0);
    // Launch delivered the impossible distress call — the only pulse so far.
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("IMPOSSIBLE DISTRESS CALL"))).toBe(true);
    advanceCrisisClock(match, t0 + 45_000); // inside the sweep interval: nothing happens
    expect(match.crisis.pulses.length).toBe(1);
    advanceCrisisClock(match, t0 + 60_000); // sweep 1
    advanceCrisisClock(match, t0 + 120_000); // sweep 2: scheduled grid surge
    expect(match.crisis.sweepCount).toBe(2);
    expect(match.crisis.pulses.some((pulse) => pulse.description.startsWith("Grid surge"))).toBe(true);
    expect(match.systems.power.stability).toBe(21); // 34 seeded: sweep1 −4, sweep2 surge −5 and −4
  });

  it("centralizes every resonance change through one choke point that re-derives condition", () => {
    const { match } = labCrew();
    const t0 = 12_000_000;
    advanceCrisisClock(match, t0);
    // Lab injections push pressure through the choke point, which re-derives the ladder.
    injectCrisisEffect(match, "resonance-spike", t0 + 1_000); // +30 over the seeded 18
    expect(match.resonance.pressure).toBe(48);
    expect(match.resonance.condition).toBe("unstable");
    injectCrisisEffect(match, "resonance-spike", t0 + 1_100);
    expect(match.resonance.pressure).toBe(78);
    expect(match.resonance.condition).toBe("critical"); // ≥ RESONANCE_CRITICAL_PRESSURE

    // Direct pressure API clamps at the bounds and re-derives the ladder.
    applyResonancePressure(match, 100, null, t0 + 1_200); // clamped to 100
    expect(match.resonance.pressure).toBe(100);
    applyResonancePressure(match, -200, "Resonance bled off through the containment lattice.", t0 + 1_300); // clamped to 0
    expect(match.resonance.pressure).toBe(0);
    expect(match.resonance.condition).toBe("stable");
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("containment lattice"))).toBe(true);
  });

  it("bleeds the power grid every sweep while resonance sits critical — with the cause visible", () => {
    const { match } = labCrew();
    const t0 = 15_000_000;
    advanceCrisisClock(match, t0);
    injectCrisisEffect(match, "resonance-spike", t0 + 1_000); // seeded 18 + 30 = 48
    injectCrisisEffect(match, "resonance-spike", t0 + 1_100); // 78 → critical
    expect(match.resonance.condition).toBe("critical");
    // The tier crossing is telegraphed with its physical consequence.
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("band has gone critical"))).toBe(true);
    const powerBefore = match.systems.power.stability;
    advanceCrisisClock(match, t0 + 61_000);
    // One sweep: the critical band bleeds −3 on top of the normal critical-tier deterioration −4.
    expect(match.systems.power.stability).toBe(powerBefore - RESONANCE_CRITICAL_POWER_DRAIN - 4);
    expect(match.crisis.pulses.some((pulse) => pulse.description.includes("bleeding the power grid"))).toBe(true);
  });

  it("gives Navigation a distinct chart-verified mitigation procedure", () => {
    const { match, navigator } = labCrew();
    const t0 = 13_000_000;
    advanceCrisisClock(match, t0);
    // Navigation degrades below critical through the seeded power dependency.
    setTier(match, "navigation", 45);
    const reserveBefore = match.sharedResources.reservePower;
    runProcedure(match, navigator, "replot-course", t0 + 1_000);
    expect(match.sharedResources.reservePower).toBe(reserveBefore - 1);
    expect(match.systems.navigation.stability).toBe(57); // 45 + PROCEDURE_NAVIGATION_RECOVERY
    expect(match.systems.navigation.condition).toBe("stable");
    // Role- and room-gated like every other procedure.
    expect(() => runProcedure(match, engineerPlayer(match), "replot-course", t0 + 2_000)).toThrow("Only the navigation specialist");
  });

  it("covers a missing navigator through a costly Command fallback", () => {
    const occupied = labCrew(true, true);
    expect(() => performEmergencyFallback(occupied.match, occupied.command, "navigation", 1_000)).toThrow("seat is occupied");

    const { match, command } = labCrew(true, false); // navigator seat empty
    const t0 = 14_000_000;
    advanceCrisisClock(match, t0);
    const reserveBefore = match.sharedResources.reservePower;
    const result = performEmergencyFallback(match, command, "navigation", t0 + 1_000);
    expect(match.sharedResources.reservePower).toBe(reserveBefore - 2);
    expect(result.evidenceId).toBe("emergency-navigation-triage");
    expect(result.observation).toContain("Navigator would have caught the drift");
    const evidence = match.evidence["emergency-navigation-triage"];
    expect(evidence?.visibility).toBe("shared");
    expect(evidence?.reliability).toBe("lowConfidence");
  });

  it("synchronizes crisis consequences across every client view", () => {
    const { match, engineer, command } = labCrew();
    const t0 = 11_000_000;
    advanceCrisisClock(match, t0);
    injectCrisisEffect(match, "power-drain", t0 + 1_000);
    const engineerView = JSON.stringify(projectClientView(match, engineer));
    const commandView = JSON.stringify(projectClientView(match, command));
    expect(JSON.parse(engineerView).revision).toBe(JSON.parse(commandView).revision);
    expect(engineerView).toContain("has failed");
    expect(commandView).toContain("has failed");
    expect(engineerView).toContain("Recovery window open");
    expect(commandView).toContain("Recovery window open");
  });
});

function commandPlayer(match: MatchState): string {
  const player = Object.values(match.players).find((candidate) => candidate.role === "command");
  if (!player) throw new Error("No command player in this fixture.");
  return player.id;
}

function engineerPlayer(match: MatchState): string {
  const player = Object.values(match.players).find((candidate) => candidate.role === "engineering");
  if (!player) throw new Error("No engineering player in this fixture.");
  return player.id;
}
