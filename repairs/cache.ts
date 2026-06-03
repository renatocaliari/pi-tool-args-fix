/**
 * Content hash cache for staleness detection.
 *
 * Records content hashes when files are read, so we can detect when
 * the model tries to edit a file whose content has changed since it
 * was last read.
 *
 * Pure state container — no I/O.
 */

/**
 * Simple string hash (djb2 variant). Fast, no deps.
 */
export function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

/**
 * Content hash cache for staleness detection.
 *
 * Records content hashes when files are read, so we can detect when
 * the model tries to edit a file whose content has changed since it
 * was last read.
 *
 * Pure state container — no I/O.
 */
export class ContentHashCache {
  /** path → content hash (using simple string hash) */
  private hashes = new Map<string, string>();
  /** path → turn index when last read */
  private readTurns = new Map<string, number>();

  /** Check if a file has ever been read in this session. */
  wasEverRead(filePath: string): boolean {
    return this.readTurns.has(filePath);
  }

  /** Set the current hash for a file path. */
  setHash(filePath: string, content: string): void {
    this.hashes.set(filePath, simpleHash(content));
  }

  /** Record that a file was read at a given turn. */
  recordRead(filePath: string, turn: number): void {
    this.readTurns.set(filePath, turn);
  }

  /**
   * Check if a file's content has changed since it was last recorded.
   * @returns true if the file has been modified after the last recorded read
   */
  isStale(filePath: string, currentContent: string): boolean {
    const recordedHash = this.hashes.get(filePath);
    if (recordedHash === undefined) return false; // never read, never stale
    return recordedHash !== simpleHash(currentContent);
  }

  /** Get the turn when the file was last read (or -1). */
  getLastReadTurn(filePath: string): number {
    return this.readTurns.get(filePath) ?? -1;
  }

  /** Clear all cached data. */
  reset(): void {
    this.hashes.clear();
    this.readTurns.clear();
  }

  /** Track the current files in the cache (for diagnostics). */
  get trackedFiles(): number {
    return this.hashes.size;
  }
}
