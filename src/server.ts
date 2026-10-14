import "dotenv/config";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import {
  envKeyFor,
  listOrchestratorModels,
  ORCHESTRATOR_IDS,
  ORCHESTRATORS,
} from "./orchestrators/index.js";
import { runLoop, type ApprovalResponse, type RunEvent } from "./loop.js";
import { pickFolder } from "./pickFolder.js";
import { commitAndPush, discardChanges, gitStatus } from "./git.js";
import { askCursor } from "./direct.js";
import { OpenCodeWorker, type FreeModel } from "./workers/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

type RunStatus = Extract<RunEvent, { type: "status" }>["status"] | "cancelling";

interface RunState {
  id: string;
  events: RunEvent[];
  listeners: Set<(event: RunEvent) => void>;
  controller: AbortController;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  workDir: string;
  goalPreview: string;
  orchestrator: string;
  iteration: number;
  stepMode: boolean;
  pendingApproval?: {
    iteration: number;
    resolve: (response: ApprovalResponse) => void;
  };
}

const TERMINAL_STATUSES = new Set<RunStatus>(["done", "failed", "cancelled"]);
const MAX_FINISHED_RUNS = 30;
const CANCELLED_RUN_TTL_MS = 60_000;

const runs = new Map<string, RunState>();

function runSummary(run: RunState) {
  return {
    id: run.id,
    status: run.status,
    active: !TERMINAL_STATUSES.has(run.status),
    workDir: run.workDir,
    goalPreview: run.goalPreview,
    orchestrator: run.orchestrator,
    iteration: run.iteration,
    stepMode: run.stepMode,
    awaitingApproval: run.pendingApproval?.iteration ?? null,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
  };
}

function pruneFinishedRuns() {
  const finished = [...runs.values()]
    .filter((r) => TERMINAL_STATUSES.has(r.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const run of finished.slice(MAX_FINISHED_RUNS)) runs.delete(run.id);
}

function pushEvent(run: RunState, event: RunEvent) {
  if (event.type === "status" && !TERMINAL_STATUSES.has(run.status)) {
    // Keep "cancelling" visible until the loop reports a terminal status.
    if (run.status !== "cancelling" || TERMINAL_STATUSES.has(event.status)) {
      run.status = event.status;
    }
    if (TERMINAL_STATUSES.has(event.status)) {
      run.endedAt = Date.now();
      pruneFinishedRuns();
      if (event.status === "cancelled") {
        // Kept briefly so an open log stream can still receive the final events.
        setTimeout(() => runs.delete(run.id), CANCELLED_RUN_TTL_MS).unref();
      }
    }
  }
  if ("iteration" in event) run.iteration = Math.max(run.iteration, event.iteration);
  run.events.push(event);
  for (const listener of run.listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
}

const app = new Hono();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    orchestrators: ORCHESTRATOR_IDS,
    hasOpencodeKey: Boolean(process.env.OPENCODE_API_KEY),
  }),
);

app.get("/api/orchestrators", (c) =>
  c.json({
    orchestrators: ORCHESTRATORS.map((o) => ({
      id: o.id,
      label: o.label,
      envKeys: o.envKeys,
      hasEnvKey: Boolean(envKeyFor(o.id)),
      defaultModel: o.defaultModel ?? null,
    })),
    defaultId: process.env.ORCH_ORCHESTRATOR || "cursor",
  }),
);

app.post("/api/orchestrators/:id/models", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { apiKey?: string };
  try {
    return c.json({
      models: await listOrchestratorModels(c.req.param("id"), body.apiKey?.trim() || undefined),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

let freeModels: Promise<FreeModel[]> | null = null;

app.get("/api/opencode/models", async (c) => {
  if (c.req.query("refresh")) freeModels = null;
  freeModels ??= OpenCodeWorker.listFreeModels(process.env.OPENCODE_API_KEY);
  try {
    return c.json({
      models: await freeModels,
      envDefault: process.env.ORCH_OPENCODE_MODEL || null,
    });
  } catch (err) {
    freeModels = null;
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/goal", async (c) => {
  const workDir = c.req.query("workDir")?.trim();
  if (!workDir) return c.json({ error: "workDir query param required" }, 400);
  try {
    const { access, readFile } = await import("node:fs/promises");
    const { join, resolve } = await import("node:path");
    const dir = resolve(workDir);
    await access(dir);
    for (const name of ["GOAL.md", "PROMPT.md", "goal.md", "prompt.md"]) {
      try {
        const text = (await readFile(join(dir, name), "utf8")).trim();
        if (text) return c.json({ goal: text, file: name });
      } catch {
        // try next
      }
    }
    return c.json({ goal: "", file: null });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

app.post("/api/opencode/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    apiKey?: string;
    model?: string;
  };
  return c.json(
    await OpenCodeWorker.diagnose({
      apiKey: body.apiKey?.trim() || process.env.OPENCODE_API_KEY || undefined,
      model: body.model?.trim() || undefined,
    }),
  );
});

function activeRunInFolder(workDir: string): RunState | undefined {
  const dir = resolve(workDir);
  return [...runs.values()].find(
    (r) => !TERMINAL_STATUSES.has(r.status) && resolve(r.workDir) === dir,
  );
}

app.get("/api/git/status", async (c) => {
  const workDir = c.req.query("workDir")?.trim();
  if (!workDir) return c.json({ error: "workDir query param required" }, 400);
  const status = await gitStatus(workDir);
  return c.json({ ...status, activeRunId: activeRunInFolder(workDir)?.id ?? null });
});

app.post("/api/git/commit-push", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workDir?: string;
    message?: string;
    push?: boolean;
  };
  const workDir = body.workDir?.trim();
  if (!workDir) return c.json({ error: "workDir is required" }, 400);
  const active = activeRunInFolder(workDir);
  if (active) {
    return c.json(
      { error: `Run ${active.id} is still working in this folder. Wait for it to finish or cancel it first.` },
      409,
    );
  }
  const message = body.message?.trim() || "Changes from orch";
  return c.json(await commitAndPush(workDir, message, body.push !== false));
});

app.post("/api/git/discard", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { workDir?: string };
  const workDir = body.workDir?.trim();
  if (!workDir) return c.json({ error: "workDir is required" }, 400);
  const active = activeRunInFolder(workDir);
  if (active) {
    return c.json(
      { error: `Run ${active.id} is still working in this folder. Wait for it to finish or cancel it first.` },
      409,
    );
  }
  return c.json(await discardChanges(workDir));
});

app.post("/api/ask", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workDir?: string;
    question?: string;
    apiKey?: string;
    model?: string;
  };
  const workDir = body.workDir?.trim();
  if (!workDir) return c.json({ error: "workDir is required" }, 400);
  const question = body.question?.trim();
  if (!question) return c.json({ error: "question is required" }, 400);

  const id = nanoid(10);
  const controller = new AbortController();
  const run: RunState = {
    id,
    events: [],
    listeners: new Set(),
    controller,
    startedAt: Date.now(),
    status: "starting",
    workDir,
    goalPreview: `Ask: ${question.split("\n")[0]!.slice(0, 110)}`,
    orchestrator: "cursor (ask)",
    iteration: 0,
    stepMode: false,
  };
  runs.set(id, run);

  void askCursor({
    workDir,
    question,
    apiKey: body.apiKey?.trim() || undefined,
    model: body.model?.trim() || undefined,
    signal: controller.signal,
    emit: (event) => pushEvent(run, event),
  }).catch((err) => {
    pushEvent(run, { type: "error", message: err instanceof Error ? err.message : String(err) });
    pushEvent(run, { type: "status", status: "failed" });
  });

  return c.json({ runId: id });
});

app.post("/api/pick-folder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { start?: string };
  try {
    const path = await pickFolder(body.start?.trim() || undefined);
    return c.json(path ? { path } : { cancelled: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get("/api/runs", (c) =>
  c.json({
    runs: [...runs.values()]
      .filter((r) => r.status !== "cancelled")
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(runSummary),
  }),
);

app.get("/api/runs/:id", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json(runSummary(run));
});

app.post("/api/runs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    goal?: string;
    workDir?: string;
    orchestrator?: string;
    maxIterations?: number;
    orchestratorApiKey?: string;
    orchestratorModel?: string;
    opencodeApiKey?: string;
    opencodeModel?: string;
    stepMode?: boolean;
    qcRules?: string;
  };

  if (!body.workDir?.trim()) {
    return c.json({ error: "workDir is required" }, 400);
  }

  const id = nanoid(10);
  const controller = new AbortController();
  const goalText = body.goal?.trim() ?? "";
  const run: RunState = {
    id,
    events: [],
    listeners: new Set(),
    controller,
    startedAt: Date.now(),
    status: "starting",
    workDir: body.workDir.trim(),
    goalPreview: goalText
      ? goalText.split("\n")[0]!.slice(0, 120)
      : "(goal from GOAL.md / PROMPT.md)",
    orchestrator: body.orchestrator || process.env.ORCH_ORCHESTRATOR || "cursor",
    iteration: 0,
    stepMode: Boolean(body.stepMode),
  };
  runs.set(id, run);

  // Fire-and-forget; clients subscribe via SSE
  void runLoop({
    runId: id,
    workDir: body.workDir.trim(),
    goal: body.goal,
    orchestratorId: body.orchestrator,
    maxIterations: body.maxIterations,
    orchestratorApiKey: body.orchestratorApiKey?.trim() || undefined,
    orchestratorModel: body.orchestratorModel?.trim() || undefined,
    opencodeApiKey: body.opencodeApiKey?.trim() || undefined,
    opencodeModel: body.opencodeModel?.trim() || undefined,
    qcRules: body.qcRules?.trim() || undefined,
    signal: controller.signal,
    emit: (event) => pushEvent(run, event),
    stepMode: () => run.stepMode,
    requestApproval: (iteration) =>
      new Promise<ApprovalResponse>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new Error("cancelled"));
          return;
        }
        const onAbort = () => {
          run.pendingApproval = undefined;
          reject(new Error("cancelled"));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        run.pendingApproval = {
          iteration,
          resolve: (response) => {
            controller.signal.removeEventListener("abort", onAbort);
            run.pendingApproval = undefined;
            resolve(response);
          },
        };
      }),
  }).catch((err) => {
    pushEvent(run, {
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    pushEvent(run, { type: "status", status: "failed" });
  });

  return c.json({ runId: id });
});

app.get("/api/runs/:id/events", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);

  return streamSSE(c, async (stream) => {
    const isTerminal = (e: RunEvent) =>
      e.type === "status" && ["done", "failed", "cancelled"].includes(e.status);

    let aborted = false;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));

    // Writes are chained so events go out in order and the terminal status
    // is fully written before the stream closes.
    let writes = Promise.resolve();
    const enqueue = (event: RunEvent) => {
      writes = writes
        .then(async () => {
          if (aborted) return;
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        })
        .catch(() => {
          aborted = true;
        });
      if (isTerminal(event)) void writes.then(finish);
    };

    run.listeners.add(enqueue);
    stream.onAbort(() => {
      aborted = true;
      finish();
    });
    for (const event of run.events) enqueue(event);

    await finished;
    run.listeners.delete(enqueue);
  });
});

app.post("/api/runs/:id/approval", async (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as {
    action?: string;
    workerPrompt?: string;
    feedback?: string;
    /** Approve this step and stop asking for the rest of the run. */
    autoApproveRest?: boolean;
  };
  const pending = run.pendingApproval;
  if (!pending) return c.json({ error: "run is not waiting for approval" }, 409);

  if (body.action === "approve") {
    if (body.autoApproveRest) {
      run.stepMode = false;
      pushEvent(run, { type: "log", message: "Step-by-step mode turned off; remaining steps run automatically" });
    }
    pending.resolve({ action: "approve", workerPrompt: body.workerPrompt });
  } else if (body.action === "reject") {
    pending.resolve({ action: "reject", feedback: body.feedback });
  } else {
    return c.json({ error: 'action must be "approve" or "reject"' }, 400);
  }
  return c.json({ ok: true });
});

app.post("/api/runs/:id/step-mode", async (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
  run.stepMode = Boolean(body.enabled);
  pushEvent(run, {
    type: "log",
    message: run.stepMode
      ? "Step-by-step mode on: the next decision will wait for approval"
      : "Step-by-step mode off",
  });
  return c.json(runSummary(run));
});

app.post("/api/runs/:id/cancel", (c) => {
  const run = runs.get(c.req.param("id"));
  if (!run) return c.json({ error: "run not found" }, 404);
  if (TERMINAL_STATUSES.has(run.status)) return c.json({ ok: true, alreadyEnded: true });
  run.controller.abort();
  run.status = "cancelling";
  pushEvent(run, { type: "log", message: "Cancel requested" });
  return c.json({ ok: true });
});

// Compiled server (dist/server.js) serves the Vite build; `npm run dev` serves web/ directly
const runningFromDist = __dirname === join(rootDir, "dist");
const webDir =
  runningFromDist && existsSync(join(rootDir, "dist/web")) ? "dist/web" : "web";

app.use("/*", serveStatic({ root: webDir }));
app.get("/", serveStatic({ path: `${webDir}/index.html` }));

const port = Number(process.env.ORCH_PORT ?? 8787);
const hostname = process.env.ORCH_HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`orch listening on http://${hostname}:${port}`);
  console.log(`UI root: ${webDir}`);
  console.log(`Cursor API key: ${process.env.CURSOR_API_KEY ? "set" : "MISSING"}`);

  // Once serving, a stray error from an SDK or child process (e.g. during cancel)
  // must not take down every run. Startup errors like EADDRINUSE still exit.
  process.on("unhandledRejection", (reason) => {
    console.error("[orch] unhandled rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[orch] uncaught exception:", err);
  });
});
