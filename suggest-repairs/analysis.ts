/**
 * Analysis data collection and prompt building for the suggestion engine.
 */

import { readAllEvents, computeBlindspots, aggregateStats } from "../recorder.js";
import type { Blindspot, AggregateStats, RepairEvent } from "../recorder.js";

/**
 * Gather all analysis data needed for suggestion generation.
 */
export function gatherAnalysisData(
  logDir?: string,
): {
  blindspots: Blindspot[];
  stats: AggregateStats;
  eventSample: RepairEvent[];
  totalEvents: number;
} {
  const events = readAllEvents(logDir);
  const blindspots = computeBlindspots(events);
  const stats = aggregateStats(events);

  const failures = events.filter(
    (e) => e.executionFailed && e.blindspotCategory !== null,
  );
  const repairs = events.filter(
    (e) => e.wasRepaired && e.repairs.length > 0,
  );
  const handled = events.filter(
    (e) => e.wasHandled,
  );

  const sample: RepairEvent[] = [
    ...failures.slice(0, 15),
    ...repairs.slice(0, 10),
    ...handled.slice(0, 5),
  ].slice(0, 30);

  return { blindspots, stats, eventSample: sample, totalEvents: events.length };
}

export const SYSTEM_PROMPT = `You are an expert in LLM tool-call reliability engineering.
You analyze telemetry data from a tool-call repair layer and suggest new repairs.

The repair layer intercepts LLM tool calls in two layers:

DISPATCH-LEVEL field repairs (repairs.ts):
- Stripping null/undefined from optional fields
- Parsing JSON strings into objects/arrays
- Wrapping bare values as arrays where expected
- Unwrapping markdown auto-links from paths
- Splitting comma-separated strings into arrays
- Coercing boolean/number strings to proper types
- Stripping extra properties from array items

HANDLER-LEVEL protections (index.ts):
- Auto-timeout injection for bash commands (300s/120s/60s)
- Pre-flight path validation (blocks non-bash on ENOENT, guides for bash)
- Staleness check via ContentHashCache before edits
- EISDIR directory fallback for read/read_file
- Sequential edit overlap detection
- Empty search loop detection (3+ empties = change strategy)
- Circuit breaker (7+ consecutive failures = force strategy change)
- Enhanced EDIT_MISMATCH guidance with file context
- Write directory fallback
- ContentHashCache update after edit/write
- Priority-based guidance cap (circuit breaker > staleness > tool help)

Your task: Analyze blindspots (errors without repair coverage), repair patterns,
and raw event samples. Then suggest specific new repairs or improvements.

The \"Current Repair Capabilities\" section in the user prompt has the FULL current
feature set — read it carefully before suggesting anything that might already exist.

IMPORTANT RULES:
1. Only suggest repairs that are DETERMINISTIC — no ML, no fuzzy matching that could silently corrupt data.
2. Content fields (command, code, oldText, newText, text, content) must NEVER be touched.
3. Prefer simple field-level fixes over complex multi-field logic.
4. Each suggestion must include a concrete implementation plan.
5. Research the web for known patterns in MCP/OpenAI tool-calling that could inspire new fixes.

After generating suggestions, critically analyze them (double-check).
Which should be implemented now, which deferred, which rejected?
Consider: risk, effort, impact, side effects, existing coverage.

Output ONLY valid JSON matching this schema, no other text:
{
  "recommendation": {
    "assessment": "string — overall critical analysis. Which suggestions to implement now, which to defer/reject, and any implementation ordering or concerns.",
    "recommendedActions": [
      {
        "suggestionIndex": 1,
        "action": "implement|defer|reject",
        "reason": "string — why this action for this suggestion"
      }
    ]
  },
  "suggestions": [
    {
      "title": "string — short descriptive name",
      "rationale": "string — evidence-based why this matters",
      "effort": "trivial|small|medium|large",
      "addressesCategory": "string | null — blindspot category if applicable",
      "affectedTools": ["tool1", "tool2"],
      "implementationPlan": ["step 1", "step 2", "..."],
      "expectedImpact": "string — what improvement this brings",
      "risks": "string — trade-offs or edge cases",
      "researchLinks": ["url1", "url2"]
    }
  ]
}

Respond with valid JSON only.`;

// ─── Capability Constants ──────────────────────────────────────────────
// Single source of truth for what this extension does.
// Used by buildUserPrompt and tested against docs/repair-catalog.md.
// Update here first when adding new features, THEN update the catalog.

/** Dispatch-level field repairs (repairs.ts). */
export const DISPATCH_CAPABILITIES = [
  "clean-path: unwrap markdown links, resolve ~/ paths",
  "parse-json: parse stringified JSON arrays/objects",
  "wrap-array: wrap bare strings/values as arrays",
  "wrap-object-as-array: wrap objects as single-element arrays",
  "split-string-to-array: split comma/space-separated strings",
  "coerce-boolean: convert 'true'/'yes'/'1' to boolean",
  "coerce-number: convert '42'/'3.14' to number",
  "strip-extra-properties: remove extra fields from array items",
  "applyRelationalDefaults: add missing offset/limit defaults",
  "isNullLikeString: strip null/none/n/a strings",
];

/** Handler-level protections (index.ts). */
export const HANDLER_CAPABILITIES = [
  "Auto-timeout injection: injects 300s/120s/60s timeout for bash based on command pattern",
  "Path validation pre-flight: checks file existence before non-bash tools, blocks with guidance on ENOENT",
  "Path guidance for bash: queues guidance when bash command references non-existent paths (no block)",
  "Staleness check (ContentHashCache): reads file before edit, blocks if content changed since last read",
  "EISDIR directory fallback: read/read_file on a directory returns listing instead of error",
  "Sequential edit overlap: detects consecutive edits on same region without intervening read",
  "Empty search loop detection: find/grep/ls returning nothing 3x+ on same concept → injects strategy-change guidance",
  "Circuit breaker: 7+ consecutive failures on same tool → injects force-strategy-change guidance",
  "Enhanced EDIT_MISMATCH guidance: reads file, finds closest oldText match, provides context",
  "Write directory fallback: write to path without extension → list directory contents instead",
  "Edit loop guidance: 3+/5+ consecutive edit failures → tool-specific guidance for whitespace/indent issues",
  "ContentHashCache update after edit/write: prevents false-positive staleness blocks on sequential edits",
  "Priority-based guidance cap: circuit breaker > staleness > tool help when cap exceeded",
];

/** Error guidance & recovery functions. */
export const GUIDANCE_CAPABILITIES = [
  "getToolHelp(toolName): per-tool usage guidance for consecutive failures",
  "getErrorGuidance(category): per-error-category guidance (TOOL_NOT_FOUND, SCHEMA_VALIDATION, INVALID_ARG, etc.)",
  "translateSchemaValidationError: converts JSON Pointer errors into LLM-friendly language",
  "buildEmptySearchGuidance: strategy-change guidance for empty search loops",
  "buildEditMismatchContext: reads file to find closest oldText match",
  "buildCircuitBreakMessage / buildEditLoopGuidance: escalating guidance for repeated failures",
];

/** Features already analyzed and deferred (do NOT re-suggest). */
export const DEFERRED_FEATURES = [
  "Auto-resolve ENOENT by trying extensions (.ts, .js, .json): HIGH RISK of false positives",
  "Schema introspection for null stripping: current approach already strips all non-content nulls (more aggressive)",
  "Schema introspection for array wrapping: remaining uncovered cases are 1x frequency — not worth effort",
];

/**
 * Build the user prompt from analysis data.
 */
export function buildUserPrompt(
  blindspots: Blindspot[],
  stats: AggregateStats,
  eventSample: RepairEvent[],
): string {
  const parts: string[] = [];

  parts.push("## Current State\n");
  parts.push(`- Total events: ${stats.totalCalls}`);
  parts.push(`- Repairs applied: ${stats.totalRepairs}`);
  parts.push(`- Execution errors: ${stats.totalErrors}`);
  parts.push(`- Handled events: ${stats.totalHandled}\n`);

  const errorEntries = Object.entries(stats.byErrorType)
    .sort((a, b) => b[1] - a[1]);
  if (errorEntries.length > 0) {
    parts.push("### Error Types\n");
    for (const [type, count] of errorEntries) {
      parts.push(`- ${type}: ${count}x`);
    }
    parts.push("");
  }

  const repairEntries = Object.entries(stats.byRepairType)
    .sort((a, b) => b[1] - a[1]);
  if (repairEntries.length > 0) {
    parts.push("### Repair Types Applied\n");
    for (const [type, count] of repairEntries) {
      parts.push(`- ${type}: ${count}x`);
    }
    parts.push("");
  }

  if (blindspots.length > 0) {
    parts.push("## Blindspots (Errors Without Repair Coverage)\n");
    for (const spot of blindspots) {
      parts.push(`### ${spot.category} (${spot.toolName}) — ${spot.count}x`);
      parts.push(`- Models: ${spot.models.join(", ")}`);
      parts.push(`- First: ${spot.firstSeen} | Last: ${spot.lastSeen}`);
      parts.push(`- Example: ${spot.example}`);
      parts.push(`- Current suggestion: ${spot.suggestion}`);
      parts.push("");
    }
  } else {
    parts.push("## Blindspots\nNo blindspots detected.\n");
  }

  parts.push("## Current Repair Capabilities\n");
  parts.push("### Dispatch-Level Field Repairs (repairs.ts)\n");
  parts.push("The following repairs already exist (from repairs.ts):");
  for (let i = 0; i < DISPATCH_CAPABILITIES.length; i++) {
    parts.push(`${i + 1}. ${DISPATCH_CAPABILITIES[i]}`);
  }
  parts.push("");

  parts.push("Field classification sets:");
  parts.push("- PATH_FIELD_NAMES: path, absolutePath, filePath, directory, cwd, target, dir, modulePath");
  parts.push("- ARRAY_FIELD_NAMES: edits, files, replacements, paths, queries, urls, commands, steps, ...");
  parts.push("- BOOLEAN_FIELD_NAMES: strict, force, verbose, quiet, debug, recursive, ...");
  parts.push("- CONTENT_FIELD_NAMES (NEVER TOUCH): content, text, command, oldText, newText, code, ...");
  parts.push("- NUMBER_FIELD_NAMES: offset, limit, timeout, concurrency, maxTokens, ...");
  parts.push("");

  parts.push("### Handler-Level Protections (index.ts)\n");
  parts.push("The following protections run in the tool_call/tool_result handlers BEFORE the dispatch repairs:");
  for (let i = 0; i < HANDLER_CAPABILITIES.length; i++) {
    parts.push(`${i + 1}. ${HANDLER_CAPABILITIES[i]}`);
  }
  parts.push("");

  parts.push("### Error Guidance & Recovery (repairs/guidance.ts + recorder/classifier.ts)\n");
  parts.push("Context-aware help injected on tool failures:");
  for (const item of GUIDANCE_CAPABILITIES) {
    parts.push(`- ${item}`);
  }
  parts.push("");

  parts.push("### Already Deferred/Rejected Features\n");
  parts.push("The following were previously analyzed and deferred (do NOT re-suggest them):");
  for (let i = 0; i < DEFERRED_FEATURES.length; i++) {
    parts.push(`${i + 1}. ${DEFERRED_FEATURES[i]}`);
  }
  parts.push("");

  const toolEntries = Object.entries(stats.byTool)
    .sort((a, b) => b[1].calls - a[1].calls);
  parts.push("## Tool Usage\n");
  parts.push("Tool | Calls | Repairs | Errors | Handled");
  parts.push("-----|-------|---------|--------|--------");
  for (const [tool, t] of toolEntries) {
    parts.push(`${tool} | ${t.calls} | ${t.repairs} | ${t.errors} | ${t.handled}`);
  }
  parts.push("");

  if (eventSample.length > 0) {
    parts.push("## Sample Events\n");
    parts.push("```json");
    for (const evt of eventSample) {
      parts.push(JSON.stringify({
        tool: evt.toolName,
        type: evt.eventType,
        error: evt.executionErrorType,
        repairs: evt.repairs.length > 0 ? evt.repairs : undefined,
        blindspot: evt.blindspotCategory,
        handled: evt.wasHandled ? evt.handleType : undefined,
        keys: evt.inputKeys,
      }));
    }
    parts.push("```");
    parts.push("");
  }

  parts.push("## Task\n");
  parts.push("Based on the data above, suggest concrete new repairs or improvements.");
  parts.push("Prioritize suggestions that address actual blindspots with highest frequency first.");
  parts.push("Output valid JSON only.");

  return parts.join("\n");
}
