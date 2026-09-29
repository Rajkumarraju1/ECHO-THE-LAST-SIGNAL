import { z } from "zod";

export const roleSchema = z.enum([
  "engineering",
  "navigation",
  "medical",
  "communications",
  "security",
  "science",
  "logistics",
  "command"
]);

export const clientIntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("room.join"),
    roomCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4,8}$/),
    callsign: z.string().trim().min(1).max(16),
    reconnectToken: z.string().min(16).max(256).optional()
  }),
  z.object({ type: z.literal("role.select"), role: roleSchema }),
  z.object({ type: z.literal("match.launch") }),
  z.object({ type: z.literal("move"), roomId: z.string().min(1).max(32), x: z.number().finite(), y: z.number().finite() }),
  z.object({ type: z.literal("evidence.share"), evidenceId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("evidence.annotate"), evidenceId: z.string().min(1).max(64), content: z.string().trim().min(1).max(240) }),
  z.object({ type: z.literal("evidence.link"), sourceEvidenceId: z.string().min(1).max(64), targetEvidenceId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("ping.send"), kind: z.enum(["investigate", "hazard", "assist", "regroup"]), roomId: z.string().min(1).max(32), message: z.string().trim().max(80) }),
  z.object({ type: z.literal("assist.request"), role: roleSchema, message: z.string().trim().max(80) }),
  z.object({ type: z.literal("investigate"), target: z.enum(["signal-array", "power-relay", "signal-origin", "vital-pattern", "echo-pulse-log", "grid-resonance-history"]) }),
  z.object({ type: z.literal("operation.propose"), operationId: z.literal("relay-containment") }),
  z.object({ type: z.literal("operation.confirm"), operationId: z.literal("relay-containment") }),
  z.object({ type: z.literal("procedure.run"), procedureId: z.enum(["reroute-power", "recycle-atmosphere", "patch-hull", "replot-course"]) }),
  z.object({ type: z.literal("rescue.player"), targetPlayerId: z.string().min(1).max(64) }),
  z.object({ type: z.literal("operation.quorum.propose"), operationId: z.literal("grid-isolation") }),
  z.object({ type: z.literal("operation.quorum.confirm"), operationId: z.literal("grid-isolation") }),
  z.object({ type: z.literal("operation.override"), operationId: z.literal("grid-isolation") }),
  z.object({ type: z.literal("emergency.fallback"), role: z.enum(["medical", "engineering", "navigation"]) }),
  z.object({ type: z.literal("crisis.inject"), effect: z.enum(["power-drain", "life-support-drain", "hull-drain", "resonance-spike", "strain-shock", "targeted-shock"]) }),
  z.object({ type: z.literal("deep.listen") }),
  z.object({ type: z.literal("vent.band") }),
  z.object({ type: z.literal("echo.propose"), choice: z.enum(["isolate", "sever", "amplify", "follow"]) }),
  z.object({ type: z.literal("echo.authorize") }),
  z.object({ type: z.literal("echo.decide"), choice: z.enum(["isolate", "sever", "amplify", "follow"]) })
]);

export type ClientIntent = z.infer<typeof clientIntentSchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("match.view"), view: z.unknown() }),
  z.object({ type: z.literal("session.ready"), playerId: z.string(), reconnectToken: z.string() }),
  z.object({ type: z.literal("intent.rejected"), code: z.string(), message: z.string() })
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
