import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ClientView, EvidenceView, Role, EchoChoice } from "./types";
import { StationViewport } from "./station/StationViewport";
import "./styles.css";

const ROLES: Array<{ id: Role; label: string; purpose: string }> = [
  { id: "engineering", label: "Engineering", purpose: "Power, reroutes, infrastructure" },
  { id: "navigation", label: "Navigation", purpose: "Routes, hazards, evacuation" },
  { id: "medical", label: "Medical", purpose: "Crew condition, rescue, life support" },
  { id: "communications", label: "Communications", purpose: "Echo signals and interference" },
  { id: "security", label: "Security", purpose: "Access and incident records" },
  { id: "science", label: "Science", purpose: "Anomalies and material evidence" },
  { id: "logistics", label: "Logistics", purpose: "Resources and equipment" },
  { id: "command", label: "Command", purpose: "Protocols and overrides" }
];

const ROOMS = ["command", "engineering", "communications", "navigation", "medical"];
const PING_KINDS = ["investigate", "hazard", "assist", "regroup"] as const;
const PING_MESSAGES: Record<(typeof PING_KINDS)[number], string> = {
  investigate: "Investigate this area",
  hazard: "Hazard reported here",
  assist: "Assistance needed here",
  regroup: "Regroup here"
};

const NEIGHBORS: Record<string, string[]> = {
  command: ["engineering", "communications", "navigation", "medical"],
  engineering: ["command", "communications"],
  communications: ["command", "engineering", "navigation"],
  navigation: ["command", "communications"],
  medical: ["command"]
};

const ORIGIN_LABELS: Record<string, string> = {
  "station-sensor": "station sensor",
  "role-instrument": "role instrument",
  "crew-report": "crew report",
  "operation-outcome": "operation record",
  "echo-manifestation": "Echo manifestation"
};

const INVESTIGATIONS: Partial<Record<Role, { target: string; room: string; label: string; evidenceId: string }>> = {
  communications: { target: "signal-array", room: "communications", label: "Analyze signal array", evidenceId: "signal-array-readout" },
  engineering: { target: "power-relay", room: "engineering", label: "Inspect K-7 power relay", evidenceId: "power-relay-readout" },
  navigation: { target: "signal-origin", room: "navigation", label: "Triangulate distress origin", evidenceId: "signal-origin-readout" },
  medical: { target: "vital-pattern", room: "medical", label: "Analyze vital pattern", evidenceId: "vital-pattern-readout" }
};

const ACT_LABELS: Record<number, string> = {
  1: "ACT I — FUNCTIONAL",
  2: "ACT II — UNEASY",
  3: "ACT III — WRONG",
  4: "ACT IV — FAILING"
};

/** Visual/analytical role identity — presentation only, no gameplay advantage. */
const ROLE_ACCENTS: Partial<Record<Role, { color: string; glyph: string; tagline: string }>> = {
  engineering: { color: "var(--role-eng)", glyph: "⚙", tagline: "Infrastructure — power, structures, reserves" },
  navigation: { color: "var(--role-nav)", glyph: "✦", tagline: "Routes — bearings, hazards, dead-reckoning" },
  medical: { color: "var(--role-med)", glyph: "✚", tagline: "Crew — bioreadings, collapses, life support" },
  communications: { color: "var(--role-com)", glyph: "◉", tagline: "The band — signals, interference, the Echo" },
  command: { color: "var(--role-cmd)", glyph: "✪", tagline: "Coordination — overrides, rescue orders, the final call" }
};

/** Reliability reads as a human label first; the raw tag stays in the title. */
const RELIABILITY_LABELS: Record<string, string> = {
  confirmed: "confirmed",
  delayed: "delayed",
  degraded: "degraded",
  lowConfidence: "low confidence",
  corrupted: "corrupted by the Echo"
};

const ORIGIN_GLYPHS: Record<string, string> = {
  "station-sensor": "⌁",
  "role-instrument": "⌖",
  "crew-report": "✎",
  "operation-outcome": "⟐",
  "echo-manifestation": "◈"
};

/** What the crew can do about each failing system — existing procedures, restated in place. */
const SYSTEM_RESPONSES: Record<string, string> = {
  power: "Response: Reroute grid power (Engineering · 1 reserve power)",
  lifeSupport: "Response: Recycle atmosphere (Medical · 1 life-support reserve)",
  hull: "Response: Patch hull breach (Engineering · 1 repair material)",
  navigation: "Response: Replot on dead-reckoning (Navigation · 1 reserve power)"
};

const RESONANCE_LINES: Record<string, string> = {
  critical: "critical — the band is bleeding the power grid every sweep. Vent the band or contain it.",
  unstable: "unstable — every interference source now pushes the band harder.",
  stable: "stable — the band is quiet."
};

function timeAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "moments ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

const ECHO_CHOICES: Array<{ choice: "isolate" | "sever" | "amplify" | "follow"; label: string; line: string }> = [
  { choice: "isolate", label: "ISOLATE", line: "Seal the Echo band inside the isolation lattice and wait it out." },
  { choice: "sever", label: "SEVER", line: "Cut the antenna feeds. The station stops listening — and stops calling." },
  { choice: "amplify", label: "AMPLIFY", line: "Answer the impossible call at full power, voice for voice. (2 reserve power)" },
  { choice: "follow", label: "FOLLOW", line: "Plot the distress route and burn the reserves to fly it. (3 reserve power)" }
];

const DOMAIN_LABELS: Partial<Record<Role, string>> = {
  engineering: "Engineering must hold the lattice or cut the feeds",
  communications: "Communications must carry the broadcast",
  navigation: "Navigation must fly the burn"
};

const ECHO_DOMAINS: Record<EchoChoice, Role> = { isolate: "engineering", sever: "engineering", amplify: "communications", follow: "navigation" };

const PROCEDURES: Partial<Record<Role, { id: string; room: string; label: string; cost: string }>> = {
  engineering: { id: "reroute-power", room: "engineering", label: "Reroute grid power", cost: "1 reserve power → power +18" },
  medical: { id: "recycle-atmosphere", room: "medical", label: "Recycle atmosphere", cost: "1 life-support reserve → life support +18" },
  navigation: { id: "replot-course", room: "navigation", label: "Replot on dead-reckoning", cost: "1 reserve power → navigation +12" }
};

/** Deliberate Echo engagement: real information, real resonance cost. */
const RESONANCE_OPS: Partial<Record<Role, { intent: "deep.listen" | "vent.band"; room: string; label: string; cost: string; blockedByEvidence: string }>> = {
  communications: { intent: "deep.listen", room: "communications", label: "Deep listen to the band", cost: "resonance +14 → confirmed lead (Echo pulse log)", blockedByEvidence: "echo-pulse-log" },
  engineering: { intent: "vent.band", room: "engineering", label: "Vent the band to space", cost: "1 repair material → resonance −26, array deaf 75s", blockedByEvidence: "" }
};
const RESOURCE_LABELS: Record<string, string> = {
  reservePower: "Reserve power",
  lifeSupportReserve: "Life-support reserve",
  repairMaterials: "Repair materials",
  medicalSupplies: "Medical supplies"
};
const OPERATION_LABELS: Record<string, string> = { "grid-isolation": "Grid isolation (90s)" };

function secondsLeft(targetMs: number | null): number | null {
  if (targetMs === null) return null;
  return Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
}

/** The room from which each domain seat co-authorizes its final Echo decision. */
function domainRoom(role: Role): string {
  switch (role) {
    case "engineering": return "engineering";
    case "communications": return "communications";
    case "navigation": return "navigation";
    case "medical": return "medical";
    default: return "command";
  }
}

function Ticking({ targetMs, prefix }: { targetMs: number | null; prefix: string }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = secondsLeft(targetMs);
  return <span>{remaining === null ? prefix : `${prefix} ${remaining}s`}</span>;
}

function EvidenceCard({ evidence, callsignFor, shared, board, linkSource, setLinkSource, draft, setDraft, submitAnnotation, onShare, privy }: {
  evidence: EvidenceView;
  callsignFor: (id: string | null) => string;
  shared?: boolean;
  board?: EvidenceView[];
  linkSource?: string | null;
  setLinkSource?: (id: string | null) => void;
  draft?: string;
  setDraft?: (id: string, value: string) => void;
  submitAnnotation?: (id: string) => void;
  onShare?: (id: string) => void;
  privy?: boolean;
}) {
  const provenance = `${callsignFor(evidence.reporterId)} · ${ORIGIN_LABELS[evidence.origin] ?? evidence.origin}`;
  const sharedProvenance = evidence.sharedByPlayerId ? ` · shared by ${callsignFor(evidence.sharedByPlayerId)}` : "";
  const candidates = (board ?? []).filter((candidate) => candidate.id !== evidence.id && !evidence.linkedEvidenceIds.includes(candidate.id));
  const linking = linkSource === evidence.id;
  const echoOrigin = evidence.origin === "echo-manifestation";
  const reliability = RELIABILITY_LABELS[evidence.reliability] ?? evidence.reliability;
  return <article className={`${privy ? "private-card" : ""} ${echoOrigin ? "echo-card" : ""}`}>
    <header className="card-head">
      <strong>{evidence.title}</strong>
      <span className={`reliability reliability-${evidence.reliability}`} title={`Recorded as: ${evidence.reliability}`}>{reliability}</span>
    </header>
    <p>{evidence.observation}</p>
    <footer className="provenance">
      <span className="prov-glyph" aria-hidden>{ORIGIN_GLYPHS[evidence.origin] ?? "⌁"}</span>
      <span className="prov-text">
        <em>found by {callsignFor(evidence.reporterId)}</em> · {ORIGIN_LABELS[evidence.origin] ?? evidence.origin} · {timeAgo(evidence.discoveredAtMs)}{shared ? sharedProvenance : ""}
      </span>
    </footer>
    {echoOrigin && <p className="echo-note">◈ Echo phenomenon — an alternate outcome surfacing on the band. Real in every reading; not this timeline's history.</p>}
    {evidence.linkedEvidenceIds.length > 0 && <p className="links">↔ {evidence.linkedEvidenceIds.map((id) => (board ?? []).find((candidate) => candidate.id === id)?.title ?? id).join(" · ")}</p>}
    {evidence.annotations.map((annotation) => <p key={annotation.id} className="annotation">↳ {callsignFor(annotation.authorPlayerId)}: {annotation.content}</p>)}
    {shared && setDraft !== undefined && <div className="card-controls"><input value={draft ?? ""} maxLength={240} placeholder="Add interpretation…" onChange={(event) => setDraft(evidence.id, event.target.value)} /><button onClick={() => submitAnnotation?.(evidence.id)} disabled={!(draft ?? "").trim()}>Annotate</button></div>}
    {shared && board && setLinkSource && candidates.length > 0 && !linking && <button onClick={() => setLinkSource(evidence.id)}>Link to…</button>}
    {shared && setLinkSource && linking && <div className="link-picker">{candidates.map((candidate) => <button key={candidate.id} onClick={() => { sendLink(evidence.id, candidate.id); setLinkSource(null); }}>Link “{candidate.title}”</button>)}<button className="muted" onClick={() => setLinkSource(null)}>Cancel</button></div>}
    {privy && onShare && <button onClick={() => onShare(evidence.id)}>Share with crew</button>}
  </article>;
}

// Set once App mounts; lets the card component issue intents without prop drilling the socket.
let sendLink: (source: string, target: string) => void = () => undefined;

function App() {
  const socket = useRef<WebSocket | null>(null);
  const [callsign, setCallsign] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [token, setToken] = useState(() => sessionStorage.getItem("echo.reconnectToken") ?? "");
  const [view, setView] = useState<ClientView | null>(null);
  const [notice, setNotice] = useState("Connect to a room with a callsign and code.");
  const [connected, setConnected] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [pingKind, setPingKind] = useState<(typeof PING_KINDS)[number]>("investigate");
  const [pingRoomId, setPingRoomId] = useState("command");
  const [assistRole, setAssistRole] = useState<Role>("engineering");

  useEffect(() => () => socket.current?.close(), []);

  const send = (message: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(message));
  sendLink = (source: string, target: string) => send({ type: "evidence.link", sourceEvidenceId: source, targetEvidenceId: target });

  const connect = () => {
    const code = roomCode.trim().toUpperCase();
    const name = callsign.trim();
    if (!/^[A-Z0-9]{4,8}$/.test(code) || !name) {
      setNotice("Enter a 4–8 character room code and a callsign.");
      return;
    }
    socket.current?.close();
    const wsUrl = import.meta.env.VITE_ECHO_SERVER_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787`;
    const ws = new WebSocket(wsUrl);
    socket.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setNotice("Connected. Waiting for crew.");
      send({ type: "room.join", roomCode: code, callsign: name, reconnectToken: token || undefined });
    };
    ws.onclose = () => {
      setConnected(false);
      setNotice("Connection lost. Reconnect to reclaim your reserved seat.");
    };
    ws.onerror = () => setNotice("Could not reach the game server.");
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as { type: string; [key: string]: unknown };
      if (message.type === "session.ready") {
        const newToken = message.reconnectToken as string;
        setPlayerId(message.playerId as string);
        setToken(newToken);
        sessionStorage.setItem("echo.reconnectToken", newToken);
      }
      if (message.type === "match.view") setView(message.view as ClientView);
      if (message.type === "intent.rejected") {
        setNotice(message.message as string);
        // A stale reconnect token (server restart, expired room) must not trap
        // the player: forget it and drop back to the join form.
        if ((message.message as string).includes("Reconnect session was not found")) {
          sessionStorage.removeItem("echo.reconnectToken");
          setToken("");
          setPlayerId(null);
          setView(null);
          setConnected(false);
          socket.current?.close();
        }
      }
    };
  };

  const assignedRoles = useMemo(() => new Set(view?.public.players.map((player) => player.role).filter(Boolean)), [view]);
  const me = view?.public.players.find((player) => player.id === playerId);
  const canLaunch = view?.phase === "lobby" && (view.public.players.length ?? 0) >= 2 && view.public.players.every((player) => player.role);
  const callsignFor = (id: string | null) => view?.public.players.find((player) => player.id === id)?.callsign ?? "crew";
  const investigation = me?.role ? INVESTIGATIONS[me.role] : undefined;
  const accent = me?.role ? ROLE_ACCENTS[me.role] : undefined;
  const currentRoom = me?.position.roomId ?? "command";
  const neighbors = NEIGHBORS[currentRoom] ?? [currentRoom];
  const pingOptions = [currentRoom, ...neighbors.filter((room) => room !== currentRoom)];
  const pingTarget = pingOptions.includes(pingRoomId) ? pingRoomId : currentRoom;
  const operation = view?.coordination.cooperativeOperation;
  const operationHint = operation?.status === "unresolved"
    ? "Communications proposes containment; Engineering confirms the counterbalance."
    : operation?.status === "proposed" ? "Waiting on Engineering to confirm the counterbalance." : "Relay contained. Well done, crew.";

  const setDraft = (id: string, value: string) => setDrafts((current) => ({ ...current, [id]: value }));
  const submitAnnotation = (evidenceId: string) => {
    const content = (drafts[evidenceId] ?? "").trim();
    if (!content) return;
    send({ type: "evidence.annotate", evidenceId, content });
    setDraft(evidenceId, "");
  };

  if (!playerId || !view) {
    return <main className="join-shell">
      <section className="join-card">
        <p className="eyebrow">ECHO // THE LAST SIGNAL — 2–8 PLAYER CO-OP</p>
        <h1>The Last Signal</h1>
        <p className="join-lede">Your station is receiving its own distress call — from an outcome that has not happened. Each specialist holds private information the rest of the crew needs to survive the Echo. Share what you know; decide together.</p>
        <ol className="join-steps">
          <li><strong>Join</strong> — pick a callsign and the room code your crew agreed on.</li>
          <li><strong>Claim a seat</strong> — each role sees different private evidence.</li>
          <li><strong>Survive Act IV</strong> — investigate, share, stabilize, and make the final call together.</li>
        </ol>
        <label>Callsign<input value={callsign} maxLength={16} onChange={(event) => setCallsign(event.target.value)} placeholder="ASTER" /></label>
        <label>Room code<input value={roomCode} maxLength={8} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="ECHO42" /></label>
        <button onClick={connect}>Join crew</button>
        <p className="notice" aria-live="polite">{notice}</p>
      </section>
    </main>;
  }

  return <main className="game-shell">
    <header><div><p className="eyebrow">ROOM {roomCode.toUpperCase()} // REV {view.revision} // {ACT_LABELS[view.scenario.act] ?? `ACT ${view.scenario.act}`}</p><h1>{view.phase === "lobby" ? "Crew assembly" : view.phase === "ended" ? "Station record closed" : "Station active"}</h1></div><p className={connected ? "connection live" : "connection"}>{connected ? "● LINK STABLE" : "● LINK LOST"}</p></header>
    {view.phase === "ended" && !view.scenario.debrief && <section className="panel end-banner"><h2>Mission failed</h2><p>{view.endReason}</p></section>}
    {view.phase === "ended" && view.scenario.debrief && <section className="panel end-banner debrief">
      <p className="debrief-kicker">FINAL DECISION — {view.scenario.echoDecision?.choice.toUpperCase() ?? "UNRESOLVED"} · {ACT_LABELS[view.scenario.act] ?? ""}</p>
      <h2>{view.scenario.debrief.title}</h2>
      <p className="choice-line">{view.scenario.debrief.choiceLine}</p>
      {view.scenario.debrief.outcomeLines.map((line, index) => <p key={index} className="outcome-line">{line}</p>)}
      <div className="debrief-columns">
        <div><h3>Confirmed leads</h3>{view.scenario.debrief.confirmedLeads.length ? view.scenario.debrief.confirmedLeads.map((lead, index) => <p key={index}>✔ {lead}</p>) : <p>None — the crew decided on instinct.</p>}</div>
        <div><h3>Never confirmed</h3>{view.scenario.debrief.missedLeads.length ? view.scenario.debrief.missedLeads.map((lead, index) => <p key={index}>— {lead}</p>) : <p>Everything the crew could reach, they reached.</p>}</div>
      </div>
      <footer className="debrief-foot"><span>{view.scenario.debrief.stationLine}</span><span>{view.scenario.debrief.crewLine}</span></footer>
      <p className="notice">The Echo never told this crew what was true. What they found, they found together.</p>
    </section>}
    {view.phase === "ended" ? null : view.phase === "lobby" ? <section className="lobby-layout">
      <div className="panel"><h2>Crew seats</h2><p>Each specialist receives private information once the station launches.</p><div className="roles">{ROLES.map((role) => <button key={role.id} disabled={Boolean(assignedRoles.has(role.id)) && me?.role !== role.id} className={me?.role === role.id ? "role selected" : "role"} onClick={() => send({ type: "role.select", role: role.id })}><strong>{role.label}</strong><span>{role.purpose}</span>{assignedRoles.has(role.id) && <em>Assigned</em>}</button>)}</div></div>
      <aside className="panel crew"><h2>Crew roster</h2>{view.public.players.map((player) => <p key={player.id}><strong>{player.callsign}</strong><span>{player.role ?? "Choosing a seat"}</span></p>)}<button disabled={!canLaunch} onClick={() => send({ type: "match.launch" })}>Launch station</button><p className="notice">{canLaunch ? "Roster is ready. Launch locks roles." : "At least two crew members must each choose a distinct role."}</p></aside>
    </section> : <section className="station-layout">
      <div className="station panel"><StationViewport view={view} playerId={playerId} onMove={(roomId) => send({ type: "move", roomId, x: 50, y: 50 })} /><p className="notice">Click an adjoining room to walk there. The server rejects impossible transitions.</p></div>
      <aside className="side-stack">
        <section className="panel">
          <h2>Your private briefing</h2>
          <p className="role-tag" style={accent && { color: accent.color }}>{accent?.glyph ?? ""} {view.private.role ?? "No assigned role"}</p>
          {accent && <p className="role-tagline">{accent.tagline}</p>}
          {(() => {
            const act = view.scenario.act;
            const lines: string[] = [];
            if (!investigation || !view.private.evidence.some((evidence) => evidence.id === investigation.evidenceId)) {
              if (!investigation) lines.push("Your specialty has no station readout yet — coordinate with the crew.");
              else if (me?.position.roomId !== investigation.room) lines.push(`Walk to ${investigation.room} to run your specialty readout.`);
              else lines.push("You are in position — run your specialty readout below.");
            }
            if (view.private.evidence.some((evidence) => evidence.id !== "briefing-" + (playerId ?? "")) && view.sharedEvidence.length === 0) lines.push("Private evidence stays yours alone until you share it with the crew.");
            if (act >= 2 && (view.public.resonance.condition !== "stable")) lines.push("The Echo band carries pressure — deliberate listening costs resonance, and a critical band bleeds the grid.");
            return lines.length ? <ul className="advisor">{lines.slice(0, 3).map((line, index) => <li key={index}>{line}</li>)}</ul> : null;
          })()}
          {investigation && me?.position.roomId === investigation.room && !view.private.evidence.some((evidence) => evidence.id === investigation.evidenceId) && <button onClick={() => send({ type: "investigate", target: investigation.target })}>{investigation.label}</button>}
          {view.private.evidence.map((evidence) => <EvidenceCard key={evidence.id} evidence={evidence} callsignFor={callsignFor} privy onShare={(id) => send({ type: "evidence.share", evidenceId: id })} />)}
          {view.private.evidence.length === 0 && <p>No private evidence currently available.</p>}
          {(() => {
            const procedure = me?.role ? PROCEDURES[me.role] : undefined;
            if (!procedure || me?.position.roomId !== procedure.room || me.incapacitated) return null;
            return <div className="procedure-row"><button onClick={() => send({ type: "procedure.run", procedureId: procedure.id })}>{procedure.label}</button><small>{procedure.cost}</small></div>;
          })()}
          {(() => {
            const op = me?.role ? RESONANCE_OPS[me.role] : undefined;
            if (!op || me?.position.roomId !== op.room || me?.incapacitated) return null;
            if (op.blockedByEvidence && view.private.evidence.some((evidence) => evidence.id === op.blockedByEvidence)) return null;
            const vented = (view.public.crisis.isolation.activeUntilMs ?? 0) > Date.now() && view.public.crisis.isolation.reason === "echo-vent";
            if (vented) return <small className="window warning">Array vented to space — nothing on the band can be heard until the vent cycle closes.</small>;
            return <div className="procedure-row"><button onClick={() => send({ type: op.intent })}>{op.label}</button><small>{op.cost}</small></div>;
          })()}
          {me?.role === "command" && (() => {
            if (me.position.roomId !== "command" || me.incapacitated) return null;
            const fallbacks: Array<{ role: "medical" | "engineering" | "navigation"; label: string; cost: string }> = [
              { role: "medical", label: "Emergency triage sweep", cost: "2 medical supplies → coarse shared bioreadings" },
              { role: "engineering", label: "Emergency load audit", cost: "2 repair materials → coarse shared grid audit" },
              { role: "navigation", label: "Emergency heading reconstruction", cost: "2 reserve power → coarse shared heading" }
            ];
            return fallbacks
              .filter((fallback) => !view.public.players.some((player) => player.role === fallback.role))
              .map((fallback) => (
                <div className="procedure-row" key={fallback.role}>
                  <button onClick={() => send({ type: "emergency.fallback", role: fallback.role })}>{fallback.label} (Command)</button>
                  <small>{fallback.cost}</small>
                </div>
              ));
          })()}
        </section>
        <section className="panel">
          <h2>Coordination</h2>
          <div className="coord-controls">
            <label className="inline">Ping kind<select value={pingKind} onChange={(event) => setPingKind(event.target.value as (typeof PING_KINDS)[number])}>{PING_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>
            <label className="inline">Room<select value={pingTarget} onChange={(event) => setPingRoomId(event.target.value)}>{pingOptions.map((room) => <option key={room} value={room}>{room}</option>)}</select></label>
            <button className="compact" onClick={() => send({ type: "ping.send", kind: pingKind, roomId: pingTarget, message: PING_MESSAGES[pingKind] })}>Send ping</button>
          </div>
          <div className="coord-controls">
            <label className="inline">Request<select value={assistRole} onChange={(event) => setAssistRole(event.target.value as Role)}>{ROLES.filter((role) => role.id !== me?.role).map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}</select></label>
            <button className="compact" onClick={() => send({ type: "assist.request", role: assistRole, message: `${assistRole} requested at ${currentRoom}` })}>Request specialist</button>
          </div>
          <div className="feed">{view.coordination.pings.map((ping) => <p key={ping.id}><strong>{callsignFor(ping.senderPlayerId)}</strong> · {ping.kind} @ {ping.roomId} — {ping.message}</p>)}{view.coordination.assistanceRequests.map((request) => <p key={request.id}><strong>{callsignFor(request.senderPlayerId)}</strong> requests {request.requestedRole} @ {request.roomId} — {request.message}</p>)}</div>
          <article><strong>Relay K-7 containment</strong><p>{operationHint}</p><small>Status: {operation?.status}</small>{operation?.status === "unresolved" && view.private.role === "communications" && <button onClick={() => send({ type: "operation.propose", operationId: "relay-containment" })}>Propose containment</button>}{operation?.status === "proposed" && view.private.role === "engineering" && <button onClick={() => send({ type: "operation.confirm", operationId: "relay-containment" })}>Confirm counterbalance</button>}</article>
          <article><strong>{OPERATION_LABELS["grid-isolation"]}</strong><p>Splits station sections for 90 seconds. Power +10, resonance −8, but strain climbs faster while isolated. Engineering proposes; Command confirms.</p>
            {(() => {
              const pending = view.public.crisis.pendingOperations["grid-isolation"];
              if (pending?.status === "pending") {
                const confirmed = pending.confirmedByPlayerIds.includes(playerId ?? "");
                return <>
                  <small>Pending · quorum: {pending.requiredRoles.join(" + ")} · <Ticking targetMs={pending.expiresAtMs} prefix="expires in" /></small>
                  {pending.requiredRoles.includes(view.private.role as Role) && !confirmed && <button onClick={() => send({ type: "operation.quorum.confirm", operationId: "grid-isolation" })}>Confirm</button>}
                  {view.private.role === "command" && <button className="danger" onClick={() => send({ type: "operation.override", operationId: "grid-isolation" })}>Emergency override (+10 strain, bypasses quorum)</button>}
                </>;
              }
              if (pending?.status === "executed" && (view.public.crisis.isolation.activeUntilMs ?? 0) > Date.now()) {
                return <small><Ticking targetMs={view.public.crisis.isolation.activeUntilMs} prefix="isolation ends in" /></small>;
              }
              if (pending?.status === "expired") return <small>Authorization expired — nothing was executed.</small>;
              return view.private.role === "engineering" && !me?.incapacitated && <button onClick={() => send({ type: "operation.quorum.propose", operationId: "grid-isolation" })} disabled={me?.position.roomId !== "engineering"}>Propose grid isolation</button>;
            })()}
          </article>
          {view.scenario.echoDecisionAvailable && !view.scenario.echoDecision && view.private.role === "command" && (() => {
            const reserves = view.public.sharedResources.reservePower ?? 0;
            const pending = view.scenario.pendingEchoDecision;
            if (pending && pending.status === "pending") {
              return <article className="echo-decision sequence">
                <header className="sequence-steps"><span className="step done">Proposed</span><span className="step now">Co-authorization</span><span className="step">Execution</span></header>
                <strong>ECHO DECISION PROPOSED: {pending.choice.toUpperCase()}</strong>
                <p>Nothing executes until the {pending.requiredRole} seat co-authorizes it from its own department.</p>
                <small>Awaiting the {pending.requiredRole} seat · <Ticking targetMs={pending.expiresAtMs} prefix="expires in" /> · leads: {view.scenario.confirmedLeadCount}</small>
              </article>;
            }
            if (pending && pending.status === "authorized") {
              return <article className="echo-decision sequence">
                <header className="sequence-steps"><span className="step done">Proposed</span><span className="step done">Co-authorized</span><span className="step now">Execution</span></header>
                <strong>ECHO DECISION AUTHORIZED: {pending.choice.toUpperCase()}</strong>
                <p>{callsignFor(pending.authorizedByPlayerId ?? null)} co-authorized it from {pending.requiredRole}. Command may now execute it at the console — or let it lapse and propose again.</p>
                <button className="danger" disabled={me?.incapacitated === true} onClick={() => send({ type: "echo.decide", choice: pending.choice })}>EXECUTE {pending.choice.toUpperCase()}</button>
                <small><Ticking targetMs={pending.expiresAtMs} prefix="authorization expires in" /> · leads: {view.scenario.confirmedLeadCount}</small>
              </article>;
            }
            return <article className="echo-decision sequence">
              <header className="sequence-steps"><span className="step now">Propose</span><span className="step">Co-authorization</span><span className="step">Execution</span></header>
              <strong>THE FINAL ECHO DECISION</strong>
              <p>The band is wide open and the station is failing. Command proposes; the department that must live with the action co-authorizes before anything executes. Every choice is survivable; none is safe.</p>
              <div className="echo-choices">
                {ECHO_CHOICES.map((entry) => (
                  <button key={entry.choice} className="danger" disabled={me?.incapacitated === true || (entry.choice === "amplify" && reserves < 2) || (entry.choice === "follow" && reserves < 3)} onClick={() => send({ type: "echo.propose", choice: entry.choice })}>
                    {entry.label}<small>{entry.line}</small>
                    <small className="domain-note">{DOMAIN_LABELS[ECHO_DOMAINS[entry.choice]] ?? ""}</small>
                  </button>
                ))}
              </div>
              <small>Reserve power: {reserves}. Amplify and Follow spend it at execution. Isolate and Sever do not. The crew's confirmed leads: {view.scenario.confirmedLeadCount}.</small>
            </article>;
          })()}
          {view.scenario.echoDecisionAvailable && !view.scenario.echoDecision && (() => {
            const pending = view.scenario.pendingEchoDecision;
            if (!pending || pending.status !== "pending" || view.private.role !== pending.requiredRole) return null;
            return <article className="echo-decision">
              <strong>CO-AUTHORIZATION REQUESTED</strong>
              <p>Command proposed to {pending.choice.toUpperCase()}. Your seat must co-authorize it from its own department before it can be executed — or refuse and let it lapse.</p>
              <button disabled={me?.position.roomId !== domainRoom(pending.requiredRole) || me?.incapacitated === true} onClick={() => send({ type: "echo.authorize" })}>CO-AUTHORIZE {pending.choice.toUpperCase()}</button>
              <small><Ticking targetMs={pending.expiresAtMs} prefix="expires in" /> — if it lapses, nothing was executed and Command may propose again.</small>
            </article>;
          })()}
          {view.scenario.echoDecision && <article className="echo-decision committed"><strong>Echo decision committed: {view.scenario.echoDecision.choice.toUpperCase()}</strong><p>It cannot be unmade. The debrief is on the shared record.</p></article>}
          <div className="rescue-row">
            {view.public.players.filter((candidate) => candidate.incapacitated).map((candidate) =>
              <p key={candidate.id}>🚑 <strong>{candidate.callsign}</strong> collapsed in {candidate.position.roomId}.{(me?.role === "medical" || me?.role === "command") && !me?.incapacitated && <button onClick={() => send({ type: "rescue.player", targetPlayerId: candidate.id })}>{me.role === "medical" ? "Stabilize" : "Order evacuation (−1 supply)"}</button>}</p>
            )}
          </div>
        </section>
        <section className="panel">
          <h2>Shared crew record</h2>
          {view.sharedEvidence.length ? view.sharedEvidence.map((evidence) => <EvidenceCard key={evidence.id} evidence={evidence} callsignFor={callsignFor} shared board={view.sharedEvidence} linkSource={linkSource} setLinkSource={setLinkSource} draft={drafts[evidence.id] ?? ""} setDraft={setDraft} submitAnnotation={submitAnnotation} />) : <p>No evidence shared yet.</p>}
        </section>
        <section className="panel">
          <h2>Station state</h2>
          <div className="systems">{Object.values(view.public.systems).map((system) => <div key={system.id} className="system-row">
            <div className="system-line"><span className="system-name">{system.id}</span><strong className={`condition ${system.condition}`}>{system.condition} · {system.stability}%</strong></div>
            <div className="system-bar"><span className={`bar-fill ${system.condition}`} style={{ width: `${system.stability}%` }} /></div>
            {system.condition === "failure" && <p className="system-response"><Ticking targetMs={system.recoveryWindow.expiresAtMs} prefix="Recovery window:" /> · {SYSTEM_RESPONSES[system.id]}</p>}
            {system.condition === "critical" && <p className="system-response">Destabilizing every sweep. {SYSTEM_RESPONSES[system.id]}</p>}
          </div>)}
          <div className="system-row resonance-row">
            <div className="system-line"><span className="system-name">Echo band</span><strong className={`condition ${view.public.resonance.condition}`}>{view.public.resonance.condition} · {view.public.resonance.pressure}</strong></div>
            <div className="system-bar"><span className={`bar-fill resonance ${view.public.resonance.condition}`} style={{ width: `${view.public.resonance.pressure}%` }} /></div>
            <p className="system-response">{RESONANCE_LINES[view.public.resonance.condition]}</p>
          </div>
          </div>
          <div className="reserves">{Object.entries(view.public.sharedResources).map(([key, value]) => <p key={key}><span>{RESOURCE_LABELS[key] ?? key}</span><strong>{value}</strong></p>)}</div>
        </section>
        <section className="panel">
          <h2>Crisis log</h2>
          <div className="crisis-feed">{view.public.crisis.pulses.slice().reverse().map((pulse) => <p key={pulse.id} className={`pulse pulse-${pulse.kind}`}>{pulse.description}</p>)}{view.public.crisis.pulses.length === 0 && <p>No crisis activity recorded.</p>}</div>
        </section>
        {roomCode.toUpperCase().startsWith("LAB") && <section className="panel lab-drills">
          <h2>Lab drills</h2>
          <p className="notice">Controlled crisis injection — laboratory rooms only.</p>
          <div className="drill-buttons">
            <button onClick={() => send({ type: "crisis.inject", effect: "power-drain" })}>Power drain</button>
            <button onClick={() => send({ type: "crisis.inject", effect: "hull-drain" })}>Hull drain</button>
            <button onClick={() => send({ type: "crisis.inject", effect: "resonance-spike" })}>Resonance spike</button>
            <button onClick={() => send({ type: "crisis.inject", effect: "strain-shock" })}>Strain shock</button>
            <button onClick={() => send({ type: "crisis.inject", effect: "targeted-shock" })}>Targeted shock (spares Command)</button>
          </div>
        </section>}
      </aside>
    </section>}
    <p className="notice" aria-live="polite">{notice}</p>
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
