/**
 * Repair Layer Extension — tool_call + tool_result + context handlers.
 *
 * Three-layer architecture for cache-friendly tool repair:
 *
 * 1. tool_call  → pre-execution repair + validation, queues guidance
 * 2. tool_result → analytics only, queues guidance, returns undefined (history untouched)
 * 3. context    → injects queued guidance into shallow-copied messages (LLM sees it, no cache impact)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	applyRelationalDefaults,
	isContentField,
	extractTextContent,
	repairObjectFields,
	extractBashPaths,
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
	getGuidancePriority,
	resolvePath,
	REPAIRABLE_TOOLS,
} from "./repairs.js";
import { formatDirectoryListing } from "./repairs/directory.js";
import { createStats, recordRepairs, parseRepairType, RepairToggle } from "./stats.js";
import {
	recordEvent,
	readAllEvents,
	pruneOldSessions,
	getLifetimeSessionCount,
	incrementLifetimeSessionCount,
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
 * Read a file from disk and update the ContentHashCache.
 * Shared helper used by Phase 5 for edit/write/read cache updates.
 * Returns true if the cache was updated, false on error.
 */
async function updateCacheFromFile(resolvedPath: string): Promise<boolean> {
	try {
		const fileContent = await fs.readFile(resolvedPath, "utf-8").catch(() => null);
		if (fileContent !== null) {
			contentHashCache.setHash(resolvedPath, fileContent);
			contentHashCache.recordRead(resolvedPath, eventSeq);
			return true;
		}
	} catch { /* skip */ }
	return false;
}

/**
 * Cap for the total guidance text injected into a single `context` event.
 *
 * Pending guidance is a side-channel buffer that accumulates across many
 * tool calls. With one-shot dedup, a session with many distinct repair /
 * error kinds could grow the join unboundedly — a single huge guidance
 * message would burn more LLM context and more cache budget than it's
 * worth. 2000 chars is ~500 tokens, well below the cache-miss budget
 * the user is willing to pay for guidance in one turn.
 *
 * Convention: when the cap is exceeded, drop OLDEST items first (FIFO)
 * and prepend a transparent marker so the LLM (and the user) knows the
 * full history exists in JSONL. Items dropped are NOT re-injected in
 * later turns — they remain in the JSONL log for analytics.
 */
const MAX_GUIDANCE_INJECTION_CHARS = 2000;

/**
 * Queue guidance for the next `context` event if not already injected this session.
 * Returns true if guidance was queued (first occurrence), false if already injected.
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

		// No close match — show file preview so LLM can see actual content
		const allLines = fileContent.split('\n');
		const previewLines = allLines.slice(0, 15);
		const preview = previewLines.map((l, i) => `${String(i + 1).padStart(4)}│ ${l}`).join('\n');
		const suffix = allLines.length > 15 ? `\n  ... (${allLines.length - 15} more lines)` : '';
		return [
			`📄 File preview (first ${previewLines.length} lines):`,
			'```',
			preview + suffix,
			'```',
			'',
			`The oldText did not match any content in this file.`,
			`The content may have changed, or you may be editing the wrong file.`,
			`Please re-read the file and re-apply the edit with exact current text.`,
		].join('\n');
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
				// No close match — show file preview
				const fallbackAllLines = fileContent.split('\n');
				const fallbackPreviewLines = fallbackAllLines.slice(0, 15);
				const fallbackPreview = fallbackPreviewLines.map((l, i) => `${String(i + 1).padStart(4)}│ ${l}`).join('\n');
				const fallbackSuffix = fallbackAllLines.length > 15 ? `\n  ... (${fallbackAllLines.length - 15} more lines)` : '';
				return [
					`📄 File preview (first ${fallbackPreviewLines.length} lines):`,
					'```',
					fallbackPreview + fallbackSuffix,
					'```',
					'',
					`The oldText did not match any content in this file.`,
					`The content may have changed, or you may be editing the wrong file.`,
					`Please re-read the file and re-apply the edit with exact current text.`,
				].join('\n');
			} catch {
				return null;
			}
		}
		return null;
	}
}

/** Minimal block message returned by pre-execution validators. */
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
	pruneOldSessions(50);

	// ─── TUI indicator: show/hide repair status in footer ───
	// Strategy: try multiple surfaces in order of preference, all wrapped in
	// try/catch since the runner may not have bound every method yet.
	//   1. setStatus  — pi's built-in footer slot ("extension statuses")
	//   2. setTitle   — terminal window/tab title (always visible in tmux/iTerm)
	// At least one of these will display in any pi mode (TUI/RPC/print).
	// Note: setStatus value is PLAIN TEXT (no ANSI codes) so powerline's
	// normalizeCompactExtensionStatus picks it up. The powerline handles
	// coloring via its own theme system using customItems config.
	function setRepairStatus(ctx: any): void {
		const display = repairToggle.getStatusDisplay();
		const isOn = repairToggle.isEnabled();
		try { ctx.ui.setStatus("repair-layer", display); } catch { /* no-op */ }
		// Title: 🔧 prefix only when ON, status at end so user can scan
		// without reading full title. Format: '🔧 π | repair: on' vs
		// 'π | repair: off'. The 🔧 acts as visual beacon for ON state.
		try {
			const status = isOn ? "repair: on" : "repair: off";
			const title = isOn ? `🔧 π | ${status}` : `π | ${status}`;
			ctx.ui.setTitle(title);
		} catch { /* no-op */ }
	}

	pi.on("session_start", async (_event, ctx) => {
		// Best-effort early attempt (may not stick — pi overrides title during TUI init).
		setRepairStatus(ctx);
		// Retry after TUI finishes init so the title sticks.
		setTimeout(() => setRepairStatus(ctx), 2000);

		const count = incrementLifetimeSessionCount();
		if (count > 0) {
			ctx.ui.notify(
				`📊 Repair Layer Active — ${count} session(s) logged.\n` +
				`Type /repair-stats-session for details, /repair-suggest to suggest new fixes.`,
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

		// Count every tool_call the handler receives — used as denominator
		// in the wouldHaveRepaired impact line (X of Y tool calls had issues).
		stats.totalToolCalls++;

		if (!repairableTools.has(event.toolName)) return undefined;

		const originalInput = event.input as Record<string, unknown>;
		if (!originalInput || typeof originalInput !== "object") return undefined;

		// Clone original input for accurate logging and repair detection
		// (repair functions mutate objects in-place)
		const originalInputClone = JSON.parse(JSON.stringify(originalInput));
		const originalNullKeys = Object.entries(originalInputClone)
			.filter(([_, v]) => v === null)
			.map(([k]) => k);

		// When OFF: compute what WOULD have been repaired, then return early.
		// Use the pure (non-trace) repair function — we discard the trace summary
		// anyway and recompute it via summarizeRepairs below.
		if (isOff) {
			const repairedFields = repairObjectFields(originalInputClone);
			const withDefaults = applyRelationalDefaults(repairedFields);
			const repairedJson = JSON.stringify(withDefaults);
			const originalJson = JSON.stringify(originalInputClone);

			const wouldHaveRepaired = originalJson !== repairedJson
				? summarizeRepairs(originalInputClone, withDefaults)
				: [];

			// G3 surface: count would-have-repaired items by type for in-memory
			// surfacing in /repair-stats-session. Mirrors the JSONL aggregation
			// in recorder.aggregateStats (bySkippedRepairType).
			if (wouldHaveRepaired.length > 0) {
				stats.wouldHaveRepairedTotal += wouldHaveRepaired.length;
				for (const detail of wouldHaveRepaired) {
					const type = parseRepairType(detail);
					if (type) {
						const count = stats.wouldHaveRepairedByType.get(type) ?? 0;
						stats.wouldHaveRepairedByType.set(type, count + 1);
					}
				}
			}

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
				inputKeys: Object.keys(originalInputClone),
				inputNullKeys: originalNullKeys,
				inputExtraProps: [],
			});
			return undefined;
		}

		const originalJson = JSON.stringify(originalInputClone);

		// Step 1: Apply field-level repairs (pure function returns new object)
		const repairedFields = repairObjectFields(originalInput);

		// Step 2: Apply relational defaults
		const withDefaults = applyRelationalDefaults(repairedFields);

		// ── Step 3a: Auto-timeout injection (bash) ────────────────────
		// When timeout is missing (stripped null), inject a sensible default.
		// This prevents the TUI from showing "stripped null" as the parameter
		// value (it displays original args before repair) AND ensures every
		// bash command has a safety timeout. Convention: 300s (5 min) for any
		// command where suggestAutoTimeout didn't produce a better value.
		if (event.toolName === "bash") {
			const command = withDefaults.command as string | undefined;
			const currentTimeout = withDefaults.timeout as number | undefined;
			if (typeof command === "string") {
				const suggested = suggestAutoTimeout(command, currentTimeout);
				if (suggested !== undefined) {
					withDefaults.timeout = suggested;
				} else if (withDefaults.timeout === undefined) {
					withDefaults.timeout = 300;
				}
			}
		}

		// ── Step 3b: Path validation (pre-flight ENOENT detection) ──────
		const paths = extractPathsFromArgs(withDefaults);

		// Bash: also extract unquoted path-like tokens that extractPathsFromArgs misses
		// (cat file.ts, ./script.sh, etc.)
		if (event.toolName === "bash" && typeof withDefaults.command === "string") {
			const cmd = withDefaults.command as string;
			const bashPaths = extractBashPaths(cmd);
			for (const p of bashPaths) {
				if (!paths.includes(p)) paths.push(p);
			}
			// cd <target> — target is always a path, even if bare name (no / or .)
			const cdMatch = cmd.match(/\bcd\s+(\S+)/);
			if (cdMatch) {
				const cdTarget = cdMatch[1]!.replace(/[;&|].*$/, "").trim();
				if (cdTarget && !cdTarget.startsWith("-") && !cdTarget.startsWith("$") && !paths.includes(cdTarget)) {
					paths.push(cdTarget);
				}
			}
		}

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
			if (invalidPaths.length > 0) {
				// Build directory listing hint for the first invalid path
				let dirHint = '';
				const firstInvalid = invalidPaths[0];
				const parentDir = path.dirname(firstInvalid);
				const basename = path.basename(firstInvalid);
				try {
					const parentExists = await fs.stat(parentDir).then(s => s.isDirectory()).catch(() => false);
					if (parentExists) {
						const entries = await fs.readdir(parentDir);
						const limited = entries.slice(0, 20);
						const similar = entries.filter(e => e.toLowerCase().includes(basename.toLowerCase()));
						const listing = limited.map(e => `  ${e}`).join('\n');
						dirHint = '\n\n📁 Directory: ' + parentDir + '\n' + listing +
							(entries.length > 20 ? `\n  ... (${entries.length - 20} more)` : '');
						if (similar.length > 0) {
							dirHint += '\n\n💡 Similar entries: ' + similar.slice(0, 5).map(e => `"${e}"`).join(', ');
						}
					}
				} catch { /* skip */ }

				if (event.toolName !== "bash") {
					queueGuidance(
						`path:${event.toolName}:${JSON.stringify(invalidPaths)}`,
						buildPathValidationGuidance(invalidPaths, event.toolName) + dirHint,
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
						inputKeys: Object.keys(originalInputClone),
						inputNullKeys: originalNullKeys,
						inputExtraProps: [],
					});
					return { content: [{ type: "text" as const, text: BLOCK_MESSAGE }], isError: true };
				} else {
					// Bash: queue guidance but don't block — command may still work
					queueGuidance(
						`bash-path:${JSON.stringify(invalidPaths)}`,
						`⚠️ Path validation: ${invalidPaths.length} path(s) referenced in the command were not found.\n` +
						invalidPaths.map(p => `  - ${p}`).join("\n") + "\n\n" +
						"The command may still run, but verify these paths exist." + dirHint,
						true,
					);
				}
			}
		}

		// NOTE: EISDIR directory fallback for read/read_file is in tool_result (Phase 2.75).
		// tool_call cannot return replacement content — only { block: true } is supported.

		// ── Shared state for edit tool across Steps 3c, 3d, and Record ──
		let editPath: string | undefined;

		// ── Step 3c: Staleness check (edit tool) ───────────────────────
		if (event.toolName === "edit" || event.toolName === "edit_file") {
			if (event.toolName === "edit") {
				editPath = withDefaults?.path as string | undefined;
			} else {
				const files = withDefaults?.files as Array<Record<string, unknown>> | undefined;
				if (files && files.length > 0) {
					editPath = files[0]?.path as string | undefined;
				}
			}

			if (editPath) {
				const resolved = resolvePath(editPath, process.env.HOME);
				try {
					const content = await fs.readFile(resolved, "utf-8");
					if (contentHashCache.isStale(resolved, content)) {
						queueGuidance(`stale:${resolved}`, buildStalenessGuidance(), true);
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
							inputKeys: Object.keys(originalInputClone),
							inputNullKeys: originalNullKeys,
							inputExtraProps: [],
						});
						return { content: [{ type: "text" as const, text: BLOCK_MESSAGE }], isError: true };
					}
				} catch { /* skip */ }
			}
		}

		// ── Step 3d: Sequential edit overlap detection ─────────────────
		if (event.toolName === "edit" && editPath) {
			const prev = lastEditPerFile.get(editPath);
			if (prev) {
				const edits = withDefaults?.edits as Array<Record<string, unknown>> | undefined;
				if (edits && edits.length > 0) {
					const currentOldText = edits[0]?.oldText as string | undefined;
					if (currentOldText) {
						const currentFirstLine = currentOldText.split("\n")[0]!;
						if (prev.firstLine === currentFirstLine || prev.oldText === currentOldText) {
							queueGuidance(
								`seq:${editPath}`,
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
								inputKeys: Object.keys(originalInputClone),
								inputNullKeys: originalNullKeys,
								inputExtraProps: [],
							});
							return { content: [{ type: "text" as const, text: BLOCK_MESSAGE }], isError: true };
						}
					}
				}
			}
		}

		// Step 4: Check if anything changed & apply repairs
		const repairedJson = JSON.stringify(withDefaults);
		const finalRepairSummary = originalJson !== repairedJson
			? summarizeRepairs(originalInputClone, withDefaults)
			: [];

		if (originalJson !== repairedJson) {
			recordRepairs(stats, finalRepairSummary);
			if (finalRepairSummary.length > 0) {
				const repairNotice = `🔧 ${event.toolName}: ${finalRepairSummary.join("; ")}`;
				// Only inject guidance for directory fallback — the model cannot
				// see that the write was redirected. All other repairs (timeout,
				// offset, type coercion, etc.) are transparent: the model sees
				// the tool result and already knows the args were fixed.
				const hasDirectoryFallback = finalRepairSummary.some(s => s.includes("directory fallback"));
				if (hasDirectoryFallback) {
					// Cache-stable key: same repair SUMMARY = same key, regardless of input length.
					// Previously keyed on `originalJson.length` which collided when two different
					// inputs (different summary) happened to share a byte length — the second
					// variant's notice was suppressed. Sorting ensures key stability when
					// summarizeRepairs returns fields in different orders across runs.
					const summaryKey = finalRepairSummary.slice().sort().join("|");
					queueGuidance(`repair:${event.toolName}:${summaryKey}`, repairNotice, true);
				}
			}

			// Update event.input in-place (this is what the tool receives)
			const inputObj = event.input as Record<string, unknown>;
			for (const key of Object.keys(inputObj)) delete inputObj[key];
			Object.assign(inputObj, withDefaults);

			if (ctx.hasUI) {
				const summary = finalRepairSummary.slice(0, 2).join("; ");
				const more = finalRepairSummary.length > 2 ? ` (+${finalRepairSummary.length - 2} more)` : "";
				ctx.ui.setStatus("repair-layer", ctx.ui.theme.fg("accent", `🔧 ${event.toolName}: ${summary}${more}`));
				setTimeout(() => setRepairStatus(ctx), 3000);
			}
		}

		// ── Record previous edit state block ──
		if (event.toolName === "edit" && editPath) {
			const edits = (event.input as Record<string, unknown>)?.edits as Array<Record<string, unknown>> | undefined;
			if (edits && edits.length > 0) {
				const oldText = edits[0]?.oldText as string;
				if (oldText) {
					lastEditPerFile.set(editPath, { oldText, edits: edits.length, firstLine: oldText.split("\n")[0] ?? oldText.slice(0, 80) });
				}
			}
		}

		eventSeq++;
		recordEvent({
			ts: new Date().toISOString(),
			eventType: "tool_call",
			sessionId: (ctx.sessionManager as any)?.getSessionId?.() ?? "unknown",
			turnIndex: eventSeq,
			toolName: event.toolName,
			provider: ctx.model?.provider ?? "unknown",
			model: ctx.model?.id ?? "unknown",
			repairs: finalRepairSummary,
			wasRepaired: originalJson !== repairedJson,
			repairSkipped: false,
			wouldHaveRepaired: [],
			executionFailed: false,
			executionErrorType: null,
			wasHandled: false,
			handleType: null,
			blindspotCategory: null,
			inputKeys: Object.keys(originalInputClone),
			inputNullKeys: originalNullKeys,
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

			// Suppress false-positive bash errors. The pi bash tool's timeout
			// wrapper has a known bug where it emits "🔧 bash: timeout: stripped
			// null" in the TUI even when the command succeeded. But that text
			// is a TUI render artifact — it does NOT appear in the tool result
			// content. The real pattern we detect is: bash + isError + no
			// meaningful error type + content has actual output. This catches
			// the timeout-wrapper bug AND any other false-positive bash errors.
			if (hasError) executionErrorType = classifyErrorType(errorText);
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

			// False-positive guard: bash + isError + no classification + has
			// actual output = the tool wrapper flagged a non-critical issue
			// (like the broken timeout wrapper emitting "stripped null"). The
			// underlying command succeeded; the isError flag is just a wrapper
			// artifact. The LLM does NOT need guidance — clear the error so
			// the LLM sees only the output and no tokens are wasted on recovery.
			if (
				hasError &&
				event.toolName === "bash" &&
				executionErrorType === null &&
				errorText &&
				errorText.trim().length > 0
			) {
				hasError = false;
				blindspotCategory = null;
			}
		}

		const err = { hasError, executionErrorType, blindspotCategory };

		// Phase 2: Detect empty results
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
							const emptyKey = `empty:${event.toolName}:${searchPattern}`;
							err.blindspotCategory = null;
							const rec = buildToolResultEvent(event, ctx, eventSeq + 1, err, true, "empty_search_loop", undefined, isOff);
							recordEvent(rec);
							eventSeq++;
							if (!isOff) queueGuidance(emptyKey, buildEmptySearchGuidance(searchPattern, event.toolName), true);
							return undefined;
						}
					} else {
						emptySearchTracker.recordFound();
					}
				}
			}
		}

		// Phase 2.75: EISDIR fallback for read/read_file
		// Replaces EISDIR errors with directory listing, BEFORE Phase 3 early return.
		if (err.hasError && err.executionErrorType === "EISDIR" &&
				(event.toolName === "read" || event.toolName === "read_file")) {
			const inputPath = (event.input as Record<string, unknown>)?.path;
			if (typeof inputPath === "string" && inputPath) {
				const resolved = resolvePath(inputPath, process.env.HOME);
				try {
					const stat = await fs.stat(resolved);
					if (stat.isDirectory()) {
						const entries = await fs.readdir(resolved);
						const { listingContent } = formatDirectoryListing(resolved, entries, event.toolName);
						// Clear error state so Phase 3+ don't fire guidance
						err.hasError = false;
						err.executionErrorType = null;
						err.blindspotCategory = null;
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
							inputKeys: Object.keys(event.input ?? {}),
							inputNullKeys: [],
							inputExtraProps: [],
						});
						return { content: [{ type: "text" as const, text: listingContent }], isError: false };
					}
				} catch { /* skip */ }
			}
		}

		// Phase 3: Consecutive failure tracking + guidance queue
		if (err.hasError) {
			const inputKeys = Object.keys(event.input ?? {});
			const consecutiveCount = failureTracker.recordFailure(event.toolName, inputKeys);

			if (consecutiveCount >= 3) err.blindspotCategory = "CONSECUTIVE_LOOP";

			if (consecutiveCount >= 1 && err.executionErrorType !== "TOOL_NOT_FOUND") {
				if (consecutiveCount >= 7 && !isOff) {
					queueGuidance(`cb:${event.toolName}`, buildCircuitBreakMessage(event.toolName), true);
				}
				if (!isOff) {
					queueGuidance(`cli:${event.toolName}`, getToolHelp(event.toolName), true);
				}
				if (!isOff && (event.toolName === "edit" || event.toolName === "edit_file") && consecutiveCount >= 3) {
					queueGuidance(`edit-loop:${event.toolName}:${consecutiveCount >= 5 ? "major" : "minor"}`, buildEditLoopGuidance(consecutiveCount), true);
				}
				if (!isOff && (event.toolName === "edit" || event.toolName === "edit_file") && err.executionErrorType === "EDIT_MISMATCH") {
					const errorText = extractTextContent(event.content) ?? "";
					const enhanced = await buildEditMismatchGuidanceText(event, errorText);
					if (enhanced) {
						// Cache-stable key: file path, not error hash.
						// Previously used fnv1a(errorText) which created a unique key
						// per error — consecutive mismatches on the same file each
						// injected new guidance even though the advice is identical
						// ("re-read the file"). File path gives 1 guidance per file
						// per session, which is enough.
						const filePath = (event.input as Record<string, unknown>)?.path ?? "unknown";
						queueGuidance(`edit-mismatch:${event.toolName}:${filePath}`, enhanced, true);
					}
				}
				// Phase 4 (error-type) guidance overlaps with cli: guidance already
				// queued in Phase 3 for execution errors. The cat: key is defensively
				// skipped here for error types that cli: covers — currently all of them
				// since Phase 3 traps every hasError path. This guard prevents future
				// regressions if Phase 3's early return changes.
			}

			// Don't return early for TOOL_NOT_FOUND — Phase 3 queues no guidance
			// for this error type, and Phase 4 is the correct handler.
			if (consecutiveCount >= 1 && err.executionErrorType !== "TOOL_NOT_FOUND") {
				err.blindspotCategory = null;
				const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "cli_guidance", inputKeys, isOff);
				recordEvent(rec);
				return undefined;
			}
		} else {
			failureTracker.recordSuccess(event.toolName);
		}

		// Phase 4: Error-type guidance (only for types NOT covered by cli: in Phase 3)
		// Phase 3 traps most hasError paths via early return, but explicitly skips
		// TOOL_NOT_FOUND. This phase catches that gap.
		// Future: if new error types are added that Phase 3 shouldn't trap, add them here.
		if (err.executionErrorType) {
			// Skip if cli: already fired for this tool in Phase 3 (already handled).
			// Check injectedGuidance directly rather than REPAIRABLE_TOOLS because
			// Phase 3 explicitly excludes TOOL_NOT_FOUND from cli: injection, so
			// the tool may be repairable but cli: never fired.
			if (injectedGuidance.has(`cli:${event.toolName}`)) {
				err.blindspotCategory = null;
				const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "category_guidance", undefined, isOff);
				recordEvent(rec);
				return undefined;
			}
			const guidanceKey = `cat:${event.toolName}:${err.executionErrorType}`;
			let guidanceText = getErrorGuidance(err.executionErrorType, event.toolName);
			if (err.executionErrorType === "SCHEMA_VALIDATION") {
				const errorText = extractTextContent(event.content) ?? "";
				const translated = translateSchemaValidationError(errorText);
				if (translated) guidanceText = `❗ ${translated}\n\n${guidanceText}`;
			}
			if (guidanceText && !isOff) queueGuidance(guidanceKey, guidanceText, true);
			err.blindspotCategory = null;
			const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, true, "category_guidance", undefined, isOff);
			recordEvent(rec);
			return undefined;
		}

		// Phase 5: Record content hash + update after edit/write
		// After a successful edit or write, update ContentHashCache so
		// subsequent staleness checks don't false-positive on the same file.
		// Without this, sequential edits (edit A → edit B without re-read)
		// would be blocked as "file content changed" even though the model
		// itself was responsible for the change.
		if (!err.hasError) {
			const toolName = event.toolName;
			const isRead = toolName === "read" || toolName === "read_file";
			const isEdit = toolName === "edit" || toolName === "edit_file";
			const isWrite = toolName === "write";

			if (isRead || isEdit || isWrite) {
				let inputPath: string | undefined;

				if (isRead || isWrite || toolName === "edit") {
					inputPath = (event.input as Record<string, unknown>)?.path as string | undefined;
				} else if (toolName === "edit_file") {
					const files = (event.input as Record<string, unknown>)?.files as Array<Record<string, unknown>> | undefined;
					if (files && files.length > 0) {
						inputPath = files[0]?.path as string | undefined;
					}
				}

				if (typeof inputPath === "string" && inputPath) {
					const resolved = inputPath.startsWith("~/") ? path.join(process.env.HOME || "/home/user", inputPath.slice(2)) : inputPath;

					// For reads: skip hashing when returned content is very large
					if (isRead) {
						const content = extractTextContent(event.content);
						if (content && content.length < 500_000) {
							// Read the actual file to get a hash for staleness detection
							await updateCacheFromFile(resolved);
						}
					} else {
						// Edit/write: always update cache so sequential edits don't false-positive
						await updateCacheFromFile(resolved);
					}
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
					} catch { /* skip */ }
				}
			}
		}

		// Phase 7: Record event
		const rec = buildToolResultEvent(event, ctx, ++eventSeq, err, false, null, undefined, isOff);
		recordEvent(rec);
		return undefined;
	});

	pi.on("context", async (event, _ctx) => {
		// Set session ID once (for repair-log path in formatCacheInfo)
		if (!stats.sessionId) {
			stats.sessionId = (_ctx.sessionManager as any)?.getSessionId?.() ?? "unknown";
		}

		for (const m of event.messages) {
			const msg = (m as any)?.message ?? m;
			if (msg?.role === "assistant" && msg?.usage) {
				const u = msg.usage;
				stats.totalCacheRead += u.cacheRead ?? 0;
				stats.totalCacheWrite += u.cacheWrite ?? 0;
				stats.totalInputTokens += u.input ?? 0;
			}
		}
		
		if (!repairToggle.isEnabled()) {
			pendingGuidance.length = 0;
			return undefined;
		}

		if (pendingGuidance.length === 0) return undefined;

		// Cap the joined text to protect LLM prefix cache and context window.
		// Priority-based drop — drops LOWEST-priority items first (circuit breaker
		// outranks tool help). Only falls back to FIFO (shift) when priority tie.
		// Last-resort: if a single item still exceeds the cap after all others
		// are dropped, hard-truncate it. The cap is always enforced.
		const SEP = "\n\n";
		let suppressedCount = 0;
		while (pendingGuidance.length > 1 && pendingGuidance.join(SEP).length > MAX_GUIDANCE_INJECTION_CHARS) {
			// Find lowest-priority item (highest getGuidancePriority value)
			let lowestIdx = -1;
			let lowestPriority = -1;
			for (let i = 0; i < pendingGuidance.length; i++) {
				const p = getGuidancePriority(pendingGuidance[i]);
				if (p > lowestPriority) {
					lowestPriority = p;
					lowestIdx = i;
				}
			}
			if (lowestIdx >= 0) {
				pendingGuidance.splice(lowestIdx, 1);
			} else {
				pendingGuidance.shift();
			}
			suppressedCount++;
		}
		let guidanceText = pendingGuidance.join(SEP);
		if (guidanceText.length > MAX_GUIDANCE_INJECTION_CHARS) {
			guidanceText = guidanceText.slice(0, MAX_GUIDANCE_INJECTION_CHARS - 50) + "...[truncated, see JSONL log]";
			suppressedCount++;
		}
		if (suppressedCount > 0) {
			guidanceText = `(${suppressedCount} lower-priority guidance item${suppressedCount === 1 ? "" : "s"} suppressed — see JSONL log for full history)\n\n${guidanceText}`;
			stats.guidanceSuppressed += suppressedCount;
		}

		const messages = [...event.messages];
		messages.push({ role: "user" as const, content: [{ type: "text" as const, text: guidanceText }] });
		pendingGuidance.length = 0;
		return { messages };
	});
registerCommands(pi, {
	stats, failureTracker, emptySearchTracker, repairToggle, contentHashCache,
	eventSeq: { get value() { return eventSeq; }, set value(v) { eventSeq = v; } },
	lastEditPerFile, injectedGuidance, setRepairStatus,
} as any);
}

