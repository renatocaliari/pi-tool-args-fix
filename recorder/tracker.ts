/**
 * Consecutive failure tracker for loop detection.
 *
 * Pure in-memory tracker. Detects when an LLM agent calls the same tool
 * repeatedly and each call fails — a common failure mode where the model
 * retries the same broken approach 15+ times.
 */

const CONSECUTIVE_LIMIT = 3;
const CIRCUIT_BREAK_LIMIT = 7;

type LoopSeverity = "none" | "minor" | "major" | "critical";

/**
 * Track consecutive failures per tool.
 * Resets on arg-pattern change or explicit recordSuccess() call.
 */
export class ConsecutiveFailureTracker {
  /** toolName → current consecutive failure count */
  private counts = new Map<string, number>();
  /** toolName → last fingerprint (reset on change of arg pattern) */
  private lastFingerprint = new Map<string, string>();

  /**
   * Record a failure. Returns the consecutive count for this tool.
   * Count resets to 1 if:
   *   - A different tool is called
   *   - The arg pattern changes significantly (different keys)
   *   - The previous call succeeded
   */
  recordFailure(toolName: string, inputKeys: string[]): number {
    const fp = inputKeys.sort().join(",");
    const prevFp = this.lastFingerprint.get(toolName);

    if (prevFp !== undefined && prevFp !== fp) {
      // Arg pattern changed — this is a new attempt, not a retry
      this.counts.set(toolName, 1);
    } else {
      const current = this.counts.get(toolName) ?? 0;
      this.counts.set(toolName, current + 1);
    }

    this.lastFingerprint.set(toolName, fp);
    return this.counts.get(toolName)!;
  }

  /**
   * Record a success — resets the count for this tool.
   */
  recordSuccess(toolName: string): void {
    this.counts.set(toolName, 0);
  }

  /** Get the current consecutive count for a tool (0 if none). */
  getCount(toolName: string): number {
    return this.counts.get(toolName) ?? 0;
  }

  /**
   * Check if this tool is in a consecutive failure loop.
   */
  isInLoop(toolName: string): boolean {
    return (this.counts.get(toolName) ?? 0) >= CONSECUTIVE_LIMIT;
  }

  /**
   * Check if this tool has reached circuit-break level (7+ consecutive).
   */
  isCircuitBreak(toolName: string): boolean {
    return (this.counts.get(toolName) ?? 0) >= CIRCUIT_BREAK_LIMIT;
  }

  /**
   * Get loop severity.
   */
  getSeverity(toolName: string): LoopSeverity {
    const count = this.counts.get(toolName) ?? 0;
    if (count >= CIRCUIT_BREAK_LIMIT) return "critical";
    if (count >= 5) return "major";
    if (count >= CONSECUTIVE_LIMIT) return "minor";
    return "none";
  }

  /** Reset all state (e.g. at session start). */
  reset(): void {
    this.counts.clear();
    this.lastFingerprint.clear();
  }
}
