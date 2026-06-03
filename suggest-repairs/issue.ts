/**
 * GitHub Issue composition — generates human-readable issue descriptions
 * for repair suggestions, suitable for opening via URL.
 */

import type { LLMConfig, RepairSuggestion, Recommendation, IssueContent, SuggestResult } from "./types.js";
import { callLLM } from "./llm-client.js";
import type { PhaseCallback } from "./types.js";
import { parseIssueContent } from "./parsing.js";

/**
 * Compose a GitHub Issue title and body describing the suggestions.
 */
export async function composeIssueContent(
  config: LLMConfig,
  suggestions: RepairSuggestion[],
  recommendation: Recommendation,
  analysisSummary: SuggestResult["analysisSummary"],
  onPhase?: PhaseCallback,
): Promise<IssueContent> {
  onPhase?.("composing-issue", "✍️ Composing GitHub Issue...");

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
