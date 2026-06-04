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
  /**
   * LLM provider-reported cache usage, accumulated across all turns in
   * this session. Read from `usage.cacheRead` / `usage.cacheWrite` on
   * assistant messages during the `context` event.
   *
   * `totalCacheRead` = tokens served from the provider's prefix cache
   * `totalCacheWrite` = tokens written to the cache for future hits
   *
   * Hit rate = totalCacheRead / (totalCacheRead + totalCacheWrite + uncachedInput)
   * Per Claude's docs: "We run alerts on our prompt cache hit rate and
   * declare SEVs if they're too low." This is the same metric.
   */
  totalCacheRead: number;
  totalCacheWrite: number;
  totalUncachedInput: number;
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
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalUncachedInput: 0,
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
 *
 * Shows two things:
 *   1. This extension's cache-safety contract: how many guidance injections
 *      have been queued this session
 *   2. LLM provider cache hit rate (from assistant message `usage` data)
 *
 * The 4-rule cache-safety pattern is documented in `docs/cache-safety.md`.
 */
export function formatCacheInfo(stats: RepairStats): string {
  const totalInput = stats.totalCacheRead + stats.totalCacheWrite + stats.totalUncachedInput;
  const hitRate = totalInput > 0 ? (stats.totalCacheRead / totalInput) * 100 : 0;
  const writeRate = totalInput > 0 ? (stats.totalCacheWrite / totalInput) * 100 : 0;

  // Per Claude's pricing (rough, for illustration):
  //   cache reads:  10% of base input
  //   cache writes: 125% of base input (5 minute cache); 200% (1 hour)
  //   uncached:     100% of base
  // Cache reads at 0.1x, writes at 1.25x, uncached at 1.0x of base.
  const PRICE_BASE = 5; // $/MTok uncached
  const priceCacheRead = (stats.totalCacheRead / 1_000_000) * PRICE_BASE * 0.1;
  const priceCacheWrite = (stats.totalCacheWrite / 1_000_000) * PRICE_BASE * 1.25;
  const priceUncached = (stats.totalUncachedInput / 1_000_000) * PRICE_BASE;
  const actualCost = priceCacheRead + priceCacheWrite + priceUncached;
  // What would the cost be with NO cache at all?
  const noCacheCost = (totalInput / 1_000_000) * PRICE_BASE;
  const savings = noCacheCost - actualCost;

  const lines: string[] = [
    `📊 Cache Impact`,
    `─────────────────`,
    ``,
    `This extension's cache-safety contract:`,
    `  Guidance injections: ${stats.guidanceInjections}  (post-execution, side-channel only)`,
    ``,
    `LLM cache hit rate (provider-reported):`,
    `  Total input:    ${formatTokens(totalInput)}`,
    `  Cache reads:    ${formatTokens(stats.totalCacheRead)} (${hitRate.toFixed(1)}% hit rate) @ $${PRICE_BASE * 0.1}/M = $${priceCacheRead.toFixed(2)}`,
    `  Cache writes:   ${formatTokens(stats.totalCacheWrite)} (${writeRate.toFixed(1)}% of total) @ $${PRICE_BASE * 1.25}/M = $${priceCacheWrite.toFixed(2)}`,
    `  Uncached:       ${formatTokens(stats.totalUncachedInput)} @ $${PRICE_BASE}/M = $${priceUncached.toFixed(2)}`,
    ``,
    `Session cost so far: $${actualCost.toFixed(2)}`,
    `vs no cache:         $${noCacheCost.toFixed(2)} (saving $${savings.toFixed(2)})`,
    ``,
    `Cache contract: this extension follows the 4-rule pattern`,
    `(static cutoff + one-shot + byte-deterministic + stable position).`,
    `See \`docs/cache-safety.md\` for the full contract.`,
  ];

  if (stats.guidanceInjections === 0) {
    return [
      ...lines.slice(0, 2),
      ``,
      `No guidance injections this session — tool args were repaired`,
      `pre-execution (zero cache impact) and no errors needed`,
      `post-execution guidance.`,
      ``,
      ...lines.slice(2),
    ].join("\n");
  }

  return lines.join("\n");
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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
