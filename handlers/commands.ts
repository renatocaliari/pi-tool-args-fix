/**
 * Command handlers for the repair layer extension.
 *
 * All /repair-* commands registered here.
 */

import { formatStats, formatCacheInfo, RepairToggle } from "../stats.js";
import {
  readAllEvents,
  aggregateStats,
  computeBlindspots,
  formatGlobalStats,
  formatBlindspots,
} from "../recorder.js";
import { generateSuggestions, formatSuggestions, composeIssueContent, buildIssueUrl } from "../suggest-repairs.js";
import type { LLMConfig, PhaseCallback } from "../suggest-repairs.js";
import type { RepairStats } from "../stats.js";
import { exec } from "node:child_process";
import { showProgress, clearProgress, showError, showInfo } from "./utils.js";
import type { HandlerContext } from "./context.js";

/**
 * Register all commands with the pi extension API.
 */
export function registerCommands(
  pi: any, // ExtensionAPI
  ctx: HandlerContext,
): void {
  const { stats, repairToggle } = ctx;

  // ─── Command: repair on/off toggle ────────────────────────────
  pi.registerCommand("repair-on", {
    description: "Enable the repair layer (auto-fixes LLM tool arg mistakes)",
    handler: async (_args: any, uiCtx: any) => {
      if (repairToggle.isEnabled()) {
        showInfo(uiCtx, "🔧 repair: already on");
        return;
      }
      repairToggle.on();
      ctx.setRepairStatus(uiCtx);
      showInfo(uiCtx, repairToggle.getNotifyMessage());
    },
  });

  pi.registerCommand("repair-off", {
    description: "Disable the repair layer (passes raw tool args through)",
    handler: async (_args: any, uiCtx: any) => {
      if (!repairToggle.isEnabled()) {
        showInfo(uiCtx, "🔧 repair: already off");
        return;
      }
      repairToggle.off();
      ctx.setRepairStatus(uiCtx);
      showInfo(uiCtx, repairToggle.getNotifyMessage());
    },
  });

  pi.registerCommand("repair-toggle", {
    description: "Toggle repair layer on/off",
    handler: async (_args: any, uiCtx: any) => {
      repairToggle.toggle();
      ctx.setRepairStatus(uiCtx);
      showInfo(uiCtx, repairToggle.getNotifyMessage());
    },
  });

  // ─── Command: in-memory session repair stats ─────────────────────
  pi.registerCommand("repair-stats-session", {
    description: "Show repair layer statistics for this session (in-memory)",
    handler: async (_args: any, uiCtx: any) => {
      const output = formatStats(stats);

      if (uiCtx.hasUI) {
        uiCtx.ui.notify(
          `📊 Repair Stats (this session)\n\n${output}\n\n💡 Tip: run /repair-stats-global for all-session aggregate.`,
          "info",
        );
      } else {
        console.log("📊 Repair Stats (this session)");
        console.log(output);
        console.log("💡 Tip: run /repair-stats-global for all-session aggregate.");
      }
    },
  });

  // ─── Command: cache impact info ─────────────────────────────────
  pi.registerCommand("repair-cache-info", {
    description: "Show cache impact metrics for this session",
    handler: async (_args: any, uiCtx: any) => {
      const output = formatCacheInfo(stats);
      if (uiCtx.hasUI) {
        uiCtx.ui.notify(output, "info");
      } else {
        console.log(output);
      }
    },
  });

  // ─── Command: global aggregate across all sessions ────────────────
  pi.registerCommand("repair-stats-global", {
    description: "Show aggregated repair stats across all logged sessions",
    handler: async (_args: any, uiCtx: any) => {
      const allEvents = readAllEvents();
      const agg = aggregateStats(allEvents);

      const sessionIds = new Set(allEvents.map((e: any) => e.sessionId));
      const footer = `\nSession logs: ${sessionIds.size} (retention 50, auto-pruned at startup)`;
      const output = formatGlobalStats(agg, sessionIds.size) + footer;

      if (uiCtx.hasUI) {
        uiCtx.ui.notify(
          `${output}\n\n💡 Tip: run /repair-suggest to send patterns upstream and evolve the extension.`,
          "info",
        );
      } else {
        console.log(output);
        console.log("💡 Tip: run /repair-suggest to send patterns upstream and evolve the extension.");
      }
    },
  });

  // ─── Command: blindspots (errors without repair coverage) ────────
  pi.registerCommand("repair-gaps", {
    description: "Show error patterns that lack repair coverage (blindspots)",
    handler: async (_args: any, uiCtx: any) => {
      const allEvents = readAllEvents();
      const blindspots = computeBlindspots(allEvents);
      const output = formatBlindspots(blindspots);

      if (uiCtx.hasUI) {
        uiCtx.ui.notify(output, "info");
      } else {
        console.log(output);
      }
    },
  });

  // ─── Command: suggest new repairs via LLM analysis ───────────────
  const getRepairOverview = (): string => {
    try {
      const allEvents = readAllEvents();
      const blindspots = computeBlindspots(allEvents);
      const s = aggregateStats(allEvents);
      return `${allEvents.length} events, ${blindspots.length} blindspots, ${s.totalErrors} errors`;
    } catch {
      return "failed to read repair logs";
    }
  };

  pi.registerCommand("repair-suggest", {
    description: "Analyze blindspots + event logs, suggest new repairs, and optionally generate implementation",
    handler: async (_args: any, uiCtx: any) => {
      const model = uiCtx.model;
      if (!model) {
        showError(uiCtx, "❌ No active model found. Start a session first.");
        return;
      }

      console.error("[repair-layer] /repair-suggest: pre-gathering data...");
      const overview = getRepairOverview();

      if (uiCtx.hasUI) {
        const ok = await uiCtx.ui.confirm(
          "Analyze repair gaps?",
          `Using ${model.provider}/${model.id}\n${overview}\n\nThis will consume LLM tokens. Continue?`,
        );
        if (!ok) {
          showInfo(uiCtx, "Cancelled.");
          return;
        }
      }

      console.error("[repair-layer] /repair-suggest: analyzing with", model.id);

      showProgress(uiCtx, [
        "🔧 Repair Suggest - Analyzing",
        "─────────────────────────",
        "  📊 Gathering repair data...",
      ]);

      let spinnerTimer: ReturnType<typeof setInterval> | null = null;
      let issueSpinnerTimer: ReturnType<typeof setInterval> | null = null;

      function stopSpinner() {
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          spinnerTimer = null;
        }
      }

      try {
        const auth = await uiCtx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok) {
          throw new Error(`API key resolution failed: ${auth.error}`);
        }

        const llmConfig: LLMConfig = {
          baseUrl: model.baseUrl,
          apiKey: auth.apiKey ?? "",
          modelId: model.id,
        };

        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let spinnerIndex = 0;

        function startSpinner(message: string) {
          stopSpinner();
          spinnerTimer = setInterval(() => {
            spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
            showProgress(uiCtx, [
              "🔧 Repair Suggest - Analyzing",
              "─────────────────────────",
              ` ${spinnerFrames[spinnerIndex]} ${message}`,
            ]);
          }, 300);
        }

        const onPhase: PhaseCallback = (phase, message) => {
          if (uiCtx.hasUI) {
            uiCtx.ui.setStatus("repair-suggest", message);
          }
          console.error(`[repair-layer] /repair-suggest: ${message}`);
          showProgress(uiCtx, [
            "🔧 Repair Suggest - Analyzing",
            "─────────────────────────",
            `  ${message}`,
          ]);

          if (phase === "calling-llm") {
            startSpinner(message);
          } else if (phase === "parsing" || phase === "formatting") {
            stopSpinner();
          }
        };

        const result = await generateSuggestions(llmConfig, undefined, undefined, onPhase);
        stopSpinner();
        const output = formatSuggestions(result);

        showProgress(uiCtx, [
          "✅ Repair Suggest — Analysis Complete",
          "─────────────────────────",
          `Found ${result.suggestions.length} suggestion(s)`,
          `Events: ${result.analysisSummary.totalEvents} | Blindspots: ${result.analysisSummary.totalBlindspots}`,
        ]);

        showInfo(uiCtx, output);

        if (uiCtx.hasUI) {
          uiCtx.ui.setStatus("repair-suggest", "✅ Analysis complete");
        }

        const implementNow = result.recommendation.recommendedActions.filter((a: any) => a.action === "implement");
        if (implementNow.length > 0 && uiCtx.hasUI) {
          const wantIssue = await uiCtx.ui.confirm(
            "Open GitHub Issue?",
            `Would you like to open a pre-filled GitHub Issue with the repair suggestion?\n` +
            `You just helped the repair-layer evolve automatically.\n\n` +
            `Recommended to implement ${implementNow.length} suggestion(s).\n` +
            `The LLM will compose a title + body with code hints — you review and submit.\n\n` +
            `Proceed?`,
          );

          if (wantIssue) {
            showProgress(uiCtx, [
              "✍️ Repair Suggest — Composing Issue",
              "─────────────────────────",
              "  ✍️ Composing GitHub Issue...",
            ]);
            uiCtx.ui.setStatus("repair-suggest", "✍️ Composing GitHub Issue...");

            issueSpinnerTimer = setInterval(() => {
              const dots = ["", ".", "..", "..."];
              const dot = dots[Math.floor(Date.now() / 500) % 4];
              showProgress(uiCtx, [
                "✍️ Repair Suggest — Composing Issue",
                "─────────────────────────",
                `  ✍️ Composing GitHub Issue${dot}`,
              ]);
            }, 150);

            const issue = await composeIssueContent(
              llmConfig,
              result.suggestions,
              result.recommendation,
              result.analysisSummary,
              undefined,
            );

            clearInterval(issueSpinnerTimer!);
            issueSpinnerTimer = null;

            const owner = "renatocaliari";
            const repo = "pi-tool-repair-layer";
            const issueUrl = buildIssueUrl(owner, repo, issue);

            showProgress(uiCtx, [
              "🌐 Repair Suggest — Opening Browser",
              "─────────────────────────",
              "Opening GitHub issue in browser...",
            ]);

            exec(`open "${issueUrl.replace(/"/g, '\\"')}"`, { timeout: 5000 }, (_err: any) => {
              showProgress(uiCtx, [
                "✅ Repair Suggest — Complete!",
                "─────────────────────────",
                "Issue opened in browser.",
                "Review and click 'Submit new issue'.",
              ]);
              setTimeout(() => clearProgress(uiCtx), 5000);
            });

            showInfo(uiCtx,
              "✅ Issue pre-filled in your browser. Review and click 'Submit new issue'.\n\n" +
              "You just helped the repair-layer evolve. Every issue makes it smarter for everyone."
            );
          } else {
            showInfo(uiCtx, "Issue submission skipped. You can run /repair-suggest again anytime.");
          }
        } else if (implementNow.length === 0 && result.suggestions.length > 0) {
          showInfo(uiCtx, "No suggestions recommended for immediate implementation.");
        }
      } catch (err) {
        const errMsg = `Analysis failed: ${err}`;
        showError(uiCtx, errMsg);
      } finally {
        if (spinnerTimer) {
          clearInterval(spinnerTimer);
          spinnerTimer = null;
        }
        if (issueSpinnerTimer) {
          clearInterval(issueSpinnerTimer);
          issueSpinnerTimer = null;
        }
        clearProgress(uiCtx);
        if (uiCtx.hasUI) {
          uiCtx.ui.setStatus("repair-suggest", undefined);
        }
      }
    },
  });
}
