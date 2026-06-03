/**
 * Code generation — generates concrete code changes for implementing selected suggestions.
 */

import type { LLMConfig, RepairSuggestion, CodeGenResult } from "./types.js";
import { callLLM } from "./llm-client.js";
import type { PhaseCallback } from "./types.js";
import { parseCodeGenResult } from "./parsing.js";

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
