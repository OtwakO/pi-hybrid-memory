import { describe, expect, it } from "vitest";

import { operationCacheOptions } from "../src/cache-options.js";

describe("operationCacheOptions", () => {
  it("uses stable, isolated identities and long retention", () => {
    expect(operationCacheOptions("session-123", "observer")).toEqual({
      sessionId: "pi-hybrid-memory:session-123:observer",
      cacheRetention: "long",
    });
    expect(operationCacheOptions("session-123", "reflector")).toEqual({
      sessionId: "pi-hybrid-memory:session-123:reflector",
      cacheRetention: "long",
    });
  });
});
