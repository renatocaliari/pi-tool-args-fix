/**
 * Path utility repair functions.
 *
 * Handles markdown link unwrapping, path cleaning, path resolution,
 * and path extraction from tool arguments.
 */

import { PATH_FIELD_NAMES } from "./constants.js";

/**
 * Unwrap markdown auto-links from path values.
 *
 * Models trained on chat distributions sometimes emit paths as markdown links:
 *   `[notes.md](http://notes.md)` → `notes.md`
 *   `[file.ts](file://path/to/file.ts)` → `file.ts`
 *
 * Only unwraps the degenerate case where the link text equals the URL without
 * its protocol prefix. Real markdown like `[click here](https://x.com)` passes
 * through untouched.
 */
export function unwrapMarkdownLink(value: string): string {
  if (typeof value !== "string") return value;

  // Match [text](url) where text === url minus protocol
  const mdLink = /^\[([^\]]+)\]\(([^)]+)\)$/;
  const match = value.match(mdLink);
  if (!match) return value;

  const [, linkText, linkUrl] = match;

  // Unwrap only when link text equals URL without protocol
  const urlWithoutProtocol = linkUrl
    .replace(/^https?:\/\//, "")
    .replace(/^file:\/\//, "");
  if (linkText === urlWithoutProtocol) {
    return linkText;
  }

  // Also handle the simple case where link text IS the URL (no protocol in URL either)
  if (linkText === linkUrl) {
    return linkText;
  }

  return value;
}

/**
 * Clean a path value: unwrap markdown links, trim whitespace, normalize.
 */
export function cleanPathValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let cleaned = value.trim();
  cleaned = unwrapMarkdownLink(cleaned);
  // Resolve ~/ paths (common LLM mistake) using shared resolvePath
  if (cleaned.startsWith("~")) {
    cleaned = resolvePath(cleaned);
  }
  return cleaned;
}

/**
 * Resolve a user-provided path, handling tilde expansion.
 * Pure function — no I/O.
 */
export function resolvePath(filePath: string, homeDir?: string): string {
  if (filePath.startsWith("~")) {
    const home = homeDir || "/home/user";
    return home + filePath.slice(1);
  }
  return filePath;
}

/**
 * Checks if a raw string looks like a URL or flag (not a file path).
 * Pure function — no I/O.
 */
export function isUrlOrFlag(value: string): boolean {
  return value.startsWith("http") || value.startsWith("-");
}

/**
 * Extract file/directory path-like string values from tool arguments.
 *
 * Returns all string values from known path fields, plus string values
 * from command fields that look like file paths.
 */
export function extractPathsFromArgs(
  args: Record<string, unknown>,
): string[] {
  const paths: string[] = [];

  // Direct path fields
  for (const key of Object.keys(args)) {
    if (PATH_FIELD_NAMES.has(key) && typeof args[key] === "string") {
      paths.push(args[key] as string);
    }
  }

  // Array fields that may contain paths (files, targets, etc.)
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      if (typeof file === "string") paths.push(file);
      else if (typeof file === "object" && file !== null) {
        const f = file as Record<string, unknown>;
        if (typeof f.path === "string") paths.push(f.path);
      }
    }
  }

  // Bash commands — extract paths/globs (anything that looks like a file reference)
  if (typeof args.command === "string") {
    const cmd = args.command as string;
    // Match quoted file paths in commands
    const quotedPaths = cmd.match(/['\"]([^'\"]+\.\w+)['\"]/g);
    if (quotedPaths) {
      for (const qp of quotedPaths) {
        paths.push(qp.replace(/['\"]/g, ""));
      }
    }
  }

  return paths;
}
