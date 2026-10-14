import { snapshotWorkspace } from "../workspace.js";
import { buildPlanPrompt, extractJson } from "./prompt.js";
import type { ModelOption, Orchestrator, PlanDecision, PlanInput } from "./types.js";

export type LlmProviderId = "claude" | "gemini" | "openai";

const SYSTEM_PROMPT =
  "You are a planning orchestrator for a coding agent. Always answer with a single JSON object and nothing else.";

async function request<T>(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      ...init.headers,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      message =
        typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? message);
    } catch {
      // keep raw text
    }
    throw new Error(`${res.status} ${message}`);
  }
  return JSON.parse(text) as T;
}

interface Provider {
  label: string;
  complete(apiKey: string, model: string, prompt: string, signal?: AbortSignal): Promise<string>;
  listModels(apiKey: string): Promise<ModelOption[]>;
}

const ANTHROPIC_HEADERS = (apiKey: string) => ({
  "x-api-key": apiKey,
  "anthropic-version": "2023-06-01",
});

/** Override to use any OpenAI-compatible server (e.g. Ollama, LM Studio, OpenRouter). */
const openaiBaseUrl = () =>
  (process.env.ORCH_OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

const OPENAI_EXCLUDED = /audio|realtime|tts|transcribe|whisper|embedding|image|dall-e|moderation|search|codex|instruct|davinci|babbage/;

export const PROVIDERS: Record<LlmProviderId, Provider> = {
  claude: {
    label: "Claude",
    async complete(apiKey, model, prompt, signal) {
      const data = await request<{ content?: Array<{ type: string; text?: string }> }>(
        "https://api.anthropic.com/v1/messages",
        {
          headers: ANTHROPIC_HEADERS(apiKey),
          body: {
            model,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          },
          signal,
        },
      );
      return (data.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    },
    async listModels(apiKey) {
      const data = await request<{ data: Array<{ id: string; display_name?: string }> }>(
        "https://api.anthropic.com/v1/models?limit=100",
        { headers: ANTHROPIC_HEADERS(apiKey) },
      );
      return data.data.map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
    },
  },

  gemini: {
    label: "Gemini",
    async complete(apiKey, model, prompt, signal) {
      const data = await request<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        promptFeedback?: { blockReason?: string };
      }>(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          headers: { "x-goog-api-key": apiKey },
          body: {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" },
          },
          signal,
        },
      );
      if (data.promptFeedback?.blockReason) {
        throw new Error(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
      }
      return (data.candidates?.[0]?.content?.parts ?? [])
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("");
    },
    async listModels(apiKey) {
      const data = await request<{
        models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>;
      }>("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        headers: { "x-goog-api-key": apiKey },
      });
      return (data.models ?? [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .filter((m) => !/embedding|aqa|imagen|tts|image/.test(m.name))
        .map((m) => {
          const id = m.name.replace(/^models\//, "");
          return { id, name: m.displayName ?? id };
        });
    },
  },

  openai: {
    label: "ChatGPT",
    async complete(apiKey, model, prompt, signal) {
      const data = await request<{
        choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
      }>(`${openaiBaseUrl()}/chat/completions`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        body: {
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        },
        signal,
      });
      const message = data.choices?.[0]?.message;
      if (message?.refusal) throw new Error(`ChatGPT refused: ${message.refusal}`);
      return message?.content ?? "";
    },
    async listModels(apiKey) {
      const data = await request<{ data: Array<{ id: string; created?: number }> }>(
        `${openaiBaseUrl()}/models`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      return data.data
        .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_EXCLUDED.test(m.id))
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
        .map((m) => ({ id: m.id, name: m.id }));
    },
  },
};

/** Orchestrator backed by a plain chat-completion API; sees the workspace via a snapshot. */
export class LlmOrchestrator implements Orchestrator {
  constructor(
    readonly id: LlmProviderId,
    private readonly opts: { apiKey: string; model: string },
  ) {}

  async plan(input: PlanInput, signal?: AbortSignal): Promise<PlanDecision> {
    const provider = PROVIDERS[this.id];
    const snapshot = await snapshotWorkspace(input.workDir);
    let text: string;
    try {
      text = await provider.complete(
        this.opts.apiKey,
        this.opts.model,
        buildPlanPrompt(input, snapshot),
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw new Error(`${provider.label} orchestrator run cancelled`);
      throw new Error(
        `${provider.label} orchestrator request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!text.trim()) throw new Error(`${provider.label} orchestrator returned an empty response`);
    return extractJson(text);
  }
}
