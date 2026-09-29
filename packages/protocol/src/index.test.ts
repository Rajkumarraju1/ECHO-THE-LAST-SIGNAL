import { describe, expect, it } from "vitest";
import { clientIntentSchema } from "./index.js";

describe("client intent protocol", () => {
  it("rejects malformed room and movement requests before they reach game rules", () => {
    expect(clientIntentSchema.safeParse({ type: "room.join", roomCode: "bad room", callsign: "Aster" }).success).toBe(false);
    expect(clientIntentSchema.safeParse({ type: "move", roomId: "command", x: Number.POSITIVE_INFINITY, y: 0 }).success).toBe(false);
  });
});
