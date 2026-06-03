/**
 * Types for the repair suggestion engine.
 */

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
