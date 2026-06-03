/**
 * LLM client — OpenAI-compatible chat completion API caller.
 *
 * Pure module (no pi extension API dependency).
 */

import type { LLMConfig } from "./types.js";

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
        temperature: 0.3,
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
 *
 * Uses backtracking with JSON.parse validation to handle nested ``` blocks
 * inside the JSON body (e.g. ```python ... ``` in a GitHub Issue body).
 */
export function extractJSON(raw: string): string {
  const trimmed = raw.trim();

  // Step 1: Greedy code fence — from first ``` to LAST ```
  const fenceStart = trimmed.indexOf("```");
  if (fenceStart !== -1) {
    const fenceEnd = trimmed.lastIndexOf("```");
    if (fenceEnd > fenceStart + 3) {
      let candidate = trimmed
        .slice(fenceStart + 3, fenceEnd)
        .replace(/^json\s*\n?/i, "")
        .trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Malformed inside fence — fall through to bracket matching
      }
    }
  }

  // Step 2: Try parsing the whole trimmed response as JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Truncated or malformed — fall through
    }
  }

  // Step 3: Greedy bracket matching — first { to last }
  const objectMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (objectMatch) {
    return objectMatch[1].trim();
  }
  const arrayMatch = trimmed.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    return arrayMatch[1].trim();
  }

  return trimmed;
}
