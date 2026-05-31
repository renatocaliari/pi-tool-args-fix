/**
 * Tool error classifier — pure pattern-matching error classification + CLI help text.
 *
 * Zero dependencies on recorder internals. Designed for testability.
 */

import { isEisdirError } from "../repairs.js";

// ─── Schema Error Translation ────────────────────────────────────────────

/**
 * Translate a JSON Schema validation error into LLM-friendly language.
 *
 * Raw schema errors use JSON Pointer paths ("edits.0.oldText") which are
 * optimized for developer debugging, not for AI self-correction.
 * This function rewrites common patterns into plain instructions.
 *
 * Returns null if no translation rule applies (let the raw error through).
 */
export function translateSchemaValidationError(errorText: string): string | null {
	if (!errorText) return null;

	const lower = errorText.toLowerCase();

	// Pattern: "edits.0.oldText: must have required properties oldText, newText"
	// The schema says edits[0] IS an object that needs oldText+newText, but the model sent {}
	// JSON Pointer path "edits.0.oldText" suggests edits[0] has .oldText — confusing.
	if (lower.includes("must have required properties")) {
		// Extract the field path (before colon) and the missing property names (after colon)
		const colonIdx = errorText.indexOf(":");
		if (colonIdx !== -1) {
			const pointerPath = errorText.slice(0, colonIdx).trim();
			// Convert "edits.0.oldText" → "edits[0]" (strip trailing property name)
			const arrayMatch = pointerPath.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\.(\d+)\.([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
			if (arrayMatch) {
				const [, arrayName, index] = arrayMatch;
				const missing = errorText.slice(colonIdx + 1).trim();
				return `${arrayName}[${index}] is missing required fields: ${missing}`;
			}
			// Simple path like "path" or "edits" — just "<field> is missing"
			const simpleMatch = pointerPath.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/);
			if (simpleMatch) {
				const missing = errorText.slice(colonIdx + 1).trim();
				return `Missing required argument: "${pointerPath}" (${missing})`;
			}
		}
	}

	// Pattern: "path: must have required properties path"
	// The root object has a property "path" that is itself required — but the model
	// omitted the entire argument. The "path: must have required properties path"
	// message is circular/confusing.
	if (lower.includes("must have required properties")) {
		return null; // fall through to generic guidance
	}

	return null;
}


// ─── Blindspot Suggestions ───────────────────────────────────────────────

/** Blindspot suggestions mapped by category. */
export const BLINDSPOT_SUGGESTIONS: Record<string, string> = {
  EISDIR: "✅ Already handled: directory-listing fallback for read/read_file. Consider expanding to write tool and bash cd cases.",
  ENOENT: "Pre-execution path validation: extract all paths from args, check existence before tool runs, try variations (relative, extension variants, fuzzy fffind match), and return tool error with alternatives.",
  timeout: "Auto-timeout injection: detect long-running command patterns (build, test, lint, piped commands) and inject timeout_seconds=300+ when missing or too short.",
  "400": "Inspect request schema: model may be sending extra/malformed parameters. Add schema validation upstream.",
  SCHEMA_VALIDATION: "The model sent arguments violating the tool's JSON schema. Consider adding field-level truncation for maxLength constraints, or enum validation.",
  CONSECUTIVE_LOOP: "Circuit breaker: after 3+ consecutive identical failures, inject tool-specific contextual guidance. After 7+, return permanent error forcing strategy change.",
  EMPTY_RESULT: "The tool returned successfully but with empty output — this can trigger silent loops where the model varies parameters endlessly looking for results.",
  EDIT_MISMATCH: "Staleness check: before edit, verify file content hash matches what was last read. On mismatch, return tool error with 'file changed since last read — re-read first'.",
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
  // "Tool X not found" errors are tool-not-found, not file-not-found
  if (lower.includes("tool ") && lower.includes(" not found")) return null;
  if (lower.includes("no such file") || lower.includes("not found") || lower.includes("enoent")) return "ENOENT";
  if (lower.includes("permission denied") || lower.includes("eacces") || lower.includes("eperm")) return "EACCES";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("bad request") || lower.includes("400")) return "bad_request";
  // Edit text mismatch — model tried to replace text that doesn't match, is identical, or is non-unique
  if (lower.includes("could not find the exact text") || lower.includes("could not find edits") || lower.includes("oldtext does not match") || lower.includes("replacement produced identical content") || lower.includes("no changes made to") || lower.includes("occurrences of the text") || (lower.includes("found ") && lower.includes(" occurrences of edits["))) return "EDIT_MISMATCH";
  // Schema validation errors — model sent arguments that violate the tool's JSON schema
  if (lower.includes("validation failed") || lower.includes("must have required properties") || lower.includes("must not have more than") || lower.includes("must not have fewer than") || lower.includes("must have less than") || lower.includes("must have more than") || lower.includes("must be one of") || lower.includes("must match")) return "SCHEMA_VALIDATION";
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
  const common =
    `The "${toolName}" tool failed. Generic guidance for any tool:` +
    `\n` +
    `\nPossible causes:` +
    `\n  - Invalid parameter names or types (check the tool\'s schema and available parameters)` +
    `\n  - Wrong argument format, value, or data type for a parameter` +
    `\n  - The tool\'s preconditions are not met (file not found, service unavailable, missing dependency)` +
    `\n  - The model passed parameters the tool does not accept (extra/unexpected fields)` +
    `\n` +
    `\nTo debug:` +
    `\n  1. Read the error message carefully — it often says exactly what went wrong` +
    `\n  2. Check parameter names: use exactly what the tool definition says, not synonyms` +
    `\n  3. Simplify: call the tool with the minimum required parameters first` +
    `\n  4. Try running the tool with --help:` +
    `\n     { "args": ["--help"] } for extension tools, or "toolname --help" for CLI tools` +
    `\n  5. If the error says something specific (\"Element not found\", \"invalid flag\", etc.),` +
    `\n     address that exact issue — don\'t retry blindly with the same arguments` +
    `\n` +
    `\nDo NOT keep retrying the same failing pattern. Change the approach.`;

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
        `The edit tool replaces exact text in a file.` +
        `\nPossible failure modes:` +
        `\n  1. oldText NOT FOUND in the file → re-read the file and check whitespace/indentation` +
        `\n  2. oldText == newText (identical content) → the replacement would be a no-op; use a real different newText` +
        `\n  3. oldText matches MULTIPLE locations → add more surrounding context lines to make it unique` +
        `\n` +
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
        `The tool rejected the arguments due to a schema validation error.` +
        `\nPossible causes:` +
        `\n  1. A required field is missing — add it with the correct value` +
        `\n  2. A field value exceeds maximum length — truncate or shorten it` +
        `\n  3. Invalid enum value — pick one from the allowed list` +
        `\n  4. Wrong data type — use the expected type (e.g. string, not number)` +
        `\n  5. Unexpected extra field — remove fields not in the tool definition` +
        `\nTo fix: review each argument against the tool's parameter requirements.` +
        `\nTip: remove any optional fields you're unsure about — send only what's required.`
      );
    default:
      return null;
  }
}
