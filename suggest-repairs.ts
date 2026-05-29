/**
 * Repair suggestion engine — analyzes blindspots + event patterns and
 * generates prioritized repair suggestions using an LLM.
 *
 * Pure module (no pi extension API dependency). Designed for testability.
 *
 * Flow:
 *   1. Gather blindspots, aggregate stats, and raw event samples
 *   2. Build structured context prompt
 *   3. Call LLM (OpenAI-compatible HTTP) → structured JSON response
 *   4. Parse into typed suggestions with implementation plans
 */

import { readAllEvents, computeBlindspots, aggregateStats, type Blindspot, type AggregateStats, type RepairEvent } from "./recorder.js";

// ─── Types ────────────────────────────────────────────────────────────────

/** Duration/cost estimate for a suggestion. */
export type EffortLevel = "trivial" | "small" | "medium" | "large";

/**
 * Progress callback for phase reporting.
 * The handler uses this to update ctx.ui.setStatus at each phase.
 */
export type PhaseCallback = (phase: string, message: string) => void;

/** A single suggested repair or enhancement. */
export interface RepairSuggestion {
  /** Short descriptive title (e.g. "Fuzzy path matching for ENOENT errors") */
  title: string;

  /** Why this matters — evidence from the data */
  rationale: string;

  /** Effort estimate */
  effort: EffortLevel;

  /** Which blindspot category this addresses (null for general improvements) */
  addressesCategory: string | null;

  /** Which tools are affected */
  affectedTools: string[];

  /** Implementation plan — ordered steps */
  implementationPlan: string[];

  /** Expected impact description */
  expectedImpact: string;

  /** Any risks or trade-offs */
  risks: string;

  /** External references or patterns to research (URLs, library names) */
  researchLinks: string[];
}

/** Recommendation from the LLM about which suggestions to implement. */
export interface Recommendation {
  /** Overall critical assessment of the repair landscape */
  assessment: string;
  /** Per-suggestion actions with reasons */
  recommendedActions: {
    /** 1-based index into the suggestions array */
    suggestionIndex: number;
    /** Whether this suggestion should be implemented now, deferred, or rejected */
    action: "implement" | "defer" | "reject";
    /** Why this action was chosen */
    reason: string;
  }[];
}

/** A concrete code change to apply to the codebase. */
export interface CodeChange {
  /** File path relative to project root */
  file: string;
  /** Description of what this change does */
  description: string;
  /** Exact old text to replace (unique) */
  oldText: string;
  /** Replacement text */
  newText: string;
}

/** Result from the code generation call. */
export interface CodeGenResult {
  /** Changes to apply, in order */
  changes: CodeChange[];
  /** Files that need new test additions */
  testInstructions: string;
  /** Any risks or notes about the implementation */
  notes: string;
}

/** Result from composing a GitHub Issue. */
export interface IssueContent {
  /** Issue title */
  title: string;
  /** Issue body in GitHub markdown */
  body: string;
}

/** Result from the suggestion engine. */
export interface SuggestResult {
  /** When the analysis was generated */
  generatedAt: string;

  /** Summary of the data analyzed */
  analysisSummary: {
    totalEvents: number;
    totalBlindspots: number;
    totalRepairsApplied: number;
    totalErrors: number;
    topErrorTypes: { type: string; count: number }[];
    topRepairTypes: { type: string; count: number }[];
  };

  /** Generated suggestions, highest priority first */
  suggestions: RepairSuggestion[];

  /** Critical recommendation from the LLM (double-check analysis) */
  recommendation: Recommendation;

  /** Raw LLM response (for debugging) */
  rawResponse: string;
}

/** Configuration for calling an LLM. */
export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

// ─── Data Collection ──────────────────────────────────────────────────────

/**
 * Gather all analysis data needed for suggestion generation.
 * Reuses existing computeBlindspots and aggregateStats from recorder.ts.
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

  // Sample some interesting events for context:
  //  - Failed events with blindspot categories
  //  - Repaired events
  const failures = events.filter(
    (e) => e.executionFailed && e.blindspotCategory !== null,
  );
  const repairs = events.filter(
    (e) => e.wasRepaired && e.repairs.length > 0,
  );
  const handled = events.filter(
    (e) => e.wasHandled,
  );

  // Take a balanced sample (up to 15 of each)
  const sample: RepairEvent[] = [
    ...failures.slice(0, 15),
    ...repairs.slice(0, 10),
    ...handled.slice(0, 5),
  ].slice(0, 30);

  return { blindspots, stats, eventSample: sample, totalEvents: events.length };
}

// ─── LLM Prompt Building ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert in LLM tool-call reliability engineering.
You analyze telemetry data from a tool-call repair layer and suggest new repairs.

The repair layer intercepts LLM tool calls and fixes common argument mistakes:
- Stripping null/undefined from optional fields
- Parsing JSON strings into objects/arrays
- Wrapping bare values as arrays where expected
- Unwrapping markdown auto-links from paths
- Splitting comma-separated strings into arrays
- Coercing boolean/number strings to proper types
- Stripping extra properties from array items

Your task: Analyze blindspots (errors without repair coverage), repair patterns,
and raw event samples. Then suggest specific new repairs or improvements.

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

/**
 * Build the user prompt from analysis data.
 */
function buildUserPrompt(
  blindspots: Blindspot[],
  stats: AggregateStats,
  eventSample: RepairEvent[],
): string {
  const parts: string[] = [];

  // Aggregate stats
  parts.push("## Current State\n");
  parts.push(`- Total events: ${stats.totalCalls}`);
  parts.push(`- Repairs applied: ${stats.totalRepairs}`);
  parts.push(`- Execution errors: ${stats.totalErrors}`);
  parts.push(`- Handled events: ${stats.totalHandled}\n`);

  // Top error types
  const errorEntries = Object.entries(stats.byErrorType)
    .sort((a, b) => b[1] - a[1]);
  if (errorEntries.length > 0) {
    parts.push("### Error Types\n");
    for (const [type, count] of errorEntries) {
      parts.push(`- ${type}: ${count}x`);
    }
    parts.push("");
  }

  // Top repair types
  const repairEntries = Object.entries(stats.byRepairType)
    .sort((a, b) => b[1] - a[1]);
  if (repairEntries.length > 0) {
    parts.push("### Repair Types Applied\n");
    for (const [type, count] of repairEntries) {
      parts.push(`- ${type}: ${count}x`);
    }
    parts.push("");
  }

  // Blindspots
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

  // Current repair capabilities (existing code reference)
  parts.push("## Current Repair Capabilities\n");
  parts.push("The following repairs already exist (from repairs.ts):");
  parts.push("1. clean-path: unwrap markdown links, resolve ~/ paths");
  parts.push("2. parse-json: parse stringified JSON arrays/objects");
  parts.push("3. wrap-array: wrap bare strings/values as arrays");
  parts.push("4. wrap-object-as-array: wrap objects as single-element arrays");
  parts.push("5. split-string-to-array: split comma/space-separated strings");
  parts.push("6. coerce-boolean: convert 'true'/'yes'/'1' to boolean");
  parts.push("7. coerce-number: convert '42'/'3.14' to number");
  parts.push("8. strip-extra-properties: remove extra fields from array items");
  parts.push("9. applyRelationalDefaults: add missing offset/limit defaults");
  parts.push("10. isNullLikeString: strip null/none/n/a strings");
  parts.push("");

  parts.push("Field classification sets (from repairs.ts):");
  parts.push("- PATH_FIELD_NAMES: path, absolutePath, filePath, directory, cwd, target, dir, modulePath");
  parts.push("- ARRAY_FIELD_NAMES: edits, files, replacements, paths, queries, urls, commands, steps, ...");
  parts.push("- BOOLEAN_FIELD_NAMES: strict, force, verbose, quiet, debug, recursive, ...");
  parts.push("- CONTENT_FIELD_NAMES (NEVER TOUCH): content, text, command, oldText, newText, code, ...");
  parts.push("- NUMBER_FIELD_NAMES: offset, limit, timeout, concurrency, maxTokens, ...");
  parts.push("");

  // Tool usage stats
  parts.push("## Tool Usage\n");
  const toolEntries = Object.entries(stats.byTool)
    .sort((a, b) => b[1].calls - a[1].calls);
  parts.push("Tool | Calls | Repairs | Errors | Handled");
  parts.push("-----|-------|---------|--------|--------");
  for (const [tool, t] of toolEntries) {
    parts.push(`${tool} | ${t.calls} | ${t.repairs} | ${t.errors} | ${t.handled}`);
  }
  parts.push("");

  // Sample events
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
  parts.push("For each suggestion, research if similar patterns exist in known MCP/OpenAI tool-calling ecosystems.");
  parts.push("Prioritize suggestions that address actual blindspots with highest frequency first.");
  parts.push("Output valid JSON only.");

  return parts.join("\n");
}

// ─── LLM Call ─────────────────────────────────────────────────────────────

/**
 * Call an OpenAI-compatible chat completion API.
 */
export async function callLLM(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
  timeoutMs?: number,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const controller = new AbortController();
  const timeout = timeoutMs ?? 120_000; // 2 minutes default
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3, // Low temp for structured output
        max_tokens: 8192,
      }),
      signal: controller.signal,
    });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "unknown");
    throw new Error(
      `LLM API error: ${response.status} ${response.statusText}\n${errorBody}`,
    );
  }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM response missing content");
    }

    return content;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`LLM API timeout after ${timeout / 1000}s. The API took too long to respond.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract JSON from an LLM response that might contain markdown code fences
 * or other surrounding text.
 */
export function extractJSON(raw: string): string {
  // Try to find JSON within code fences first
  const jsonBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }
  // Try parsing the whole response as JSON
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed;
  }
  // Try to find {...} or [...] in the text
  const objectMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (objectMatch) return objectMatch[1].trim();
  const arrayMatch = trimmed.match(/(\[[\s\S]*\])/);
  if (arrayMatch) return arrayMatch[1].trim();

  return trimmed;
}

/**
 * Parse the LLM response into structured suggestions.
 * Gracefully handles malformed responses.
 */
export function parseSuggestions(raw: string): RepairSuggestion[] {
  const json = extractJSON(raw);

  try {
    const parsed = JSON.parse(json);

    // Handle { suggestions: [...] } wrapper
    const items = parsed.suggestions || parsed;

    if (!Array.isArray(items)) {
      console.error("[suggest-repairs] LLM response is not an array, wrapping");
      return [items as RepairSuggestion].filter((s) => s.title);
    }

    return items.map((item: any): RepairSuggestion => ({
      title: item.title || "Untitled suggestion",
      rationale: item.rationale || "",
      effort: validateEffort(item.effort),
      addressesCategory: item.addressesCategory ?? null,
      affectedTools: Array.isArray(item.affectedTools) ? item.affectedTools : [],
      implementationPlan: Array.isArray(item.implementationPlan) ? item.implementationPlan : [],
      expectedImpact: item.expectedImpact || "",
      risks: item.risks || "",
      researchLinks: Array.isArray(item.researchLinks) ? item.researchLinks : [],
    }));
  } catch (err) {
    console.error("[suggest-repairs] Failed to parse LLM response:", err);
    console.error("[suggest-repairs] Raw JSON extracted:", json.slice(0, 500));
    return [
      {
        title: "Error parsing LLM suggestions",
        rationale: `The LLM returned unparseable JSON. Raw response: ${raw.slice(0, 300)}...`,
        effort: "small",
        addressesCategory: null,
        affectedTools: [],
        implementationPlan: ["Check the raw LLM output and debug the prompt"],
        expectedImpact: "N/A — parse failure",
        risks: "N/A",
        researchLinks: [],
      },
    ];
  }
}

function validateEffort(e: string): EffortLevel {
  if (["trivial", "small", "medium", "large"].includes(e)) return e as EffortLevel;
  return "medium";
}

// ─── High-Level API ───────────────────────────────────────────────────────

/**
 * Run the full suggestion pipeline:
 *   1. Gather analysis data
 *   2. Call LLM
 *   3. Parse structured suggestions
 *   4. Return result
 */
export async function generateSuggestions(
  llmConfig: LLMConfig,
  logDir?: string,
  systemPromptOverride?: string,
  onPhase?: PhaseCallback,
): Promise<SuggestResult> {
  onPhase?.("gathering", "📊 Gathering repair data...");
  const { blindspots, stats, eventSample, totalEvents } = gatherAnalysisData(logDir);

  onPhase?.("building-prompt", "📝 Building analysis prompt with " + blindspots.length + " blindspots...");
  const userPrompt = buildUserPrompt(blindspots, stats, eventSample);

  onPhase?.("calling-llm", "🤖 Analyzing patterns with LLM (may take a minute)...");
  const rawResponse = await callLLM(
    llmConfig,
    systemPromptOverride ?? SYSTEM_PROMPT,
    userPrompt,
  );

  onPhase?.("parsing", "🔍 Parsing LLM response...");
  const suggestions = parseSuggestions(rawResponse);

  // Parse recommendation from raw response
  const recommendation = parseRecommendation(rawResponse);

  onPhase?.("formatting", "✨ Formatting suggestions...");

  // Compute summary
  const errorEntries = Object.entries(stats.byErrorType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  const repairEntries = Object.entries(stats.byRepairType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([type, count]) => ({ type, count }));

  return {
    generatedAt: new Date().toISOString(),
    analysisSummary: {
      totalEvents,
      totalBlindspots: blindspots.length,
      totalRepairsApplied: stats.totalRepairs,
      totalErrors: stats.totalErrors,
      topErrorTypes: errorEntries,
      topRepairTypes: repairEntries,
    },
    suggestions,
    recommendation,
    rawResponse,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Parse the recommendation section from the raw LLM response.
 * Falls back to a default recommendation if parsing fails.
 */
export function parseRecommendation(raw: string): Recommendation {
  const json = extractJSON(raw);
  try {
    const parsed = JSON.parse(json);
    const rec = parsed.recommendation;
    if (!rec) {
      return {
        assessment: "The LLM did not provide a critical assessment.",
        recommendedActions: [],
      };
    }
    return {
      assessment: rec.assessment || "No assessment provided.",
      recommendedActions: Array.isArray(rec.recommendedActions)
        ? rec.recommendedActions.map((a: any) => ({
            suggestionIndex: a.suggestionIndex ?? 0,
            action: a.action || "defer",
            reason: a.reason || "",
          }))
        : [],
    };
  } catch {
    return {
      assessment: "Could not parse LLM recommendation. Review suggestions manually.",
      recommendedActions: [],
    };
  }
}

/**
 * Format suggestions as a human-readable tree for terminal/notify output.
 */
export function formatSuggestions(result: SuggestResult): string {
  const lines: string[] = [];

  lines.push("💡 Repair Suggestions (LLM-generated)");
  lines.push("─".repeat(50));
  lines.push("");

  // Summary
  lines.push(`📊 Analysis: ${result.analysisSummary.totalEvents} events | ` +
    `${result.analysisSummary.totalBlindspots} blindspots | ` +
    `${result.analysisSummary.totalRepairsApplied} repairs | ` +
    `${result.analysisSummary.totalErrors} errors`);

  if (result.analysisSummary.topErrorTypes.length > 0) {
    lines.push(`   Top errors: ${result.analysisSummary.topErrorTypes.map(e => `${e.type} (${e.count}x)`).join(", ")}`);
  }
  lines.push("");

  // ── Critical Recommendation ──
  if (result.recommendation.assessment) {
    lines.push("🔎 Critical Analysis");
    lines.push("─".repeat(50));
    lines.push(result.recommendation.assessment);
    lines.push("");

    if (result.recommendation.recommendedActions.length > 0) {
      const implementNow = result.recommendation.recommendedActions.filter(a => a.action === "implement");
      const deferred = result.recommendation.recommendedActions.filter(a => a.action !== "implement");

      if (implementNow.length > 0) {
        lines.push("✅  Recommended to implement now:");
        for (const a of implementNow) {
          const sug = result.suggestions[a.suggestionIndex - 1];
          lines.push(`   ${a.suggestionIndex}. ${sug?.title || "Unknown"}`);
          lines.push(`      ${a.reason}`);
        }
        lines.push("");
      }

      if (deferred.length > 0) {
        lines.push(`⏸️  Deferred/rejected:`);
        for (const a of deferred) {
          const sug = result.suggestions[a.suggestionIndex - 1];
          lines.push(`   ${a.suggestionIndex}. ${sug?.title || "Unknown"} (${a.action})`);
          lines.push(`      ${a.reason}`);
        }
        lines.push("");
      }
    }
  }

  if (result.recommendation.recommendedActions.filter(a => a.action === "implement").length > 0) {
    lines.push('💬 Action: reply "implement" to auto-implement the recommended repairs');
    lines.push("");
  }

  // Suggestions
  for (let i = 0; i < result.suggestions.length; i++) {
    const s = result.suggestions[i];
    const effortIcon = s.effort === "trivial" ? "🟢" : s.effort === "small" ? "🔵" : s.effort === "medium" ? "🟡" : "🔴";

    lines.push(`${effortIcon}  ${i + 1}. ${s.title}`);
    lines.push(`   ${s.rationale}`);
    lines.push(`   Effort: ${s.effort}`);

    if (s.addressesCategory) {
      lines.push(`   Addresses: ${s.addressesCategory}`);
    }
    if (s.affectedTools.length > 0) {
      lines.push(`   Tools: ${s.affectedTools.join(", ")}`);
    }

    lines.push(`   Expected: ${s.expectedImpact}`);

    if (s.risks) {
      lines.push(`   ⚠️ ${s.risks}`);
    }

    if (s.implementationPlan.length > 0) {
      lines.push(`   Plan:`);
      for (const step of s.implementationPlan) {
        lines.push(`     • ${step}`);
      }
    }

    if (s.researchLinks.length > 0) {
      lines.push(`   Research:`);
      for (const link of s.researchLinks) {
        lines.push(`     ${link}`);
      }
    }

    lines.push("");
  }

  lines.push("───");
  lines.push(`Generated at: ${result.generatedAt}`);

  return lines.join("\n");
}

/**
 * Generate concrete code changes for implementing selected suggestions.
 * Reads the actual codebase files and asks the LLM to produce edit blocks.
 */
export async function generateCodeChanges(
  config: LLMConfig,
  suggestions: RepairSuggestion[],
  codeFiles: { path: string; content: string }[],
  onPhase?: PhaseCallback,
): Promise<CodeGenResult> {
  onPhase?.("reading-codebase", "📖 Reading codebase structure...");

  // Build code context
  const codeContext = codeFiles.map(f =>
    `## File: ${f.path}\n\`\`\`typescript\n${f.content}\n\`\`\``
  ).join("\n\n");

  const suggestionsContext = suggestions.map((s, i) =>
    `## Suggestion #${i + 1}: ${s.title}\nRationale: ${s.rationale}\nEffort: ${s.effort}\nAddresses: ${s.addressesCategory || "general"}\nTools: ${s.affectedTools.join(", ")}\nPlan:\n${s.implementationPlan.map(p => `  - ${p}`).join("\n")}`
  ).join("\n\n");

  const systemPrompt = `You are an expert TypeScript developer implementing repair functions for a tool-call repair layer.

Generate concrete code changes to implement the requested repairs.

Rules:
1. Only output valid JSON matching the schema below, no other text.
2. Each change must have EXACT oldText that exists in the file.
3. Changes should be minimal and focused.
4. Follow the existing pattern in repairs.ts: pure functions, exported, tested.
5. Also suggest test additions for the new functions.

Output ONLY valid JSON:
{
  "changes": [
    {
      "file": "repairs.ts" | "index.ts" | "repairs.test.ts",
      "description": "What this change does",
      "oldText": "exact existing text to replace",
      "newText": "replacement text"
    }
  ],
  "testInstructions": "What tests to add and how",
  "notes": "Any risks or implementation notes"
}`;

  const userPrompt = `## Current Codebase\n\n${codeContext}\n\n## Suggestions to Implement\n\n${suggestionsContext}\n\nGenerate the exact code changes needed to implement the repair functions and integrate them into the pipeline.\n\nFor each change, provide the EXACT oldText that exists in the file and the exact replacement newText.`;

  onPhase?.("generating-code", "⚡ Generating code changes with LLM...");
  const raw = await callLLM(config, systemPrompt, userPrompt);
  return parseCodeGenResult(raw);
}

export function parseCodeGenResult(raw: string): CodeGenResult {
  const json = extractJSON(raw);
  try {
    const parsed = JSON.parse(json);
    return {
      changes: Array.isArray(parsed.changes)
        ? parsed.changes.map((c: any) => ({
            file: c.file || "",
            description: c.description || "",
            oldText: c.oldText || "",
            newText: c.newText || "",
          }))
        : [],
      testInstructions: parsed.testInstructions || "",
      notes: parsed.notes || "",
    };
  } catch (err) {
    console.error("[suggest-repairs] Failed to parse code generation:", err);
    return {
      changes: [],
      testInstructions: `Parse error: ${err}`,
      notes: "LLM returned unparseable JSON for code generation.",
    };
  }
}

// ─── GitHub Issue Composition ─────────────────────────────────────────────

/**
 * Compose a GitHub Issue title and body describing the suggestions.
 * The LLM generates a human-readable report with embedded code patches
 * suitable for opening as a GitHub Issue via URL query params.
 */
export async function composeIssueContent(
  config: LLMConfig,
  suggestions: RepairSuggestion[],
  recommendation: Recommendation,
  analysisSummary: SuggestResult["analysisSummary"],
  onPhase?: PhaseCallback,
): Promise<IssueContent> {
  onPhase?.("composing-issue", "✍️ Composing GitHub Issue...");

  // Build a concise context of what was found
  const errorContext = analysisSummary.topErrorTypes
    .map((e) => `  - ${e.type}: ${e.count}x`)
    .join("\n");

  const suggestionsContext = suggestions
    .map(
      (s, i) =>
        `### Suggestion #${i + 1}: ${s.title}\n` +
        `Rationale: ${s.rationale}\n` +
        `Effort: ${s.effort}\n` +
        `Addresses: ${s.addressesCategory || "general"}\n` +
        `Tools: ${s.affectedTools.join(", ")}\n` +
        `Expected: ${s.expectedImpact}\n` +
        (s.risks ? `Risks: ${s.risks}\n` : ""),
    )
    .join("\n---\n");

  const systemPrompt = `You are a helpful open-source contributor.

You write concise, actionable GitHub Issues for a tool-call repair layer extension.
The issue describes a blindspot in the repair layer — an error pattern that the
current repairs don't cover — and proposes concrete code changes to fix it.

Rules:
1. Title must be short and descriptive (under 80 chars).
2. Body must include:
   - Description of the bug/pattern (what, why it matters)
   - Evidence (error types, frequency, affected tools)
   - Proposed fix with code blocks (pseudo-implementation steps)
3. NO sensitive data (no repo names, user data, API keys).
4. Use GitHub-flavored markdown.
5. Be polite and constructive. This is a contribution.
6. Output ONLY valid JSON matching the schema below.

{
  "title": "string — short issue title under 80 chars",
  "body": "string — full GitHub markdown issue body"
}`;

  const userPrompt = `## Telemetry Analysis

Analyzed ${analysisSummary.totalEvents} repair events across log sessions.
- Blindspots found: ${analysisSummary.totalBlindspots}
- Repairs applied: ${analysisSummary.totalRepairsApplied}
- Execution errors: ${analysisSummary.totalErrors}

## Top Error Patterns
${errorContext}

## Recommendation
${recommendation.assessment || "No assessment provided."}

## Suggestions
${suggestionsContext}

Instructions:
Compose a GitHub Issue that reports the most impactful finding(s).
Include the recommendation context: which suggestion(s) to implement.
Include implementation clues (code-like blocks) but do NOT reference internal session data.
Title should be clear enough for a maintainer to understand at a glance.`;

  const raw = await callLLM(config, systemPrompt, userPrompt);
  return parseIssueContent(raw);
}

export function parseIssueContent(raw: string): IssueContent {
  const json = extractJSON(raw);
  try {
    const parsed = JSON.parse(json);
    return {
      title: parsed.title || "Repair suggestion",
      body: parsed.body || "",
    };
  } catch (err) {
    console.error("[suggest-repairs] Failed to parse issue content:", err);
    return {
      title: "Repair suggestion (auto-generated)",
      body: `Could not parse LLM response. See console for details.\n\nRaw response:\n\`\`\`\n${raw.slice(0, 2000)}\n\`\`\``,
    };
  }
}

/**
 * Build a GitHub URL to open a pre-filled issue.
 * No API token needed — uses query params supported by GitHub.
 */
export function buildIssueUrl(
  owner: string,
  repo: string,
  issue: IssueContent,
): string {
  const base = `https://github.com/${owner}/${repo}/issues/new`;
  const params = new URLSearchParams({
    title: issue.title,
    body: issue.body,
    labels: "suggestion",
  });
  return `${base}?${params.toString()}`;
}
