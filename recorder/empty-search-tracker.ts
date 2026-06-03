/**
 * Consecutive empty search tracker — detects "silent loops" where find/grep
 * return success but produce no results, and the model keeps retrying with
 * slightly different patterns instead of changing strategy.
 *
 * Pure in-memory tracker. Inspired by real failure mode observed in subagent
 * sessions where a model searched for NavUnifiedDropdown 15+ times across
 * find/grep while the actual file was nav_unified_dropdown.templ.
 *
 * Key design decisions:
 * - Counts are keyed by CONCEPT, not by exact pattern. find "NavUnifiedDropdown"
 *   then grep "nav_unified_drop" share one count — they are the same concept.
 * - recordFound() resets ALL counts — any successful result breaks any loop.
 */

const EMPTY_SEARCH_LIMIT = 3;

/**
 * Track consecutive empty search results across find/grep/ls.
 */
export class ConsecutiveEmptySearchTracker {
  /** A map where all related fingerprints point to the same canonical key → count */
  private fingerprintToCanonical = new Map<string, string>();
  /** canonical fingerprint → consecutive empty count */
  private conceptCounts = new Map<string, number>();
  /** The current canonical fingerprint we're tracking */
  private currentCanonical: string | null = null;

  /**
   * Record an empty search result. Returns the consecutive empty count.
   *
   * Counts accumulate across related pattern variants:
   *   "NavUnifiedDropdown"   → empty (count=1)
   *   "nav_unified_dropdow"  → empty (count=2) — same concept
   *   "session"              → empty (count=1) — different concept, reset
   */
  recordEmpty(pattern: string): number {
    const fp = this.makeFingerprint(pattern);

    // Find the canonical key for this fingerprint (might be a new one or existing related)
    const canonical = this.resolveCanonical(fp);

    if (this.currentCanonical !== null && this.currentCanonical !== canonical) {
      // Concept changed — reset
      this.conceptCounts.clear();
      this.fingerprintToCanonical.clear();
      this.currentCanonical = canonical;
    } else {
      this.currentCanonical = canonical;
    }

    const current = (this.conceptCounts.get(canonical) ?? 0) + 1;
    this.conceptCounts.set(canonical, current);
    return current;
  }

  /**
   * Record a successful (non-empty) search — resets ALL counts.
   * A single hit breaks any loop, regardless of which tool found it.
   */
  recordFound(): void {
    this.conceptCounts.clear();
    this.fingerprintToCanonical.clear();
    this.currentCanonical = null;
  }

  /** Get the current consecutive empty count for a search pattern. */
  getCount(pattern: string): number {
    const fp = this.makeFingerprint(pattern);
    const canonical = this.fingerprintToCanonical.get(fp);
    if (canonical === undefined) return 0;
    return this.conceptCounts.get(canonical) ?? 0;
  }

  /** Check if the given pattern is in a consecutive empty loop (3+ empties). */
  isInEmptyLoop(pattern: string): boolean {
    return this.getCount(pattern) >= EMPTY_SEARCH_LIMIT;
  }

  /** Reset all state. */
  reset(): void {
    this.conceptCounts.clear();
    this.fingerprintToCanonical.clear();
    this.currentCanonical = null;
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Create a stable fingerprint from a search pattern.
   * Normalizes case and collapses punctuation/whitespace.
   */
  private makeFingerprint(pattern: string): string {
    const normalized = pattern
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\\/'"_*?\-]/g, " ")  // collapse search chars
      .replace(/\s+/g, " ")                             // collapse whitespace
      .trim();
    return normalized || "_empty";
  }

  /**
   * Find or create a canonical key for a fingerprint.
   * If the fingerprint is related to any existing one, they share the canonical.
   */
  private resolveCanonical(fp: string): string {
    // Check if we already have an exact match in the map
    const existing = this.fingerprintToCanonical.get(fp);
    if (existing !== undefined) return existing;

    // Check if this fingerprint is related to any existing canonical
    for (const [existingFp, canonical] of this.fingerprintToCanonical) {
      if (this.areRelated(fp, existingFp)) {
        // Both this fp and the matching one should point to the same canonical
        this.fingerprintToCanonical.set(fp, canonical);
        return canonical;
      }
    }

    // New concept — this fingerprint IS the canonical
    this.fingerprintToCanonical.set(fp, fp);
    return fp;
  }

  /**
   * Two fingerprints are "related" if one is a substring of the other, or
   * if one contains a 4+ char fragment from the other.
   */
  private areRelated(a: string, b: string): boolean {
    if (a === b) return true;

    const aCompact = a.replace(/\s+/g, "");
    const bCompact = b.replace(/\s+/g, "");

    // Direct substring match
    if (aCompact.includes(bCompact) || bCompact.includes(aCompact)) return true;

    // 4+ char fragment overlap
    if (aCompact.length >= 4 && bCompact.length >= 4) {
      for (let i = 0; i <= bCompact.length - 4; i++) {
        const frag = bCompact.slice(i, i + 4);
        if (aCompact.includes(frag)) return true;
      }
    }

    // Check space-split tokens for shorter patterns
    const aTokens = a.split(/\s+/).filter(Boolean);
    const bTokens = b.split(/\s+/).filter(Boolean);
    for (const aTok of aTokens) {
      for (const bTok of bTokens) {
        if (aTok.length >= 4 && bTok.length >= 4 && (aTok.includes(bTok) || bTok.includes(aTok))) {
          return true;
        }
      }
    }

    return false;
  }
}
