/**
 * Formatting for repair suggestion output (terminal/notify).
 */

import type { SuggestResult } from "./types.js";

/**
 * Format suggestions as a human-readable tree for terminal/notify output.
 */
export function formatSuggestions(result: SuggestResult): string {
  const lines: string[] = [];

  lines.push("💡 Repair Suggestions (LLM-generated)");
  lines.push("─".repeat(50));
  lines.push("");

  lines.push(`📊 Analysis: ${result.analysisSummary.totalEvents} events | ` +
    `${result.analysisSummary.totalBlindspots} blindspots | ` +
    `${result.analysisSummary.totalRepairsApplied} repairs | ` +
    `${result.analysisSummary.totalErrors} errors`);

  if (result.analysisSummary.topErrorTypes.length > 0) {
    lines.push(`   Top errors: ${result.analysisSummary.topErrorTypes.map(e => `${e.type} (${e.count}x)`).join(", ")}`);
  }
  lines.push("");

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
