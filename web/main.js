const form = document.getElementById("run-form");
const startBtn = document.getElementById("start-btn");
const cancelBtn = document.getElementById("cancel-btn");
const loadBtn = document.getElementById("load-btn");
const logEl = document.getElementById("log");
const statusPill = document.getElementById("status-pill");
const healthEl = document.getElementById("health");

const themeBtn = document.getElementById("theme-btn");

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? "Light" : "Dark";
}

applyTheme(document.documentElement.dataset.theme || "light");
themeBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("orch.theme", next);
  applyTheme(next);
});

const orchSelectEl = document.getElementById("orchestrator");
const orchKeyEl = document.getElementById("orchestratorApiKey");
const orchKeyLabelEl = document.getElementById("orchestrator-key-label");
const orchModelEl = document.getElementById("orchestratorModel");
const orchModelListEl = document.getElementById("orchestrator-models");
const loadOrchModelsBtn = document.getElementById("load-orch-models-btn");
const orchModelsResultEl = document.getElementById("orchestrator-models-result");
const opencodeKeyEl = document.getElementById("opencodeApiKey");
const modelEl = document.getElementById("opencodeModel");
const refreshModelsBtn = document.getElementById("refresh-models-btn");

let currentRunId = null;
let eventSource = null;

const TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

const STORAGE_KEYS = {
  orchestrator: "orch.orchestrator",
  orchestratorKey: (id) => `orch.orchestratorKey.${id}`,
  orchestratorModel: (id) => `orch.orchestratorModel.${id}`,
  opencodeApiKey: "orch.opencodeApiKey",
  opencodeModel: "orch.opencodeModel",
  workDir: "orch.workDir",
};

// Keys saved before multi-provider support.
const legacyCursorKey = localStorage.getItem("orch.cursorApiKey");
if (legacyCursorKey && !localStorage.getItem(STORAGE_KEYS.orchestratorKey("cursor"))) {
  localStorage.setItem(STORAGE_KEYS.orchestratorKey("cursor"), legacyCursorKey);
}
localStorage.removeItem("orch.cursorApiKey");

function persist(el, key) {
  const saved = localStorage.getItem(key);
  if (saved !== null) el.value = saved;
  el.addEventListener("change", () => localStorage.setItem(key, el.value.trim()));
}

let orchestrators = [];

function currentOrchestrator() {
  return orchestrators.find((o) => o.id === orchSelectEl.value);
}

function showOrchestrator() {
  const meta = currentOrchestrator();
  if (!meta) return;
  const id = meta.id;
  orchKeyLabelEl.textContent = `${meta.label} API key`;
  orchKeyEl.value = localStorage.getItem(STORAGE_KEYS.orchestratorKey(id)) || "";
  orchKeyEl.placeholder = meta.hasEnvKey
    ? `Using ${meta.envKeys.join(" / ")} from server env`
    : `Required (or set ${meta.envKeys.join(" / ")})`;
  orchModelEl.value = localStorage.getItem(STORAGE_KEYS.orchestratorModel(id)) || "";
  orchModelEl.placeholder = meta.defaultModel
    ? `Default: ${meta.defaultModel}`
    : "Pick a model (click Load models)";
  orchModelListEl.innerHTML = "";
  orchModelsResultEl.hidden = true;
  if (orchKeyEl.value || meta.hasEnvKey) loadOrchestratorModels({ quiet: true });
}

async function loadOrchestratorModels({ quiet = false } = {}) {
  const meta = currentOrchestrator();
  if (!meta) return;
  const id = meta.id;
  loadOrchModelsBtn.disabled = true;
  if (!quiet) {
    orchModelsResultEl.hidden = false;
    orchModelsResultEl.className = "hint";
    orchModelsResultEl.textContent = `Loading ${meta.label} models…`;
  }
  try {
    const res = await fetch(`/api/orchestrators/${id}/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: orchKeyEl.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (orchSelectEl.value !== id) return;
    orchModelListEl.innerHTML = "";
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      if (m.name !== m.id) opt.label = m.name;
      orchModelListEl.appendChild(opt);
    }
    if (!orchModelEl.value && !meta.defaultModel && data.models[0]) {
      orchModelEl.value = data.models[0].id;
      localStorage.setItem(STORAGE_KEYS.orchestratorModel(id), orchModelEl.value);
    }
    orchModelsResultEl.hidden = false;
    orchModelsResultEl.className = "hint";
    orchModelsResultEl.textContent = `${data.models.length} ${meta.label} models available. Key works.`;
  } catch (err) {
    if (orchSelectEl.value !== id) return;
    orchModelsResultEl.hidden = false;
    orchModelsResultEl.className = "hint bad";
    orchModelsResultEl.textContent = `Could not load ${meta.label} models: ${err instanceof Error ? err.message : err}`;
  } finally {
    loadOrchModelsBtn.disabled = false;
  }
}

async function loadOrchestrators() {
  try {
    const res = await fetch("/api/orchestrators");
    const data = await res.json();
    orchestrators = data.orchestrators;
    orchSelectEl.innerHTML = "";
    for (const o of orchestrators) {
      const opt = document.createElement("option");
      opt.value = o.id;
      opt.textContent = o.label;
      orchSelectEl.appendChild(opt);
    }
    const saved = localStorage.getItem(STORAGE_KEYS.orchestrator);
    orchSelectEl.value = orchestrators.some((o) => o.id === saved) ? saved : data.defaultId;
    showOrchestrator();
  } catch (err) {
    appendLog("err", `Could not load orchestrators: ${err instanceof Error ? err.message : err}`);
  }
}

orchSelectEl.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEYS.orchestrator, orchSelectEl.value);
  showOrchestrator();
});
orchKeyEl.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEYS.orchestratorKey(orchSelectEl.value), orchKeyEl.value.trim());
  if (orchKeyEl.value.trim()) loadOrchestratorModels();
});
orchModelEl.addEventListener("change", () =>
  localStorage.setItem(STORAGE_KEYS.orchestratorModel(orchSelectEl.value), orchModelEl.value.trim()),
);
loadOrchModelsBtn.addEventListener("click", () => loadOrchestratorModels());

persist(opencodeKeyEl, STORAGE_KEYS.opencodeApiKey);
persist(document.getElementById("workDir"), STORAGE_KEYS.workDir);
modelEl.addEventListener("change", () =>
  localStorage.setItem(STORAGE_KEYS.opencodeModel, modelEl.value),
);

async function loadModels(refresh = false) {
  modelEl.disabled = true;
  refreshModelsBtn.disabled = true;
  modelEl.innerHTML = '<option value="">Loading models…</option>';
  try {
    const res = await fetch(`/api/opencode/models${refresh ? "?refresh=1" : ""}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);

    modelEl.innerHTML = "";
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.id})`;
      modelEl.appendChild(opt);
    }
    if (data.models.length === 0) {
      modelEl.innerHTML = '<option value="">No free models found</option>';
    }

    const preferred = localStorage.getItem(STORAGE_KEYS.opencodeModel) || data.envDefault;
    if (preferred && data.models.some((m) => m.id === preferred)) {
      modelEl.value = preferred;
    }
  } catch (err) {
    modelEl.innerHTML = '<option value="">Failed to load models</option>';
    appendLog("err", `Could not load OpenCode models: ${err instanceof Error ? err.message : err}`);
  } finally {
    modelEl.disabled = false;
    refreshModelsBtn.disabled = false;
  }
}

refreshModelsBtn.addEventListener("click", () => loadModels(true));

const testBtn = document.getElementById("test-opencode-btn");
const testResultEl = document.getElementById("opencode-test-result");

testBtn.addEventListener("click", async () => {
  testBtn.disabled = true;
  testResultEl.hidden = false;
  testResultEl.className = "hint";
  testResultEl.textContent = `Testing ${modelEl.value || "default model"}…`;
  try {
    const res = await fetch("/api/opencode/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: opencodeKeyEl.value.trim(), model: modelEl.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const logins = data.logins.length ? data.logins.join(", ") : "none found";
    const secs = (data.ms / 1000).toFixed(1);
    if (data.ok) {
      testResultEl.className = "hint ok";
      testResultEl.textContent = `✓ OpenCode works (${secs}s). Reply: "${data.reply}". Logins: ${logins}`;
    } else {
      testResultEl.className = "hint bad";
      testResultEl.textContent = `✗ OpenCode failed (${secs}s): ${data.error}. Logins: ${logins}`;
    }
  } catch (err) {
    testResultEl.className = "hint bad";
    testResultEl.textContent = `✗ Test request failed: ${err instanceof Error ? err.message : err}`;
  } finally {
    testBtn.disabled = false;
  }
});

const workDirEl = document.getElementById("workDir");
const browseBtn = document.getElementById("browse-btn");

browseBtn.addEventListener("click", async () => {
  browseBtn.disabled = true;
  try {
    const res = await fetch("/api/pick-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: workDirEl.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (data.path) {
      workDirEl.value = data.path;
      localStorage.setItem(STORAGE_KEYS.workDir, data.path);
    }
  } catch (err) {
    appendLog("err", `Folder picker: ${err instanceof Error ? err.message : err}`);
  } finally {
    browseBtn.disabled = false;
  }
});
loadModels();

function setStatus(status) {
  statusPill.textContent = status;
  statusPill.className = `pill ${status}`;
}

function appendLog(cls, text) {
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function formatEvent(event) {
  switch (event.type) {
    case "status":
      setStatus(event.status);
      if (event.message) appendLog("meta", `[status] ${event.status}: ${event.message}`);
      else appendLog("meta", `[status] ${event.status}`);
      break;
    case "log":
      appendLog("meta", event.message);
      break;
    case "orchestrator": {
      const qc = formatQc(event.decision.qc);
      if (qc) appendLog(event.decision.qc.passed ? "orch" : "err", `[qc #${event.iteration}] ${qc}`);
      appendLog(
        "orch",
        `[orch #${event.iteration}] ${event.decision.action}: ${event.decision.reason}` +
          (event.decision.workerPrompt
            ? `\n  → worker: ${event.decision.workerPrompt}`
            : ""),
      );
      break;
    }
    case "worker":
      appendLog(
        "worker",
        `[opencode #${event.iteration}]\n${event.summary}` +
          (event.diffSummary ? `\n  diff:\n${event.diffSummary}` : ""),
      );
      break;
    case "progress":
      appendLog("progress", `  · opencode: ${event.message}`);
      break;
    case "approval":
      showApproval(event);
      break;
    case "approval_resolved":
      hideApproval();
      if (event.outcome === "rejected") {
        appendLog("meta", `[you #${event.iteration}] rejected${event.feedback ? `: ${event.feedback}` : ""}`);
      } else if (event.outcome === "edited") {
        appendLog("meta", `[you #${event.iteration}] approved with edits\n  → worker: ${event.workerPrompt}`);
      } else {
        appendLog("meta", `[you #${event.iteration}] approved`);
      }
      break;
    case "error":
      appendLog("err", `[error] ${event.message}`);
      break;
    default:
      appendLog("meta", JSON.stringify(event));
  }
}

function formatQc(qc) {
  if (!qc) return null;
  if (qc.passed) return "QC passed on the previous step";
  const list = qc.violations.length ? qc.violations.map((v) => `\n  ✗ ${v}`).join("") : " (no details)";
  return `QC failed on the previous step:${list}`;
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

const VIEWING_RUN_KEY = "orch.viewingRun";

/** Shows a run's log; the server replays all past events, so this also restores after a refresh. */
function subscribe(runId) {
  closeStream();
  currentRunId = runId;
  localStorage.setItem(VIEWING_RUN_KEY, runId);
  logEl.textContent = "";
  setStatus("starting");
  cancelBtn.disabled = false;
  startBtn.disabled = true;
  refreshRuns();

  eventSource = new EventSource(`/api/runs/${runId}/events`);

  hideApproval();
  for (const type of [
    "status",
    "log",
    "orchestrator",
    "approval",
    "approval_resolved",
    "worker",
    "progress",
    "error",
  ]) {
    eventSource.addEventListener(type, (msg) => {
      // Connection errors also arrive as "error" events, without data.
      if (typeof msg.data !== "string") return;
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch (err) {
        appendLog("err", `Failed to parse event: ${err}`);
        return;
      }
      formatEvent(event);
      if (event.type === "status") refreshRuns();
      if (event.type === "status" && TERMINAL_STATUSES.has(event.status)) {
        // The server ends the stream here; stop the browser from reconnecting and replaying.
        closeStream();
        hideApproval();
        startBtn.disabled = false;
        cancelBtn.disabled = true;
      }
    });
  }
}

const approvalPanelEl = document.getElementById("approval-panel");
const approvalTitleEl = document.getElementById("approval-title");
const approvalReasonEl = document.getElementById("approval-reason");
const approvalPromptLabelEl = document.getElementById("approval-prompt-label");
const approvalPromptEl = document.getElementById("approval-prompt");
const approvalFeedbackEl = document.getElementById("approval-feedback");
const approveBtn = document.getElementById("approve-btn");
const approveAllBtn = document.getElementById("approve-all-btn");
const rejectBtn = document.getElementById("reject-btn");

const APPROVAL_COPY = {
  prompt: {
    title: "Orchestrator wants to send this to OpenCode",
    approve: "Send to OpenCode",
    reject: "Reject and re-plan",
  },
  done: {
    title: "Orchestrator thinks the goal is done",
    approve: "Accept: finish run",
    reject: "Not done: keep going",
  },
  fail: {
    title: "Orchestrator wants to give up",
    approve: "Accept: stop run",
    reject: "Keep trying",
  },
};

function showApproval(event) {
  const { action, reason, workerPrompt } = event.decision;
  const copy = APPROVAL_COPY[action] ?? APPROVAL_COPY.prompt;
  approvalTitleEl.textContent = `Step ${event.iteration}: ${copy.title}`;
  const qc = formatQc(event.decision.qc);
  approvalReasonEl.textContent = `Reason: ${reason}${qc ? `\n\n${qc}` : ""}`;
  approvalPromptLabelEl.hidden = action !== "prompt";
  approvalPromptEl.value = workerPrompt ?? "";
  approvalFeedbackEl.value = "";
  approveBtn.textContent = copy.approve;
  approveAllBtn.hidden = action !== "prompt";
  rejectBtn.textContent = copy.reject;
  setApprovalBusy(false);
  approvalPanelEl.hidden = false;
  approvalPanelEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideApproval() {
  approvalPanelEl.hidden = true;
}

function setApprovalBusy(busy) {
  for (const btn of [approveBtn, approveAllBtn, rejectBtn]) btn.disabled = busy;
}

async function sendApproval(body) {
  if (!currentRunId) return;
  setApprovalBusy(true);
  try {
    const res = await fetch(`/api/runs/${currentRunId}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    refreshRuns();
  } catch (err) {
    setApprovalBusy(false);
    appendLog("err", `Approval failed: ${err instanceof Error ? err.message : err}`);
  }
}

approveBtn.addEventListener("click", () =>
  sendApproval({ action: "approve", workerPrompt: approvalPromptEl.value }),
);
approveAllBtn.addEventListener("click", () =>
  sendApproval({ action: "approve", workerPrompt: approvalPromptEl.value, autoApproveRest: true }),
);
rejectBtn.addEventListener("click", () =>
  sendApproval({ action: "reject", feedback: approvalFeedbackEl.value }),
);

const qcModeEl = document.getElementById("qcMode");
const qcRulesEl = document.getElementById("qcRules");
const qcRulesLabelEl = document.getElementById("qc-rules-label");

function showQcRules() {
  qcRulesLabelEl.hidden = qcModeEl.value !== "on";
}

qcModeEl.value = localStorage.getItem("orch.qcMode") === "on" ? "on" : "off";
qcRulesEl.value = localStorage.getItem("orch.qcRules") ?? "";
showQcRules();
qcModeEl.addEventListener("change", () => {
  localStorage.setItem("orch.qcMode", qcModeEl.value);
  showQcRules();
  if (qcModeEl.value === "on") qcRulesEl.focus();
});
qcRulesEl.addEventListener("input", () => localStorage.setItem("orch.qcRules", qcRulesEl.value));

const stepModeEl = document.getElementById("stepMode");
const runStepToggleEl = document.getElementById("run-step-toggle");
const runStepModeEl = document.getElementById("runStepMode");

stepModeEl.checked = localStorage.getItem("orch.stepMode") === "1";
stepModeEl.addEventListener("change", () =>
  localStorage.setItem("orch.stepMode", stepModeEl.checked ? "1" : "0"),
);

runStepModeEl.addEventListener("change", async () => {
  if (!currentRunId) return;
  try {
    const res = await fetch(`/api/runs/${currentRunId}/step-mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: runStepModeEl.checked }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  } catch (err) {
    runStepModeEl.checked = !runStepModeEl.checked;
    appendLog("err", `Could not change step-by-step mode: ${err instanceof Error ? err.message : err}`);
  }
});

const runsPanelEl = document.getElementById("runs-panel");
const runsListEl = document.getElementById("runs-list");

function formatAge(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

async function refreshRuns() {
  let runs;
  try {
    const res = await fetch("/api/runs");
    runs = (await res.json()).runs;
  } catch {
    return;
  }
  runsPanelEl.hidden = runs.length === 0;
  runsListEl.innerHTML = "";

  const viewed = runs.find((r) => r.id === currentRunId);
  runStepToggleEl.hidden = !viewed?.active;
  if (viewed) runStepModeEl.checked = viewed.stepMode;
  for (const run of runs) {
    const li = document.createElement("li");
    if (run.id === currentRunId) li.classList.add("viewing");

    const status = document.createElement("span");
    status.className = "pill";
    status.textContent = run.status;

    const info = document.createElement("span");
    info.className = "run-info";
    const folder = run.workDir.split("/").filter(Boolean).pop() || run.workDir;
    const elapsed = (run.endedAt ?? Date.now()) - run.startedAt;
    info.title = `${run.workDir}\n${run.goalPreview}`;
    info.innerHTML = "";
    info.append(
      `${folder} — ${run.goalPreview} `,
      Object.assign(document.createElement("span"), {
        className: "run-meta",
        textContent: `· ${run.orchestrator} · iter ${run.iteration} · ${formatAge(elapsed)}`,
      }),
    );

    li.append(status, info);

    if (run.id !== currentRunId) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "ghost";
      view.textContent = "View";
      view.addEventListener("click", () => subscribe(run.id));
      li.append(view);
    }
    if (run.active && run.status !== "cancelling") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ghost";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => cancelRun(run.id));
      li.append(cancel);
    }
    runsListEl.append(li);
  }
}

async function cancelRun(runId) {
  if (runId === currentRunId) {
    cancelBtn.disabled = true;
    setStatus("cancelling");
  }
  try {
    const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  } catch (err) {
    appendLog(
      "err",
      `Cancel failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "If the server is unreachable, check the terminal running npm run dev.",
    );
    if (runId === currentRunId) {
      closeStream();
      setStatus("failed");
    }
  }
  refreshRuns();
}

document.getElementById("clear-log-btn").addEventListener("click", () => {
  logEl.textContent = "";
  const viewingActiveRun = currentRunId && !TERMINAL_STATUSES.has(statusPill.textContent);
  if (viewingActiveRun) return;
  // Finished run: stop viewing it so a refresh doesn't replay its log.
  closeStream();
  hideApproval();
  currentRunId = null;
  localStorage.removeItem(VIEWING_RUN_KEY);
  setStatus("idle");
  refreshRuns();
});

async function restoreViewedRun() {
  const runId = localStorage.getItem(VIEWING_RUN_KEY);
  if (!runId) return;
  try {
    const res = await fetch(`/api/runs/${runId}`);
    if (res.ok) {
      const run = await res.json();
      if (run.status !== "cancelled") {
        subscribe(runId);
        return;
      }
      localStorage.removeItem(VIEWING_RUN_KEY);
      return;
    }
  } catch {
    return;
  }
  localStorage.removeItem(VIEWING_RUN_KEY);
}

restoreViewedRun();
refreshRuns();
setInterval(() => {
  if (!document.hidden) refreshRuns();
}, 3000);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  logEl.textContent = "";
  setStatus("starting");

  const payload = {
    workDir: document.getElementById("workDir").value.trim(),
    goal: document.getElementById("goal").value,
    orchestrator: orchSelectEl.value,
    orchestratorApiKey: orchKeyEl.value.trim(),
    orchestratorModel: orchModelEl.value.trim(),
    maxIterations: Number(document.getElementById("maxIterations").value) || 15,
    opencodeApiKey: opencodeKeyEl.value.trim(),
    opencodeModel: modelEl.value,
    stepMode: stepModeEl.checked,
    qcRules: qcModeEl.value === "on" ? qcRulesEl.value.trim() : "",
  };

  if (qcModeEl.value === "on" && !payload.qcRules) {
    setStatus("failed");
    appendLog("err", "QC rules are on but the rules box is empty. Add rules or set QC rules to Off.");
    return;
  }

  const meta = currentOrchestrator();
  if (meta && !payload.orchestratorApiKey && !meta.hasEnvKey) {
    setStatus("failed");
    appendLog("err", `Enter a ${meta.label} API key (or set ${meta.envKeys.join(" / ")} on the server)`);
    return;
  }
  if (meta && !payload.orchestratorModel && !meta.defaultModel) {
    setStatus("failed");
    appendLog("err", `Choose a ${meta.label} model (click Load models)`);
    return;
  }

  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    subscribe(data.runId);
  } catch (err) {
    setStatus("failed");
    appendLog("err", err instanceof Error ? err.message : String(err));
    startBtn.disabled = false;
    cancelBtn.disabled = true;
  }
});

cancelBtn.addEventListener("click", () => {
  if (currentRunId) cancelRun(currentRunId);
});

loadBtn.addEventListener("click", async () => {
  const workDir = document.getElementById("workDir").value.trim();
  if (!workDir) {
    appendLog("err", "Set a work folder first");
    return;
  }
  try {
    const res = await fetch(`/api/goal?workDir=${encodeURIComponent(workDir)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (!data.goal) {
      appendLog("meta", "No GOAL.md / PROMPT.md found in that folder");
      return;
    }
    document.getElementById("goal").value = data.goal;
    appendLog("meta", `Loaded ${data.file}`);
  } catch (err) {
    appendLog("err", err instanceof Error ? err.message : String(err));
  }
});

async function refreshHealth() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error();
    healthEl.textContent = "Server ok";
  } catch {
    healthEl.textContent = "API unreachable — is the server running?";
  }
}

refreshHealth();
loadOrchestrators();

// Re-enable buttons when a terminal status is logged
const observer = new MutationObserver(() => {
  const s = statusPill.textContent;
  if (s === "done" || s === "failed" || s === "cancelled") {
    startBtn.disabled = false;
    cancelBtn.disabled = true;
  }
});
observer.observe(statusPill, { childList: true, characterData: true, subtree: true });
