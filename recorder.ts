/**
 * Repair event recorder — JSONL persistence, aggregation, and blindspot analysis.
 *
 * Pure module (no pi extension API dependency). Designed for testability.
 *
 * Data layout:
 *   .pi/repair-log/<sessionId>.jsonl     ← append-only events
 *   .pi/repair-log/<sessionId>.meta.json ← session metadata (reusable)
 *
 * DuckDB-compatible: each JSONL line is a self-describing JSON object.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isEisdirError } from "./repairs.js";

// ─── Types ────────────────────────────────────────────────────────────────

/** A single tool-call or tool-result event recorded to JSONL. */
export interface RepairEvent {
  ts: string;
  /** "tool_call" | "tool_result" */
  eventType: "tool_call" | "tool_result";
  sessionId: string;
  turnIndex: number;
  toolName: string;

  /** Model responsible for this tool call. */
  provider: string;
  model: string;

  /** Repair descriptions (e.g. ["input.edits: parsed JSON string → array"]). */
  repairs: string[];
  wasRepaired: boolean;

  // tool_result fields (null/undefined for tool_call events)
  executionFailed: boolean;
  executionErrorType: string | null;
  wasHandled: boolean;
  handleType: string | null;

  /**
   * Blindspot category — non-null when THIS event could benefit from a new
   * repair that doesn't exist yet. Examples:
   *  - "EISDIR"  (read on directory → candidate: auto-list)
   *  - "ENOENT"  (file not found → candidate: fuzzy path matching)
   *  - "timeout" (bash timeout → candidate: auto-extend known tools)
   *  - "400"     (bad request → candidate: argument reordering)
   *  - "model_domain_list"  (model sends comma-sep string for array field)
   *  - "model_null_field"   (model sends null for optional param)
   */
  blindspotCategory: string | null;

  /** Input shape — structural fingerprint for pattern detection. */
  inputKeys: string[];
  inputNullKeys: string[];
  inputExtraProps: string[];
}

/** Aggregate stats across a single session or globally. */
export interface AggregateStats {
  totalCalls: number;
  totalRepairs: number;
  totalErrors: number;
  totalHandled: number;

  /** { toolName → callCount } */
  byTool: Record<string, { calls: number; repairs: number; errors: number }>;
  /** { "provider/model" → callCount } */
  byModel: Record<string, number>;
  /** { repairType → count } */
  byRepairType: Record<string, number>;
  /** { errorType → count } */
  byErrorType: Record<string, number>;
}

/** A detected blindspot — errors without repair coverage. */
export interface Blindspot {
  category: string;
  toolName: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  example: string;
  models: string[];
  suggestion: string;
}

// ─── Error Classification ────────────────────────────────────────────────

/**
 * Classify a tool result error message into a canonical error type.
 * Used for blindspot detection and error aggregation.
 */
export function classifyErrorType(errorText: string | null): string | null {
	if (!errorText) return null;
	if (isEisdirError(errorText)) return "EISDIR";
	const lower = errorText.toLowerCase();
	if (lower.includes("no such file") || lower.includes("not found") || lower.includes("enoent")) return "ENOENT";
	if (lower.includes("permission denied") || lower.includes("eacces") || lower.includes("eperm")) return "EACCES";
	if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
	if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
	if (lower.includes("bad request") || lower.includes("400")) return "bad_request";
	// HTTP status codes in error text
	const httpMatch = lower.match(/\b([45]\d{2})\b/);
	if (httpMatch) return `HTTP_${httpMatch[1]}`;
	return null;
}

// ─── Path Resolution ──────────────────────────────────────────────────────

export function getRepairLogDir(): string {
  return path.join(".pi", "repair-log");
}

export function sessionLogPath(sessionId: string): string {
  return path.join(getRepairLogDir(), `${sessionId}.jsonl`);
}

export function sessionMetaPath(sessionId: string): string {
  return path.join(getRepairLogDir(), `${sessionId}.meta.json`);
}

// ─── I/O ──────────────────────────────────────────────────────────────────

/** Ensure repair-log directory exists. Sync to avoid race on first call. */
export function ensureDir(): void {
  const dir = getRepairLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Append one event as a JSON line. Non-blocking; fire-and-forget. */
export function recordEvent(event: RepairEvent): void {
  try {
    const sid = event.sessionId || "unknown";
    ensureDir();
    const line = JSON.stringify({ ...event, sessionId: sid }) + "\n";
    const logPath = sessionLogPath(sid);
    fs.appendFileSync(logPath, line, "utf-8");
  } catch {
    // Silently ignore write failures — logging should never break the agent
  }
}

/** Read all events for one session, most recent first. */
export function readSessionEvents(sessionId: string, logDir?: string): RepairEvent[] {
  const logPath = logDir
    ? path.join(logDir, `${sessionId}.jsonl`)
    : sessionLogPath(sessionId);
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, "utf-8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as RepairEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is RepairEvent => e !== null)
    .reverse();
}

/** Read all events across all session files. */
export function readAllEvents(logDir?: string): RepairEvent[] {
  const dir = logDir ?? getRepairLogDir();
  if (!fs.existsSync(dir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const all: RepairEvent[] = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, "utf-8").trim();
      if (!raw) continue;
      const events = raw
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as RepairEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is RepairEvent => e !== null);
      all.push(...events);
    } catch {
      // Skip unreadable files
    }
  }

  return all.reverse();
}

/**
 * Delete expired session logs beyond the retention limit.
 * Returns the number of sessions pruned.
 */
export function pruneOldSessions(maxSessions: number = 50, logDir?: string): number {
  const dir = logDir ?? getRepairLogDir();
  if (!fs.existsSync(dir)) return 0;

  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  // Group by session ID: keep only .jsonl files, one per session
  const sessionFiles = files
    .filter((f) => f.isFile() && f.name.endsWith(".jsonl"))
    .map((f) => ({
      name: f.name,
      sessionId: f.name.replace(/\.jsonl$/, ""),
      mtime: fs.statSync(path.join(dir, f.name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  if (sessionFiles.length <= maxSessions) return 0;

  let removed = 0;
  for (const file of sessionFiles.slice(maxSessions)) {
    try {
      fs.unlinkSync(path.join(dir, file.name));
      removed++;
      const metaPath = path.join(dir, file.sessionId + ".meta.json");
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
    } catch {
      // Best-effort cleanup
    }
  }
  return removed;
}

// ─── Aggregation ──────────────────────────────────────────────────────────

/** Aggregate events into stats. */
export function aggregateStats(events: RepairEvent[]): AggregateStats {
  const stats: AggregateStats = {
    totalCalls: 0,
    totalRepairs: 0,
    totalErrors: 0,
    totalHandled: 0,
    byTool: {},
    byModel: {},
    byRepairType: {},
    byErrorType: {},
  };

  for (const evt of events) {
    stats.totalCalls++;

    if (evt.wasRepaired) stats.totalRepairs++;
    if (evt.executionFailed) stats.totalErrors++;
    if (evt.wasHandled) stats.totalHandled++;

    // By tool
    if (!stats.byTool[evt.toolName]) {
      stats.byTool[evt.toolName] = { calls: 0, repairs: 0, errors: 0 };
    }
    stats.byTool[evt.toolName].calls++;
    if (evt.wasRepaired) stats.byTool[evt.toolName].repairs++;
    if (evt.executionFailed) stats.byTool[evt.toolName].errors++;

    // By model
    const modelKey = `${evt.provider}/${evt.model}`;
    stats.byModel[modelKey] = (stats.byModel[modelKey] ?? 0) + 1;

    // By repair type
    const repairTypes = extractRepairTypes(evt.repairs);
    for (const rt of repairTypes) {
      stats.byRepairType[rt] = (stats.byRepairType[rt] ?? 0) + 1;
    }

    // By error type
    if (evt.executionErrorType) {
      stats.byErrorType[evt.executionErrorType] =
        (stats.byErrorType[evt.executionErrorType] ?? 0) + 1;
    }
  }

  return stats;
}

// ─── Blindspot Detection ──────────────────────────────────────────────────

/** Blindspot suggestions mapped by category. */
const BLINDSPOT_SUGGESTIONS: Record<string, string> = {
  EISDIR: "Add directory-listing fallback for read tool (similar to current EISDIR handler but as a documented pattern check).",
  ENOENT: "Consider fuzzy path matching: retry with relative path, check common parent dirs.",
  timeout: "Add auto-timeout extension for known long-running tools (build, test, lint).",
  "400": "Inspect request schema: model may be sending extra/malformed parameters. Add schema validation upstream.",
  model_null_field: "Add null-stripping in tool_call handler (already done for some fields — expand coverage to all optional fields).",
  model_domain_list: "Add comma/space-split to array repair (already done for some fields — verify field name coverage).",
  model_bare_array: "Add bare-string → array wrapping for this field (check ARRAY_FIELD_NAMES coverage).",
  model_json_string: "Add JSON string parsing for deeply nested stringified objects.",
  model_extra_props: "Add extra-property stripping in array items for this field (check ARRAY_ITEM_SCHEMAS coverage).",
  model_boolean_string: "Add boolean coercion for this field (check BOOLEAN_FIELD_NAMES coverage).",
  model_number_string: "Add number coercion for this field (check NUMBER_FIELD_NAMES coverage).",
};

/** Get a suggestion text for a blindspot category. */
export function getSuggestion(category: string, toolName: string): string {
  if (BLINDSPOT_SUGGESTIONS[category]) return BLINDSPOT_SUGGESTIONS[category];
  return `Investigate ${toolName} errors with category "${category}" — no predefined suggestion exists.`;
}

/** Extract repair action names from repair detail strings. */
export function extractRepairTypes(repairs: string[]): string[] {
  const types: string[] = [];
  for (const detail of repairs) {
    // Match patterns like:
    // "input.path: unwrapped markdown path ..."
    // "input.edits: parsed JSON string ..."
    // "input.strict: coerced boolean ..."
    // "input.limit: coerced number ..."
    // "input.nullField: stripped null ..."
    // "someField: wrapped object → ..."
    // "someField: wrapped bare ..."
    // "someField: split string ..."
    const match = detail.match(
      /: (unwrapped markdown|parsed JSON|wrapped bare|wrapped object|split string|coerced boolean|coerced number|stripped null|stripped extra props|directory fallback)/
    );
    if (match) {
      types.push(match[1]);
    } else if (detail.includes(": stripped null")) {
      types.push("stripped null");
    }
  }
  return types;
}

/**
 * Compute blindspots — error patterns that have NO repair coverage.
 *
 * A blindspot is an error that:
 *  1. Had executionFailed=true
 *  2. Had wasRepaired=false (no repair caught it before execution)
 *  3. OR had wasRepaired=true but still failed (repair was insufficient)
 *
 * Grouped by (toolName + blindspotCategory).
 */
export function computeBlindspots(events: RepairEvent[]): Blindspot[] {
  // Filter to relevant events
  const failures = events.filter(
    (e) => e.executionFailed && e.blindspotCategory !== null
  );

  // Group by tool + category
  type GroupKey = string; // "toolName::category"
  const groups = new Map<
    GroupKey,
    {
      category: string;
      toolName: string;
      count: number;
      firstSeen: string;
      lastSeen: string;
      example: string;
      models: Set<string>;
    }
  >();

  for (const evt of failures) {
    const cat = evt.blindspotCategory!;
    const key = `${evt.toolName}::${cat}`;

    let group = groups.get(key);
    if (!group) {
      group = {
        category: cat,
        toolName: evt.toolName,
        count: 0,
        firstSeen: evt.ts,
        lastSeen: evt.ts,
        example: "",
        models: new Set(),
      };
      groups.set(key, group);
    }

    group.count++;
    group.models.add(`${evt.provider}/${evt.model}`);
    if (evt.ts < group.firstSeen) group.firstSeen = evt.ts;
    if (evt.ts > group.lastSeen) group.lastSeen = evt.ts;
    if (!group.example) {
      group.example = formatExample(evt);
    }
  }

  return Array.from(groups.values())
    .map((g) => ({
      category: g.category,
      toolName: g.toolName,
      count: g.count,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      example: g.example,
      models: Array.from(g.models).sort(),
      suggestion: getSuggestion(g.category, g.toolName),
    }))
    .sort((a, b) => b.count - a.count);
}

function formatExample(evt: RepairEvent): string {
  const parts: string[] = [];
  if (evt.inputKeys.length > 0) {
    parts.push(`input keys: [${evt.inputKeys.slice(0, 5).join(", ")}${evt.inputKeys.length > 5 ? ", ..." : ""}]`);
  }
  if (evt.inputNullKeys.length > 0) {
    parts.push(`null fields: [${evt.inputNullKeys.join(", ")}]`);
  }
  if (evt.inputExtraProps.length > 0) {
    parts.push(`extra props: [${evt.inputExtraProps.join(", ")}]`);
  }
  return parts.join(" | ") || `turn ${evt.turnIndex}`;
}

// ─── Formatting ───────────────────────────────────────────────────────────

/** Format aggregate stats as a table for terminal output. */
export function formatSessionStats(stats: AggregateStats): string {
  if (stats.totalCalls === 0) return "No tool calls recorded in this session.";

  const lines: string[] = [];

  // Summary section
  lines.push("📊 Session Repair Stats");
  lines.push("─".repeat(40));
  lines.push(`Tool calls:           ${stats.totalCalls}`);
  lines.push(`Repairs applied:      ${stats.totalRepairs} (${pct(stats.totalRepairs, stats.totalCalls)})`);
  lines.push(`Execution errors:     ${stats.totalErrors} (${pct(stats.totalErrors, stats.totalCalls)})`);
  lines.push(`Fallback handled:     ${stats.totalHandled}`);
  lines.push("");

  // By tool
  const toolEntries = Object.entries(stats.byTool).sort(
    (a, b) => b[1].calls - a[1].calls
  );
  lines.push("By Tool:");
  lines.push(
    `  ${"Tool".padEnd(20)} ${"Calls".padStart(5)} ${"Fixes".padStart(5)} ${"Errors".padStart(6)}`
  );
  lines.push(`  ${"-".repeat(38)}`);
  for (const [tool, t] of toolEntries) {
    lines.push(
      `  ${tool.padEnd(20)} ${String(t.calls).padStart(5)} ${String(t.repairs).padStart(5)} ${String(t.errors).padStart(6)}`
    );
  }

  // By repair type
  if (Object.keys(stats.byRepairType).length > 0) {
    lines.push("");
    lines.push("Top Repairs:");
    const repairEntries = Object.entries(stats.byRepairType).sort(
      (a, b) => b[1] - a[1]
    );
    for (const [type, count] of repairEntries.slice(0, 10)) {
      lines.push(`  ${type.padEnd(24)} ${String(count).padStart(4)}`);
    }
  }

  return lines.join("\n");
}

/** Format global aggregate stats. */
export function formatGlobalStats(
  stats: AggregateStats,
  sessionCount: number
): string {
  if (stats.totalCalls === 0) return "No tool calls recorded across sessions.";

  const lines: string[] = [];

  lines.push("🌍 Global Repair Stats");
  lines.push("─".repeat(45));
  lines.push(`Sessions:             ${sessionCount}`);
  lines.push(`Tool calls:           ${stats.totalCalls}`);
  lines.push(`Repairs applied:      ${stats.totalRepairs} (${pct(stats.totalRepairs, stats.totalCalls)})`);
  lines.push(`Execution errors:     ${stats.totalErrors} (${pct(stats.totalErrors, stats.totalCalls)})`);
  lines.push(`Fallback handled:     ${stats.totalHandled}`);
  lines.push("");

  // By tool
  const toolEntries = Object.entries(stats.byTool).sort(
    (a, b) => b[1].calls - a[1].calls
  );
  lines.push("By Tool:");
  lines.push(
    `  ${"Tool".padEnd(20)} ${"Calls".padStart(6)} ${"Fixes".padStart(5)} ${"Errors".padStart(6)}`
  );
  lines.push(`  ${"-".repeat(39)}`);
  for (const [tool, t] of toolEntries) {
    lines.push(
      `  ${tool.padEnd(20)} ${String(t.calls).padStart(6)} ${String(t.repairs).padStart(5)} ${String(t.errors).padStart(6)}`
    );
  }
  lines.push("");

  // By model
  const modelEntries = Object.entries(stats.byModel).sort(
    (a, b) => b[1] - a[1]
  );
  if (modelEntries.length > 0) {
    lines.push("By Model:");
    for (const [model, count] of modelEntries.slice(0, 10)) {
      lines.push(`  ${model.padEnd(30)} ${String(count).padStart(4)}`);
    }
  }
  lines.push("");

  // By repair type
  if (Object.keys(stats.byRepairType).length > 0) {
    lines.push("Top Repairs:");
    const repairEntries = Object.entries(stats.byRepairType).sort(
      (a, b) => b[1] - a[1]
    );
    for (const [type, count] of repairEntries.slice(0, 10)) {
      lines.push(`  ${type.padEnd(24)} ${String(count).padStart(4)}`);
    }
  }

  // By error type
  if (Object.keys(stats.byErrorType).length > 0) {
    lines.push("");
    lines.push("Top Errors:");
    const errorEntries = Object.entries(stats.byErrorType).sort(
      (a, b) => b[1] - a[1]
    );
    for (const [type, count] of errorEntries.slice(0, 8)) {
      lines.push(`  ${type.padEnd(24)} ${String(count).padStart(4)}`);
    }
  }

  return lines.join("\n");
}

/** Format blindspots as actionable table. */
export function formatBlindspots(spots: Blindspot[]): string {
  if (spots.length === 0) {
    return "✅ No blindspots detected — all errors have repair coverage.";
  }

  const lines: string[] = [];
  lines.push("🔍 Repair Blindspots (unfixed error patterns)");
  lines.push("─".repeat(60));
  lines.push("");

  for (const spot of spots) {
    lines.push(`  [${spot.category}] ${spot.toolName} — ${spot.count}x`);
    lines.push(`  ├─ Models: ${spot.models.join(", ")}`);
    lines.push(`  ├─ First: ${spot.firstSeen}`);
    lines.push(`  ├─ Last:  ${spot.lastSeen}`);
    lines.push(`  ├─ Example: ${spot.example}`);
    lines.push(`  └─ 💡 ${spot.suggestion}`);
    lines.push("");
  }

  lines.push(`Total: ${spots.length} blindspot(s) detected.`);
  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function pct(part: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}
