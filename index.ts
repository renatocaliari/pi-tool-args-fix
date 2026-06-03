/**
 * Repair Layer Extension — tool_call + tool_result handlers.
 *
 * Core insight: "open model bad at tool calling" is almost always a harness problem.
 * Apply ~10 structural repairs (path, array, boolean, number, JSON, etc.) to tool args
 * before execution. Content fields (command, code, oldText, newText) are NEVER touched.
 *
 * Handler logic lives in ./handlers/*.ts for maintainability.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyRelationalDefaults,
	isContentField,
	extractTextContent,
	repairObjectFields,
	extractPathsFromArgs,
	suggestAutoTimeout,
	ContentHashCache,
	buildEditMismatchContext,
	buildEnhancedEditMismatchGuidance,
	buildEditNonUniqueGuidance,
	buildEditWrongFileGuidance,
	extractFailedEditIndex,
	extractFailedEditPath,
	extractNonUniqueEditCount,
	buildStalenessGuidance,
	buildSequentialEditGuidance,
	buildCircuitBreakMessage,
	buildPathValidationGuidance,
	buildEmptySearchGuidance,
	buildEditLoopGuidance,
	resolvePath,
} from "./repairs.js";
import { formatDirectoryListing } from "./repairs/directory.js";
import { createStats, recordRepairs, RepairToggle } from "./stats.js";
import {
	recordEvent,
	readAllEvents,
	aggregateStats,
	pruneOldSessions,
	ConsecutiveFailureTracker,
	ConsecutiveEmptySearchTracker,
} from "./recorder.js";
import {
	getToolHelp,
	getErrorGuidance,
	translateSchemaValidationError,
	classifyErrorType,
} from "./recorder/classifier.js";
import type { RepairEvent } from "./recorder.js";
import { registerCommands } from "./handlers/commands.js";
import { summarizeRepairs } from "./handlers/utils.js";

// ─── Module-level state & helpers ────────────────────────────────────────

/** Tools where exit code 1 means "no results" (not an error). */
const NATIVE_CLI_TOOLS = new Set(["grep", "find", "ls"]);

/** Tools tracked for empty search loops. */
const EMPTY_SEARCH_TOOLS = new Set(["find", "grep", "ls"]);

/** Track which (toolName:errorType) pairs have already received error-type guidance. */
const guidedErrorPairs = new Set<string>();

/** Track last edit state per file for sequential edit overlap detection. */
interface LastEditState {
  oldText: string;
  edits: number;
  firstLine: string;
}
const lastEditPerFile = new Map<string, LastEditState>();

// ─── Tool Result Helpers ─────────────────────────────────────────────────

/** Build a tool_result repair event. */
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
 * the closest text region to the failed oldText.
 */
async function enhanceEditMismatchGuidance(
	event: any,
	baseGuidance: string,
	errorText: string,
): Promise<string | null> {
	let filePath: string | undefined = extractFailedEditPath(errorText);
	if (!filePath) {
		if (event.input?.path) {
			filePath = event.input.path;
		} else if (event.input?.files?.[0]?.path) {
			filePath = event.input.files[0].path;
		}
	}
	if (!filePath) return null;

	const resolved = resolvePath(filePath, process.env.HOME);

	let oldText: string | undefined;
	const failedIndex = extractFailedEditIndex(errorText);
	if (failedIndex !== undefined) {
		const edits = event.input?.edits as Array<{ oldText?: string }> | undefined;
		if (edits && edits[failedIndex] && typeof edits[failedIndex].oldText === "string") {
			oldText = edits[failedIndex].oldText;
		}
	} else {
		oldText = event.input?.oldText ?? event.input?.edits?.[0]?.oldText;
	}
	if (typeof oldText !== "string" || !oldText) return null;

	try {
		const fileContent = await fs.readFile(resolved, "utf-8");

		const nonUniqueCount = extractNonUniqueEditCount(errorText);
		if (nonUniqueCount !== undefined) {
			const nonUniqueGuidance = buildEditNonUniqueGuidance(fileContent, oldText, nonUniqueCount);
			if (nonUniqueGuidance) {
				return `${baseGuidance}\n\n${nonUniqueGuidance}`;
			}
		}

		const c = buildEditMismatchContext(fileContent, oldText);
		if (c) {
			return buildEnhancedEditMismatchGuidance(baseGuidance, c);
		}

		const inputPath: string = event.input?.path ?? filePath;
		return `${baseGuidance}\n\n${buildEditWrongFileGuidance(inputPath, filePath)}`;
	} catch {
		const fallbackPath = event.input?.path;
		if (fallbackPath && typeof fallbackPath === "string" && fallbackPath !== filePath) {
			const resolvedFallback = resolvePath(fallbackPath, process.env.HOME);
			try {
				const fileContent = await fs.readFile(resolvedFallback, "utf-8");

				const nonUniqueCount = extractNonUniqueEditCount(errorText);
				if (nonUniqueCount !== undefined) {
					const nonUniqueGuidance = buildEditNonUniqueGuidance(fileContent, oldText, nonUniqueCount);
					if (nonUniqueGuidance) {
						return `${baseGuidance}\n\n${nonUniqueGuidance}`;
					}
				}

				const c = buildEditMismatchContext(fileContent, oldText);
				if (c) {
					return buildEnhancedEditMismatchGuidance(baseGuidance, c);
				}

				return `${baseGuidance}\n\n${buildEditWrongFileGuidance(fallbackPath, filePath)}`;
			} catch {
				return null;
			}
		}
		return null;
	}
}

// ─── Main Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const stats = createStats();
	const failureTracker = new ConsecutiveFailureTracker();
	const emptySearchTracker = new ConsecutiveEmptySearchTracker();
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
		if (!repairToggle.isEnabled()) return undefined;

		const T = ["read", "write", "edit", "bash", "read_file", "edit_file", "write_file",
			"get_file_skeleton", "get_function", "replace_symbol", "find_symbol_references", "rename_symbol",
			"ffgrep", "fffind", "agent_browser", "web_search", "fetch_content", "code_search", "subagent",
			"ctx_execute", "ctx_execute_file", "ctx_fetch_and_index", "ctx_batch_execute", "ctx_index", "ctx_search",
			"run_experiment", "log_experiment", "grep", "find", "ls"];
		const repairableTools = new Set(T);

		if (!repairableTools.has(event.toolName)) return undefined;

		const originalInput = event.input as Record<string, unknown>;
		if (!originalInput || typeof originalInput !== "object") return undefined;

		const originalJson = JSON.stringify(originalInput);

		// Step 1: Apply field-level repairs
		const repaired = repairObjectFields(originalInput);

		// Step 2: Apply relational defaults
		const withDefaults = applyRelationalDefaults(repaired);

		// ── Step 3a: Auto-timeout injection (bash) ────────────────────
		if (event.toolName === "bash") {
			const command = withDefaults.command as string | undefined;
			const currentTimeout = withDefaults.timeout as number | undefined;
			if (typeof command === "string") {
				const suggested = suggestAutoTimeout(command, currentTimeout);
				if (suggested !== undefined) {
					withDefaults.timeout = suggested;
				}
			}
		}

		// ── Step 3b: Path validation (pre-flight ENOENT detection) ──────
		const paths = extractPathsFromArgs(withDefaults);
		const hasContentField = Object.keys(withDefaults).some(k => isContentField(k));
		if (paths.length > 0 && !hasContentField) {
			const invalidPaths: string[] = [];
			for (const p of paths) {
				const resolved = p.startsWith("~/") ? path.join(process.env.HOME || "/home/user", p.slice(2)) : p;
				if (!resolved) continue;
				if (resolved.startsWith("http") || resolved.startsWith("-")) continue;
				try {
					const exists = await fs.stat(resolved).then(s => s.isFile() || s.isDirectory()).catch(() => false);
					if (!exists) invalidPaths.push(resolved);
				} catch { /* skip */ }
			}
			if (invalidPaths.length > 0 && event.toolName !== "bash") {
				const guidance = buildPathValidationGuidance(invalidPaths, event.toolName);
				eventSeq++;
				recordEvent({
					ts: new Date().toISOString(),
					eventType: "tool_result",
					sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
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

		// ── Shared state for edit tool across Steps 3c, 3d, and Record ──
		let editPath: string | undefined;

		// ── Step 3c: Staleness check (edit tool) ───────────────────────
		if (event.toolName === "edit" || event.toolName === "edit_file") {
			if (event.toolName === "edit") {
				editPath = (event.input as Record<string, unknown>)?.path as string | undefined;
			} else {
				const files = (event.input as Record<string, unknown>)?.files as Array<Record<string, unknown>> | undefined;
				if (files && files.length > 0) {
					editPath = files[0]?.path as string | undefined;
				}
			}

			if (editPath) {
				const resolved = resolvePath(editPath, process.env.HOME);
				try {
					const content = await fs.readFile(resolved, "utf-8");
					if (contentHashCache.isStale(resolved, content)) {
						const lastTurn = contentHashCache.getLastReadTurn(resolved);
						const staleGuidance = buildStalenessGuidance(lastTurn);
						eventSeq++;
						recordEvent({
							ts: new Date().toISOString(),
							eventType: "tool_result",
							sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
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
				} catch { /* new file — fine */ }
			}
		}

		// ── Step 3d: Sequential edit overlap detection ─────────────────
		if (event.toolName === "edit" && editPath) {
			const prev = lastEditPerFile.get(editPath);
			if (prev) {
				const edits = (event.input as Record<string, unknown>)?.edits as Array<Record<string, unknown>> | undefined;
				if (edits && edits.length > 0) {
					const currentOldText = edits[0]?.oldText as string | undefined;
					if (currentOldText) {
						const currentFirstLine = currentOldText.split("\n")[0]!;
						if (prev.firstLine === currentFirstLine || prev.oldText === currentOldText) {
							const matchCount = stats.sequentials || 0;
							stats.sequentials = matchCount + 1;
							const guidance = buildSequentialEditGuidance(prev.firstLine, currentFirstLine, editPath, matchCount + 1);
							eventSeq++;
							recordEvent({
								ts: new Date().toISOString(),
								eventType: "tool_result",
								sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
								turnIndex: eventSeq,
								toolName: event.toolName,
								provider: ctx.model?.provider ?? "unknown",
								model: ctx.model?.id ?? "unknown",
								repairs: [],
								wasRepaired: false,
								executionFailed: true,
								executionErrorType: "EDIT_MISMATCH",
								wasHandled: true,
								handleType: "sequential_overlap",
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
				}
			}
		}

		// Step 4: Check if anything changed & collect repair descriptions
		const repairedJson = JSON.stringify(withDefaults);
		const repairSummary = originalJson !== repairedJson
			? summarizeRepairs(originalInput, withDefaults)
			: [];

		if (originalJson !== repairedJson) {
			recordRepairs(stats, repairSummary);

			const inputObj = event.input as Record<string, unknown>;
			for (const key of Object.keys(inputObj)) {
				delete inputObj[key];
			}
			Object.assign(inputObj, withDefaults);

			if (ctx.hasUI) {
				const summary = repairSummary.slice(0, 2).join("; ");
				const more = repairSummary.length > 2 ? ` (+${repairSummary.length - 2} more)` : "";
				ctx.ui.setStatus("repair-layer", ctx.ui.theme.fg("accent", `🔧 ${event.toolName}: ${summary}${more}`));
				setTimeout(() => setRepairStatus(ctx), 3000);
			}
		}

		// ── Record previous edit state for sequential overlap detection ─
		if (event.toolName === "edit" && editPath) {
			const edits = (event.input as Record<string, unknown>)?.edits as Array<Record<string, unknown>> | undefined;
			if (edits && edits.length > 0) {
				const oldText = edits[0]?.oldText as string;
				if (oldText) {
					lastEditPerFile.set(editPath, { oldText, edits: edits.length, firstLine: oldText.split("\n")[0] ?? oldText.slice(0, 80) });
				}
			}
		}

		// Record event for post-session analysis
		eventSeq++;
		recordEvent({
			ts: new Date().toISOString(),
			eventType: "tool_call",
			sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
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
			inputNullKeys: Object.entries(originalInput).filter(([_, v]) => v === null).map(([k]) => k),
			inputExtraProps: [],
		});

		return undefined;
	});

	// ─── tool_result handler ─────────────────────────────────────────────
	pi.on("tool_result", async (event, ctx) => {
		// Phase 1: Classify error
		let hasError = event.isError ?? false;
		let executionErrorType: string | null = null;
		let blindspotCategory: string | null = null;

		if (hasError) {
			const errorText = extractTextContent(event.content);
			executionErrorType = classifyErrorType(errorText);
			blindspotCategory = executionErrorType;

			if (NATIVE_CLI_TOOLS.has(event.toolName) && executionErrorType === null) {
				hasError = false;
				executionErrorType = null;
				blindspotCategory = null;
			}

			if (hasError && executionErrorType === null && !errorText) {
				hasError = false;
				blindspotCategory = null;
			}
		}

		const err = { hasError, executionErrorType, blindspotCategory };

		// Phase 2: Detect empty results (analytics only)
		if (!err.hasError && err.blindspotCategory === null) {
			const resText = extractTextContent(event.content);
			if (resText && (resText.trim() === "" || resText.trim() === "(no output)")) {
				err.blindspotCategory = "EMPTY_RESULT";
			}
		}

		// Phase 2.5: Detect empty search loops
		if (EMPTY_SEARCH_TOOLS.has(event.toolName) && !err.hasError) {
			const resText = extractTextContent(event.content);
			if (resText) {
				const input = event.input as Record<string, unknown> | undefined;
				const pattern = typeof input?.pattern === "string" ? input.pattern : null;
				let searchPattern = pattern;
				if (!pattern && typeof input?.command === "string") {
					const cmd = input.command as string;
					const m = cmd.match(/\bgrep\s+(?:-i\s+)?['"]?([\w.-]+)['"]?/);
					if (m) searchPattern = m[1];
				}
				if (searchPattern) {
					const trimmed = resText.trim();
					const isEmpty = trimmed === "" || trimmed === "(no output)" ||
						trimmed === "No files found matching pattern" ||
						trimmed.includes("No matches found") ||
						trimmed.toLowerCase().includes("no results");
					if (isEmpty) {
						const cnt = emptySearchTracker.recordEmpty(searchPattern);
						if (cnt >= 3) {
							const guidance = buildEmptySearchGuidance(searchPattern, cnt, event.toolName);
							const currentText = extractTextContent(event.content) ?? "";
							err.blindspotCategory = null;
							const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "empty_search_loop");
							recordEvent(rec);
							eventSeq++;
							return {
								content: [{ type: "text" as const, text: `${currentText}\n\n🔧 ${guidance}` }],
								isError: true,
							};
						}
					} else {
						emptySearchTracker.recordFound();
					}
				}
			}
		}

		// Phase 3: Consecutive failure tracking + CLI guidance injection
		if (err.hasError) {
			const inputKeys = Object.keys(event.input ?? {});
			const consecutiveCount = failureTracker.recordFailure(event.toolName, inputKeys);

			if (consecutiveCount >= 3) {
				err.blindspotCategory = "CONSECUTIVE_LOOP";
			}

			if (consecutiveCount >= 1 && err.executionErrorType !== "TOOL_NOT_FOUND") {
				const currentText = extractTextContent(event.content) ?? "";
				let helpText = getToolHelp(event.toolName);

				if (event.toolName === "edit" || event.toolName === "edit_file") {
					if (consecutiveCount >= 5) {
						helpText += "\n\n" + buildEditLoopGuidance(consecutiveCount);
					} else if (consecutiveCount >= 3) {
						helpText += "\n\n" + buildEditLoopGuidance(consecutiveCount);
					}
				}

				if (consecutiveCount >= 7) {
					const circuitBreakMsg = buildCircuitBreakMessage(event.toolName, consecutiveCount, currentText);
					err.blindspotCategory = null;
					const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "circuit_break", inputKeys);
					recordEvent(rec);
					eventSeq++;
					return { content: [{ type: "text" as const, text: circuitBreakMsg }], isError: true };
				}

				if ((event.toolName === "edit" || event.toolName === "edit_file") && err.executionErrorType === "EDIT_MISMATCH") {
					const enhanced = await enhanceEditMismatchGuidance(event, helpText, currentText);
					if (enhanced) helpText = enhanced;
				}

				err.blindspotCategory = null;
				const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "cli_guidance", inputKeys);
				recordEvent(rec);
				eventSeq++;
				return {
					content: [{ type: "text" as const, text: `${currentText}\n\n🔧 Tool guidance ──\n${helpText}` }],
					isError: true,
				};
			}
		} else {
			failureTracker.recordSuccess(event.toolName);
		}

		// Phase 4: Error-type guidance (first occurrence only)
		if (err.executionErrorType) {
			const guidanceKey = `${event.toolName}:${err.executionErrorType}`;
			if (!guidedErrorPairs.has(guidanceKey)) {
				guidedErrorPairs.add(guidanceKey);
				let guidanceText = getErrorGuidance(err.executionErrorType, event.toolName);

				if (err.executionErrorType === "EDIT_MISMATCH" && !err.blindspotCategory) {
					const errorText = extractTextContent(event.content) ?? "";
					const enhanced = await enhanceEditMismatchGuidance(event, guidanceText, errorText);
					if (enhanced) guidanceText = enhanced;
				}

				if (err.executionErrorType === "SCHEMA_VALIDATION") {
					const errorText = extractTextContent(event.content) ?? "";
					const translated = translateSchemaValidationError(errorText);
					if (translated) guidanceText = `❗ ${translated}\n\n${guidanceText}`;
				}

				if (guidanceText) {
					const currentText = extractTextContent(event.content) ?? "";
					err.blindspotCategory = null;
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

		// Phase 5: EISDIR directory fallback (read / read_file)
		if (err.hasError && err.executionErrorType === "EISDIR" && (event.toolName === "read" || event.toolName === "read_file")) {
			const inputPath = (event.input as Record<string, unknown>)?.path;
			if (typeof inputPath === "string" && inputPath) {
				let resolvedPath = inputPath;
				if (resolvedPath.startsWith("~/")) {
					resolvedPath = path.join(process.env.HOME || process.env.USERPROFILE || "/home/user", resolvedPath.slice(2));
				}
				try {
					const stat = await fs.stat(resolvedPath);
					if (stat.isDirectory()) {
						const entries = await fs.readdir(resolvedPath);
						const { listingContent } = formatDirectoryListing(resolvedPath, entries, event.toolName);
						err.hasError = false;
						err.executionErrorType = null;
						err.blindspotCategory = null;
						const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "directory_fallback");
						recordEvent(rec);
						return { content: [{ type: "text" as const, text: listingContent }], isError: false };
					}
				} catch { /* not a dir */ }
			}
		}

		// Phase 6: Record content hash for staleness tracking
		if (!err.hasError && (event.toolName === "read" || event.toolName === "read_file")) {
			const inputPath = (event.input as Record<string, unknown>)?.path;
			if (typeof inputPath === "string" && inputPath) {
				const resolved = inputPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", inputPath.slice(2)) : inputPath;
				const content = extractTextContent(event.content);
				if (content && content.length < 500_000) {
					try {
						const fileContent = await fs.readFile(resolved, "utf-8").catch(() => null);
						if (fileContent !== null) {
							contentHashCache.setHash(resolved, fileContent);
							contentHashCache.recordRead(resolved, eventSeq);
						}
					} catch { /* skip */ }
				}
			}
		}

		// Phase 7: Write tool directory fallback
		if (!err.hasError && event.toolName === "write") {
			const inputPath = (event.input as Record<string, unknown>)?.path;
			if (typeof inputPath === "string" && inputPath) {
				const resolved = inputPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", inputPath.slice(2)) : inputPath;
				if (!path.extname(resolved)) {
					try {
						const stat = await fs.stat(resolved);
						if (stat.isDirectory()) {
							const entries = await fs.readdir(resolved);
							const { listingContent } = formatDirectoryListing(resolved, entries, "write");
							return { content: [{ type: "text" as const, text: listingContent }], isError: false };
						}
					} catch { /* not a dir */ }
				}
			}
		}

		// Phase 8: Record event
		const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, false, null);
		recordEvent(rec);
		return undefined;
	});

	// ─── Register commands from handler module ────────────────────────
	registerCommands(pi, {
		stats,
		failureTracker,
		emptySearchTracker,
		repairToggle,
		contentHashCache,
		eventSeq: { get value() { return eventSeq; }, set value(v) { eventSeq = v; } },
		lastEditPerFile,
		guidedErrorPairs,
		setRepairStatus,
	} as any);
}
