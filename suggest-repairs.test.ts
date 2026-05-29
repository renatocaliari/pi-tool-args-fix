import { describe, it, expect } from "vitest";
import {
  gatherAnalysisData,
  extractJSON,
  parseSuggestions,
  formatSuggestions,
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
