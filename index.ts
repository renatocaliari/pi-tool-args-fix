/**
 * Repair Layer Extension — tool_call + tool_result + context handlers.
 *
 * Three-layer architecture for cache-friendly tool repair:
 *
 * 1. tool_call  → pre-execution repair + validation, queues guidance
 * 2. tool_result → analytics only, queues guidance, returns undefined (history untouched)
 * 3. context    → injects queued guidance into shallow-copied messages (LLM sees it, no cache impact)
 *
 * Pre-execution repairs (null stripping, array wrapping, etc.) have ZERO cache impact.
 * Post-execution guidance NEVER enters the conversation history.
 * The only cache miss per error type is the FIRST occurrence of a minimal block message.
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
	REPAIRABLE_TOOLS,
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

/**
 * Track which guidance strings have been injected this session.
 * Keyed by kind prefix + categorical inputs. Once injected, never re-injected.
 */
const injectedGuidance = new Set<string>();

/**
 * Guidance queued for the next `context` event.
 * These are injected into the LLM's deep-copied message array (not persisted).
 */
const pendingGuidance: string[] = [];

/** Track last edit state per file for sequential edit overlap detection. */
interface LastEditState {
  oldText: string;
  edits: number;
  firstLine: string;
}
const lastEditPerFile = new Map<string, LastEditState>();

// ─── Session-local state (reset on each session_start) ───────────────────
let stats = createStats();
let failureTracker = new ConsecutiveFailureTracker();
let emptySearchTracker = new ConsecutiveEmptySearchTracker();
let repairToggle = new RepairToggle(true);
let contentHashCache = new ContentHashCache();
let eventSeq = 0;

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
	repairSkipped = false,
	wouldHaveRepaired: string[] = [],
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
		repairSkipped,
		wouldHaveRepaired,
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
 * Queue guidance for the next `context` event if not already injected this session.
 * Returns true if guidance was queued (first occurrence), false if already injected.
 *
 * ALL guidance goes through this function — it ensures:
 * 1. One-shot per (key) per session
 * 2. stats counter is incremented
 * 3. Guidance text enters pendingGuidance (not tool_result.content)
 */
function queueGuidance(key: string, text: string, injectStats: boolean): boolean {
	if (injectedGuidance.has(key)) return false;
	injectedGuidance.add(key);
	if (injectStats) stats.guidanceInjections++;
	pendingGuidance.push(text);
	return true;
}

/**
 * Enhanced EDIT_MISMATCH guidance: tries to read the target file and find
 * the closest text region to the failed oldText.
 */
async function buildEditMismatchGuidanceText(
	event: any,
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
			if (nonUniqueGuidance) return nonUniqueGuidance;
		}

		const c = buildEditMismatchContext(fileContent, oldText);
		if (c) return buildEnhancedEditMismatchGuidance(getToolHelp("edit"), c);

		const inputPath: string = event.input?.path ?? filePath;
		return buildEditWrongFileGuidance(inputPath, filePath);
	} catch {
		const fallbackPath = event.input?.path;
		if (fallbackPath && typeof fallbackPath === "string" && fallbackPath !== filePath) {
			const resolvedFallback = resolvePath(fallbackPath, process.env.HOME);
			try {
				const fileContent = await fs.readFile(resolvedFallback, "utf-8");
				const nonUniqueCount = extractNonUniqueEditCount(errorText);
				if (nonUniqueCount !== undefined) {
					const nonUniqueGuidance = buildEditNonUniqueGuidance(fileContent, oldText, nonUniqueCount);
					if (nonUniqueGuidance) return nonUniqueGuidance;
				}
				const c = buildEditMismatchContext(fileContent, oldText);
				if (c) return buildEnhancedEditMismatchGuidance(getToolHelp("edit"), c);
				return buildEditWrongFileGuidance(fallbackPath, filePath);
			} catch {
				return null;
			}
		}
		return null;
	}
}

/**
 * Minimal block message returned by pre-execution validators.
 * Always the same string — byte-identical across all sessions → cache-friendly.
 * The detailed guidance goes via pendingGuidance → context event → shallow copy.
 */
const BLOCK_MESSAGE = "[repair-layer] blocked";

// ─── Main Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Reset session state
	stats = createStats();
	failureTracker = new ConsecutiveFailureTracker();
	emptySearchTracker = new ConsecutiveEmptySearchTracker();
	repairToggle = new RepairToggle(true);
	contentHashCache = new ContentHashCache();
	eventSeq = 0;
	injectedGuidance.clear();
	pendingGuidance.length = 0;
	lastEditPerFile.clear();

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

	// ─── tool_call handler — pre-execution repair + validation ───────────
	pi.on("tool_call", async (event, ctx) => {
		const isOff = !repairToggle.isEnabled();

		const repairableTools = REPAIRABLE_TOOLS;

		if (!repairableTools.has(event.toolName)) return undefined;

		const originalInput = event.input as Record<string, unknown>;
		if (!originalInput || typeof originalInput !== "object") return undefined;

		// When OFF: compute what WOULD have been repaired, then return early
		if (isOff) {
			const originalJson = JSON.stringify(originalInput);
			const repaired = repairObjectFields(originalInput);
			const withDefaults = applyRelationalDefaults(repaired);
			const repairedJson = JSON.stringify(withDefaults);
			const wouldHaveRepaired = originalJson !== repairedJson
				? summarizeRepairs(originalInput, withDefaults)
				: [];

			eventSeq++;
			recordEvent({
				ts: new Date().toISOString(),
				eventType: "tool_call",
				sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
				turnIndex: eventSeq,
				toolName: event.toolName,
				provider: ctx.model?.provider ?? "unknown",
				model: ctx.model?.id ?? "unknown",
				repairs: [],
				wasRepaired: false,
				repairSkipped: true,
				wouldHaveRepaired,
				executionFailed: false,
				executionErrorType: null,
				wasHandled: false,
				handleType: null,
				blindspotCategory: null,
				inputKeys: Object.keys(originalInput),
				inputNullKeys: [],
				inputExtraProps: [],
			});
			return undefined;
		}

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
				// Queue detailed guidance via side channel, return minimal block message
				queueGuidance(
					`path:${event.toolName}:${JSON.stringify(invalidPaths)}`,
					buildPathValidationGuidance(invalidPaths, event.toolName),
					true,
				);
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
					repairSkipped: false,
					wouldHaveRepaired: [],
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
					content: [{ type: "text" as const, text: BLOCK_MESSAGE }],
					isError: true,
				};
			}
		}

		// ── Step 3b-ii: EISDIR pre-flight (read/read_file) ──────────────
		if ((event.toolName === "read" || event.toolName === "read_file") && !hasContentField) {
			const readPath = originalInput?.path as string | undefined;
			if (typeof readPath === "string") {
				const resolved = readPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", readPath.slice(2)) : readPath;
				try {
					const stat = await fs.stat(resolved);
					if (stat.isDirectory()) {
						const entries = await fs.readdir(resolved);
						const { listingContent } = formatDirectoryListing(resolved, entries, event.toolName);
					eventSeq++;
					recordEvent({
						ts: new Date().toISOString(),
						eventType: "tool_result",
						sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
						turnIndex: eventSeq,
						toolName: event.toolName,
						provider: ctx.model?.provider ?? "unknown",
						model: ctx.model?.id ?? "unknown",
						repairs: ["directory fallback"],
						wasRepaired: true,
						repairSkipped: false,
						wouldHaveRepaired: [],
						executionFailed: false,
						executionErrorType: null,
						wasHandled: true,
						handleType: "directory_fallback",
						blindspotCategory: null,
						inputKeys: Object.keys(originalInput),
						inputNullKeys: [],
						inputExtraProps: [],
					});
						return {
							content: [{ type: "text" as const, text: listingContent }],
							isError: false,
						};
					}
				} catch { /* not a dir — let tool handle */ }
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
						// Queue guidance via side channel, return minimal block message
						queueGuidance(
							`stale:${resolved}`,
							buildStalenessGuidance(),
							true,
						);
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
							repairSkipped: false,
							wouldHaveRepaired: [],
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
							content: [{ type: "text" as const, text: BLOCK_MESSAGE }],
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
							// Queue guidance via side channel
							queueGuidance(
								`seq:${editPath}:${JSON.stringify([prev.firstLine, currentFirstLine])}`,
								buildSequentialEditGuidance(prev.firstLine, currentFirstLine, editPath),
								true,
							);
							const matchCount = stats.sequentials || 0;
							stats.sequentials = matchCount + 1;
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
								repairSkipped: false,
								wouldHaveRepaired: [],
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
								content: [{ type: "text" as const, text: BLOCK_MESSAGE }],
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

			// Queue repair notification for context event
			if (repairSummary.length > 0) {
				const repairNotice = `🔧 ${event.toolName}: ${repairSummary.join("; ")}`;
				queueGuidance(`repair:${event.toolName}:${originalJson.length}`, repairNotice, true);
			}

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
			repairSkipped: false,
			wouldHaveRepaired: [],
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

	// ─── tool_result handler — analytics + guidance queue ──
	pi.on("tool_result", async (event, ctx) => {
		const isOff = !repairToggle.isEnabled();

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

		// Phase 2.5: Detect empty search loops (analytics + guidance queue only)
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
							// Always record the event for analytics
							const emptyKey = `empty:${event.toolName}:${searchPattern}`;
							err.blindspotCategory = null;
							const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "empty_search_loop", undefined, isOff);
							recordEvent(rec);
							eventSeq++;

							// Queue guidance via side channel (once per pattern) — skip when toggle OFF
							if (!isOff) {
								queueGuidance(
									emptyKey,
									buildEmptySearchGuidance(searchPattern, undefined, event.toolName),
									true,
								);
							}
							// Return early — result already handled (event recorded, guidance queued).
							// Prevents Phase 7 from recording a duplicate event.
							return undefined;
						}
					} else {
						emptySearchTracker.recordFound();
					}
				}
			}
		}

		// Phase 3: Consecutive failure tracking + guidance queue
		if (err.hasError) {
			const inputKeys = Object.keys(event.input ?? {});
			const consecutiveCount = failureTracker.recordFailure(event.toolName, inputKeys);

			if (consecutiveCount >= 3) {
				err.blindspotCategory = "CONSECUTIVE_LOOP";
			}

			if (consecutiveCount >= 1 && err.executionErrorType !== "TOOL_NOT_FOUND") {
				// Circuit-break (7+) — skip guidance when toggle OFF
				if (consecutiveCount >= 7 && !isOff) {
					queueGuidance(
						`cb:${event.toolName}`,
						buildCircuitBreakMessage(event.toolName, undefined, undefined),
						true,
					);
				}

				// CLI guidance (1st failure per tool) — skip when toggle OFF
				if (!isOff) {
					queueGuidance(
						`cli:${event.toolName}`,
						getToolHelp(event.toolName),
						true,
					);
				}

				// Edit loop guidance (3+ failures on edit) — skip when toggle OFF
				if (!isOff && (event.toolName === "edit" || event.toolName === "edit_file") && consecutiveCount >= 3) {
					queueGuidance(
						`edit-loop:${event.toolName}:${consecutiveCount >= 5 ? "major" : "minor"}`,
						buildEditLoopGuidance(consecutiveCount),
						true,
					);
				}

				// Enhanced EDIT_MISMATCH guidance — skip when toggle OFF
				if (!isOff && (event.toolName === "edit" || event.toolName === "edit_file") && err.executionErrorType === "EDIT_MISMATCH") {
					const errorText = extractTextContent(event.content) ?? "";
					const enhanced = await buildEditMismatchGuidanceText(event, errorText);
					if (enhanced) {
						queueGuidance(
							`edit-mismatch:${event.toolName}:${errorText.slice(0, 60)}`,
							enhanced,
							true,
						);
					}
				}
			}

			if (consecutiveCount >= 1) {
				err.blindspotCategory = null;
				const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "cli_guidance", inputKeys, isOff);
				recordEvent(rec);
				return undefined;
			}
		} else {
			failureTracker.recordSuccess(event.toolName);
		}

		// Phase 4: Error-type guidance (first occurrence only) — skip guidance when toggle OFF
		if (err.executionErrorType) {
			const guidanceKey = `cat:${event.toolName}:${err.executionErrorType}`;
			let guidanceText = getErrorGuidance(err.executionErrorType, event.toolName);

			if (err.executionErrorType === "EDIT_MISMATCH" && !err.blindspotCategory) {
				const errorText = extractTextContent(event.content) ?? "";
				const enhanced = await buildEditMismatchGuidanceText(event, errorText);
				if (enhanced) guidanceText = enhanced;
			}

			if (err.executionErrorType === "SCHEMA_VALIDATION") {
				const errorText = extractTextContent(event.content) ?? "";
				const translated = translateSchemaValidationError(errorText);
				if (translated) guidanceText = `❗ ${translated}\n\n${guidanceText}`;
			}

			if (guidanceText && !isOff) {
				queueGuidance(guidanceKey, guidanceText, true);
			}

			err.blindspotCategory = null;
			const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "category_guidance", undefined, isOff);
			recordEvent(rec);
			return undefined;
		}

		// Phase 5: Record content hash for staleness tracking
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

		// Phase 6: Write tool directory fallback
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

		// Phase 7: Record event
		const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, false, null, undefined, isOff);
		recordEvent(rec);
		return undefined;
	});

	// ─── context event handler — injects queued guidance via side channel ──
	// Cache-stability invariant: we shallow-copy the messages array and ONLY push
	// new entries. We never mutate existing message objects in place. The returned
	// array is what the LLM sees for this turn; `event.messages` itself is never
	// touched, so the prefix stays byte-identical and DeepSeek's cache holds.
	// Regression test: repairs.test.ts → "context handler returns new array reference".
	pi.on("context", async (event, _ctx) => {
		// Always accumulate LLM cache stats from message usage, regardless
		// of whether we'll push guidance. This gives the user visibility
		// into their actual cache hit rate via /repair-cache-info.
		//
		// Source: `usage.cacheRead` and `usage.cacheWrite` on assistant
		// messages (set by the LLM provider each turn).
		// Per Claude's docs: "We run alerts on our prompt cache hit rate."
		for (const m of event.messages) {
			const msg = (m as any)?.message ?? m;
			if (msg?.role === "assistant" && msg?.usage) {
				const u = msg.usage;
				stats.totalCacheRead += u.cacheRead ?? 0;
				stats.totalCacheWrite += u.cacheWrite ?? 0;
				stats.totalUncachedInput += u.input ?? 0;
			}
		}

		// If no guidance queued, return undefined (no-op, no array copy).
		if (pendingGuidance.length === 0) return;

		// Shallow copy — push only, never mutate elements. See invariant above.
		const messages = [...event.messages];
		messages.push({
			role: "user" as const,
			content: [{ type: "text" as const, text: pendingGuidance.join("\n\n") }],
		});
		pendingGuidance.length = 0;

		return { messages };
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
		injectedGuidance,
		setRepairStatus,
	} as any);
}
