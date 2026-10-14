import { CursorOrchestrator, listCursorModels } from "./cursor.js";
import { LlmOrchestrator, PROVIDERS, type LlmProviderId } from "./llm.js";
import type { ModelOption, Orchestrator } from "./types.js";

export type {
  HistoryEntry,
  ModelOption,
  Orchestrator,
  PlanDecision,
  PlanInput,
  PlanAction,
} from "./types.js";

export interface OrchestratorInfo {
  id: string;
  label: string;
  /** Env vars checked (in order) when no key is supplied from the UI. */
  envKeys: string[];
  defaultModel?: string;
}

export const ORCHESTRATORS: OrchestratorInfo[] = [
  {
    id: "cursor",
    label: "Cursor",
    envKeys: ["CURSOR_API_KEY"],
    defaultModel: process.env.ORCH_CURSOR_MODEL || "composer-2.5",
  },
  { id: "claude", label: "Claude (Anthropic)", envKeys: ["ANTHROPIC_API_KEY"] },
  { id: "gemini", label: "Gemini (Google)", envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  { id: "openai", label: "ChatGPT (OpenAI)", envKeys: ["OPENAI_API_KEY"] },
];

export const ORCHESTRATOR_IDS = ORCHESTRATORS.map((o) => o.id);

function info(id: string): OrchestratorInfo {
  const found = ORCHESTRATORS.find((o) => o.id === id);
  if (!found) {
    throw new Error(`Unknown orchestrator "${id}". Supported: ${ORCHESTRATOR_IDS.join(", ")}`);
  }
  return found;
}

export function envKeyFor(id: string): string | undefined {
  for (const name of info(id).envKeys) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}

function resolveKey(id: string, apiKey?: string): string {
  const key = apiKey || envKeyFor(id);
  if (!key) {
    const meta = info(id);
    throw new Error(
      `A ${meta.label} API key is required: enter one in the UI or set ${meta.envKeys.join(" / ")}`,
    );
  }
  return key;
}

export function createOrchestrator(opts: {
  id: string;
  workDir: string;
  apiKey?: string;
  model?: string;
}): Orchestrator {
  const meta = info(opts.id);
  const apiKey = resolveKey(opts.id, opts.apiKey);
  const model = opts.model || meta.defaultModel;
  if (!model) {
    throw new Error(`Choose a model for the ${meta.label} orchestrator`);
  }

  if (opts.id === "cursor") {
    return new CursorOrchestrator({ apiKey, workDir: opts.workDir, model });
  }
  return new LlmOrchestrator(opts.id as LlmProviderId, { apiKey, model });
}

export async function listOrchestratorModels(id: string, apiKey?: string): Promise<ModelOption[]> {
  const key = resolveKey(id, apiKey);
  if (id === "cursor") return listCursorModels(key);
  return PROVIDERS[id as LlmProviderId].listModels(key);
}
