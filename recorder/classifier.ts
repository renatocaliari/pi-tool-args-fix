/**
 * Tool error classifier — pure pattern-matching error classification + CLI help text.
 *
 * Zero dependencies on recorder internals. Designed for testability.
 */

import { isEisdirError } from "../repairs.js";

// ─── Blindspot Suggestions ───────────────────────────────────────────────

/** Blindspot suggestions mapped by category. */
export const BLINDSPOT_SUGGESTIONS: Record<string, string> = {
  EISDIR: "Add directory-listing fallback for read tool (similar to current EISDIR handler but as a documented pattern check).",
  ENOENT: "Consider fuzzy path matching: retry with relative path, check common parent dirs.",
  timeout: "Add auto-timeout extension for known long-running tools (build, test, lint).",
  "400": "Inspect request schema: model may be sending extra/malformed parameters. Add schema validation upstream.",
  SCHEMA_VALIDATION: "The model sent arguments violating the tool's JSON schema. Consider adding field-level truncation for maxLength constraints, or enum validation.",
  CONSECUTIVE_LOOP: "The model is calling the same tool repeatedly with identical arguments and every call fails. The failure tracker can inject guidance or circuit-break after N attempts.",
  EMPTY_RESULT: "The tool returned successfully but with empty output — this can trigger silent loops where the model varies parameters endlessly looking for results.",
  model_null_field: "Add null-stripping in tool_call handler (already done for some fields — expand coverage to all optional fields).",
  model_domain_list: "Add comma/space-split to array repair (already done for some fields — verify field name coverage).",
  model_bare_array: "Add bare-string → array wrapping for this field (check ARRAY_FIELD_NAMES coverage).",
  model_json_string: "Add JSON string parsing for deeply nested stringified objects.",
  model_extra_props: "Add extra-property stripping in array items for this field (check ARRAY_ITEM_SCHEMAS coverage).",
  model_boolean_string: "Add boolean coercion for this field (check BOOLEAN_FIELD_NAMES coverage).",
  model_number_string: "Add number coercion for this field (check NUMBER_FIELD_NAMES coverage).",
};

/** Get a suggestion text for a blindspot category. */
export function getSuggestion(category: string, toolName: string): string {
  if (BLINDSPOT_SUGGESTIONS[category]) return BLINDSPOT_SUGGESTIONS[category];
  return `Investigate ${toolName} errors with category "${category}" — no predefined suggestion exists.`;
}

// ─── Error Classification ────────────────────────────────────────────────

/**
 * Classify a tool result error message into a canonical error type.
 * Used for blindspot detection and error aggregation.
 *
 * This is a pure pattern-matching function — it NEVER looks at toolName.
 * That keeps it generic: any tool's error text is classified identically.
 */
export function classifyErrorType(errorText: string | null): string | null {
  if (!errorText) return null;
  if (isEisdirError(errorText)) return "EISDIR";
  const lower = errorText.toLowerCase();
  if (lower.includes("no such file") || lower.includes("not found") || lower.includes("enoent")) return "ENOENT";
  if (lower.includes("permission denied") || lower.includes("eacces") || lower.includes("eperm")) return "EACCES";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("bad request") || lower.includes("400")) return "bad_request";
  // Edit text mismatch — model tried to replace text that doesn't match exactly
  if (lower.includes("could not find the exact text") || lower.includes("could not find edits") || lower.includes("oldtext does not match")) return "EDIT_MISMATCH";
  // Schema validation errors — model sent arguments that violate the tool's JSON schema
  if (lower.includes("validation failed") || lower.includes("must not have more than") || lower.includes("must not have fewer than") || lower.includes("must have less than") || lower.includes("must have more than") || lower.includes("must be one of") || lower.includes("must match")) return "SCHEMA_VALIDATION";
  // HTTP status codes in error text
  const httpMatch = lower.match(/\b([45]\d{2})\b/);
  if (httpMatch) return `HTTP_${httpMatch[1]}`;
  return null;
}

// ─── CLI Help Text ───────────────────────────────────────────────────────────

/**
 * Return contextual guidance text for a native CLI tool.
 * Used when a CLI tool fails consecutively — instead of showing a bare
 * error, the model gets structured guidance on how to use the tool.
 */
export function getToolHelp(toolName: string, failedCommand?: string): string {
  const common = "Consider checking the command syntax, file paths, and permissions.";

  switch (toolName) {
    case "bash":
      return (
        `The bash tool runs shell commands. It exited with a non-zero status.` +
        (failedCommand
          ? ` The failed command was: ${failedCommand.slice(0, 100)}`
          : "") +
        ` Possible causes:\n` +
        `  - Command not found or typo in command name\n` +
        `  - File or directory not found\n` +
        `  - Permission denied (not executable / restricted path)\n` +
        `  - Invalid arguments to the command\n` +
        `  - Exit code 1 is normal for grep (no matches), find (empty), diff (difference)\n` +
        `To debug, try: running the command with simpler arguments, checking file paths, or using 'command --help'`
      );
    case "grep":
      return (
        `The grep tool searches for patterns in files.` +
        `\n  - Exit code 0: match(es) found` +
        `\n  - Exit code 1: no matches found (this is NORMAL, not an error)` +
        `\n  - Exit code 2: error (e.g. file not found, invalid pattern)` +
        `\nTip: If the pattern wasn't found, try a broader pattern, check the file path, or use grep -i for case-insensitive search.`
      );
    case "find":
      return (
        `The find tool searches for files/directories matching criteria.` +
        `\n  - Exit code 0: results found (or no criteria matched)` +
        `\n  - Exit code 1: no files matched (this is NORMAL)` +
        `\nTip: If nothing was found, try broadening the search path or using less restrictive filters.`
      );
    case "ls":
      return (
        `The ls tool lists directory contents.` +
        `\n  - Exit code 0: success` +
        `\n  - Exit code 1: minor issue (e.g. no match with glob pattern — NORMAL)` +
        `\nTip: Check the directory path exists and you have read permission.`
      );
    case "edit":
      return (
        `The edit tool replaces exact text in a file. It failed because the oldText was not found.` +
        `\nCommon causes:` +
        `\n  - The text has already been modified by a previous edit` +
        `\n  - The text differs from the file content (whitespace, quotes, indentation)` +
        `\n  - The file was modified externally` +
        `\nTo fix: read the file first with the read tool to get the current content, then use the exact text as oldText.`
      );
    case "read":
      return (
        `The read tool reads file contents.` +
        `\nCommon issues:` +
        `\n  - File does not exist (check the path)` +
        `\n  - Permission denied (check file permissions)` +
        `\n  - Directory passed instead of file (use ls to list directory contents)`
      );
    case "write":
      return (
        `The write tool creates or overwrites a file.` +
        `\nCommon issues:` +
        `\n  - Permission denied (check directory permissions)` +
        `\n  - Directory does not exist (create parent directories first)`
      );
    default:
      return common;
  }
}

/**
 * Return contextual guidance text for a specific error category (not tool-specific).
 * Used when an error type like SCHEMA_VALIDATION occurs — the model gets structured
 * advice about what went wrong and how to fix it.
 * Returns null for error categories that have no predefined guidance.
 */
export function getErrorGuidance(category: string, _toolName?: string): string | null {
  switch (category) {
    case "SCHEMA_VALIDATION":
      return (
        `The tool rejected the arguments due to a schema validation error. This is a permanent error — retrying the same arguments will not help.` +
        `\nPossible causes:` +
        `\n  - Required field missing from the arguments` +
        `\n  - Field value exceeds maximum length constraints` +
        `\n  - Invalid enum value (not in the allowed list)` +
        `\n  - Wrong data type for a field (expected string, got number)` +
        `\n  - Unexpected extra field not in the tool's definition` +
        `\nTo fix: review the tool's parameter requirements and ensure every argument is valid.` +
        `\nTip: remove any extra fields not explicitly required by the tool definition.`
      );
    default:
      return null;
  }
}
