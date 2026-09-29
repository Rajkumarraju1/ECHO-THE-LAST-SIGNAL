export type Role = "engineering" | "navigation" | "medical" | "communications" | "security" | "science" | "logistics" | "command";
export type EchoChoice = "isolate" | "sever" | "amplify" | "follow";

export interface EchoDebriefView {
  title: string;
  choiceLine: string;
  outcomeLines: string[];
  confirmedLeads: string[];
  missedLeads: string[];
  stationLine: string;
  crewLine: string;
}

export interface ScenarioViewType {
  act: 1 | 2 | 3 | 4;
  distressCallAtMs: number | null;
  actStartedAtMs: Record<1 | 2 | 3 | 4, number | null>;
  echoDecisionAvailable: boolean;
  echoDecision: { choice: EchoChoice; atMs: number } | null;
  pendingEchoDecision: PendingEchoDecisionView | null;
  debrief: EchoDebriefView | null;
  confirmedLeadCount: number;
  distressOrigin: string;
}

export interface PendingEchoDecisionView {
  choice: EchoChoice;
  status: "pending" | "authorized" | "expired";
  proposedByPlayerId: string;
  proposedAtMs: number;
  requiredRole: Role;
  expiresAtMs: number;
  authorizedByPlayerId?: string | null;
}

export interface ClientView {
  revision: number;
  phase: "lobby" | "active" | "ended";
  endReason: string | null;
  scenario: ScenarioViewType;
  public: {
    players: Array<{
      id: string;
      callsign: string;
      role: Role | null;
      position: { roomId: string; x: number; y: number };
      connection: "connected" | "reserved" | "handoff";
      incapacitated: boolean;
      strain: number;
    }>;
    systems: Record<string, { id: string; condition: string; stability: number; recoveryWindow: { openedAtMs: number | null; expiresAtMs: number | null } }>;
    resonance: { condition: string; pressure: number };
    sharedResources: Record<string, number>;
    crisis: {
      nextPulseAtMs: number | null;
      pulses: Array<{ id: string; kind: string; roomId: string | null; systemId: string | null; description: string; atMs: number }>;
      isolation: { activeUntilMs: number | null; reason: string | null };
      pendingOperations: Record<string, {
        id: string;
        status: "pending" | "expired" | "executed";
        proposedByPlayerId: string;
        proposedAtMs: number;
        expiresAtMs: number;
        requiredRoles: Role[];
        confirmedByPlayerIds: string[];
      }>;
    };
  };
  sharedEvidence: EvidenceView[];
  coordination: CoordinationView;
  private: {
    role: Role | null;
    evidence: EvidenceView[];
  };
}

export interface EvidenceView {
  id: string;
  title: string;
  observation: string;
  reliability: string;
  origin: "station-sensor" | "role-instrument" | "crew-report" | "operation-outcome" | "echo-manifestation";
  reporterId: string;
  discoveredAtMs: number;
  visibility: "private" | "shared";
  sharedByPlayerId: string | null;
  sharedAtMs: number | null;
  annotations: Array<{ id: string; authorPlayerId: string; content: string; createdAtMs: number }>;
  linkedEvidenceIds: string[];
}

export interface CoordinationView {
  pings: Array<{ id: string; senderPlayerId: string; kind: string; roomId: string; message: string; createdAtMs: number }>;
  assistanceRequests: Array<{ id: string; senderPlayerId: string; requestedRole: Role; roomId: string; message: string; createdAtMs: number }>;
  cooperativeOperation: { id: "relay-containment"; status: "unresolved" | "proposed" | "stabilized"; proposedByPlayerId: string | null; confirmedByPlayerId: string | null };
}
