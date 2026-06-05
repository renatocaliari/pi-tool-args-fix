/**
 * Guidance message builders.
 *
 * Pure functions that produce human-readable guidance strings for various
 * tool failure modes — preventing the LLM from blindly retrying the same
 * broken approach.
 */

// ─── Path Validation Guidance ──────────────────────────────────────────

/**
 * Build path validation guidance for tool error message.
 * Pure function — no I/O.
 */
export function buildPathValidationGuidance(
  invalidPaths: string[],
  _toolName: string,
): string {
  const pathList = invalidPaths.map(p => `  - ${p}`).join("\n");
  return [
    `⚠️ Path validation: ${invalidPaths.length} path(s) not found.`,
    pathList,
    "",
    "Possible fixes:",
    "  • Check the file path spelling",
    "  • The file may be in a different directory",
    "  • You may need to create the file first (use write tool)",
    "  • Use fffind or ls to discover the correct path",
  ].join("\n");
}

// ─── Staleness Guidance ────────────────────────────────────────────────

/**
 * Build staleness guidance for edit tool when content hash has changed.
 *
 * Cache-friendly: output is a fixed string with no dynamic state.
 * Same error → same string → DeepSeek prefix cache hit.
 */
export function buildStalenessGuidance(): string {
  return [
    `⚠️ File content has changed since it was last read.`,
    "The edit may overwrite newer content or the oldText no longer matches.",
    "Please re-read the file first with the read tool to get current content,",
    "then apply the edit with the exact current text as oldText.",
  ].join("\n");
}

// ─── Circuit Break Guidance ────────────────────────────────────────────

/**
 * Build circuit break message for the LLM (7+ consecutive failures).
 *
 * Cache-friendly: output is a fixed string per tool. Identical text is
 * returned for 7+, 8+, 9+ failures — only the tool name varies.
 */
export function buildCircuitBreakMessage(toolName: string): string {
  return [
    `🔴 CIRCUIT BREAKER: Tool "${toolName}" has failed multiple consecutive times.`,
    "The current approach is not working and further retries will not help.",
    "Please switch to a completely different strategy:",
    "  • If editing: use the write tool to create a new version of the file",
    "  • If reading: verify the path exists (use ls or fffind)",
    "  • If running a command: simplify the command or check syntax",
    "  • Move on to a different task entirely",
  ].join("\n");
}

// ─── Edit Loop Guidance ────────────────────────────────────────────────

/**
 * Build edit_file loop guidance (3+ or 5+ consecutive failures).
 *
 * Cache-friendly: returns one of two FIXED strings — "major" (5+ failures)
 * or "minor" (3-4 failures). No attempt count is included in the output.
 * Same threshold + tool state → same text.
 */
export function buildEditLoopGuidance(consecutiveCount: number): string {
  if (consecutiveCount >= 5) {
    return [
      `⚠️ Repeated attempts to edit the same file with the same arguments have failed.`,
      "The edit is clearly not matching the current file content.",
      "Consider an alternative approach:",
      "  • Read the file first with the read tool, then re-apply the edit with exact text",
      "  • Use the write tool to write the entire file content (if you know the full content)",
      "  • Create a new file instead of modifying an existing one",
    ].join("\n");
  }
  return [
    `💡 Tip: Multiple consecutive failures on this file.`,
    "The oldText may have whitespace differences (tabs vs spaces, trailing spaces).",
    "Read the file and check indentation carefully.",
  ].join("\n");
}

// ─── Ordinal Suffix ────────────────────────────────────────────────────

/** Format a number with ordinal suffix (1st, 2nd, 3rd, 4th, etc.). */
export function ordinalSuffix(n: number): string {
  // Teens (11-13) are always "th"
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return n + "th";
  const last = n % 10;
  if (last === 1) return n + "st";
  if (last === 2) return n + "nd";
  if (last === 3) return n + "rd";
  return n + "th";
}

// ─── Sequential Edit Overlap Guidance ──────────────────────────────────

/**
 * Build sequential edit overlap guidance.
 *
 * Warns when consecutive edits target overlapping region of the same file
 * without an intervening read.
 *
 * Cache-friendly: the `consecutiveCount` parameter is accepted for backward
 * compatibility but is NOT included in the output. Same previous/current
 * first lines + same file path → same string. Note: the categorical
 * inputs themselves (filePath, prevOldTextFirstLine, currentOldTextFirstLine)
 * ARE variable per session, but they are inputs from the model (file
 * contents), not internal state — so identical model inputs produce
 * identical guidance.
 */
export function buildSequentialEditGuidance(
  prevOldTextFirstLine: string,
  currentOldTextFirstLine: string,
  filePath: string,
  _consecutiveCount?: number,
): string {
  return [
    `⚠️ You are editing the same region of \`${filePath}\` again without re-reading.`,
    `Previous edit targeted content starting with:`,
    `  "${prevOldTextFirstLine}"`,
    `This edit targets content starting with:`,
    `  "${currentOldTextFirstLine}"`,
    `Since the previous edit already changed this region, the current oldText likely no longer matches.`,
    "",
    "Please re-read the file first with the read tool to get the current content,",
    "then re-apply the edit with exact oldText matching the current file.",
  ].join("\n");
}

// ─── Edit Mismatch Extractors ─────────────────────────────────────────

/**
 * Extract the edit index from an EDIT_MISMATCH error text.
 * Returns undefined if the error is not about a specific edit index
 * (e.g., it's about "the exact text" for single-edits without an array).
 */
export function extractFailedEditIndex(errorText: string): number | undefined {
  if (!errorText) return undefined;
  const match = errorText.match(/edits\[(\d+)\]/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return undefined;
}

/**
 * Extract the file path from an EDIT_MISMATCH error text.
 * Returns undefined if no path is found.
 */
export function extractFailedEditPath(errorText: string): string | undefined {
  if (!errorText) return undefined;
  // Match capture after "in ": greedy \S+ grabs all non-whitespace,
  // then we strip trailing dot if present (sentence separator, not part of path)
  const match = errorText.match(/in\s+(\S+)/);
  if (match) {
    let p = match[1];
    // Remove trailing quotes that appeared in truncated test strings
    if (p.endsWith('"')) p = p.slice(0, -1);
    // Remove trailing dot followed by space or end (sentence separator)
    if (p.endsWith('.')) p = p.slice(0, -1);
    return p;
  }
  return undefined;
}

// ─── Edit Mismatch Context Builder ────────────────────────────────────

/**
 * Build edit mismatch context from file content and oldText.
 * Returns context lines around the closest match to oldText.
 */
export function buildEditMismatchContext(
  fileContent: string,
  oldText: string,
): { contextLines: string; matchLine: number } | null {
  const lines = fileContent.split("\n");
  const oldFirstLine = oldText.split("\n")[0].trim();
  if (!oldFirstLine) return null;

  const prefix = oldFirstLine.slice(0, 40);
  const matchLine = lines.findIndex(l => l.trim().startsWith(prefix));
  if (matchLine === -1) return null;

  const start = Math.max(0, matchLine - 2);
  const end = Math.min(lines.length, matchLine + 4);
  const contextLines = lines.slice(start, end).map((l, i) => {
    const lineNum = start + i + 1;
    const marker = start + i === matchLine ? " →" : "  ";
    return `${marker} ${String(lineNum).padStart(4)}│ ${l}`;
  }).join("\n");

  return { contextLines, matchLine };
}

// ─── Enhanced Edit Mismatch Guidance ──────────────────────────────────

/**
 * Build the full enhanced EDIT_MISMATCH guidance string by combining
 * base guidance with file context from buildEditMismatchContext.
 */
export function buildEnhancedEditMismatchGuidance(
  baseGuidance: string,
  context: { contextLines: string; matchLine: number },
): string {
  return [
    baseGuidance,
    "",
    `📄 File context around the closest match to oldText:`,
    "```",
    context.contextLines,
    "```",
    `Note: line ${context.matchLine + 1} starts similarly to your oldText, but the exact`,
    `text does not match. Read the file to see the full content before editing.`,
  ].join("\n");
}

// ─── Non-Unique Edit Count ────────────────────────────────────────────

/**
 * Extract the non-unique occurrence count from an edit error message.
 * Matches patterns like "Found 4 occurrences of edits[3] in ..."
 */
export function extractNonUniqueEditCount(errorMessage: string | null): number | undefined {
  if (!errorMessage) return undefined;
  // Match both "Found 4 occurrences" and "Found 1 occurrence"
  const match = errorMessage.match(/Found (\d+) occurrences?/);
  return match ? parseInt(match[1], 10) : undefined;
}

// ─── OldText Match ───────────────────────────────────────────────────

interface OldTextMatch {
  lineNumbers: number[];
  prefix: string;
}

/**
 * Find all lines in a string that start with a given prefix.
 * Used when edit.oldText matches multiple locations.
 */
export function findAllOldTextMatchLines(
  content: string,
  oldText: string
): OldTextMatch | null {
  if (!oldText || !content) return null;
  // Use the first line of oldText as the prefix (trimmed)
  const prefix = oldText.split("\n")[0].trim();
  if (!prefix) return null;
  const lines = content.split("\n");
  const lineNumbers: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(prefix)) {
      lineNumbers.push(i);
    }
  }

  if (lineNumbers.length === 0) return null;
  return { lineNumbers, prefix };
}

// ─── Non-Unique Edit Guidance ─────────────────────────────────────────

/**
 * Build guidance for when an edit.oldText matches multiple locations.
 */
export function buildEditNonUniqueGuidance(
  content: string,
  oldText: string,
  matchCount: number
): string | null {
  const result = findAllOldTextMatchLines(content, oldText);
  if (!result) return null;

  const firstLine = oldText.split("\n")[0].trim();
  const lines = content.split("\n");
  const prefix = firstLine;

  return [
    `Note: oldText matched ${matchCount} time(s) in the file. Try to add more context surrounding your edit to make oldText unique.`,
    "",
    `Prefix: "${prefix}"`,
    "Matching locations:",
    ...result.lineNumbers.map((ln, i) => {
      const start = Math.max(0, ln - 1);
      const end = Math.min(lines.length, ln + 2);
      const snippet = lines.slice(start, end).join("\n");
      return `  ${i + 1}. → (line ${ln + 1}):\n${snippet}`;
    }),
    "",
    `Recommended: add more surrounding context to your oldText so it matches only one location.`,
    "",
    "Tips to make your oldText unique:",
    "  • Include the line BEFORE and AFTER your edit target",
    "  • Use more lines of context",
    "  • Include indentation exactly as it appears in the file",
  ].join("\n");
}

// ─── Empty Search Guidance ────────────────────────────────────────────

/**
 * Build guidance for consecutive empty search results (find/grep/ls returning nothing).
 * Injected when the model searches for the same concept 3+ times with no results.
 *
 * Cache-friendly: output is a function of (pattern, toolName) only. Same
 * pattern + same tool → same string. This is intentional: once the
 * threshold is hit, the guidance should be stable across turns (the model
 * gets the same "change strategy" reminder every time the loop continues).
 */
export function buildEmptySearchGuidance(pattern: string, toolName?: string): string {
  const lines = [
    `⚠️  ${toolName ?? "search"} "${pattern.slice(0, 80)}" returned no results.`,
    `The search pattern is not matching any files.`,
    `Retrying with the same pattern (or minor variations) will keep failing.`,
    ``,
    `Possible causes:`,
    `  • The file uses a different name than expected (check exact spelling)`,
    `  • The file may use snake_case, kebab-case, or a different path prefix`,
    `  • The file might not exist yet (needs to be created)`,
    `  • The pattern might be too narrow — try listing the directory first`,
    `  • You may be looking in the wrong directory`,
    ``,
    `Try:`,
    `  • Use ls to list the parent directory and discover the actual filename`,
    `  • Search for a shorter or more generic term (part of the name, not the full name)`,
    `  • Use read on a known nearby file to confirm the directory structure`,
    ``,
    `Do NOT keep retrying the same ${toolName ?? "search"} pattern. Change strategy now.`,
  ].join("\n");
  return lines;
}

// ─── Wrong File Edit Guidance ─────────────────────────────────────────

/**
 * Build guidance suggesting an edit might target the wrong file.
 * @param errorPath The path from the error message
 * @param inputPath Optional path the user specified in the input
 */
export function buildEditWrongFileGuidance(errorPath: string, inputPath?: string): string {
  const lines: string[] = [
    `Note: The edit to "${errorPath}" appears to target a DIFFERENT file.`,
    "Your oldText matches content in another file, not the one you specified.",
    "",
    "Possible causes:",
    "  1. You're editing the wrong file — re-read the file to verify",
    "  2. File content changed — re-read the file",
    "  3. Whitespace mismatch — check indentation and trailing spaces",
    "",
    "Possible fixes:",
    "  1. Change the path to point to the correct file",
    "  2. split into separate edit calls for each file",
  ];

  if (inputPath && inputPath !== errorPath) {
    lines.push(`  3. These differ: error path "${errorPath}" vs input path "${inputPath}" — verify you are editing the intended file`);
  }

  return lines.join("\n");
}
