export const ROLES = [
  "engineering",
  "navigation",
  "medical",
  "communications",
  "security",
  "science",
  "logistics",
  "command"
] as const;

export type Role = (typeof ROLES)[number];

export const SYSTEM_IDS = ["power", "lifeSupport", "hull", "navigation"] as const;
export type SystemId = (typeof SYSTEM_IDS)[number];

export type MatchPhase = "lobby" | "active" | "ended";
export type SystemCondition = "stable" | "critical" | "failure" | "terminal";
export type ResonanceCondition = "stable" | "unstable" | "critical";
export type ConnectionState = "connected" | "reserved" | "handoff";
export type EvidenceVisibility = "private" | "shared";
export type PingKind = "investigate" | "hazard" | "assist" | "regroup";
export type OperationStatus = "unresolved" | "proposed" | "stabilized";
export type PendingOperationStatus = "pending" | "expired" | "executed";
export type CoordinatedOperationId = "grid-isolation";
export type CrisisPulseKind = "surge" | "strain" | "interference" | "log";

export interface Position {
  roomId: string;
  x: number;
  y: number;
}

export interface PlayerState {
  id: string;
  callsign: string;
  role: Role | null;
  position: Position;
  connection: ConnectionState;
  reconnectDeadlineMs: number | null;
  incapacitated: boolean;
  /** Accumulated physical strain; at the limit the crew member collapses. */
  strain: number;
}

export interface RecoveryWindow {
  openedAtMs: number | null;
  expiresAtMs: number | null;
}

export interface StationSystem {
  id: SystemId;
  condition: SystemCondition;
  stability: number;
  /** Open while the system is in failure; recovery must happen before expiry. */
  recoveryWindow: RecoveryWindow;
}

export interface ResonanceState {
  condition: ResonanceCondition;
  pressure: number;
}

export type EvidenceOrigin = "station-sensor" | "role-instrument" | "crew-report" | "operation-outcome" | "echo-manifestation";

export interface EvidenceRecord {
  id: string;
  title: string;
  observation: string;
  reliability: "confirmed" | "delayed" | "degraded" | "lowConfidence" | "corrupted";
  reporterId: string;
  discoveredAtMs: number;
  /** How this record entered the world; preserved when the record is shared. */
  origin: EvidenceOrigin;
  visibility: EvidenceVisibility;
  recipientPlayerId: string | null;
  /** Crew member who released this record to the shared board, and when. */
  sharedByPlayerId: string | null;
  sharedAtMs: number | null;
  annotations: EvidenceAnnotation[];
  linkedEvidenceIds: string[];
}

export interface EvidenceAnnotation {
  id: string;
  authorPlayerId: string;
  content: string;
  createdAtMs: number;
}

export interface ContextualPing {
  id: string;
  senderPlayerId: string;
  kind: PingKind;
  roomId: string;
  message: string;
  createdAtMs: number;
}

export interface AssistanceRequest {
  id: string;
  senderPlayerId: string;
  requestedRole: Role;
  roomId: string;
  message: string;
  createdAtMs: number;
}

export interface CooperativeOperation {
  id: "relay-containment";
  status: OperationStatus;
  proposedByPlayerId: string | null;
  confirmedByPlayerId: string | null;
}

export interface SharedReserve {
  reservePower: number;
  lifeSupportReserve: number;
  repairMaterials: number;
  medicalSupplies: number;
}

export interface PendingOperation {
  id: CoordinatedOperationId;
  status: PendingOperationStatus;
  proposedByPlayerId: string;
  proposedAtMs: number;
  /** Authorization expires at this time; expiry is visible to every client. */
  expiresAtMs: number;
  requiredRoles: Role[];
  confirmedByPlayerIds: string[];
}

export interface CrisisPulseRecord {
  id: string;
  kind: CrisisPulseKind;
  roomId: string | null;
  systemId: SystemId | null;
  description: string;
  atMs: number;
}

export interface CrisisState {
  /** Next scheduled crisis pulse; null until the station is active. */
  nextPulseAtMs: number | null;
  /** Monotonic id counter for crisis log entries. */
  pulseSeq: number;
  /** Synchronized crisis log; the newest entries are visible to all clients. */
  pulses: CrisisPulseRecord[];
  isolation: { activeUntilMs: number | null; reason: string | null };
  pendingOperations: Record<string, PendingOperation>;
  /** Server time of the last full crisis sweep; sweeps run at fixed intervals. */
  lastSweepAtMs: number | null;
  /** Number of completed crisis sweeps; drives the deterministic pulse plan. */
  sweepCount: number;
}

export interface ScenarioState {
  /** Set once launchMatch establishes the Phase-3 station scenario. */
  seeded: boolean;
  /** Present when the impossible distress call has arrived (Act I onward). */
  distressCallAtMs: number | null;
  /** Completed acts; Phase 5 acts advance on crisis sweeps. */
  act: 1 | 2 | 3 | 4;
  /** Highest act whose scripted beat has fired. */
  actStartedAtMs: Record<1 | 2 | 3 | 4, number | null>;
  /** Evidence the crew has logged for the final Echo decision (and debrief). */
  confirmedLeads: string[];
  /** Echo manifestations already shown to the crew. */
  manifestationIds: string[];
  /** Set when Command commits to one of the four final Echo decisions. */
  echoDecision: { choice: EchoDecisionChoice; atMs: number } | null;
  /**
   * The in-flight propose → co-authorize → execute sequence for the final
   * Echo decision. Command proposes; the domain seat co-authorizes from its
   * own department; only then can Command execute. Expiry is always visible.
   */
  pendingEchoDecision: PendingEchoDecision | null;
  /** Filled when the match ends by decision or collapse: the outcome debrief. */
  debrief: EchoDebrief | null;
  /** Distress-call origin coordinates, varied per seed from three honest possibilities. */
  distressOrigin: "derelict-hull" | "folded-signal" | "future-station";
}

export type EchoDecisionChoice = "isolate" | "sever" | "amplify" | "follow";

/** One proposed final Echo decision moving through the quorum sequence. */
export interface PendingEchoDecision {
  choice: EchoDecisionChoice;
  status: "pending" | "authorized" | "expired";
  proposedByPlayerId: string;
  proposedAtMs: number;
  /** The seat whose domain must co-authorize before Command may execute. */
  requiredRole: Role;
  /** Co-authorization window; lapsing is visible to every client. */
  expiresAtMs: number;
  /** Set by the co-authorizing domain seat. */
  authorizedByPlayerId?: string | null;
}

export interface EchoDebrief {
  title: string;
  /** What the crew chose, in one visible sentence. */
  choiceLine: string;
  /** What the station's instruments could actually verify about the outcome. */
  outcomeLines: string[];
  /** The leads the crew confirmed before deciding (acknowledged honestly). */
  confirmedLeads: string[];
  /** The leads the crew never confirmed — named as gaps, not as hidden truth. */
  missedLeads: string[];
  /** How the station ended (condition summary line). */
  stationLine: string;
  /** Who made it out of the shift standing. */
  crewLine: string;
}

export interface EchoManifestation {
  id: string;
  /** Sweep at which this manifestation becomes possible. */
  atSweep: number;
  /** The manifestation can only fire while this system tier holds. */
  requiresCondition?: "critical" | "failure";
  title: string;
  observation: string;
}

export interface ScenarioInvestigation {
  target: string;
  role: Role;
  roomId: string;
  evidenceId: string;
  title: string;
  observation: string;
  /** Counts as a confirmed lead for the Echo decision context. */
  lead?: boolean;
}

export interface MatchState {
  id: string;
  seed: number;
  revision: number;
  phase: MatchPhase;
  players: Record<string, PlayerState>;
  systems: Record<SystemId, StationSystem>;
  resonance: ResonanceState;
  scenario: ScenarioState;
  sharedResources: SharedReserve;
  crisis: CrisisState;
  evidence: Record<string, EvidenceRecord>;
  pings: ContextualPing[];
  assistanceRequests: AssistanceRequest[];
  cooperativeOperation: CooperativeOperation;
  /** Set when a system reaches terminal failure and the mission is lost. */
  endReason: string | null;
}

export interface PublicPlayerView {
  id: string;
  callsign: string;
  role: Role | null;
  position: Position;
  connection: ConnectionState;
  incapacitated: boolean;
  strain: number;
}

export interface EvidenceView {
  id: string;
  title: string;
  observation: string;
  reliability: EvidenceRecord["reliability"];
  origin: EvidenceOrigin;
  reporterId: string;
  discoveredAtMs: number;
  visibility: EvidenceVisibility;
  sharedByPlayerId: string | null;
  sharedAtMs: number | null;
  annotations: EvidenceAnnotation[];
  linkedEvidenceIds: string[];
}

export interface ScenarioView {
  act: 1 | 2 | 3 | 4;
  distressCallAtMs: number | null;
  actStartedAtMs: Record<1 | 2 | 3 | 4, number | null>;
  /** Set once the final Echo decision is available (Act IV). */
  echoDecisionAvailable: boolean;
  echoDecision: { choice: EchoDecisionChoice; atMs: number } | null;
  /** The live propose → co-authorize → execute state, if any. */
  pendingEchoDecision: PendingEchoDecision | null;
  debrief: EchoDebrief | null;
  /** Count of leads confirmed so far — fuels the debrief, not a score. */
  confirmedLeadCount: number;
  distressOrigin: ScenarioState["distressOrigin"];
}

export interface ClientMatchView {
  revision: number;
  phase: MatchPhase;
  endReason: string | null;
  scenario: ScenarioView;
  public: {
    players: PublicPlayerView[];
    systems: Record<SystemId, StationSystem>;
    resonance: ResonanceState;
    sharedResources: SharedReserve;
    crisis: {
      nextPulseAtMs: number | null;
      pulses: CrisisPulseRecord[];
      isolation: { activeUntilMs: number | null; reason: string | null };
      pendingOperations: Record<string, PendingOperation>;
    };
  };
  sharedEvidence: EvidenceView[];
  coordination: {
    pings: ContextualPing[];
    assistanceRequests: AssistanceRequest[];
    cooperativeOperation: CooperativeOperation;
  };
  private: {
    role: Role | null;
    evidence: EvidenceView[];
  };
}
