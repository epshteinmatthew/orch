import type { PlanDecision, PlanInput, QcResult } from "./types.js";

export function extractJson(text: string): PlanDecision {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();

  // Prefer first {...} object if there's surrounding prose
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Orchestrator response did not contain JSON");
  }

  const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<PlanDecision>;
  if (!parsed.action || !["prompt", "done", "fail"].includes(parsed.action)) {
    throw new Error(`Invalid action in orchestrator JSON: ${String(parsed.action)}`);
  }
  if (parsed.action === "prompt" && !parsed.workerPrompt?.trim()) {
    throw new Error('action "prompt" requires workerPrompt');
  }
  return {
    action: parsed.action,
    workerPrompt: parsed.workerPrompt?.trim(),
    reason: (parsed.reason ?? "").trim() || "(no reason given)",
    qc: parseQc(parsed.qc),
  };
}

function parseQc(raw: unknown): QcResult | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const qc = raw as { passed?: unknown; violations?: unknown };
  const violations = Array.isArray(qc.violations)
    ? qc.violations.map((v) => String(v).trim()).filter(Boolean)
    : [];
  // A model that lists violations but says passed=true is treated as failing.
  return { passed: qc.passed === true && violations.length === 0, violations };
}

function formatQc(qc: QcResult | undefined): string | undefined {
  if (!qc) return undefined;
  return qc.passed ? "QC: passed" : `QC: FAILED — ${qc.violations.join("; ") || "(no details)"}`;
}

/**
 * @param workspaceSnapshot For orchestrators without file access; omit when the
 * orchestrator can inspect the work directory itself.
 */
export function buildPlanPrompt(input: PlanInput, workspaceSnapshot?: string): string {
  const historyBlock =
    input.history.length === 0
      ? "(none yet)"
      : input.history
          .map((h) => {
            const lines = [`### Iteration ${h.iteration}`];
            const qc = formatQc(h.decision.qc);
            if (qc) lines.push(`${qc} (your verdict on the previous worker iteration)`);
            lines.push(
              `Decision: ${h.decision.action} — ${h.decision.reason}`,
              `Worker prompt: ${h.decision.workerPrompt ?? "(n/a)"}`,
            );
            if (h.harnessNote !== undefined) {
              lines.push(`OVERRIDDEN by the harness: ${h.harnessNote}`);
            } else if (h.userFeedback !== undefined) {
              lines.push(
                `REJECTED by the user (nothing was sent to the worker). User feedback: ${h.userFeedback || "(none given)"}`,
              );
            } else {
              if (h.editedPrompt !== undefined) {
                lines.push(`The user edited the prompt before sending. Prompt actually sent: ${h.editedPrompt}`);
              }
              lines.push(`Worker result: ${h.workerSummary ?? "(n/a)"}`);
            }
            return lines.join("\n");
          })
          .join("\n\n");

  const lastFeedback = input.history.at(-1)?.userFeedback;
  const feedbackBlock =
    lastFeedback === undefined
      ? ""
      : `\n## The user rejected your last proposal\n${lastFeedback || "(no reason given)"}\nTake this feedback into account in your next decision.\n`;

  const lastNote = input.history.at(-1)?.harnessNote;
  const noteBlock =
    lastNote === undefined ? "" : `\n## Your last decision was overridden\n${lastNote}\n`;

  const qcRules = input.qcRules?.trim();
  const qcBlock = qcRules
    ? `
## QC rules (must ALL be met)
${qcRules}

Quality control is your responsibility. Before accepting the last worker iteration, check it against every QC rule above (inspect the actual files/changes, not just the worker's summary).
- If any rule is violated, your action MUST be "prompt" and the workerPrompt must tell the worker exactly which rules were violated and how to fix them, before any new work.
- Never use "done" while any QC rule is violated.
- Report your verdict in the "qc" field. On the first iteration (no worker output yet) set "qc" to null.
`
    : "";

  const qcSchema = qcRules
    ? `,\n  "qc": { "passed": boolean, "violations": ["rule that was broken and where"] } | null`
    : "";

  const inspection =
    workspaceSnapshot === undefined
      ? "Inspect the work directory as needed (list files, read key files, check git status if present)."
      : `You cannot read files directly. This is a snapshot of the work directory taken just now:\n\n${workspaceSnapshot}\n\nIf you need to see a file's contents to judge progress, have the worker report on it.`;

  return `You are the ORCHESTRATOR for a coding harness.

Your job: decide the next step for an OpenCode worker agent that can edit files in the work directory.
You do NOT implement the goal yourself. You inspect the workspace, judge progress, and either:
- prompt the worker with a concrete next instruction, or
- declare done, or
- declare fail.

Work directory: ${input.workDir}
Iteration: ${input.iteration} / ${input.maxIterations}

## Goal
${input.goal}

## Last worker summary
${input.lastWorkerSummary ?? "(none)"}

## Last diff summary
${input.lastDiffSummary ?? "(none)"}

## Prior iterations
${historyBlock}
${feedbackBlock}${noteBlock}${qcBlock}
${inspection}

Respond with ONLY a JSON object (no markdown outside the JSON is preferred; a single fenced json block is OK):
{
  "action": "prompt" | "done" | "fail",
  "workerPrompt": "string — required when action is prompt; concrete instructions for OpenCode",
  "reason": "short explanation of your decision"${qcSchema}
}

Rules:
- Prefer small, verifiable steps over giant prompts.
- On the first iteration, give a clear kickoff prompt covering the full goal if the workspace is empty of progress.
- Use "done" only when the goal is substantially achieved.
- Use "fail" if blocked or max useful progress is exhausted before the limit.
`;
}
