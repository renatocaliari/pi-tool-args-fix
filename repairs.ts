/**
 * Repair functions for LLM tool call arguments.
 *
 * This module is a barrel re-export of all sub-modules.
 * The actual implementations live in repairs/*.ts for maintainability.
 *
 * For new code, prefer importing from the specific sub-module:
 *   import { cleanPathValue } from "./repairs/path-utils.js";
 */
export {
  PATH_FIELD_NAMES, ARRAY_FIELD_NAMES, BOOLEAN_FIELD_NAMES,
  CONTENT_FIELD_NAMES, NUMBER_FIELD_NAMES, FALSY_STRINGS,
  TRUTHY_STRINGS, LONG_RUNNING_TOKENS
} from "./repairs/constants.js";

export {
  unwrapMarkdownLink,
  cleanPathValue,
  resolvePath,
  isUrlOrFlag,
  extractPathsFromArgs,
} from "./repairs/path-utils.js";

export {
  ARRAY_ITEM_SCHEMAS,
  stripExtraPropertiesFromItems,
  tryParseJsonString,
  wrapAsArrayIfNeeded,
  wrapObjectAsArrayIfNeeded,
  applyRelationalDefaults,
} from "./repairs/array-utils.js";

export {
  classifyField,
  isContentField,
  isNumberField,
} from "./repairs/classification.js";

export {
  isNullLikeString,
  trySplitStringToArray,
  coerceToBoolean,
  coerceToNumber,
} from "./repairs/coercion.js";

export {
  isEisdirError,
  extractTextContent,
  formatDirectoryListing,
} from "./repairs/directory.js";

export {
  isLongRunningCommand,
  suggestAutoTimeout,
} from "./repairs/timeout.js";

export {
  buildPathValidationGuidance,
  buildStalenessGuidance,
  buildCircuitBreakMessage,
  buildEditLoopGuidance,
  ordinalSuffix,
  buildSequentialEditGuidance,
  buildEditMismatchContext,
  buildEnhancedEditMismatchGuidance,
  extractFailedEditIndex,
  extractFailedEditPath,
  extractNonUniqueEditCount,
  findAllOldTextMatchLines,
  buildEditNonUniqueGuidance,
  buildEmptySearchGuidance,
  buildEditWrongFileGuidance,
} from "./repairs/guidance.js";

export {
  ContentHashCache,
  simpleHash,
} from "./repairs/cache.js";

export {
  REPAIRABLE_TOOLS,
  repairFieldValue,
  repairObjectFields,
  repairObjectFieldsWithTrace,
} from "./repairs/dispatch.js";


