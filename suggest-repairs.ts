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

Output ONLY valid JSON matching this schema, no other text:
{
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
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

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
): Promise<SuggestResult> {
  const { blindspots, stats, eventSample, totalEvents } = gatherAnalysisData(logDir);
  const userPrompt = buildUserPrompt(blindspots, stats, eventSample);

  const rawResponse = await callLLM(
    llmConfig,
    systemPromptOverride ?? SYSTEM_PROMPT,
    userPrompt,
  );

  const suggestions = parseSuggestions(rawResponse);

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
    rawResponse,
  };
}

// ─── Formatting ─────────────────────────────────────────────────────────────

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
