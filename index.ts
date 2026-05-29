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
	cleanPathValue,
	tryParseJsonString,
	wrapAsArrayIfNeeded,
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
	formatGlobalStats,
	formatBlindspots,
	ConsecutiveFailureTracker,
	getToolHelp,
} from "./recorder.js";
import type { RepairEvent } from "./recorder.js";

/** Pi built-in CLI tools that use shell exit codes (may have exit code 1 = "no results" not an error). */
const NATIVE_CLI_TOOLS = new Set(["bash", "grep", "find", "ls"]);



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
	const failureTracker = new ConsecutiveFailureTracker();
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
			"grep", "find", "ls",
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
	// ─── tool_result: Execution error recording + directory fallback ──
//
// Handler phases:
//   1. Classify error (pattern matching + CLI filter + safety net)
//   1.b Track consecutive failures + inject CLI guidance on 2nd+
//   1.c Detect empty results (analytics only)
//   2. Handle EISDIR directory fallback (read tool)
//   3. Record event to JSONL

/** Phase 1: Classify tool result error into canonical type. */
function classifyToolResultError(
	event: any,
): { hasError: boolean; executionErrorType: string | null; blindspotCategory: string | null } {
	let hasError = event.isError ?? false;
	let executionErrorType: string | null = null;
	let blindspotCategory: string | null = null;

	if (!hasError) return { hasError, executionErrorType, blindspotCategory };

	const errorText = extractTextContent(event.content);
	executionErrorType = classifyErrorType(errorText);
	blindspotCategory = executionErrorType;

	// Native CLI false positives filter: bash/grep/find/ls exit code 1 is "no results", not error
	if (NATIVE_CLI_TOOLS.has(event.toolName) && executionErrorType === null) {
		hasError = false;
		executionErrorType = null;
		blindspotCategory = null;
	}

	// Generic safety net: no error text → not meaningful to flag
	if (hasError && executionErrorType === null && !errorText) {
		hasError = false;
		blindspotCategory = null;
	}

	return { hasError, executionErrorType, blindspotCategory };
}

/** Phase 1.c: Detect empty results (analytics only). */
function detectEmptyResult(
	event: any,
	err: { hasError: boolean; blindspotCategory: string | null },
): void {
	if (err.hasError || err.blindspotCategory !== null) return;

	const resText = extractTextContent(event.content);
	if (resText && (resText.trim() === "" || resText.trim() === "(no output)")) {
		err.blindspotCategory = "EMPTY_RESULT";
	}
}

/** Build a RepairEvent for a tool_result from handler context. */
function buildToolResultEvent(
	event: any,
	ctx: any,
	turn: number,
	err: { hasError: boolean; executionErrorType: string | null; blindspotCategory: string | null },
	wasHandled: boolean,
	handleType: string | null,
	inputKeysOverride?: string[],
): RepairEvent {
	return {
		ts: new Date().toISOString(),
		eventType: "tool_result",
		sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
		turnIndex: turn,
		toolName: event.toolName,
		provider: ctx.model?.provider ?? "unknown",
		model: ctx.model?.id ?? "unknown",
		repairs: [],
		wasRepaired: false,
		executionFailed: err.hasError,
		executionErrorType: err.executionErrorType,
		wasHandled,
		handleType,
		blindspotCategory: err.blindspotCategory,
		inputKeys: inputKeysOverride ?? Object.keys(event.input ?? {}),
		inputNullKeys: [],
		inputExtraProps: [],
	};
}

/**
 * Phase 1.b: Track failures for consecutive detection.
 * Returns a patched result object when CLI guidance should be injected.
 */
function trackAndInterceptFailures(
	event: any,
	err: { hasError: boolean; executionErrorType: string | null; blindspotCategory: string | null },
	failureTracker: ConsecutiveFailureTracker,
	ctx: any,
	eventSeq: number,
): { result?: { content: any; isError: boolean }; eventSeqDelta: number } {
	const inputKeys = Object.keys(event.input ?? {});
	let delta = 0;

	if (err.hasError) {
		const consecutiveCount = failureTracker.recordFailure(event.toolName, inputKeys);

		if (consecutiveCount >= 3) {
			err.blindspotCategory = "CONSECUTIVE_LOOP";
		}

		// CLI guidance: native CLI tools on 2nd+ consecutive failure
		if (consecutiveCount >= 2 && NATIVE_CLI_TOOLS.has(event.toolName)) {
			const currentText = extractTextContent(event.content) ?? "";
			const helpText = getToolHelp(event.toolName);
			console.error(`[repair-layer] tool_result_modified:${event.toolName} - consecutive failure ${consecutiveCount}, injecting CLI guidance`);

			err.blindspotCategory = null; // being handled — no longer a blindspot
			const rec: RepairEvent = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "cli_guidance", inputKeys);
			recordEvent(rec);

			return {
				result: {
					content: [{ type: "text" as const, text: `${currentText}\n\n── Tool guidance ──\n${helpText}` }],
					isError: true,
				},
				eventSeqDelta: 1,
			};
		}
	} else {
		failureTracker.recordSuccess(event.toolName);
	}

	return { eventSeqDelta: 0 };
}

/**
 * Phase 2: Handle EISDIR directory fallback (read tool on a directory).
 * Returns a patched result with directory listing when applicable.
 */
async function handleEisdirFallback(
	event: any,
	ctx: any,
	err: { hasError: boolean; executionErrorType: string | null },
	stats: any,
): Promise<{ result?: { content: any; isError: boolean }; wasHandled: boolean; handleType: string | null }> {
	if (event.toolName !== "read" || !err.hasError || err.executionErrorType !== "EISDIR") {
		return { wasHandled: false, handleType: null };
	}

	const inputPath = (event.input as Record<string, unknown>)?.path;
	if (typeof inputPath !== "string" || !inputPath) {
		return { wasHandled: false, handleType: null };
	}

	let resolvedPath = inputPath;
	if (resolvedPath.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "/home/user";
		resolvedPath = path.join(home, resolvedPath.slice(2));
	}

	try {
		const stat = await fs.stat(resolvedPath);
		if (!stat.isDirectory()) return { wasHandled: false, handleType: null };

		const entries = await fs.readdir(resolvedPath);
		const listing = entries.map((e) => `  ${e}`).join("\n");
		const dirName = path.basename(resolvedPath);

		const listingContent = [
			`📁 Directory: ${resolvedPath}`,
			"",
			"Contents:",
			listing,
			"",
			`${entries.length} entr${entries.length === 1 ? "y" : "ies"} total.`,
			"",
			"ℹ️ The model called read on a directory. Use bash ls or read with a specific file path inside this directory.",
		].join("\n");

		const detail = `${dirName}: directory fallback (${entries.length} entries listed)`;
		console.error(`[repair-layer] tool_result_modified:read - ${detail}`);
		recordRepairs(stats, [detail]);

		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"repair-layer",
				ctx.ui.theme.fg("accent", `🔧 read: directory fallback → ${dirName} (${entries.length} entries)`),
			);
			setTimeout(() => ctx.ui.setStatus("repair-layer", undefined), 3000);
		}

		return {
			result: { content: [{ type: "text" as const, text: listingContent }], isError: false },
			wasHandled: true,
			handleType: "directory_fallback",
		};
	} catch {
		return { wasHandled: false, handleType: null };
	}
}

pi.on("tool_result", async (event, ctx) => {
	const err = classifyToolResultError(event);
	detectEmptyResult(event, err);

	// Phase 1.b: consecutive failure tracking + CLI guidance interception
	const intercept = trackAndInterceptFailures(event, err, failureTracker, ctx, eventSeq);
	if (intercept.eventSeqDelta) eventSeq = eventSeq + intercept.eventSeqDelta;
	if (intercept.result) return intercept.result;

	// Phase 2: EISDIR directory fallback
	const fallback = await handleEisdirFallback(event, ctx, err, stats);
	if (fallback.result) {
		err.hasError = false;
		err.executionErrorType = null;
		err.blindspotCategory = null; // handled — no longer a blindspot
		const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "directory_fallback");
		recordEvent(rec);
		return fallback.result;
	}

	// Phase 3: Record event
	const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, false, null);
	recordEvent(rec);
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
