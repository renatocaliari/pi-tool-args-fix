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
import { getSuggestion } from "./recorder/classifier.js";
import { parseRepairType } from "./stats.js";
import { formatExample } from "./recorder/formatting.js";

// Re-export from sub-modules for backward compatibility
export { classifyErrorType, getToolHelp, getErrorGuidance, getSuggestion } from "./recorder/classifier.js";
export { ConsecutiveFailureTracker } from "./recorder/tracker.js";
export { ConsecutiveEmptySearchTracker } from "./recorder/empty-search-tracker.js";
export { formatExample, formatSessionStats, formatGlobalStats, formatBlindspots } from "./recorder/formatting.js";

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

  /**
   * True when the repair toggle was OFF at the time of this event.
   * Analytics still recorded, but repairs + guidance were skipped.
   */
  repairSkipped: boolean;

  /**
   * When repairSkipped=true, lists what WOULD have been repaired
   * if the toggle had been ON. Empty array when toggle was ON or
   * when no repairs were needed.
   */
  wouldHaveRepaired: string[];

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
   *  - "model_bare_array"   (model sends bare value for array field)
   *  - "model_json_string"  (model sends stringified JSON instead of object)
   *  - "model_extra_props"  (model sends extra properties in array items)
   *  - "model_boolean_string" (model sends boolean as string "true"/"false")
   *  - "model_number_string" (model sends number as string "42"/"3.14")
   */
  blindspotCategory: string | null;

  // input fingerprinting
  inputKeys: string[];
  inputNullKeys: string[];
  inputExtraProps: string[];
}

/** Aggregated stats for one or more sessions. */
export interface AggregateStats {
  totalCalls: number;
  totalRepairs: number;
  totalErrors: number;
  totalHandled: number;
  totalSkipped: number;
  byTool: Record<
    string,
    { calls: number; repairs: number; errors: number; handled: number; skipped: number }
  >;
  byModel: Record<string, number>;
  byRepairType: Record<string, number>;
  bySkippedRepairType: Record<string, number>;
  byErrorType: Record<string, number>;
}

/** A blindspot — error pattern without repair coverage. */
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

// ─── Path Resolution ──────────────────────────────────────────────────────

export function getRepairLogDir(): string {
  return path.join(".pi", "repair-log");
}

export function sessionLogPath(sessionId: string): string {
  return path.join(getRepairLogDir(), `${sessionId}.jsonl`);
}

// ─── I/O ──────────────────────────────────────────────────────────────────

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Append one event to the session log.
 * Creates the log directory if needed.
 * @param event — the event to persist
 * @param logDir — custom log directory (default: .pi/repair-log/)
 */
export function recordEvent(event: RepairEvent, logDir?: string): void {
  try {
    const sid = event.sessionId || "unknown";
    const dir = logDir ?? getRepairLogDir();
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ...event, sessionId: sid }) + "\n";
    const logPath = logDir
      ? path.join(logDir, `${sid}.jsonl`)
      : sessionLogPath(sid);
    fs.appendFileSync(logPath, line, "utf-8");
  } catch {
    // Silently ignore write failures — logging should never break the agent
  }
}

/**
 * Read all events for a session, most recent first.
 * Returns an empty array if the session has no logs.
 */
export function readSessionEvents(
  sessionId: string,
  logDir?: string,
): RepairEvent[] {
  const dir = logDir ?? getRepairLogDir();
  const logPath = path.join(dir, `${sessionId}.jsonl`);

  if (!fs.existsSync(logPath)) return [];

  const raw = fs.readFileSync(logPath, "utf-8").trim();
  if (!raw) return [];

  const lines = raw.split("\n");
  const events: RepairEvent[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as RepairEvent;
      events.push(parsed);
    } catch {
      // Skip malformed lines silently
    }
  }

  // Most recent first
  return events.reverse();
}

/**
 * Read all events across ALL session logs in the repair log directory.
 */
export function readAllEvents(logDir?: string): RepairEvent[] {
  const dir = logDir ?? getRepairLogDir();
  if (!fs.existsSync(dir)) return [];

  const sessions = fs.readdirSync(dir);
  const all: RepairEvent[] = [];

  for (const file of sessions) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.replace(".jsonl", "");
    const events = readSessionEvents(sessionId, dir);
    all.push(...events);
  }

  return all;
}

/**
 * Prune old session logs, keeping only the most recent N.
 */
export function pruneOldSessions(
  keep: number,
  logDir?: string,
): number {
  const dir = logDir ?? getRepairLogDir();
  if (!fs.existsSync(dir)) return 0;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  let removed = 0;
  for (const file of files.slice(keep)) {
    const logPath = path.join(dir, file.name);
    const metaPath = path.join(dir, file.name.replace(".jsonl", ".meta.json"));
    try {
      fs.unlinkSync(logPath);
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
      removed++;
    } catch {
      // Best effort — skip files that can't be removed
    }
  }

  return removed;
}

// ─── Analysis ─────────────────────────────────────────────────────────────

/** Aggregate a list of events into summary stats. */
export function aggregateStats(events: RepairEvent[]): AggregateStats {
  const stats: AggregateStats = {
    totalCalls: 0,
    totalRepairs: 0,
    totalErrors: 0,
    totalHandled: 0,
    totalSkipped: 0,
    byTool: {},
    byModel: {},
    byRepairType: {},
    bySkippedRepairType: {},
    byErrorType: {},
  };

  if (events.length === 0) return stats;

  for (const evt of events) {
    stats.totalCalls++;

    // Per-tool stats
    if (!stats.byTool[evt.toolName]) {
      stats.byTool[evt.toolName] = { calls: 0, repairs: 0, errors: 0, handled: 0, skipped: 0 };
    }
    stats.byTool[evt.toolName].calls++;

    // Repair stats
    if (evt.wasRepaired && evt.eventType === "tool_call") {
      stats.totalRepairs++;
      stats.byTool[evt.toolName].repairs++;

      // Granular repair types
      const repairTypes = extractRepairTypes(evt.repairs);
      for (const type of repairTypes) {
        stats.byRepairType[type] = (stats.byRepairType[type] ?? 0) + 1;
      }
    }

    // Skipped repair stats (toggle was OFF)
    if (evt.repairSkipped) {
      stats.totalSkipped++;
      stats.byTool[evt.toolName].skipped++;

      // Track what would have been repaired
      for (const repair of evt.wouldHaveRepaired) {
        const type = parseRepairType(repair);
        if (type) {
          stats.bySkippedRepairType[type] = (stats.bySkippedRepairType[type] ?? 0) + 1;
        }
      }
    }

    // Error stats (only on tool_result with executionFailed)
    if (evt.executionFailed) {
      stats.totalErrors++;
      stats.byTool[evt.toolName].errors++;

      const errorType = evt.executionErrorType ?? "unknown";
      stats.byErrorType[errorType] = (stats.byErrorType[errorType] ?? 0) + 1;
    }

    // Handler stats
    if (evt.wasHandled) {
      stats.totalHandled++;
      stats.byTool[evt.toolName].handled++;
    }

    // Per-model stats (exclude test models)
    const modelId = `${evt.provider}/${evt.model}`;
    if (!modelId.includes("test")) {
      stats.byModel[modelId] = (stats.byModel[modelId] ?? 0) + 1;
    }
  }

  return stats;
}

/** Extract repair action names from repair detail strings. */
export function extractRepairTypes(repairs: string[]): string[] {
  const types: string[] = [];
  for (const detail of repairs) {
    const type = parseRepairType(detail);
    if (type) {
      types.push(type);
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


