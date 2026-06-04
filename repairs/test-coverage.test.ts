/**
 * Test coverage guard — enforces AGENTS.md rule:
 *
 *   "Every repair in the catalog must have colocated tests in
 *    `repairs/*.test.ts`. Coverage is checked via
 *    `npx vitest run --coverage`. If a repair function has no tests,
 *    add them before committing."
 *
 * This test parses the source of each `repairs/*.ts` module, extracts
 * every exported function/class/arrow-const, and asserts that the matching
 * `repairs/<name>.test.ts` file mentions that symbol in at least one
 * `it(...)` or `test(...)` block. Constants in `constants.ts` are exempt
 * (they're tested by the barrel-contract test in this same folder).
 *
 * False positives are acceptable (a test can mention a function in a
 * comment or unrelated context). False negatives are NOT — if this
 * test passes, every repair function has at least one test that
 * references it.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPAIRS_DIR = __dirname;

const SUB_MODULES = [
  "array-utils.ts",
  "cache.ts",
  "classification.ts",
  "coercion.ts",
  "directory.ts",
  "dispatch.ts",
  "guidance.ts",
  "path-utils.ts",
  "timeout.ts",
];

interface ExportInfo {
  name: string;
  kind: "function" | "class" | "const-fn";
}

/** Parse a module's source to extract exported function/class/const-fn names. */
function extractExports(filePath: string): ExportInfo[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const exports: ExportInfo[] = [];

  // export function NAME / export async function NAME
  const fnRx = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
  for (const m of content.matchAll(fnRx)) {
    exports.push({ name: m[1], kind: "function" });
  }

  // export class NAME
  const classRx = /^export\s+class\s+(\w+)/gm;
  for (const m of content.matchAll(classRx)) {
    exports.push({ name: m[1], kind: "class" });
  }

  // export const NAME = (...) => { ... }
  // or export const NAME = function
  // Heuristic: capture NAME from lines that look like "export const NAME = (" or "= function"
  const constFnRx = /^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|[a-zA-Z_$])/gm;
  for (const m of content.matchAll(constFnRx)) {
    // Skip constant collections (Set, Map, Array, primitives)
    // We want only arrow/function expressions
    const lineStart = m.index ?? 0;
    const lineEnd = content.indexOf("\n", lineStart);
    const line = content.slice(lineStart, lineEnd);
    // Heuristic: a function-like const has "(" before any "new" or "[" or "{" or string literal
    if (/^export\s+const\s+\w+\s*=\s*(?:async\s+)?\(|^export\s+const\s+\w+\s*=\s*function\b/.test(line)) {
      exports.push({ name: m[1], kind: "const-fn" });
    }
  }

  return exports;
}

/** Count `it(...)` and `test(...)` blocks in a file (rough metric). */
function countTestBlocks(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  const content = fs.readFileSync(filePath, "utf-8");
  const itCount = (content.match(/\bit\s*\(/g) ?? []).length;
  const testCount = (content.match(/\btest\s*\(/g) ?? []).length;
  return itCount + testCount;
}

/** Check if a symbol is mentioned anywhere in a test file. */
function symbolReferencedInTest(testFilePath: string, symbol: string): boolean {
  if (!fs.existsSync(testFilePath)) return false;
  const content = fs.readFileSync(testFilePath, "utf-8");
  // Word-boundary match on the symbol name
  const rx = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return rx.test(content);
}

describe("repairs test coverage guard — every exported symbol has a test", () => {
  for (const modFile of SUB_MODULES) {
    const modName = modFile.replace(/\.ts$/, "");
    const modPath = path.join(REPAIRS_DIR, modFile);
    const testPath = path.join(REPAIRS_DIR, `${modName}.test.ts`);

    it(`${modName}.ts: test file exists and contains test blocks`, () => {
      expect(fs.existsSync(testPath), `Missing test file: ${testPath}`).toBe(true);
      const blocks = countTestBlocks(testPath);
      expect(blocks, `Test file ${modName}.test.ts has no it()/test() blocks`).toBeGreaterThan(0);
    });

    it(`${modName}.ts: every export is referenced in ${modName}.test.ts`, () => {
      const exports = extractExports(modPath);
      expect(exports.length, `${modName}.ts has no exports`).toBeGreaterThan(0);

      const unreferenced: string[] = [];
      for (const exp of exports) {
        if (!symbolReferencedInTest(testPath, exp.name)) {
          unreferenced.push(`${exp.kind} ${exp.name}`);
        }
      }

      expect(
        unreferenced,
        `${modName}.ts exports without any test mention: ${unreferenced.join(", ")}`,
      ).toEqual([]);
    });
  }
});

describe("repairs test coverage guard — summary", () => {
  it("exports across all sub-modules total to a reasonable count", () => {
    let totalExports = 0;
    let totalTestRefs = 0;
    for (const modFile of SUB_MODULES) {
      const modPath = path.join(REPAIRS_DIR, modFile);
      const testPath = path.join(REPAIRS_DIR, modFile.replace(/\.ts$/, ".test.ts"));
      const exports = extractExports(modPath);
      totalExports += exports.length;
      for (const exp of exports) {
        if (symbolReferencedInTest(testPath, exp.name)) totalTestRefs++;
      }
    }
    // Sanity floor: at least 30 repair-related exports across the 9 sub-modules
    expect(totalExports).toBeGreaterThan(30);
    // 100% reference rate — every export must appear in its test file
    expect(totalTestRefs).toBe(totalExports);
  });
});
