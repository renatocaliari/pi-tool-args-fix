/**
 * Shared context type for handler modules.
 */

import type { RepairStats } from "../stats.js";
import { ConsecutiveFailureTracker, ConsecutiveEmptySearchTracker } from "../recorder.js";
import { RepairToggle } from "../stats.js";

export interface HandlerContext {
  stats: RepairStats;
  failureTracker: ConsecutiveFailureTracker;
  emptySearchTracker: ConsecutiveEmptySearchTracker;
  repairToggle: RepairToggle;
  eventSeq: { value: number };
  lastEditPerFile: Map<string, any>;
  injectedGuidance: Set<string>;
  setRepairStatus: (ctx: any) => void;
}


