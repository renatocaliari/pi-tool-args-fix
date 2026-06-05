/**
 * Shared UI helpers for handler modules.
 */

/** Helper: show progress widget above editor */
export function showProgress(ctx: any, lines: string[]): void {
  if (ctx.hasUI) {
    ctx.ui.setWidget("repair-progress", lines);
  }
}

/** Helper: clear progress widget */
export function clearProgress(ctx: any): void {
  if (ctx.hasUI) {
    ctx.ui.setWidget("repair-progress", undefined);
  }
}

/** Helper: show error notification */
export function showError(ctx: any, msg: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(msg, "error");
  } else {
    console.error("[repair-layer]", msg);
  }
}

/** Helper: show info notification */
export function showInfo(ctx: any, msg: string): void {
  if (ctx.hasUI) {
    ctx.ui.notify(msg, "info");
  } else {
    console.log(msg);
  }
}

/**
 * Summarize differences between original and repaired tool call arguments.
 * Returns an array of human-readable repair descriptions.
 *
 * Two passes:
 * 1. Keys in `original` but not in `repaired` → "stripped" (key was removed,
 *    typically because the value was null/null-like and the field is optional).
 *    This includes null-strip on non-content fields, null-like string removal,
 *    and stripped extra props.
 * 2. Keys in `repaired` → existing logic (added / changed / unchanged).
 */
export function summarizeRepairs(
  original: Record<string, unknown>,
  repaired: Record<string, unknown>,
  prefix: string = "",
): string[] {
  const details: string[] = [];

  // Pass 1: keys removed by repair
  for (const key of Object.keys(original)) {
    if (key in repaired) continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const oldValue = original[key];
    if (oldValue === null) {
      details.push(`${fullKey}: stripped null`);
    } else if (typeof oldValue === "string" && ["null", "none", "n/a", "nil"].includes(oldValue.trim().toLowerCase())) {
      details.push(`${fullKey}: stripped null-like string "${oldValue.slice(0, 30)}"`);
    } else {
      details.push(`${fullKey}: stripped`);
    }
  }

  // Pass 2: keys present in repaired
  for (const [key, newValue] of Object.entries(repaired)) {
    const oldValue = original[key];
    const fullKey = prefix ? `${prefix}.${key}` : key;

    // Key was added during repair (e.g., auto-injected timeout)
    if (!(key in original)) {
      details.push(`${fullKey}: added`);
      continue;
    }

    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      if (Array.isArray(oldValue) && Array.isArray(newValue)) {
        details.push(`${fullKey}: repaired array (${oldValue.length} → ${newValue.length} items)`);
      } else if (typeof oldValue === "object" && typeof newValue === "object" &&
        oldValue !== null && newValue !== null && !Array.isArray(oldValue) && !Array.isArray(newValue)) {
        const nested = summarizeRepairs(
          oldValue as Record<string, unknown>,
          newValue as Record<string, unknown>,
          fullKey,
        );
        details.push(...nested);
      } else if (typeof oldValue === "string" && Array.isArray(newValue)) {
        // Only label as "parsed JSON" when the source string actually looked like JSON.
        // Without this check, "single.txt" → ["single.txt"] would get the wrong label.
        // Convention: a string is JSON-like if it trims to start with `[` (or `{` or `"`)
        // and end with its matching close. KISS — bracket sniff, no real JSON.parse.
        const trimmed = oldValue.trim();
        const jsonLike =
          (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith('"') && trimmed.endsWith('"'));
        if (jsonLike) {
          details.push(`${fullKey}: parsed JSON string → array`);
        } else {
          details.push(`${fullKey}: wrapped bare → array`);
        }
      } else if (!Array.isArray(oldValue) && Array.isArray(newValue) && typeof oldValue !== "object") {
        details.push(`${fullKey}: wrapped bare → array`);
      } else if (typeof oldValue === "object" && oldValue !== null && Array.isArray(newValue)) {
        details.push(`${fullKey}: wrapped object → array`);
      } else if (typeof oldValue === "boolean" || typeof newValue === "boolean") {
        const oldPreview = String(oldValue);
        const newPreview = String(newValue);
        details.push(`${fullKey}: coerced boolean "${oldPreview}" → ${newPreview}`);
      } else if (typeof oldValue === "number" || typeof newValue === "number") {
        const oldPreview = String(oldValue);
        const newPreview = String(newValue);
        details.push(`${fullKey}: coerced number "${oldPreview}" → ${newPreview}`);
      } else if (typeof oldValue === "string" && typeof newValue === "string") {
        const oldPreview = oldValue.length > 40 ? oldValue.slice(0, 40) + "..." : oldValue;
        const newPreview = newValue.length > 40 ? newValue.slice(0, 40) + "..." : newValue;
        details.push(`${fullKey}: "${oldPreview}" → "${newPreview}"`);
      } else {
        details.push(`${fullKey}: repaired (${typeof oldValue} → ${typeof newValue})`);
      }
    }
  }

  return details;
}
