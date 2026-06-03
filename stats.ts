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
 *
 * State machine:
 *   ┌──────┐  on()   ┌───────┐
 *   │ OFF  │ ──────→ │  ON   │
 *   └──────┘ ←────── └───────┘
 *              off()
 *          toggle() flips both ways
 *
 * All transitions are idempotent: calling on() while ON is a no-op.
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
    return this.enabled ? "🔧 repair: on" : "🔧 repair: off";
  }

  /** Notification message for the user. */
  getNotifyMessage(): string {
    if (this.enabled) {
      return "🔧 repair: on — tool arguments will be auto-repaired";
    }
    return "🔧 repair: off — tool arguments pass through unrepaired";
  }
}

export type RepairType =
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
  sequentials: number; // sequential edit overlap detections
  guidanceInjections: number; // total guidance injections this session (cache breaks)
}

/**
 * Parse repair detail strings to extract repair types.
 *
 * Example detail: "path.field: parsed JSON string '[...]' → array"
 * Returns: "parsed JSON"
 */
export function parseRepairType(detail: string): RepairType | null {
  // Match the repair action after ": "
  // Note: coerced boolean/number have format 'coerced boolean/number "value" → newValue'
  const match = detail.match(
    /: (parsed JSON|wrapped bare|wrapped object|unwrapped markdown|split string|coerced boolean|coerced number|stripped null|stripped extra props|directory fallback)/
  );
  if (match) {
    return match[1] as RepairType;
  }

  // NOTE: coerced boolean/number are already matched by the regex above

  return null;
}

/**
 * Create a new empty stats object.
 */
export function createStats(): RepairStats {
  return {
    repairTypeStats: new Map<RepairType, number>(),
    totalRepairs: 0,
    sequentials: 0,
    guidanceInjections: 0,
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
 * Format stats as a table string.
 */
/**
 * Format cache impact info for the session.
 */
export function formatCacheInfo(stats: RepairStats): string {
  if (stats.guidanceInjections === 0) {
    return "No guidance injections this session — no cache impact from this extension.";
  }
  return [
    `📊 Cache Impact`,
    `─────────────────`,
    `Guidance injections: ${stats.guidanceInjections}`,
    `Each injection means the tool_result text differs from what it would be`,
    `without this extension, potentially invalidating DeepSeek's 64-token`,
    `block cache for subsequent tokens.`,
    ``,
    `Note: pre-execution repairs (null stripping, array wrapping, etc.)`,
    `have ZERO cache impact — they modify args before the tool executes.`,
    `Only post-execution guidance injection affects the conversation prefix.`,
  ].join("\n");
}

export function formatStats(stats: RepairStats): string {
  if (stats.totalRepairs === 0 && stats.sequentials === 0 && stats.guidanceInjections === 0) {
    return "No repairs applied in this session.";
  }

  // Sort by count descending
  const sorted = Array.from(stats.repairTypeStats.entries()).sort(
    (a, b) => b[1] - a[1]
  );

  // Calculate max width for alignment
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

  // Add sequential overlap count if > 0
  if (stats.sequentials > 0) {
    lines.push("");
    lines.push(`Sequential edit overlaps blocked: ${stats.sequentials}`);
  }

  // Add guidance injection count (cache impact metric)
  if (stats.guidanceInjections > 0) {
    lines.push(`Guidance injections (cache misses): ${stats.guidanceInjections}`);
  }

  return [header, separator, ...lines, separator, totalLine].join("\n");
}
