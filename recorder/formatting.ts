/**
 * Formatting helpers for repair statistics and blindspots.
 *
 * Extracted from recorder.ts to reduce file size (545 → ~305 lines).
 * Pure functions with no I/O — type-only imports from parent module.
 */

import type { RepairEvent, AggregateStats, Blindspot } from "../recorder.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function pct(part: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

// ─── Formatting ───────────────────────────────────────────────────────────

/** Format a single blindspot example. */
export function formatExample(evt: RepairEvent): string {
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
