export type PlanAction = "prompt" | "done" | "fail";

export interface PlanInput {
  goal: string;
  workDir: string;
  iteration: number;
  maxIterations: number;
  lastWorkerSummary?: string;
  lastDiffSummary?: string;
  history: HistoryEntry[];
  /** User-defined quality rules every worker iteration must satisfy. */
  qcRules?: string;
}

export interface QcResult {
  passed: boolean;
  violations: string[];
}

export interface HistoryEntry {
  iteration: number;
  decision: PlanDecision;
  workerSummary?: string;
  /** Set in step-by-step mode when the user changed the proposed worker prompt. */
  editedPrompt?: string;
  /** Set in step-by-step mode when the user rejected the decision. */
  userFeedback?: string;
  /** Set when the harness overrode the decision (e.g. "done" while QC failed). */
  harnessNote?: string;
}

export interface PlanDecision {
  action: PlanAction;
  workerPrompt?: string;
  reason: string;
  /** QC verdict on the most recent worker iteration; only present when QC rules are active. */
  qc?: QcResult;
}

export interface ModelOption {
  id: string;
  name: string;
}

export interface Orchestrator {
  readonly id: string;
  plan(input: PlanInput, signal?: AbortSignal): Promise<PlanDecision>;
  dispose?(): Promise<void>;
}
