/**
 * Repair Layer Extension
 *
 * Intercepts tool calls and repairs common LLM argument mistakes before execution.
 * Inspired by Ahmad Awais's tool-input repair layer for CommandCode:
 *   https://x.com/mrahmadawais/status/2050956678502420612
 *
 * Core insight: "open model bad at tool calling" is almost always a harness problem.
 * A small set of finite, compositional failure modes repeats across models.
 *
 * Repairs applied (validate-then-repair philosophy):
 *   1. Strip `null` from optional fields (omit instead of sending null)
 *   2. Parse stringified JSON arrays/objects ("['a','b']" → ["a","b"])
 *   3. Wrap bare strings where arrays are expected ("foo" → ["foo"])
 *   4. Wrap objects where arrays are expected ({a:1} → [{a:1}])
 *   5. Unwrap markdown auto-links from path fields ([file.md](url) → file.md)
 *   6. Relational defaults (read_file: limit-only → offset=1; offset-only → limit=2000)
 *
 * Safety: content fields (command text, file content, oldText, newText, code, etc.)
 * are NEVER touched. Only structural/container fields are repaired.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

// ─── Field Classification ────────────────────────────────────────────────

const PATH_FIELD_NAMES = new Set([
	"path",
	"absolutePath",
	"filePath",
	"directory",
	"cwd",
	"target",
	"dir",
	"modulePath",
]);

const ARRAY_FIELD_NAMES = new Set([
	"edits",
	"files",
	"replacements",
	"paths",
	"function_names",
	"functionNames",
	"symbols",
	"queries",
	"urls",
	"commands",
	"steps",
	"args",
	"values",
	"items",
	"extensions",
	"include",
	"exclude",
	"options",
	"headers",
	"tasks",
	"patterns",
	"names",
	"ids",
	"schemas",
	"replacements",
	"messages",
	"prompts",
	"parameters",
	"responses",
	"tools",
	"skills",
]);

const CONTENT_FIELD_NAMES = new Set([
	"content",
	"text",
	"command",
	"oldText",
	"old_text",
	"newText",
	"new_text",
	"code",
	"source",
	"data",
	"body",
	"message",
	"description",
	"instructions",
	"prompt",
	"summary",
	"comment",
	"note",
]);

const NUMBER_FIELD_NAMES = new Set([
	"offset",
	"limit",
	"timeout",
	"timeout_seconds",
	"concurrency",
	"maxTokens",
	"max_tokens",
	"maxResults",
	"max_results",
	"numResults",
	"num_results",
	"start_line",
	"end_line",
	"port",
	"ttl",
	"context",
	"maxDepth",
	"maxFiles",
	"concurrency",
	"retries",
	"interval",
]);

// ─── Path Repair ──────────────────────────────────────────────────────────

/**
 * Unwrap markdown auto-links from path values.
 *
 * Models trained on chat distributions sometimes emit paths as markdown links:
 *   `[notes.md](http://notes.md)` → `notes.md`
 *   `[file.ts](file://path/to/file.ts)` → `file.ts`
 *
 * Only unwraps the degenerate case where the link text equals the URL without
 * its protocol prefix. Real markdown like `[click here](https://x.com)` passes
 * through untouched.
 */
function unwrapMarkdownLink(value: string): string {
	if (typeof value !== "string") return value;

	// Match [text](url) where text === url minus protocol
	const mdLink = /^\[([^\]]+)\]\(([^)]+)\)$/;
	const match = value.match(mdLink);
	if (!match) return value;

	const [, linkText, linkUrl] = match;

	// Unwrap only when link text equals URL without protocol
	const urlWithoutProtocol = linkUrl.replace(/^https?:\/\//, "").replace(/^file:\/\//, "");
	if (linkText === urlWithoutProtocol) {
		return linkText;
	}

	// Also handle the simple case where link text IS the URL (no protocol in URL either)
	if (linkText === linkUrl) {
		return linkText;
	}

	return value;
}

/**
 * Clean a path value: unwrap markdown links, trim whitespace, normalize.
 */
function cleanPathValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	let cleaned = value.trim();
	cleaned = unwrapMarkdownLink(cleaned);
	// Resolve relative paths to absolute (common LLM mistake: ~/ paths)
	if (cleaned.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "/home/user";
		cleaned = path.join(home, cleaned.slice(2));
	}
	return cleaned;
}

// ─── Array Repairs ────────────────────────────────────────────────────────

/**
 * Try to parse a string as JSON. If it parses to an array or object, return it.
 * This handles models that emit `"[\"a\",\"b\"]"` as a JSON string literal
 * instead of an actual array value.
 */
function tryParseJsonString(value: unknown): unknown {
	if (typeof value !== "string") return value;

	const trimmed = value.trim();
	if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return value;

	try {
		const parsed = JSON.parse(trimmed);
		// Only accept parsed arrays/objects, not primitives (avoid false positives)
		if (Array.isArray(parsed) || (typeof parsed === "object" && parsed !== null)) {
			return parsed;
		}
	} catch {
		// Not valid JSON — leave as-is
	}
	return value;
}

/**
 * Wrap a single value in an array when the key suggests an array is expected.
 * Example: `function_names: "main"` → `function_names: ["main"]`
 */
function wrapAsArrayIfNeeded(value: unknown, key: string): unknown {
	// Already an array — nothing to do
	if (Array.isArray(value)) return value;

	// null → empty array (the LLM meant "no items")
	if (value === null || value === undefined) return [];

	// Objects are handled by wrap-object-as-array, never by wrap-array
	if (typeof value === "object") return value;

	// Wrap bare primitives (strings, numbers, booleans)
	return [value];
}

/**
 * Wrap a single object in an array when the key suggests an array is expected.
 * Example: `edits: {oldText:"x", newText:"y"}` → `edits: [{oldText:"x", newText:"y"}]`
 * Handles models that omit the outer array when there's only one item.
 */
function wrapObjectAsArrayIfNeeded(value: unknown, _key: string): unknown {
	// Already an array — nothing to do
	if (Array.isArray(value)) return value;

	// Object (but not null) → wrap in array
	if (typeof value === "object" && value !== null) {
		return [value];
	}

	return value;
}

// ─── Relational Defaults ──────────────────────────────────────────────────

/**
 * Apply relational defaults for read/read_file tools.
 *
 * Relational invariant: if offset is provided, limit should also be present (and vice versa).
 * Models often provide only one, causing unnecessary errors.
 *
 * Instead of failing, we extend semantics:
 *   - `limit` alone → assume `offset = 1` (read from the start)
 *   - `offset` alone → assume `limit = 2000` (reasonable default)
 */
function applyRelationalDefaults(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
	if (toolName !== "read" && toolName !== "read_file") return input;

	const result = { ...input } as Record<string, unknown>;

	if (result.limit !== undefined && result.offset === undefined) {
		result.offset = 1;
	}
	if (result.offset !== undefined && result.limit === undefined) {
		result.limit = 2000;
	}

	return result;
}

// ─── Field-Level Repair Logic ─────────────────────────────────────────────

/**
 * Determine if a field should be repaired based on its key.
 * Returns the repair strategies to apply.
 */
type RepairAction =
	| "parse-json"
	| "wrap-array"
	| "wrap-object-as-array"
	| "clean-path"
	| "strip-nulls"
	| "none";

function classifyField(key: string): RepairAction[] {
	const lower = key.toLowerCase();
	const actions: RepairAction[] = [];

	// Path fields: clean markdown links + normalize
	if (PATH_FIELD_NAMES.has(key) || lower.endsWith("path") || lower.endsWith("_path") || lower.endsWith("dir")) {
		actions.push("clean-path");
	}

	// Array fields: parse JSON strings, wrap bare values
	// Only trigger on explicit set membership or known plural suffixes
	if (
		ARRAY_FIELD_NAMES.has(key) ||
		lower.endsWith("_list") ||
		lower.endsWith("list") ||
		lower.endsWith("_names") ||
		lower.endsWith("names") ||
		lower.endsWith("_items") ||
		lower.endsWith("items")
	) {
		actions.push("parse-json");
		actions.push("wrap-array");
		actions.push("wrap-object-as-array");
	}

	// Explicit array suffix patterns
	if (lower.endsWith("_array") || lower.endsWith("array")) {
		actions.push("parse-json", "wrap-array", "wrap-object-as-array");
	}

	return actions;
}

function isContentField(key: string): boolean {
	const lower = key.toLowerCase();
	if (CONTENT_FIELD_NAMES.has(key)) return true;
	// Heuristic: fields where the full stem ends in Text, content, body, message describe content
	// Must match exactly (e.g. "oldText", "newText", "body") not partial ("context", "longtext" is fine)
	if (lower === "context") return false; // NOT content — it's a number
	if (lower.endsWith("text") || lower.endsWith("content") || lower.endsWith("body")) return true;
	return false;
}

function isNumberField(key: string): boolean {
	const lower = key.toLowerCase();
	if (NUMBER_FIELD_NAMES.has(key)) return true;
	if (lower.startsWith("max") || lower.startsWith("min") || lower.endsWith("limit") ||
		lower.endsWith("timeout") || lower.endsWith("count") || lower.endsWith("_ms") ||
		lower.endsWith("depth") || lower.endsWith("level") || lower.endsWith("index") ||
		lower.endsWith("_id")) return true;
	return false;
}

/**
 * Apply repairs to a single field value based on its key.
 * Returns [repaired value, any repair descriptions].
 */
function repairFieldValue(
	value: unknown,
	key: string,
	parentKey: string,
): [unknown, string[]] {
	const repairs: string[] = [];

	// NEVER touch content fields
	if (isContentField(key)) {
		return [value, repairs];
	}

	// ── PHASE 1: Structural repairs FIRST (before recursing into nested objects/arrays) ──
	// Critical: a field like `edits` may receive a bare object that needs wrapping to
	// array BEFORE we recurse into its fields. Same for parse-json (string→structure)
	// and wrap-array (bare string→array). Order: clean-path, parse-json first (may
	// change type), then wrap-object-as-array (object→[object]), then wrap-array (bare→[bare]).
	const actions = classifyField(key);

	for (const action of actions) {
		switch (action) {
			case "clean-path": {
				const cleaned = cleanPathValue(value);
				if (cleaned !== undefined && cleaned !== value) {
					repairs.push(`${parentKey}.${key}: unwrapped markdown path "${String(value).slice(0, 40)}" → "${cleaned.slice(0, 40)}"`);
					value = cleaned;
				}
				break;
			}
			case "parse-json": {
				const parsed = tryParseJsonString(value);
				if (parsed !== value) {
					const preview =
						typeof value === "string" ? value.slice(0, 50) : String(value).slice(0, 50);
					repairs.push(`${parentKey}.${key}: parsed JSON string "${preview}" → structured value`);
					value = parsed;
				}
				break;
			}
			case "wrap-object-as-array": {
				if (typeof value === "object" && value !== null && !Array.isArray(value)) {
					repairs.push(`${parentKey}.${key}: wrapped object → single-element array`);
					value = [value];
				}
				break;
			}
			case "wrap-array": {
				const wrapped = wrapAsArrayIfNeeded(value, key);
				if (wrapped !== value) {
					repairs.push(`${parentKey}.${key}: wrapped bare "${String(value).slice(0, 30)}" → array`);
					value = wrapped;
				}
				break;
			}
		}
	}

	// ── PHASE 2: Recurse into structured values after type changes ──
	if (Array.isArray(value)) {
		const repairedItems: unknown[] = [];
		let anyChanged = false;
		for (const item of value) {
			const [repaired, itemRepairs] = repairFieldValue(item, "[item]", key);
			repairedItems.push(repaired);
			if (itemRepairs.length > 0) anyChanged = true;
		}
		if (anyChanged) {
			repairs.push(`repaired ${parentKey}.${key} nested items`);
		}
		return [repairedItems, repairs];
	}

	if (typeof value === "object" && value !== null) {
		const [repairedObj, nestedRepairs] = repairObjectFieldsWithTrace(
			value as Record<string, unknown>,
			`${parentKey}.${key}`,
		);
		repairs.push(...nestedRepairs);
		return [repairedObj, repairs];
	}

	return [value, repairs];
}

/**
 * Apply repairs to all fields in an object, returning the repaired object.
 * Repairs are applied silently (no trace output).
 * For trace output, use repairObjectFieldsWithTrace.
 */
function repairObjectFields(
	obj: Record<string, unknown>,
	parentKey: string = "input",
): Record<string, unknown> {
	const [result] = repairObjectFieldsWithTrace(obj, parentKey);
	return result;
}

/**
 * Apply repairs to all fields in an object, returning [repaired, repairs[]].
 */
function repairObjectFieldsWithTrace(
	obj: Record<string, unknown>,
	parentKey: string = "input",
): [Record<string, unknown>, string[]] {
	const result: Record<string, unknown> = {};
	const allRepairs: string[] = [];

	for (const [key, value] of Object.entries(obj)) {
		// Skip null values (strip nulls)
		if (value === null) {
			allRepairs.push(`${parentKey}.${key}: stripped null (optional field omitted)`);
			continue;
		}

		// Skip number fields (don't repair numbers)
		if (isNumberField(key) && typeof value === "number") {
			result[key] = value;
			continue;
		}

		const [repaired, repairs] = repairFieldValue(value, key, parentKey);
		result[key] = repaired;
		allRepairs.push(...repairs);
	}

	return [result, allRepairs];
}

// ─── Main Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Track repair statistics per (tool, model)
	const repairStats = new Map<string, { count: number; details: string[] }>();

	function recordRepair(toolName: string, modelLabel: string, repairs: string[]) {
		const key = `${modelLabel}::${toolName}`;
		const entry = repairStats.get(key) || { count: 0, details: [] };
		entry.count++;
		entry.details.push(...repairs);
		// Keep only last 20 detail lines per key
		if (entry.details.length > 20) {
			entry.details = entry.details.slice(-20);
		}
		repairStats.set(key, entry);
	}

	pi.on("tool_call", async (event, ctx) => {
		// Only repair known tools (skip custom/unknown tools to be safe)
		const repairableTools = new Set([
			"read", "write", "edit", "bash",
			"read_file", "edit_file", "write_file",
			"get_file_skeleton", "get_function", "replace_symbol",
			"find_symbol_references", "rename_symbol",
			"ffgrep", "fffind",
			"agent_browser", "web_search", "fetch_content",
			"code_search", "subagent",
			"ctx_execute", "ctx_execute_file",
			"ctx_fetch_and_index", "ctx_batch_execute",
			"ctx_index", "ctx_search",
			"run_experiment", "log_experiment",
		]);

		if (!repairableTools.has(event.toolName)) return undefined;

		const originalInput = event.input as Record<string, unknown>;
		if (!originalInput || typeof originalInput !== "object") return undefined;

		// Deep clone to compare later
		const originalJson = JSON.stringify(originalInput);

		// Step 1: Apply field-level repairs (includes null stripping, path cleaning,
		// JSON parsing, array wrapping)
		const repaired = repairObjectFields(originalInput);

		// Step 2: Apply relational defaults
		const withDefaults = applyRelationalDefaults(event.toolName, repaired);

		// Step 4: Check if anything changed
		const repairedJson = JSON.stringify(withDefaults);

		if (originalJson !== repairedJson) {
			// Log repairs
			const modelLabel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "unknown";

			// Collect repair descriptions (we can't easily thread them through the
			// recursive repair, so we compute a summary diff)
			const repairSummary = summarizeRepairs(originalInput, withDefaults);

			recordRepair(event.toolName, modelLabel, repairSummary);

			console.error(
				`[repair-layer] tool_input_repaired:${event.toolName} ` +
				`(${modelLabel}) - ${repairSummary.length} fixes`,
			);
			for (const detail of repairSummary) {
				console.error(`[repair-layer]   ${detail}`);
			}

			// Mutate input in place (pi supports this)
			// Clear all keys and reassign from repaired
			for (const key of Object.keys(event.input as object)) {
				delete (event.input as Record<string, unknown>)[key];
			}
			Object.assign(event.input, withDefaults);

			// Notify user in UI
			if (ctx.hasUI) {
				const summary = repairSummary.slice(0, 2).join("; ");
				const more = repairSummary.length > 2 ? ` (+${repairSummary.length - 2} more)` : "";
				ctx.ui.setStatus(
					"repair-layer",
					ctx.ui.theme.fg("accent", `🔧 ${event.toolName}: ${summary}${more}`),
				);
				// Clear status after 3 seconds
				setTimeout(() => {
					ctx.ui.setStatus("repair-layer", undefined);
				}, 3000);
			}
		}

		return undefined; // let tool execute
	});

	// Command: view repair stats
	pi.registerCommand("repair-stats", {
		description: "Show repair layer statistics",
		handler: async (_args, ctx) => {
			if (repairStats.size === 0) {
				ctx.ui.notify("No repairs applied so far.", "info");
				return;
			}

			const lines: string[] = [];
			for (const [key, entry] of repairStats.entries()) {
				lines.push(`${key}: ${entry.count} repairs`);
			}

			if (ctx.hasUI) {
				ctx.ui.notify(
					`Repair Stats:\n${lines.join("\n")}\n\nTotal tools repaired: ${repairStats.size}`,
					"info",
				);
			} else {
				console.log("Repair Stats:");
				for (const line of lines) console.log(`  ${line}`);
				console.log(`  Total: ${repairStats.size}`);
			}
		},
	});
}

// ─── Repair Summary Helper ────────────────────────────────────────────────

function summarizeRepairs(
	original: Record<string, unknown>,
	repaired: Record<string, unknown>,
	prefix: string = "",
): string[] {
	const details: string[] = [];

	for (const [key, newValue] of Object.entries(repaired)) {
		const oldValue = original[key];
		const fullKey = prefix ? `${prefix}.${key}` : key;

		// Key was stripped (null removal)
		if (!(key in original)) {
			details.push(`${fullKey}: stripped null`);
			continue;
		}

		if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
			if (Array.isArray(oldValue) && Array.isArray(newValue)) {
				details.push(`${fullKey}: repaired array (${oldValue.length} → ${newValue.length} items)`);
			} else if (typeof oldValue === "object" && typeof newValue === "object" &&
				oldValue !== null && newValue !== null && !Array.isArray(oldValue) && !Array.isArray(newValue)) {
				const nested = summarizeRepairs(
					oldValue as Record<string, unknown>,
					newValue as Record<string, unknown>,
					fullKey,
				);
				details.push(...nested);
			} else if (typeof oldValue === "string" && Array.isArray(newValue)) {
				details.push(`${fullKey}: parsed JSON string → array`);
			} else if (!Array.isArray(oldValue) && Array.isArray(newValue) && typeof oldValue !== "object") {
				details.push(`${fullKey}: wrapped bare → array`);
			} else if (typeof oldValue === "object" && oldValue !== null && Array.isArray(newValue)) {
				details.push(`${fullKey}: wrapped object → array`);
			} else if (typeof oldValue === "string" && typeof newValue === "string") {
				const oldPreview = oldValue.length > 40 ? oldValue.slice(0, 40) + "..." : oldValue;
				const newPreview = newValue.length > 40 ? newValue.slice(0, 40) + "..." : newValue;
				details.push(`${fullKey}: "${oldPreview}" → "${newPreview}"`);
			} else {
				details.push(`${fullKey}: repaired (${typeof oldValue} → ${typeof newValue})`);
			}
		}
	}

	return details;
}
