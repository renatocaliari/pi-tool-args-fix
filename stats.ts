/**
 * Repair statistics tracking module.
 *
 * Tracks repair usage by type and provides formatted output.
 * Designed to be testable independently of the pi extension API.
 */

// ─── Repair Toggle (enable/disable state machine) ───────────────────────

/**
 * Pure toggle state for the repair layer.
 * Tracked per-session without depending on pi extension API.
 */
export class RepairToggle {
  private enabled: boolean;

  constructor(initial = true) {
    this.enabled = initial;
  }

  /** Enable the repair layer. Idempotent. */
  on(): void {
    this.enabled = true;
  }

  /** Disable the repair layer. Idempotent. */
  off(): void {
    this.enabled = false;
  }

  /** Flip current state. Returns new state. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  /** Current state. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Status text for UI display. */
  getStatusDisplay(): string {
    return this.enabled
      ? "🔧 repair: on"
      : "🔧 repair: off (analytics + logs still on)";
  }

  /** Notification message for the user. */
  getNotifyMessage(): string {
    if (this.enabled) {
      return "🔧 repair: on — tool arguments will be auto-repaired";
    }
    return "🔧 repair: off — tool arguments pass through unrepaired";
  }
}

type RepairType =
  | "parsed JSON"
  | "wrapped bare"
  | "wrapped object"
  | "unwrapped markdown"
  | "split string"
  | "coerced boolean"
  | "coerced number"
  | "stripped null"
  | "stripped extra props"
  | "directory fallback";

export interface RepairStats {
  repairTypeStats: Map<RepairType, number>;
  totalRepairs: number;
  totalToolCalls: number;
  sequentials: number;
  guidanceInjections: number;
  guidanceSuppressed: number;
  wouldHaveRepairedByType: Map<RepairType, number>;
  wouldHaveRepairedTotal: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalInputTokens: number;
  /** Session ID for repair-log path. Set by context handler. */
  sessionId?: string;
}

/**
 * Parse repair detail strings to extract repair types.
 */
export function parseRepairType(detail: string): RepairType | null {
  const match = detail.match(
    /: (parsed JSON|wrapped bare|wrapped object|unwrapped markdown|split string|coerced boolean|coerced number|stripped null|stripped extra props|directory fallback)/
  );
  if (match) {
    return match[1] as RepairType;
  }
  return null;
}

/**
 * Create a new empty stats object.
 */
export function createStats(): RepairStats {
  return {
    repairTypeStats: new Map<RepairType, number>(),
    totalRepairs: 0,
    totalToolCalls: 0,
    sequentials: 0,
    guidanceInjections: 0,
    guidanceSuppressed: 0,
    wouldHaveRepairedByType: new Map<RepairType, number>(),
    wouldHaveRepairedTotal: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalInputTokens: 0,
    sessionId: undefined,
  };
}

/**
 * Record repairs from detail strings.
 * Returns updated stats (mutates input).
 */
export function recordRepairs(
  stats: RepairStats,
  repairDetails: string[]
): RepairStats {
  for (const detail of repairDetails) {
    const repairType = parseRepairType(detail);
    if (repairType) {
      const count = stats.repairTypeStats.get(repairType) || 0;
      stats.repairTypeStats.set(repairType, count + 1);
      stats.totalRepairs++;
    }
  }

  return stats;
}

/**
 * Format cache impact info for the session.
 */
export function formatCacheInfo(stats: RepairStats): string {
  const totalInput = stats.totalInputTokens;
  const computedFromScratch = totalInput - stats.totalCacheRead;

  // Build cache metrics section
  const cacheLines: string[] = [
    `📊 Cache Impact`,
    `─────────────────`,
    ``,
    `Tokenizer (LLM prefix cache):`,
    `  Total sent to API:   ${padToken(totalInput)}  (100%)`,
    `  Served from cache:   ${padToken(stats.totalCacheRead)}  ${fmtPct(stats.totalCacheRead, totalInput)}`,
    `  Computed from zero:  ${padToken(computedFromScratch)}  ${fmtPct(computedFromScratch, totalInput)}`,
  ];

  if (stats.totalCacheWrite > 0) {
    cacheLines.push(`  Written to cache:    ${padToken(stats.totalCacheWrite)}`);
  }

  // Only add the note when no cache data was reported
  if (stats.totalCacheRead === 0 && totalInput > 0) {
    cacheLines.push(`  (${fmtPct(0, totalInput)} hit rate — provider did not report cache data)`);
  }

  // Guidance section
  const guidanceLines: string[] = [
    ``,
    `Guidance (context event — injected before LLM call, not persisted):`,
    `  Items: ${stats.guidanceInjections}`,
  ];
  if (stats.guidanceSuppressed > 0) {
    guidanceLines.push(`  Suppressed by 2000-char cap: ${stats.guidanceSuppressed}`);
  }

  // Repair log path
  const pathLines: string[] = [
    ``,
    `Repair log (all events with full details):`,
    `  ${formatRepairLogPath(stats)}`,
  ];

  return [...cacheLines, ...guidanceLines, ...pathLines].join("\n");
}

function fmtPct(part: number, total: number): string {
  if (total <= 0) return "";
  return `(${(part / total * 100).toFixed(1)}%)`;
}

function padToken(n: number): string {
  return String(formatTokens(n)).padStart(8);
}

/**
 * Build the absolute path to the repair log file.
 * Uses process.cwd() at call time (when user runs /repair-cache-info).
 */
export function formatRepairLogPath(stats: RepairStats): string {
  const cwd = process.cwd();
  const sessionId = stats.sessionId ?? "unknown";
  return `${cwd}/.pi/repair-log/${sessionId}.jsonl`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Format stats as a table string.
 */
export function formatStats(stats: RepairStats): string {
  if (stats.totalRepairs === 0 && stats.sequentials === 0 && stats.guidanceInjections === 0) {
    return "No repairs applied in this session.";
  }

  const sorted = Array.from(stats.repairTypeStats.entries()).sort(
    (a, b) => b[1] - a[1]
  );

  const maxTypeLen = Math.max(
    ...sorted.map(([type]) => type.length),
    "Repair Type".length
  );

  const lines: string[] = [];
  for (const [type, count] of sorted) {
    const pct = Math.round((count / stats.totalRepairs) * 100);
    lines.push(
      `${type.padEnd(maxTypeLen)}  ${String(count).padStart(5)}  ${String(pct).padStart(3)}%`
    );
  }

  const header = `${"Repair Type".padEnd(maxTypeLen)}  ${"Count".padStart(5)}  ${"%".padStart(3)}`;
  const separator = "-".repeat(header.length);
  const totalLine = `${"Total".padEnd(maxTypeLen)}  ${String(stats.totalRepairs).padStart(5)}`;

  if (stats.sequentials > 0) {
    lines.push("");
    lines.push(`Sequential edit overlaps blocked: ${stats.sequentials}`);
  }

  if (stats.guidanceInjections > 0) {
    lines.push(`Guidance items queued (side-channel): ${stats.guidanceInjections}`);
  }

  return [header, separator, ...lines, separator, totalLine].join("\n");
}

/**
 * Compact one-line summary for the powerline / footer.
 * Shows: repairs count | guidance count | suppressed count.
 *
 * Example: "🔧 22 repairs  |  7 guidance  |  0 suppressed"
 */
export function formatFooterSummary(stats: RepairStats): string {
  const parts: string[] = [];
  if (stats.totalRepairs > 0) {
    parts.push(`${stats.totalRepairs} repairs`);
  }
  if (stats.guidanceInjections > 0) {
    parts.push(`${stats.guidanceInjections} guidance`);
  }
  if (stats.guidanceSuppressed > 0) {
    parts.push(`${stats.guidanceSuppressed} suppressed`);
  }
  if (parts.length === 0) {
    return "🔧 repair: on  —  no activity";
  }
  return `🔧 ${parts.join("  |  ")}`;
}

/**
 * Format the "would have repaired" section (G3 surface).
 *
 * Shows what repairs would have been applied if the toggle was ON,
 * plus the context: how many of the total tool calls had arg issues.
 *
 * Convention: if the count is zero, returns a one-liner saying so.
 * Otherwise returns a table with a footer line that contextualizes
 * the absolute total against the total tool calls this session.
 */
export function formatWouldHaveRepaired(stats: RepairStats): string {
  if (stats.wouldHaveRepairedTotal === 0) {
    return "🔍 Would have repaired (if repair was ON): 0 (no skipped events this session)";
  }

  const sorted = Array.from(stats.wouldHaveRepairedByType.entries()).sort(
    (a, b) => b[1] - a[1],
  );

  const maxTypeLen = Math.max(
    ...sorted.map(([type]) => type.length),
    "Repair Type".length,
  );

  const lines: string[] = [];
  for (const [type, count] of sorted) {
    const pct = Math.round((count / stats.wouldHaveRepairedTotal) * 100);
    lines.push(
      `${type.padEnd(maxTypeLen)}  ${String(count).padStart(5)}  ${String(pct).padStart(3)}%`,
    );
  }

  const header = `${"Repair Type".padEnd(maxTypeLen)}  ${"Count".padStart(5)}  ${"%".padStart(3)}`;
  const separator = "-".repeat(header.length);
  const totalLine = `${"Total".padEnd(maxTypeLen)}  ${String(stats.wouldHaveRepairedTotal).padStart(5)}`;

  // Context footer: compare the absolute total to what actually happened.
  // % is "share of tool calls that had arg issues" — the natural metric
  // for "how much is OFF costing you".
  const toolCallsAffected = stats.wouldHaveRepairedTotal; // 1:1 with skipped events, but using total for clarity
  const totalCalls = stats.totalToolCalls;
  const affectedPct = totalCalls > 0
    ? Math.round((toolCallsAffected / totalCalls) * 100)
    : 0;
  const contextLine = totalCalls > 0
    ? `\nImpact: ${toolCallsAffected} of ${totalCalls} tool calls (${affectedPct}%) had arg issues while OFF`
    : "";

  return [
    "🔍 Would have repaired (if repair was ON):",
    "",
    ...[header, separator, ...lines, separator, totalLine],
    contextLine,
  ].join("\n");
}
