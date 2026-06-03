/**
 * Directory fallback and content extraction helpers.
 *
 * Handles EISDIR detection, text content extraction from tool result arrays,
 * and formatting directory listings for the fallback mechanism.
 */

import * as path from "node:path";

const EISDIR_PATTERNS = [
  "eisdir",
  "illegal operation on a directory",
  "is a directory",
];

/**
 * Check if an error message is an EISDIR error from reading a directory.
 * Covers both raw Node.js error and safe/fallback messages.
 */
export function isEisdirError(text: string): boolean {
  const lower = text.toLowerCase();
  return EISDIR_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Extract text content from a tool result content array.
 */
export function extractTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text") {
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  return null;
}

/**
 * Format a directory listing result for the EISDIR fallback.
 * Pure function — no I/O, no ExtensionAPI dependency.
 *
 * @param resolvedPath - Absolute path to the directory
 * @param entries - Directory entry names
 * @param toolName - Tool name ("read" or "read_file") for contextual message
 * @returns Formatted listing content, detail string for logs, and directory name
 */
export function formatDirectoryListing(
  resolvedPath: string,
  entries: string[],
  toolName: string,
): { listingContent: string; detail: string; dirName: string } {
  const listing = entries.map((e) => `  ${e}`).join("\n");
  const dirName = path.basename(resolvedPath);

  const listingContent = [
    `📁 Directory: ${resolvedPath}`,
    "",
    "Contents:",
    listing,
    "",
    `${entries.length} entr${entries.length === 1 ? "y" : "ies"} total.`,
    "",
    `ℹ️ The model called ${toolName} on a directory. Use bash ls or ${toolName} with a specific file path inside this directory.`,
  ].join("\n");

  const detail = `${dirName}: directory fallback (${entries.length} entr${entries.length === 1 ? "y" : "ies"} listed)`;

  return { listingContent, detail, dirName };
}
