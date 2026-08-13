import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfigFromPaths } from "../src/config.js";

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-hybrid-config-"));
  return {
    globalConfigPath: join(root, "global", "pi-hybrid-memory-config.json"),
    projectConfigPath: join(root, "project", ".pi", "pi-hybrid-memory-config.json"),
  };
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe("unified hybrid-memory config", () => {
  it("scaffolds one complete global config file", () => {
    const paths = fixture();

    const config = loadConfigFromPaths(paths);

    expect(readJson(paths.globalConfigPath)).toMatchObject({
      overrideDefaultCompaction: true,
      debug: false,
      observationThresholdTokens: 1000,
      observerChunkMaxTokens: 60000,
      compactionThresholdTokens: 50000,
      compactionThresholdPercentage: 80,
      maxSummaryTokens: 16000,
    });
    expect(config.hybrid.compactionThresholdTokens).toBe(50000);
  });

  it("preserves existing global values while adding missing defaults", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, {
      observationThresholdTokens: 2222,
      maxFiles: 77,
    });

    const config = loadConfigFromPaths(paths);
    const globalFile = readJson(paths.globalConfigPath);

    expect(config.hybrid.observationThresholdTokens).toBe(2222);
    expect(config.hybrid.maxFiles).toBe(77);
    expect(globalFile).toMatchObject({
      observationThresholdTokens: 2222,
      maxFiles: 77,
      overrideDefaultCompaction: true,
      reflectionThresholdTokens: 30000,
    });
  });

  it("lets sparse project config override global fields individually", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, {
      observationThresholdTokens: 4000,
      maxFiles: 40,
      maxCommits: 12,
    });
    writeJson(paths.projectConfigPath, {
      maxFiles: 90,
    });

    const config = loadConfigFromPaths(paths);

    expect(config.hybrid.observationThresholdTokens).toBe(4000);
    expect(config.hybrid.maxCommits).toBe(12);
    expect(config.hybrid.maxFiles).toBe(90);
    expect(readJson(paths.projectConfigPath)).toEqual({ maxFiles: 90 });
  });

  it("normalizes unsafe observer and percentage values after merging", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, {
      observerChunkMaxTokens: 0,
      compactionThresholdPercentage: 100,
    });

    const config = loadConfigFromPaths(paths);

    expect(config.hybrid.observerChunkMaxTokens).toBe(256);
    expect(config.hybrid.compactionThresholdPercentage).toBeNull();
  });
});
