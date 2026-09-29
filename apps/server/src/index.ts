import { randomBytes, randomUUID } from "node:crypto";
import { type AddressInfo } from "node:net";
import {
  addEvidence,
  addPing,
  addPlayer,
  annotateEvidence,
  advanceConnectionDeadlines,
  assignRole,
  createMatch,
  launchMatch,
  linkEvidence,
  movePlayer,
  investigate,
  proposeRelayContainment,
  projectClientView,
  reconnectPlayer,
  requestAssistance,
  reserveDisconnectedPlayer,
  shareEvidence,
  confirmRelayContainment,
  applyStationDrain,
  authorizeEchoDecision,
  confirmCoordinatedOperation,
  injectCrisisEffect,
  makeEchoDecision,
  performDeepListen,
  performEmergencyFallback,
  performVentTheBand,
  proposeEchoDecision,
  proposeCoordinatedOperation,
  proposeEmergencyOverride,
  rescuePlayer,
  runProcedure,
  type MatchState,
  type Role
} from "@echo/core";
import { clientIntentSchema, type ClientIntent } from "@echo/protocol";
import { WebSocket, WebSocketServer } from "ws";

interface PlayerSession {
  playerId: string;
  roomCode: string;
  reconnectToken: string;
  socket: WebSocket | null;
}

interface CreateServerOptions {
  host?: string;
  port?: number;
  /** Crisis sweep interval in ms (default 60 000). Shorter intervals accelerate drills. */
  sweepIntervalMs?: number;
}

const ROLE_BRIEFINGS: Record<Role, { title: string; observation: string }> = {
  engineering: { title: "Load anomaly", observation: "A future overload appears to begin in Engineering, but the path is incomplete." },
  navigation: { title: "Route divergence", observation: "The distress call contains a docking route that does not exist in the current station map." },
  medical: { title: "Crew status anomaly", observation: "The transmission includes an injury pattern no current crew member has sustained." },
  communications: { title: "Impossible distress call", observation: "The station is broadcasting a warning in its own voices from an outcome that has not happened." },
  security: { title: "Restricted incident", observation: "A future access log shows a quarantine action without a present incident record." },
  science: { title: "Resonance trace", observation: "Anomalous readings match a physical state the station does not currently occupy." },
  logistics: { title: "Missing manifest", observation: "A cargo manifest references emergency equipment that is absent from the current inventory." },
  command: { title: "Protocol contradiction", observation: "A future command authorization conflicts with the station's present emergency protocol." }
};

class AuthoritativeRoom {
  readonly match: MatchState;
  private readonly sessionsByPlayerId = new Map<string, PlayerSession>();
  private readonly sessionsByToken = new Map<string, PlayerSession>();
  readonly code: string;
  readonly sweepIntervalMs: number;

  constructor(code: string, sweepIntervalMs: number) {
    this.code = code;
    this.match = createMatch(code, hashRoomCode(code));
    this.sweepIntervalMs = sweepIntervalMs;
  }

  handleJoin(socket: WebSocket, intent: Extract<ClientIntent, { type: "room.join" }>): void {
    if (intent.reconnectToken) {
      const session = this.sessionsByToken.get(intent.reconnectToken);
      if (session && session.roomCode === intent.roomCode) {
        if (session.socket && session.socket !== socket) {
          session.socket.close();
          session.socket = null;
        }
        reconnectPlayer(this.match, session.playerId);
        session.socket = socket;
        this.sendSessionReady(session);
        this.broadcastViews();
        return;
      }
      // A stale token (server restart, expired room, wrong room) must not
      // trap the player: fall through to a fresh guest join with a new
      // session. Valid tokens for live matches still take the reconnect path
      // above, so the 90-second reserved seat behavior is unchanged.
    }
    if (this.match.phase !== "lobby") throw new Error("This roster is locked.");
    const playerId = randomUUID();
    const session: PlayerSession = {
      playerId,
      roomCode: this.code,
      reconnectToken: randomBytes(24).toString("base64url"),
      socket
    };
    addPlayer(this.match, playerId, intent.callsign);
    this.sessionsByPlayerId.set(playerId, session);
    this.sessionsByToken.set(session.reconnectToken, session);
    this.sendSessionReady(session);
    this.broadcastViews();
  }

  handleIntent(session: PlayerSession, intent: Exclude<ClientIntent, { type: "room.join" }>): void {
    switch (intent.type) {
      case "role.select":
        assignRole(this.match, session.playerId, intent.role);
        break;
      case "match.launch":
        launchMatch(this.match);
        this.createInitialRoleBriefings();
        break;
      case "move":
        movePlayer(this.match, session.playerId, intent.roomId, intent.x, intent.y);
        break;
      case "evidence.share":
        shareEvidence(this.match, intent.evidenceId, session.playerId);
        break;
      case "evidence.annotate":
        annotateEvidence(this.match, intent.evidenceId, session.playerId, intent.content, Date.now());
        break;
      case "evidence.link":
        linkEvidence(this.match, intent.sourceEvidenceId, intent.targetEvidenceId, session.playerId);
        break;
      case "ping.send":
        addPing(this.match, session.playerId, intent.kind, intent.roomId, intent.message, Date.now());
        break;
      case "assist.request":
        requestAssistance(this.match, session.playerId, intent.role, intent.message, Date.now());
        break;
      case "investigate":
        investigate(this.match, session.playerId, intent.target, Date.now());
        break;
      case "deep.listen":
        performDeepListen(this.match, session.playerId, Date.now());
        break;
      case "vent.band":
        performVentTheBand(this.match, session.playerId, Date.now());
        break;
      case "operation.propose":
        proposeRelayContainment(this.match, session.playerId);
        break;
      case "operation.confirm":
        confirmRelayContainment(this.match, session.playerId);
        break;
      case "procedure.run":
        runProcedure(this.match, session.playerId, intent.procedureId, Date.now());
        break;
      case "rescue.player":
        rescuePlayer(this.match, session.playerId, intent.targetPlayerId);
        break;
      case "operation.quorum.propose":
        proposeCoordinatedOperation(this.match, session.playerId, intent.operationId, Date.now());
        break;
      case "operation.quorum.confirm":
        confirmCoordinatedOperation(this.match, session.playerId, intent.operationId, Date.now());
        break;
      case "operation.override":
        proposeEmergencyOverride(this.match, session.playerId, intent.operationId, Date.now());
        break;
      case "emergency.fallback":
        performEmergencyFallback(this.match, session.playerId, intent.role, Date.now());
        break;
      case "crisis.inject":
        injectCrisisEffect(this.match, intent.effect, Date.now());
        applyStationDrain(this.match, 12);
        break;
      case "echo.propose":
        proposeEchoDecision(this.match, session.playerId, intent.choice, Date.now());
        break;
      case "echo.authorize":
        authorizeEchoDecision(this.match, session.playerId, Date.now());
        break;
      case "echo.decide":
        makeEchoDecision(this.match, session.playerId, intent.choice, Date.now());
        break;
    }
    this.broadcastViews();
  }

  disconnect(session: PlayerSession, socket: WebSocket): void {
    if (session.socket !== socket) return;
    session.socket = null;
    reserveDisconnectedPlayer(this.match, session.playerId, Date.now());
    this.broadcastViews();
  }

  advance(nowMs: number): void {
    const previousRevision = this.match.revision;
    advanceConnectionDeadlines(this.match, nowMs, this.sweepIntervalMs);
    if (this.match.revision !== previousRevision) this.broadcastViews();
  }

  sessionForSocket(socket: WebSocket): PlayerSession | undefined {
    return [...this.sessionsByPlayerId.values()].find((session) => session.socket === socket);
  }

  private createInitialRoleBriefings(): void {
    for (const player of Object.values(this.match.players)) {
      if (!player.role) continue;
      const briefing = ROLE_BRIEFINGS[player.role];
      addEvidence(this.match, {
        id: `briefing-${player.id}`,
        title: briefing.title,
        observation: briefing.observation,
        reliability: "degraded",
        reporterId: player.id,
        discoveredAtMs: Date.now(),
        origin: "station-sensor",
        visibility: "private",
        recipientPlayerId: player.id,
        sharedByPlayerId: null,
        sharedAtMs: null,
        annotations: [],
        linkedEvidenceIds: []
      });
    }
  }

  private sendSessionReady(session: PlayerSession): void {
    this.send(session.socket, {
      type: "session.ready",
      playerId: session.playerId,
      reconnectToken: session.reconnectToken
    });
  }

  private broadcastViews(): void {
    for (const session of this.sessionsByPlayerId.values()) {
      this.send(session.socket, { type: "match.view", view: projectClientView(this.match, session.playerId) });
    }
  }

  private send(socket: WebSocket | null, message: unknown): void {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
}

export class EchoGameServer {
  private readonly rooms = new Map<string, AuthoritativeRoom>();
  private readonly sessionBySocket = new WeakMap<WebSocket, PlayerSession>();
  private readonly wss: WebSocketServer;
  private readonly timer: NodeJS.Timeout;
  private readonly sweepIntervalMs: number;

  constructor(options: CreateServerOptions = {}) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    this.wss = new WebSocketServer({ host: options.host ?? "127.0.0.1", port: options.port ?? 8787 });
    this.wss.on("connection", (socket) => this.attach(socket));
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const room of this.rooms.values()) room.advance(now);
    }, 1_000);
  }

  async listening(): Promise<AddressInfo> {
    if (this.wss.address()) return this.wss.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      this.wss.once("listening", () => resolve(this.wss.address() as AddressInfo));
      this.wss.once("error", reject);
    });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    return new Promise((resolve, reject) => this.wss.close((error) => (error ? reject(error) : resolve())));
  }

  private attach(socket: WebSocket): void {
    socket.on("message", (data) => {
      try {
        const parsed = clientIntentSchema.safeParse(JSON.parse(data.toString()));
        if (!parsed.success) {
          this.reject(socket, "invalid_intent", "The client request was invalid.");
          return;
        }
        if (parsed.data.type === "room.join") {
          const room = this.getOrCreateRoom(parsed.data.roomCode);
          room.handleJoin(socket, parsed.data);
          const session = room.sessionForSocket(socket);
          if (session) this.sessionBySocket.set(socket, session);
          return;
        }
        const session = this.sessionBySocket.get(socket);
        if (!session) throw new Error("Join a room before sending match actions.");
        const room = this.rooms.get(session.roomCode);
        if (!room) throw new Error("Match room no longer exists.");
        room.handleIntent(session, parsed.data);
      } catch (error) {
        this.reject(socket, "intent_rejected", error instanceof Error ? error.message : "The request could not be completed.");
      }
    });
    socket.on("close", () => {
      const session = this.sessionBySocket.get(socket);
      if (!session) return;
      const room = this.rooms.get(session.roomCode);
      room?.disconnect(session, socket);
    });
  }

  private getOrCreateRoom(code: string): AuthoritativeRoom {
    const existing = this.rooms.get(code);
    if (existing) return existing;
    const room = new AuthoritativeRoom(code, this.sweepIntervalMs);
    this.rooms.set(code, room);
    return room;
  }

  private reject(socket: WebSocket, code: string, message: string): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "intent.rejected", code, message }));
  }
}

function hashRoomCode(code: string): number {
  return [...code].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 0x45d9f3b), 0x1f123bb5) >>> 0;
}

export function createGameServer(options: CreateServerOptions = {}): EchoGameServer {
  return new EchoGameServer(options);
}

if (process.argv[1]?.endsWith("index.ts")) {
  const server = createGameServer({
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 8787),
    sweepIntervalMs: Number(process.env.ECHO_SWEEP_MS ?? 60_000)
  });
  server.listening().then((address) => console.log(`ECHO game server listening on ws://localhost:${address.port} (crisis sweep ${process.env.ECHO_SWEEP_MS ?? 60_000}ms)`));
}
