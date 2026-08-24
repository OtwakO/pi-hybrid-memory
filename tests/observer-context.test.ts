import { describe, expect, it } from "vitest";

import { OBSERVER_FIXED_TOKEN_RESERVE } from "../src/om/observer-context.js";

// This is a deliberately conservative allowance for observer output, tool schemas,
// provider framing, and continuation overhead. Changing it affects both proactive
// observation and compaction catch-up capacity calculations.
describe("observer context reservation", () => {
  it("keeps one shared conservative reservation", () => {
    expect(OBSERVER_FIXED_TOKEN_RESERVE).toBe(6_144);
  });
});
