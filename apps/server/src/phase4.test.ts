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

type CrisisView = {
  revision: number;
  public: {
    systems: Record<string, { stability: number; condition: string; recoveryWindow: { openedAtMs: number | null; expiresAtMs: number | null } }>;
    sharedResources: Record<string, number>;
    crisis: {
      pulses: Array<{ id: string; description: string }>;
      pendingOperations: Record<string, { status: string; expiresAtMs: number }>;
      isolation: { activeUntilMs: number | null };
    };
  };
  private: { role: string | null };
};

function crisisState(client: TestClient) {
  const view = client.latestView() as unknown as CrisisView | undefined;
  if (!view) return undefined;
  return {
    view,
    system: (id: string) => view.public.systems[id],
    resources: () => view.public.sharedResources,
    pulses: () => view.public.crisis.pulses,
    operation: () => view.public.crisis.pendingOperations["grid-isolation"],
    isolation: () => view.public.crisis.isolation.activeUntilMs
  };
}

describe("phase 4 crisis loop over real WebSockets", () => {
  let server: EchoGameServer | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server?.close();
    server = undefined;
  });

  it("synchronizes a full crisis/recovery sequence across both clients", async () => {
    server = createGameServer({ port: 0 });
    const address = await server.listening() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;

    const engineering = await TestClient.connect(url);
    const commandClient = await TestClient.connect(url);
    clients.push(engineering, commandClient);
    engineering.send({ type: "room.join", roomCode: "LABCRIS", callsign: "Vale" });
    await engineering.waitFor(() => engineering.messages.find((message) => message.type === "session.ready"));
    commandClient.send({ type: "room.join", roomCode: "LABCRIS", callsign: "Rhea" });
    await commandClient.waitFor(() => commandClient.messages.find((message) => message.type === "session.ready"));

    engineering.send({ type: "role.select", role: "engineering" });
    commandClient.send({ type: "role.select", role: "command" });
    await engineering.waitFor(() => (engineering.latestView()?.private as { role?: string } | undefined)?.role === "engineering" ? true : undefined);
    await commandClient.waitFor(() => (commandClient.latestView()?.private as { role?: string } | undefined)?.role === "command" ? true : undefined);
    engineering.send({ type: "match.launch" });
    await engineering.waitFor(() => engineering.latestView()?.phase === "active" ? true : undefined);
    await commandClient.waitFor(() => commandClient.latestView()?.phase === "active" ? true : undefined);
    // Each specialist walks to their own department: procedures are location-gated.
    engineering.send({ type: "move", roomId: "engineering", x: 50, y: 50 });
    await engineering.waitFor(() => (engineering.latestView()?.public as { players?: Array<{ position?: { roomId?: string } }> } | undefined)?.players?.some((player) => player.position?.roomId === "engineering") ? true : undefined);

    // 1. Inject a power crisis in the laboratory room.
    engineering.send({ type: "crisis.inject", effect: "power-drain" });
    await engineering.waitFor(() => crisisState(engineering)?.system("power")?.condition === "failure" ? true : undefined);
    const failure = crisisState(engineering)!;
    expect(failure.system("power")!.recoveryWindow.expiresAtMs).toBeGreaterThan(0);
    expect(failure.pulses().some((pulse) => pulse.description.includes("Recovery window open"))).toBe(true);

    // Both clients see the same failure at the same revision — synchronized truth.
    await commandClient.waitFor(() => crisisState(commandClient)?.system("power")?.condition === "failure" ? true : undefined);
    expect(crisisState(commandClient)!.view.revision).toBe(failure.view.revision);
    expect(crisisState(commandClient)!.system("power")!.stability).toBe(failure.system("power")!.stability);

    // 2. Unauthorized procedure attempts are rejected on the wire.
    commandClient.send({ type: "procedure.run", procedureId: "reroute-power" });
    await commandClient.rejection();
    engineering.send({ type: "procedure.run", procedureId: "reroute-power" });
    // ...and the authorized one lands: the recovery window closes, reserves drop on both views.
    await engineering.waitFor(() => crisisState(engineering)?.system("power")?.condition !== "failure" ? true : undefined);
    const afterProcedure = crisisState(engineering)!;
    expect(afterProcedure.system("power")!.stability).toBe(failure.system("power")!.stability + 18);
    expect(afterProcedure.resources().reservePower).toBe(5);
    await commandClient.waitFor(() => crisisState(commandClient)?.resources().reservePower === 5 ? true : undefined);
    expect(crisisState(commandClient)!.view.revision).toBe(afterProcedure.view.revision);

    // 3. Quorum operation: Engineering proposes, Command confirms — visible to both.
    engineering.send({ type: "operation.quorum.propose", operationId: "grid-isolation" });
    await engineering.waitFor(() => crisisState(engineering)?.operation()?.status === "pending" ? true : undefined);
    await commandClient.waitFor(() => crisisState(commandClient)?.operation()?.status === "pending" ? true : undefined);
    expect(crisisState(commandClient)!.operation()!.expiresAtMs).toBe(crisisState(engineering)!.operation()!.expiresAtMs);
    commandClient.send({ type: "operation.quorum.confirm", operationId: "grid-isolation" });
    await engineering.waitFor(() => crisisState(engineering)?.isolation() ? true : undefined);
    await commandClient.waitFor(() => crisisState(commandClient)?.isolation() ? true : undefined);
    expect(crisisState(commandClient)!.isolation()).toBe(crisisState(engineering)!.isolation());
    expect(crisisState(engineering)!.operation()!.status).toBe("executed");

    // 4. Collapsed crew requires rescue; unauthorized rescue attempts are rejected.
    engineering.send({ type: "crisis.inject", effect: "strain-shock" });
    await engineering.waitFor(() => {
      const players = engineering.latestView()?.public as { players?: Array<{ incapacitated: boolean }> } | undefined;
      return players?.players?.every((player) => player.incapacitated) ? true : undefined;
    });
    engineering.send({ type: "rescue.player", targetPlayerId: "nobody" });
    await engineering.rejection();
    // Everyone is down, so the sequence ends here; the important assertion is
    // that the collapse and the rejection synchronized to both clients.
    await commandClient.waitFor(() => {
      const players = commandClient.latestView()?.public as { players?: Array<{ incapacitated: boolean }> } | undefined;
      return players?.players?.every((player) => player.incapacitated) ? true : undefined;
    });
  });

  it("rejects crisis injection outside laboratory rooms", async () => {
    server = createGameServer({ port: 0 });
    const address = await server.listening() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;

    const engineering = await TestClient.connect(url);
    const commandClient = await TestClient.connect(url);
    clients.push(engineering, commandClient);
    engineering.send({ type: "room.join", roomCode: "ECHO77", callsign: "Vale" });
    await engineering.waitFor(() => engineering.messages.find((message) => message.type === "session.ready"));
    commandClient.send({ type: "room.join", roomCode: "ECHO77", callsign: "Rhea" });
    await commandClient.waitFor(() => commandClient.messages.find((message) => message.type === "session.ready"));
    engineering.send({ type: "role.select", role: "engineering" });
    commandClient.send({ type: "role.select", role: "command" });
    await engineering.waitFor(() => (engineering.latestView()?.private as { role?: string } | undefined)?.role === "engineering" ? true : undefined);
    await commandClient.waitFor(() => (commandClient.latestView()?.private as { role?: string } | undefined)?.role === "command" ? true : undefined);
    engineering.send({ type: "match.launch" });
    await engineering.waitFor(() => engineering.latestView()?.phase === "active" ? true : undefined);

    engineering.send({ type: "crisis.inject", effect: "power-drain" });
    await engineering.rejection();
    expect(engineering.latestView()?.phase).toBe("active");
  });
});
