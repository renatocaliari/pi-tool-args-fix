/**
 * Repair suggestion engine — analyzes blindspots + event patterns and
 * generates prioritized repair suggestions using an LLM.
 *
 * This module is the barrel + orchestrator for the suggestion pipeline.
 * The actual implementations live in suggest-repairs/*.ts.
 *
 * Flow:
 *   1. Gather blindspots, aggregate stats, and raw event samples
 *   2. Build structured context prompt
 *   3. Call LLM (OpenAI-compatible HTTP) → structured JSON response
 *   4. Parse into typed suggestions with implementation plans
 */

export type {
  EffortLevel,
  PhaseCallback,
  RepairSuggestion,
  Recommendation,
  CodeChange,
  CodeGenResult,
  IssueContent,
  SuggestResult,
  LLMConfig,
} from "./suggest-repairs/types.js";

export { generateCodeChanges } from "./suggest-repairs/code-gen.js";
export { composeIssueContent, buildIssueUrl } from "./suggest-repairs/issue.js";
export { formatSuggestions } from "./suggest-repairs/formatting.js";
export { parseSuggestions, parseRecommendation, parseIssueContent, parseCodeGenResult } from "./suggest-repairs/parsing.js";
export { callLLM, extractJSON } from "./suggest-repairs/llm-client.js";
export { gatherAnalysisData, buildUserPrompt, SYSTEM_PROMPT } from "./suggest-repairs/analysis.js";

import { gatherAnalysisData, buildUserPrompt, SYSTEM_PROMPT } from "./suggest-repairs/analysis.js";
import { callLLM } from "./suggest-repairs/llm-client.js";
import { parseSuggestions, parseRecommendation } from "./suggest-repairs/parsing.js";
import type { SuggestResult, LLMConfig, PhaseCallback } from "./suggest-repairs/types.js";

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
  const recommendation = parseRecommendation(rawResponse);

  onPhase?.("formatting", "✨ Formatting suggestions...");

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
