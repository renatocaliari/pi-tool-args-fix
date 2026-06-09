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

	// Pattern: "edits[0] and edits[1] overlap in /path/to/file"
	// The model sent multiple edits whose oldText regions overlap.
	if (lower.includes("overlap")) {
		const fileMatch = errorText.match(/overlap in (\/[^\s]+\.\w+)/);
		const file = fileMatch ? fileMatch[1].trim() : "(unknown)";
		const editMatch = errorText.match(/(edits\[\d+\]\s*and\s*edits\[\d+\])/);
		const edits = editMatch ? editMatch[1] : "edits";
		return `${edits} target overlapping regions in ${file}. Merge them into one edit or make each edits[i].oldText target a unique, non-overlapping part of the file.`;
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
  ENOENT: "Pre-execution path validation: extract all paths from args, check existence before tool runs, try variations (relative path, extension variants, fuzzy match), and return tool error with alternatives.",
  timeout: "Auto-timeout injection: detect long-running command patterns (build/test → 300s, generate/deploy → 120s) and pipe-only commands (grep/cat/sort → 60s) and inject timeout_seconds when missing or too short.",
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
  const lower = errorText.toLowerCase();
  // Build/runtime conflicts — output path is a directory, port in use, etc.
  // IMPORTANT: check BEFORE isEisdirError() since "is a directory" is a superset;
  // BUILD_CONFLICT is more specific (build output, not a read).
  if (lower.includes("already exists and is a directory") || lower.includes("build output")) return "BUILD_CONFLICT";
  if (isEisdirError(errorText)) return "EISDIR";
  // "Tool X not found" errors: tool/extension not registered, not file-not-found
  if (lower.includes("tool ") && lower.includes(" not found")) return "TOOL_NOT_FOUND";
  if (lower.includes("no such file") || lower.includes("not found") || lower.includes("enoent")) return "ENOENT";
  if (lower.includes("permission denied") || lower.includes("eacces") || lower.includes("eperm")) return "EACCES";
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("rate limit") || lower.includes("429")) return "rate_limit";
  if (lower.includes("bad request") || lower.includes("400")) return "bad_request";
  // Invalid CLI arguments — wrong flag, unknown option, illegal option
  if (lower.includes("illegal option") || lower.includes("unknown option") || lower.includes("unrecognized") || lower.includes("invalid option") || lower.includes("invalid argument")) return "INVALID_ARG";
  // Git push/pull conflicts — rejected pushes, non-fast-forward
  if (lower.includes("failed to push") || lower.includes("updates were rejected") || lower.includes("fetch first") || lower.includes("non-fast-forward") || lower.includes("non fast forward") || lower.includes("fast-forward")) return "GIT_REJECTED";
  // Edit text mismatch — model tried to replace text that doesn't match, is identical, is non-unique, or overlaps
  if (lower.includes("could not find the exact text") || lower.includes("could not find edits") || lower.includes("oldtext does not match") || lower.includes("replacement produced identical content") || lower.includes("no changes made to") || lower.includes("occurrences of the text") || lower.includes("overlap") || (lower.includes("found ") && lower.includes(" occurrences of edits["))) return "EDIT_MISMATCH";
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
 *
 * Cache-friendly: output is a function of (toolName, failedCommand)
 * only. `failedCommand` is a categorical input from the model — the same
 * command on a replayed session produces the same text. The first 100
 * chars of failedCommand are deterministic for the same model output.
 * Same tool + same failed command → same string → prefix cache hit.
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
        `  - Invalid arguments to the command (check flags and syntax)\n` +
        `  - Environment issue (missing variable, wrong directory)\n` +
        `To debug, try: running the command with simpler arguments, checking the exact error message, or using 'command --help'`
      );
    case "grep":
      return (
        `The grep tool searches for patterns in files.` +
        `\n  - Exit code 0: match(es) found` +
        `\n  - Exit code 1: no matches found (this is NORMAL, not an error)` +
        `\n  - Exit code 2: error (e.g. file not found, invalid pattern)` +
        `\nTip: If the pattern wasn't found, try a broader pattern, check the file path, or use grep -i for case-insensitive search.` +
        `\n` +
        `\n🔁 Alternatives if grep keeps returning nothing:` +
        `\n  • The file may use a different name than expected (check exact spelling)` +
        `\n  • The file may use snake_case, kebab-case, or a different path prefix` +
        `\n  • Try listing the parent directory with ls first to see actual files` +
        `\n  • Search for a shorter/more generic term (part of the name, not the full name)` +
        `\n  • Use 'ls' to list a known directory containing the expected file`
      );
    case "find":
      return (
        `The find tool searches for files/directories matching criteria.` +
        `\n  - Exit code 0: results found (or no criteria matched)` +
        `\n  - Exit code 1: no files matched (this is NORMAL)` +
        `\nTip: If nothing was found, try broadening the search path or using less restrictive filters.` +
        `\n` +
        `\n🔁 Alternatives if find keeps returning nothing:` +
        `\n  • The file may use a different naming convention than expected` +
        `\n  • Try searching for just PART of the filename, not the full name` +
        `\n  • Use grep -r on a directory to search file contents` +
        `\n  • List the parent directory with ls to discover actual filenames` +
        `\n  • Check if the file is in a different location (use ls on sibling dirs)` +
        `\nDo NOT keep retrying find with minor glob variations — change your strategy.`
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
        `\n  4. edits overlap (edits[N] and edits[M] share content) → merge overlapping edits into one edit block, or make each edits[i].oldText target a unique, non-overlapping region` +
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
 *
 * Cache-friendly: output is a function of (category, toolName) only.
 * For TOOL_NOT_FOUND, the tool name is included in the static text.
 * No turn counts, failure counts, or other session state appear in output.
 * Same category + same tool → same string → prefix cache hit.
 */
export function getErrorGuidance(category: string, _toolName?: string): string | null {
  switch (category) {
    case "TOOL_NOT_FOUND":
      return (
        `The "${_toolName}" tool was not found by the runtime. This means the tool or extension that provides it is not registered in the current session.` +
        `\nPossible causes:` +
        `\n  1. The package that provides this tool is not installed` +
        `\n  2. The extension failed to load (init error, missing dependency, runtime crash)` +
        `\n  3. Some sessions may load extensions differently` +
        `\n` +
        `\nTo debug:` +
        `\n  1. Check installed packages: pi list` +
        `\n  2. Try /reload to discover and reinitialize extensions` +
        `\n  3. Use an alternative tool to accomplish the same goal` +
        `\n` +
        `\nDo NOT keep retrying the same missing tool. Change your approach.`
      );
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
    case "INVALID_ARG":
      return (
        `The command failed because of an invalid argument or flag.` +
        `\nCommon causes:` +
        `\n  - The flag doesn\'t exist on this platform (e.g. \`cat -A\` is GNU-only, not available on macOS)` +
        `\n  - Typo in the flag name or value` +
        `\n  - Wrong syntax (e.g. missing value after a flag)` +
        `\nTo fix: check the command\'s usage with \`--help\` and use only flags that exist on your system.` +
        `\nOn macOS, prefer native equivalents of GNU tools where possible.`
      );
    case "BUILD_CONFLICT":
      return (
        `The build command failed because of a file or directory conflict.` +
        `\nCommon causes:` +
        `\n  - Build output path is a directory (not a file) — use \`-o /dev/null\` or a different output path` +
        `\n  - A stale output directory exists — remove it with \`rm -rf\` first` +
        `\n  - Another process holds the file` +
        `\nTo fix: specify a valid output path. For Go: \`go build -o /dev/null ./cmd/web/\`` +
        `\nOr remove the stale output: \`rm -rf <output>\` before rebuilding.`
      );
    case "GIT_REJECTED":
      return (
        `Git rejected the push because the remote has commits the local branch doesn\'t.` +
        `\nThis is normal when working in a shared branch — another push happened since your last pull.` +
        `\nTo fix:` +
        `\n  1. \`git pull --rebase origin <branch>\` to integrate remote changes` +
        `\n  2. Then \`git push origin <branch>\` again` +
        `\nThe rebase applies your local commits on top of the remote, keeping history linear.`
      );
    default:
      return null;
  }
}
