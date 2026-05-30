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
	repairFieldValue,
	repairObjectFields,
	repairObjectFieldsWithTrace,
	extractPathsFromArgs,
	suggestAutoTimeout,
	ContentHashCache,
	simpleHash,
	buildEditMismatchContext,
	buildEnhancedEditMismatchGuidance,
} from "./repairs.js";
import { createStats, recordRepairs, formatStats, RepairToggle } from "./stats.js";
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
	getErrorGuidance,
} from "./recorder.js";
import { exec } from "node:child_process";
import type { RepairEvent } from "./recorder.js";
import { generateSuggestions, formatSuggestions, composeIssueContent, buildIssueUrl } from "./suggest-repairs.js";
import type { LLMConfig, PhaseCallback, IssueContent } from "./suggest-repairs.js";

/** Pi built-in CLI tools that use shell exit codes (may have exit code 1 = "no results" not an error). */
const NATIVE_CLI_TOOLS = new Set(["bash", "grep", "find", "ls"]);
/** Tools that get guidance injection on consecutive failures (includes CLI + edit/read/write). */
const GUIDANCE_TOOLS = new Set([...NATIVE_CLI_TOOLS, "edit", "read", "write"]);

/** Track which (toolName:errorType) pairs have already received error-type guidance. */
const guidedErrorPairs = new Set<string>();



// ─── Main Extension ───────────────────────────────────────────────────────

/** Helper: show progress widget above editor */
function showProgress(ctx: any, lines: string[]): void {
	if (ctx.hasUI) {
		ctx.ui.setWidget("repair-progress", lines);
	}
}

/** Helper: clear progress widget */
function clearProgress(ctx: any): void {
	if (ctx.hasUI) {
		ctx.ui.setWidget("repair-progress", undefined);
	}
}

/** Helper: show error notification */
function showError(ctx: any, msg: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(msg, "error");
	} else {
		console.error("[repair-layer]", msg);
	}
}

/** Helper: show info notification */
function showInfo(ctx: any, msg: string): void {
	if (ctx.hasUI) {
		ctx.ui.notify(msg, "info");
	} else {
		console.log(msg);
	}
}

export default function (pi: ExtensionAPI) {
	const stats = createStats();
	const failureTracker = new ConsecutiveFailureTracker();
	const repairToggle = new RepairToggle(true);
	const contentHashCache = new ContentHashCache();
	let eventSeq = 0;

	// Prune old session logs at startup
	const pruned = pruneOldSessions(50);
	if (pruned > 0) {
		console.log(`[repair-layer] pruned ${pruned} old session log(s) (retention: 50)`);
	}

	// ─── TUI indicator: show/hide repair status in footer ───
	function setRepairStatus(ctx: any): void {
		if (!ctx.hasUI) return;
		const display = repairToggle.getStatusDisplay();
		ctx.ui.setStatus("repair-layer", ctx.ui.theme.fg("accent", display));
	}

	pi.on("session_start", async (_event, ctx) => {
		setRepairStatus(ctx);

		// Show a quick global snapshot so user knows what's happening across sessions
		const allEvents = readAllEvents();
		if (allEvents.length > 0) {
			const agg = aggregateStats(allEvents);
			const sessionIds = new Set(allEvents.map((e: { sessionId: string }) => e.sessionId));
			ctx.ui.notify(
				`📊 Repair Layer — Global Overview\n` +
				`${sessionIds.size} session(s), ${allEvents.length} events, ${agg.totalRepairs} repairs\n` +
				`Type /repair-stats-session for session details, /repair-stats-global for all-session aggregate, /repair-suggest to suggest new fixes.`,
				"info",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus("repair-layer", undefined);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		// Skip if repair layer is disabled
		if (!repairToggle.isEnabled()) return undefined;

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

		// ── Step 3a: Auto-timeout injection (bash) ────────────────────────
		if (event.toolName === "bash") {
			const command = withDefaults.command as string | undefined;
			const currentTimeout = withDefaults.timeout as number | undefined;
			if (typeof command === "string") {
				const suggested = suggestAutoTimeout(command, currentTimeout);
				if (suggested !== undefined) {
					withDefaults.timeout = suggested;
					console.error(`[repair-layer] auto-timeout:${event.toolName} injected timeout=${suggested}s for command pattern`);
				}
			}
		}

		// ── Step 3b: Path validation (pre-flight ENOENT detection) ──────
		const ENOENT_TOOLS = new Set(["read", "read_file", "write", "write_file", "edit", "edit_file", "bash", "ffgrep", "fffind"]);
		if (ENOENT_TOOLS.has(event.toolName)) {
			const paths = extractPathsFromArgs(withDefaults);
			const invalidPaths: string[] = [];
			for (const p of paths) {
				const resolved = p.startsWith("~/") ? path.join(process.env.HOME || "/home/user", p.slice(2)) : p;
				if (!resolved) continue;
				// Only check paths that look like file paths (not URLs, not commands)
				if (resolved.startsWith("http") || resolved.startsWith("-")) continue;
				try {
					const exists = await fs.stat(resolved).then(s => s.isFile() || s.isDirectory()).catch(() => false);
					if (!exists) {
						invalidPaths.push(resolved);
					}
				} catch { /* stat failed, skip */ }
			}
			if (invalidPaths.length > 0 && event.toolName !== "bash") {
				// For file tools: return tool error with guidance before execution
				const pathList = invalidPaths.map(p => `  - ${p}`).join("\n");
				const guidance = [
					`⚠️ Path validation: ${invalidPaths.length} path(s) not found.`,
					pathList,
					"",
					"Possible fixes:",
					"  • Check the file path spelling",
					"  • The file may be in a different directory",
					"  • You may need to create the file first (use write tool)",
					"  • Use fffind or ls to discover the correct path",
				].join("\n");

				console.error(`[repair-layer] tool_call_blocked:${event.toolName} - ${invalidPaths.length} invalid paths`);

				// Record blocked event
				eventSeq++;
				const callSessionId: string = (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown";
				recordEvent({
					ts: new Date().toISOString(),
					eventType: "tool_result",
					sessionId: callSessionId,
					turnIndex: eventSeq,
					toolName: event.toolName,
					provider: ctx.model?.provider ?? "unknown",
					model: ctx.model?.id ?? "unknown",
					repairs: [],
					wasRepaired: false,
					executionFailed: true,
					executionErrorType: "ENOENT",
					wasHandled: true,
					handleType: "path_validation",
					blindspotCategory: null,
					inputKeys: Object.keys(originalInput),
					inputNullKeys: [],
					inputExtraProps: [],
				});

				return {
					content: [{ type: "text" as const, text: guidance }],
					isError: true,
				};
			}
		}

		// ── Step 3c: Staleness check (edit tool — content hash cache) ───
		if (event.toolName === "edit" || event.toolName === "edit_file") {
			// Extract the file path from the edit request
			let editPath: string | undefined;
			if (event.toolName === "edit") {
				editPath = (event.input as Record<string, unknown>)?.path as string | undefined;
			} else {
				const files = (event.input as Record<string, unknown>)?.files as Array<Record<string, unknown>> | undefined;
				if (files && files.length > 0) {
					editPath = files[0]?.path as string | undefined;
				}
			}

			if (editPath) {
				const resolved = editPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", editPath.slice(2)) : editPath;
				try {
					const content = await fs.readFile(resolved, "utf-8");
					if (contentHashCache.isStale(resolved, content)) {
						const lastTurn = contentHashCache.getLastReadTurn(resolved);
						const staleGuidance = [
							`⚠️ File content has changed since it was last read (turn ${lastTurn}).`,
							`The edit may overwrite newer content or the oldText no longer matches.`,
							`Please re-read the file first with the read tool to get current content,`,
							`then apply the edit with the exact current text as oldText.`,
						].join("\n");

						console.error(`[repair-layer] tool_call_blocked:${event.toolName} - stale content for ${resolved}`);

						eventSeq++;
						const callSessionId: string = (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown";
						recordEvent({
							ts: new Date().toISOString(),
							eventType: "tool_result",
							sessionId: callSessionId,
							turnIndex: eventSeq,
							toolName: event.toolName,
							provider: ctx.model?.provider ?? "unknown",
							model: ctx.model?.id ?? "unknown",
							repairs: [],
							wasRepaired: false,
							executionFailed: true,
							executionErrorType: "EDIT_MISMATCH",
							wasHandled: true,
							handleType: "staleness_check",
							blindspotCategory: null,
							inputKeys: Object.keys(originalInput),
							inputNullKeys: [],
							inputExtraProps: [],
						});

						return {
							content: [{ type: "text" as const, text: staleGuidance }],
							isError: true,
						};
					}
				} catch { /* file doesn't exist yet for new files — that's fine */ }
			}
		}

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
				// Clear transient repair message after 3s, restore permanent on/off indicator
				setTimeout(() => setRepairStatus(ctx), 3000);
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
//   2. Handle EISDIR directory fallback (read / read_file)
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
 * Enhanced EDIT_MISMATCH guidance: tries to read the target file and find
 * the closest text region to the failed oldText, so the model gets context
 * about what's actually in the file vs what it tried to match.
 */
async function enhanceEditMismatchGuidance(
	event: any,
	baseGuidance: string,
): Promise<string | null> {
	let filePath: string | undefined;
	if (event.input?.path) {
		filePath = event.input.path;
	} else if (event.input?.files?.[0]?.path) {
		filePath = event.input.files[0].path;
	}
	if (!filePath) return null;

	const resolved = resolvePath(filePath, process.env.HOME);

	const oldText = event.input?.oldText ?? event.input?.edits?.[0]?.oldText;
	if (typeof oldText !== "string" || !oldText) return null;

	try {
		const fileContent = await fs.readFile(resolved, "utf-8");
		const ctx = buildEditMismatchContext(fileContent, oldText);
		if (!ctx) return null;
		return buildEnhancedEditMismatchGuidance(baseGuidance, ctx);
	} catch {
		return null;
	}
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

		// Guidance: native tools on 2nd+ consecutive failure
		if (consecutiveCount >= 2 && GUIDANCE_TOOLS.has(event.toolName)) {
			const currentText = extractTextContent(event.content) ?? "";
			let helpText = getToolHelp(event.toolName);

			// Enhanced guidance for edit_file loops — more specific than generic help
			if (event.toolName === "edit" || event.toolName === "edit_file") {
				if (consecutiveCount >= 5) {
					helpText += `\n\n⚠️ This is attempt #${consecutiveCount} to edit the same file with the same arguments.` +
						`\nThe edit is clearly not matching the current file content.` +
						`\nConsider an alternative approach:` +
						`\n  • Read the file first with the read tool, then re-apply the edit with exact text` +
						`\n  • Use the write tool to write the entire file content (if you know the full content)` +
						`\n  • Create a new file instead of modifying an existing one`;
				} else if (consecutiveCount >= 3) {
					helpText += `\n\n💡 Tip: ${consecutiveCount} consecutive failures on this file. ` +
						`The oldText may have whitespace differences (tabs vs spaces, trailing spaces). ` +
						`Read the file and check indentation carefully.`;
				}
			}

			// Circuit-break: 7+ consecutive failures → permanent error
			// Forces the model to abandon this approach entirely
			if (consecutiveCount >= 7) {
				const circuitBreakMsg = [
					`🔴 CIRCUIT BREAKER: Tool "${event.toolName}" has failed ${consecutiveCount} consecutive times.`,
					`The current approach is not working and further retries will not help.`,
					`Please switch to a completely different strategy:`,
					`  • If editing: use the write tool to create a new version of the file`,
					`  • If reading: verify the path exists (use ls or fffind)`,
					`  • If running a command: simplify the command or check syntax`,
					`  • Move on to a different task entirely`,
					``,
					`Error details: ${currentText.slice(0, 200)}`,
				].join("\n");

				console.error(`[repair-layer] tool_result_circuit_break:${event.toolName} - ${consecutiveCount} consecutive failures`);

				err.blindspotCategory = null;
				const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "circuit_break", inputKeys);
				recordEvent(rec);

				return {
					result: {
						content: [{ type: "text" as const, text: circuitBreakMsg }],
						isError: true,
					},
					eventSeqDelta: 1,
				};
			}

			console.error(`[repair-layer] tool_result_modified:${event.toolName} - consecutive failure ${consecutiveCount}, injecting CLI guidance`);

			err.blindspotCategory = null; // being handled — no longer a blindspot
			const rec: RepairEvent = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "cli_guidance", inputKeys);
			recordEvent(rec);

			return {
				result: {
					content: [{ type: "text" as const, text: `${currentText}\n\n🔧 Tool guidance ──\n${helpText}` }],
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
 * Phase 2: Handle EISDIR directory fallback (read / read_file on a directory).
 * Returns a patched result with directory listing when applicable.
 */
async function handleEisdirFallback(
	event: any,
	ctx: any,
	err: { hasError: boolean; executionErrorType: string | null },
	stats: any,
): Promise<{ result?: { content: any; isError: boolean }; wasHandled: boolean; handleType: string | null }> {
	const TOOLS_WITH_DIR_FALLBACK = new Set(["read", "read_file"]);
	if (!TOOLS_WITH_DIR_FALLBACK.has(event.toolName) || !err.hasError || err.executionErrorType !== "EISDIR") {
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
		const { listingContent, detail, dirName } = formatDirectoryListing(resolvedPath, entries, event.toolName);
		console.error(`[repair-layer] tool_result_modified:read - ${detail}`);
		recordRepairs(stats, [detail]);

		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"repair-layer",
				ctx.ui.theme.fg("accent", `🔧 read: directory fallback → ${dirName} (${entries.length} entries)`),
			);
			setTimeout(() => setRepairStatus(ctx), 3000);
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

// ─── Phase 1.d: Error-type guidance (e.g. SCHEMA_VALIDATION, EDIT_MISMATCH) ──
	if (err.executionErrorType) {
		const guidanceKey = `${event.toolName}:${err.executionErrorType}`;
		if (!guidedErrorPairs.has(guidanceKey)) {
			guidedErrorPairs.add(guidanceKey);
			let guidanceText = getErrorGuidance(err.executionErrorType, event.toolName);

			// Enhanced EDIT_MISMATCH: try to read file and offer context
			if (err.executionErrorType === "EDIT_MISMATCH" && !err.blindspotCategory) {
				const enhanced = await enhanceEditMismatchGuidance(event, guidanceText);
				if (enhanced) guidanceText = enhanced;
			}

			if (guidanceText) {
				const currentText = extractTextContent(event.content) ?? "";
				err.blindspotCategory = null; // being handled — no longer a blindspot
				const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "category_guidance");
				recordEvent(rec);
				eventSeq++;
				return {
					content: [{ type: "text" as const, text: `${currentText}\n\n🔧 Tool guidance ──\n${guidanceText}` }],
					isError: true,
				};
			}
		}
	}

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

	// ── Phase 2.b: Record content hash for staleness tracking ──────────
	// When a read/read_file succeeds, cache the content hash so we can
	// detect stale edits later.
	if (!err.hasError && (event.toolName === "read" || event.toolName === "read_file")) {
		const inputPath = (event.input as Record<string, unknown>)?.path;
		if (typeof inputPath === "string" && inputPath) {
			const resolved = inputPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", inputPath.slice(2)) : inputPath;
			const content = extractTextContent(event.content);
			if (content && content.length < 500_000) { // Skip huge files
				try {
					// Read the actual file content for accurate hash
					const fileContent = await fs.readFile(resolved, "utf-8").catch(() => null);
					if (fileContent !== null) {
						contentHashCache.setHash(resolved, fileContent);
						contentHashCache.recordRead(resolved, eventSeq);
					}
				} catch { /* skip unreadable */ }
			}
		}
	}

	// ── Phase 2.c: Expand EISDIR directory fallback for write tool ─────
	if (!err.hasError && event.toolName === "write") {
		const inputPath = (event.input as Record<string, unknown>)?.path;
		if (typeof inputPath === "string" && inputPath) {
			const resolved = inputPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", inputPath.slice(2)) : inputPath;
			// Check if the write target's parent looks like a directory (common mistake)
			// If path has no extension and the full path IS a directory, flag it
			if (!path.extname(resolved)) {
				try {
					const stat = await fs.stat(resolved);
					if (stat.isDirectory()) {
						const entries = await fs.readdir(resolved);
						const { listingContent, detail, dirName } = formatDirectoryListing(resolved, entries, "write");
						console.error(`[repair-layer] tool_result_modified:write - ${detail}`);
						recordRepairs(stats, [detail]);
						return {
							content: [{ type: "text" as const, text: listingContent }],
							isError: false,
						};
					}
				} catch { /* stat failed, not a directory — proceed */ }
			}
		}
	}

	// Phase 3: Record event
	const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, false, null);
	recordEvent(rec);
	return undefined;
});

	// ─── Command: repair on/off toggle ────────────────────────────
	pi.registerCommand("repair-on", {
		description: "Enable the repair layer (auto-fixes LLM tool arg mistakes)",
		handler: async (_args, ctx) => {
			if (repairToggle.isEnabled()) {
				showInfo(ctx, "🔧 repair: already on");
				return;
			}
			repairToggle.on();
			setRepairStatus(ctx);
			showInfo(ctx, repairToggle.getNotifyMessage());
		},
	});

	pi.registerCommand("repair-off", {
		description: "Disable the repair layer (passes raw tool args through)",
		handler: async (_args, ctx) => {
			if (!repairToggle.isEnabled()) {
				showInfo(ctx, "🔧 repair: already off");
				return;
			}
			repairToggle.off();
			setRepairStatus(ctx);
			showInfo(ctx, repairToggle.getNotifyMessage());
		},
	});

	pi.registerCommand("repair-toggle", {
		description: "Toggle repair layer on/off",
		handler: async (_args, ctx) => {
			repairToggle.toggle();
			setRepairStatus(ctx);
			showInfo(ctx, repairToggle.getNotifyMessage());
		},
	});

	// ─── Command: in-memory session repair stats ─────────────────────
	pi.registerCommand("repair-stats-session", {
		description: "Show repair layer statistics for this session (in-memory)",
		handler: async (_args, ctx) => {
			const output = formatStats(stats);

			if (ctx.hasUI) {
				ctx.ui.notify(`📊 Repair Stats (this session)\n\n${output}\n\n💡 Tip: run /repair-stats-global for all-session aggregate.`, "info");
			} else {
				console.log("📊 Repair Stats (this session)");
				console.log(output);
				console.log("💡 Tip: run /repair-stats-global for all-session aggregate.");
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
				ctx.ui.notify(`${output}\n\n💡 Tip: run /repair-suggest to send patterns upstream and evolve the extension.`, "info");
			} else {
				console.log(output);
				console.log("💡 Tip: run /repair-suggest to send patterns upstream and evolve the extension.");
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

	// ─── Command: suggest new repairs via LLM analysis ───────────────
	// ─── Helper: gather data to show in confirmation message ────
	function getRepairOverview(): string {
		try {
			const allEvents = readAllEvents();
			const blindspots = computeBlindspots(allEvents);
			const stats = aggregateStats(allEvents);
			return `${allEvents.length} events, ${blindspots.length} blindspots, ${stats.totalErrors} errors`;
		} catch {
			return "failed to read repair logs";
		}
	}

	// ─── Helper: read codebase files for implementation ────────
	// ─── Command: suggest new repairs via LLM analysis ────────
	pi.registerCommand("repair-suggest", {
		description: "Analyze blindspots + event logs, suggest new repairs, and optionally generate implementation",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				showError(ctx, "❌ No active model found. Start a session first.");
				return;
			}

			// Pre-gather overview for confirm message
			console.error("[repair-layer] /repair-suggest: pre-gathering data...");
			const overview = getRepairOverview();

			// ── Phase 0: Confirm ─────────────────────────────────
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Analyze repair gaps?",
					`Using ${model.provider}/${model.id}
${overview}

This will consume LLM tokens. Continue?`,
				);
				if (!ok) {
					showInfo(ctx, "Cancelled.");
					return;
				}
			}

				// ── Phase 1: Analyze ─────────────────────────────────
			console.error("[repair-layer] /repair-suggest: analyzing with", model.id);

			// Show visible progress widget (no phase numbers — they flash by too fast)
			showProgress(ctx, [
				"🔧 Repair Suggest - Analyzing",
				"─────────────────────────",
				"  📊 Gathering repair data...",
			]);

			// Animated spinner helpers (declared outside try so finally can clean them up)
			let spinnerTimer: ReturnType<typeof setInterval> | null = null;
			let issueSpinnerTimer: ReturnType<typeof setInterval> | null = null;

			function stopSpinner() {
				if (spinnerTimer) {
					clearInterval(spinnerTimer);
					spinnerTimer = null;
				}
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					throw new Error(`API key resolution failed: ${auth.error}`);
				}

				const llmConfig: LLMConfig = {
					baseUrl: model.baseUrl,
					apiKey: auth.apiKey ?? "",
					modelId: model.id,
				};

				// Animated spinner for long-running phases (LLM calls)
				const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
				let spinnerIndex = 0;

				function startSpinner(message: string) {
					stopSpinner();
					spinnerTimer = setInterval(() => {
						spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
						showProgress(ctx, [
							"🔧 Repair Suggest - Analyzing",
							"─────────────────────────",
							` ${spinnerFrames[spinnerIndex]} ${message}`,
						]);
					}, 300);
				}

			// Phase callback — updates widget + status bar + spinner management
				const onPhase: PhaseCallback = (phase, message) => {
					// Always update status bar and widget
					if (ctx.hasUI) {
						ctx.ui.setStatus("repair-suggest", message);
					}
					console.error(`[repair-layer] /repair-suggest: ${message}`);
					showProgress(ctx, [
						"🔧 Repair Suggest - Analyzing",
						"─────────────────────────",
						`  ${message}`,
					]);

					// Start animated spinner during LLM calls, stop for fast phases
					if (phase === "calling-llm") {
						startSpinner(message);
					} else if (phase === "parsing" || phase === "formatting") {
						stopSpinner();
					}
				};

				const result = await generateSuggestions(llmConfig, undefined, undefined, onPhase);
				stopSpinner();
				const output = formatSuggestions(result);

				// Show success in widget
				showProgress(ctx, [
					"✅ Repair Suggest — Analysis Complete",
					"─────────────────────────",
					`Found ${result.suggestions.length} suggestion(s)`,
					`Events: ${result.analysisSummary.totalEvents} | Blindspots: ${result.analysisSummary.totalBlindspots}`,
				]);

				// Show result as notification
				showInfo(ctx, output);

				if (ctx.hasUI) {
					ctx.ui.setStatus("repair-suggest", "✅ Analysis complete");
				}

				// ── Phase 2: Open GitHub Issue with suggestion ──────
				const implementNow = result.recommendation.recommendedActions.filter(a => a.action === "implement");
				if (implementNow.length > 0 && ctx.hasUI) {
					const wantIssue = await ctx.ui.confirm(
						"Open GitHub Issue?",
						`Would you like to open a pre-filled GitHub Issue with the repair suggestion?\n` +
						`You just helped the repair-layer evolve automatically. Every issue like this` +
						` makes the extension smarter for everyone.\n\n` +
						`Recommended to implement ${implementNow.length} suggestion(s).\n` +
						`The LLM will compose a title + body with code hints — you review and submit.\n\n` +
						`Proceed?`,
					);

					if (wantIssue) {
						// Show progress for issue composition
						showProgress(ctx, [
							"✍️ Repair Suggest — Composing Issue",
							"─────────────────────────",
							"  ✍️ Composing GitHub Issue...",
						]);
						ctx.ui.setStatus("repair-suggest", "✍️ Composing GitHub Issue...");

						// Animated dots spinner during issue composition LLM call
						issueSpinnerTimer = setInterval(() => {
							const dots = ["", ".", "..", "..."];
							const dot = dots[Math.floor(Date.now() / 500) % 4];
							showProgress(ctx, [
								"✍️ Repair Suggest — Composing Issue",
								"─────────────────────────",
								`  ✍️ Composing GitHub Issue${dot}`,
							]);
						}, 150);

						const issue = await composeIssueContent(
							llmConfig,
							result.suggestions,
							result.recommendation,
							result.analysisSummary,
							undefined,
						);

						clearInterval(issueSpinnerTimer!);
						issueSpinnerTimer = null;

						const owner = "renatocaliari";
						const repo = "pi-tool-repair-layer";
						const issueUrl = buildIssueUrl(owner, repo, issue);

						// Show progress for browser open
						showProgress(ctx, [
							"🌐 Repair Suggest — Opening Browser",
							"─────────────────────────",
							"Opening GitHub issue in browser...",
						]);

						// Open browser (async, callback runs AFTER finally block)
						exec(`open "${issueUrl.replace(/"/g, "\\\"")}"`, { timeout: 5000 }, (_err) => {
							// The finally block already cleared the widget.
							// Re-show success so user sees confirmation.
							showProgress(ctx, [
								"✅ Repair Suggest — Complete!",
								"─────────────────────────",
								"Issue opened in browser.",
								"Review and click 'Submit new issue'.",
							]);
							// Clear widget after 5 seconds
							setTimeout(() => clearProgress(ctx), 5000);
						});

						showInfo(ctx,
							"✅ Issue pre-filled in your browser. Review and click 'Submit new issue'.\n\n" +
							"You just helped the repair-layer evolve. Every issue makes it smarter for everyone."
						);
					} else {
						showInfo(ctx, "Issue submission skipped. You can run /repair-suggest again anytime.");
					}
				} else if (implementNow.length === 0 && result.suggestions.length > 0) {
					showInfo(ctx, "No suggestions recommended for immediate implementation.");
				}
			} catch (err) {
				const errMsg = `Analysis failed: ${err}`;
				showError(ctx, errMsg);
			} finally {
				// Stop any running spinners (may still be ticking after exception)
				if (spinnerTimer) {
					clearInterval(spinnerTimer);
					spinnerTimer = null;
				}
				if (issueSpinnerTimer) {
					clearInterval(issueSpinnerTimer);
					issueSpinnerTimer = null;
				}
				// Clear the widget. If the issue-browser path was taken, its
				// exec callback will re-show a "Complete!" widget momentarily.
				clearProgress(ctx);
				if (ctx.hasUI) {
					ctx.ui.setStatus("repair-suggest", undefined);
				}
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
