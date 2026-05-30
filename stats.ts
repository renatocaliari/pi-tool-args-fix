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

  // Handle coerced values with different format
  if (detail.includes(": coerced boolean")) {
    return "coerced boolean";
  }
  if (detail.includes(": coerced number")) {
    return "coerced number";
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
export function formatStats(stats: RepairStats): string {
  if (stats.totalRepairs === 0) {
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

  return [header, separator, ...lines, separator, totalLine].join("\n");
}
