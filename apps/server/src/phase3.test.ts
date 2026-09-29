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

  rejection(): Promise<Message> {
    return this.waitFor(() => this.messages.find((message) => message.type === "intent.rejected"));
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

describe("phase 3 asymmetric cooperation loop", () => {
  let server: EchoGameServer | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server?.close();
    server = undefined;
  });

  it("moves different information through sharing, linking, ping/assist, and a synchronized station change", async () => {
    server = createGameServer({ port: 0 });
    const address = await server.listening() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;

    const comms = await TestClient.connect(url);
    const engineering = await TestClient.connect(url);
    clients.push(comms, engineering);
    comms.send({ type: "room.join", roomCode: "LOOP3", callsign: "Aster" });
    await comms.waitFor(() => comms.messages.find((message) => message.type === "session.ready"));
    engineering.send({ type: "room.join", roomCode: "LOOP3", callsign: "Bram" });
    await engineering.waitFor(() => engineering.messages.find((message) => message.type === "session.ready"));

    comms.send({ type: "role.select", role: "communications" });
    engineering.send({ type: "role.select", role: "engineering" });
    await comms.waitFor(() => (comms.latestView()?.private as { role?: string } | undefined)?.role === "communications" ? true : undefined);
    await engineering.waitFor(() => (engineering.latestView()?.private as { role?: string } | undefined)?.role === "engineering" ? true : undefined);
    comms.send({ type: "match.launch" });
    await comms.waitFor(() => comms.latestView()?.phase === "active" ? true : undefined);
    await engineering.waitFor(() => engineering.latestView()?.phase === "active" ? true : undefined);

    // 1. Launch seeds the shared physical situation both private briefings refer to.
    const launched = comms.latestView() as { public: { systems: Record<string, { stability: number; condition: string }>; resonance: { condition: string; pressure: number } } } | undefined;
    expect(launched?.public.systems.power?.stability).toBe(34);
    expect(launched?.public.resonance.condition).toBe("unstable");

    // 2. Each specialist walks to their own department and pulls different evidence.
    comms.send({ type: "move", roomId: "communications", x: 50, y: 50 });
    engineering.send({ type: "move", roomId: "engineering", x: 50, y: 50 });
    comms.send({ type: "investigate", target: "signal-array" });
    engineering.send({ type: "investigate", target: "power-relay" });
    await comms.waitFor(() => (comms.latestView()?.private as { evidence?: Array<{ id: string }> } | undefined)?.evidence?.some((item) => item.id === "signal-array-readout"));
    await engineering.waitFor(() => (engineering.latestView()?.private as { evidence?: Array<{ id: string }> } | undefined)?.evidence?.some((item) => item.id === "power-relay-readout"));

    // The readouts stay private: neither client can see the other's instrument output.
    expect(JSON.stringify(comms.latestView())).not.toContain("power-relay-readout");
    expect(JSON.stringify(engineering.latestView())).not.toContain("signal phase");
    // Engineering's own instrument delivers Engineering-specific physical facts.
    const engineeringPrivate = (engineering.latestView()?.private as { evidence?: Array<{ id: string; title: string; observation: string }> } | undefined)?.evidence ?? [];
    const loadTrace = engineeringPrivate.find((item) => item.id === "power-relay-readout");
    expect(loadTrace?.title).toBe("K-7 load trace");
    expect(loadTrace?.observation).toContain("asymmetric load");
    expect(loadTrace?.observation).toContain("counterbalance window");
    expect(loadTrace?.observation).not.toContain("Echo predicts");

    // 3. Provenance-tagged release onto the shared crew board.
    comms.send({ type: "evidence.share", evidenceId: "signal-array-readout" });
    engineering.send({ type: "evidence.share", evidenceId: "power-relay-readout" });
    const sharedBoard = await comms.waitFor(() => {
      const board = comms.latestView()?.sharedEvidence as Array<Record<string, unknown>> | undefined;
      return board?.length === 2 ? board : undefined;
    });
    expect(sharedBoard.every((item) => item.origin === "role-instrument" && item.sharedByPlayerId)).toBe(true);
    await engineering.waitFor(() => (engineering.latestView()?.sharedEvidence as unknown[] | undefined)?.length === 2);

    // 4. Contextual ping from Comms into the adjoining Engineering room; a far ping is rejected.
    comms.send({ type: "ping.send", kind: "assist", roomId: "medical", message: "Far ping should fail" });
    await comms.rejection();
    comms.send({ type: "ping.send", kind: "assist", roomId: "engineering", message: "Confirm K-7 load trace" });
    await engineering.waitFor(() => {
      const pings = engineering.latestView()?.coordination as { pings?: Array<Record<string, unknown>> } | undefined;
      return pings?.pings?.some((ping) => ping.roomId === "engineering" && ping.kind === "assist") ? true : undefined;
    });

    // 5. Role-specific assistance request targets the occupied Engineering seat only.
    comms.send({ type: "assist.request", role: "navigation", message: "Empty seat should fail" });
    await comms.rejection();
    comms.send({ type: "assist.request", role: "engineering", message: "Counterbalance K-7" });
    await engineering.waitFor(() => {
      const requests = (engineering.latestView()?.coordination as { assistanceRequests?: Array<Record<string, unknown>> } | undefined)?.assistanceRequests;
      return requests?.some((request) => request.requestedRole === "engineering") ? true : undefined;
    });

    // 6. The crew links the two halves into one interpretation and proposes the operation.
    comms.send({ type: "evidence.link", sourceEvidenceId: "signal-array-readout", targetEvidenceId: "power-relay-readout" });
    await comms.waitFor(() => {
      const board = comms.latestView()?.sharedEvidence as Array<{ linkedEvidenceIds?: string[] }> | undefined;
      return board?.some((item) => item.linkedEvidenceIds?.includes("power-relay-readout")) ? true : undefined;
    });
    expect(comms.messages.length).toBeGreaterThan(0);
    comms.send({ type: "operation.propose", operationId: "relay-containment" });
    await engineering.waitFor(() => ((engineering.latestView()?.coordination as { cooperativeOperation?: { status?: string } } | undefined)?.cooperativeOperation?.status) === "proposed");

    // 7. Engineering confirms from Engineering; the whole crew sees the station change.
    const systemsBefore = JSON.stringify((comms.latestView() as { public: { resonance: unknown } }).public.resonance);
    engineering.send({ type: "operation.confirm", operationId: "relay-containment" });
    const stabilized = await comms.waitFor(() => {
      const coordination = comms.latestView()?.coordination as { cooperativeOperation?: { status?: string } } | undefined;
      const resonance = (comms.latestView() as { public?: { resonance?: { pressure?: number } } } | undefined)?.public?.resonance;
      return coordination?.cooperativeOperation?.status === "stabilized" && resonance ? { status: coordination.cooperativeOperation.status, pressure: resonance.pressure } : undefined;
    });
    expect(stabilized.status).toBe("stabilized");
    expect(stabilized.pressure).toBeLessThan(JSON.parse(systemsBefore).pressure);
    expect(JSON.stringify(comms.latestView())).toContain("Relay K-7 contained");
    await engineering.waitFor(() => ((engineering.latestView()?.coordination as { cooperativeOperation?: { status?: string } } | undefined)?.cooperativeOperation?.status) === "stabilized" ? true : undefined);
    expect(JSON.stringify(engineering.latestView())).toContain("Relay K-7 contained");
  });
});
