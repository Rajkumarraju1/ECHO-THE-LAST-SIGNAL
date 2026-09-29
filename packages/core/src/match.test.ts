import { describe, expect, it } from "vitest";
import {
  addEvidence,
  addPing,
  addPlayer,
  annotateEvidence,
  advanceConnectionDeadlines,
  assignRole,
  createMatch,
  createSeededRng,
  investigate,
  linkEvidence,
  movePlayer,
  reserveDisconnectedPlayer,
  reconnectPlayer,
  launchMatch,
  projectClientView,
  proposeRelayContainment,
  confirmRelayContainment,
  requestAssistance,
  shareEvidence
} from "./index.js";

describe("authoritative match state", () => {
  it("never serializes private evidence to an unauthorized player", () => {
    const match = createMatch("ECHO-42", 42);
    addPlayer(match, "p1", "Aster");
    addPlayer(match, "p2", "Bram");
    assignRole(match, "p1", "communications");
    assignRole(match, "p2", "engineering");
    addEvidence(match, {
      id: "echo-fragment-1",
      title: "Impossible distress call",
      observation: "The reactor fails after the seventh bell.",
      reliability: "degraded",
      reporterId: "p1",
      discoveredAtMs: 10,
      origin: "crew-report",
      visibility: "private",
      recipientPlayerId: "p1",
      sharedByPlayerId: null,
      sharedAtMs: null,
      annotations: [],
      linkedEvidenceIds: []
    });

    const unauthorizedPayload = JSON.stringify(projectClientView(match, "p2"));
    expect(unauthorizedPayload).not.toContain("seventh bell");
    expect(projectClientView(match, "p1").private.evidence).toHaveLength(1);

    shareEvidence(match, "echo-fragment-1", "p1");
    const sharedView = projectClientView(match, "p2").sharedEvidence[0];
    expect(sharedView?.observation).toContain("seventh bell");
    // Provenance survives the release to the shared board.
    expect(sharedView?.origin).toBe("crew-report");
    expect(sharedView?.sharedByPlayerId).toBe("p1");
    expect(sharedView?.sharedAtMs).toBeGreaterThan(0);
    expect(() => shareEvidence(match, "echo-fragment-1", "p1")).toThrow("already on the shared crew board");
  });

  it("locks role selection at launch and requires two distinct players", () => {
    const match = createMatch("ECHO-43", 43);
    addPlayer(match, "p1", "Aster");
    expect(() => launchMatch(match)).toThrow("At least two players");
    addPlayer(match, "p2", "Bram");
    assignRole(match, "p1", "communications");
    assignRole(match, "p2", "engineering");
    launchMatch(match);
    expect(() => assignRole(match, "p1", "medical")).toThrow("Roles cannot change");
  });

  it("produces deterministic scenario variation from a seed", () => {
    const first = createSeededRng(12345);
    const second = createSeededRng(12345);
    const a = Array.from({ length: 8 }, () => first.nextInt(100));
    const b = Array.from({ length: 8 }, () => second.nextInt(100));
    expect(a).toEqual(b);
  });

  it("validates authoritative movement and supports a reserved reconnect", () => {
    const match = createMatch("ECHO-44", 44);
    addPlayer(match, "p1", "Aster");
    addPlayer(match, "p2", "Bram");
    assignRole(match, "p1", "communications");
    assignRole(match, "p2", "engineering");
    launchMatch(match);
    expect(match.systems.power?.stability).toBe(34);
    expect(match.systems.power?.condition).toBe("critical");
    expect(match.resonance).toEqual({ condition: "unstable", pressure: 18 });
    movePlayer(match, "p1", "communications", 25, 75);
    expect(match.players.p1?.position.roomId).toBe("communications");
    expect(() => movePlayer(match, "p1", "medical", 25, 75)).toThrow("not connected");
    reserveDisconnectedPlayer(match, "p1", 1_000);
    expect(() => movePlayer(match, "p1", "command", 0, 0)).toThrow("Disconnected");
    advanceConnectionDeadlines(match, 90_999);
    expect(match.players.p1?.connection).toBe("reserved");
    advanceConnectionDeadlines(match, 91_000);
    expect(match.players.p1?.connection).toBe("handoff");
    reconnectPlayer(match, "p1");
    expect(match.players.p1?.connection).toBe("connected");
    expect(() => reconnectPlayer(match, "p1")).not.toThrow();
  });

  it("requires linked, deliberately shared asymmetric evidence for a two-role operation", () => {
    const match = createMatch("ECHO-45", 45);
    addPlayer(match, "comms", "Aster");
    addPlayer(match, "engineer", "Bram");
    assignRole(match, "comms", "communications");
    assignRole(match, "engineer", "engineering");
    launchMatch(match);
    movePlayer(match, "comms", "communications", 30, 30);
    movePlayer(match, "engineer", "engineering", 30, 30);

    expect(() => investigate(match, "engineer", "signal-array", 100)).toThrow("communications authorization");
    investigate(match, "comms", "signal-array", 100);
    investigate(match, "engineer", "power-relay", 101);

    // The two instruments report genuinely different facts about the same relay.
    const commsReadout = projectClientView(match, "comms").private.evidence.find((item) => item.id === "signal-array-readout");
    const engineerReadout = projectClientView(match, "engineer").private.evidence.find((item) => item.id === "power-relay-readout");
    expect(commsReadout?.title).toBe("K-7 signal phase");
    expect(commsReadout?.observation).toContain("Echo predicts");
    expect(engineerReadout?.title).toBe("K-7 load trace");
    // Engineering gets measured physical state: load asymmetry, the exact
    // counterbalance window, and the failure mode it prevents.
    expect(engineerReadout?.observation).toContain("asymmetric load");
    expect(engineerReadout?.observation).toContain("counterbalance window");
    expect(engineerReadout?.observation).not.toContain("Echo predicts");
    // Neither specialist's private readout leaks to the other client.
    expect(JSON.stringify(projectClientView(match, "engineer"))).not.toContain("signal phase");
    expect(JSON.stringify(projectClientView(match, "comms"))).not.toContain("asymmetric load");
    expect(() => proposeRelayContainment(match, "comms")).toThrow("has not been shared");
    shareEvidence(match, "signal-array-readout", "comms");
    shareEvidence(match, "power-relay-readout", "engineer");
    annotateEvidence(match, "signal-array-readout", "engineer", "Engineering can counterbalance this.", 102);
    linkEvidence(match, "signal-array-readout", "power-relay-readout", "comms");
    // Contextual pings only reach rooms the sender occupies or adjoins.
    expect(() => addPing(match, "comms", "hazard", "medical", "Sealed off from here", 102)).toThrow("adjoin your position");
    addPing(match, "comms", "assist", "engineering", "Confirm K-7 load trace", 103);
    // Assistance requests are role-specific and can only target occupied seats.
    expect(() => requestAssistance(match, "comms", "navigation", "Reroute the route check", 103)).toThrow("No crew member holds");
    expect(() => requestAssistance(match, "comms", "communications", "Talk to myself", 103)).toThrow("already hold");
    requestAssistance(match, "comms", "engineering", "Counterbalance K-7", 104);

    const engineerView = projectClientView(match, "engineer");
    expect(engineerView.sharedEvidence).toHaveLength(2);
    expect(engineerView.sharedEvidence[0]?.annotations[0]?.authorPlayerId).toBe("engineer");
    expect(engineerView.sharedEvidence[0]?.linkedEvidenceIds).toContain("power-relay-readout");
    expect(engineerView.coordination.pings[0]?.senderPlayerId).toBe("comms");
    expect(engineerView.coordination.assistanceRequests[0]?.requestedRole).toBe("engineering");

    proposeRelayContainment(match, "comms");
    expect(() => confirmRelayContainment(match, "comms")).toThrow("Engineering must confirm");
    const pressureBefore = match.resonance.pressure;
    confirmRelayContainment(match, "engineer");
    expect(match.cooperativeOperation.status).toBe("stabilized");
    expect(match.resonance.pressure).toBe(pressureBefore - 10);
    const commsView = projectClientView(match, "comms");
    expect(commsView.coordination.cooperativeOperation.status).toBe("stabilized");
    // The synchronized station change lands as shared, sourced evidence for the whole crew.
    const outcome = commsView.sharedEvidence.find((evidence) => evidence.id === "relay-containment-record");
    expect(outcome?.origin).toBe("operation-outcome");
    expect(outcome?.visibility).toBe("shared");
  });
});
