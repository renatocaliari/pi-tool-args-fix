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
 */
export function summarizeRepairs(
  original: Record<string, unknown>,
  repaired: Record<string, unknown>,
  prefix: string = "",
): string[] {
  const details: string[] = [];

  for (const [key, newValue] of Object.entries(repaired)) {
    const oldValue = original[key];
    const fullKey = prefix ? `${prefix}.${key}` : key;

    // Key was stripped (null removal)
    if (!(key in original)) {
      details.push(`${fullKey}: stripped null`);
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
        details.push(`${fullKey}: parsed JSON string → array`);
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
