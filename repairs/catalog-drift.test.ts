/**
 * Catalog drift guard — enforces `docs/repair-catalog.md` as the source
 * of truth.
 *
 * AGENTS.md:
 *   "REPAIR CATALOG: See `docs/repair-catalog.md` — source of truth for
 *    ALL 9 field-level repairs, 8 execution guidance functions, 3
 *    classification predicates, 8 constant sets, and the dispatch table.
 *    Every refactoring MUST preserve the catalog contracts. Do not delete
 *    or rename any function without updating the catalog and checking
 *    test coverage."
 *
 * This test parses the catalog markdown, extracts the documented
 * dispatchers and classification predicates, and asserts:
 *   1. Every catalog dispatcher exists in `repairs/dispatch.ts`.
 *   2. Every source-file dispatcher is mentioned in the catalog.
 *   3. Every classification predicate in the catalog exists in
 *      `repairs/classification.ts`.
 *   4. The action table has 9 rows (8 dispatchers + 1 inline).
 *   5. The dispatch table code block has 8 entries.
 *
 * If any of these fail, the catalog is stale relative to the code (or
 * vice versa). Update one or the other — never both silently.
 */

import { describe, it, expect } from "vitest";
import {
  DISPATCH_CAPABILITIES,
  HANDLER_CAPABILITIES,
  GUIDANCE_CAPABILITIES,
  DEFERRED_FEATURES,
} from "../suggest-repairs/analysis.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATALOG_PATH = path.resolve(__dirname, "..", "docs", "repair-catalog.md");
const DISPATCH_PATH = path.resolve(__dirname, "dispatch.ts");
const CLASSIFICATION_PATH = path.resolve(__dirname, "classification.ts");

// ─── Parsers ─────────────────────────────────────────────────────────────

/** Extract the markdown table for "Field-Level Repairs" — the 9-action
 *  catalog of repair actions and their dispatchers. */
function parseFieldRepairsTable(md: string): Array<{
  index: string;
  action: string;
  dispatcher: string | null;
}> {
  // Find the section
  const sectionMatch = md.match(/## 1\. Field-Level Repairs[\s\S]*?(?=\n## )/);
  if (!sectionMatch) return [];
  const section = sectionMatch[0];

  // Extract rows starting with "| <num> |". Some rows (e.g. row 7) have
  // `— (inline in ...)` instead of a backtick-wrapped action, so accept
  // any cell content for action+dispatcher and clean it up after.
  const rows: Array<{ index: string; action: string; dispatcher: string | null }> = [];
  const rowRx = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  for (const m of section.matchAll(rowRx)) {
    const index = m[1];
    const actionRaw = m[2].trim();
    const dispatcherRaw = m[3].trim();

    // Skip the header row ("| # | Action | Dispatcher | ...")
    if (index === "#") continue;
    // Skip separator row (|---|---|...)
    if (/^[-:|\s]+$/.test(actionRaw)) continue;

    // Action: backticks → unwrapped; em-dash → null
    const action = actionRaw.startsWith("`")
      ? actionRaw.replace(/`/g, "").trim()
      : actionRaw;
    const isInline = actionRaw.startsWith("—") || dispatcherRaw.startsWith("—") || dispatcherRaw === "";
    const dispatcher = isInline
      ? null
      : dispatcherRaw.replace(/`/g, "").trim();
    rows.push({ index, action, dispatcher });
  }
  return rows;
}

/** Extract dispatcher names from the catalog's "Dispatch Table" code block. */
function parseDispatchTableInCatalog(md: string): string[] {
  const sectionMatch = md.match(/## 1\. Field-Level Repairs[\s\S]*?(?=\n## )/);
  if (!sectionMatch) return [];
  const section = sectionMatch[0];

  // Find the dispatch table code block: contains "repairDispatchers"
  const codeBlockRx = /```typescript\n([\s\S]*?)\n```/g;
  let dispatchBlock = "";
  for (const m of section.matchAll(codeBlockRx)) {
    if (m[1].includes("repairDispatchers")) {
      dispatchBlock = m[1];
      break;
    }
  }
  if (!dispatchBlock) return [];

  // Extract dispatcher names: "dispatchFoo" keys
  const dispatchers: string[] = [];
  const keyRx = /^\s*"[\w-]+":\s*(\w+),?\s*$/gm;
  for (const m of dispatchBlock.matchAll(keyRx)) {
    dispatchers.push(m[1]);
  }
  return dispatchers;
}

/** Extract classification predicates from the catalog. */
function parseClassificationPredicatesInCatalog(md: string): string[] {
  // Table: | `isArrayLike` | `classifyField` | ... |
  const rx = /^\|\s*`(\w+)`\s*\|\s*`classifyField`/gm;
  const preds: string[] = [];
  for (const m of md.matchAll(rx)) {
    preds.push(m[1]);
  }
  return preds;
}

/** Extract dispatcher function names defined in `repairs/dispatch.ts` source. */
function extractSourceDispatchers(source: string): string[] {
  // Match: const dispatchFoo: ... = ... OR function dispatchFoo OR export const dispatchFoo = ...
  const names: string[] = [];
  const rx = /(?:^export\s+)?(?:const|function|async\s+function)\s+(dispatch\w+)/gm;
  for (const m of source.matchAll(rx)) {
    names.push(m[1]);
  }
  // Also catch entries in the dispatch table: "clean-path": dispatchCleanPath,
  const tableRx = /^\s*"\w[\w-]*":\s*(dispatch\w+)/gm;
  for (const m of source.matchAll(tableRx)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return [...new Set(names)].sort();
}

/** Extract classification predicate names defined in `repairs/classification.ts`.
 *  Includes non-exported functions — the catalog may document module-internal
 *  helpers (e.g. `isArrayLike` is referenced from `classifyField` but not
 *  re-exported). */
function extractSourcePredicates(source: string): string[] {
  const names: string[] = [];
  const rx = /^(?:export\s+)?function\s+(\w+)/gm;
  for (const m of source.matchAll(rx)) {
    names.push(m[1]);
  }
  return names;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("catalog drift guard — field-level repairs table", () => {
  it("catalog has exactly 9 action rows (8 dispatchers + 1 inline)", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const rows = parseFieldRepairsTable(md);
    expect(rows).toHaveLength(9);
    // Row 7 is the inline one
    const inlineRows = rows.filter((r) => r.dispatcher === null);
    expect(inlineRows).toHaveLength(1);
    expect(inlineRows[0].index).toBe("7");
  });

  it("every catalog dispatcher exists in repairs/dispatch.ts source", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const rows = parseFieldRepairsTable(md);
    const catalogDispatchers = rows
      .map((r) => r.dispatcher)
      .filter((d): d is string => d !== null);

    const source = fs.readFileSync(DISPATCH_PATH, "utf-8");
    const sourceDispatchers = extractSourceDispatchers(source);

    const missing = catalogDispatchers.filter(
      (d) => !sourceDispatchers.includes(d),
    );
    expect(
      missing,
      `Catalog mentions dispatchers not found in source: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every source dispatcher is mentioned in the catalog", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const rows = parseFieldRepairsTable(md);
    const catalogDispatchers = new Set(
      rows.map((r) => r.dispatcher).filter((d): d is string => d !== null),
    );

    const source = fs.readFileSync(DISPATCH_PATH, "utf-8");
    const sourceDispatchers = extractSourceDispatchers(source);

    const unlisted = sourceDispatchers.filter(
      (d) => !catalogDispatchers.has(d),
    );
    expect(
      unlisted,
      `Source defines dispatchers not in catalog: ${unlisted.join(", ")}`,
    ).toEqual([]);
  });
});

describe("catalog drift guard — dispatch table code block", () => {
  it("catalog dispatch table has exactly 8 entries", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const dispatchers = parseDispatchTableInCatalog(md);
    expect(dispatchers).toHaveLength(8);
  });

  it("catalog dispatch table entries match source dispatchers", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const tableEntries = parseDispatchTableInCatalog(md);

    const source = fs.readFileSync(DISPATCH_PATH, "utf-8");
    const sourceDispatchers = extractSourceDispatchers(source);

    // The catalog table should reference the same set of dispatchers
    // (though possibly a subset — only those wired in the dispatch table)
    for (const entry of tableEntries) {
      expect(sourceDispatchers).toContain(entry);
    }
  });
});

describe("catalog drift guard — capability constants (analysis.ts)", () => {
  it("DISPATCH_CAPABILITIES has 10 items (matching section 1 of catalog)", () => {
    expect(DISPATCH_CAPABILITIES).toHaveLength(10);
    expect(DISPATCH_CAPABILITIES[0]).toMatch(/^clean-path/);
    expect(DISPATCH_CAPABILITIES[DISPATCH_CAPABILITIES.length - 1]).toMatch(/^isNullLikeString/);
  });

  it("HANDLER_CAPABILITIES has 13 items (matching section 2 of catalog)", () => {
    expect(HANDLER_CAPABILITIES).toHaveLength(13);
    expect(HANDLER_CAPABILITIES[0]).toMatch(/^Auto-timeout injection/);
    expect(HANDLER_CAPABILITIES[HANDLER_CAPABILITIES.length - 1]).toMatch(/^Priority-based/);
  });

  it("GUIDANCE_CAPABILITIES has 6 items", () => {
    expect(GUIDANCE_CAPABILITIES).toHaveLength(6);
    expect(GUIDANCE_CAPABILITIES[0]).toMatch(/^getToolHelp/);
  });

  it("DEFERRED_FEATURES has 3 items", () => {
    expect(DEFERRED_FEATURES).toHaveLength(3);
    expect(DEFERRED_FEATURES[0]).toMatch(/^Auto-resolve ENOENT/);
  });
});

describe("catalog drift guard — classification predicates", () => {
  it("catalog lists 3 classification predicates", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const preds = parseClassificationPredicatesInCatalog(md);
    expect(preds).toHaveLength(3);
    expect(preds).toEqual(
      expect.arrayContaining(["isArrayLike", "isBooleanField", "looksLikeNumberField"]),
    );
  });

  it("every catalog classification predicate exists in source", () => {
    const md = fs.readFileSync(CATALOG_PATH, "utf-8");
    const preds = parseClassificationPredicatesInCatalog(md);

    const source = fs.readFileSync(CLASSIFICATION_PATH, "utf-8");
    const sourceFunctions = extractSourcePredicates(source);

    const missing = preds.filter((p) => !sourceFunctions.includes(p));
    expect(
      missing,
      `Catalog references predicates not in source: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
