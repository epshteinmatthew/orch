import {
  Agent,
  Cursor,
  CursorAgentError,
  getDefaultSdkStateRoot,
  JsonlLocalAgentStore,
  type ToolName,
} from "@cursor/sdk";
import { join } from "node:path";
import { buildPlanPrompt, extractJson } from "./prompt.js";
import type { ModelOption, Orchestrator, PlanDecision, PlanInput } from "./types.js";

/**
 * Cursor may only look at the work folder; OpenCode is the only thing allowed to change it.
 * An allowlist (not a denylist) so tools added to the platform later can't write either.
 * Excludes "shell" (can write files) and "task" (subagents get their own toolsets).
 */
export const CURSOR_READ_ONLY_TOOLS: ToolName[] = ["read", "grep", "glob", "ls", "semSearch", "readLints"];

export async function listCursorModels(apiKey: string): Promise<ModelOption[]> {
  const models = await Cursor.models.list({ apiKey });
  return models.map((m) => ({ id: m.id, name: m.displayName || m.id }));
}

export class CursorOrchestrator implements Orchestrator {
  readonly id = "cursor";
  private agent: Awaited<ReturnType<typeof Agent.create>> | null = null;

  constructor(
    private readonly opts: {
      apiKey: string;
      workDir: string;
      model: string;
    },
  ) {}

  private async getAgent() {
    if (this.agent) return this.agent;
    this.agent = await Agent.create({
      apiKey: this.opts.apiKey,
      model: { id: this.opts.model },
      tools: CURSOR_READ_ONLY_TOOLS,
      local: {
        cwd: this.opts.workDir,
        // JSONL avoids the SDK's node:sqlite requirement (Node >= 22.13 with stable sqlite).
        store: new JsonlLocalAgentStore(
          join(getDefaultSdkStateRoot(this.opts.workDir), "jsonl"),
        ),
      },
    });
    return this.agent;
  }

  async plan(input: PlanInput, signal?: AbortSignal): Promise<PlanDecision> {
    // Rejects as soon as the run is cancelled so the loop doesn't wait for Cursor to wind down.
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Cursor orchestrator run cancelled"));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});

    try {
      const agent = await Promise.race([this.getAgent(), aborted]);
      const sending = agent.send(buildPlanPrompt(input));
      const run = await Promise.race([sending, aborted]).catch((err) => {
        void sending.then((r) => r.cancel()).catch(() => {});
        throw err;
      });
      const stopRun = () => void run.cancel().catch(() => {});
      if (signal?.aborted) stopRun();
      signal?.addEventListener("abort", stopRun, { once: true });

      let result;
      try {
        result = await Promise.race([run.wait(), aborted]);
      } finally {
        signal?.removeEventListener("abort", stopRun);
      }
      if (result.status === "error" || result.status === "cancelled") {
        throw new Error(
          `Cursor orchestrator run ${result.status}: ${result.error?.message ?? result.id}`,
        );
      }
      const text = (result.result ?? "").trim();
      if (!text) {
        throw new Error("Cursor orchestrator returned empty result");
      }
      return extractJson(text);
    } catch (err) {
      if (err instanceof CursorAgentError) {
        throw new Error(
          `Cursor orchestrator failed to start: ${err.message} (retryable=${err.isRetryable})`,
        );
      }
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async dispose(): Promise<void> {
    if (this.agent) {
      await this.agent[Symbol.asyncDispose]();
      this.agent = null;
    }
  }
}
