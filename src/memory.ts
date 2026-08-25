// /hm-memory command: browse observations, reflections, and VCC compactions
// Flow: category picker → chronological list → detail view → back
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.js";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Entry, ObservationRecord, MemoryReflection, ReflectionRecord } from "./types.js";
import { OBSERVATION_CUSTOM_TYPE } from "./types.js";
import { getMemoryState } from "./om/branch.js";
import { reflectionContent, renderSummary, deriveCoverageTags, type ObservationCoverageTag } from "./om/compaction.js";
import { estimateStringTokens } from "./om/tokens.js";
import {
  buildMemoryMetrics,
  buildMemoryPickerOptions,
  describeContextSummary,
  describeReflectionGate,
  type ReflectionGateStatus,
} from "./memory-metrics.js";

const MOUSE_ON = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const OVERLAY_OPTS = { width: "92%" as const, maxHeight: "92%" as const, anchor: "center" as const };
const MIN_VIEWPORT = 8;

type Screen = "picker" | "list" | "detail" | "contextFormat";
type Category = "observations" | "reflections" | "compactions";

interface MemoryItem {
  label: string;
  detail: string;
  timestamp: string;
  relevance: string;
  tokenCount: number;
  coverage: string;
}

const pad2 = (n: number): string => n.toString().padStart(2, "0");

function fmtTs(v: string | undefined): string {
  if (!v) return "??:??";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "??:??" : `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtFullTs(v: string | undefined): string {
  if (!v) return "unknown";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "unknown" : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

function parseMouse(data: string): { button: number; type: "press" | "release" }[] {
  const out: { button: number; type: "press" | "release" }[] = [];
  SGR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR_RE.exec(data)) !== null) out.push({ button: +m[1]!, type: m[4] === "M" ? "press" : "release" });
  return out;
}


const isObservationEntry = (e: Entry): boolean => e.type === "custom" && e.customType === OBSERVATION_CUSTOM_TYPE;
const isObsData = (v: unknown): v is { records: ObservationRecord[] } =>
  !!v && typeof v === "object" && "records" in v && Array.isArray((v as Record<string, unknown>).records);

function collectObservations(entries: Entry[]): ObservationRecord[] {
  const all: ObservationRecord[] = [];
  for (const e of entries) if (isObservationEntry(e) && isObsData(e.data)) all.push(...e.data.records);
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}

function collectCompactions(entries: Entry[]): Entry[] {
  return entries.filter(e => e.type === "compaction");
}

// ═══════════════════════════════════════════════════════════════════════
// MemoryOverlay
// ═══════════════════════════════════════════════════════════════════════

class MemoryOverlay {
  private screen: Screen = "picker";
  private category: Category = "observations";
  private items: MemoryItem[] = [];

  private pickerSel = 0;
  private listSel = 0;
  private listOffset = 0;
  private detailOffset = 0;
  private detailTotalLines = 0;
  private ctxOffset = 0;
  private vpHeight = 10;

  private allObs: ObservationRecord[] = [];
  private allRef: MemoryReflection[] = [];
  private allComp: Entry[] = [];
  private compTexts: string[] = [];
  private contextSummary = "";
  private contextStatus = describeContextSummary(undefined);
  private reflectionGate: ReflectionGateStatus | null = null;
  private coverageTags: Map<string, ObservationCoverageTag> = new Map();

  constructor(
    private theme: any,
    private done: () => void,
  ) {}

  loadData(
    obs: ObservationRecord[],
    refs: MemoryReflection[],
    comp: Entry[],
    contextSummary: string,
    coverageTags: Map<string, ObservationCoverageTag>,
    reflectionGate: ReflectionGateStatus,
  ) {
    this.allObs = obs;
    this.allRef = refs;
    this.allComp = comp;
    this.compTexts = comp.map(c => typeof c.summary === "string" ? c.summary : "(empty)");
    this.contextSummary = contextSummary;
    this.contextStatus = describeContextSummary(comp.at(-1));
    this.reflectionGate = reflectionGate;
    this.coverageTags = coverageTags;
  }

  private buildItems(cat: Category): MemoryItem[] {
    if (cat === "observations") {
      return this.allObs.map(o => {
        const tok = estimateStringTokens(o.content);
        const cov = this.coverageTags.get(o.id) ?? "uncited";
        return { label: o.content, timestamp: o.timestamp, relevance: o.relevance, tokenCount: tok, coverage: cov, detail: [
          `ID: ${o.id}`, `Relevance: ${o.relevance}`, `Coverage: ${cov}`, `Time: ${fmtFullTs(o.timestamp)}`, `Tokens: ~${tok}`, "", o.content,
        ].join("\n") };
      });
    }
    if (cat === "reflections") {
      return this.allRef.map(r => {
        const c = reflectionContent(r);
        const tok = estimateStringTokens(c);
        const id = typeof r === "string" ? "n/a" : (r as ReflectionRecord).id;
        const ids = typeof r === "string" ? [] : r.supportingObservationIds;
        return { label: c, timestamp: "n/a", relevance: "", tokenCount: tok, coverage: "", detail: [
          `ID: ${id}`, "", c,
          ...(ids.length > 0 ? ["", "Supporting observations:", ...ids.map(i => `  • ${i}`)] : []),
        ].join("\n") };
      });
    }
    return this.allComp.map((c, i) => {
      const s = typeof c.summary === "string" ? c.summary : "(no summary)";
      const tok = estimateStringTokens(s);
      const fk = c.firstKeptEntryId || "unknown";
      const fl = s.split("\n").find(l => l.trim()) || "(empty)";
      return { label: fl, timestamp: c.timestamp || "n/a", relevance: "", tokenCount: tok, coverage: "", detail: [
        `Compaction #${i + 1}`, `firstKeptEntryId: ${fk}`, "", s,
      ].join("\n") };
    });
  }

  private row(th: any, c: string, innerW: number): string {
    return th.fg("border", "│") + c + " ".repeat(Math.max(0, innerW - visibleWidth(c))) + th.fg("border", "│");
  }

  // ── Input ─────────────────────────────────────────────────────────

  handleInput(data: string): void {
    this.handleMouse(data);
    if (this.screen === "picker") return this.handlePicker(data);
    if (this.screen === "list") return this.handleList(data);
    if (this.screen === "detail") return this.handleDetail(data);
    if (this.screen === "contextFormat") return this.handleContextFormat(data);
  }

  private handlePicker(data: string): void {
    const opts = this.pickerOptions();
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(); return; }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("m"))) {
      const opt = opts[clamp(this.pickerSel, 0, opts.length - 1)];
      if (opt.cat === "") {
        this.openContextFormat();
      } else {
        this.category = opt.cat as Category;
        this.items = this.buildItems(this.category);
        this.listSel = 0; this.listOffset = 0;
        this.screen = "list";
      }
      return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) this.pickerSel = Math.max(0, this.pickerSel - 1);
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) this.pickerSel = Math.min(opts.length - 1, this.pickerSel + 1);
  }

  private handleList(data: string): void {
    const n = this.items.length;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.screen = "picker"; return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) this.listSel = Math.max(0, this.listSel - 1);
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) this.listSel = Math.min(n - 1, this.listSel + 1);
    if (matchesKey(data, Key.pageUp)) this.listSel = Math.max(0, this.listSel - 10);
    if (matchesKey(data, Key.pageDown)) this.listSel = Math.min(n - 1, this.listSel + 10);
    if (matchesKey(data, Key.left)) this.listSel = Math.max(0, this.listSel - 50);
    if (matchesKey(data, Key.right)) this.listSel = Math.min(n - 1, this.listSel + 50);
    if (matchesKey(data, Key.home)) this.listSel = 0;
    if (matchesKey(data, Key.end)) this.listSel = n - 1;
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("m")) && n > 0) { this.openDetail(this.listSel); return; }
  }

  private handleDetail(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("m"))) { this.screen = "list"; return; }
    if (matchesKey(data, Key.up)) this.detailOffset = Math.max(0, this.detailOffset - 1);
    if (matchesKey(data, Key.down)) this.detailOffset++;
    if (matchesKey(data, Key.pageUp)) this.detailOffset = Math.max(0, this.detailOffset - 10);
    if (matchesKey(data, Key.pageDown)) this.detailOffset += 10;
    if (matchesKey(data, Key.left)) this.detailOffset = Math.max(0, this.detailOffset - 50);
    if (matchesKey(data, Key.right)) this.detailOffset += 50;
    if (matchesKey(data, Key.home)) this.detailOffset = 0;
  }

  private handleMouse(data: string): void {
    for (const e of parseMouse(data)) {
      if (e.type !== "press") continue;
      if (e.button === 64) { // wheel up
        if (this.screen === "list") this.listSel = Math.max(0, this.listSel - 3);
        else if (this.screen === "detail") this.detailOffset = Math.max(0, this.detailOffset - 3);
        else if (this.screen === "contextFormat") this.ctxOffset = Math.max(0, this.ctxOffset - 3);
        else this.pickerSel = Math.max(0, this.pickerSel - 1);
      } else if (e.button === 65) { // wheel down
        const n = this.items.length;
        if (this.screen === "list") this.listSel = Math.min(n - 1, this.listSel + 3);
        else if (this.screen === "detail") this.detailOffset++;
        else if (this.screen === "contextFormat") this.ctxOffset++;
      }
    }
  }

  private openDetail(idx: number) {
    if (idx < 0 || idx >= this.items.length) return;
    this.detailOffset = 0;
    this.detailTotalLines = this.items[idx].detail.split("\n").length;
    this.screen = "detail";
  }

  private openContextFormat() {
    this.ctxOffset = 0;
    this.screen = "contextFormat";
  }

  private pickerOptions(): Array<{ label: string; detail: string; cat: Category | "" }> {
    if (!this.reflectionGate) return [];
    return buildMemoryPickerOptions({
      observations: this.allObs,
      reflections: this.allRef,
      compactionSummaries: this.compTexts,
      contextStatus: this.contextStatus,
      reflectionGate: this.reflectionGate,
    }).map(option => ({
      label: option.label,
      detail: option.detail,
      cat: option.category === "context" ? "" : option.category,
    }));
  }

  // ── Render ────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.screen === "picker") return this.renderPicker(width);
    if (this.screen === "list") return this.renderList(width);
    if (this.screen === "detail") return this.renderDetail(width);
    if (this.screen === "contextFormat") return this.renderContextFormat(width);
    return [];
  }

  private renderPicker(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const opts = this.pickerOptions();
    const lines: string[] = [];
    const row = (c: string) => this.row(th, c, innerW);

    lines.push(th.fg("accent", `╭${"─".repeat(innerW)}╮`));

    const title = th.fg("accent", th.bold("💾 Hybrid Memory"));
    const gap = Math.max(0, innerW - 1 - visibleWidth(title));
    lines.push(row(" " + title + " ".repeat(gap)));

    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    for (let i = 0; i < opts.length; i++) {
      const o = opts[i];
      const sel = i === this.pickerSel;
      const arrow = sel ? th.fg("accent", "▸ ") : "  ";
      const label = sel ? th.fg("accent", th.bold(o.label)) : th.fg("text", o.label);
      const info = th.fg("dim", o.detail);
      const g = Math.max(0, innerW - 1 - visibleWidth(arrow) - visibleWidth(label) - visibleWidth(info));
      lines.push(row(" " + arrow + label + " ".repeat(g) + info));
    }

    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    const esc = th.fg("error", "[Esc]") + " " + th.fg("text", "Close");
    const enter = th.fg("accent", "[Enter]") + " " + th.fg("text", "Select");
    const nav = th.fg("muted", "↑↓:navigate    ");
    const right = nav + enter + "    " + esc;
    const g = Math.max(0, innerW - 1 - visibleWidth(right));
    lines.push(row(" " + " ".repeat(g) + right));

    lines.push(th.fg("accent", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  private renderList(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const contentW = innerW - 1; // 1-char gutter
    const n = this.items.length;
    const sel = clamp(this.listSel, 0, Math.max(0, n - 1));
    const lines: string[] = [];
    const row = (c: string) => this.row(th, c, innerW);

    // Viewport height: 92% of terminal minus chrome lines
    const rows = process.stdout.rows || 40;
    const chrome = this.category === "observations" ? 7 : 6; // +1 for coverage legend
    this.vpHeight = Math.max(MIN_VIEWPORT, Math.floor(rows * 0.92) - chrome);

    // Header
    lines.push(th.fg("accent", `╭${"─".repeat(innerW)}╮`));
    const catLabel = this.category === "observations" ? "Observations" : this.category === "reflections" ? "Reflections" : "VCC Compactions";
    const title = th.fg("accent", th.bold(` ${catLabel} `));
    const info = th.fg("dim", "│ ") + th.fg("text", `${n} entries`) + th.fg("dim", "  │  ") + th.fg("text", `~${this.items.reduce((s, i) => s + i.tokenCount, 0).toLocaleString()} tokens`);
    const hGap = Math.max(0, innerW - 1 - visibleWidth(title) - visibleWidth(info));
    lines.push(row(" " + title + " ".repeat(hGap) + info));
    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    // Scroll
    if (sel < this.listOffset) this.listOffset = sel;
    if (sel >= this.listOffset + this.vpHeight) this.listOffset = sel - this.vpHeight + 1;

    const relevanceTag = (r: string, cov: string): string => {
      const base = (() => {
        switch (r) {
          case "critical": return th.fg("error", "[crit]");
          case "high": return th.fg("warning", "[high]");
          case "medium": return th.fg("text", "[med] ");
          default: return th.fg("dim", "[low] ");
        }
      })();
      if (cov === "uncited") return base + " " + th.fg("dim", "○");
      if (cov === "cited") return base + " " + th.fg("success", "●");
      if (cov === "reinforced") return base + " " + th.fg("warning", "◆");
      return base;
    };

    // Content
    if (n === 0) {
      const msg = th.fg("dim", "  No entries yet.");
      const g = Math.max(0, innerW - 1 - visibleWidth(msg));
      lines.push(row(" " + msg + " ".repeat(g)));
      for (let i = 0; i < this.vpHeight - 1; i++) lines.push(row(""));
    } else {
      for (let i = this.listOffset; i < Math.min(this.listOffset + this.vpHeight, n); i++) {
      const item = this.items[i];
      const gutter = i === sel ? th.fg("accent", "▸") : " ";

      const tag = relevanceTag(item.relevance, item.coverage);
      const time = th.fg("dim", fmtTs(item.timestamp));
      const left = gutter + " " + tag + " " + time + " ";
      const leftW = visibleWidth(left);

      const right = th.fg("dim", `~${item.tokenCount.toLocaleString()}tok`);
      const rightW = visibleWidth(right);

      // Label fills remaining space, right is always right-aligned
      const labelMax = Math.max(5, contentW - leftW - rightW - 1);
      const label = i === sel
        ? th.fg("accent", th.bold(truncateToWidth(item.label, labelMax)))
        : truncateToWidth(item.label, labelMax);

      const pad = Math.max(0, contentW - leftW - visibleWidth(label) - rightW);
        lines.push(row(left + label + " ".repeat(pad) + right));
      }
      for (let i = 0; i < this.vpHeight - Math.min(this.vpHeight, n - this.listOffset); i++) {
        lines.push(row(""));
      }
    }

    // Separator
    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    // Coverage legend (observations page only)
    if (this.category === "observations") {
      const legend = th.fg("dim", "○") + th.fg("muted", " uncited  ") + th.fg("success", "●") + th.fg("muted", " cited  ") + th.fg("warning", "◆") + th.fg("muted", " reinforced");
      const lg = Math.max(0, innerW - 1 - visibleWidth(legend));
      lines.push(row(" " + " ".repeat(lg) + legend));
    }

    // Footer
    const esc = th.fg("error", "[Esc]") + " " + th.fg("text", "Back");
    const enter = th.fg("accent", "[Enter]") + " " + th.fg("text", "Details");
    const pct = n > 0 ? Math.round(((sel + 1) / n) * 100) : 0;
    const infoLeft = th.fg("dim", ` ${sel + 1}/${n}  (${pct}%)`);
    const actions = th.fg("muted", "↑↓/🖱 PgUp/PgDn    ");
    const right = actions + enter + "    " + esc;
    const fGap = Math.max(0, innerW - 1 - visibleWidth(infoLeft) - visibleWidth(right));
    lines.push(row(" " + infoLeft + " ".repeat(fGap) + right));

    lines.push(th.fg("accent", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  private renderDetail(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const contentW = innerW - 1;
    const lines: string[] = [];
    const row = (c: string) => this.row(th, c, innerW);

    const item = this.items[clamp(this.listSel, 0, Math.max(0, this.items.length - 1))];
    if (!item) return this.renderList(width);

    const rows = process.stdout.rows || 40;
    this.vpHeight = Math.max(MIN_VIEWPORT, Math.floor(rows * 0.92) - 6);

    // Header
    lines.push(th.fg("accent", `╭${"─".repeat(innerW)}╮`));
    const catLabel = this.category === "observations" ? "Observation" : this.category === "reflections" ? "Reflection" : "Compaction";
    const title = th.fg("accent", th.bold(` ${catLabel} `));
    const info = th.fg("dim", "│ ") + th.fg("text", `~${item.tokenCount.toLocaleString()} tokens`);
    const hGap = Math.max(0, innerW - 1 - visibleWidth(title) - visibleWidth(info));
    lines.push(row(" " + title + " ".repeat(hGap) + info));
    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    // Content — flatten all wrapped lines into a single visual array
    const textLines = item.detail.split("\n");
    const allVisual: string[] = [];
    for (const tl of textLines) allVisual.push(...this.wrapLine(tl, contentW));
    this.detailTotalLines = allVisual.length;
    this.detailOffset = clamp(this.detailOffset, 0, Math.max(0, this.detailTotalLines - this.vpHeight));

    for (let i = this.detailOffset; i < Math.min(this.detailOffset + this.vpHeight, this.detailTotalLines); i++) {
      lines.push(row(" " + (allVisual[i] ?? "")));
    }
    for (let i = 0; i < this.vpHeight - Math.min(this.vpHeight, this.detailTotalLines - this.detailOffset); i++) {
      lines.push(row(""));
    }

    // Separator
    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    // Footer
    const esc = th.fg("error", "[Esc]") + " " + th.fg("text", "Back");
    if (this.detailTotalLines > this.vpHeight) {
      const pct = Math.round((Math.min(this.detailOffset + this.vpHeight, this.detailTotalLines) / this.detailTotalLines) * 100);
      const info = th.fg("dim", ` L${this.detailOffset + 1}–${Math.min(this.detailOffset + this.vpHeight, this.detailTotalLines)}/${this.detailTotalLines} (${pct}%)`);
      const scroll = th.fg("muted", "↑↓/🖱 PgUp/PgDn    ");
      const right = scroll + esc;
      const g = Math.max(0, innerW - 1 - visibleWidth(info) - visibleWidth(right));
      lines.push(row(" " + info + " ".repeat(g) + right));
    } else {
      const g = Math.max(0, innerW - 1 - visibleWidth(esc));
      lines.push(row(" ".repeat(g) + esc));
    }

    lines.push(th.fg("accent", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  private renderContextFormat(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const contentW = innerW - 1;
    const lines: string[] = [];
    const row = (c: string) => this.row(th, c, innerW);

    const rows = process.stdout.rows || 40;
    const vpH = Math.max(MIN_VIEWPORT, Math.floor(rows * 0.92) - 6);

    lines.push(th.fg("accent", `╭${"─".repeat(innerW)}╮`));
    const title = th.fg("accent", th.bold(" Current Context Summary "));
    const tokenStr = this.contextStatus.label;
    const info = th.fg("dim", "│ ") + th.fg("text", tokenStr);
    const hGap = Math.max(0, innerW - 1 - visibleWidth(title) - visibleWidth(info));
    lines.push(row(" " + title + " ".repeat(hGap) + info));
    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    const text = this.contextSummary;
    const textLines = text.split("\n");
    const allVisual: string[] = [];
    for (const tl of textLines) allVisual.push(...this.wrapLine(tl, contentW));
    const total = allVisual.length;

    // Scroll: clamp offset within content bounds
    if (this.ctxOffset < 0) this.ctxOffset = 0;
    if (this.ctxOffset > total - vpH && total > vpH) this.ctxOffset = total - vpH;
    const start = Math.max(0, this.ctxOffset);

    for (let i = start; i < Math.min(start + vpH, total); i++) {
      lines.push(row(" " + (allVisual[i] ?? "")));
    }
    for (let i = 0; i < vpH - Math.min(vpH, total - start); i++) lines.push(row(""));

    lines.push(row(th.fg("dim", "─".repeat(innerW))));

    // Footer
    const esc = th.fg("error", "[Esc]") + " " + th.fg("text", "Back");
    if (total > vpH) {
      const pct = total > 0 ? Math.round((Math.min(start + vpH, total) / total) * 100) : 0;
      const info = th.fg("dim", ` L${start + 1}–${Math.min(start + vpH, total)}/${total} (${pct}%)`);
      const scroll = th.fg("muted", "↑↓:scroll  PgUp/PgDn  Home/End    ");
      const right = scroll + esc;
      const g = Math.max(0, innerW - 1 - visibleWidth(info) - visibleWidth(right));
      lines.push(row(" " + info + " ".repeat(g) + right));
    } else {
      const g = Math.max(0, innerW - 1 - visibleWidth(esc));
      lines.push(row(" ".repeat(g) + esc));
    }

    lines.push(th.fg("accent", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  private handleContextFormat(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.screen = "picker"; return;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) { this.ctxOffset = Math.max(0, this.ctxOffset - 1); return; }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) { this.ctxOffset++; return; }
    if (matchesKey(data, Key.pageUp)) { this.ctxOffset = Math.max(0, this.ctxOffset - 10); return; }
    if (matchesKey(data, Key.pageDown)) { this.ctxOffset += 10; return; }
    if (matchesKey(data, Key.left)) { this.ctxOffset = Math.max(0, this.ctxOffset - 50); return; }
    if (matchesKey(data, Key.right)) { this.ctxOffset += 50; return; }
    if (matchesKey(data, Key.home)) { this.ctxOffset = 0; return; }
    if (matchesKey(data, Key.end)) { this.ctxOffset = Number.MAX_SAFE_INTEGER; return; }
  }

  private wrapCache = new Map<string, string[]>();
  private wrapLine(text: string, w: number): string[] {
    const key = `${w}:${text}`;
    if (this.wrapCache.has(key)) return this.wrapCache.get(key)!;
    const out: string[] = [];
    for (const line of text.split("\n")) {
      if (line.length <= w) { out.push(line); continue; }
      // Word-wrap: split on spaces, fill lines up to w
      const words = line.split(/\s+/);
      let cur = "";
      for (const word of words) {
        if (word.length > w) {
          // Word longer than line — push current, then break word
          if (cur) { out.push(cur); cur = ""; }
          for (let s = 0; s < word.length; s += w) out.push(word.slice(s, s + w));
        } else if (cur && cur.length + 1 + word.length > w) {
          out.push(cur); cur = word;
        } else if (cur) {
          cur += " " + word;
        } else {
          cur = word;
        }
      }
      if (cur) out.push(cur);
    }
    this.wrapCache.set(key, out);
    return out;
  }

  invalidate(): void { this.wrapCache.clear(); }
}

// ═══════════════════════════════════════════════════════════════════════
// Register command
// ═══════════════════════════════════════════════════════════════════════

export function registerMemoryCommand(pi: ExtensionAPI, runtime: Runtime): void {
  pi.registerCommand("hm-memory", {
    description: "Browse observations, reflections, and VCC compactions",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("hm-memory requires interactive mode", "warning"); return; }

      runtime.ensureConfig(ctx.cwd);
      const entries = ctx.sessionManager.getBranch() as Entry[];
      const memoryState = getMemoryState(entries);
      const obs = collectObservations(entries);
      const refs = memoryState.reflections;
      const comp = collectCompactions(entries);

      // Build OM context summary using the exact renderSummary that compaction uses
      const allObservations = [...memoryState.committedObs, ...memoryState.pendingObs];
      const coverageTags = deriveCoverageTags(refs, allObservations);
      const reflectionGate = describeReflectionGate(
        buildMemoryMetrics(memoryState),
        runtime.config.hybrid.reflectionThresholdTokens,
      );

      let contextSummary = "";
      const lastComp = comp.length > 0 ? comp[comp.length - 1] : null;

      // Show what's already in context from last compaction
      if (lastComp && typeof lastComp.summary === "string" && lastComp.summary.trim()) {
        contextSummary = "═══ Already in context (from last compaction) ═══\n\n" + lastComp.summary;
      } else {
        contextSummary = "(No compaction has run yet — the raw conversation is still in context.)\n";
      }

      // Show pending observations/reflections that will be merged next compaction
      const pendingContent = renderSummary(refs, memoryState.pendingObs);
      const committedOM = renderSummary(refs, memoryState.committedObs);
      if (pendingContent.trim() || committedOM.trim()) {
        contextSummary += "\n\n═══ Will be injected on next compaction ═══\n\n";
        if (committedOM.trim()) {
          contextSummary += "## Memory (currently built)\n\n" + committedOM;
          if (pendingContent.trim()) contextSummary += "\n";
        }
        if (pendingContent.trim()) {
          contextSummary += "## Memory (pending — new observations since last merge)\n\n" + pendingContent;
        }
        contextSummary += "\n\n## Session State (VCC — generated at compaction time)\n(Will be merged with OM layer during next compaction)";
      }

      process.stdout.write(MOUSE_ON);
      try {
        await ctx.ui.custom<"close">((tui: any, theme: any, _kb: any, done: (a: "close") => void) => {
          const overlay = new MemoryOverlay(theme, () => done("close"));
          overlay.loadData(obs, refs, comp, contextSummary, coverageTags, reflectionGate);
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (d: string) => { overlay.handleInput(d); tui.requestRender(); },
          };
        }, { overlay: true, overlayOptions: OVERLAY_OPTS });
      } finally {
        process.stdout.write(MOUSE_OFF);
      }
    },
  });
}
