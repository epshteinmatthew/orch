import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveGoal } from "./goal.js";
import {
  createOrchestrator,
  type HistoryEntry,
  type PlanDecision,
} from "./orchestrators/index.js";
import { createWorker } from "./workers/index.js";

export type ApprovalResponse =
  | { action: "approve"; workerPrompt?: string }
  | { action: "reject"; feedback?: string };

export type RunEvent =
  | {
      type: "status";
      status: "starting" | "running" | "awaiting_approval" | "done" | "failed" | "cancelled";
      message?: string;
    }
  | { type: "orchestrator"; iteration: number; decision: PlanDecision }
  | { type: "approval"; iteration: number; decision: PlanDecision }
  | {
      type: "approval_resolved";
      iteration: number;
      outcome: "approved" | "edited" | "rejected";
      workerPrompt?: string;
      feedback?: string;
    }
  | { type: "worker"; iteration: number; summary: string; diffSummary?: string }
  | { type: "progress"; iteration: number; message: string; source?: string }
  | { type: "answer"; text: string }
  | { type: "error"; message: string }
  | { type: "log"; message: string };

export interface RunOptions {
  runId: string;
  workDir: string;
  goal?: string;
  orchestratorId?: string;
  maxIterations?: number;
  orchestratorApiKey?: string;
  orchestratorModel?: string;
  opencodeApiKey?: string;
  opencodeModel?: string;
  qcRules?: string;
  signal: AbortSignal;
  emit: (event: RunEvent) => void;
  /** Checked before each decision so step-by-step mode can be toggled mid-run. */
  stepMode?: () => boolean;
  /** Resolves with the user's response; rejects if the run is cancelled while waiting. */
  requestApproval?: (iteration: number, decision: PlanDecision) => Promise<ApprovalResponse>;
}

export async function runLoop(opts: RunOptions): Promise<void> {
  const workDir = resolve(opts.workDir);
  const maxIterations =
    opts.maxIterations ??
    (Number(process.env.ORCH_MAX_ITERS) || 15);
  const orchestratorId =
    opts.orchestratorId || process.env.ORCH_ORCHESTRATOR || "cursor";

  opts.emit({ type: "status", status: "starting", message: `Work dir: ${workDir}` });

  try {
    await access(workDir);
  } catch {
    opts.emit({ type: "error", message: `Work directory does not exist: ${workDir}` });
    opts.emit({ type: "status", status: "failed" });
    return;
  }

  let goal: string;
  try {
    goal = await resolveGoal(workDir, opts.goal);
  } catch (err) {
    opts.emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    opts.emit({ type: "status", status: "failed" });
    return;
  }

  opts.emit({ type: "log", message: `Goal resolved (${goal.length} chars)` });
  opts.emit({
    type: "log",
    message: `Orchestrator: ${orchestratorId}${opts.orchestratorModel ? ` (${opts.orchestratorModel})` : ""}; max iters: ${maxIterations}`,
  });

  const qcRules = opts.qcRules?.trim() || undefined;
  if (qcRules) {
    const count = qcRules.split("\n").filter((l) => l.trim()).length;
    opts.emit({ type: "log", message: `QC rules active (${count} line${count === 1 ? "" : "s"})` });
  }

  let orchestrator;
  try {
    orchestrator = createOrchestrator({
      id: orchestratorId,
      workDir,
      apiKey: opts.orchestratorApiKey,
      model: opts.orchestratorModel,
    });
  } catch (err) {
    opts.emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    opts.emit({ type: "status", status: "failed" });
    return;
  }

  let worker;
  try {
    const model = opts.opencodeModel || process.env.ORCH_OPENCODE_MODEL;
    opts.emit({
      type: "log",
      message: `Starting OpenCode worker (model: ${model || "OpenCode default"})…`,
    });
    worker = await createWorker({
      id: "opencode",
      workDir,
      model,
      apiKey: opts.opencodeApiKey,
    });
    opts.emit({ type: "log", message: "OpenCode worker ready" });
  } catch (err) {
    await orchestrator.dispose?.();
    opts.emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    opts.emit({ type: "status", status: "failed" });
    return;
  }

  opts.emit({ type: "status", status: "running" });

  const history: HistoryEntry[] = [];

  let lastWorkerSummary: string | undefined;
  let lastDiffSummary: string | undefined;
  // Stays undefined if the loop runs out of iterations.
  let finalStatus: "done" | "failed" | "cancelled" | undefined;

  try {
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (opts.signal.aborted) {
        finalStatus = "cancelled";
        break;
      }

      opts.emit({ type: "log", message: `Iteration ${iteration}: orchestrator planning…` });

      let decision: PlanDecision;
      try {
        decision = await orchestrator.plan({
          goal,
          workDir,
          iteration,
          maxIterations,
          lastWorkerSummary,
          lastDiffSummary,
          history,
          qcRules,
        }, opts.signal);
      } catch (err) {
        if (opts.signal.aborted) {
          finalStatus = "cancelled";
          break;
        }
        opts.emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        finalStatus = "failed";
        break;
      }

      opts.emit({ type: "orchestrator", iteration, decision });
      const entry: HistoryEntry = { iteration, decision };
      history.push(entry);
      let promptToSend = decision.workerPrompt;

      if (qcRules && decision.action === "done" && decision.qc && !decision.qc.passed) {
        entry.harnessNote =
          'You said "done" but your own QC verdict lists violations. Have the worker fix every violation first.';
        opts.emit({
          type: "log",
          message: `Iteration ${iteration}: orchestrator said done but QC failed; asking it to fix the violations first`,
        });
        continue;
      }

      if (opts.stepMode?.() && opts.requestApproval) {
        opts.emit({
          type: "status",
          status: "awaiting_approval",
          message: `Iteration ${iteration}: waiting for your approval`,
        });
        opts.emit({ type: "approval", iteration, decision });
        let response: ApprovalResponse;
        try {
          response = await opts.requestApproval(iteration, decision);
        } catch {
          finalStatus = "cancelled";
          break;
        }
        opts.emit({ type: "status", status: "running" });

        if (response.action === "reject") {
          entry.userFeedback = response.feedback?.trim() ?? "";
          opts.emit({
            type: "approval_resolved",
            iteration,
            outcome: "rejected",
            feedback: entry.userFeedback,
          });
          continue;
        }

        const edited = response.workerPrompt?.trim();
        if (decision.action === "prompt" && edited && edited !== decision.workerPrompt) {
          entry.editedPrompt = edited;
          promptToSend = edited;
          opts.emit({ type: "approval_resolved", iteration, outcome: "edited", workerPrompt: edited });
        } else {
          opts.emit({ type: "approval_resolved", iteration, outcome: "approved" });
        }
      }

      if (decision.action === "done") {
        finalStatus = "done";
        break;
      }
      if (decision.action === "fail") {
        finalStatus = "failed";
        break;
      }

      if (opts.signal.aborted) {
        finalStatus = "cancelled";
        break;
      }

      opts.emit({
        type: "log",
        message: `Iteration ${iteration}: sending prompt to OpenCode…`,
      });

      try {
        const result = await worker.run(promptToSend!, opts.signal, (message) =>
          opts.emit({ type: "progress", iteration, message }),
        );
        lastWorkerSummary = result.summary;
        lastDiffSummary = result.diffSummary;
        history[history.length - 1]!.workerSummary = result.summary;
        opts.emit({
          type: "worker",
          iteration,
          summary: result.summary,
          diffSummary: result.diffSummary,
        });
      } catch (err) {
        if (opts.signal.aborted) {
          finalStatus = "cancelled";
          break;
        }
        opts.emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        finalStatus = "failed";
        break;
      }
    }

    if (finalStatus === undefined) {
      finalStatus = "failed";
      opts.emit({
        type: "log",
        message: `Reached max iterations (${maxIterations}) without done/fail`,
      });
    }
  } finally {
    for (const [name, dispose] of [
      ["OpenCode worker", () => worker.dispose()],
      ["orchestrator", () => orchestrator.dispose?.()],
    ] as const) {
      try {
        await Promise.race([
          dispose(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timed out after 10s")), 10_000).unref(),
          ),
        ]);
      } catch (err) {
        opts.emit({
          type: "log",
          message: `Cleanup of ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  opts.emit({
    type: "status",
    status: finalStatus,
    message:
      finalStatus === "done"
        ? "Goal completed"
        : finalStatus === "cancelled"
          ? "Run cancelled"
          : "Run failed",
  });
}
