import type { CacheOperation } from "./cache-telemetry.js";

const CACHE_NAMESPACE = "pi-hybrid-memory";

export interface CacheOptions {
  sessionId: string;
  cacheRetention: "long";
}

export const operationCacheOptions = (
  piSessionId: string,
  operation: CacheOperation,
): CacheOptions => ({
  sessionId: `${CACHE_NAMESPACE}:${piSessionId}:${operation}`,
  cacheRetention: "long",
});
