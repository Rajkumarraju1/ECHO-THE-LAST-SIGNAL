/**
 * StationViewport — React wrapper around the Pixi 2.5D scene.
 *
 * WebGL unavailable → a simplified spatial CSS fallback renders the same
 * shared geometry (layout.ts): raised floor plates, extruded south wall
 * strips, doorway gaps, room labels, prop silhouettes, and grounded crew
 * chips mapped by the same positionToPoint used by the Pixi scene.
 *
 * The live match view is delivered through a ref (setView) so Pixi mode
 * never re-renders React; only fallback mode consumes state changes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DOORS,
  PROPS,
  ROOMS,
  ROLE_COLORS,
  ROLE_GLYPHS,
  SYSTEM_ROOMS,
  WORLD,
  connectingDoor,
  positionToPoint,
  type StationRoomId
} from "./layout";
import { createStationScene, type PlayerMarkerData, type SceneFxSnapshot, type StationSceneHandle } from "./scene";
import type { ClientView } from "../types";

interface ViewportProps {
  view: ClientView;
  playerId: string | null;
  onMove: (roomId: StationRoomId) => void;
}

function extractMarkers(view: ClientView): PlayerMarkerData[] {
  return view.public.players.map((player) => ({
    id: player.id,
    callsign: player.callsign,
    role: player.role,
    roomId: player.position.roomId,
    x: player.position.x,
    y: player.position.y,
    connection: player.connection,
    incapacitated: player.incapacitated
  }));
}

/** Presentation snapshot of authoritative crisis/Echo state — no new rules. */
function buildFxSnapshot(view: ClientView): SceneFxSnapshot {
  const alerts: Record<string, string> = {};
  for (const system of Object.values(view.public.systems)) alerts[system.id] = system.condition;
  const echoEvidenceIds = [...view.private.evidence, ...view.sharedEvidence]
    .filter((evidence) => evidence.origin === "echo-manifestation")
    .map((evidence) => evidence.id);
  return {
    alerts,
    resonance: view.public.resonance,
    isolation: view.public.crisis.isolation,
    pulses: view.public.crisis.pulses.map((pulse) => ({ id: pulse.id, kind: pulse.kind, roomId: pulse.roomId })),
    echoActive: view.scenario.echoDecisionAvailable && !view.scenario.echoDecision,
    echoEvidenceIds
  };
}

function StationFallback({ view, playerId, onMove }: ViewportProps) {
  const me = view.public.players.find((player) => player.id === playerId) ?? null;
  const currentRoom = me?.position.roomId ?? "";
  const players = view.public.players;
  // Spatial state classes mirror the Pixi scene's crisis/Echo treatment.
  const roomAlerts = new Map<string, string>();
  for (const system of Object.values(view.public.systems)) {
    if (system.condition === "critical" || system.condition === "failure" || system.condition === "terminal") {
      const roomId = SYSTEM_ROOMS[system.id];
      if (roomId) roomAlerts.set(roomId, roomAlerts.get(roomId) === "failure" ? "failure" : system.condition);
    }
  }
  const seamActive = view.public.crisis.isolation.reason === "grid-isolation" && (view.public.crisis.isolation.activeUntilMs ?? 0) > Date.now();
  const bandLoud = view.public.resonance.condition === "unstable" || view.public.resonance.condition === "critical";
  const echoActive = view.scenario.echoDecisionAvailable && !view.scenario.echoDecision;
  return (
    <div className={"station-fallback" + (seamActive ? " fb-seam" : "") + (bandLoud ? " fb-band" : "") + (echoActive ? " fb-echo" : "")} style={{ aspectRatio: `${WORLD.w} / ${WORLD.h}` }}>
      <div className="station-fallback-world">
        {(Object.keys(ROOMS) as StationRoomId[]).map((roomId) => {
          const room = ROOMS[roomId];
          const here = players.filter((player) => player.position.roomId === roomId);
          const adjoining = me ? Boolean(connectingDoor(currentRoom as StationRoomId, roomId)) : false;
          const alertClass = roomAlerts.get(roomId) === "failure" ? " fb-alert-failure" : roomAlerts.get(roomId) === "critical" ? " fb-alert-critical" : "";
          return (
            <button
              key={roomId}
              className={
                "fb-room" + (roomId === currentRoom ? " fb-current" : "") + (adjoining ? " fb-adjoining" : "") + alertClass
              }
              style={{ left: room.x, top: room.y, width: room.w, height: room.h, borderColor: room.accent }}
              onClick={() => onMove(roomId)}
              disabled={Boolean(me?.incapacitated)}
            >
              <span className="fb-label">{room.label}</span>
              {here.map((player, index) => {
                const point = positionToPoint(roomId, player.position.x, player.position.y, index, here.length);
                const glyph = ROLE_GLYPHS[player.role ?? ""] ?? "●";
                const stateTag = player.incapacitated ? "! " : player.connection === "reserved" ? "⊘ " : player.connection === "handoff" ? "⋯ " : "";
                return (
                  <span
                    key={player.id}
                    className={"fb-crew" + (player.incapacitated ? " fb-down" : "") + (player.connection !== "connected" ? " fb-faded" : "")}
                    style={{
                      left: point.x - room.x,
                      top: point.y - room.y,
                      color: ROLE_COLORS[player.role ?? ""] ?? "#9db8c3"
                    }}
                    title={`${player.callsign} — ${player.role ?? "no role"}${player.connection !== "connected" ? ` (${player.connection})` : ""}${player.incapacitated ? " (incapacitated)" : ""}`}
                  >
                    {stateTag}
                    {glyph} {player.callsign}
                  </span>
                );
              })}
            </button>
          );
        })}
        {DOORS.map((door, index) => (
          <span
            key={index}
            className="fb-door"
            style={{ left: door.x, top: door.y, width: door.w, height: door.h }}
            aria-hidden
          />
        ))}
        {PROPS.map((prop, index) => (
          <span
            key={index}
            className={"fb-prop fb-prop-" + prop.kind}
            style={{ left: prop.x, top: prop.y, width: prop.w, height: prop.h, background: prop.accent }}
            aria-hidden
          />
        ))}
      </div>
      <p className="notice">Simplified station view (spatial CSS) — same rooms, doors, and crew positions. Click an adjoining room to walk there.</p>
    </div>
  );
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** `?station=css` forces the fallback; otherwise WebGL availability decides. */
function stationRenderer(): "pixi" | "css" {
  try {
    if (new URLSearchParams(window.location.search).get("station") === "css") return "css";
  } catch {
    /* ignore malformed URLs */
  }
  return webglAvailable() ? "pixi" : "css";
}

export function StationViewport({ view, playerId, onMove }: ViewportProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<StationSceneHandle | null>(null);
  const [pixiFailed, setPixiFailed] = useState(false);
  const supportsWebGL = useMemo(() => stationRenderer() === "pixi", []);

  // Live view flows to the scene without React re-renders.
  const latest = useRef({ view, playerId, onMove });
  latest.current = { view, playerId, onMove };

  useEffect(() => {
    if (!supportsWebGL) return;
    let disposed = false;
    let scene: StationSceneHandle | null = null;
    createStationScene(hostRef.current ?? document.createElement("div"), (roomId) => {
      latest.current.onMove(roomId);
    })
      .then((handle) => {
        if (disposed) {
          handle.destroy();
          return;
        }
        scene = handle;
        sceneRef.current = handle;
        const current = latest.current;
        const me = current.view.public.players.find((player) => player.id === current.playerId) ?? null;
        handle.update(extractMarkers(current.view), me?.position.roomId ?? "", buildFxSnapshot(current.view));
      })
      .catch(() => {
        if (!disposed) setPixiFailed(true);
      });
    return () => {
      disposed = true;
      sceneRef.current = null;
      scene?.destroy();
    };
  }, [supportsWebGL]);

  // Refresh scene contents on every revision (skips duplicate views from StrictMode double-effects).
  const lastSynced = useRef<ClientView | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || lastSynced.current === view) return;
    lastSynced.current = view;
    const me = view.public.players.find((player) => player.id === playerId) ?? null;
    scene.update(extractMarkers(view), me?.position.roomId ?? "", buildFxSnapshot(view));
  });

  if (!supportsWebGL || pixiFailed) {
    return <StationFallback view={view} playerId={playerId} onMove={onMove} />;
  }
  return <div className="station-canvas-host" ref={hostRef} aria-label="Station map" />;
}
