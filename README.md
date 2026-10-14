# orch

Local harness: **Cursor** (orchestrator) plans and checks; **OpenCode** executes in a work folder. Drive it from a localhost UI.

## Setup

```bash
cp .env.example .env
# set CURSOR_API_KEY in .env

npm install
npm run dev
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787).

Requires `opencode` on your `PATH` (already authenticated) and a Cursor API key.

## Usage

1. Under **Orchestrator**, pick a provider (Cursor, Claude, Gemini, or ChatGPT), paste its API key, and choose a model (**Load models** lists what your key can use). Under **OpenCode worker**, optionally add an OpenCode API key and pick one of OpenCode's always-free models. Everything is remembered in your browser; server env vars are used as fallbacks.
1. Set **Work folder** to the project directory OpenCode should edit.
2. Enter a **Goal**, or put `GOAL.md` / `PROMPT.md` in that folder (UI text and file are merged if both exist).
3. Click **Start**. Watch the run log: orchestrator decisions → OpenCode prompts → rinse/repeat until done.

## Architecture

| Role | Default | Swap |
|------|---------|------|
| Orchestrator | Cursor SDK (`src/orchestrators/cursor.ts`); Claude / Gemini / ChatGPT via their HTTP APIs (`src/orchestrators/llm.ts`) | Add a provider to `PROVIDERS` in `llm.ts`, or implement `Orchestrator` and register it in `src/orchestrators/index.ts` |

Cursor runs as a local agent and can read the work folder itself. Claude, Gemini, and ChatGPT can't, so each planning call includes a snapshot of the folder: the file list (up to 400 files), `git status`, and `git diff HEAD` (up to 15k chars).
| Worker | OpenCode HTTP server (`src/workers/opencode.ts`) | Implement `Worker` and register in `src/workers/index.ts` |

Env knobs: `ORCH_ORCHESTRATOR`, `ORCH_MAX_ITERS`, `ORCH_CURSOR_MODEL`, `ORCH_OPENCODE_MODEL` (`provider/model`, e.g. `opencode/claude-sonnet-5-5`), `ORCH_WORKER_TIMEOUT_MS`, `ORCH_PORT`, `ORCH_HOST`.

Smoke-test the OpenCode worker on its own: `npx tsx scripts/smoke-opencode.ts`.
