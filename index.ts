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
 *   7. Split comma/space-separated strings into arrays ("foo, bar" → ["foo", "bar"])
 *   8. Strip null-like strings ("null", "none", "n/a" → omit field)
 *   9. Coerce boolean strings ("true", "yes", "1" → true)
 *  10. Coerce number strings ("42", "3.14" → 42, 3.14)
 *
 * Safety: content fields (command text, file content, oldText, newText, code, etc.)
 * are NEVER touched. Only structural/container fields are repaired.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "./test-import.js";

export default function (pi: ExtensionAPI) {
	// Stub: return undefined for all tool calls
	pi.on("tool_call", async (_event, _ctx) => {
		return undefined;
	});
}/**
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
			case "split-string-to-array": {
				const split = trySplitStringToArray(value);
				if (split !== value && Array.isArray(split)) {
					repairs.push(`${parentKey}.${key}: split string "${String(value).slice(0, 40)}" → array`);
					value = split;
				}
				break;
			}
			case "coerce-boolean": {
				const coerced = coerceToBoolean(value);
				if (coerced !== value) {
					repairs.push(`${parentKey}.${key}: coerced "${String(value).slice(0, 30)}" → ${coerced}`);
					value = coerced;
				}
				break;
			}
			case "coerce-number": {
				const coerced = coerceToNumber(value);
				if (coerced !== value) {
					repairs.push(`${parentKey}.${key}: coerced "${String(value).slice(0, 30)}" → ${coerced}`);
					value = coerced;
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
	const stats = createStats();

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
		const withDefaults = applyRelationalDefaults(repaired);

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

			recordRepairs(stats, repairSummary);

			console.error(
				`[repair-layer] tool_input_repaired:${event.toolName} ` +
				`(${modelLabel}) - ${repairSummary.length} fixes`,
			);
			for (const detail of repairSummary) {
				console.error(`[repair-layer]   ${detail}`);
			}

			// Mutate input in place (pi supports this)
			// Clear all keys and reassign from repaired
			const inputObj = event.input as Record<string, unknown>;
			for (const key of Object.keys(inputObj)) {
				delete inputObj[key];
			}
			Object.assign(inputObj, withDefaults);

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
		description: "Show repair layer statistics for this session",
		handler: async (_args, ctx) => {
			const output = formatStats(stats);

			if (ctx.hasUI) {
				ctx.ui.notify(`📊 Repair Stats (this session)\n\n${output}`, "info");
			} else {
				console.log("📊 Repair Stats (this session)");
				console.log(output);
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
			} else if (typeof oldValue === "boolean" || typeof newValue === "boolean") {
				const oldPreview = String(oldValue);
				const newPreview = String(newValue);
				details.push(`${fullKey}: coerced boolean "${oldPreview}" → ${newPreview}`);
			} else if (typeof oldValue === "number" || typeof newValue === "number") {
				const oldPreview = String(oldValue);
				const newPreview = String(newValue);
				details.push(`${fullKey}: coerced number "${oldPreview}" → ${newPreview}`);
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
