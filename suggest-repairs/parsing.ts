/**
 * Parsing functions for LLM responses in the suggestion engine.
 */

import type { RepairSuggestion, Recommendation, CodeGenResult, IssueContent, EffortLevel } from "./types.js";
import { extractJSON } from "./llm-client.js";

/**
 * Parse the LLM response into structured suggestions.
 * Gracefully handles malformed responses.
 */
export function parseSuggestions(raw: string): RepairSuggestion[] {
  const json = extractJSON(raw);

  try {
    const parsed = JSON.parse(json);
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

/**
 * Parse the recommendation section from the raw LLM response.
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
 * Parse code generation result from LLM response.
 */
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

/**
 * Parse GitHub Issue content from LLM response.
 */
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
    const titleMatch = json.match(/"title"\s*:\s*"([^"]+)"/);
    const body = tryExtractBody(json);
    if (titleMatch) {
      const title = titleMatch[1];
      if (body) {
        return { title, body };
      }
      return { title, body: "(partial — LLM response was truncated)" };
    }
    return {
      title: "Repair suggestion (auto-generated)",
      body: `Could not parse LLM response. See console for details.\n\nRaw response:\n\`\`\`\n${raw.slice(0, 2000)}\n\`\`\``,
    };
  }
}

/**
 * Best-effort body extraction from truncated JSON.
 */
function tryExtractBody(json: string): string | null {
  const bodyMatch = json.match(/"body"\s*:\s*"([\s\S]*)$/);
  if (!bodyMatch) return null;
  let content = bodyMatch[1];
  content = content.replace(/"\s*\}\s*$/, "");
  content = content.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (content.length > 8000) {
    content = content.slice(0, 8000) + "\n\n*(truncated — LLM response was cut off)*";
  }
  return content;
}
