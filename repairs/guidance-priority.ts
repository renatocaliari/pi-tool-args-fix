/**
 * Guidance priority classification — determines which guidance items to
 * keep/drop when the injection cap is exceeded.
 *
 * Pure function — no I/O, no side effects. Deterministic: same text →
 * same priority every time.
 *
 * Priority bands:
 *   0 = circuit breaker (must force strategy change)
 *   1 = staleness (file changed, must re-read)
 *   2 = sequential overlap (editing without re-reading)
 *   3 = EDIT_MISMATCH (wrong file, non-unique, edit loop)
 *   4 = path validation
 *   5 = empty search loop
 *   6 = tool help (getToolHelp, getErrorGuidance)
 *   7 = generic / informational
 *
 * Lower number = higher priority (kept first).
 * Drops LOWEST priority items first when under cap pressure.
 */
export function getGuidancePriority(text: string): number {
  if (text.includes("\uD83D\uDD34 CIRCUIT BREAKER")) return 0;
  if (text.includes("\u26A0\uFE0F File content has changed")) return 1;
  if (text.includes("\u26A0\uFE0F You are editing the same region")) return 2;
  // EDIT_MISMATCH group: wrong file, non-unique, edit loop
  if (
    text.includes("DIFFERENT file") ||
    text.includes("oldText matched") ||
    text.includes("Multiple consecutive failures") ||
    text.includes("\u26A0\uFE0F Repeated attempts to edit")
  ) return 3;
  if (text.includes("\u26A0\uFE0F Path validation")) return 4;
  if (text.includes("returned no results")) return 5;
  if (text.startsWith("The ")) return 6; // tool help
  return 7; // generic
}
