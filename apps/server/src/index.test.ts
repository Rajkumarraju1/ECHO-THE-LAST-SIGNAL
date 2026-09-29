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

  waitFor(predicate: (message: Message) => boolean, timeoutMs = 2_000): Promise<Message> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(onMessage);
        reject(new Error(`Timed out waiting for server message. Received: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      const onMessage = () => {
        const match = this.messages.find(predicate);
        if (!match) return;
        clearTimeout(timeout);
        this.listeners.delete(onMessage);
        resolve(match);
      };
      this.listeners.add(onMessage);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

function matchView(message: Message): Record<string, unknown> | undefined {
  return message.type === "match.view" ? (message.view as Record<string, unknown>) : undefined;
}

describe("authoritative WebSocket room", () => {
  let server: EchoGameServer | undefined;
  const clients: TestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server?.close();
    server = undefined;
  });

  it("synchronizes two clients without leaking private role evidence and supports reconnect", async () => {
    server = createGameServer({ port: 0 });
    const address = await server.listening() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;
    const communications = await TestClient.connect(url);
    const engineering = await TestClient.connect(url);
    clients.push(communications, engineering);

    communications.send({ type: "room.join", roomCode: "ECHO42", callsign: "Aster" });
    const communicationsReady = await communications.waitFor((message) => message.type === "session.ready");
    const reconnectToken = communicationsReady.reconnectToken as string;
    engineering.send({ type: "room.join", roomCode: "ECHO42", callsign: "Bram" });
    await engineering.waitFor((message) => message.type === "session.ready");

    communications.send({ type: "role.select", role: "communications" });
    await communications.waitFor((message) => {
      const view = matchView(message);
      return Boolean(view?.private && (view.private as { role?: string }).role === "communications");
    });
    engineering.send({ type: "role.select", role: "engineering" });
    await engineering.waitFor((message) => {
      const view = matchView(message);
      return Boolean(view?.private && (view.private as { role?: string }).role === "engineering");
    });
    communications.send({ type: "match.launch" });

    const activeCommunications = await communications.waitFor((message) => matchView(message)?.phase === "active");
    await engineering.waitFor((message) => matchView(message)?.phase === "active");
    const communicationsPayload = JSON.stringify(activeCommunications);
    const engineeringPayload = JSON.stringify(engineering.messages);
    expect(communicationsPayload).toContain("Impossible distress call");
    expect(engineeringPayload).not.toContain("Impossible distress call");

    communications.send({ type: "move", roomId: "engineering", x: 20, y: 80 });
    const synchronizedMovement = await engineering.waitFor((message) => {
      const view = matchView(message);
      const publicState = view?.public as { players?: Array<{ callsign: string; position: { roomId: string } }> } | undefined;
      return publicState?.players?.some((player) => player.callsign === "Aster" && player.position.roomId === "engineering") ?? false;
    });
    expect(JSON.stringify(synchronizedMovement)).toContain("engineering");

    communications.send({ type: "move", roomId: "medical", x: 20, y: 80 });
    const rejected = await communications.waitFor((message) => message.type === "intent.rejected" && message.message === "That room is not connected to the player’s current location.");
    expect(rejected.code).toBe("intent_rejected");

    await communications.close();
    const reservedView = await engineering.waitFor((message) => {
      const view = matchView(message);
      const publicState = view?.public as { players?: Array<{ callsign: string; connection: string }> } | undefined;
      return publicState?.players?.some((player) => player.callsign === "Aster" && player.connection === "reserved") ?? false;
    });
    expect(JSON.stringify(reservedView)).toContain("reserved");

    const reconnected = await TestClient.connect(url);
    clients.push(reconnected);
    reconnected.send({ type: "room.join", roomCode: "ECHO42", callsign: "Ignored", reconnectToken });
    const restoredView = await reconnected.waitFor((message) => matchView(message)?.phase === "active");
    expect(JSON.stringify(restoredView)).toContain("Impossible distress call");
    expect(JSON.stringify(restoredView)).toContain("connected");
  });

  it("recovers a stale reconnect token into a fresh guest join instead of trapping the player", async () => {
    server = createGameServer({ port: 0 });
    const address = await server.listening() as AddressInfo;
    const url = `ws://127.0.0.1:${address.port}`;

    // A client presenting a token the server has never issued (restart, lost room).
    const stale = await TestClient.connect(url);
    clients.push(stale);
    stale.send({ type: "room.join", roomCode: "FRESH1", callsign: "Vale", reconnectToken: "stale-token-from-a-dead-server-000000" });
    const ready = await stale.waitFor((message) => message.type === "session.ready");
    // The stale token did not reject: the player got a brand-new session.
    expect(ready.reconnectToken).not.toBe("stale-token-from-a-dead-server-000000");
    const lobbyView = await stale.waitFor((message) => matchView(message) !== undefined);
    expect(matchView(lobbyView)?.phase).toBe("lobby");
    expect(stale.messages.find((message) => message.type === "intent.rejected")).toBeUndefined();

    // The recovered session participates in the normal lobby flow end to end.
    const crewmate = await TestClient.connect(url);
    clients.push(crewmate);
    crewmate.send({ type: "room.join", roomCode: "FRESH1", callsign: "Rhea" });
    await crewmate.waitFor((message) => message.type === "session.ready");
    stale.send({ type: "role.select", role: "engineering" });
    crewmate.send({ type: "role.select", role: "command" });
    await stale.waitFor((message) => {
      const view = matchView(message);
      return Boolean(view?.private && (view.private as { role?: string }).role === "engineering");
    });
    stale.send({ type: "match.launch" });
    await stale.waitFor((message) => matchView(message)?.phase === "active");
    await crewmate.waitFor((message) => matchView(message)?.phase === "active");

    // The fresh session's own token reconnects the reserved seat (valid path intact).
    const validToken = ready.reconnectToken as string;
    await stale.close();
    await crewmate.waitFor((message) => {
      const view = matchView(message);
      const players = view?.public as { players?: Array<{ callsign: string; connection: string }> } | undefined;
      return players?.players?.some((player) => player.callsign === "Vale" && player.connection === "reserved") ?? false;
    });
    const rejoined = await TestClient.connect(url);
    clients.push(rejoined);
    rejoined.send({ type: "room.join", roomCode: "FRESH1", callsign: "Ignored", reconnectToken: validToken });
    const restored = await rejoined.waitFor((message) => matchView(message)?.phase === "active");
    expect(JSON.stringify(restored)).toContain("Vale");
  });
});
