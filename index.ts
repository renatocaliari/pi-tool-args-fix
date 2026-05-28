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

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PATH_FIELD_NAMES,
	ARRAY_FIELD_NAMES,
	BOOLEAN_FIELD_NAMES,
	CONTENT_FIELD_NAMES,
	NUMBER_FIELD_NAMES,
	unwrapMarkdownLink,
	cleanPathValue,
	tryParseJsonString,
	wrapAsArrayIfNeeded,
	wrapObjectAsArrayIfNeeded,
	applyRelationalDefaults,
	classifyField,
	isNullLikeString,
	trySplitStringToArray,
	coerceToBoolean,
	coerceToNumber,
	isContentField,
	isNumberField,
	extractTextContent,
	stripExtraPropertiesFromItems,
} from "./repairs.js";
import { createStats, recordRepairs, formatStats } from "./stats.js";
import {
	recordEvent,
	readAllEvents,
	aggregateStats,
	computeBlindspots,
	pruneOldSessions,
	classifyErrorType,
	formatSessionStats,
	formatGlobalStats,
	formatBlindspots,
} from "./recorder.js";



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
				const wrapped = wrapAsArrayIfNeeded(value);
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
			case "strip-extra-properties": {
				const [cleaned, stripped] = stripExtraPropertiesFromItems(value, key);
				if (cleaned !== value) {
					repairs.push(`${parentKey}.${key}: stripped extra props [${stripped.join(", ")}] from array items`);
					value = cleaned;
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

		// Skip null-like strings ("null", "none", "n/a", etc.)
		if (isNullLikeString(value)) {
			allRepairs.push(`${parentKey}.${key}: stripped null-like string "${String(value).slice(0, 30)}" (optional field omitted)`);
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
	let eventSeq = 0;

	// Prune old session logs at startup
	const pruned = pruneOldSessions(50);
	if (pruned > 0) {
		console.log(`[repair-layer] pruned ${pruned} old session log(s) (retention: 50)`);
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
		const withDefaults = applyRelationalDefaults(repaired);

		// Step 4: Check if anything changed & collect repair descriptions
		const repairedJson = JSON.stringify(withDefaults);
		const repairSummary = originalJson !== repairedJson
			? summarizeRepairs(originalInput, withDefaults)
			: [];

		if (originalJson !== repairedJson) {
			// Log repairs
			const modelLabel = ctx.model
				? `${ctx.model.provider}/${ctx.model.id}`
				: "unknown";

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

		// Record event for post-session analysis
		eventSeq++;
		const callSessionId: string = (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown";
		recordEvent({
			ts: new Date().toISOString(),
			eventType: "tool_call",
			sessionId: callSessionId,
			turnIndex: eventSeq,
			toolName: event.toolName,
			provider: ctx.model?.provider ?? "unknown",
			model: ctx.model?.id ?? "unknown",
			repairs: repairSummary,
			wasRepaired: originalJson !== repairedJson,
			executionFailed: false,
			executionErrorType: null,
			wasHandled: false,
			handleType: null,
			blindspotCategory: null,
			inputKeys: Object.keys(originalInput),
			inputNullKeys: Object.entries(originalInput)
				.filter(([_, v]) => v === null)
				.map(([k]) => k),
			inputExtraProps: [],
		});

		return undefined; // let tool execute
	});

	// ─── tool_result: Execution error recording + directory fallback ──
	pi.on("tool_result", async (event, ctx) => {
		// ── Phase 1: Extract error info ──────────────────────────────
		let executionErrorType: string | null = null;
		let blindspotCategory: string | null = null;
		const hasError = event.isError ?? false;

		if (hasError) {
			const errorText = extractTextContent(event.content);
			executionErrorType = classifyErrorType(errorText);
			blindspotCategory = executionErrorType;
		}

		// ── Phase 2: Handle directory fallback (read tool EISDIR) ───
		let wasHandled = false;
		let handleType: string | null = null;

		if (event.toolName === "read" && hasError && executionErrorType === "EISDIR") {
			// Get the path from the original input
			const inputPath = (event.input as Record<string, unknown>)?.path;
			if (typeof inputPath === "string" && inputPath) {
				// Resolve the path
				let resolvedPath = inputPath;
				if (resolvedPath.startsWith("~/")) {
					const home = process.env.HOME || process.env.USERPROFILE || "/home/user";
					resolvedPath = path.join(home, resolvedPath.slice(2));
				}

				try {
					const stat = await fs.stat(resolvedPath);
					if (stat.isDirectory()) {
						// It's a directory — list its contents
						const entries = await fs.readdir(resolvedPath);
						const listing = entries.map((e) => `  ${e}`).join("\n");
						const dirName = path.basename(resolvedPath);

						const listingContent = [
							`📁 Directory: ${resolvedPath}`,
							``,
							"Contents:",
							listing,
							``,
							`${entries.length} entr${entries.length === 1 ? "y" : "ies"} total.`,
							``,
							`ℹ️ The model called read on a directory. Use bash ls or read with a specific file path inside this directory.`,
						].join("\n");

						// Log and track stats
						const detail = `${dirName}: directory fallback (${entries.length} entries listed)`;
						console.error(`[repair-layer] tool_result_modified:read - ${detail}`);
						recordRepairs(stats, [detail]);

						if (ctx.hasUI) {
							ctx.ui.setStatus(
								"repair-layer",
								ctx.ui.theme.fg("accent", `🔧 read: directory fallback → ${dirName} (${entries.length} entries)`),
							);
							setTimeout(() => {
								ctx.ui.setStatus("repair-layer", undefined);
							}, 3000);
						}

						wasHandled = true;
						handleType = "directory_fallback";
						blindspotCategory = null; // No longer a blindspot

						// Record handled event
						eventSeq++;
						const resSessionId: string = (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown";
						recordEvent({
							ts: new Date().toISOString(),
							eventType: "tool_result",
							sessionId: resSessionId,
							turnIndex: eventSeq,
							toolName: event.toolName,
							provider: ctx.model?.provider ?? "unknown",
							model: ctx.model?.id ?? "unknown",
							repairs: [],
							wasRepaired: false,
							executionFailed: false,
							executionErrorType: null,
							wasHandled: true,
							handleType: "directory_fallback",
							blindspotCategory: null,
							inputKeys: Object.keys(event.input ?? {}),
							inputNullKeys: [],
							inputExtraProps: [],
						});

						// Return patched result: clear error, provide listing
						return {
							content: [{ type: "text", text: listingContent }],
							isError: false,
						};
					}
					// Not a directory — fall through to error recording
				} catch {
					// stat or readdir failed — fall through to error recording
				}
			}
			// Input path was invalid or stat failed — fall through to error recording
		}

		// ── Phase 3: Record event (error or success) ──────────────────
		eventSeq++;
		const resSessionId: string = (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown";
		recordEvent({
			ts: new Date().toISOString(),
			eventType: "tool_result",
			sessionId: resSessionId,
			turnIndex: eventSeq,
			toolName: event.toolName,
			provider: ctx.model?.provider ?? "unknown",
			model: ctx.model?.id ?? "unknown",
			repairs: [],
			wasRepaired: false,
			executionFailed: hasError,
			executionErrorType,
			wasHandled,
			handleType,
			blindspotCategory,
			inputKeys: Object.keys(event.input ?? {}),
			inputNullKeys: [],
			inputExtraProps: [],
		});

		return undefined;
	});

	// ─── Command: in-memory session repair stats ─────────────────────
	pi.registerCommand("repair-stats", {
		description: "Show repair layer statistics for this session (in-memory)",
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

	// ─── Command: global aggregate across all sessions ────────────────
	pi.registerCommand("repair-stats-global", {
		description: "Show aggregated repair stats across all logged sessions",
		handler: async (_args, ctx) => {
			const allEvents = readAllEvents();
			const agg = aggregateStats(allEvents);

			// Count unique sessions
			const sessionIds = new Set(allEvents.map((e) => e.sessionId));

			const footer = `\nSession logs: ${sessionIds.size} (retention 50, auto-pruned at startup)`;
			const output = formatGlobalStats(agg, sessionIds.size) + footer;

			if (ctx.hasUI) {
				ctx.ui.notify(`${output}`, "info");
			} else {
				console.log(output);
			}
		},
	});

	// ─── Command: blindspots (errors without repair coverage) ────────
	pi.registerCommand("repair-gaps", {
		description: "Show error patterns that lack repair coverage (blindspots)",
		handler: async (_args, ctx) => {
			const allEvents = readAllEvents();
			const blindspots = computeBlindspots(allEvents);
			const output = formatBlindspots(blindspots);

			if (ctx.hasUI) {
				ctx.ui.notify(`${output}`, "info");
			} else {
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
