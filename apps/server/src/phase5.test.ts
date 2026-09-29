import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createGameServer, type EchoGameServer } from "./index.js";

type Message = { type: string; [key: string]: unknown };

class TestClient {
  readonly messages: Message[] = [];
  private readonly listeners = new Set<() => void>();

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as Message);
      for (const listener of this.listeners) listener();
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /** Waits until the predicate returns a truthy value (undefined/false mean "not yet"). */
  async waitFor<T>(predicate: () => T | undefined | false, timeoutMs = 2_000): Promise<T> {
    const existing = predicate();
    if (existing) return existing;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(onMessage);
        reject(new Error(`Timed out waiting. Received: ${JSON.stringify(this.messages.slice(-6))}`));
      }, timeoutMs);
      const onMessage = () => {
        const match = predicate();
        if (!match) return;
        clearTimeout(timeout);
        this.listeners.delete(onMessage);
        resolve(match);
      };
      this.listeners.add(onMessage);
    });
  }

  latestView(): Record<string, unknown> | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.type === "match.view") return message.view as Record<string, unknown>;
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

type ScenarioView = {
  revision: number;
  phase: string;
  endReason: string | null;
  scenario: {
    act: number;
    echoDecisionAvailable: boolean;
    echoDecision: { choice: string } | null;
    pendingEchoDecision: {
      choice: string;
      status: "pending" | "authorized" | "expired";
      requiredRole: string;
      expiresAtMs: number;
      authorizedByPlayerId?: string | null;
    } | null;
    debrief: {
      title: string;
      choiceLine: string;
      outcomeLines: string[];
      confirmedLeads: string[];
      missedLeads: string[];
      stationLine: string;
      crewLine: string;
    } | null;
    confirmedLeadCount: number;
  };
  sharedEvidence: Array<{ id: string }>;
  public: {
    players: Array<{ callsign: string; position: { roomId: string } }>;
    systems: Record<string, { stability: number; condition: string }>;
    sharedResources: Record<string, number>;
    resonance: { condition: string; pressure: number };
    crisis: { pulses: Array<{ description: string }>; isolation: { activeUntilMs: number | null; reason: string | null } };
  };
  private: { role: string | null; evidence: Array<{ id: string }> };
};

function scenarioOf(client: TestClient) {
  return (client.latestView() as unknown as ScenarioView | undefined)?.scenario;
}

function viewOf(client: TestClient) {
  return client.latestView() as unknown as ScenarioView | undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("phase 5: the impossible distress call, played end to end over real sockets", () => {
  let server: EchoGameServer | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server?.close();
    server = undefined;
  });

  it("plays distress call → acts → manifestations → resonance ops → quorum decision → debrief", { timeout: 90_000 }, async () => {
    // Compressed drill pacing: 1-second sweeps keep the whole playthrough fast.
    server = createGameServer({ port: 0, sweepIntervalMs: 1_000 });
    const address = await server.listening() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;

    const command = await TestClient.connect(url);
    const engineering = await TestClient.connect(url);
    const communications = await TestClient.connect(url);
    clients.push(command, engineering, communications);

    // — Join, pick seats, launch. The distress call arrives with launch.
    command.send({ type: "room.join", roomCode: "PLAY06", callsign: "Rhea" });
    engineering.send({ type: "room.join", roomCode: "PLAY06", callsign: "Vale" });
    communications.send({ type: "room.join", roomCode: "PLAY06", callsign: "Lyris" });
    await command.waitFor(() => command.messages.find((message) => message.type === "session.ready"));
    await engineering.waitFor(() => engineering.messages.find((message) => message.type === "session.ready"));
    await communications.waitFor(() => communications.messages.find((message) => message.type === "session.ready"));
    command.send({ type: "role.select", role: "command" });
    engineering.send({ type: "role.select", role: "engineering" });
    communications.send({ type: "role.select", role: "communications" });
    await command.waitFor(() => (command.latestView() as unknown as ScenarioView | undefined)?.private.role === "command");
    await engineering.waitFor(() => (engineering.latestView() as unknown as ScenarioView | undefined)?.private.role === "engineering");
    await communications.waitFor(() => (communications.latestView() as unknown as ScenarioView | undefined)?.private.role === "communications");
    command.send({ type: "match.launch" });
    await command.waitFor(() => command.latestView()?.phase === "active");
    await engineering.waitFor(() => engineering.latestView()?.phase === "active");
    await communications.waitFor(() => communications.latestView()?.phase === "active");

    // — Act I: the impossible distress call is on every client's log.
    await command.waitFor(() => (command.latestView() as unknown as ScenarioView | undefined)?.public.crisis.pulses.some((pulse) => pulse.description.includes("IMPOSSIBLE DISTRESS CALL")));
    const launched = command.latestView() as unknown as ScenarioView;
    expect(launched.scenario.act).toBe(1);
    expect(launched.public.systems.power?.stability).toBe(34);
    expect(JSON.stringify(command.latestView())).toContain("IMPOSSIBLE DISTRESS CALL");

    // — Act I→II: Engineering walks to Engineering and traces K-7; the
    // share synchronizes the confirmed-lead count across every client.
    engineering.send({ type: "move", roomId: "engineering", x: 50, y: 50 });
    await engineering.waitFor(() => (engineering.latestView() as unknown as ScenarioView).public.players.some((player) => player.callsign === "Vale" && player.position.roomId === "engineering"));
    engineering.send({ type: "investigate", target: "power-relay" });
    await engineering.waitFor(() => (engineering.latestView() as unknown as ScenarioView).private.evidence.some((evidence) => evidence.id === "power-relay-readout"));
    engineering.send({ type: "evidence.share", evidenceId: "power-relay-readout" });
    await command.waitFor(() => scenarioOf(command)?.confirmedLeadCount === 1);

    // — Move Communications to its department before the long drive.
    communications.send({ type: "move", roomId: "communications", x: 50, y: 50 });
    await communications.waitFor(() => (communications.latestView() as unknown as ScenarioView).public.players.some((player) => player.callsign === "Lyris" && player.position.roomId === "communications"));

    // — Drive to Act IV with real crew work:
    //   Engineering reroutes whenever power leaves stable, and vents the band
    //   whenever resonance sits at critical so the grid bleed stays survivable.
    //   Communications deep-listens once Act II opens (pressure +14 — real
    //   engagement, real cost) and shares the Echo pulse log with the crew.
    for (let tick = 0; tick < 40; tick += 1) {
      await sleep(1_100);
      const engineeringView = viewOf(engineering);
      const communicationsView = viewOf(communications);
      if (!engineeringView || engineeringView.phase !== "active") break;
      if (!communicationsView || communicationsView.phase !== "active") break;
      // Communications bot first: listen before any vent deafens the array.
      if (communicationsView.scenario.act >= 2
        && !communicationsView.private.evidence.some((evidence) => evidence.id === "echo-pulse-log")
        && communicationsView.public.crisis.isolation.reason !== "echo-vent") {
        communications.send({ type: "deep.listen" });
      }
      if (communicationsView.private.evidence.some((evidence) => evidence.id === "echo-pulse-log")
        && !communicationsView.sharedEvidence.some((evidence) => evidence.id === "echo-pulse-log")) {
        communications.send({ type: "evidence.share", evidenceId: "echo-pulse-log" });
      }
      // Engineering bot: keep the grid alive and the band survivable.
      if (engineeringView.public.systems.power?.condition !== "stable") {
        engineering.send({ type: "procedure.run", procedureId: "reroute-power" });
      }
      if (engineeringView.scenario.act >= 2
        && engineeringView.public.resonance.condition === "critical"
        && engineeringView.public.crisis.isolation.reason !== "echo-vent") {
        engineering.send({ type: "vent.band" });
      }
      if (scenarioOf(command)?.act === 4) break;
    }
    // The resonance trade actually happened: a second confirmed lead exists,
    // and the band carried real pressure from the deliberate listen.
    await command.waitFor(() => scenarioOf(command)?.confirmedLeadCount === 2);
    expect(viewOf(communications)?.public.resonance.pressure ?? 0).toBeGreaterThanOrEqual(30); // seeded 18 + 14
    await command.waitFor(() => scenarioOf(command)?.act === 4, 60_000);
    await engineering.waitFor(() => scenarioOf(engineering)?.act === 4);
    await communications.waitFor(() => scenarioOf(communications)?.act === 4);
    // Manifestations have fired by Act III and are visible as corrupted evidence.
    expect(JSON.stringify(command.latestView())).toContain("Echo manifestation");
    expect(scenarioOf(command)?.echoDecisionAvailable).toBe(true);

    // — The final decision is a three-step quorum: Command proposes
    // ISOLATE; Engineering co-authorizes from its own department; Command
    // executes at the console. Nothing runs automatically.
    command.send({ type: "echo.propose", choice: "isolate" });
    await command.waitFor(() => scenarioOf(command)?.pendingEchoDecision?.status === "pending");
    await engineering.waitFor(() => scenarioOf(engineering)?.pendingEchoDecision?.status === "pending");
    await communications.waitFor(() => scenarioOf(communications)?.pendingEchoDecision?.status === "pending");
    expect(scenarioOf(command)?.pendingEchoDecision?.requiredRole).toBe("engineering");

    // Executing without co-authorization is refused, visibly, to the sender.
    command.send({ type: "echo.decide", choice: "isolate" });
    await command.waitFor(() => command.messages.find((message) => message.type === "intent.rejected" && String(message.message).includes("co-authorization")));
    expect(scenarioOf(command)?.echoDecision).toBeNull();
    expect(command.latestView()?.phase).toBe("active");

    // Engineering co-authorizes from its own department.
    engineering.send({ type: "echo.authorize" });
    await command.waitFor(() => scenarioOf(command)?.pendingEchoDecision?.status === "authorized");
    await engineering.waitFor(() => scenarioOf(engineering)?.pendingEchoDecision?.status === "authorized");

    // Executing a different choice than the co-authorized one is refused.
    command.send({ type: "echo.decide", choice: "amplify" });
    await command.waitFor(() => command.messages.find((message) => message.type === "intent.rejected" && String(message.message).includes("proposed and co-authorized")));
    expect(scenarioOf(command)?.echoDecision).toBeNull();

    // Explicit execution by Command commits — exactly once, for everyone.
    command.send({ type: "echo.decide", choice: "isolate" });
    await command.waitFor(() => scenarioOf(command)?.echoDecision?.choice === "isolate");
    await engineering.waitFor(() => scenarioOf(engineering)?.echoDecision?.choice === "isolate");
    await communications.waitFor(() => scenarioOf(communications)?.echoDecision?.choice === "isolate");

    // — Debrief: synchronized, honest, and grounded in the actual playthrough.
    const debrief = await command.waitFor(() => scenarioOf(command)?.debrief ?? undefined, 5_000);
    expect(debrief.title).toContain("Debrief");
    expect(debrief.choiceLine).toContain("isolation lattice");
    expect(debrief.confirmedLeads).toContain("The Echo pulse log");
    expect(debrief.confirmedLeads).toContain("The K-7 load trace");
    expect(debrief.missedLeads.length).toBeGreaterThan(0);
    expect(debrief.stationLine).toContain("Station condition:");
    const engineeringDebrief = scenarioOf(engineering)?.debrief;
    const communicationsDebrief = scenarioOf(communications)?.debrief;
    expect(communicationsDebrief?.choiceLine).toBe(debrief.choiceLine);
    expect(engineeringDebrief?.confirmedLeads).toEqual(debrief.confirmedLeads);
    expect(command.latestView()?.phase).toBe("ended");
    expect(command.latestView()?.endReason).toContain("sealed the Echo band");
  });
});
