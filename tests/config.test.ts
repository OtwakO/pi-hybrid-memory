import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const load = (
  paths: ReturnType<typeof fixture>,
  options: { projectTrusted?: boolean; notify?: (message: string, level?: "info" | "warning" | "error") => void } = {},
) => loadConfigFromPaths(paths, {
  projectTrusted: options.projectTrusted ?? true,
  notify: options.notify,
});

describe("unified hybrid-memory config", () => {
  it("scaffolds one complete global config file", () => {
    const paths = fixture();

    const config = load(paths);

    expect(readJson(paths.globalConfigPath)).toMatchObject({
      overrideDefaultCompaction: true,
      debug: false,
      observationThresholdTokens: 1000,
      observerChunkMaxTokens: 60000,
      observerEpochMaxTokens: 96000,
      compactionThresholdTokens: 50000,
      compactionThresholdPercentage: 80,
      maxSummaryTokens: 16000,
    });
    expect(config.hybrid.compactionThresholdTokens).toBe(50000);
  });

  it("preserves existing global values and unknown fields while adding missing defaults", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, {
      observationThresholdTokens: 2222,
      maxFiles: 77,
      futureSetting: "preserve-me",
    });

    const config = load(paths);
    const globalFile = readJson(paths.globalConfigPath);

    expect(config.hybrid.observationThresholdTokens).toBe(2222);
    expect(config.hybrid.maxFiles).toBe(77);
    expect(globalFile).toMatchObject({
      observationThresholdTokens: 2222,
      maxFiles: 77,
      futureSetting: "preserve-me",
      overrideDefaultCompaction: true,
      reflectionThresholdTokens: 30000,
    });
  });

  it("lets trusted sparse project config override global fields individually", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, {
      observationThresholdTokens: 4000,
      maxFiles: 40,
      maxCommits: 12,
    });
    writeJson(paths.projectConfigPath, {
      maxFiles: 90,
    });

    const config = load(paths, { projectTrusted: true });

    expect(config.hybrid.observationThresholdTokens).toBe(4000);
    expect(config.hybrid.maxCommits).toBe(12);
    expect(config.hybrid.maxFiles).toBe(90);
    expect(readJson(paths.projectConfigPath)).toEqual({ maxFiles: 90 });
  });

  it("does not read project config when the project is untrusted", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, { maxFiles: 44 });
    writeJson(paths.projectConfigPath, { maxFiles: 999 });
    const notifications: string[] = [];

    const config = load(paths, {
      projectTrusted: false,
      notify: message => notifications.push(message),
    });

    expect(config.hybrid.maxFiles).toBe(44);
    expect(notifications).toContain(
      "pi-hybrid-memory: ignored project configuration because the project is not trusted.",
    );
  });

  it("preserves malformed global JSON and uses defaults without rewriting it", () => {
    const paths = fixture();
    mkdirSync(dirname(paths.globalConfigPath), { recursive: true });
    const malformed = "{ invalid json\n";
    writeFileSync(paths.globalConfigPath, malformed);
    const notifications: Array<{ message: string; level?: string }> = [];

    const config = load(paths, {
      notify: (message, level) => notifications.push({ message, level }),
    });

    expect(readFileSync(paths.globalConfigPath, "utf8")).toBe(malformed);
    expect(config.hybrid.maxFiles).toBe(40);
    expect(notifications.some(({ message, level }) =>
      level === "error" && message.includes("could not parse global configuration"))).toBe(true);
  });

  it("preserves unreadable global input and uses defaults without replacing it", () => {
    const paths = fixture();
    mkdirSync(paths.globalConfigPath, { recursive: true });
    const notifications: Array<{ message: string; level?: string }> = [];

    const config = load(paths, {
      notify: (message, level) => notifications.push({ message, level }),
    });

    expect(config.hybrid.maxFiles).toBe(40);
    expect(notifications.some(({ message, level }) =>
      level === "error" && message.includes("could not read global configuration"))).toBe(true);
  });

  it("rejects invalid known fields individually while preserving valid fields and the file", () => {
    const paths = fixture();
    const original = {
      debug: "yes",
      observationThresholdTokens: -5,
      observerChunkMaxTokens: 0,
      observerEpochMaxTokens: -1,
      compactionThresholdPercentage: 100,
      compactionModel: { provider: " ", id: "model" },
      maxFiles: 77,
    };
    writeJson(paths.globalConfigPath, original);
    const before = readFileSync(paths.globalConfigPath, "utf8");
    const notifications: string[] = [];

    const config = load(paths, { notify: message => notifications.push(message) });

    expect(config.extension.debug).toBe(false);
    expect(config.hybrid.observationThresholdTokens).toBe(1000);
    expect(config.hybrid.observerChunkMaxTokens).toBe(60000);
    expect(config.hybrid.observerEpochMaxTokens).toBe(96000);
    expect(config.hybrid.compactionThresholdPercentage).toBe(80);
    expect(config.hybrid.compactionModel).toBeNull();
    expect(config.hybrid.maxFiles).toBe(77);
    expect(readFileSync(paths.globalConfigPath, "utf8")).toBe(before);
    expect(notifications.some(message => message.includes("invalid global setting debug"))).toBe(true);
    expect(notifications.some(message => message.includes("invalid global setting compactionModel"))).toBe(true);
  });

  it("ignores malformed trusted project config without changing the valid global config", () => {
    const paths = fixture();
    writeJson(paths.globalConfigPath, { maxFiles: 55 });
    mkdirSync(dirname(paths.projectConfigPath), { recursive: true });
    const malformed = "[not an object]";
    writeFileSync(paths.projectConfigPath, malformed);
    const notifications: string[] = [];

    const config = load(paths, {
      projectTrusted: true,
      notify: message => notifications.push(message),
    });

    expect(config.hybrid.maxFiles).toBe(55);
    expect(readFileSync(paths.projectConfigPath, "utf8")).toBe(malformed);
    expect(notifications.some(message => message.includes("could not parse project configuration"))).toBe(true);
  });
});
