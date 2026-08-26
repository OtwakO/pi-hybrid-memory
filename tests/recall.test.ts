import { describe, expect, it, vi } from "vitest";

import { registerRecallTool } from "../src/tools/recall.js";
import { OBSERVATION_CUSTOM_TYPE } from "../src/types.js";
import type { Entry, MemoryDetailsV4, ObservationEntryData, ObservationRecord } from "../src/types.js";

const CURRENT_BASE36_MEMORY_ID = "mr6pp8nr000a";
const HEX_MEMORY_ID = "aaaaaaaaaaaa";
const PI_SOURCE_ENTRY_ID = "6fd67ce7";

const observation = (id: string, sourceEntryIds = [PI_SOURCE_ENTRY_ID]): ObservationRecord => ({
  id,
  content: `observation ${id}`,
  timestamp: "2026-06-27T00:00:00.000Z",
  relevance: "high",
  sourceEntryIds,
});

const rawEntry = (id = PI_SOURCE_ENTRY_ID, content = "source text", role = "user"): Entry => ({
  type: "message",
  id,
  timestamp: "2026-06-27T00:00:00.000Z",
  message: { role, content },
});

const observationEntry = (record: ObservationRecord): Entry => {
  const data: ObservationEntryData = {
    records: [record],
    coversFromId: PI_SOURCE_ENTRY_ID,
    coversUpToId: PI_SOURCE_ENTRY_ID,
    tokenCount: 10,
  };
  return {
    type: "custom",
    id: "observer-entry",
    timestamp: "2026-06-27T00:00:01.000Z",
    customType: OBSERVATION_CUSTOM_TYPE,
    data,
  };
};

const memoryCompactionEntry = (
  reflections: MemoryDetailsV4["reflections"],
  observations: ObservationRecord[] = [],
): Entry => ({
  type: "compaction",
  id: "compaction-entry",
  timestamp: "2026-06-27T00:00:02.000Z",
  summary: "summary",
  details: {
    type: "observational-memory",
    version: 4,
    observations,
    reflections,
  },
});

const reflectionCompactionEntry = (reflectionId: string): Entry =>
  memoryCompactionEntry([{
    id: reflectionId,
    content: `reflection ${reflectionId}`,
    supportingObservationIds: [],
  }]);

const registeredTool = () => {
  const registerTool = vi.fn();
  registerRecallTool({ registerTool } as any);
  expect(registerTool).toHaveBeenCalledOnce();
  return registerTool.mock.calls[0][0];
};

const execute = async (id: string, entries: Entry[]) => {
  const tool = registeredTool();
  return tool.execute(
    "tool-call",
    { id },
    undefined,
    undefined,
    { sessionManager: { getBranch: () => entries } },
  );
};

const resultText = (result: any): string =>
  result.content
    .filter((part: any) => part.type === "text")
    .map((part: any) => part.text)
    .join("\n");

const renderedResultText = (result: any): string => {
  const tool = registeredTool();
  const component = tool.renderResult(result, {}, undefined, undefined);
  return component.render(120).join("\n");
};

describe("hm_recall memory ID compatibility", () => {
  it("briefly explains both memory and source lookup modes to the AI", () => {
    const tool = registeredTool();

    expect(tool.description).toContain("12-character memory id");
    expect(tool.description).toContain("8-character source id");
    expect(tool.promptSnippet).toContain("exact wording, paths, errors, and decisions");
    expect(tool.parameters.properties.id.pattern).toBe("^(?:[a-f0-9]{8}|[a-z0-9]{12})$");
  });

  it("recalls current 12-character base36 observation IDs", async () => {
    const record = observation(CURRENT_BASE36_MEMORY_ID);
    const result = await execute(CURRENT_BASE36_MEMORY_ID, [rawEntry(), observationEntry(record)]);

    expect(result.details.status).toBe("ok");
    expect(result.details.observations[0].id).toBe(CURRENT_BASE36_MEMORY_ID);
    expect(result.details.sourceEntries[0].content).toBe("source text");
    expect(resultText(result)).toContain(`Observation ${CURRENT_BASE36_MEMORY_ID}`);
    expect(resultText(result)).toContain("Sources (bounded chronological previews):");
    expect(resultText(result)).toContain("source text");
    expect(resultText(result)).toContain("Use an 8-character source id with hm_recall to retrieve that exact entry.");
  });

  it("recalls observations that exist only in compaction details", async () => {
    const record = observation(CURRENT_BASE36_MEMORY_ID);
    const result = await execute(CURRENT_BASE36_MEMORY_ID, [
      rawEntry(),
      memoryCompactionEntry([], [record]),
    ]);

    expect(result.details.status).toBe("ok");
    expect(result.details.observations[0].id).toBe(CURRENT_BASE36_MEMORY_ID);
    expect(result.details.sourceEntries[0].content).toBe("source text");
  });

  it("recalls reflection evidence through supporting observations and sources", async () => {
    const reflectionId = "mr6pp8nr000b";
    const record = observation(CURRENT_BASE36_MEMORY_ID);
    const result = await execute(reflectionId, [
      rawEntry(),
      memoryCompactionEntry([{
        id: reflectionId,
        content: `reflection ${reflectionId}`,
        supportingObservationIds: [record.id],
      }], [record]),
    ]);

    expect(result.details.reflections[0].id).toBe(reflectionId);
    expect(result.details.observations[0].id).toBe(record.id);
    expect(result.details.sourceEntries[0].content).toBe("source text");
    expect(resultText(result)).toContain("Supporting observations:");
  });

  it("recalls current 12-character base36 reflection IDs", async () => {
    const reflectionId = "mr6pp8nr000b";
    const result = await execute(reflectionId, [reflectionCompactionEntry(reflectionId)]);

    expect(result.details.status).toBe("ok");
    expect(result.details.reflections[0].id).toBe(reflectionId);
    expect(resultText(result)).toContain(`Reflection ${reflectionId}`);
  });

  it("continues accepting upstream-compatible 12-character hex IDs", async () => {
    const record = observation(HEX_MEMORY_ID);
    const result = await execute(HEX_MEMORY_ID, [rawEntry(), observationEntry(record)]);

    expect(result.details.status).toBe("ok");
    expect(result.details.observations[0].id).toBe(HEX_MEMORY_ID);
  });

  it("shows source excerpts in Pi's custom TUI result renderer", async () => {
    const record = observation(CURRENT_BASE36_MEMORY_ID);
    const result = await execute(CURRENT_BASE36_MEMORY_ID, [rawEntry(), observationEntry(record)]);
    const rendered = renderedResultText(result);

    expect(rendered).toContain("Sources (bounded chronological previews):");
    expect(rendered).toContain("source text");
    expect(rendered).toContain("8-character source id");
  });

  it("returns bounded source text for message, custom-message, and summary entries", async () => {
    const ids = ["source01", "source02", "source03"];
    const record = observation(CURRENT_BASE36_MEMORY_ID, ids);
    const entries: Entry[] = [
      rawEntry(ids[0], [{ type: "text", text: "assistant log" }], "assistant"),
      {
        type: "custom_message",
        id: ids[1],
        timestamp: "2026-06-27T00:00:01.000Z",
        content: "custom log",
      },
      {
        type: "branch_summary",
        id: ids[2],
        timestamp: "2026-06-27T00:00:02.000Z",
        summary: "summary log",
      },
      observationEntry(record),
    ];

    const result = await execute(CURRENT_BASE36_MEMORY_ID, entries);

    expect(result.details.sourceEntries.map((source: any) => source.content)).toEqual([
      "assistant log",
      "custom log",
      "summary log",
    ]);
    expect(resultText(result)).toContain("assistant log");
    expect(resultText(result)).toContain("custom log");
    expect(resultText(result)).toContain("summary log");
  });

  it("bounds each memory source preview to 1,200 characters", async () => {
    const record = observation(CURRENT_BASE36_MEMORY_ID);
    const result = await execute(CURRENT_BASE36_MEMORY_ID, [
      rawEntry(PI_SOURCE_ENTRY_ID, "x".repeat(3_000)),
      observationEntry(record),
    ]);

    const source = result.details.sourceEntries[0];
    expect(source.content.length).toBeLessThanOrEqual(1_200);
    expect(source.contentTruncated).toBe(true);
    expect(source.content).toContain("[truncated]");
  });

  it("spreads the 8,000-character preview budget across early and late sources", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => (index + 1).toString(16).padStart(8, "0"));
    const record = observation(CURRENT_BASE36_MEMORY_ID, ids);
    const entries = [
      ...ids.map((id, index) => rawEntry(id, `entry-${index}:` + "x".repeat(1_990))),
      observationEntry(record),
    ];

    const result = await execute(CURRENT_BASE36_MEMORY_ID, entries);
    const sources = result.details.sourceEntries;
    const includedCharacters = sources.reduce(
      (total: number, source: any) => total + (source.content?.length ?? 0),
      0,
    );

    expect(sources).toHaveLength(10);
    expect(includedCharacters).toBeLessThanOrEqual(8_000);
    expect(sources.every((source: any) => source.content?.length > 0)).toBe(true);
    expect(sources[0].content.length).toBe(sources[9].content.length);
    expect(sources[9].content).toContain("entry-9:");
    expect(sources.every((source: any) => source.contentTruncated)).toBe(true);
  });

  it("redistributes preview budget left over by short sources", async () => {
    const ids = ["00000001", "00000002", "00000003"];
    const record = observation(CURRENT_BASE36_MEMORY_ID, ids);
    const result = await execute(CURRENT_BASE36_MEMORY_ID, [
      rawEntry(ids[0], "short"),
      rawEntry(ids[1], "a".repeat(3_000)),
      rawEntry(ids[2], "b".repeat(3_000)),
      observationEntry(record),
    ]);

    expect(result.details.sourceEntries[0].content).toBe("short");
    expect(result.details.sourceEntries[1].content.length).toBe(1_200);
    expect(result.details.sourceEntries[2].content.length).toBe(1_200);
  });

  it("uses an 8-character Pi id to retrieve the exact source entry", async () => {
    const result = await execute(PI_SOURCE_ENTRY_ID, [rawEntry(PI_SOURCE_ENTRY_ID, "exact original log")]);

    expect(result.details.status).toBe("ok");
    expect(result.details.observations).toEqual([]);
    expect(result.details.sourceEntries[0].id).toBe(PI_SOURCE_ENTRY_ID);
    expect(result.details.sourceEntries[0].content).toBe("exact original log");
    expect(resultText(result)).toContain(`Source entry ${PI_SOURCE_ENTRY_ID}:`);
    expect(resultText(result)).toContain("exact original log");
  });

  it("applies a safety cap to direct source lookup", async () => {
    const result = await execute(PI_SOURCE_ENTRY_ID, [rawEntry(PI_SOURCE_ENTRY_ID, "x".repeat(25_000))]);

    const source = result.details.sourceEntries[0];
    expect(source.content.length).toBeLessThanOrEqual(20_000);
    expect(source.contentTruncated).toBe(true);
  });

  it("reports a valid but unavailable 8-character source id", async () => {
    const result = await execute(PI_SOURCE_ENTRY_ID, []);

    expect(result.details.status).toBe("source_unavailable");
    expect(resultText(result)).toContain("not available on the current branch");
  });

  it("rejects ids outside both supported namespaces", async () => {
    const result = await execute("not-an-id", [rawEntry()]);

    expect(result.details.status).toBe("invalid_id");
    expect(resultText(result)).toContain("12-character memory id or 8-character source id");
  });
});
