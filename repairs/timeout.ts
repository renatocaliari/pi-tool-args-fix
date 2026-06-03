/**
 * Timeout-related repair functions.
 *
 * Handles detection of long-running bash commands and automatic
 * timeout suggestion/injection.
 */

import { LONG_RUNNING_TOKENS } from "./constants.js";

/**
 * Check if a bash command looks like a long-running operation
 * that might need a larger timeout.
 */
export function isLongRunningCommand(command: string): boolean {
  return LONG_RUNNING_TOKENS.some((re) => re.test(command));
}

/**
 * Suggest an appropriate timeout_seconds for a bash command.
 * Returns undefined if no change suggested.
 *
 * Rules:
 * - If no timeout provided and command is long-running → suggest 300 (5 min)
 * - If timeout < 30 and command is long-running → suggest 120 (2 min)
 * - If command has pipes (known bug with timeout enforcement) → suggest 600 (10 min)
 * - Otherwise → keep as-is
 */
export function suggestAutoTimeout(
  command: string,
  currentTimeout?: number,
): number | undefined {
  const hasPipes = /\|\s*(tee|cat|grep|sort|uniq|wc|head|tail)/.test(command);
  const isLong = isLongRunningCommand(command);

  if (!isLong && !hasPipes) return undefined;

  // Pipe commands: known timeout enforcement bug in Claude Code and OpenCode
  if (hasPipes) {
    if (currentTimeout === undefined || currentTimeout < 600) {
      return 600;
    }
    return undefined;
  }

  // Long-running command with no timeout
  if (currentTimeout === undefined) {
    return isLong && /\b(test|build|lint|compile)\b/i.test(command) ? 300 : 120;
  }

  // Long-running command with too-short timeout
  if (isLong && currentTimeout < 30) {
    return 120;
  }

  return undefined;
}
