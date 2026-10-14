import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import type { Worker, WorkerResult } from "./types.js";

const POLL_INTERVAL_MS = 1000;

// Child servers outlive the parent unless killed explicitly.
const liveProcs = new Set<ChildProcess>();
process.once("exit", () => {
  for (const proc of liveProcs) proc.kill("SIGTERM");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => process.exit(signal === "SIGINT" ? 130 : 143));
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = addr.port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Parses `provider/model` (e.g. `opencode/claude-sonnet-5-5`). */
function parseModelRef(value: string | undefined): { providerID: string; id: string } | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`ORCH_OPENCODE_MODEL must look like provider/model, got "${trimmed}"`);
  }
  return { providerID: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

interface ContentPart {
  type?: string;
  text?: string;
  name?: string;
  state?: { status?: string; input?: Record<string, unknown> | string };
}

interface SessionMessage {
  id: string;
  type: "user" | "assistant" | "idle" | string;
  text?: string;
  outcome?: string;
  content?: ContentPart[];
  error?: { type?: string; message?: string };
}

interface ModelInfo {
  id: string;
  providerID: string;
  name?: string;
  status?: string;
  cost?: Array<{ input: number; output: number }>;
}

interface IntegrationInfo {
  id: string;
  connections?: Array<{ id?: string; label?: string; method?: string; type?: string }>;
}

export interface Diagnosis {
  ok: boolean;
  reply?: string;
  error?: string;
  logins: string[];
  ms: number;
}

export interface FreeModel {
  id: string;
  name: string;
}

interface FileDiff {
  file: string;
  additions: number;
  deletions: number;
  status: string;
}

function toolTarget(part: ContentPart): string | undefined {
  const input = part.state?.input;
  if (!input || typeof input !== "object") return undefined;
  const target =
    input.filePath ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query;
  if (target === undefined) return undefined;
  const text = String(target).replace(/\s+/g, " ").trim();
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function describeToolActivity(part: ContentPart): string {
  const name = part.name ?? "tool";
  const target = toolTarget(part);
  const verbs: Record<string, string> = {
    write: "Writing",
    edit: "Editing",
    patch: "Patching",
    read: "Reading",
    bash: "Running",
    shell: "Running",
    grep: "Searching for",
    glob: "Finding files",
    list: "Listing",
    webfetch: "Fetching",
    websearch: "Searching the web for",
    todowrite: "Updating todo list",
    task: "Starting subtask",
  };
  const verb = verbs[name];
  if (!verb) return `Using ${name}${target ? `: ${target}` : ""}`;
  return target ? `${verb} ${target}` : verb;
}

/**
 * Emits one line per new activity (thinking, writing, each tool call) and for failed tools.
 * `seen` tracks which parts and states have already been reported across polls.
 */
function reportProgress(
  messages: SessionMessage[],
  seen: Set<string>,
  onProgress: (message: string) => void,
): void {
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    (msg.content ?? []).forEach((part, index) => {
      const key = `${msg.id}:${index}`;
      if (part.type === "reasoning") {
        if (!seen.has(key)) onProgress("Thinking…");
      } else if (part.type === "text") {
        if (!seen.has(key)) onProgress("Writing a response…");
      } else if (part.type === "tool") {
        const status = part.state?.status;
        // Tool input is only a parsed object once the call stops streaming.
        if (status === "streaming") return;
        if (!seen.has(key)) onProgress(describeToolActivity(part));
        if (status === "error" && !seen.has(`${key}:error`)) {
          onProgress(`${part.name ?? "Tool"} failed`);
          seen.add(`${key}:error`);
        }
      } else if (part.type && !seen.has(key)) {
        onProgress(part.type);
      }
      seen.add(key);
    });
  }
}

function describeTool(part: ContentPart): string {
  const target = toolTarget(part);
  return `[tool ${part.name ?? "?"}${target ? `: ${target}` : ""}]`;
}

function assistantText(messages: SessionMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.type !== "assistant") continue;
    for (const part of msg.content ?? []) {
      if (part.type === "text" && part.text?.trim()) lines.push(part.text.trim());
      else if (part.type === "tool") lines.push(describeTool(part));
    }
  }
  return lines.join("\n").trim();
}

function summarizeDiff(diff: FileDiff[]): string | undefined {
  if (diff.length === 0) return undefined;
  const lines = diff
    .slice(0, 40)
    .map((d) => `- ${d.file} [${d.status}] (+${d.additions}/-${d.deletions})`);
  const more = diff.length > 40 ? `\n… and ${diff.length - 40} more` : "";
  return lines.join("\n") + more;
}

export class OpenCodeWorker implements Worker {
  readonly id = "opencode";
  private proc: ChildProcess | null = null;
  private baseUrl = "";
  private authHeader = "";
  private sessionId = "";
  private output = "";

  constructor(
    private readonly workDir: string,
    private readonly opts: { model?: string; apiKey?: string; timeoutMs?: number } = {},
  ) {}

  /** Runs a one-line prompt in a scratch session to check that auth and the model work. */
  static async diagnose(opts: { apiKey?: string; model?: string }): Promise<Diagnosis> {
    const started = Date.now();
    const worker = new OpenCodeWorker(tmpdir(), { ...opts, timeoutMs: 90_000 });
    let logins: string[] = [];
    try {
      await worker.launch();
      try {
        const res = await worker.api<{ data: IntegrationInfo[] }>("GET", "/api/integration");
        const opencode = res.data.find((i) => i.id === "opencode");
        logins = (opencode?.connections ?? []).map(
          (c) => `${c.label ?? c.id ?? "credential"} (${c.method ?? c.type ?? "?"})`,
        );
      } catch {
        // informational only
      }
      if (opts.apiKey) logins.unshift("API key from UI (OPENCODE_API_KEY)");

      await worker.start();
      const result = await worker.run("Reply with exactly the word: pong");
      return { ok: true, reply: result.summary, logins, ms: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        logins,
        ms: Date.now() - started,
      };
    } finally {
      await worker.dispose();
    }
  }

  /** Zero-cost models served by OpenCode's own provider. */
  static async listFreeModels(apiKey?: string): Promise<FreeModel[]> {
    const worker = new OpenCodeWorker(tmpdir(), { apiKey });
    try {
      await worker.launch();
      // The catalog loads asynchronously after the server reports healthy.
      let models: ModelInfo[] = [];
      const deadline = Date.now() + 20_000;
      while (models.length === 0 && Date.now() < deadline) {
        models = (await worker.api<{ data: ModelInfo[] }>("GET", "/api/model")).data;
        if (models.length === 0) await sleep(500);
      }
      return models
        .filter(
          (m) =>
            m.providerID === "opencode" &&
            (m.status ?? "active") === "active" &&
            m.cost?.length &&
            m.cost.every((c) => c.input === 0 && c.output === 0),
        )
        .map((m) => ({ id: `${m.providerID}/${m.id}`, name: m.name ?? m.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await worker.dispose();
    }
  }

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      throw new Error(`OpenCode ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async start(): Promise<void> {
    const model = parseModelRef(this.opts.model || process.env.ORCH_OPENCODE_MODEL);
    if (!this.proc) await this.launch();

    try {
      const session = await this.api<{ data: { id: string } }>("POST", "/api/session", {
        title: "orch-worker",
        ...(model ? { model } : {}),
      });
      this.sessionId = session.data.id;
    } catch (err) {
      await this.dispose();
      throw err;
    }
  }

  private async launch(): Promise<void> {
    const port = await findFreePort();
    const password = randomBytes(24).toString("base64url");
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

    this.proc = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: password,
          ...(this.opts.apiKey ? { OPENCODE_API_KEY: this.opts.apiKey } : {}),
        },
      },
    );

    const capture = (chunk: Buffer) => {
      this.output += chunk.toString();
      if (this.output.length > 16_000) this.output = this.output.slice(-12_000);
    };
    this.proc.stderr?.on("data", capture);
    this.proc.stdout?.on("data", capture);
    this.proc.on("error", (err) => {
      this.output += `\n[failed to spawn opencode: ${err.message}]\n`;
    });
    const proc = this.proc;
    liveProcs.add(proc);
    proc.on("exit", (code) => {
      liveProcs.delete(proc);
      this.output += `\n[opencode exited code=${code}]\n`;
    });

    const ready = await this.waitHealthy(30_000);
    if (!ready) {
      await this.dispose();
      throw new Error(
        `OpenCode server failed to become healthy on ${this.baseUrl}. Output:\n${this.output.slice(-2000)}`,
      );
    }
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.proc || this.proc.exitCode != null) return false;
      try {
        const res = await fetch(`${this.baseUrl}/api/info`, {
          headers: { Authorization: this.authHeader },
        });
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    return false;
  }

  /** Messages newer than `userMessageId`, oldest first. */
  private async messagesSince(userMessageId: string): Promise<SessionMessage[]> {
    const res = await this.api<{ data: SessionMessage[] }>(
      "GET",
      `/api/session/${this.sessionId}/message?order=desc&limit=200`,
    );
    const newer: SessionMessage[] = [];
    for (const msg of res.data) {
      if (msg.id === userMessageId) break;
      newer.push(msg);
    }
    return newer.reverse();
  }

  async run(
    prompt: string,
    signal?: AbortSignal,
    onProgress?: (message: string) => void,
  ): Promise<WorkerResult> {
    if (!this.sessionId) {
      throw new Error("OpenCodeWorker not started");
    }

    const sent = await this.api<{ data: { id: string } }>(
      "POST",
      `/api/session/${this.sessionId}/prompt`,
      { text: prompt },
      signal,
    );
    const userMessageId = sent.data.id;

    const timeoutMs =
      this.opts.timeoutMs ?? (Number(process.env.ORCH_WORKER_TIMEOUT_MS) || 30 * 60_000);
    const deadline = Date.now() + timeoutMs;
    let messages: SessionMessage[] = [];
    let idle: SessionMessage | undefined;
    const seen = new Set<string>();

    while (!idle) {
      if (signal?.aborted) {
        await this.interrupt();
        throw new Error("OpenCode run cancelled");
      }
      if (Date.now() > deadline) {
        await this.interrupt();
        throw new Error(`OpenCode run timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      if (this.proc?.exitCode != null) {
        throw new Error(`OpenCode server exited. Output:\n${this.output.slice(-2000)}`);
      }
      await sleep(POLL_INTERVAL_MS);
      messages = await this.messagesSince(userMessageId);
      if (onProgress) {
        const prefix = `${this.workDir.replace(/\/$/, "")}/`;
        reportProgress(messages, seen, (m) => onProgress(m.replaceAll(prefix, "")));
      }
      idle = messages.find((m) => m.type === "idle");
    }

    const rawText = assistantText(messages);
    if (idle.outcome !== "succeeded") {
      const errors = messages
        .filter((m) => m.error?.message)
        .map((m) => `${m.error!.type ?? "error"}: ${m.error!.message}`);
      throw new Error(
        `OpenCode turn ${idle.outcome ?? "ended"}${errors.length ? `: ${errors.join("; ")}` : ""}` +
          (rawText ? `\nPartial output:\n${rawText.slice(0, 1000)}` : ""),
      );
    }

    let diffSummary: string | undefined;
    try {
      const diff = await this.api<{ data: FileDiff[] }>(
        "GET",
        `/api/session/${this.sessionId}/diff?from=${userMessageId}`,
      );
      diffSummary = summarizeDiff(diff.data);
    } catch {
      // diff is best-effort (e.g. not a git repo)
    }

    const summary =
      rawText.length > 2000 ? `${rawText.slice(0, 2000)}…` : rawText || "(empty worker response)";

    return { summary, rawText, diffSummary };
  }

  private async interrupt(): Promise<void> {
    try {
      await this.api("POST", `/api/session/${this.sessionId}/interrupt`);
    } catch {
      // best-effort
    }
  }

  async dispose(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.sessionId = "";
    if (!proc || proc.exitCode != null) return;

    proc.kill("SIGTERM");
    const killed = await Promise.race([
      new Promise<boolean>((resolve) => proc.once("exit", () => resolve(true))),
      sleep(3000).then(() => false),
    ]);
    if (!killed) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
}
