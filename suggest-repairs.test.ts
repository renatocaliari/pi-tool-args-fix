import { describe, it, expect } from "vitest";
import {
  gatherAnalysisData,
  extractJSON,
  parseSuggestions,
  formatSuggestions,
  parseIssueContent,
  buildIssueUrl,
  callLLM,
  type RepairSuggestion,
  type SuggestResult,
  type LLMConfig,
} from "./suggest-repairs.ts";

describe("gatherAnalysisData", () => {
  it("should return data from existing log files", () => {
    // Uses default .pi/repair-log/ which has real data
    const data = gatherAnalysisData();
    expect(data.blindspots).toBeDefined();
    expect(Array.isArray(data.blindspots)).toBe(true);
    expect(data.stats).toBeDefined();
    expect(typeof data.totalEvents).toBe("number");
    expect(data.eventSample.length).toBeLessThanOrEqual(30);
  });

  it("should handle empty log directory gracefully", () => {
    const data = gatherAnalysisData("/tmp/nonexistent-repair-log-xyz");
    expect(data.blindspots).toEqual([]);
    expect(data.totalEvents).toBe(0);
    expect(data.eventSample).toEqual([]);
  });
});

describe("extractJSON", () => {
  it("should extract JSON from code fences", () => {
    const input = 'Some text\n```json\n{"key": "value"}\n```\nmore text';
    expect(extractJSON(input)).toBe('{"key": "value"}');
  });

  it("should return raw JSON if no fences", () => {
    expect(extractJSON('{"a": 1}')).toBe('{"a": 1}');
  });

  it("should find JSON object in text", () => {
    expect(extractJSON("Here is the result: {\"suggestions\": []}")).toBe('{"suggestions": []}');
  });

  it("should handle nested code fences inside JSON body (greedy bracket matching)", () => {
    // The body contains ```python ... ``` which would break a lazy regex
    const input = '{"title":"Fix ENOENT","body":"```python\\nprint(\\"hi\\")\\n```"}';
    expect(extractJSON(input)).toBe(input);
  });

  it("should extract from ```json fences with nested ``` inside string values", () => {
    // LLM wrapped in ```json with a body that contains ``` language blocks
    const inner = '{"title":"Fix it","body":"```python\\ncode\\n```"}';
    const input = `\\n\`\`\`json\\n${inner}\\n\`\`\``;
    expect(extractJSON(input)).toBe(inner);
  });

  it("should handle truncated JSON gracefully (no parse error)", () => {
    const input = '{"title":"Fix ENOENT","body":"Partial content';
    expect(extractJSON(input)).toBe(input);
  });
});

describe("parseSuggestions", () => {
  it("should parse valid suggestions wrapper format", () => {
    const raw = JSON.stringify({
      suggestions: [
        {
          title: "Test repair",
          rationale: "Because reasons",
          effort: "small",
          addressesCategory: "ENOENT",
          affectedTools: ["read", "read_file"],
          implementationPlan: ["Add function", "Update tests"],
          expectedImpact: "Fewer ENOENT errors",
          risks: "Low risk",
          researchLinks: ["https://example.com"],
        },
      ],
    });
    const result = parseSuggestions(raw);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Test repair");
    expect(result[0].effort).toBe("small");
    expect(result[0].addressesCategory).toBe("ENOENT");
  });

  it("should handle empty suggestions array", () => {
    const result = parseSuggestions(JSON.stringify({ suggestions: [] }));
    expect(result).toEqual([]);
  });

  it("should handle malformed response gracefully", () => {
    const result = parseSuggestions("not even close to JSON");
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain("Error parsing");
  });

  it("should validate effort level", () => {
    const raw = JSON.stringify({
      suggestions: [
        { title: "A", effort: "invalid-level" },
        { title: "B", effort: "large" },
      ],
    });
    const result = parseSuggestions(raw);
    expect(result[0].effort).toBe("medium"); // fallback
    expect(result[1].effort).toBe("large");
  });

  it("should handle array-only format (no wrapper)", () => {
    const raw = JSON.stringify([
      {
        title: "Direct array",
        rationale: "test",
        effort: "trivial",
        addressesCategory: null,
        affectedTools: [],
        implementationPlan: [],
        expectedImpact: "",
        risks: "",
        researchLinks: [],
      },
    ]);
    const result = parseSuggestions(raw);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Direct array");
  });
});

describe("formatSuggestions", () => {
  const mockResult: SuggestResult = {
    generatedAt: "2026-05-29T16:00:00.000Z",
    analysisSummary: {
      totalEvents: 100,
      totalBlindspots: 3,
      totalRepairsApplied: 25,
      totalErrors: 10,
      topErrorTypes: [{ type: "ENOENT", count: 5 }, { type: "timeout", count: 3 }],
      topRepairTypes: [{ type: "parsed JSON", count: 12 }],
    },
    recommendation: {
      assessment: "Two suggestions worth implementing, one deferred.",
      recommendedActions: [
        { suggestionIndex: 1, action: "implement", reason: "High impact, low risk" },
      ],
    },
    suggestions: [
      {
        title: "Fuzzy path matching",
        rationale: "ENOENT errors occur 5x for read tool",
        effort: "medium",
        addressesCategory: "ENOENT",
        affectedTools: ["read", "read_file"],
        implementationPlan: [
          "Add fuzzyMatchPath function",
          "Retry with common parent dirs",
        ],
        expectedImpact: "Reduce ENOENT errors by ~60%",
        risks: "May match wrong file in rare cases",
        researchLinks: ["https://example.com/fuzzy"],
      },
    ],
    rawResponse: "",
  };

  it("should produce formatted output with all suggestion details", () => {
    const output = formatSuggestions(mockResult);
    expect(output).toContain("Repair Suggestions");
    expect(output).toContain("Fuzzy path matching");
    expect(output).toContain("ENOENT errors occur");
    expect(output).toContain("medium");
    expect(output).toContain("Add fuzzyMatchPath function");
    expect(output).toContain("Reduce ENOENT errors");
    expect(output).toContain("https://example.com/fuzzy");
    expect(output).toContain("100 events");
    expect(output).toContain("3 blindspots");
  });
});

describe("LLMConfig type", () => {
  it("should be constructible", () => {
    const config: LLMConfig = {
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      modelId: "test-model",
    };
    expect(config.baseUrl).toBe("https://api.example.com/v1");
    expect(config.apiKey).toBe("sk-test");
    expect(config.modelId).toBe("test-model");
  });
});

describe("parseIssueContent", () => {
  it("should parse valid issue content", () => {
    const raw = JSON.stringify({
      title: "Add fuzzy path matching for ENOENT errors",
      body: "## Description\nENOENT errors are common.\n\n## Proposed fix\nImplement fuzzy matching.",
    });
    const result = parseIssueContent(raw);
    expect(result.title).toBe("Add fuzzy path matching for ENOENT errors");
    expect(result.body).toContain("ENOENT errors");
    expect(result.body).toContain("fuzzy matching");
  });

  it("should handle malformed response gracefully", () => {
    const result = parseIssueContent("not valid json");
    expect(result.title).toContain("suggestion");
    expect(result.body).toContain("Could not parse");
  });

  it("should fall back to defaults for missing fields", () => {
    const result = parseIssueContent(JSON.stringify({}));
    expect(result.title).toBe("Repair suggestion");
  });
});

describe("buildIssueUrl", () => {
  it("should generate a valid GitHub issue URL", () => {
    const url = buildIssueUrl("calionauta", "pi-tool-repair-layer", {
      title: "Fix ENOENT errors",
      body: "Description here",
    });
    expect(url).toContain("github.com/calionauta/pi-tool-repair-layer/issues/new");
    expect(url).toContain("title=Fix+ENOENT+errors");
    expect(url).toContain("body=Description+here");
    expect(url).toContain("labels=suggestion");
  });

  it("should URL-encode special characters in title and body", () => {
    const url = buildIssueUrl("owner", "repo", {
      title: "Bug: fix & improve",
      body: "Check `code` here",
    });
    expect(url).toContain("%26"); // & encoded
  });
});

describe("callLLM timeout", () => {
  it("should use AbortController with signal", async () => {
    // Verify that callLLM passes signal to fetch
    let fetchOptions: any = {};
    const originalFetch = global.fetch;
    global.fetch = ((url: string, opts: any) => {
      fetchOptions = opts;
      // Return a successful response
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "test" } }] })));
    }) as any;
    
    try {
      await callLLM(
        { baseUrl: "https://api.test.com/v1", apiKey: "sk-test", modelId: "test" },
        "system",
        "user",
      );
      expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
