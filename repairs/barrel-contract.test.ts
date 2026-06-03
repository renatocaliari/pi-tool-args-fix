/**
 * Barrel contract tests — verify that every export from each sub-module
 * is properly re-exported from the repairs barrel (repairs.ts).
 *
 * This catches drift: someone adds/renames a function in a sub-module
 * but forgets to update the barrel, or accidentally reorganizes exports
 * across sub-modules.
 *
 * Pure runtime check — TypeScript alone doesn't prevent this because
 * the barrel file itself compiles fine if a source module still exports SOMETHING.
 */

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get all exported symbol names from a module's source code.
 */
function getLocalExports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const exports: string[] = [];

  // Match `export function foo(`, `export class Foo {`, `export const FOO`
  const patterns = [
    /^export\s+(?:function\s+|class\s+|const\s+|let\s+|var\s+)(\w+)/gm,
    /^export\s+type\s+(\w+)/gm,
    /^export\s+interface\s+(\w+)/gm,
    /^export\s+enum\s+(\w+)/gm,
  ];

  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      exports.push(m[1]);
    }
  }

  // Match export const/let with destructuring: export const { foo, bar }
  const destructureRx = /^export\s+(?:const|let|var)\s+\{([^}]+)\}/gm;
  while (true) {
    const m = destructureRx.exec(content);
    if (!m) break;
    for (const name of m[1].split(",")) {
      const trimmed = name.trim();
      if (trimmed) exports.push(trimmed);
    }
  }

  // Match export type { Foo, Bar } (type re-exports)
  // export type { Foo as Bar } — use original name
  const typeExportRx = /^export\s+type\s+\{([^}]+)\}/gm;
  while (true) {
    const m = typeExportRx.exec(content);
    if (!m) break;
    for (const name of m[1].split(",")) {
      const parts = name.trim().split(/\s+as\s+/);
      const original = parts[0].trim();
      if (original) exports.push(original);
    }
  }

  return [...new Set(exports)].sort();
}

/**
 * Get the set of re-exported symbol names from the barrel for a given sub-module.
 *
 * Handles multiple barrel export styles:
 *   export { Foo } from "./repairs/path-utils.js";
 *   export { type IFoo } from "./suggest-repairs/types.js";
 *   export async function bar() { ... }
 */
function getBarrelReexportsFor(barrelPath: string, subModuleName: string): string[] {
  const content = fs.readFileSync(barrelPath, "utf-8");
  const exports: string[] = [];

  // Match `export { Foo, bar } from "...subModule...";`
  // and `export type { Foo, bar } from "...subModule...";`
  const blockExportRx = new RegExp(
    `export\\s+(?:type\\s+)?\\{([^}]+)\\}\\s*from\\s*["'][^"']*${subModuleName.replace(/\.ts$/, "")}[^"']*["']`,
    "g"
  );
  let m: RegExpExecArray | null;
  while ((m = blockExportRx.exec(content)) !== null) {
    for (const name of m[1].split(",")) {
      const parts = name.trim().split(/\s+as\s+/);
      const original = parts[0].trim().replace(/^type\s+/, "");
      if (original) exports.push(original);
    }
  }

  // Match inline `export async function generateSuggestions` inside the barrel file
  // Also catch `export const FOO = ...` or `export class Bar` defined directly in barrel
  const inlineFnRx = /^export\s+(?:async\s+)?function\s+\*?\s*(\w+)/gm;
  while ((m = inlineFnRx.exec(content)) !== null) {
    exports.push(m[1]);
  }

  return [...new Set(exports)].sort();
}

const REPAIRS_DIR = path.resolve(__dirname, "..", "repairs");
const BARREL_PATH = path.resolve(__dirname, "..", "repairs.ts");

const SUB_MODULES = [
  "path-utils.ts",
  "array-utils.ts",
  "classification.ts",
  "coercion.ts",
  "directory.ts",
  "timeout.ts",
  "guidance.ts",
  "cache.ts",
  "dispatch.ts",
];

describe("repairs barrel contract — sub-module exports", () => {
  for (const modFile of SUB_MODULES) {
    const modName = modFile.replace(/\.ts$/, "");
    const modPath = path.join(REPAIRS_DIR, modFile);

    it(`${modName}: every local export is re-exported from repairs.ts barrel`, () => {
      const localExports = getLocalExports(modPath);
      const barrelExports = getBarrelReexportsFor(BARREL_PATH, modName);

      const missing = localExports.filter(
        (name) => !barrelExports.includes(name) && !name.startsWith("_")
      );

      expect(missing).toEqual([]);
    });
  }
});

describe("repairs barrel — constants re-export parity", () => {
  it("exports all 8 constant sets", async () => {
    const barrel = await import("../repairs.js");
    expect(barrel.PATH_FIELD_NAMES).toBeDefined();
    expect(barrel.ARRAY_FIELD_NAMES).toBeDefined();
    expect(barrel.BOOLEAN_FIELD_NAMES).toBeDefined();
    expect(barrel.CONTENT_FIELD_NAMES).toBeDefined();
    expect(barrel.NUMBER_FIELD_NAMES).toBeDefined();
    expect(barrel.FALSY_STRINGS).toBeDefined();
    expect(barrel.TRUTHY_STRINGS).toBeDefined();
    expect(barrel.LONG_RUNNING_TOKENS).toBeDefined();
  });

  it("each constant set has expected content via dynamic import", async () => {
    // Use ESM import instead of require() for ESM compatibility
    const barrel = await import("../repairs.js");
    expect(barrel.PATH_FIELD_NAMES.has("path")).toBe(true);
    expect(barrel.ARRAY_FIELD_NAMES.has("edits")).toBe(true);
    expect(barrel.CONTENT_FIELD_NAMES.has("command")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// suggest-repairs barrel contract
// ═════════════════════════════════════════════════════════════════════════

const SUGGEST_REPAIRS_DIR = path.resolve(__dirname, "..", "suggest-repairs");
const SUGGEST_BARREL_PATH = path.resolve(__dirname, "..", "suggest-repairs.ts");

const SUGGEST_SUB_MODULES = [
  "types.ts",
  "llm-client.ts",
  "analysis.ts",
  "parsing.ts",
  "formatting.ts",
  "code-gen.ts",
  "issue.ts",
];

describe("suggest-repairs barrel contract", () => {
  for (const modFile of SUGGEST_SUB_MODULES) {
    const modName = modFile.replace(/\.ts$/, "");
    const modPath = path.join(SUGGEST_REPAIRS_DIR, modFile);

    it(`${modName}: every local export is re-exported from suggest-repairs.ts barrel`, () => {
      const localExports = getLocalExports(modPath);
      const barrelExports = getBarrelReexportsFor(SUGGEST_BARREL_PATH, modName);

      const missing = localExports.filter(
        (name) => !barrelExports.includes(name) && !name.startsWith("_")
      );

      expect(missing).toEqual([]);
    });
  }
});

describe("suggest-repairs barrel — orchestrator function present", () => {
  it("exports generateSuggestions as the main orchestrator", async () => {
    const barrel = await import("../suggest-repairs.js");
    expect(barrel.generateSuggestions).toBeDefined();
    expect(typeof barrel.generateSuggestions).toBe("function");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Extension handler smoke test — validates wiring doesn't crash
// ═════════════════════════════════════════════════════════════════════════

describe("extension handler — basic wiring", () => {
  it("default export is a function (extension factory)", async () => {
    const mod = await import("../index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("importing index.ts does not throw at module level", async () => {
    // This already passed via the dynamic import above, but be explicit
    await expect(async () => {
      await import("../index.js");
    }).not.toThrow();
  });
});

describe("handler modules — clean imports", () => {
  it("handlers/commands.ts imports resolve and module loads", async () => {
    const mod = await import("../handlers/commands.js");
    expect(mod.registerCommands).toBeDefined();
    expect(typeof mod.registerCommands).toBe("function");
  });

  it("handlers/utils.ts imports resolve and module loads", async () => {
    const mod = await import("../handlers/utils.js");
    expect(mod.summarizeRepairs).toBeDefined();
    expect(typeof mod.summarizeRepairs).toBe("function");
  });

  it("handlers/context.ts type exports compile", () => {
    const content = fs.readFileSync(
      path.resolve(__dirname, "..", "handlers", "context.ts"),
      "utf-8"
    );
    expect(content).toContain("export interface HandlerContext");
  });
});
