const state = {
  entities: [],
  graph: null,
  graphLoaded: false,
  inspection: null,
  githubUrl: "",
  selectedEntity: null,
  selectedModule: null,
  agents: [],
  visibleAgentCount: 48,
  selectedAgent: null,
  neo4jConnected: false,
  sourceGraphWorld: null,
  sourceGraphView: { scale: 1, x: 0, y: 0 },
  agentWorkflowView: { scale: 1, x: 0, y: 0 },
  agentCodeView: { scale: 1, x: 0, y: 0 },
  graphWorld: null,
  graphView: { scale: 1, x: 0, y: 0 },
  treeExpanded: new Set(),
  fileTreeEntries: new Map(),
  inspectionLoaderTimer: null,
  activePage: "overview",
  graphMode: "evidence",
  sourcePath: "",
  timeline: [],
  timelineIndex: 0,
  aiRoom: null,
  aiTimeline: [],
  aiTimelineIndex: 0,
  sourceScrollSyncBound: false,
  githubInsightsLoading: false,
  githubHistoryLoading: false,
  githubContributorsLoading: false,
  fileNodes: [],
  repositoryDocuments: [],
  simulationPayload: null,
  evidenceChainPayload: null,
  evidenceFilter: "all",
  evidenceQuery: "",
  trackCommitLimit: 20,
  aiProviders: [],
  aiSelectedProvider: "",
  aiSelectedModel: "",
  inspectionJobId: "",
  inspectionProgressTimer: null,
  loaderPercent: 0,
};
window.state = state;

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({ error: "Invalid server response" }));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatDate(value, fallback = "Unknown date") {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function formatDateTime(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function displayLanguage(value) {
  if (!value || value === "unknown") return "Unknown";
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function setNotice(id, message = "", kind = "") {
  const element = $(`#${id}`);
  if (!element) return;
  element.textContent = message;
  element.className = `notice ${kind}`.trim();
}

function setGraphState(message, kind = "") {
  const element = $("#graph-state");
  element.className = `graph-state ${kind}`.trim();
  element.hidden = false;
  element.innerHTML = kind === "loading"
    ? `<span class="loading-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`
    : escapeHtml(message);
}

function setDashboardVisible(visible) {
  $("#intake-screen").hidden = visible;
  $("#dashboard-screen").hidden = !visible;
  $("#workspace-tabs").hidden = !visible;
  if (visible) window.scrollTo({ top: 0, behavior: "smooth" });
}

function showWorkspacePage(page, updateHash = true) {
  const available = new Set([...document.querySelectorAll("[data-page-view]")].map((element) => element.dataset.pageView));
  const requested = page === "people" ? "agents" : page === "evidence" ? "track" : page;
  const nextPage = available.has(requested) ? requested : "overview";
  state.activePage = nextPage;
  document.querySelectorAll("[data-page-view]").forEach((view) => {
    const active = view.dataset.pageView === nextPage;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document.querySelectorAll("[data-page]").forEach((tab) => {
    const active = tab.dataset.page === nextPage;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (updateHash && window.location.hash !== `#${nextPage}`) window.history.replaceState(null, "", `#${nextPage}`);
  try {
    if (nextPage === "track") {
      if (typeof loadGithubTimeline === "function") loadGithubTimeline();
      if (state.githubUrl && state.inspection?.github?.history_loaded === false) loadGithubHistory();
    }
    if (nextPage === "settings") checkNeo4j(false);
    if (nextPage === "source") {
      ensureSourceWorkspaceChrome();
      if (state.graphLoaded && typeof renderSourceRelationGraph === "function" && !state.sourceGraphFocus) {
        renderSourceRelationGraph(state.sourcePath || "");
      }
      if (state.graphLoaded && !state.sourcePath && state.repositoryDocuments?.length) {
        const readme = state.repositoryDocuments.find((document) => /^readme(?:\.|$)/i.test(String(document.path || "")));
        if (readme) window.setTimeout(() => loadSource(readme.path), 0);
      }
    }
    if (nextPage === "agents" && typeof renderAgentsPage === "function") {
      renderAgentsPage();
      if (state.githubUrl && state.inspection?.github?.contributors_loaded === false) loadGithubContributors();
    }
    if (nextPage === "track" && state.githubUrl && state.inspection?.github?.history_loaded === false) loadGithubHistory();
    if (nextPage === "track" && state.githubUrl && state.inspection?.github?.insights_loaded === false) loadGithubInsights();
    if (nextPage === "simulation") renderSimulationPage();
    if (nextPage === "compare") renderComparePage();
    if (nextPage === "overview" && typeof window.renderCommitLab === "function") {
      window.renderCommitLab();
    }
  } catch (error) {
    console.error("Error activating page", nextPage, error);
  }
}

const INSPECTION_STAGES = ["metadata", "contributors", "history", "insights", "source", "tree", "analysis"];

function resetInspectionLoader() {
  if (state.inspectionLoaderTimer) window.clearTimeout(state.inspectionLoaderTimer);
  state.inspectionLoaderTimer = null;
  state.loaderPercent = 0;
  document.querySelectorAll("#inspection-stages [data-stage]").forEach((item) => {
    item.className = "";
    const status = item.querySelector(".stage-state");
    if (status) status.textContent = "Queued";
  });
  $("#inspection-loader-progress").style.width = "0%";
  $("#loader-percent").textContent = "0%";
  document.querySelectorAll("[data-loader-stat]").forEach((element) => {
    element.textContent = "0";
    element.classList.remove("is-ticking");
  });
  $("#inspection-loader-title").textContent = "Preparing the workspace";
  $("#inspection-loader-description").textContent = "Mnemo is collecting bounded evidence and arranging it into a readable map.";
  $("#inspection-loader-footnote").textContent = "This can take a moment for a large repository.";
  if ($("#loader-chunks")) $("#loader-chunks").textContent = "Waiting for the first collection…";
}

function animateLoaderNumber(element, target, duration = 760) {
  if (!element) return Promise.resolve();
  const numericTarget = Math.max(0, Math.round(Number(target) || 0));
  const start = performance.now();
  element.classList.remove("is-ticking");
  void element.offsetWidth;
  element.classList.add("is-ticking");
  return new Promise((resolve) => {
    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatNumber(Math.round(numericTarget * eased));
      if (progress < 1) window.requestAnimationFrame(tick);
      else {
        element.textContent = formatNumber(numericTarget);
        element.classList.remove("is-ticking");
        resolve();
      }
    };
    window.requestAnimationFrame(tick);
  });
}

function loaderSnapshotValues(summary = {}, inspection = null, graph = null) {
  const counts = summary.counts || {};
  const analysis = inspection?.analysis?.summary || {};
  const github = inspection?.github || {};
  return {
    files: counts.files ?? analysis.file_count ?? 0,
    commits: counts.commits ?? github.commits?.length ?? 0,
    contributors: counts.contributors ?? github.contributor_count ?? github.contributors?.length ?? 0,
    functions: counts.functions ?? analysis.function_count ?? 0,
    edges: counts.edges ?? graph?.edges?.length ?? 0,
    imports: analysis.import_count ?? 0,
  };
}

async function animateLoaderSnapshot(summary, inspection, graph = null) {
  const values = loaderSnapshotValues(summary, inspection, graph);
  const entries = Object.entries(values);
  await Promise.all(entries.map(([key, value], index) => animateLoaderNumber($(`[data-loader-stat="${key}"]`), value, 620 + index * 65)));
}

function setLoaderPercent(value) {
  const requestedValue = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  // Progress events arrive faster than an animation frame. Animating every
  // event lets an older 0–40% animation finish after a newer one and overwrite
  // the real value. The bar is CSS-transitioned; the number stays monotonic.
  const numericValue = Math.max(state.loaderPercent || 0, requestedValue);
  state.loaderPercent = numericValue;
  const progress = $("#inspection-loader-progress");
  const label = $("#loader-percent");
  if (progress) progress.style.width = `${numericValue}%`;
  if (label) label.textContent = `${numericValue}%`;
}

function setInspectionStage(stageKey, title, description) {
  const activeIndex = Math.max(0, INSPECTION_STAGES.indexOf(stageKey));
  document.querySelectorAll("#inspection-stages [data-stage]").forEach((item) => {
    const index = INSPECTION_STAGES.indexOf(item.dataset.stage);
    const status = item.querySelector(".stage-state");
    item.className = index < activeIndex ? "complete" : index === activeIndex ? "active" : "";
    if (status) status.textContent = index < activeIndex ? "Complete" : index === activeIndex ? "Working" : "Queued";
  });
  setLoaderPercent(Math.round((activeIndex / INSPECTION_STAGES.length) * 100));
  $("#inspection-loader-title").textContent = title;
  $("#inspection-loader-description").textContent = description;
}

function updateInspectionLoader(progress = {}) {
  const percent = Number(progress.percent);
  if (Number.isFinite(percent)) setLoaderPercent(percent);
  const counts = progress.counts || {};
  const collections = progress.collections || {};
  const values = {
    files: counts.files,
    commits: counts.commits ?? collections.commits,
    contributors: counts.contributors ?? collections.contributors,
    functions: counts.functions,
    edges: counts.edges,
    imports: counts.imports,
  };
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    const element = $(`[data-loader-stat="${key}"]`);
    if (element) element.textContent = formatNumber(value);
  });
  if (progress.message) $("#inspection-loader-description").textContent = progress.message;
  const requests = progress.requests || {};
  const requestLabel = requests.total
    ? `${formatNumber(requests.completed || 0)} of ${formatNumber(requests.total)} collection requests returned`
    : "Preparing segmented collection requests…";
  const stageLabel = progress.stage ? ` · ${progress.stage}` : "";
  $("#inspection-loader-footnote").textContent = `${requestLabel}${stageLabel}`;
  const chunkLabels = {
    metadata: "Repository metadata",
    contributors: "Contributors",
    history: "History and discussions",
    insights: "Analytics and Actions",
    source: "Source and symbols",
    tree: "File tree",
    analysis: "Architecture analysis",
  };
  const chunks = (progress.chunks || []).map((chunk) => chunkLabels[chunk] || chunk);
  if ($("#loader-chunks")) {
    $("#loader-chunks").innerHTML = chunks.length
      ? chunks.map((chunk) => `<span class="loader-chunk"><b>✓</b>${escapeHtml(chunk)}</span>`).join("")
      : "Waiting for the first collection…";
  }
  const segments = new Map((progress.segments || []).map((segment) => [segment.key, segment]));
  document.querySelectorAll("#inspection-stages [data-stage]").forEach((item) => {
    const segment = segments.get(item.dataset.stage);
    if (!segment) return;
    const status = segment.status || "queued";
    item.className = status === "complete" ? "complete" : status === "active" ? "active" : status === "deferred" ? "deferred" : "";
    const stateLabel = item.querySelector(".stage-state");
    if (stateLabel) stateLabel.textContent = status === "complete" ? "Complete" : status === "active" ? "Working" : status === "deferred" ? "Deferred" : status === "error" ? "Error" : "Queued";
  });
  const activeSegment = segments.get(progress.stage);
  const stageTitles = {
    contributors: "Collecting contributor history",
    history: "Collecting history and discussions",
    insights: "Collecting analytics and Actions",
    checkout: "Refreshing the local checkout",
    source: "Indexing source files",
    tree: "Arranging the file tree",
    analysis: "Finishing architecture analysis",
  };
  $("#inspection-loader-title").textContent = activeSegment?.label || stageTitles[progress.stage] || (progress.status === "complete" ? "Workspace ready" : "Collecting repository evidence");
}

async function waitForInspectionJob(jobId) {
  state.inspectionJobId = jobId;
  return new Promise((resolve, reject) => {
    let settled = false;
    let polling = false;
    let eventSource = null;
    let socket = null;
    let pollTimer = null;
    const closeStreams = () => {
      eventSource?.close();
      socket?.close();
      if (pollTimer) window.clearTimeout(pollTimer);
    };
    const finish = async (payload = null) => {
      if (settled) return;
      settled = true;
      closeStreams();
      state.inspectionJobId = "";
      try {
        resolve(payload || await api(`/api/github/progress?job_id=${encodeURIComponent(jobId)}`));
      } catch (error) {
        reject(error);
      }
    };
    const handleRecord = (record) => {
      if (settled || state.inspectionJobId !== jobId) return;
      updateInspectionLoader(record.progress || {});
      const isJobTerminal = record.event === "job" && (record.data?.status === "complete" || record.data?.status === "error");
      if (record.status === "error" || (isJobTerminal && record.data?.status === "error")) {
        settled = true;
        closeStreams();
        state.inspectionJobId = "";
        reject(new Error(record.data?.message || "Segmented inspection failed."));
      } else if (record.status === "complete" || (isJobTerminal && record.data?.status === "complete")) {
        finish();
      }
    };
    const handleMessage = (message) => {
      try { handleRecord(JSON.parse(message.data)); } catch (error) { console.warn("Invalid inspection progress event", error); }
    };
    const startPolling = () => {
      if (polling || settled) return;
      polling = true;
      const poll = async () => {
        if (settled) return;
        try {
          const payload = await api(`/api/github/progress?job_id=${encodeURIComponent(jobId)}`);
          updateInspectionLoader(payload.progress || {});
          if (payload.status === "complete") return finish(payload);
          if (payload.status === "error") {
            settled = true;
            closeStreams();
            state.inspectionJobId = "";
            return reject(new Error(payload.error || "Segmented inspection failed."));
          }
          pollTimer = window.setTimeout(poll, 240);
        } catch (error) {
          settled = true;
          closeStreams();
          state.inspectionJobId = "";
          reject(error);
        }
      };
      poll();
    };
    if (window.EventSource) {
      eventSource = new EventSource(`/api/github/progress/stream?job_id=${encodeURIComponent(jobId)}`);
      ["job", "stage", "collection", "requests", "progress", "message"].forEach((type) => eventSource.addEventListener(type, handleMessage));
      eventSource.onerror = () => {
        if (settled) return;
        eventSource?.close();
        if (window.WebSocket) {
          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          try {
            socket = new WebSocket(`${protocol}//${window.location.host}/api/github/progress/ws?job_id=${encodeURIComponent(jobId)}`);
            socket.onmessage = handleMessage;
            socket.onerror = () => { socket?.close(); startPolling(); };
            socket.onclose = () => { if (!settled) startPolling(); };
          } catch (_error) {
            startPolling();
          }
        } else {
          startPolling();
        }
      };
    } else {
      startPolling();
    }
  });
}

function completeInspectionStagesThrough(stageKey) {
  const completedIndex = INSPECTION_STAGES.indexOf(stageKey);
  document.querySelectorAll("#inspection-stages [data-stage]").forEach((item) => {
    const index = INSPECTION_STAGES.indexOf(item.dataset.stage);
    if (index <= completedIndex) {
      item.className = "complete";
      const status = item.querySelector(".stage-state");
      if (status) status.textContent = "Complete";
    }
  });
  setLoaderPercent(Math.round(((completedIndex + 1) / INSPECTION_STAGES.length) * 100));
}

function beginInspectionLoading() {
  resetInspectionLoader();
  state.treeExpanded = new Set();
  state.fileTreeEntries = new Map();
  state.fileNodes = [];
  state.repositoryDocuments = [];
  $("#inspection-loader").hidden = false;
  document.body.classList.add("is-inspecting");
  setInspectionStage("metadata", "Reading repository metadata", "Fetching the bounded GitHub snapshot and repository identity.");
}

function finishInspectionLoading(deferredStages = []) {
  document.querySelectorAll("#inspection-stages [data-stage]").forEach((item) => {
    item.className = "complete";
    const status = item.querySelector(".stage-state");
    if (status) status.textContent = "Complete";
  });
  deferredStages.forEach((stageKey) => {
    const item = document.querySelector(`#inspection-stages [data-stage="${stageKey}"]`);
    if (!item) return;
    item.className = "deferred";
    const status = item.querySelector(".stage-state");
    if (status) status.textContent = "Deferred";
  });
  setLoaderPercent(100);
  $("#inspection-loader-title").textContent = "Workspace ready";
  $("#inspection-loader-description").textContent = "The repository map is ready to explore.";
  $("#inspection-loader-footnote").textContent = "Opening the architecture workspace…";
  state.inspectionLoaderTimer = window.setTimeout(() => {
    $("#inspection-loader").hidden = true;
    document.body.classList.remove("is-inspecting");
    state.inspectionLoaderTimer = null;
  }, 420);
}

function failInspectionLoading(message) {
  if (state.inspectionLoaderTimer) window.clearTimeout(state.inspectionLoaderTimer);
  state.inspectionLoaderTimer = null;
  $("#inspection-loader-title").textContent = "Inspection paused";
  $("#inspection-loader-description").textContent = message;
  $("#inspection-loader-footnote").textContent = "Return to the search field and try again.";
  $("#inspection-loader").hidden = false;
  document.body.classList.add("is-inspecting");
  state.inspectionLoaderTimer = window.setTimeout(() => {
    $("#inspection-loader").hidden = true;
    document.body.classList.remove("is-inspecting");
    state.inspectionLoaderTimer = null;
  }, 1400);
}

function canonicalGithubUrl(value) {
  const raw = String(value || "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\.git\/?$/, "").replace(/\/$/, "");
  const parts = raw.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "github.com") parts.shift();
  if (parts.length < 2) return "";
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

function githubParts(value) {
  const canonical = canonicalGithubUrl(value);
  if (!canonical) return null;
  const parts = new URL(canonical).pathname.split("/").filter(Boolean);
  return { owner: parts[0], repo: parts[1], url: canonical };
}

function entityLabel(entity) {
  return entity.label || entity.labels?.find((label) => ["Repository", "File", "Function", "Class", "ConfigKey", "Commit", "Contributor", "Decision"].includes(label)) || "Entity";
}

function entityTitle(entity) {
  return entity.name || entity.path || entity.file_path || entity.signature || entity.message || entity.display_name || entity.username || entity.login || entity.id || "Entity";
}

function entityPath(entity) {
  return entity.path || entity.file_path || "";
}

function graphNodeType(node) {
  return node.labels?.find((label) => ["Repository", "File", "Function", "Class", "ConfigKey", "Commit", "Contributor", "Decision", "Module", "PullRequest", "Issue", "Branch"].includes(label)) || "Entity";
}

function svgElement(name, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    element.setAttribute(key, String(value));
  });
  return element;
}

function toggleFullscreen(element) {
  if (!element) return;
  if (document.fullscreenElement) {
    document.exitFullscreen?.().catch(() => {});
    return;
  }
  element.requestFullscreen?.().catch(() => {});
}

function aiProviderEntries(status) {
  const available = status?.available_providers || [];
  if (available.length) {
    return available.map((provider) => ({
      name: provider.name,
      model: provider.model,
      configured: provider.configured !== false,
    }));
  }
  return (status?.providers || []).map((provider) => ({ name: provider.name, model: provider.model, configured: true }));
}

function renderProviders(status) {
  const providers = aiProviderEntries(status);
  state.aiProviders = providers;
  [$("#ai-provider"), $("#ai-room-provider")].filter(Boolean).forEach((select) => {
    const current = select.value;
    select.innerHTML = '<option value="">Auto provider</option>';
    providers.forEach((provider) => {
      const option = document.createElement("option");
      option.value = provider.name;
      option.textContent = provider.name;
      select.appendChild(option);
    });
    if (current && providers.some((provider) => provider.name === current)) select.value = current;
  });
  $("#provider-label")?.remove();
}

let stateAiCatalog = null;

function renderAiModelSelects(catalog, providerFilter = null) {
  const models = catalog?.models || [];
  const pairs = [
    { model: $("#ai-room-model"), provider: $("#ai-room-provider") },
    { model: $("#ai-model"), provider: $("#ai-provider") },
  ].filter((pair) => pair.model);
  pairs.forEach(({ model: select, provider: providerSelect }) => {
    const provider = providerFilter == null ? (providerSelect?.value || "") : providerFilter;
    const scoped = provider ? models.filter((entry) => entry.provider === provider) : models;
    const current = select.value;
    select.innerHTML = '<option value="">Auto model</option>';
    const grouped = new Map();
    scoped.forEach((entry) => {
      if (!grouped.has(entry.provider)) grouped.set(entry.provider, []);
      grouped.get(entry.provider).push(entry);
    });
    grouped.forEach((entries, name) => {
      const group = document.createElement("optgroup");
      group.label = name;
      entries.forEach((entry) => {
        const option = document.createElement("option");
        option.value = entry.model;
        option.dataset.provider = name;
        option.textContent = entry.model;
        group.appendChild(option);
      });
      select.appendChild(group);
    });
    const keep = [...select.options].find((option) => option.value === current && (!provider || option.dataset.provider === provider));
    if (keep) select.value = current;
  });
}

function aiProviderConfigured(name) {
  const entry = (state.aiProviders || []).find((provider) => provider.name === name);
  return entry ? entry.configured !== false : true;
}

function aiCatalogScope() {
  const all = stateAiCatalog?.models || [];
  const provider = state.aiSelectedProvider || "";
  return { all, provider, scoped: provider ? all.filter((entry) => entry.provider === provider) : all };
}

function aiCatalogRow(entry) {
  const selected = state.aiSelectedProvider === entry.provider && state.aiSelectedModel === entry.model;
  const needsKey = entry.configured === false;
  const tier = entry.is_free ? "FREE" : "CATALOG";
  return `<button class="ai-catalog-row${selected ? " selected" : ""}${needsKey ? " is-unconfigured" : ""}" type="button" data-ai-catalog-provider="${escapeHtml(entry.provider)}" data-ai-catalog-model="${escapeHtml(entry.model)}"><span class="ai-catalog-tier${entry.is_free ? " free" : ""}">${tier}</span><span class="ai-catalog-provider">${escapeHtml(entry.provider)}</span><span class="ai-catalog-model">${escapeHtml(entry.model)}</span><span class="ai-catalog-note">${escapeHtml(entry.note || "provider catalog")}${needsKey ? " · add API key" : ""}</span></button>`;
}

function bindAiCatalogRows(host) {
  if (!host) return;
  host.querySelectorAll("[data-ai-catalog-model]").forEach((button) => {
    button.addEventListener("click", () => selectAiModel(button.dataset.aiCatalogProvider, button.dataset.aiCatalogModel));
  });
}

function aiCatalogEmptyMarkup(all, provider) {
  return all.length
    ? `<div class="ai-catalog-empty">No free models are listed for ${escapeHtml(provider)}.</div>`
    : '<div class="ai-catalog-empty">No catalog information is available from the local server.</div>';
}

function renderAiCatalogList() {
  const panel = document.getElementById("ai-catalog-list");
  if (!panel) return;
  const { all, provider, scoped } = aiCatalogScope();
  const note = document.getElementById("ai-catalog-note");
  if (note) {
    note.textContent = !all.length
      ? "The local server returned no model catalog."
      : provider
        ? `${provider} · ${formatNumber(scoped.length)} free model${scoped.length === 1 ? "" : "s"} · ${aiProviderConfigured(provider) ? "API key ready" : "add API key to run"}`
        : `${formatNumber(all.length)} free models across ${formatNumber(new Set(all.map((entry) => entry.provider)).size)} providers · filter with a provider select`;
  }
  // Render scoped models (filtered by selected provider) or all models if no provider selected
  const modelsToShow = provider ? scoped : all;
  panel.innerHTML = modelsToShow.length ? modelsToShow.map(aiCatalogRow).join("") : aiCatalogEmptyMarkup(all, provider);
  bindAiCatalogRows(panel);
}

function renderAiProviderPills() {
  const host = document.getElementById("ai-room-catalog-providers");
  if (!host) return;
  const all = stateAiCatalog?.models || [];
  const providers = [...new Set(all.map((entry) => entry.provider))];
  const pills = [
    `<button class="ai-provider-pill${state.aiSelectedProvider ? "" : " active"}" type="button" data-ai-provider-pill=""><span>All providers</span><strong>${formatNumber(all.length)}</strong></button>`,
    ...providers.map((name) => {
      const count = all.filter((entry) => entry.provider === name).length;
      const configured = aiProviderConfigured(name);
      return `<button class="ai-provider-pill${state.aiSelectedProvider === name ? " active" : ""}${configured ? "" : " is-unconfigured"}" type="button" data-ai-provider-pill="${escapeHtml(name)}"><span>${escapeHtml(name)}</span><strong>${formatNumber(count)}</strong><em>${configured ? "key ready" : "add key"}</em></button>`;
    }),
  ];
  host.innerHTML = pills.join("");
  host.querySelectorAll("[data-ai-provider-pill]").forEach((button) => {
    button.addEventListener("click", () => selectAiProvider(button.dataset.aiProviderPill || ""));
  });
}

function renderAiRoomCatalog() {
  const host = document.getElementById("ai-room-catalog-list");
  if (!host) return;
  const { all, provider, scoped } = aiCatalogScope();
  renderAiProviderPills();
  const note = document.getElementById("ai-room-catalog-note");
  if (note) {
    note.textContent = !all.length
      ? "Waiting for the local model catalog."
      : provider
        ? `${provider} · ${formatNumber(scoped.length)} free model${scoped.length === 1 ? "" : "s"}${aiProviderConfigured(provider) ? "" : " · add an API key to run it"}`
        : `${formatNumber(all.length)} free models from ${formatNumber(new Set(all.map((entry) => entry.provider)).size)} providers · pick a provider to narrow the list`;
  }
  // Render all models if no provider selected, otherwise render scoped (filtered) models
  const modelsToShow = provider ? scoped : all;
  host.innerHTML = modelsToShow.length ? modelsToShow.map(aiCatalogRow).join("") : aiCatalogEmptyMarkup(all, provider);
  bindAiCatalogRows(host);
}

function selectAiProvider(provider) {
  state.aiSelectedProvider = provider;
  state.aiSelectedModel = "";
  ["#ai-provider", "#ai-room-provider"].forEach((selector) => { if ($(selector)) $(selector).value = provider; });
  ["#ai-model", "#ai-room-model"].forEach((selector) => { if ($(selector)) $(selector).value = ""; });
  renderAiModelSelects(stateAiCatalog, provider);
  renderAiCatalogList();
  renderAiRoomCatalog();
}

function selectAiModel(provider, model) {
  state.aiSelectedProvider = provider;
  state.aiSelectedModel = model;
  ["#ai-provider", "#ai-room-provider"].forEach((selector) => { if ($(selector)) $(selector).value = provider; });
  renderAiModelSelects(stateAiCatalog, provider);
  ["#ai-model", "#ai-room-model"].forEach((selector) => { if ($(selector)) $(selector).value = model; });
  renderAiCatalogList();
  renderAiRoomCatalog();
  if ($("#ai-room-notice")) {
    if (provider && !aiProviderConfigured(provider)) {
      setNotice("ai-room-notice", `${provider} has no API key in this environment. ${model} can stay selected, but answers fall back to deterministic evidence until the key is added.`, "error");
    } else if (provider) {
      setNotice("ai-room-notice", `${provider} · ${model} is ready for the next question.`, "success");
    }
  }
}

function renderAiCatalog(catalog) {
  stateAiCatalog = catalog;
  renderAiModelSelects(catalog);
  renderAiCatalogList();
  renderAiRoomCatalog();
  renderAiConnectionStatus(catalog);
}

function renderAiConnectionStatus(catalog) {
  const host = document.getElementById("settings-ai-providers");
  const dot = document.getElementById("settings-ai-dot");
  const label = document.getElementById("settings-ai-label");
  if (!host || !label) return;
  const providers = catalog?.providers || [];
  const models = catalog?.models || [];
  const configured = providers.length;
  label.textContent = configured
    ? `${formatNumber(configured)} provider${configured === 1 ? "" : "s"} queried · ${formatNumber(models.length)} models returned`
    : "No AI provider key configured";
  if (dot) dot.className = `status-dot ${configured ? "ready" : ""}`.trim();
  host.innerHTML = providers.length
    ? providers.map((provider) => `<div class="ai-connection-row"><span class="ai-connection-dot ${provider.error ? "error" : "ready"}"></span><span><strong>${escapeHtml(provider.name)}</strong><small>${provider.error ? escapeHtml(provider.error) : `${formatNumber(provider.model_count || 0)} models · ${formatNumber(provider.free_count || 0)} marked free`}</small></span></div>`).join("")
    : '<div class="empty-state">Add a provider API key to fetch its live model catalog.</div>';
}

async function refreshAiCatalog() {
  const buttons = [$("#ai-catalog-refresh"), $("#settings-ai-refresh")].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; button.textContent = "Refreshing…"; });
  try {
    const catalog = await api("/api/ai/catalog?refresh=1");
    renderAiCatalog(catalog);
  } catch (error) {
    setNotice("ai-room-notice", `Model catalog refresh failed: ${error.message}`, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; button.textContent = button.id === "settings-ai-refresh" ? "Refresh provider catalog" : "Refresh models"; });
  }
}

function renderNeo4jStatus(status) {
  const dot = $("#neo4j-dot");
  const label = $("#neo4j-label");
  state.neo4jConnected = Boolean(status?.connected);
  const stateClass = status?.connected ? "ready" : status?.configured ? "" : "error";
  const labelText = !status?.configured
    ? "Neo4j: not configured"
    : status.connected
      ? `Neo4j: connected · ${status.database || "database"}`
      : "Neo4j: unavailable";
  if (dot) dot.className = `status-dot ${stateClass}`.trim();
  if (label) label.textContent = labelText;
  const settingsDot = $("#settings-neo4j-dot");
  const settingsLabel = $("#settings-neo4j-label");
  if (settingsDot) settingsDot.className = `status-dot ${stateClass}`.trim();
  if (settingsLabel) settingsLabel.textContent = labelText.replace(/^Neo4j:\s*/, "");
  [$("#neo4j-sync-button"), $("#settings-neo4j-sync")].filter(Boolean).forEach((button) => {
    button.disabled = !state.graphLoaded || !state.neo4jConnected;
  });
}

async function checkNeo4j(showNotice = false) {
  const buttons = [$("#neo4j-check-button"), $("#settings-neo4j-check")].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; button.textContent = "Checking…"; });
  try {
    const status = await api("/api/neo4j/status?check=1");
    renderNeo4jStatus(status);
    if (showNotice) {
      const message = status.connected ? "Neo4j connection is healthy." : status.error || "Neo4j is not reachable.";
      setNotice("ingest-notice", message, status.connected ? "success" : "error");
      setNotice("settings-notice", message, status.connected ? "success" : "error");
    }
    return status;
  } catch (error) {
    renderNeo4jStatus({ configured: false, connected: false });
    if (showNotice) {
      setNotice("ingest-notice", error.message, "error");
      setNotice("settings-notice", error.message, "error");
    }
    return null;
  } finally {
    buttons.forEach((button) => { button.disabled = false; button.textContent = button.id === "settings-neo4j-check" ? "Check connection" : "Check"; });
  }
}

async function syncNeo4j() {
  if (!state.graphLoaded) {
    setNotice("ingest-notice", "Inspect a repository before syncing Neo4j.", "error");
    return;
  }
  const buttons = [$("#neo4j-sync-button"), $("#settings-neo4j-sync")].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; button.textContent = "Syncing…"; });
  setNotice("ingest-notice", "Sending the local graph to Neo4j…");
  setNotice("settings-notice", "Sending the local graph to Neo4j…");
  try {
    const payload = await api("/api/neo4j/sync", { method: "POST", body: JSON.stringify({}) });
    renderNeo4jStatus(payload.connection);
    const message = `Neo4j synced ${formatNumber(payload.sync.nodes_synced)} nodes and ${formatNumber(payload.sync.edges_synced)} relationships.`;
    setNotice("ingest-notice", message, "success");
    setNotice("settings-notice", message, "success");
  } catch (error) {
    await checkNeo4j(false);
    setNotice("ingest-notice", error.message, "error");
    setNotice("settings-notice", error.message, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = !state.graphLoaded || !state.neo4jConnected; button.textContent = button.id === "settings-neo4j-sync" ? "Sync current graph" : "Sync graph"; });
  }
}

function setGraphAvailability(available) {
  ["#entity-search", "#entity-filter", "#refresh-entities"].forEach((selector) => { const element = $(selector); if (element) element.disabled = !available; });
  [$("#neo4j-sync-button"), $("#settings-neo4j-sync")].filter(Boolean).forEach((button) => {
    button.disabled = !available || !state.neo4jConnected;
  });
}

function setStatsLoading() {
  document.querySelectorAll("[data-metric]").forEach((element) => { element.textContent = "…"; });
}

function updateMetric(name, value) {
  const element = $(`[data-metric="${name}"]`);
  if (element) element.textContent = formatNumber(value);
}

function renderRepoOverview(inspection, summary = {}) {
  const github = inspection?.github || {};
  const metadata = github.repository || inspection?.repository || summary.repository || {};
  const githubRepo = githubParts(metadata.html_url || metadata.url || inspection?.repository?.url || state.githubUrl);
  const name = metadata.full_name || inspection?.repository?.full_name || metadata.name || summary.repository?.name || "Local repository";
  const description = metadata.description || (inspection ? "A bounded GitHub snapshot with deterministic source and history analysis." : "Loaded from a local Git checkout.");
  const branch = metadata.default_branch || summary.repository?.default_branch || "Detached HEAD";
  const url = metadata.html_url || metadata.url || githubRepo?.url || summary.repository?.url || "";
  $("#repo-name").textContent = name;
  $("#repo-description").textContent = description;
  $("#workspace-title").textContent = name;
  $("#workspace-subtitle").textContent = inspection ? "A bounded snapshot of structure, history, people, and decisions." : "A local graph snapshot ready to explore.";
  $("#repo-branch").textContent = branch;
  const rateLimited = Boolean(github.errors?.github_rate_limit);
  $("#repo-snapshot-value").textContent = inspection ? rateLimited ? "Local + rate limited" : "GitHub ready" : "Local ready";
  $("#repo-snapshot-detail").textContent = inspection
    ? rateLimited ? "checkout + local history ready · API token needed" : "metadata + graph + source evidence"
    : "graph + source evidence";
  const githubLink = $("#github-link");
  githubLink.hidden = !url || !url.includes("github.com");
  githubLink.href = url || "#";
  const topics = metadata.topics || [];
  $("#topic-row").innerHTML = topics.length ? topics.slice(0, 8).map((topic) => `<span class="topic">#${escapeHtml(topic)}</span>`).join("") : '<span class="topic">public repository</span>';
  const facts = [
    ["Default branch", branch],
    ["License", metadata.license?.spdx_id || metadata.license?.name || "Not declared"],
    ["Stars", metadata.stargazers_count == null ? "—" : formatNumber(metadata.stargazers_count)],
    ["Last pushed", formatDate(metadata.pushed_at || metadata.updated_at, "Unknown")],
  ];
  $("#repo-facts").innerHTML = facts.map(([label, value]) => `<div class="repo-fact"><strong>${escapeHtml(label)}</strong><span title="${escapeHtml(value)}">${escapeHtml(value)}</span></div>`).join("");
  renderExternalLenses(githubRepo?.url || state.githubUrl);
}

function renderExternalLenses(repositoryUrl) {
  // The canonical source link is already available in the repository header.
  // Keep this row empty rather than naming or proxying third-party viewers.
  void repositoryUrl;
  $("#lens-row").innerHTML = "";
}

function renderMetadata(inspection, summary = {}) {
  const github = inspection?.github || {};
  const counts = summary.counts || {};
  const graphFiles = (state.graph?.nodes || []).filter((node) => graphNodeType(node) === "File").length;
  updateMetric("files", counts.files ?? graphFiles);
  updateMetric("functions", (counts.functions || 0) + (counts.classes || 0));
  updateMetric("commits", github.commits?.length ?? counts.commits ?? 0);
  updateMetric("pulls", github.pull_requests?.length ?? 0);
  updateMetric("issues", github.issues?.length ?? 0);
  updateMetric("releases", github.releases?.length ?? 0);
  updateMetric("contributors", Math.max(github.contributor_count || 0, github.contributors?.length || 0, counts.contributors || 0));
  const contributorMetric = document.querySelector('[data-metric="contributors"]');
  if (contributorMetric && github.errors?.contributors) {
    contributorMetric.parentElement.querySelector("small").textContent = "partial API list · local Git fallback";
  }
  const pullSummary = github.pull_request_summary || {};
  updateMetric("merges", pullSummary.merged ?? (github.pull_requests || []).filter((pull) => pull.merged_at).length);
  updateMetric("deployments", github.deployments?.length ?? 0);
  updateMetric("packages", github.packages?.length ?? 0);
  const pullMetric = document.querySelector('[data-metric="pulls"]');
  if (pullMetric && pullSummary.merged != null) {
    pullMetric.parentElement.querySelector("small").textContent = `${formatNumber(pullSummary.merged)} merged · ${formatNumber(pullSummary.feature_like || 0)} feature-like`;
  }
  const githubErrors = Object.keys(github.errors || {});
  $("#metadata-note").textContent = inspection
    ? github.errors?.github_rate_limit
      ? "GitHub API rate limited · local checkout and history still available"
      : githubErrors.length
        ? `Partial GitHub snapshot · ${githubErrors.length} endpoint${githubErrors.length === 1 ? "" : "s"} unavailable`
       : github.history_status === "partial"
         ? "Core snapshot ready · partial GitHub history"
       : github.history_loaded === false
         ? `Core snapshot ready · full history deferred`
         : `Fresh checkout + API snapshot · ${formatDateTime(inspection.freshness?.inspected_at || new Date().toISOString())}`
    : "Local graph snapshot";
}

function renderLanguages(inspection) {
  const languages = inspection?.github?.languages || {};
  const entries = Object.entries(languages).sort((a, b) => Number(b[1]) - Number(a[1]));
  const total = entries.reduce((sum, [, bytes]) => sum + (Number(bytes) || 0), 0);
  if ($("#language-count")) $("#language-count").textContent = entries.length ? `${entries.length} detected` : "None detected";
  if ($("#language-list")) {
    $("#language-list").innerHTML = entries.length
      ? entries.slice(0, 7).map(([name, bytes]) => {
        const share = total ? Math.max(1, Math.round((Number(bytes) / total) * 100)) : 0;
        return `<div class="language-row"><span class="language-name">${escapeHtml(name)}</span><span class="language-bar"><span style="width:${share}%"></span></span><span class="language-share">${share}%</span></div>`;
      }).join("")
      : '<div class="empty-state">GitHub did not return language statistics for this snapshot.</div>';
  }
}

function dependencyEntries(inspection) {
  const manifests = inspection?.analysis?.dependency_manifests || [];
  const result = [];
  const seen = new Set();
  manifests.forEach((manifest) => {
    (manifest.dependencies || []).forEach((dependency) => {
      const key = `${dependency.name}:${dependency.spec || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ ...dependency, manifest: manifest.path });
    });
  });
  return result;
}

function renderDependencies(inspection) {
  const analysis = inspection?.analysis;
  const dependencies = dependencyEntries(inspection);
  const count = analysis?.summary?.dependency_count ?? dependencies.length;
  if ($("#dependency-count")) $("#dependency-count").textContent = `${formatNumber(count)} declared`;
  if ($("#dependency-list")) {
    $("#dependency-list").innerHTML = dependencies.length
      ? dependencies.slice(0, 18).map((dependency) => `<span class="dependency-chip" title="${escapeHtml(dependency.manifest || "manifest")}">${escapeHtml(dependency.name)}${dependency.spec ? ` <small>${escapeHtml(dependency.spec)}</small>` : ""}</span>`).join("")
      : '<div class="empty-state">No supported dependency manifest was found.</div>';
  }
}

function jumpToGitTrackCommit(sha) {
  if (!sha) return;
  showWorkspacePage("track");
  const index = (state.timeline || []).findIndex((commit) => (commit.sha || "") === sha);
  if (index >= 0) {
    state.timelineIndex = index;
    renderTimelineDetail(index);
    const slider = $("#timeline-slider");
    if (slider) slider.value = String(index);
    $("#timeline-detail")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function renderOverviewActivity() {
  const host = $("#overview-activity");
  const note = $("#overview-activity-note");
  if (!host) return;
  const nodes = state.graph?.nodes || [];
  const edges = state.graph?.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let commits = nodes
    .filter((node) => graphNodeType(node) === "Commit")
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(0, 10);
  if (!commits.length && state.inspection?.github?.commits?.length) {
    commits = state.inspection.github.commits.slice(0, 10).map((c) => ({
      id: `commit:${c.sha}`,
      sha: c.sha,
      message: c.message || c.commit?.message,
      timestamp: c.timestamp || c.commit?.author?.date,
      author_email: c.author?.login || c.commit?.author?.name,
    }));
  }
  if (!commits.length) {
    host.innerHTML = `<div class="empty-state">${state.graphLoaded ? "No local commits were recorded in this snapshot." : "Inspect a repository to list its latest commits."}</div>`;
    if (note) note.textContent = state.graphLoaded ? "No commits" : "Waiting for a snapshot";
    return;
  }
  const authorOf = new Map(edges.filter((edge) => edge.type === "AUTHORED").map((edge) => [edge.target, edge.source]));
  const modifiedByCommit = new Map();
  edges.filter((edge) => edge.type === "MODIFIED").forEach((edge) => {
    const target = byId.get(edge.target);
    if (!target || !["File", "Function", "Class", "ConfigKey"].includes(graphNodeType(target))) return;
    if (!modifiedByCommit.has(edge.source)) modifiedByCommit.set(edge.source, new Set());
    modifiedByCommit.get(edge.source).add(edge.target);
  });
  host.innerHTML = commits.map((commit, index) => {
    const author = byId.get(authorOf.get(commit.id)) || {};
    const files = modifiedByCommit.get(commit.id)?.size || 0;
    const isFirst = index === 0;
    return `<button class="overview-commit ${isFirst ? "is-first" : ""}" type="button" data-overview-sha="${escapeHtml(commit.sha || "")}"><span class="overview-commit-rail" aria-hidden="true"><i></i></span><span class="overview-commit-body"><strong>${escapeHtml(commit.message || "Repository change")}</strong><small>${escapeHtml(author.display_name || author.username || commit.author_email || "Unknown contributor")} · ${escapeHtml(formatDate(commit.timestamp))}</small></span><span class="overview-commit-meta"><code>${escapeHtml(String(commit.sha || "").slice(0, 7) || "no-sha")}</code><span>${formatNumber(files)} file${files === 1 ? "" : "s"}</span></span></button>`;
  }).join("");
  host.querySelectorAll("[data-overview-sha]").forEach((button) => {
    button.addEventListener("click", () => jumpToGitTrackCommit(button.dataset.overviewSha));
  });
  if (note) note.textContent = `${formatNumber(commits.length)} most recent commits · click to inspect`;
}

function renderOverviewCoverage(inspection, summary = {}) {
  const host = $("#overview-coverage");
  const note = $("#overview-coverage-note");
  if (!host) return;
  const counts = summary.counts || {};
  const ingestion = summary.ingestion || {};
  const github = inspection?.github || {};
  const apiErrors = Object.keys(github.errors || {}).length;
  const rateLimited = Boolean(github.errors?.github_rate_limit);
  const lastInspected = inspection?.freshness?.inspected_at || summary.loaded_at || "";
  const coverage = summary.evidence_coverage;
  const apiState = !state.githubUrl
    ? "Local checkout"
    : rateLimited
      ? "Rate limited"
      : apiErrors
        ? `${apiErrors} endpoint${apiErrors === 1 ? "" : "s"} partial`
        : "Snapshot ready";
  const rows = [
    ["Source files", counts.files ?? ingestion.tracked_files ?? 0, `${formatNumber(counts.functions || 0)} functions · ${formatNumber(counts.classes || 0)} classes`],
    ["Relationships", counts.edges ?? 0, `${formatNumber(counts.decisions || 0)} decisions · ${formatNumber(counts.config_keys || 0)} config keys`],
    ["History window", github.commits?.length ?? counts.commits ?? 0, inspection
      ? github.history_status === "partial" ? "partial GitHub history"
        : github.history_loaded === false ? "recent GitHub window · full history deferred" : "commits returned by GitHub"
      : "commits in the local window"],
    ["Evidence coverage", coverage == null ? "—" : `${Number(coverage).toFixed(1)}%`, "files with linked decision history"],
    ["GitHub API", apiState, state.githubUrl ? "bounded REST snapshot" : "no remote inspection"],
    ["Last inspected", lastInspected ? formatDateTime(lastInspected) : "—", inspection ? "freshness of this snapshot" : "loaded from a local graph"],
  ];
  host.innerHTML = rows.map(([label, value, detail]) => `<div class="overview-coverage-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(detail)}</small></div>`).join("");
  // Add a summary line at the bottom
  const summaryNote = document.createElement("div");
  summaryNote.className = "overview-coverage-summary";
  const totalFiles = counts.files ?? ingestion.tracked_files ?? 0;
  const totalFunctions = counts.functions || 0;
  const totalClasses = counts.classes || 0;
  summaryNote.innerHTML = `<small>Total: ${formatNumber(totalFiles)} source files · ${formatNumber(totalFunctions)} functions · ${formatNumber(totalClasses)} classes · ${formatNumber(counts.decisions || 0)} decisions</small>`;
  host.querySelector(".overview-coverage-summary")?.remove();
  host.appendChild(summaryNote);
  if (note) note.textContent = inspection ? "GitHub + local graph" : "Local graph only";
}

function renderArchitectureSummary(inspection, graph) {
  const analysis = inspection?.analysis;
  const summary = analysis?.summary || {};
  const graphCounts = graph?.nodes ? { files: graph.nodes.filter((node) => graphNodeType(node) === "File").length } : {};
  const cards = [
    [summary.module_count ?? 0, "modules"],
    [summary.import_count ?? 0, "import edges"],
    [summary.total_lines ?? "—", "source lines"],
    [summary.top_language ? displayLanguage(summary.top_language) : graphCounts.files ? `${formatNumber(graphCounts.files)} files` : "—", "top signal"],
  ];
  $("#architecture-summary").innerHTML = `<div class="architecture-stat-grid">${cards.map(([value, label]) => `<div class="architecture-stat"><strong>${typeof value === "number" ? formatNumber(value) : escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("")}</div>`;
}

function renderInspection(inspection, summary = {}) {
  state.summary = summary;
  renderRepoOverview(inspection, summary);
  renderMetadata(inspection, summary);
  renderLanguages(inspection);
  renderDependencies(inspection);
  renderArchitectureSummary(inspection, state.graph);
  renderOverviewActivity();
  renderOverviewCoverage(inspection, summary);
  renderLandmarks(inspection);
  renderGithubTrack(inspection);
  if (typeof renderAgentsPage === "function") renderAgentsPage();
  if (typeof window.renderCommitLab === "function") window.renderCommitLab();
}

function contributorIdentity(commit, contributorMap) {
  const author = commit?.author || {};
  const login = author.login || author.name || author.email || "unknown contributor";
  const apiContributor = contributorMap.get(author.login) || contributorMap.get(login);
  return {
    login: apiContributor?.login || login,
    avatar: apiContributor?.avatar_url || author.avatar_url || "",
    htmlUrl: apiContributor?.html_url || author.html_url || "",
  };
}

function renderLandmarks(inspection) {
  const host = $("#landmark-list");
  if (!host) return;
  const github = inspection?.github || {};
  const releases = (github.releases || []).slice(0, 4).map((release) => ({ kind: "R", title: release.name || release.tag_name || "Release", meta: formatDate(release.published_at || release.created_at), url: release.html_url }));
  const pulls = (github.pull_requests || []).slice(0, 4).map((pull) => ({ kind: "P", title: `#${pull.number || "?"} ${pull.title || "Pull request"}`, meta: `${pull.state || "open"} · ${formatDate(pull.updated_at || pull.created_at)}`, url: pull.html_url }));
  const items = [...releases, ...pulls].slice(0, 8);
  host.innerHTML = items.length ? items.map((item) => `<article class="landmark-card"><span class="landmark-kind">${escapeHtml(item.kind)}</span><div class="landmark-body"><span class="landmark-title" title="${escapeHtml(item.title)}">${item.url ? `<a class="landmark-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)} ↗</a>` : escapeHtml(item.title)}</span><div class="landmark-meta">${escapeHtml(item.meta)}</div></div></article>`).join("") : '<div class="empty-state">No releases or pull requests were returned.</div>';
}

function renderTrackAuthorOptions() {
  const select = $("#track-commit-author");
  if (!select) return;
  const current = select.value || "all";
  const authors = [...new Set((state.inspection?.github?.commits || [])
    .map((commit) => commit.author?.login || commit.author?.name || "")
    .filter(Boolean))].sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="all">All authors</option>${authors.map((author) => `<option value="${escapeHtml(author)}">${escapeHtml(author)}</option>`).join("")}`;
  select.value = current === "all" || authors.includes(current) ? current : "all";
}

function renderTrackCommits() {
  const host = $("#commit-history");
  const note = $("#track-history-note");
  if (!host) return;
  const graphNodes = state.graph?.nodes || [];
  const graphEdges = state.graph?.edges || [];
  const byId = new Map(graphNodes.map((node) => [node.id, node]));
  const authoredBy = new Map(graphEdges.filter((edge) => edge.type === "AUTHORED").map((edge) => [edge.target, byId.get(edge.source)]));
  const apiCommits = state.inspection?.github?.commits || [];
  // The Git track must stay useful without a live GitHub API snapshot, so the
  // local graph commits are the fallback source of history.
  const commits = apiCommits.length
    ? apiCommits
    : graphNodes
      .filter((node) => graphNodeType(node) === "Commit")
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime() || (a.history_index || 0) - (b.history_index || 0))
      .map((node) => {
        const author = authoredBy.get(node.id) || {};
        return {
          sha: node.sha,
          message: node.message,
          date: node.timestamp,
          author: { name: author.display_name || author.username || node.author_email || "" },
        };
      });
  if (!commits.length) {
    host.innerHTML = '<div class="empty-state">No commit history was returned for this snapshot.</div>';
    if (note) note.textContent = "No commit data";
    return;
  }
  const graphCommitBySha = new Map(graphNodes.filter((node) => graphNodeType(node) === "Commit" && node.sha).map((node) => [node.sha, node]));
  const modifiedByCommit = new Map();
  graphEdges.filter((edge) => edge.type === "MODIFIED").forEach((edge) => {
    const target = byId.get(edge.target);
    if (!target || !["File", "Function", "Class", "ConfigKey"].includes(graphNodeType(target))) return;
    if (!modifiedByCommit.has(edge.source)) modifiedByCommit.set(edge.source, []);
    modifiedByCommit.get(edge.source).push(edge);
  });

  const query = ($("#track-commit-search")?.value || "").trim().toLowerCase();
  const author = $("#track-commit-author")?.value || "all";
  const filtered = commits.filter((commit) => {
    const authorName = commit.author?.login || commit.author?.name || "";
    if (author !== "all" && authorName !== author) return false;
    if (!query) return true;
    return `${commit.message || ""} ${commit.sha || ""} ${authorName}`.toLowerCase().includes(query);
  });
  const limit = Math.max(20, state.trackCommitLimit || 20);
  const visible = filtered.slice(0, limit);
  if (!filtered.length) {
    host.innerHTML = '<div class="empty-state">No commits match this filter.</div>';
    if (note) note.textContent = `0 of ${formatNumber(commits.length)} sampled commits`;
    return;
  }

  host.innerHTML = visible.map((commit, index) => {
    const graphCommit = graphCommitBySha.get(commit.sha);
    const kind = graphCommit?.commit_kind === "merge" ? "merge" : "commit";
    const modifications = (modifiedByCommit.get(graphCommit?.id) || []);
    const filePaths = [...new Set(modifications.map((edge) => byId.get(edge.target)?.path || byId.get(edge.target)?.file_path).filter(Boolean))].slice(0, 4);
    const diff = modifications.map((edge) => edge.diff_hunk || "").filter(Boolean)[0] || "";
    const authorName = commit.author?.login || commit.author?.name || "Unknown contributor";
    const filesMarkup = filePaths.length
      ? `<div class="commit-files">${filePaths.map((path) => `<button class="commit-file" type="button" data-open-source-path="${escapeHtml(path)}" title="Open ${escapeHtml(path)} in the source explorer">${escapeHtml(path.split("/").pop())}</button>`).join("")}</div>`
      : "";
    return `<article class="commit-row"><span class="commit-node">${kind === "merge" ? "⑂" : index === 0 ? "●" : "○"}</span><div class="commit-body"><div class="commit-topline"><strong>${escapeHtml(authorName)}</strong><time>${escapeHtml(formatDate(commit.date))}</time></div><p>${escapeHtml(commit.message || "Repository change")}</p><div class="commit-tags"><code>${escapeHtml(String(commit.sha || "").slice(0, 12))}</code>${kind === "merge" ? '<span class="commit-tag">merge commit</span>' : ""}</div>${filesMarkup}<div class="commit-actions"><button class="commit-action" type="button" data-track-sha="${escapeHtml(commit.sha || "")}">Focus in timeline →</button></div>${diff ? `<details class="commit-diff"><summary>Show recorded diff hunk</summary><pre>${escapeHtml(diff)}</pre></details>` : ""}</div></article>`;
  }).join("");

  if (filtered.length > visible.length) {
    host.insertAdjacentHTML("beforeend", `<button class="track-load-more" type="button" id="track-load-more">Show ${formatNumber(Math.min(20, filtered.length - visible.length))} more · ${formatNumber(visible.length)} of ${formatNumber(filtered.length)}</button>`);
  }
  if (note) {
    note.textContent = query || author !== "all"
      ? `${formatNumber(visible.length)} of ${formatNumber(filtered.length)} matching · ${formatNumber(commits.length)} sampled`
      : `${formatNumber(visible.length)} of ${formatNumber(commits.length)} sampled commits`;
  }
}

function renderGithubTrack(inspection) {
  const github = inspection?.github || {};
  const repository = github.repository || {};
  const branches = github.branches || [];
  const graphCommitCount = (state.graph?.nodes || []).filter((node) => graphNodeType(node) === "Commit").length;
  const commitCount = github.commits?.length || graphCommitCount;
  const pulls = github.pull_requests || [];
  const events = github.events || [];
  $("#track-branch-count").textContent = formatNumber(branches.length);
  $("#track-commit-count").textContent = formatNumber(commitCount);
  $("#track-pull-count").textContent = formatNumber(pulls.length);
  $("#track-last-push").textContent = formatDate(repository.pushed_at, "Unknown");
  $("#track-branch-note").textContent = branches.length ? `${formatNumber(branches.length)} refs returned` : "No branch data";
  $("#track-pr-note").textContent = pulls.length ? `${formatNumber(pulls.length)} recent records` : "No pull requests";
  $("#track-push-note").textContent = events.length ? `${formatNumber(events.length)} observed events` : "No push events";
  const historyState = github.history_status === "partial"
    ? `${formatNumber(commitCount)} commits · partial history`
    : github.history_status === "deferred" || github.history_loaded === false
      ? (state.githubHistoryLoading ? "Loading full history…" : `${formatNumber(commitCount)} recent commits · full history deferred`)
      : (commitCount ? `${formatNumber(commitCount)} commits in this snapshot` : "No commit data");
  $("#track-history-note").textContent = historyState;
  // Render branches with better styling
  $("#branch-list").innerHTML = branches.length
    ? branches.slice(0, 16).map((branch) => {
      const commitSha = branch.commit?.sha || "";
      const isProtected = branch.protected;
      return `<div class="branch-row"><span class="track-icon ${isProtected ? "protected" : "active"}">${iconSvg("git")}</span><span><strong>${escapeHtml(branch.name || "unknown")}</strong>` + (commitSha ? `<small>${formatDate(repository.pushed_at || new Date().toISOString(), "short")}</small>` : "") + `</span><code>${escapeHtml(commitSha?.slice(0, 10) || "no-sha")}</code></div>`;
    }).join("")
    : '<div class="empty-state">No branch metadata was returned for this snapshot.</div>';
  // Render pull requests with merge status indicators
  $("#pull-status-list").innerHTML = pulls.length
    ? pulls.slice(0, 12).map((pull) => {
      const conflict = pull.mergeable === false || ["dirty", "conflicting"].includes(String(pull.mergeable_state || "").toLowerCase());
      const mergedAt = pull.merged_at ? formatDate(pull.merged_at) : "";
      const status = pull.merged_at ? "Merged" : conflict ? "Merge conflict" : String(pull.state || "Open").replace(/^./, (char) => char.toUpperCase());
      const statusClass = pull.merged_at ? "merged" : conflict ? "conflict" : "open";
      return `<a class="pull-row" href="${escapeHtml(pull.html_url || "#")}" target="_blank" rel="noopener noreferrer"><span class="pull-number">${iconSvg("pull")}#${escapeHtml(pull.number || "?")}</span><span class="pull-body"><strong>${escapeHtml(pull.title || "Pull request")}</strong><small>${escapeHtml(pull.user?.login || "Unknown author")} · ${escapeHtml(formatDate(pull.updated_at || pull.created_at))}${mergedAt ? ` · merged ${escapeHtml(mergedAt)}` : ""}</small></span><span class="pull-status ${statusClass}">${escapeHtml(status)}</span></a>`;
    }).join("")
    : '<div class="empty-state">No pull request metadata was returned for this snapshot.</div>';
  // Render push events with actor info
  const pushEvents = events.filter((event) => event.type === "PushEvent");
  $("#push-list").innerHTML = pushEvents.length
    ? pushEvents.slice(0, 12).map((event) => {
      const actor = event.actor?.login || "Unknown GitHub actor";
      const ref = event.ref?.replace("refs/heads/", "") || "unknown ref";
      const commitCount = event.distinct_size || event.size || event.commits?.length || 0;
      return `<div class="push-row"><span class="track-icon">${iconSvg("git")}</span><span class="push-body"><strong>${escapeHtml(actor)}</strong><small>${escapeHtml(ref)} · ${escapeHtml(formatDate(event.created_at))}</small></span><code>${formatNumber(commitCount)} commits</code></div>`;
    }).join("")
    : '<div class="empty-state">No GitHub push events were returned. This is an API limitation, not simulated data.</div>';
  renderTrackAuthorOptions();
  renderTrackCommits();
  renderCommitTimeline(state.graph);
  renderGithubInsights(inspection);
}

async function loadGithubHistory() {
  if (!state.githubUrl || state.githubHistoryLoading || state.inspection?.github?.history_loaded !== false) return;
  state.githubHistoryLoading = true;
  renderGithubTrack(state.inspection);
  try {
    const payload = await api(`/api/github/history?url=${encodeURIComponent(state.githubUrl)}`);
    state.inspection = payload.inspection || state.inspection;
    renderMetadata(state.inspection, state.summary || {});
    renderOverviewCoverage(state.inspection, state.summary || {});
    renderGithubTrack(state.inspection);
    renderLandmarks(state.inspection);
    if (typeof loadGithubTimeline === "function") {
      if (typeof resetGithubTimeline === "function") resetGithubTimeline();
      if (state.activePage === "evidence") loadGithubTimeline(true);
    }
    const status = state.inspection?.github?.history_status;
    setNotice("ingest-notice", status === "partial" ? "GitHub history loaded partially; unavailable collections are marked in coverage." : "Full GitHub history loaded.", status === "partial" ? "error" : "success");
  } catch (error) {
    setNotice("ingest-notice", `Full GitHub history could not be loaded: ${error.message}`, "error");
  } finally {
    state.githubHistoryLoading = false;
    renderGithubTrack(state.inspection);
  }
}

async function loadGithubContributors() {
  if (!state.githubUrl || state.githubContributorsLoading || state.inspection?.github?.contributors_loaded !== false) return;
  state.githubContributorsLoading = true;
  setNotice("ingest-notice", "Loading the contributor segment…", "loading");
  try {
    const payload = await api(`/api/github/contributors?url=${encodeURIComponent(state.githubUrl)}`);
    state.inspection = payload.inspection || state.inspection;
    renderMetadata(state.inspection, state.summary || {});
    renderLandmarks(state.inspection);
    if (typeof renderAgentsPage === "function") renderAgentsPage();
    setNotice("ingest-notice", `Loaded ${formatNumber(state.inspection?.github?.contributors?.length || 0)} contributor records.`, "success");
  } catch (error) {
    setNotice("ingest-notice", `Contributor segment could not be loaded: ${error.message}`, "error");
  } finally {
    state.githubContributorsLoading = false;
    if (typeof renderAgentsPage === "function") renderAgentsPage();
  }
}

function renderGithubInsights(inspection) {
  const github = inspection?.github || {};
  if (github.insights_loaded === false && ["not_requested", "rate_limited"].includes(github.insights_status || "not_requested")) {
    $("#track-insights-note").textContent = state.githubInsightsLoading ? "Loading optional collections…" : github.insights_status === "rate_limited" ? "Rate limited" : "Load when needed";
    $("#track-insight-grid").innerHTML = `<div class="insight-load-card"><p>Optional GitHub insights include Actions, traffic, forks, discussions, dependency metadata, and aggregate statistics. They are loaded only when this page is opened so the core workspace stays fast.</p><button class="text-button" id="load-github-insights" type="button" ${state.githubInsightsLoading ? "disabled" : ""}>${state.githubInsightsLoading ? "Loading…" : "Load optional insights"}</button></div>`;
    const button = $("#load-github-insights");
    if (button) button.addEventListener("click", loadGithubInsights);
    return;
  }
  const coverage = github.coverage || {};
  const items = [
    ["Issues", github.issues?.length || 0, coverage.issues],
    ["Branches", github.branches?.length || 0, coverage.branches],
    ["Discussions", github.discussions?.length || 0, coverage.discussions],
    ["Actions runs", github.workflow_runs?.length || 0, coverage.workflow_runs],
    ["Workflows", github.workflows?.length || 0, coverage.workflows],
    ["Forks", github.forks?.length || 0, coverage.forks],
    ["Code frequency", github.code_frequency?.length || 0, coverage.code_frequency],
    ["Commit activity", github.commit_activity?.length || 0, coverage.commit_activity],
    ["Participation", github.participation && Object.keys(github.participation).length ? "ready" : "—", coverage.participation],
    ["Punch card", github.punch_card?.length || 0, coverage.punch_card],
    ["Dependencies", github.dependency_graph?.sbom?.packages?.length || 0, coverage.dependency_graph],
    ["Traffic views", github.traffic?.views?.length || 0, coverage.traffic],
    ["Community profile", github.community_profile && Object.keys(github.community_profile).length ? "ready" : "—", null],
    ["Network graph", coverage.network?.complete ? "ready" : "limited", coverage.network],
    ["Pulse", coverage.pulse?.complete ? "ready" : "limited", coverage.pulse],
    ["Community standards", coverage.community_standards?.complete ? "ready" : "limited", coverage.community_standards],
    ["Actions metrics", github.actions_usage && Object.keys(github.actions_usage).length ? "ready" : "—", coverage.actions_metrics],
  ];
  const available = items.filter(([, value, record]) => value !== 0 || record || value === "ready" || value === "limited");
   const insightSuffix = github.insights_status === "partial" ? " · partial" : "";
   $("#track-insights-note").textContent = available.length ? `${formatNumber(available.length)} insight${available.length === 1 ? "" : "s"} reported${insightSuffix}` : "No additional insight data";
  $("#track-insight-grid").innerHTML = available.length
    ? available.map(([label, value, record]) => {
      const status = record?.complete ? "complete" : record?.truncated ? "bounded" : record ? "partial" : "observed";
      return `<article class="track-insight-card"><div class="insight-card-header"><span class="insight-card-label">${escapeHtml(label)}</span><strong class="insight-card-value">${escapeHtml(value)}</strong></div><small class="insight-card-status">${escapeHtml(status)}${record?.reason ? ` · ${escapeHtml(record.reason)}` : ""}</small></article>`;
    }).join("")
    : '<div class="empty-state">No additional GitHub insight collections were returned.</div>';
}

async function loadGithubInsights() {
  if (!state.githubUrl || state.githubInsightsLoading || state.inspection?.github?.insights_loaded !== false) return;
  state.githubInsightsLoading = true;
  renderGithubInsights(state.inspection);
  try {
    const payload = await api(`/api/github/insights?url=${encodeURIComponent(state.githubUrl)}`);
    state.inspection = payload.inspection || state.inspection;
    renderGithubTrack(state.inspection);
    const rateLimit = state.inspection?.github?.errors?.github_rate_limit;
    setNotice("ingest-notice", rateLimit?.message || "Optional GitHub insights loaded.", rateLimit ? "error" : "success");
  } catch (error) {
    setNotice("ingest-notice", error.message, "error");
  } finally {
    state.githubInsightsLoading = false;
    renderGithubInsights(state.inspection);
  }
}

function renderCommitTimeline(graph = state.graph) {
  const commits = (graph?.nodes || [])
    .filter((node) => graphNodeType(node) === "Commit")
    .sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime() || (b.history_index || 0) - (a.history_index || 0));
  state.timeline = commits;
  const slider = $("#timeline-slider");
  slider.max = String(Math.max(0, commits.length - 1));
  slider.value = String(Math.min(state.timelineIndex, Math.max(0, commits.length - 1)));
  slider.disabled = !commits.length;
  $("#timeline-axis").innerHTML = commits.length
    ? commits.map((commit, index) => `<button type="button" class="timeline-stop${index === Number(slider.value) ? " active" : ""}" data-timeline-index="${index}" title="${escapeHtml(commit.message || "commit")}"><span></span></button>`).join("")
    : "";
  renderTimelineDetail(Number(slider.value));
}

function renderTimelineDetail(index) {
  state.timelineIndex = Math.max(0, Math.min(index, Math.max(0, state.timeline.length - 1)));
  const commit = state.timeline[state.timelineIndex];
  if (!commit) {
    $("#timeline-position").textContent = "No timeline loaded";
    $("#timeline-detail").innerHTML = '<div class="empty-state">No locally ingested commits are available.</div>';
    return;
  }
  const author = (state.graph?.nodes || []).find((node) => (state.graph?.edges || []).some((edge) => edge.type === "AUTHORED" && edge.source === node.id && edge.target === commit.id));
  const modifications = (state.graph?.edges || []).filter((edge) => edge.type === "MODIFIED" && edge.source === commit.id);
  const byId = new Map((state.graph?.nodes || []).map((node) => [node.id, node]));
  const fileRecords = modifications
    .map((edge) => ({
      path: byId.get(edge.target)?.path || byId.get(edge.target)?.file_path || "tracked file",
      diff_hunk: edge.diff_hunk || "",
      label: graphNodeType(byId.get(edge.target) || {}) || "File",
    }))
    .filter((record) => record.path);
  const files = fileRecords.map((record) => record.path);
  $("#timeline-position").textContent = `${formatNumber(state.timelineIndex + 1)} of ${formatNumber(state.timeline.length)} · ${formatDate(commit.timestamp)}`;
  const timelineSlider = $("#timeline-slider");
  if (timelineSlider) timelineSlider.value = String(state.timelineIndex);
  $("#timeline-axis").querySelectorAll("[data-timeline-index]").forEach((stop) => stop.classList.toggle("active", Number(stop.dataset.timelineIndex) === state.timelineIndex));
  const diffMarkup = typeof renderMultiFileRecordDiff === "function"
    ? renderMultiFileRecordDiff(fileRecords)
    : '<div class="empty-state">No diff renderer is available.</div>';
  $("#timeline-detail").innerHTML = `<div class="timeline-detail-head"><div><span class="eyebrow">${commit.commit_kind === "merge" ? "MERGE COMMIT" : "COMMIT"}</span><h3>${escapeHtml(commit.message || "Repository change")}</h3></div><code>${escapeHtml(String(commit.sha || "").slice(0, 12))}</code></div><div class="timeline-detail-facts"><span><strong>Author</strong>${escapeHtml(author?.display_name || author?.username || commit.author_email || "Unknown")}</span><span><strong>Parents</strong>${formatNumber(commit.parent_count || 0)}</span><span><strong>Files touched</strong>${formatNumber(files.length)}</span><span><strong>Insertions / deletions</strong>+${formatNumber(commit.insertions || 0)} / −${formatNumber(commit.deletions || 0)}</span></div><div class="timeline-files">${files.length ? files.map((file) => `<button class="timeline-file-link" type="button" data-timeline-file="${escapeHtml(file)}">${escapeHtml(file)}</button>`).join("") : '<span>No file targets recorded</span>'}</div>${diffMarkup}</div>`;
  $("#timeline-detail").querySelectorAll("[data-timeline-file]").forEach((button) => button.addEventListener("click", () => openGraphSourcePath(button.dataset.timelineFile)));
}

function commitNodesForWorkspace() {
  return (state.graph?.nodes || [])
    .filter((node) => graphNodeType(node) === "Commit")
    .sort((a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime() || (b.history_index || 0) - (a.history_index || 0));
}

function renderComparePage() {
  const from = $("#compare-from");
  const to = $("#compare-to");
  const empty = $("#compare-empty");
  if (!from || !to) return;
  const commits = commitNodesForWorkspace();
  if (!state.graphLoaded || commits.length < 2) {
    from.innerHTML = '<option value="">Select a snapshot</option>';
    to.innerHTML = '<option value="">Select a snapshot</option>';
    if (empty) empty.textContent = state.graphLoaded ? "At least two local commits are required for comparison." : "Load a repository with at least two commits to compare structural changes.";
    return;
  }
  const options = commits.map((commit, index) => `<option value="${escapeHtml(commit.id)}">${escapeHtml(`${index + 1}. ${(commit.sha || "").slice(0, 10)} · ${(commit.message || "Repository change").split("\n")[0].slice(0, 60)}`)}</option>`).join("");
  const previousFrom = from.value;
  const previousTo = to.value;
  from.innerHTML = options;
  to.innerHTML = options;
  from.value = commits.some((commit) => commit.id === previousFrom) ? previousFrom : commits[0].id;
  to.value = commits.some((commit) => commit.id === previousTo) ? previousTo : commits[commits.length - 1].id;
  if (empty) empty.textContent = "Select two snapshots and compare their recorded file relationships.";
}

function commitRecords(commitId) {
  const byId = new Map((state.graph?.nodes || []).map((node) => [node.id, node]));
  return (state.graph?.edges || [])
    .filter((edge) => edge.type === "MODIFIED" && edge.source === commitId)
    .map((edge) => ({
      path: byId.get(edge.target)?.path || byId.get(edge.target)?.file_path || "",
      diff_hunk: edge.diff_hunk || "",
      label: graphNodeType(byId.get(edge.target) || {}) || "File",
    }))
    .filter((record) => record.path);
}

function runCompare() {
  const result = $("#compare-result");
  const empty = $("#compare-empty");
  const from = commitNodesForWorkspace().find((commit) => commit.id === $("#compare-from")?.value);
  const to = commitNodesForWorkspace().find((commit) => commit.id === $("#compare-to")?.value);
  if (!result || !from || !to) {
    if (empty) empty.textContent = "Choose two snapshots after loading a repository.";
    return;
  }
  const beforeRecords = commitRecords(from.id);
  const afterRecords = commitRecords(to.id);
  const before = new Map(beforeRecords.map((record) => [record.path, record]));
  const after = new Map(afterRecords.map((record) => [record.path, record]));
  const added = [...after.keys()].filter((path) => !before.has(path)).sort();
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();
  const shared = [...after.keys()].filter((path) => before.has(path)).sort();
  const changedRecords = [...new Set([...added, ...shared])]
    .map((path) => ({ path, from: before.get(path) || null, to: after.get(path) || null }))
    .filter((record) => record.from?.diff_hunk || record.to?.diff_hunk);
  const diffMarkup = changedRecords.length && typeof renderComparisonDiffMarkup === "function"
    ? `<section class="compare-diff-section"><div class="compare-section-heading"><div><span class="eyebrow">RECORDED PATCHES</span><h3>File-by-file change records</h3></div><span class="section-note">${formatNumber(changedRecords.length)} file${changedRecords.length === 1 ? "" : "s"} with diff hunks</span></div>${changedRecords.slice(0, 40).map((record) => renderComparisonDiffMarkup(record)).join("")}</section>`
    : '<section class="compare-diff-section"><div class="empty-state">No diff hunks were recorded for the selected commit pair.</div></section>';
  result.hidden = false;
  if (empty) empty.textContent = `${(from.sha || "").slice(0, 10)} → ${(to.sha || "").slice(0, 10)} · recorded file relationship comparison`;
  result.innerHTML = `<div class="compare-summary"><span><strong>${formatNumber(added.length)}</strong> added targets</span><span><strong>${formatNumber(removed.length)}</strong> removed targets</span><span><strong>${formatNumber(shared.length)}</strong> shared targets</span><span><strong>${formatNumber(changedRecords.length)}</strong> diff records</span></div><div class="compare-columns"><section><h3>Added / newly touched</h3>${added.length ? `<ul>${added.map((path) => `<li>${escapeHtml(path)}</li>`).join("")}</ul>` : '<p class="empty-state">No newly touched files.</p>'}</section><section><h3>Removed from target</h3>${removed.length ? `<ul>${removed.map((path) => `<li>${escapeHtml(path)}</li>`).join("")}</ul>` : '<p class="empty-state">No removed file targets.</p>'}</section><section><h3>Shared targets</h3>${shared.length ? `<ul>${shared.slice(0, 40).map((path) => `<li>${escapeHtml(path)}</li>`).join("")}</ul>` : '<p class="empty-state">No shared file targets.</p>'}</section></div>${diffMarkup}<p class="compare-note">The left and right panes show the recorded patch attached to each selected commit. Arbitrary non-adjacent snapshots do not imply a full checkout diff.</p>`;
}

state.simulationHistory = state.simulationHistory || [];
state.activeSimTab = state.activeSimTab || "chat";

function setSimulationTab(tabName) {
  state.activeSimTab = tabName;
  document.querySelectorAll(".simulation-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.simTab === tabName);
  });
  const panels = {
    chat: $("#sim-content-chat"),
    orchestrator: $("#sim-content-orchestrator"),
    routing: $("#sim-content-routing"),
    findings: $("#sim-content-findings"),
  };
  Object.entries(panels).forEach(([key, el]) => {
    if (el) el.hidden = key !== tabName;
  });
}

function renderSimulationScope() {
  const counts = state.summary?.counts || {};
  const scopeEl = $("#simulation-scope");
  const modelPill = $("#simulation-model-pill");
  const routeEl = $("#simulation-card-route");
  const verifierEl = $("#simulation-card-verifier");

  if (!state.graphLoaded) {
    if (scopeEl) scopeEl.textContent = "Load a repository first";
    return;
  }
  if (scopeEl) {
    scopeEl.textContent = `${formatNumber(counts.files || 0)} files · ${formatNumber(counts.commits || 0)} commits · ${formatNumber(state.graph?.nodes?.length || 0)} nodes`;
  }
  const prov = $("#ai-room-provider")?.value || state.aiProvider;
  const mod = $("#ai-room-model")?.value || state.aiModel;
  if (modelPill) {
    modelPill.textContent = prov ? `${prov} · ${mod || "Auto"}` : "Mnemo Graph-RAG AI";
  }
  if (state.simulationPayload?.orchestration) {
    if (routeEl) routeEl.textContent = aiRouteLabel(state.simulationPayload.orchestration);
    if (verifierEl) verifierEl.textContent = "Verified Multi-Agent Consensus";
  }
}

function renderSimulationChatThread() {
  const thread = $("#simulation-chat-thread");
  if (!thread) return;

  if (!state.simulationHistory.length) {
    thread.innerHTML = `
      <div class="simulation-chat-welcome">
        <div class="sim-welcome-icon">M</div>
        <div class="sim-welcome-text">
          <strong>Welcome to Mnemo AI Simulation</strong>
          <p>Ask any architectural question, simulate feature changes, check blast radius, or explore code relationships. Answers are grounded in the repository's Knowledge Graph and Graph-RAG index.</p>
        </div>
      </div>`;
    return;
  }

  thread.innerHTML = state.simulationHistory.map((item) => {
    const rawAnswer = item.answer || "Simulation completed.";
    const lines = String(rawAnswer).split("\n").map((text) => ({ text }));
    let formatted = typeof renderMarkdown === "function" ? renderMarkdown(lines, "simulation.md") : "";
    if (!formatted || !formatted.trim()) {
      formatted = `<p>${escapeHtml(rawAnswer).replace(/\n/g, "<br>")}</p>`;
    }
    const orch = item.payload?.orchestration;
    const cleanRag = (item.payload?.rag_chunks || []).filter((chunk) => {
      const path = String(chunk.file_path || "").toLowerCase();
      return !/\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|tar|gz|bin|exe|so|dll|dylib|woff2?|ttf|eot)$/i.test(path);
    });

    const evidencePills = [];
    if (orch?.flow?.nodes?.length) {
      evidencePills.push(`<button type="button" class="sim-evidence-chip active" data-switch-sim-tab="routing">Route: ${formatNumber(orch.flow.nodes.length)} steps</button>`);
    }
    if (orch?.transcript?.length) {
      evidencePills.push(`<button type="button" class="sim-evidence-chip" data-switch-sim-tab="orchestrator">Agents: ${orch.transcript.map(a => a.login).slice(0, 2).join(", ")}</button>`);
    }
    if (cleanRag.length) {
      evidencePills.push(`<button type="button" class="sim-evidence-chip" data-switch-sim-tab="findings">Chunks: ${cleanRag.length} code extracts</button>`);
    }

    return `
      <div class="simulation-msg user">
        <div class="sim-bubble">${escapeHtml(item.question)}</div>
      </div>
      <div class="simulation-msg bot">
        <div class="sim-bubble">
          <div class="sim-bubble-head">
            <span class="sim-bubble-author">${iconSvg("chat")} Mnemo AI</span>
            <span class="sim-bubble-badge">${escapeHtml(item.model || "Graph-RAG")}</span>
          </div>
          <div class="sim-bubble-text">${formatted}</div>
          ${evidencePills.length ? `<div class="sim-bubble-evidence">${evidencePills.join("")}</div>` : ""}
        </div>
      </div>`;
  }).join("");

  thread.scrollTop = thread.scrollHeight;
}

function renderSimulationOrchestratorView(payload) {
  const empty = $("#sim-orchestrator-empty");
  const body = $("#sim-orchestrator-body");
  if (!empty || !body) return;

  const orch = payload?.orchestration;
  const transcript = orch?.transcript || [];
  if (!transcript.length) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  body.innerHTML = transcript.map((agent) => {
    const commitsCount = (agent.commits || []).length;
    const filesCount = (agent.touched_files || []).length;
    const filesMarkup = (agent.touched_files || []).slice(0, 4).map((f) => `<button type="button" class="file-pill-link" data-open-source="${escapeHtml(f)}">${escapeHtml(f)}</button>`).join(" ");

    return `
      <article class="sim-agent-card">
        <header class="sim-agent-head">
          <div class="sim-agent-info">
            <span class="sim-agent-avatar">${escapeHtml((agent.login || "A").slice(0, 1).toUpperCase())}</span>
            <div>
              <strong>${escapeHtml(agent.login || "Contributor Agent")}</strong>
              <small>${escapeHtml(agent.evidence_source || "Verified repository contributor agent")}</small>
            </div>
          </div>
          <span class="sim-agent-role">Contributor Agent</span>
        </header>
        <p class="sim-agent-text">${escapeHtml(agent.message || "Analyzed repository files and verified change lineage.")}</p>
        <div class="sim-agent-meta">
          <span>${formatNumber(commitsCount)} commits</span> · 
          <span>${formatNumber(filesCount)} files touched</span>
          ${filesMarkup ? `<div>${filesMarkup}</div>` : ""}
        </div>
      </article>`;
  }).join("");
}

function renderSimulationRoutingView(payload) {
  const empty = $("#sim-routing-empty");
  const trace = $("#simulation-trace");
  if (!empty || !trace) return;

  const flow = payload?.orchestration?.flow;
  if (!flow || !flow.nodes || !flow.nodes.length) {
    empty.hidden = false;
    trace.hidden = true;
    return;
  }
  empty.hidden = true;
  trace.hidden = false;

  trace.innerHTML = `
    <div class="simulation-trace-head">
      <strong>Simulated Evidence Route (${formatNumber(flow.nodes.length)} Steps)</strong>
      <span>${escapeHtml(payload.orchestration.status || "verified")}</span>
    </div>
    <ol>
      ${flow.nodes.slice(0, 24).map((node) => `
        <li>
          <b>${escapeHtml(node.kind || "step")}</b>
          <span>${escapeHtml(node.label || node.id || "Evidence Step")}</span>
          <small>${escapeHtml(node.subtitle || "")}</small>
        </li>
      `).join("")}
    </ol>`;
}

function renderSimulationFindingsView(payload) {
  const empty = $("#sim-findings-empty");
  const body = $("#sim-findings-body");
  if (!empty || !body) return;

  const cleanRag = (payload?.rag_chunks || []).filter((chunk) => {
    const path = String(chunk.file_path || "").toLowerCase();
    return !/\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|tar|gz|bin|exe|so|dll|dylib|woff2?|ttf|eot)$/i.test(path);
  });

  if (!cleanRag.length) {
    empty.hidden = false;
    body.hidden = true;
    return;
  }
  empty.hidden = true;
  body.hidden = false;

  body.innerHTML = cleanRag.map((chunk) => {
    const fpath = chunk.file_path || "unknown";
    const start = chunk.start_line || 1;
    const end = chunk.end_line || start;
    const tokens = chunk.token_count || 0;
    const text = (chunk.text || chunk.code || "").slice(0, 750);

    return `
      <article class="sim-chunk-card">
        <header class="sim-chunk-head">
          <button type="button" class="sim-chunk-file file-pill-link" data-open-source="${escapeHtml(fpath)}" title="Open file in Source Explorer">${escapeHtml(fpath)} (lines ${start}-${end})</button>
          <span class="sim-chunk-tokens">${formatNumber(tokens)} tokens · ${escapeHtml(chunk.chunk_type || "code")}</span>
        </header>
        <pre class="sim-chunk-code"><code>${escapeHtml(text)}</code></pre>
      </article>`;
  }).join("");
}

function renderSimulationPage() {
  renderSimulationScope();
  renderSimulationChatThread();
  if (state.simulationPayload) {
    renderSimulationOrchestratorView(state.simulationPayload);
    renderSimulationRoutingView(state.simulationPayload);
    renderSimulationFindingsView(state.simulationPayload);
  }
}

async function runSimulation(forcedQuestion = null) {
  const questionInput = $("#simulation-question");
  const button = $("#simulation-run");
  const thread = $("#simulation-chat-thread");

  if (!state.graphLoaded) {
    setNotice("simulation-notice", "Inspect or load a repository before running a simulation.", "error");
    return;
  }

  const question = (typeof forcedQuestion === "string" ? forcedQuestion : questionInput?.value)?.trim() || "Explain the core system architecture and dataflow of this repository";
  if (questionInput) questionInput.value = "";

  // Switch to chat tab if not active
  setSimulationTab("chat");

  // Append user message immediately
  if (thread) {
    const userMsg = document.createElement("div");
    userMsg.className = "simulation-msg user";
    userMsg.innerHTML = `<div class="sim-bubble">${escapeHtml(question)}</div>`;
    thread.appendChild(userMsg);

    const pendingMsg = document.createElement("div");
    pendingMsg.className = "simulation-msg bot";
    pendingMsg.id = "sim-pending-msg";
    pendingMsg.innerHTML = `
      <div class="sim-bubble">
        <div class="sim-bubble-head">
          <span class="sim-bubble-author"><span class="loading-spinner"></span> Mnemo AI</span>
          <span class="sim-bubble-badge">Simulating route…</span>
        </div>
        <div class="sim-bubble-text"><p>Traversing repository graph, coordinating contributor agents, and retrieving Graph-RAG chunks…</p></div>
      </div>`;
    thread.appendChild(pendingMsg);
    thread.scrollTop = thread.scrollHeight;
  }

  if (button) {
    button.disabled = true;
    button.innerHTML = `<span class="loading-spinner"></span> Simulating…`;
  }
  setNotice("simulation-notice", "Mnemo AI is simulating the evidence route…");

  try {
    const aiAssist = $("#simulation-ai-assist")?.checked ?? true;
    const provider = $("#ai-room-provider")?.value || state.aiProvider || undefined;
    const model = $("#ai-room-model")?.value?.trim() || state.aiModel || undefined;

    const payload = await api("/api/ai/room", {
      method: "POST",
      body: JSON.stringify({ question, ai_assist: aiAssist, provider, model }),
    });

    state.simulationPayload = payload;
    const answerText = payload.ai?.text || payload.orchestration?.synthesis || payload.result?.answer || "Simulation completed from the active graph.";

    state.simulationHistory.push({
      question,
      answer: answerText,
      payload,
      model: payload.ai?.model || payload.ai?.provider || "Graph-RAG AI",
    });

    renderSimulationPage();
    setNotice("simulation-notice", "Simulation complete.", "success");
  } catch (error) {
    const pending = $("#sim-pending-msg");
    if (pending) {
      pending.innerHTML = `
        <div class="sim-bubble">
          <div class="sim-bubble-head"><span class="sim-bubble-author">Mnemo AI</span><span class="sim-bubble-badge">Error</span></div>
          <div class="sim-bubble-text"><p class="empty-state">${escapeHtml(error.message || "Failed to complete simulation.")}</p></div>
        </div>`;
    }
    setNotice("simulation-notice", error.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = `<span>Send &amp; Simulate</span>`;
    }
  }
}

function renderAiRoom(payload) {
  state.aiRoom = payload;
  const statusChip = $("#ai-status-chip");
  if (statusChip) {
    statusChip.textContent = payload?.ai ? `AI · ${payload.ai.provider || "enabled"}` : "AI off";
    statusChip.classList.toggle("is-active", Boolean(payload?.ai));
  }
  if (typeof renderAiThread === "function") renderAiThread(payload);
}

async function askAiRoom() {
  const question = $("#ai-room-question").value.trim();
  if (!question) {
    setNotice("ai-room-notice", "Ask a question about the repository timeline.", "error");
    return;
  }
  if (!state.graphLoaded) {
    if (typeof renderAiThreadError === "function") {
      renderAiThreadError("Please inspect a repository first (click 'Inspect repository' at top) to load commits, contributors, and code relationships.");
    }
    setNotice("ai-room-notice", "Inspect a repository before asking.", "error");
    return;
  }
  if (typeof renderAiThreadPending === "function") {
    renderAiThreadPending(question);
  }
  const button = $("#ai-room-send");
  button.disabled = true;
  button.textContent = "Routing…";
  setNotice("ai-room-notice", $("#ai-room-assist").checked ? "Checking evidence, then asking the selected provider…" : "Checking graph evidence…");
  try {
    const payload = await api("/api/ai/room", {
      method: "POST",
      body: JSON.stringify({
        question,
        ai_assist: $("#ai-room-assist").checked,
        provider: $("#ai-room-provider").value || undefined,
        model: $("#ai-room-model").value.trim() || undefined,
      }),
    });
    renderAiRoom(payload);
    setNotice("ai-room-notice", payload.result?.status === "abstain" ? "No supporting intent was recorded." : "Answer ready.", payload.result?.status === "abstain" ? "" : "success");
  } catch (error) {
    setNotice("ai-room-notice", error.message, "error");
    if (typeof renderAiThreadError === "function") renderAiThreadError(error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'Ask <span>&rarr;</span>';
  }
}

function evidenceStepMatches(step, query) {
  if (!query) return true;
  const commit = step.commit || {};
  const author = step.author || {};
  const decisions = step.decisions || [];
  const haystack = [
    commit.message,
    commit.sha,
    author.display_name,
    author.username,
    author.email,
    ...(step.modified || []).map((item) => entityPath(item) || entityTitle(item)),
    ...decisions.map((item) => item.summary || item.context || ""),
    ...(step.superseded || []).map((item) => item.summary || ""),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

async function loadEvidenceChain(entityId = state.selectedEntity) {
  if (!state.graphLoaded) {
    renderEvidenceChain({ target: null, steps: [], message: "Inspect a repository to build the chain of evidence." });
    return null;
  }
  try {
    const query = entityId ? `?entity_id=${encodeURIComponent(entityId)}` : "";
    const payload = await api(`/api/evidence/chain${query}`);
    renderEvidenceChain(payload);
    return payload;
  } catch (error) {
    renderEvidenceChain({ target: null, steps: [], message: error.message });
    return null;
  }
}

function renderEvidenceChain(payload = state.evidenceChainPayload) {
  if (payload) state.evidenceChainPayload = payload;
  const current = state.evidenceChainPayload || {};
  const steps = current.steps || [];
  const target = current.target;
  const query = state.evidenceQuery.trim().toLowerCase();
  const decisions = steps.reduce((sum, step) => sum + (step.decisions?.length || 0), 0);
  const superseded = steps.reduce((sum, step) => sum + (step.superseded?.length || 0), 0);
  const filtered = steps.filter((step) => {
    if (state.evidenceFilter === "decisions" && !(step.decisions || []).length) return false;
    if (state.evidenceFilter === "superseded" && !(step.superseded || []).length) return false;
    return evidenceStepMatches(step, query);
  });

  if ($("#evidence-stat-changes")) $("#evidence-stat-changes").textContent = formatNumber(steps.length);
  if ($("#evidence-stat-decisions")) $("#evidence-stat-decisions").textContent = formatNumber(decisions);
  if ($("#evidence-stat-superseded")) $("#evidence-stat-superseded").textContent = formatNumber(superseded);
  if ($("#evidence-stat-scope")) $("#evidence-stat-scope").textContent = target ? entityTitle(target).slice(0, 16) : "Repository";
  if ($("#evidence-stat-scope-detail")) $("#evidence-stat-scope-detail").textContent = target ? "selected entity" : "recent linked changes";
  if ($("#chain-summary")) {
    $("#chain-summary").textContent = steps.length
      ? `${formatNumber(filtered.length)} of ${formatNumber(steps.length)} linked change${steps.length === 1 ? "" : "s"}${query || state.evidenceFilter !== "all" ? " matching" : ""}`
      : "No linked history";
  }

  if ($("#evidence-chain")) {
    $("#evidence-chain").innerHTML = filtered.length
      ? filtered.map((step, index) => {
        const commit = step.commit || {};
        const author = step.author || {};
        const modified = (step.modified || []).slice(0, 6);
        const decisionList = step.decisions || [];
        const supersededList = step.superseded || [];
        const decision = decisionList[0] || {};
        const modifiedText = modified.length ? modified.map((item) => entityPath(item) || entityTitle(item)).join(" · ") : "No file target recorded";
        const decisionText = decisionList.length ? decisionList.map((item) => item.summary || "Recorded decision").join(" · ") : "Structural change without a recorded intent decision";
        const diff = (step.modified || []).map((item) => item.diff_hunk || "").filter(Boolean).join("\n\n");
        const sha = commit.sha || "";
        const statusPill = decision.status
          ? `<span class="chain-pill chain-pill-${escapeHtml(decision.status)}">${escapeHtml(decision.status)} decision</span>`
          : '<span class="chain-pill chain-pill-none">structural</span>';
        const supersededPill = supersededList.length ? `<span class="chain-pill chain-pill-expired">supersedes ${formatNumber(supersededList.length)}</span>` : "";
        const fileRow = modified.length
          ? `<div class="chain-file-row">${modified.map((item) => `<span class="chain-file" title="${escapeHtml(entityPath(item) || entityTitle(item))}">${escapeHtml(entityPath(item) || entityTitle(item))}</span>`).join("")}</div>`
          : "";
        return `<article class="chain-step"><div class="chain-marker">${String(index + 1).padStart(2, "0")}</div><div class="chain-step-body"><div class="chain-step-topline"><span class="chain-stage">COMMIT → CODE → INTENT</span><span class="chain-badges">${statusPill}${supersededPill}</span><time>${escapeHtml(formatDate(commit.timestamp))}</time></div><h3>${escapeHtml(commit.message || "Recorded repository change")}</h3><div class="chain-facts"><span><strong>Author</strong>${escapeHtml(author.display_name || author.username || author.email || "Unknown contributor")}</span><span><strong>Commit</strong><code>${escapeHtml(sha.slice(0, 12) || "No SHA")}</code></span><span><strong>Changed</strong>${escapeHtml(modifiedText)}</span></div>${fileRow}<div class="chain-decision"><span class="chain-decision-label">Decision record</span><p>${escapeHtml(decisionText)}</p>${supersededList.length ? `<small>Supersedes: ${escapeHtml(supersededList.map((item) => item.summary || item.id).join(" · "))}</small>` : ""}</div><div class="chain-actions"><button class="chain-action" type="button" data-chain-sha="${escapeHtml(sha)}">Open in Git track →</button>${diff ? `<details class="chain-diff"><summary>Show recorded diff</summary><pre>${escapeHtml(diff)}</pre></details>` : ""}</div></div></article>`;
      }).join("")
      : `<div class="empty-state">${steps.length ? "No linked changes match this filter." : escapeHtml(current.message || "No linked commit evidence was found for this repository.")}</div>`;

    $("#evidence-chain").querySelectorAll("[data-chain-sha]").forEach((button) => {
      button.addEventListener("click", () => jumpToGitTrackCommit(button.dataset.chainSha));
    });
  }
}

function renderEntities() {
  const list = $("#entity-list");
  if (!list) return;
  const meta = $("#entity-meta");
  if (!state.graphLoaded) {
    if (meta) meta.textContent = "Awaiting repository";
    list.innerHTML = '<div class="empty-state">Inspect a repository to browse tracked files, symbols, and configuration keys.</div>';
    return;
  }
  if (!state.entities.length) {
    if (meta) meta.textContent = "0 entities";
    list.innerHTML = '<div class="empty-state">No matching repository entities.</div>';
    return;
  }
  if (meta) meta.textContent = `${formatNumber(state.entities.length)} entities shown`;
  list.innerHTML = state.entities.map((entity) => {
    const label = entityLabel(entity);
    const path = entityPath(entity);
    const line = entity.start_line ? ` · L${entity.start_line}` : "";
    const selected = state.selectedEntity === entity.id ? " selected" : "";
    return `<button class="entity-row${selected}" data-entity-id="${escapeHtml(entity.id)}"><span class="entity-icon ${escapeHtml(label)}">${escapeHtml(label.slice(0, 1))}</span><span class="entity-text"><span class="entity-name">${escapeHtml(entityTitle(entity))}</span><span class="entity-path">${escapeHtml(path || entity.signature || entity.id)}${escapeHtml(line)}</span></span><span class="entity-type">${escapeHtml(label)}</span></button>`;
  }).join("");
  list.querySelectorAll("[data-entity-id]").forEach((element) => element.addEventListener("click", () => selectEntity(element.dataset.entityId)));
}

async function hydrateGraph(summaryHint = null, graphHint = null) {
  setGraphAvailability(false);
  setGraphState("Loading repository relationships…", "loading");
  try {
    const [summary, graph] = await Promise.all([
      summaryHint ? Promise.resolve(summaryHint) : api("/api/graph/summary"),
      (graphHint && Array.isArray(graphHint.nodes)) ? Promise.resolve(graphHint) : api("/api/graph?limit=1000"),
    ]);
    state.graph = graph;
    state.graphLoaded = true;
    renderMetadata(state.inspection, summary);
    renderRepoOverview(state.inspection, summary);
    renderOverviewActivity();
    renderOverviewCoverage(state.inspection, summary);
    if (typeof window.renderCommitLab === "function") window.renderCommitLab();
    renderArchitectureSummary(state.inspection, graph);
    renderGithubTrack(state.inspection);
    renderGraph(graph);
    renderFileTree(graph);
    loadFileCatalog();
    loadRepositoryDocuments();
    renderComparePage();
    renderSimulationPage();
    if (typeof renderAgentsPage === "function") renderAgentsPage();
    if (state.activePage === "source" && typeof renderSourceRelationGraph === "function") {
      renderSourceRelationGraph(state.sourcePath || "");
    }
    setGraphAvailability(true);
    [$("#neo4j-sync-button"), $("#settings-neo4j-sync")].filter(Boolean).forEach((button) => {
      button.disabled = !state.neo4jConnected;
    });
    return summary;
  } catch (error) {
    state.graphLoaded = false;
    setGraphState(error.message, "error");
    setGraphAvailability(false);
    throw error;
  }
}

function moduleGroup(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (parts.length <= 1) return "root";
  if (parts.length === 2) return parts[0];
  return parts.slice(0, 2).join("/");
}

function moduleDisplayName(module) {
  return module.name || String(module.path || "module").split("/").pop();
}

function graphViewBoxSize() {
  const svg = $("#graph-canvas");
  const viewBox = svg.viewBox.baseVal;
  return { width: viewBox.width || 1180, height: viewBox.height || 660 };
}

function applyGraphTransform() {
  if (!state.graphWorld) return;
  const { scale, x, y } = state.graphView;
  state.graphWorld.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
  $("#graph-zoom-reset").textContent = `${Math.round(scale * 100)}%`;
}

function resetGraphView() {
  state.graphView = { scale: 1, x: 0, y: 0 };
  applyGraphTransform();
}

function changeGraphZoom(delta) {
  const next = Math.max(.55, Math.min(2.4, state.graphView.scale + delta));
  state.graphView.scale = Number(next.toFixed(2));
  applyGraphTransform();
}

function createGraphWorld() {
  const svg = $("#graph-canvas");
  svg.replaceChildren();
  state.graphWorld = svgElement("g", { id: "graph-world" });
  svg.appendChild(state.graphWorld);
  resetGraphView();
  return state.graphWorld;
}

/* --------------------------------------------------------------------------
   Reusable pan + zoom surface
   Every SVG graph that is not the architecture canvas owns its own view
   state. Drag the background to pan, scroll or use the tool buttons to zoom.
   -------------------------------------------------------------------------- */

const panZoomSurfaces = {};

function viewState(key) {
  if (!state[key] || typeof state[key] !== "object") state[key] = { scale: 1, x: 0, y: 0 };
  return state[key];
}

function applyPanZoom(view, world, label) {
  if (world) world.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.scale})`);
  if (label) label.textContent = `${Math.round(view.scale * 100)}%`;
}

function setupSvgPanZoom({ wrapId, svgId, viewKey, labelId, worldGetter, min = .35, max = 3 }) {
  const wrap = document.getElementById(wrapId);
  const svg = document.getElementById(svgId);
  if (!wrap || !svg) return null;
  const view = viewState(viewKey);
  const label = () => (labelId ? document.getElementById(labelId) : null);
  const apply = () => applyPanZoom(view, worldGetter(), label());
  const toSvgPoint = (event) => {
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const matrix = svg.getScreenCTM();
    return matrix ? point.matrixTransform(matrix.inverse()) : { x: 0, y: 0 };
  };
  const zoomBy = (delta, origin = null) => {
    const next = Number(Math.max(min, Math.min(max, view.scale + delta)).toFixed(2));
    if (next === view.scale) return;
    const box = svg.viewBox.baseVal;
    const cx = origin ? origin.x : (box.width || 0) / 2;
    const cy = origin ? origin.y : (box.height || 0) / 2;
    const ratio = next / view.scale;
    view.x = cx - (cx - view.x) * ratio;
    view.y = cy - (cy - view.y) * ratio;
    view.scale = next;
    apply();
  };
  const reset = () => {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    apply();
  };
  const fit = () => {
    const world = worldGetter();
    if (!world) return;
    const box = world.getBBox();
    const viewBox = svg.viewBox.baseVal;
    if (!box.width || !box.height || !viewBox.width || !viewBox.height) return;
    const scale = Number(Math.max(min, Math.min(max, Math.min(viewBox.width / box.width, viewBox.height / box.height) * .92)).toFixed(2));
    view.scale = scale;
    view.x = (viewBox.width - box.width * scale) / 2 - box.x * scale;
    view.y = (viewBox.height - box.height * scale) / 2 - box.y * scale;
    apply();
  };
  let drag = null;
  let suppressClick = false;
  wrap.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { point: toSvgPoint(event), startX: view.x, startY: view.y, moved: false };
    wrap.classList.add("is-panning");
    try { wrap.setPointerCapture?.(event.pointerId); } catch { /* pointer capture is optional */ }
  });
  wrap.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const point = toSvgPoint(event);
    const dx = point.x - drag.point.x;
    const dy = point.y - drag.point.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.startX + dx;
    view.y = drag.startY + dy;
    apply();
  });
  const endDrag = () => {
    if (drag?.moved) suppressClick = true;
    drag = null;
    wrap.classList.remove("is-panning");
  };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);
  wrap.addEventListener("pointerleave", endDrag);
  // A drag must not also open the node that happened to sit under the pointer.
  wrap.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);
  wrap.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    zoomBy(event.deltaY < 0 ? .12 : -.12, toSvgPoint(event));
  }, { passive: false });
  panZoomSurfaces[viewKey] = { zoomBy, reset, fit, apply };
  apply();
  return panZoomSurfaces[viewKey];
}

function zoomSurface(viewKey, delta) {
  panZoomSurfaces[viewKey]?.zoomBy(delta);
}

function resetSurface(viewKey) {
  panZoomSurfaces[viewKey]?.reset();
}

function fitSurface(viewKey) {
  panZoomSurfaces[viewKey]?.fit();
}

window.setupSvgPanZoom = setupSvgPanZoom;
window.zoomSurface = zoomSurface;
window.resetSurface = resetSurface;
window.fitSurface = fitSurface;

function enableNodeDrag(element, nodeId, positions, edgesList) {
  if (!element || !nodeId) return;
  element.style.cursor = "grab";
  let dragging = false;
  let startPointer = null;
  let startPos = null;
  let hasMoved = false;

  element.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const svg = document.getElementById("graph-canvas");
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM().inverse());
    startPointer = { x: svgP.x, y: svgP.y };
    const cur = positions.get(nodeId) || { x: 0, y: 0 };
    startPos = { ...cur };
    hasMoved = false;
    dragging = true;
    element.style.cursor = "grabbing";
    element.classList.add("is-dragging-node");

    const onPointerMove = (moveEvt) => {
      if (!dragging) return;
      moveEvt.stopPropagation();
      const mPt = svg.createSVGPoint();
      mPt.x = moveEvt.clientX;
      mPt.y = moveEvt.clientY;
      const curSvgP = mPt.matrixTransform(svg.getScreenCTM().inverse());
      const dx = curSvgP.x - startPointer.x;
      const dy = curSvgP.y - startPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) hasMoved = true;
      const newX = startPos.x + dx;
      const newY = startPos.y + dy;
      positions.set(nodeId, {
        ...startPos,
        x: newX,
        y: newY,
        centerX: newX + (startPos.width ? startPos.width / 2 : 0),
        centerY: newY + (startPos.height ? startPos.height / 2 : 0)
      });
      element.setAttribute("transform", `translate(${dx}, ${dy})`);

      if (Array.isArray(edgesList)) {
        edgesList.forEach((e) => {
          if (e.fromId === nodeId || e.toId === nodeId || e.source === nodeId || e.target === nodeId) {
            const p1 = positions.get(e.fromId || e.source);
            const p2 = positions.get(e.toId || e.target);
            if (p1 && p2 && e.path) {
              if (typeof e.updateFn === "function") {
                e.updateFn(p1, p2);
              } else if (typeof cgCurve === "function") {
                e.path.setAttribute("d", cgCurve(p1, p2, e.bend || 0.45));
              }
            }
          }
        });
      }
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      element.style.cursor = "grab";
      element.classList.remove("is-dragging-node");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  });

  element.addEventListener("click", (evt) => {
    if (hasMoved) {
      evt.stopPropagation();
      evt.preventDefault();
      hasMoved = false;
    }
  }, true);
}
window.enableNodeDrag = enableNodeDrag;

function renderModuleGraph(modules, imports, graph = null) {
  const svg = $("#graph-canvas");
  const world = createGraphWorld();
  const contributorActivity = state.inspection?.github?.contributor_activity?.length
    ? state.inspection.github.contributor_activity
    : (state.inspection?.github?.contributors || []).map((person) => ({
      ...person,
      login: person.login,
      commit_count: person.contributions || 0,
      last_commit: null,
    }));
  const graphNodes = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const graphEdges = graph?.edges || [];
  const moduleSymbols = state.inspection?.analysis?.module_symbols || {};
  const githubLoginByCommit = new Map(
    (state.inspection?.github?.commits || [])
      .filter((commit) => commit.sha && commit.author?.login)
      .map((commit) => [commit.sha, commit.author.login]),
  );
  const contributorLinks = new Map();
  const localContributorByGithubLogin = new Map();
  graphEdges
    .filter((edge) => edge.type === "AUTHORED")
    .forEach((authored) => {
      const commit = graphNodes.get(authored.target);
      const login = githubLoginByCommit.get(commit?.sha);
      if (login) localContributorByGithubLogin.set(login, authored.source);
      const modifiedFiles = graphEdges.filter((edge) => edge.type === "MODIFIED" && edge.source === authored.target);
      const moduleIds = contributorLinks.get(authored.source) || new Set();
      modifiedFiles.forEach((modified) => {
        const target = graphNodes.get(modified.target);
        const path = target?.path || target?.file_path;
        if (path) moduleIds.add(`module:${path}`);
      });
      contributorLinks.set(authored.source, moduleIds);
    });
  const groups = new Map();
  modules.filter((module) => module?.id).forEach((module) => {
    const key = moduleGroup(module.path || module.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(module);
  });
  const orderedGroups = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const groupWidth = 300;
  const groupGap = 28;
  const peopleRailWidth = contributorActivity.length ? 220 : 0;
  const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(orderedGroups.length))));
  const moduleRowHeight = 40;
  const groupHeaderHeight = 48;
  const rowHeights = [];
  const visibleModules = new Map();
  orderedGroups.forEach(([name, items], index) => {
    const displayItems = items.slice(0, 14);
    const hiddenCount = Math.max(0, items.length - displayItems.length);
    const height = groupHeaderHeight + (displayItems.length * moduleRowHeight) + (hiddenCount ? 28 : 0);
    const row = Math.floor(index / columns);
    rowHeights[row] = Math.max(rowHeights[row] || 0, height);
    visibleModules.set(name, displayItems);
  });
  const rowY = [];
  rowHeights.forEach((height, index) => { rowY[index] = 28 + rowHeights.slice(0, index).reduce((sum, value) => sum + value + 30, 0); });
  const groupStart = peopleRailWidth ? peopleRailWidth : 28;
  const width = Math.max(1180, groupStart + columns * groupWidth + (columns - 1) * groupGap + 60);
  const height = Math.max(660, rowHeights.reduce((sum, value) => sum + value + 30, 28));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const positions = new Map();
  orderedGroups.forEach(([name, items], index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
     const x = groupStart + column * (groupWidth + groupGap);
    const y = rowY[row];
    const displayItems = visibleModules.get(name) || [];
    const hiddenCount = Math.max(0, items.length - displayItems.length);
    const groupHeight = groupHeaderHeight + (displayItems.length * moduleRowHeight) + (hiddenCount ? 28 : 0);
    world.appendChild(svgElement("rect", { x, y, width: groupWidth, height: groupHeight, rx: 16, class: "graph-group-box" }));
    const groupLabel = svgElement("text", { x: x + 16, y: y + 22, class: "graph-group-label" });
    groupLabel.textContent = name === "root" ? "ROOT MODULES" : `/${name}`;
    world.appendChild(groupLabel);
    const groupCount = svgElement("text", { x: x + groupWidth - 16, y: y + 22, class: "graph-group-count", "text-anchor": "end" });
    groupCount.textContent = `${items.length} module${items.length === 1 ? "" : "s"}`;
    world.appendChild(groupCount);
    displayItems.forEach((module, moduleIndex) => {
      const nodeY = y + groupHeaderHeight + moduleIndex * moduleRowHeight;
      positions.set(module.id, { x: x + 12, y: nodeY, width: groupWidth - 24, centerX: x + groupWidth / 2, centerY: nodeY + 15 });
    });
    if (hiddenCount) {
      const more = svgElement("text", { x: x + 16, y: y + groupHeight - 11, class: "graph-group-count" });
      more.textContent = `+ ${hiddenCount} more modules`;
      world.appendChild(more);
    }
  });
  const contributorPositions = new Map();
  if (contributorActivity.length) {
    const peopleBoxHeight = Math.min(height - 40, 58 + contributorActivity.length * 58);
    world.appendChild(svgElement("rect", { x: 20, y: 28, width: 178, height: peopleBoxHeight, rx: 16, class: "graph-people-box" }));
    const peopleLabel = svgElement("text", { x: 36, y: 49, class: "graph-group-label" });
    peopleLabel.textContent = "PEOPLE";
    world.appendChild(peopleLabel);
    contributorActivity.forEach((person, index) => {
      const y = 70 + index * 58;
      const localContributorId = localContributorByGithubLogin.get(person.login);
      contributorPositions.set(localContributorId || `github:${person.login}`, { x: 36, y: y + 12 });
      const personGroup = svgElement("g", { class: "graph-person-node" });
      personGroup.appendChild(svgElement("circle", { cx: 47, cy: y + 12, r: 14, class: "graph-avatar-ring" }));
      if (person.avatar_url) {
        personGroup.appendChild(svgElement("image", { href: person.avatar_url, x: 34, y: y - 1, width: 26, height: 26, "clip-path": "circle(13px at 13px 13px)" }));
      } else {
        const initial = svgElement("text", { x: 47, y: y + 16, class: "graph-avatar-initial", "text-anchor": "middle" });
        initial.textContent = String(person.login || "?").slice(0, 1).toUpperCase();
        personGroup.appendChild(initial);
      }
      const label = svgElement("text", { x: 69, y: y + 10, class: "graph-person-label" });
      label.textContent = String(person.login || "unknown").slice(0, 18);
      personGroup.appendChild(label);
      const count = svgElement("text", { x: 69, y: y + 23, class: "graph-person-count" });
      count.textContent = `${person.commit_count || 0} commits`;
      personGroup.appendChild(count);
      world.appendChild(personGroup);
    });
  }
  const edgeLayer = svgElement("g");
  (imports || []).slice(0, 240).forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target_module);
    if (!source || !target || edge.source === edge.target_module) return;
     const startX = source.x + source.width;
    const startY = source.centerY;
    const endX = target.x;
    const endY = target.centerY;
    const bend = Math.max(24, Math.abs(endX - startX) * .38);
    edgeLayer.appendChild(svgElement("path", { d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`, class: "graph-edge" }));
  });
  contributorPositions.forEach((personPosition, contributorId) => {
    const moduleIds = contributorLinks.get(contributorId) || new Set();
    [...moduleIds].slice(0, 8).forEach((moduleId) => {
      const target = positions.get(moduleId);
      if (!target) return;
      const startX = personPosition.x + 158;
      const startY = personPosition.y;
      const endX = target.x + 10;
      const endY = target.centerY;
      const bend = Math.max(18, (endX - startX) * .22);
      edgeLayer.appendChild(svgElement("path", { d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`, class: "graph-person-edge" }));
    });
  });
  world.insertBefore(edgeLayer, world.firstChild);
  orderedGroups.forEach(([, items]) => {
    (visibleModules.get(moduleGroup(items[0]?.path || items[0]?.name)) || []).forEach((module) => {
      const position = positions.get(module.id);
      if (!position) return;
      const symbols = moduleSymbols[module.id] || [];
      const node = svgElement("g", { class: `graph-node${state.selectedModule === module.id ? " selected" : ""}`, tabindex: "0", role: "button", "aria-label": `Module: ${moduleDisplayName(module)} with ${symbols.length} symbols` });
      node.appendChild(svgElement("rect", { x: position.x, y: position.y, width: position.width, height: 31, rx: 8, class: "graph-module-box" }));
      const label = svgElement("text", { x: position.x + 11, y: position.y + 13, class: "graph-module-label" });
      label.textContent = moduleDisplayName(module).slice(0, 28);
      node.appendChild(label);
      const path = svgElement("text", { x: position.x + 11, y: position.y + 25, class: "graph-module-path" });
      path.textContent = String(module.path || "").slice(0, 38);
      node.appendChild(path);
      const symbolCount = svgElement("text", { x: position.x + position.width - 11, y: position.y + 18, class: "graph-module-symbols", "text-anchor": "end" });
      symbolCount.textContent = `${symbols.length} sym`;
      node.appendChild(symbolCount);
      const title = svgElement("title");
      title.textContent = `${moduleDisplayName(module)} · ${module.path || ""} · ${symbols.length} symbols`;
      node.appendChild(title);
      node.addEventListener("click", () => selectModule(module));
      node.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectModule(module); } });
      world.appendChild(node);
    });
  });
  const symbolCount = Object.values(moduleSymbols).reduce((sum, items) => sum + (items?.length || 0), 0);
  $("#graph-meta").textContent = `${formatNumber(modules.length)} modules · ${formatNumber(imports?.length || 0)} imports · ${formatNumber(symbolCount)} symbols`;
  $("#graph-state").hidden = true;
  applyGraphTransform();
}

function renderFallbackGraph(graph) {
  const files = (graph?.nodes || []).filter((node) => graphNodeType(node) === "File");
  if (!files.length) {
    $("#graph-meta").textContent = "No visible architecture";
    setGraphState("The active repository has no visible module relationships yet.");
    return;
  }
  const modules = files.slice(0, 90).map((node) => ({ id: node.id, name: node.path, path: node.path, language: node.language }));
  const imports = [];
  renderModuleGraph(modules, imports);
  $("#graph-meta").textContent = `${formatNumber(files.length)} tracked files · module analysis unavailable`;
}

function createGraphIcon(type, x, y, size = 16, color = "currentColor") {
  const svgFn = (tag, attrs = {}) => {
    if (typeof svgElement === "function") return svgElement(tag, attrs);
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };
  const g = svgFn("g", {
    class: "graph-vector-icon",
    transform: `translate(${x}, ${y})`,
    stroke: color,
    fill: "none",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true"
  });

  const addPath = (d, fill = "none", stroke = color, width = "1.5") => {
    const p = svgFn("path", { d, fill, stroke, "stroke-width": width });
    g.appendChild(p);
    return p;
  };
  const addCircle = (cx, cy, r, fill = "none", stroke = color, width = "1.5") => {
    const c = svgFn("circle", { cx, cy, r, fill, stroke, "stroke-width": width });
    g.appendChild(c);
    return c;
  };
  const addRect = (rx, ry, w, h, radius = 2, fill = "none", stroke = color, width = "1.5") => {
    const r = svgFn("rect", { x: rx, y: ry, width: w, height: h, rx: radius, fill, stroke, "stroke-width": width });
    g.appendChild(r);
    return r;
  };
  const addLine = (x1, y1, x2, y2, stroke = color, width = "1.5") => {
    const l = svgFn("line", { x1, y1, x2, y2, stroke, "stroke-width": width });
    g.appendChild(l);
    return l;
  };

  const key = String(type || "").toLowerCase();
  switch (key) {
    case "contributor":
    case "user":
    case "author":
      addCircle(8, 5, 3.2);
      addPath("M 2.5 14.5 C 2.5 11 5 9.8 8 9.8 C 11 9.8 13.5 11 13.5 14.5");
      break;
    case "commit":
      addCircle(8, 8, 3.2);
      addLine(1, 8, 4.8, 8);
      addLine(11.2, 8, 15, 8);
      break;
    case "file":
      addPath("M 3.5 1.5 L 9.5 1.5 L 13.5 5.5 L 13.5 14.5 L 3.5 14.5 Z");
      addPath("M 9.5 1.5 L 9.5 5.5 L 13.5 5.5");
      break;
    case "function":
    case "symbol":
      addPath("M 9 2.5 C 7.5 2.5 6.5 3.5 6.5 5 C 6.5 6.5 8 7.5 8 9 C 8 10.5 6.5 12 5 12.5");
      addLine(4, 7, 10, 7);
      break;
    case "class":
      addRect(2.5, 2.5, 11, 11, 2);
      addLine(2.5, 6.5, 13.5, 6.5);
      addLine(6.5, 6.5, 6.5, 13.5);
      break;
    case "configkey":
    case "config":
      addLine(2, 5, 14, 5);
      addCircle(6, 5, 2, color);
      addLine(2, 11, 14, 11);
      addCircle(10, 11, 2, color);
      break;
    case "decision":
      addPath("M 8 1.5 L 14 8 L 8 14.5 L 2 8 Z");
      addCircle(8, 8, 1.8, color, color);
      break;
    case "frontend":
      addRect(1.5, 2, 13, 9, 1.5);
      addLine(5, 14, 11, 14);
      addLine(8, 11, 8, 14);
      break;
    case "backend":
      addRect(2.5, 2.5, 11, 11, 2);
      addRect(5.5, 5.5, 5, 5, 1, color, "none");
      addLine(8, 0.5, 8, 2.5);
      addLine(8, 13.5, 8, 15.5);
      addLine(0.5, 8, 2.5, 8);
      addLine(13.5, 8, 15.5, 8);
      break;
    case "database":
      addPath("M 2 4 C 2 2.5 4.7 1.5 8 1.5 C 11.3 1.5 14 2.5 14 4 C 14 5.5 11.3 6.5 8 6.5 C 4.7 6.5 2 5.5 2 4 Z");
      addPath("M 2 4 V 8.5 C 2 10 4.7 11 8 11 C 11.3 11 14 10 14 8.5 V 4");
      addPath("M 2 8.5 V 13 C 2 14.5 4.7 15.5 8 15.5 C 11.3 15.5 14 14.5 14 13 V 8.5");
      break;
    case "ci":
      addRect(1.5, 2, 13, 12, 2);
      addPath("M 5 6 L 8 8 L 5 10");
      addLine(9.5, 10, 12, 10);
      break;
    case "infrastructure":
      addPath("M 4.5 13 C 3 13 2 11.8 2 10.3 C 2 9 3 8 4.2 7.8 C 4.8 5.5 6.7 4 9 4 C 11.6 4 13.5 5.8 13.8 8.3 C 14.7 8.7 15.5 9.7 15.5 10.8 C 15.5 12 14.5 13 13.2 13 Z");
      break;
    case "docs":
      addPath("M 2 3 C 4.5 2.5 7 3.3 8 4.5 C 9 3.3 11.5 2.5 14 3 V 13 C 11.5 12.5 9 13.3 8 14.5 C 7 13.3 4.5 12.5 2 13 Z");
      addLine(8, 4.5, 8, 14.5);
      break;
    default:
      addCircle(8, 8, 4.5);
      break;
  }
  return g;
}

function renderEvidenceGraph(graph) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const commits = nodes.filter((node) => graphNodeType(node) === "Commit").sort((a, b) => (a.history_index || 0) - (b.history_index || 0)).slice(0, 16);
  const commitIds = new Set(commits.map((node) => node.id));
  const contributorIds = new Set(edges.filter((edge) => edge.type === "AUTHORED" && commitIds.has(edge.target)).map((edge) => edge.source));
  const contributors = [...contributorIds].map((id) => byId.get(id)).filter(Boolean).slice(0, 14);
  const knownLogins = new Set(contributors.map((node) => String(node.username || node.display_name || node.login || "").toLowerCase()));
  (state.inspection?.github?.contributors || []).forEach((person) => {
    const login = String(person.login || "").trim();
    if (!login || knownLogins.has(login.toLowerCase())) return;
    knownLogins.add(login.toLowerCase());
    contributors.push({
      id: `github-contributor:${login}`,
      labels: ["Contributor"],
      login,
      avatar_url: person.avatar_url,
      html_url: person.html_url,
      contributions: person.contributions,
      verified_github: true,
    });
  });
  const codeIds = new Set(edges.filter((edge) => edge.type === "MODIFIED" && commitIds.has(edge.source)).map((edge) => edge.target));
  const code = [...codeIds].map((id) => byId.get(id)).filter((node) => node && ["File", "Function", "Class", "ConfigKey"].includes(graphNodeType(node))).slice(0, 28);
  const decisionIds = new Set(edges.filter((edge) => edge.type === "RESULTED_IN" && commitIds.has(edge.source)).map((edge) => edge.target));
  const decisions = [...decisionIds].map((id) => byId.get(id)).filter(Boolean).slice(0, 12);
  if (!commits.length && !code.length) {
    setGraphState("The active repository has no visible history relationships yet.");
    $("#graph-meta").textContent = "No evidence relationships";
    return;
  }
  const selectedIds = new Set([...contributors, ...commits, ...code, ...decisions].map((node) => node.id));
  const width = 1600;
  const height = 880;
  const top = 76;
  const lanes = [
    { key: "contributors", title: "AUTHORS & CONTRIBUTORS", items: contributors, x: 30, width: 280 },
    { key: "commits", title: "COMMITS & HISTORY", items: commits, x: 340, width: 360 },
    { key: "code", title: "CHANGED ENTITIES (FILES & CODE)", items: code, x: 730, width: 500, isGrid: true },
    { key: "decisions", title: "INFERRED DECISIONS & MILESTONES", items: decisions, x: 1260, width: 310 },
  ];
  const svg = $("#graph-canvas");
  const world = createGraphWorld();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const positions = new Map();

  lanes.forEach((lane) => {
    world.appendChild(svgElement("rect", { x: lane.x, y: 26, width: lane.width, height: height - 56, rx: 16, class: "relationship-lane" }));
    const heading = svgElement("text", { x: lane.x + 18, y: 52, class: "relationship-lane-title" });
    heading.textContent = lane.title;
    world.appendChild(heading);

    if (lane.isGrid) {
      const colWidth = (lane.width - 34) / 2;
      lane.items.forEach((node, index) => {
        const col = index % 2;
        const row = Math.floor(index / 2);
        const cardX = lane.x + 12 + col * (colWidth + 10);
        const cardY = top + row * 52;
        positions.set(node.id, { x: cardX, y: cardY, width: colWidth, height: 44, centerX: cardX + colWidth / 2, centerY: cardY + 22 });
      });
    } else {
      lane.items.forEach((node, index) => {
        const cardY = top + index * 54;
        positions.set(node.id, { x: lane.x + 14, y: cardY, width: lane.width - 28, height: 44, centerX: lane.x + lane.width / 2, centerY: cardY + 22 });
      });
    }
  });

  const edgeList = [];
  const edgeLayer = svgElement("g", { class: "relationship-edges" });
  edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)).forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;
    const updatePath = (p1, p2) => {
      const startX = p1.x + p1.width;
      const endX = p2.x;
      const bend = Math.max(22, Math.abs(endX - startX) * 0.36);
      return `M ${startX} ${p1.centerY} C ${startX + bend} ${p1.centerY}, ${endX - bend} ${p2.centerY}, ${endX} ${p2.centerY}`;
    };
    const line = svgElement("path", { d: updatePath(source, target), class: `relationship-edge relationship-${edge.type.toLowerCase()}` });
    const title = svgElement("title");
    title.textContent = edge.type;
    line.appendChild(title);
    edgeLayer.appendChild(line);
    edgeList.push({ path: line, fromId: edge.source, toId: edge.target, updateFn: (p1, p2) => line.setAttribute("d", updatePath(p1, p2)) });
  });
  world.appendChild(edgeLayer);

  lanes.forEach((lane) => lane.items.forEach((node) => {
    const position = positions.get(node.id);
    if (!position) return;
    const type = graphNodeType(node);
    const group = svgElement("g", { class: `relationship-node relationship-${type.toLowerCase()}`, tabindex: "0", role: "button", "aria-label": `${type}: ${entityTitle(node)}` });
    group.appendChild(svgElement("rect", { x: position.x, y: position.y, width: position.width, height: position.height, rx: 10, class: "relationship-node-box" }));
    const iconColors = {
      contributor: "#2d6a4f",
      commit: "#0077b6",
      file: "#475569",
      function: "#d97706",
      class: "#7c3aed",
      configkey: "#475569",
      decision: "#9333ea"
    };
    const iconColor = iconColors[type.toLowerCase()] || "#475569";
    const icon = createGraphIcon(type, position.x + 9, position.y + 13, 16, iconColor);
    group.appendChild(icon);
    const title = svgElement("text", { x: position.x + 31, y: position.y + 19, class: "relationship-node-title", "font-size": "11.5", "font-weight": "750" });
    title.textContent = String(entityTitle(node)).slice(0, 24);
    group.appendChild(title);
    const subtitle = svgElement("text", { x: position.x + 31, y: position.y + 35, class: "relationship-node-subtitle", "font-size": "9.5" });
    subtitle.textContent = String(node.path || node.message || node.username || node.sha || type).slice(0, 30);
    group.appendChild(subtitle);
    const tooltip = svgElement("title");
    tooltip.textContent = `${type} · ${entityTitle(node)}`;
    group.appendChild(tooltip);
    if (["File", "Function", "Class", "ConfigKey"].includes(type)) {
      group.addEventListener("click", () => selectEntity(node.id));
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectEntity(node.id); } });
    }
    enableNodeDrag(group, node.id, positions, edgeList);
    world.appendChild(group);
  }));

  $("#graph-meta").textContent = `${formatNumber(contributors.length)} contributors · ${formatNumber(commits.length)} commits · ${formatNumber(code.length)} code entities · ${formatNumber(decisions.length)} decisions`;
  $("#graph-state").hidden = true;
  applyGraphTransform();
}

function renderGraph(graph) {
  const relationships = state.inspection?.analysis?.module_relationships;
  updateGraphLegend();
  document.getElementById("graph-wrap")?.classList.toggle("is-code", state.graphMode === "code");
  if (state.graphMode === "evidence") renderEvidenceGraph(graph);
  else if (state.graphMode === "code") {
    if (typeof renderCodeGraph === "function") renderCodeGraph(graph);
    else renderFallbackGraph(graph);
  } else if (state.graphMode === "architecture") renderArchitectureGraph();
  else if (relationships?.modules?.length) renderModuleGraph(relationships.modules, relationships.imports || [], graph);
  else renderFallbackGraph(graph);
  renderGraphInsights();
  if (state.graphLoaded && !state._architectureAiGenerated) {
    window.setTimeout(() => generateArchitectureAIUnderstanding(false), 200);
  }
}

function renderArchitectureGraph() {
  const svg = $("#graph-canvas");
  const stateEl = $("#graph-state");
  const architecture = state.inspection?.analysis?.architecture || {};
  let nodes = architecture.nodes || [];
  let edges = architecture.edges || [];

  if ((!nodes.length || nodes.length < 3) && state.graphLoaded) {
    const fileNodes = (state.graph?.nodes || []).filter((n) => graphNodeType(n) === "File");
    const paths = fileNodes.map((n) => n.path || n.name || "");
    const matching = (patterns) => paths.filter((p) => patterns.some((pattern) => p.toLowerCase().includes(pattern.toLowerCase())));

    const frontendPaths = matching(["components", "pages", "app", "public", "static", ".html", ".css", ".jsx", ".tsx", ".vue", "web", "ui", "demo", "notebooks", ".ipynb"]);
    const backendPaths = matching(["api", "server", "backend", "services", "manage.py", "main.py", "app.py", "pathway", "src", "lib", "engine", "core", "cargo.toml", ".py", ".rs", ".go"]);
    const dbPaths = matching(["migrations", "prisma", "models", ".sql", "alembic", "connectors", "storage", "tables", "kafka", "postgres", "redis", "sinks", "sources", "db"]);
    const infraPaths = matching(["docker", "k8s", "kubernetes", "helm", ".tf", "terraform", "requirements.txt", "cargo.lock", ".env", "compose"]);
    const ciPaths = matching([".github", "workflows", "gitlab-ci", "jenkinsfile", "circleci", "release.yml", "test.yml"]);
    const docsPaths = matching(["readme", "contributing", "license", "security", ".md", "docs", "tutorial"]);

    const defs = [
      { category: "frontend", label: "Frontend & UI", paths: frontendPaths, signals: ["UI components, templates & web assets"] },
      { category: "backend", label: "Backend / Core Engine", paths: backendPaths.length ? backendPaths : paths.slice(0, 10), signals: ["Core runtime, dataflow & algorithmic pipelines"] },
      { category: "database", label: "Database & Storage", paths: dbPaths.length ? dbPaths : ["streaming storage / tables"], signals: ["Data persistence, tables & streaming sinks"] },
      { category: "ci", label: "CI / Delivery", paths: ciPaths.length ? ciPaths : [".github/workflows"], signals: ["Automated testing & release pipelines"] },
      { category: "infrastructure", label: "Infrastructure & Runtime", paths: infraPaths.length ? infraPaths : ["runtime environment"], signals: ["Execution environment & container specs"] },
      { category: "docs", label: "Documentation & Specs", paths: docsPaths.length ? docsPaths : ["README.md"], signals: ["Architecture documentation & guides"] },
    ];

    nodes = defs.map((d) => ({
      id: `architecture:${d.category}`,
      category: d.category,
      label: d.label,
      confidence: "observed",
      signals: d.signals,
      paths: d.paths.length ? d.paths.slice(0, 8) : [d.signals[0]],
      explanation: `${d.label} supported by ${d.paths.length} detected files.`,
    }));

    edges = [
      { source: "architecture:frontend", target: "architecture:backend", label: "client requests API / engine", confidence: "inferred" },
      { source: "architecture:backend", target: "architecture:database", label: "engine reads/writes storage & connectors", confidence: "inferred" },
      { source: "architecture:ci", target: "architecture:infrastructure", label: "delivery configures deployment", confidence: "inferred" },
      { source: "architecture:infrastructure", target: "architecture:backend", label: "packages service & engine runtime", confidence: "inferred" },
      { source: "architecture:infrastructure", target: "architecture:frontend", label: "packages UI assets", confidence: "inferred" },
      { source: "architecture:docs", target: "architecture:backend", label: "specifies system invariants", confidence: "inferred" },
    ];
  }

  if (!svg || !nodes.length) {
    if (svg) svg.innerHTML = "";
    if (stateEl) {
      stateEl.hidden = false;
      stateEl.textContent = state.graphLoaded ? "No deterministic architecture signals were found in the tracked repository." : "Inspect a repository to infer its architecture.";
    }
    $("#graph-meta").textContent = "No architecture signals";
    return;
  }

  const width = 1380;
  const height = 740;
  const nodeWidth = 340;
  const nodeHeight = 140;
  const coordinates = {
    frontend: [80, 80],
    backend: [520, 80],
    database: [960, 80],
    ci: [80, 420],
    infrastructure: [520, 420],
    docs: [960, 420],
  };
  const positions = new Map();
  nodes.forEach((node, index) => {
    const point = coordinates[node.category] || [80 + (index % 3) * 440, 580 + Math.floor(index / 3) * 160];
    positions.set(node.id, { x: point[0], y: point[1], width: nodeWidth, height: nodeHeight, centerX: point[0] + nodeWidth / 2, centerY: point[1] + nodeHeight / 2 });
  });

  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const world = svgElement("g", { class: "graph-world architecture-world" });
  state.graphWorld = world;

  const defs = svgElement("defs");
  const marker = svgElement("marker", { id: "architecture-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  const edgeList = [];
  const edgeLayer = svgElement("g", { class: "architecture-edges" });
  edges.forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;
    const updatePath = (p1, p2) => {
      const forward = p2.x >= p1.x;
      const startX = forward ? p1.x + p1.width : p1.x;
      const endX = forward ? p2.x : p2.x + p2.width;
      const startY = p1.y + p1.height / 2;
      const endY = p2.y + p2.height / 2;
      const bend = Math.max(28, Math.abs(endX - startX) * 0.34);
      return `M ${startX} ${startY} C ${forward ? startX + bend : startX - bend} ${startY}, ${forward ? endX - bend : endX + bend} ${endY}, ${endX} ${endY}`;
    };
    const path = svgElement("path", { d: updatePath(source, target), class: "architecture-edge", "marker-end": "url(#architecture-arrow)" });
    const title = svgElement("title");
    title.textContent = edge.label || "inferred relationship";
    path.appendChild(title);
    edgeLayer.appendChild(path);
    const label = svgElement("text", { x: (source.centerX + target.centerX) / 2, y: (source.centerY + target.centerY) / 2 - 8, class: "architecture-edge-label", "text-anchor": "middle" });
    label.textContent = edge.label || "inferred flow";
    edgeLayer.appendChild(label);

    edgeList.push({
      path,
      fromId: edge.source,
      toId: edge.target,
      updateFn: (p1, p2) => {
        path.setAttribute("d", updatePath(p1, p2));
        label.setAttribute("x", (p1.centerX + p2.centerX) / 2);
        label.setAttribute("y", (p1.centerY + p2.centerY) / 2 - 8);
      }
    });
  });
  world.appendChild(edgeLayer);

  nodes.forEach((node) => {
    const position = positions.get(node.id);
    if (!position) return;
    const group = svgElement("g", { class: `architecture-node architecture-${node.category}`, tabindex: "0", role: "button", "aria-label": `${node.label}: ${node.explanation || ""}` });
    group.appendChild(svgElement("rect", { x: position.x, y: position.y, width: position.width, height: position.height, rx: 16, class: "architecture-node-box" }));
    const categoryColors = {
      frontend: "#058c42",
      backend: "#1d63b8",
      database: "#b35c00",
      ci: "#6930c3",
      infrastructure: "#b5179e",
      docs: "#2b2d42"
    };
    const iconColor = categoryColors[node.category] || "#153e35";
    const icon = createGraphIcon(node.category, position.x + 18, position.y + 17, 18, iconColor);
    group.appendChild(icon);
    const title = svgElement("text", { x: position.x + 44, y: position.y + 31, class: "architecture-node-title" });
    title.textContent = node.label;
    group.appendChild(title);
    const confidence = svgElement("text", { x: position.x + 18, y: position.y + 56, class: "architecture-node-confidence" });
    confidence.textContent = `${node.confidence || "observed"} · ${formatNumber((node.paths || []).length)} evidence files`;
    group.appendChild(confidence);
    const evidence = svgElement("text", { x: position.x + 18, y: position.y + 86, class: "architecture-node-path" });
    evidence.textContent = String(node.paths?.[0] || "tracked repository signal").slice(0, 38);
    group.appendChild(evidence);
    const signal = svgElement("text", { x: position.x + 18, y: position.y + 110, class: "architecture-node-path" });
    signal.textContent = String(node.signals?.[0] || (node.paths?.[1] ? node.paths[1] : "deterministic detector")).slice(0, 38);
    group.appendChild(signal);
    const titleNode = svgElement("title");
    titleNode.textContent = `${node.label} · ${node.explanation || ""}`;
    group.appendChild(titleNode);
    group.addEventListener("click", () => openGraphSourcePath(node.paths?.[0]));
    group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openGraphSourcePath(node.paths?.[0]); } });

    enableNodeDrag(group, node.id, positions, edgeList);
    world.appendChild(group);
  });
  svg.appendChild(world);
  if (stateEl) stateEl.hidden = true;
  $("#graph-meta").textContent = `${formatNumber(nodes.length)} architecture layers · ${formatNumber(edges.length)} inferred flows`;
  applyGraphTransform();
}

const GRAPH_EDGE_SEMANTICS = {
  AUTHORED: "a contributor wrote a commit",
  MODIFIED: "a commit touched a file, function, or config key",
  RESULTED_IN: "a commit produced a recorded decision",
  IMPORTS: "one module imports another",
  CALLS: "one symbol calls another",
  DEFINES: "a file defines a symbol",
  PART_OF: "an entity belongs to a folder or module",
  SUPERSEDES: "a newer decision replaced an older one",
};

function openGraphSourcePath(path) {
  if (!path) return;
  showWorkspacePage("source");
  window.setTimeout(() => {
    if (typeof loadSource === "function") loadSource(path);
  }, 60);
}

async function generateArchitectureAIUnderstanding(force = false) {
  const content = $("#architecture-ai-content");
  const status = $("#architecture-ai-status");
  if (!content) return;
  if (!state.graphLoaded) {
    content.innerHTML = '<div class="empty-state">Inspect a repository to generate AI architecture understanding.</div>';
    if (status) status.textContent = "No repository loaded";
    return;
  }
  if (!force && state._architectureAiGenerated) {
    return;
  }
  if (status) status.textContent = "Analyzing...";
  content.innerHTML = '<div class="empty-state"><span class="loading-spinner" aria-hidden="true"></span> Generating architecture understanding from the graph...</div>';
  try {
    const repo = state.inspection?.github?.repository || state.inspection?.repository || state.summary?.repository || {};
    const summary = state.summary || {};
    const graph = state.graph || {};
    const analysis = state.inspection?.analysis || {};
    const prompt = `Provide a concise, evidence-based architecture understanding for this repository.\nRepository: ${repo.full_name || repo.name || "unknown"}\nFiles: ${summary.counts?.files || 0}, Functions: ${summary.counts?.functions || 0}, Commits: ${summary.counts?.commits || 0}\nModules: ${analysis.summary?.module_count || 0}, Imports: ${analysis.summary?.import_count || 0}\nArchitecture layers: ${(analysis.architecture?.nodes || []).length}\nFocus on: system design, key components, data flow, dependencies, and notable patterns. Be specific to this repo based on structure.`;
    const payload = await api("/api/ai/room", {
      method: "POST",
      body: JSON.stringify({
        question: prompt,
        ai_assist: true,
      }),
    });
    const answer = payload?.ai?.text || payload?.result?.answer || payload?.answer || "";
    if (answer) {
      const lines = typeof answer === "string" ? answer.split("\n").map((text) => ({ text })) : [];
      content.innerHTML = `<div class="architecture-ai-text">${renderMarkdown(lines, "architecture.md")}</div>`;
      if (status) status.textContent = `AI analysis complete · ${payload?.ai?.provider || "local graph"}`;
      state._architectureAiGenerated = true;
    } else {
      content.innerHTML = '<div class="empty-state">No AI understanding generated. The graph evidence is available above.</div>';
      if (status) status.textContent = "No response";
    }
  } catch (error) {
    content.innerHTML = `<div class="empty-state">${escapeHtml(error.message || "Failed to generate AI understanding")}</div>`;
    if (status) status.textContent = "Error";
  }
}

function renderGraphInsights() {
  const readHost = $("#graph-insight-read");
  if (!readHost) return;
  const graph = state.graph;
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const relationships = state.inspection?.analysis?.module_relationships;
  const modules = relationships?.modules || [];
  const imports = relationships?.imports || [];
  const architecture = state.inspection?.analysis?.architecture || {};
  const inbound = new Map();
  const outbound = new Map();
  imports.filter((item) => item.target_module).forEach((item) => {
    outbound.set(item.source, (outbound.get(item.source) || 0) + 1);
    inbound.set(item.target_module, (inbound.get(item.target_module) || 0) + 1);
  });
  const ranked = state.graphMode === "architecture"
    ? (architecture.nodes || []).map((node) => ({
      ...node,
      name: node.label,
      path: node.paths?.[0] || "",
      inbound: (architecture.edges || []).filter((edge) => edge.target === node.id).length,
      outbound: (architecture.edges || []).filter((edge) => edge.source === node.id).length,
    }))
    : modules
    .map((module) => ({ ...module, inbound: inbound.get(module.id) || 0, outbound: outbound.get(module.id) || 0 }))
    .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound) || a.name.localeCompare(b.name))
    .slice(0, 6);
  const readText = {
    evidence: nodes.length
      ? "Each lane narrows the story: authors on the left, their commits, the code those commits modified, and any decision the change produced. Lines follow recorded edges only, so a gap means the repository never recorded that link."
      : "Inspect a repository to arrange contributors, commits, code entities, and decisions into evidence lanes.",
    code: nodes.length
      ? "The map starts at the repository, branches into contributors and commits, then fans out to the files and symbols those commits touched. Import and call edges describe how the code holds together, independent of who wrote it."
      : "Inspect a repository to draw the repository, contributors, commits, files, and symbols in one map.",
    modules: modules.length
      ? `${formatNumber(modules.length)} modules and ${formatNumber(imports.length)} imports are grouped by folder. Click a module below to open its file in the source explorer; the ranking follows how many imports a module sends and receives.`
      : "Module relationships appear after a source analysis. Inspect a repository to build them.",
    architecture: architecture.nodes?.length
      ? `${formatNumber(architecture.nodes.length)} deterministic layers connect observed repository signals. Click a layer to open its strongest evidence file. ${architecture.note || ""}`
      : "Architecture signals appear when tracked configuration and source files identify application layers.",
  }[state.graphMode] || "Choose Evidence, Code graph, or Modules to read this map.";
  readHost.textContent = readText;

  const rankHost = $("#graph-rank-list");
  const rankNote = $("#graph-insight-rank-note");
  if (rankHost) {
    rankHost.innerHTML = ranked.length
      ? ranked.map((module) => `<li><button class="graph-rank-row" type="button" data-graph-open-path="${escapeHtml(module.path)}" title="Open ${escapeHtml(module.path)}"><span>${escapeHtml(module.name)}</span><small>${formatNumber(module.outbound)} out · ${formatNumber(module.inbound)} in</small></button></li>`).join("")
      : '<li class="graph-insight-empty">No module relationships were recorded for this snapshot.</li>';
    rankHost.querySelectorAll("[data-graph-open-path]").forEach((button) => {
      button.addEventListener("click", () => openGraphSourcePath(button.dataset.graphOpenPath));
    });
  }
   if (rankNote) rankNote.textContent = ranked.length ? state.graphMode === "architecture" ? `${formatNumber(ranked.length)} detected layers` : `top ${formatNumber(ranked.length)} of ${formatNumber(modules.length)}` : "no analysis yet";

  const edgeHost = $("#graph-edge-list");
  if (!edgeHost) return;
  const counts = new Map();
  edges.forEach((edge) => counts.set(edge.type, (counts.get(edge.type) || 0) + 1));
  if (imports.length) counts.set("IMPORTS", (counts.get("IMPORTS") || 0) + imports.length);
  const rows = [...counts.entries()]
    .filter(([type]) => GRAPH_EDGE_SEMANTICS[type])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  edgeHost.innerHTML = rows.length
    ? rows.map(([type, count]) => `<li><span class="graph-edge-type">${escapeHtml(type.toLowerCase().replaceAll("_", " "))}</span><small>${escapeHtml(GRAPH_EDGE_SEMANTICS[type])} · ${formatNumber(count)}</small></li>`).join("")
    : '<li class="graph-insight-empty">No relationships were recorded in this snapshot.</li>';

  generateArchitectureAIUnderstanding();
}

function updateGraphLegend() {
  const evidence = document.getElementById("graph-legend");
  const code = document.getElementById("graph-code-legend");
  const architecture = document.getElementById("graph-architecture-legend");
  if (evidence) evidence.hidden = state.graphMode === "code";
  if (code) code.hidden = state.graphMode !== "code";
  if (architecture) architecture.hidden = state.graphMode !== "architecture";
}

function createTreeNode(name, path = "") {
  return { name, path, folders: new Map(), files: [] };
}

const ICON_PATHS = {
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.1a2 2 0 0 1 1.4.6L11.5 7h7A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
  folderOpen: '<path d="M3 8.2A2.4 2.4 0 0 1 5.4 6h3a2 2 0 0 1 1.4.6L11.3 8h6.2A2.5 2.5 0 0 1 20 10.5V11"/><path d="M3 9.6h16.9a1.1 1.1 0 0 1 1.06 1.4l-1.7 6.1A2 2 0 0 1 17.3 19H5.4A2.4 2.4 0 0 1 3 16.6Z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  code: '<path d="m8 9-3 3 3 3M16 9l3 3-3 3M14 6l-4 12"/>',
  html: '<path d="m8 4-5 2 1 13 8 2 8-2 1-13-5-2"/><path d="m8 8 4 1 4-1M8 12l4 1 4-1M8 16l4 1 4-1"/>',
  python: '<path d="M12 3c-4 0-4 2-4 4v2h8V7c0-2 0-4-4-4Z"/><path d="M12 21c4 0 4-2 4-4v-2H8v2c0 2 0 4 4 4Z"/><circle cx="10" cy="6" r=".7"/><circle cx="14" cy="18" r=".7"/>',
  javascript: '<path d="M4 3h16v18H4z"/><path d="M8 17c0 1 1 2 2 2s2-1 2-2v-5M15 13c0-1 1-1 2-1 1 0 2 1 2 2 0 2-4 1-4 3 0 1 1 2 2 2 1 0 2-1 2-2"/>',
  typescript: '<path d="M4 3h16v18H4z"/><path d="M7 9h6M10 9v8M15 14c0-1 1-1 2-1 1 0 2 1 2 2 0 2-4 1-4 3 0 1 1 2 2 2"/>',
  styles: '<path d="M4 4h16v16H4z"/><path d="M7 8h10M7 12h7M7 16h5"/>',
  markdown: '<path d="M4 5h16v14H4z"/><path d="m7 15 2-3 2 2 2-3 3 4"/>',
  text: '<path d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M7 8h10M7 12h10M7 16h6"/>',
  data: '<path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  image: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 3-4 7 6"/>',
  settings: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/>',
  json: '<path d="M9 4H7.5A1.5 1.5 0 0 0 6 5.5v4A1.5 1.5 0 0 1 4.5 11 1.5 1.5 0 0 1 6 12.5v4A1.5 1.5 0 0 0 7.5 18H9"/><path d="M15 4h1.5A1.5 1.5 0 0 1 18 5.5v4A1.5 1.5 0 0 0 19.5 11 1.5 1.5 0 0 0 18 12.5v4a1.5 1.5 0 0 1-1.5 1.5H15"/><circle cx="12" cy="9" r=".6"/><circle cx="12" cy="13" r=".6"/>',
  yaml: '<path d="M5 5h14M5 12h14M5 19h14"/><circle cx="2.5" cy="5" r=".8"/><circle cx="2.5" cy="12" r=".8"/><circle cx="2.5" cy="19" r=".8"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2"/>',
  git: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 8.2v7.6M8.2 6H14a4 4 0 0 1 4 4v.2"/>',
  pull: '<path d="M6 4v16M6 8h8a4 4 0 0 1 4 4v8"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/>',
  env: '<circle cx="8" cy="12" r="3.4"/><path d="M11.4 12H21M18 12v3M14.6 12v2.2"/>',
  docker: '<rect x="2.5" y="10" width="4" height="4" rx=".6"/><rect x="7.5" y="10" width="4" height="4" rx=".6"/><rect x="12.5" y="10" width="4" height="4" rx=".6"/><rect x="7.5" y="5" width="4" height="4" rx=".6"/><path d="M2.5 15.5c2.6 2.4 6 3.5 9.4 3.5 4.6 0 8.2-2 9.6-5.5-2 0-3.4-.7-4.4-1.7"/>',
  shell: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><path d="m7 10 2.5 2.5L7 15M12.5 15h4"/>',
  sql: '<ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6"/><path d="M5 12v6c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6v-6"/>',
  license: '<circle cx="12" cy="9" r="5"/><path d="m8.5 13.5-1 6.5 4.5-2.2 4.5 2.2-1-6.5"/>',
  package: '<path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2Z"/><path d="m4 7.2 8 4.3 8-4.3M12 11.5V21"/>',
  react: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)"/>',
  notebook: '<path d="M6 4h11a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M4 9h4M4 15h4M9 8h6M9 12h6M9 16h4"/>',
  font: '<path d="M5 19 12 5l7 14M8 14h8"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1.6"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>',
  binary: '<rect x="4" y="4" width="16" height="16" rx="2.4"/><path d="M9 9h1v6H9M14 9h2v6h-2"/>',
};

const CODICON_NAMES = {
  folder: "folder",
  folderOpen: "folder-opened",
  chevron: "chevron-right",
  code: "file-code",
  html: "file-code",
  python: "file-code",
  javascript: "file-code",
  typescript: "file-code",
  styles: "symbol-color",
  markdown: "markdown",
  text: "file-text",
  data: "json",
  image: "file-media",
  settings: "settings-gear",
  json: "json",
  yaml: "symbol-property",
  lock: "lock",
  git: "git-commit",
  pull: "git-pull-request",
  env: "key",
  docker: "symbol-interface",
  shell: "terminal",
  sql: "database",
  license: "law",
  package: "package",
  react: "symbol-event",
  notebook: "notebook",
  font: "symbol-parameter",
  archive: "archive",
  binary: "file-binary",
};

function iconSvg(name) {
  const codicon = CODICON_NAMES[name] || CODICON_NAMES.text;
  return `<span class="codicon codicon-${codicon} tree-codicon" aria-hidden="true"></span>`;
}

const FILE_NAME_ICONS = {
  dockerfile: "docker",
  "docker-compose.yml": "docker",
  "docker-compose.yaml": "docker",
  makefile: "shell",
  "package.json": "package",
  "package-lock.json": "package",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "cargo.toml": "package",
  "cargo.lock": "lock",
  "go.mod": "package",
  "go.sum": "lock",
  "poetry.lock": "lock",
  "pyproject.toml": "package",
  "requirements.txt": "python",
  "tsconfig.json": "typescript",
  "jsconfig.json": "javascript",
  license: "license",
  "license.md": "license",
  licence: "license",
  "readme.md": "markdown",
  "next.config.ts": "typescript",
  "next.config.js": "javascript",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".env": "env",
  ".env.example": "env",
  ".env.local": "env",
  "eslint.config.mjs": "settings",
};

function fileIconName(file) {
  const name = String(file.name || "").toLowerCase();
  const extension = String(file.extension || "").toLowerCase();
  if (FILE_NAME_ICONS[name]) return FILE_NAME_ICONS[name];
  if (name.startsWith(".env")) return "env";
  if (name.startsWith("readme")) return "markdown";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif"].includes(extension)) return "image";
  if (["html", "htm"].includes(extension)) return "html";
  if (extension === "py") return "python";
  if (["js", "jsx", "mjs", "cjs"].includes(extension)) return "javascript";
  if (["ts", "tsx"].includes(extension)) return "typescript";
  if (["css", "scss", "sass", "less"].includes(extension)) return "styles";
  if (["md", "mdx"].includes(extension)) return "markdown";
  if (extension === "ipynb") return "notebook";
  if (extension === "json") return "json";
  if (["yaml", "yml"].includes(extension)) return "yaml";
  if (["toml", "ini", "cfg", "conf"].includes(extension)) return "settings";
  if (["lock"].includes(extension)) return "lock";
  if (["sql", "db", "sqlite"].includes(extension)) return "sql";
  if (["sh", "bash", "zsh", "ps1", "bat", "cmd"].includes(extension)) return "shell";
  if (["woff", "woff2", "ttf", "otf", "eot"].includes(extension)) return "font";
  if (["zip", "tar", "gz", "rar", "7z"].includes(extension)) return "archive";
  if (["exe", "dll", "so", "dylib", "pyc", "bin"].includes(extension)) return "binary";
  if (["txt", "rst", "log", "csv"].includes(extension)) return "text";
  if (["go", "java", "kt", "rb", "php", "rs", "c", "h", "cpp", "hpp", "cs", "swift"].includes(extension)) return "code";
  return "text";
}

function renderRepositoryDocuments(payload = {}) {
  const host = $("#repository-documents");
  const note = $("#repository-documents-note");
  if (!host) return;
  const documents = payload.documents || [];
  state.repositoryDocuments = documents;
  if (note) note.textContent = documents.length ? `${formatNumber(documents.length)} readable document${documents.length === 1 ? "" : "s"}` : "No standards found";
  host.innerHTML = documents.length
    ? documents.map((document) => `<button class="repository-document" type="button" data-document-path="${escapeHtml(document.path)}"><span class="document-icon">${iconSvg(fileIconName({ name: document.path.split("/").pop(), extension: "md" }))}</span><span class="document-body"><strong>${escapeHtml(document.title || document.path)}</strong><small>${escapeHtml(document.path)} · ${formatNumber(document.size_bytes || 0)} bytes</small></span><span class="document-arrow">→</span></button>`).join("")
    : '<div class="empty-state">No README, standards, or documentation Markdown files were found.</div>';
  host.querySelectorAll("[data-document-path]").forEach((button) => button.addEventListener("click", () => loadSource(button.dataset.documentPath)));
}

async function loadRepositoryDocuments() {
  const host = $("#repository-documents");
  if (!host || !state.graphLoaded) return;
  try {
    renderRepositoryDocuments(await api("/api/repository/documents"));
    if (state.activePage === "source" && !state.sourcePath && state.repositoryDocuments.length) {
      const readme = state.repositoryDocuments.find((document) => /^readme(?:\.|$)/i.test(String(document.path || "")));
      if (readme) loadSource(readme.path);
    }
  } catch (error) {
    host.innerHTML = `<div class="empty-state error-state">${escapeHtml(error.message)}</div>`;
  }
}

function highlightSourceLine(text, language) {
  const escaped = escapeHtml(String(text || ""));
  const value = String(language || "").toLowerCase();
  if (!escaped) return " ";
  const tokenPattern = /(&quot;.*?&quot;|&#39;.*?&#39;|\/\/.*$|\/\*.*?\*\/|^\s*#.*$|\b(?:async|await|class|const|def|else|export|extends|function|from|if|import|interface|let|new|return|type|var|while|SELECT|FROM|WHERE)\b)/g;
  return escaped.replace(tokenPattern, (token) => {
    const tokenClass = token.startsWith("//") || token.startsWith("/*") || token.trim().startsWith("#") ? "source-token-comment" : token.startsWith("&quot;") || token.startsWith("&#39;") ? "source-token-string" : value === "json" ? "source-token-keyword" : "source-token-keyword";
    return `<span class="${tokenClass}">${token}</span>`;
  });
}

function markdownAssetUrl(documentPath, source) {
  const raw = String(source || "").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return "";
  const parts = documentPath.split("/").slice(0, -1);
  raw.split("/").forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") parts.pop();
    else parts.push(part);
  });
  const path = parts.join("/");
  return path && !path.includes("..") ? `/api/source/raw?path=${encodeURIComponent(path)}&mode=inline` : "";
}

function isFilePathLike(str) {
  const s = String(str || "").trim();
  if (s.includes(" ") || s.length < 2 || s.length > 120) return false;
  return /\.(md|py|js|ts|tsx|jsx|json|yaml|yml|rs|go|java|c|cpp|h|css|html|sh|toml|lock|sql|txt|dockerfile|gitignore|gradle|xml)$/i.test(s) || s.includes("/");
}

function markdownInline(value, documentPath) {
  let output = escapeHtml(value);
  output = output.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, source) => {
    const url = markdownAssetUrl(documentPath, source);
    return url ? `<img class="markdown-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" />` : escapeHtml(alt);
  });
  output = output.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1 ↗</a>');
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/`([^`]+)`/g, (_match, codeContent) => {
    const trimmed = codeContent.trim();
    if (isFilePathLike(trimmed)) {
      return `<button type="button" class="file-pill-link" data-open-source="${escapeHtml(trimmed)}" title="Open ${escapeHtml(trimmed)} in Source Explorer">${escapeHtml(trimmed)}</button>`;
    }
    return `<code>${escapeHtml(codeContent)}</code>`;
  });
  return output;
}

function renderMarkdown(lines, documentPath) {
  const output = [];
  let inFence = false;
  let listOpen = false;
  let inTable = false;
  (lines || []).forEach((line) => {
    const value = typeof line === "string" ? line : String(line?.text ?? line?.content ?? "");
    if (value.trim().startsWith("```")) {
      if (inFence) output.push("</code></pre>");
      else output.push("<pre class=\"markdown-code\"><code>");
      inFence = !inFence;
      return;
    }
    if (inFence) { output.push(escapeHtml(value) + "\n"); return; }
    
    // Support markdown tables
    if (value.trim().startsWith("|") && value.trim().endsWith("|")) {
      if (!inTable) {
        if (listOpen) { output.push("</ul>"); listOpen = false; }
        output.push("<table><tbody>");
        inTable = true;
      }
      if (value.includes("---")) return;
      const cells = value.trim().slice(1, -1).split("|").map((c) => c.trim());
      output.push(`<tr>${cells.map((c) => `<td>${markdownInline(c, documentPath)}</td>`).join("")}</tr>`);
      return;
    }
    if (inTable) {
      output.push("</tbody></table>");
      inTable = false;
    }

    // Support all markdown headings h1-h6
    const heading = value.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (listOpen) { output.push("</ul>"); listOpen = false; }
      const level = heading[1].length;
      output.push(`<h${level}>${markdownInline(heading[2], documentPath)}</h${level}>`);
      return;
    }
    const item = value.match(/^\s*[-*+]\s+(.+)$/);
    if (item) {
      if (!listOpen) { output.push("<ul>"); listOpen = true; }
      output.push(`<li>${markdownInline(item[1], documentPath)}</li>`);
      return;
    }
    if (listOpen) { output.push("</ul>"); listOpen = false; }
    if (!value.trim()) return;
    output.push(`<p>${markdownInline(value, documentPath)}</p>`);
  });
  if (listOpen) output.push("</ul>");
  if (inTable) output.push("</tbody></table>");
  if (inFence) output.push("</code></pre>");
  return output.join("");
}

function treeFileCount(node) {
  return node.files.length + [...node.folders.values()].reduce((sum, child) => sum + treeFileCount(child), 0);
}

function treeFolderCount(node) {
  return node.folders.size + [...node.folders.values()].reduce((sum, child) => sum + treeFolderCount(child), 0);
}

function isGeneratedTreePath(path) {
  const normalized = String(path || "").toLowerCase();
  return normalized === "build"
    || normalized.startsWith("build/")
    || normalized.includes("/node_modules")
    || normalized.includes("/.next")
    || normalized.includes("/__pycache__")
    || normalized.endsWith(".egg-info")
    || normalized.includes(".egg-info/")
    || normalized.startsWith("dist/")
    || normalized === "dist";
}

function renderTreeFolder(folder, depth = 0) {
  const folderEntries = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const fileEntries = [...folder.files].sort((a, b) => a.name.localeCompare(b.name));
  return `${folderEntries.map((child) => {
    const expanded = state.treeExpanded.has(child.path);
    const count = treeFileCount(child);
    const generated = isGeneratedTreePath(child.path);
    return `<div class="tree-node"><button class="tree-row tree-folder-row${expanded ? " expanded" : ""}${generated ? " generated" : ""}" type="button" data-tree-toggle="${escapeHtml(child.path)}" aria-expanded="${expanded ? "true" : "false"}" style="--tree-depth:${depth}"><span class="tree-chevron" aria-hidden="true">${iconSvg("chevron")}</span><span class="tree-icon folder-icon${expanded ? " is-open" : ""}" aria-hidden="true">${iconSvg(expanded ? "folderOpen" : "folder")}</span><span class="tree-name" title="${escapeHtml(child.path)}">${escapeHtml(child.name)}</span>${generated ? '<span class="tree-generated-mark">generated</span>' : ""}<span class="tree-count">${formatNumber(count)}</span></button>${expanded ? `<div class="tree-children">${renderTreeFolder(child, depth + 1)}</div>` : ""}</div>`;
  }).join("")}${fileEntries.map((file) => {
    const selected = state.sourcePath === file.path || state.selectedEntity === file.entityId || state.selectedModule === file.moduleId;
    const language = displayLanguage(file.language || "file");
    const iconName = fileIconName(file);
     const generated = isGeneratedTreePath(file.path);
     return `<button class="tree-row tree-file-row${selected ? " selected" : ""}${generated ? " generated" : ""}" type="button" data-tree-path="${escapeHtml(file.path)}" data-tree-entity-id="${escapeHtml(file.entityId || "")}" data-tree-module-id="${escapeHtml(file.moduleId || "")}" title="${escapeHtml(file.path)}" style="--tree-depth:${depth}"><span class="tree-chevron" aria-hidden="true"></span><span class="tree-icon file-icon file-icon-${escapeHtml(iconName)}" aria-hidden="true">${iconSvg(iconName)}</span><span class="tree-name">${escapeHtml(file.name)}</span>${generated ? '<span class="tree-generated-mark">generated</span>' : ""}<span class="tree-file-language">${escapeHtml(language)}</span></button>`;
  }).join("")}`;
}

function renderFileTree(graph = state.graph) {
  const tree = createTreeNode("", "");
  const modules = state.inspection?.analysis?.module_relationships?.modules || [];
  const modulesByPath = new Map(modules.map((module) => [module.path || module.name, module]));
  const graphFiles = [
    ...(graph?.nodes || []).filter((node) => graphNodeType(node) === "File"),
    ...(state.fileNodes || []),
  ];
  const filesByPath = new Map();
  graphFiles.forEach((file) => {
    const path = file.path || file.file_path;
    if (path) filesByPath.set(path, file);
  });
  modules.forEach((module) => {
    const path = module.path || module.name;
    if (path && !filesByPath.has(path)) filesByPath.set(path, module);
  });
  state.fileTreeEntries = new Map();
  [...filesByPath.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([path, file]) => {
    const parts = String(path).split("/").filter(Boolean);
    if (!parts.length) return;
    let cursor = tree;
    parts.slice(0, -1).forEach((part, index) => {
      const folderPath = parts.slice(0, index + 1).join("/");
      if (!cursor.folders.has(part)) cursor.folders.set(part, createTreeNode(part, folderPath));
      cursor = cursor.folders.get(part);
    });
    const name = parts[parts.length - 1];
    const module = modulesByPath.get(path);
    const entityId = file.id || (file.labels ? file.id : "");
    const entry = {
      name,
      path,
      entityId,
      moduleId: module?.id || (file.id && !file.labels ? file.id : ""),
      language: file.language || module?.language || "unknown",
      extension: name.includes(".") ? name.split(".")[name.split(".").length - 1] : "file",
    };
    cursor.files.push(entry);
    state.fileTreeEntries.set(path, entry);
  });
  const fileCount = state.fileTreeEntries.size;
  if (!state.graphLoaded || !fileCount) {
    $("#tree-meta").textContent = state.graphLoaded ? "No files" : "Awaiting repository";
    $("#file-tree").innerHTML = `<div class="empty-state">${state.graphLoaded ? "No tracked source files were returned for this snapshot." : "Inspect a repository to browse folders and files."}</div>`;
    return;
  }
  $("#tree-meta").textContent = `${formatNumber(fileCount)} files · ${formatNumber(treeFolderCount(tree))} folders`;
  $("#file-tree").innerHTML = renderTreeFolder(tree);
}

async function loadFileCatalog() {
  if (!state.graphLoaded) return;
  try {
    const payload = await api("/api/files?limit=20000");
    state.fileNodes = payload.files || [];
    renderFileTree(state.graph);
  } catch (error) {
    console.warn("File catalog unavailable", error);
  }
}

function loadFileChanges(path) {
  if (!path || !state.graph) {
    $("#file-changes-meta").textContent = path ? "Loading..." : "No file selected";
    $("#file-changes-list").innerHTML = '<div class="empty-state">No graph data available.</div>';
    return;
  }
  $("#file-changes-meta").textContent = path;
  const nodes = state.graph.nodes || [];
  const edges = state.graph.edges || [];
  const fileNode = nodes.find((n) => (n.labels?.includes("File")) && (n.path === path || n.file_path === path));
  if (!fileNode) {
    $("#file-changes-list").innerHTML = '<div class="empty-state">No changes recorded for this file.</div>';
    return;
  }
  const modifiedEdges = edges.filter((e) => e.type === "MODIFIED" && e.target === fileNode.id);
  const changes = modifiedEdges.map((edge) => {
    const commit = nodes.find((n) => n.id === edge.source && n.labels?.includes("Commit"));
    const authorEdge = edges.find((e) => e.type === "AUTHORED" && e.target === commit?.id);
    const author = authorEdge ? nodes.find((n) => n.id === authorEdge.source) : null;
    return {
      commit,
      author,
      diff_hunk: edge.diff_hunk || "",
      timestamp: commit?.timestamp || commit?.date || "",
    };
  }).filter((c) => c.commit);
  changes.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  if (!changes.length) {
    $("#file-changes-list").innerHTML = '<div class="empty-state">No changes recorded for this file.</div>';
    renderFileTimeline(path, []);
    renderCommitDiff(path, null);
    return;
  }
  renderFileTimeline(path, changes);
  renderCommitDiff(path, changes[0]);
  $("#file-changes-list").innerHTML = changes.map((change) => {
    const sha = change.commit?.sha || "";
    const shortSha = sha ? sha.slice(0, 7) : (change.commit?.id || "").slice(0, 7);
    const message = change.commit?.message || "Repository change";
    const authorName = change.author?.display_name || change.author?.username || change.author?.login || change.author?.email || "Unknown";
    const time = change.timestamp ? formatDateTime(change.timestamp) : "Unknown time";
    return `<div class="file-change-item"><div class="file-change-header"><code class="file-change-sha">${escapeHtml(shortSha)}</code><span class="file-change-time">${escapeHtml(time)}</span></div><div class="file-change-author">${escapeHtml(authorName)}</div><div class="file-change-message">${escapeHtml(message)}</div>${change.diff_hunk ? `<details class="file-change-diff"><summary>Diff</summary><pre>${escapeHtml(change.diff_hunk)}</pre></details>` : ""}</div>`;
  }).join("");
}

async function handleFileTreeClick(event) {
  const toggle = event.target.closest("[data-tree-toggle]");
  if (toggle) {
    const path = toggle.dataset.treeToggle;
    if (state.treeExpanded.has(path)) state.treeExpanded.delete(path);
    else state.treeExpanded.add(path);
    renderFileTree();
    return;
  }
  const file = event.target.closest("[data-tree-path]");
  if (!file) return;
  const entry = state.fileTreeEntries.get(file.dataset.treePath);
  if (!entry) return;
  if (entry.entityId) {
    await selectEntity(entry.entityId);
    return;
  }
  if (entry.moduleId) {
    const module = (state.inspection?.analysis?.module_relationships?.modules || []).find((item) => item.id === entry.moduleId);
    if (module) selectModule(module);
    else {
      state.sourceHistoryPayload = null;
      state.sourceHistoryPromise = null;
      await loadSource(entry.path);
      loadFileChanges(entry.path);
      renderSourceRelationGraph(entry.path);
    }
    return;
  }
  state.sourceHistoryPayload = null;
  state.sourceHistoryPromise = null;
  await loadSource(entry.path);
  loadFileChanges(entry.path);
  renderSourceRelationGraph(entry.path);
}

function renderDetailLoading() {
  if ($("#entity-summary")) $("#entity-summary").innerHTML = '<div class="loading-state"><span class="loading-spinner" aria-hidden="true"></span><span>Loading entity metadata…</span></div>';
  if ($("#evidence-count")) $("#evidence-count").textContent = "Loading evidence";
  if ($("#evidence-list")) $("#evidence-list").innerHTML = '<div class="loading-state"><span class="loading-spinner" aria-hidden="true"></span><span>Following linked history…</span></div>';
}

function renderDetailError(message) {
  if ($("#entity-summary")) $("#entity-summary").innerHTML = `<div class="empty-state error-state">${escapeHtml(message)}</div>`;
  if ($("#evidence-count")) $("#evidence-count").textContent = "Unavailable";
  if ($("#evidence-list")) $("#evidence-list").innerHTML = "";
}

function renderEvidence(item) {
  const decision = item.decisions?.[0] || item.decision;
  const commit = item.commit || {};
  const author = item.author || item.contributor || {};
  const status = decision?.status ? `<span class="evidence-decision-status">${escapeHtml(decision.status)}</span>` : "";
  return `<article class="evidence-card"><div class="evidence-title">${escapeHtml(decision?.summary || "History changed this entity")}</div><div class="evidence-meta"><code title="${escapeHtml(commit.sha || "")}">${escapeHtml((commit.sha || "").slice(0, 12) || "No SHA")}</code>${status}<span>${escapeHtml(formatDateTime(commit.timestamp))}</span><span>${escapeHtml(author.display_name || author.email || "Unknown author")}</span></div><div class="evidence-message">${escapeHtml(commit.message || "No commit message")}</div></article>`;
}

function renderDetail(detail, evidence) {
  if (!$("#entity-summary")) return;
  const node = detail.node;
  const label = entityLabel(node);
  const path = entityPath(node) || node.signature || node.id;
  const facts = [`<span class="summary-fact"><strong>Type</strong>${escapeHtml(label)}</span>`];
  if (node.language) facts.push(`<span class="summary-fact"><strong>Language</strong>${escapeHtml(displayLanguage(node.language))}</span>`);
  if (node.start_line) facts.push(`<span class="summary-fact"><strong>Lines</strong>${escapeHtml(`L${node.start_line}–${node.end_line || node.start_line}`)}</span>`);
  if (detail.relationships?.length) facts.push(`<span class="summary-fact"><strong>Links</strong>${formatNumber(detail.relationships.length)}</span>`);
  const value = node.current_value != null ? `<div class="summary-value">Current value: ${escapeHtml(node.current_value)}</div>` : "";
  $("#entity-summary").innerHTML = `<div class="summary-title-row"><div class="summary-title" title="${escapeHtml(entityTitle(node))}">${escapeHtml(entityTitle(node))}</div><span class="summary-type">${escapeHtml(label)}</span></div><div class="summary-subtitle" title="${escapeHtml(path)}">${escapeHtml(path)}</div><div class="summary-facts">${facts.join("")}</div>${value}`;
  if ($("#evidence-count")) $("#evidence-count").textContent = evidence.length ? `${evidence.length} history records` : "No linked intent";
  if ($("#evidence-list")) $("#evidence-list").innerHTML = evidence.length ? evidence.map(renderEvidence).join("") : '<div class="empty-state">No linked decision evidence for this entity. Mnemo will not fabricate intent.</div>';
}

function setSourceLoading() {
  if ($("#source-title")) $("#source-title").textContent = "Loading source…";
  if ($("#source-meta")) $("#source-meta").textContent = "Read-only";
  if ($("#source-toolbar")) $("#source-toolbar").innerHTML = "";
  if ($("#source-file-tab")) $("#source-file-tab").textContent = "Loading source…";
  if ($("#source-explain-button")) $("#source-explain-button").disabled = true;
  if ($("#source-gutter")) $("#source-gutter").innerHTML = "";
  if ($("#source-view")) $("#source-view").innerHTML = '<span class="loading-state"><span class="loading-spinner" aria-hidden="true"></span><span>Reading tracked source…</span></span>';
}

function ensureSourceWorkspaceChrome() {
  const grid = document.querySelector(".workspace-grid");
  const sourcePanel = $(".source-panel");
  const explorerPanel = $(".explorer-panel");
  if (!grid || !sourcePanel || !explorerPanel) return;
  if (!grid.querySelector(".source-activity-rail")) {
    const rail = document.createElement("aside");
    rail.className = "source-activity-rail";
    rail.setAttribute("aria-label", "Source tools");
    rail.innerHTML = '<button class="source-activity active" type="button" aria-label="Explorer" title="Explorer">▣</button><button class="source-activity" type="button" aria-label="Search" title="Search">⌕</button><button class="source-activity" type="button" aria-label="Graph" title="Graph">⌘</button><button class="source-activity" type="button" aria-label="Timeline" title="Timeline">◷</button><span class="source-activity-spacer"></span><button class="source-activity" type="button" aria-label="Settings" title="Settings">⚙</button>';
    grid.insertBefore(rail, grid.firstElementChild);
    rail.querySelectorAll(".source-activity").forEach((button) => button.addEventListener("click", () => {
      rail.querySelectorAll(".source-activity").forEach((item) => item.classList.toggle("active", item === button));
    }));
  }
  if (!explorerPanel.querySelector(".source-workbench-tabs")) {
    const tabs = document.createElement("div");
    tabs.className = "source-workbench-tabs";
    tabs.innerHTML = '<button class="active" type="button">Search</button><button type="button">Symbols</button><button type="button">Problems <b>0</b></button><button type="button">Git</button>';
    explorerPanel.insertBefore(tabs, explorerPanel.firstElementChild);
    tabs.querySelectorAll("button").forEach((button) => button.addEventListener("click", () => {
      tabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
    }));
  }
  if (!sourcePanel.querySelector(".source-assistant-panel")) {
    const assistant = document.createElement("section");
    assistant.className = "source-assistant-panel";
    assistant.innerHTML = '<div class="source-assistant-tabs"><span class="active">AI assistant</span><span>Problems <b>0</b></span><span>Output</span><span>Terminal</span></div><div class="source-assistant-body"><div class="source-assistant-copy"><span class="eyebrow">SOURCE CONTEXT</span><strong id="source-assistant-context">Ask about the selected file</strong><span id="source-assistant-output">The assistant uses the same deterministic graph, source, and timeline evidence.</span></div><div class="source-assistant-compose"><input id="source-assistant-input" type="text" placeholder="Ask anything about this file…" /><button id="source-assistant-send" type="button">Ask</button></div></div>';
    sourcePanel.appendChild(assistant);
    $("#source-assistant-send")?.addEventListener("click", askSourceAssistant);
    $("#source-assistant-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") askSourceAssistant(); });
  }
}

async function askSourceAssistant() {
  const input = $("#source-assistant-input");
  const output = $("#source-assistant-output");
  const question = input?.value?.trim();
  if (!question || !state.graphLoaded) return;
  if (output) output.textContent = "Following source, commits, and evidence…";
  try {
    const payload = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({
        question: state.sourcePath ? `${question} Focus on ${state.sourcePath}.` : question,
        ai_assist: $("#ai-assist")?.checked || false,
      }),
    });
    output.textContent = payload.result?.answer || payload.ai?.text || "No grounded answer was returned.";
  } catch (error) {
    output.textContent = error.message;
  }
}

function bindSourceScrollSync() {
  if (state.sourceScrollSyncBound) return;
  const view = $("#source-view");
  const gutter = $("#source-gutter");
  if (!view || !gutter) return;
  view.addEventListener("scroll", () => {
    gutter.scrollTop = view.scrollTop;
  }, { passive: true });
  state.sourceScrollSyncBound = true;
}

function setSourceEmpty(message) {
  if ($("#source-title")) $("#source-title").textContent = "Source preview unavailable";
  if ($("#source-meta")) $("#source-meta").textContent = "Read-only";
  if ($("#source-toolbar")) $("#source-toolbar").innerHTML = "";
  if ($("#source-file-tab")) $("#source-file-tab").textContent = "No file selected";
  if ($("#source-explain-button")) $("#source-explain-button").disabled = true;
  if ($("#source-gutter")) $("#source-gutter").innerHTML = "";
  if ($("#source-view")) $("#source-view").innerHTML = `<span class="empty-state">${escapeHtml(message)}</span>`;
  state.sourceViewMode = "code";
}

function setSourceError(message) {
  if ($("#source-title")) $("#source-title").textContent = "Source unavailable";
  if ($("#source-meta")) $("#source-meta").textContent = "Read-only";
  if ($("#source-toolbar")) $("#source-toolbar").innerHTML = "";
  if ($("#source-file-tab")) {
    $("#source-file-tab").textContent = "Source unavailable";
    $("#source-file-tab").className = "source-tab";
  }
  if ($("#source-explain-button")) $("#source-explain-button").disabled = true;
  if ($("#source-gutter")) $("#source-gutter").innerHTML = "";
  if ($("#source-view")) $("#source-view").innerHTML = `<span class="empty-state error-state">${escapeHtml(message)}</span>`;
  if ($("#source-explanation")) $("#source-explanation").innerHTML = `<div class="empty-state error-state">${escapeHtml(message)}</div>`;
}

function fallbackCopyText(text, onDone) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand("copy");
    if (onDone) onDone();
  } catch (error) {
    console.error("Copy failed", error);
  } finally {
    area.remove();
  }
}

function copySourceText() {
  const view = $("#source-view");
  const button = $("#source-copy-button");
  if (!view) return;
  const lines = [...view.querySelectorAll(".source-line")].map((line) => line.textContent);
  const text = lines.join("\n");
  if (!text.trim()) return;
  const done = () => {
    if (!button) return;
    const original = button.dataset.originalLabel || button.textContent;
    button.dataset.originalLabel = original;
    button.textContent = "Copied";
    window.setTimeout(() => { button.textContent = original; }, 1200);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopyText(text, done));
  } else {
    fallbackCopyText(text, done);
  }
}

async function loadFileHistory(path) {
  if (!path) return null;
  try {
    const candidate = state.fileTreeEntries?.get(path);
    const entityId = candidate?.entityId || candidate?.moduleId || null;
    const query = new URLSearchParams({ limit: "24" });
    if (entityId) query.set("entity_id", entityId);
    query.set("path", path);
    const payload = await api(`/api/evidence/chain?${query.toString()}`);
    return payload;
  } catch (error) {
    return { steps: [], message: error.message };
  }
}

async function loadSourceHistory(path) {
  const history = await loadFileHistory(path);
  state.sourceHistoryPayload = history;
  state.sourceHistoryPromise = Promise.resolve(history);
  renderSourceHistory(history, path);
}

function renderSourceHistory(payload, path) {
  const steps = payload?.steps || [];
  const targetLabel = path || "selected file";
  const summary = document.getElementById("chain-summary");
  if (summary) summary.textContent = steps.length ? `${formatNumber(steps.length)} recorded change${steps.length === 1 ? "" : "s"} · ${escapeHtml(targetLabel)}` : "No recorded changes";
  const chainEl = $("#evidence-chain");
  if (chainEl) {
    chainEl.innerHTML = steps.length
      ? steps.map((step, index) => {
          const commit = step.commit || {};
          const author = step.author || {};
          const modified = (step.modified || []).slice(0, 6);
          const decisions = step.decisions || [];
          const superseded = step.superseded || [];
          const modifiedText = modified.length ? modified.map((item) => entityPath(item) || entityTitle(item)).join(" · ") : "No file target recorded";
          const decisionText = decisions.length
            ? decisions.map((item) => item.summary || "Recorded decision").join(" · ")
            : "Structural change without a recorded intent decision";
          const diff = modified.map((item) => item.diff_hunk || "").filter(Boolean).join("\n\n");
          const hunks = diff ? diff.split(/\n(?=@@)/).filter(Boolean) : [];
          return `<article class="chain-step"><div class="chain-marker">${String(index + 1).padStart(2, "0")}</div><div class="chain-step-body"><div class="chain-step-topline"><span class="chain-stage">COMMIT → CODE → INTENT</span><time>${escapeHtml(formatDate(commit.timestamp))}</time></div><h3>${escapeHtml(commit.message || "Recorded repository change")}</h3><div class="chain-facts"><span><strong>Author</strong>${escapeHtml(author.display_name || author.username || author.email || "Unknown contributor")}</span><span><strong>Commit</strong><code>${escapeHtml(String(commit.sha || "").slice(0, 12) || "No SHA")}</code></span><span><strong>Changed</strong>${escapeHtml(modifiedText)}</span></div><div class="chain-decision"><span class="chain-decision-label">Decision record</span><p>${escapeHtml(decisionText)}</p>${superseded.length ? `<small>Supersedes: ${escapeHtml(superseded.map((item) => item.summary || item.id).join(" · "))}</small>` : ""}</div>${hunks.length ? `<details class="chain-diff"><summary>Show recorded diff</summary><pre>${escapeHtml(diff)}</pre></details>` : ""}</div></article>`;
        }).join("")
      : `<div class="empty-state">${escapeHtml(payload?.message || "No recorded commit evidence was found for this file.")}</div>`;
  }
}

function renderSourceChanges(historyPayload) {
  const steps = historyPayload?.steps || [];
  const path = state.sourcePath;
  if (!steps.length) {
    $("#source-view").innerHTML = `<div class="source-view-pane active" id="source-diff-view"><div class="empty-state">No recorded diff hunks were attached to this file’s commit history.</div></div>`;
    return;
  }
  const hunks = steps
    .map((step) => (step.modified || []).map((item) => item.diff_hunk || "").filter(Boolean).join("\n\n"))
    .filter(Boolean)
    .join("\n\n");
  if (!hunks) {
    $("#source-view").innerHTML = `<div class="source-view-pane active" id="source-diff-view"><div class="empty-state">The recorded history exists, but no diff hunks are attached to it.</div></div>`;
    return;
  }
  $("#source-view").innerHTML = `<div class="source-view-pane active diff" id="source-diff-view"><span class="source-history-filehead">File history diff · ${escapeHtml(path || "selected file")}</span>${hunks.split(/\n(?=@@)/).map((hunk, index) => `<details class="source-history-hunk" open><summary>Hunk ${index + 1}</summary>${escapeHtml(hunks.split(/\n(?=@@)/)[index])}</details>`).join("")}</div>`;
}

async function loadSource(path, startLine = 1, endLine = 160) {
  if (!path) {
    setSourceEmpty("This selection is not backed by a source file path.");
    return;
  }
  setSourceLoading();
  try {
    const payload = await api(`/api/source?path=${encodeURIComponent(path)}&start_line=${startLine}&end_line=${endLine}`);
    state.sourcePath = payload.path;
    $("#source-title").textContent = payload.path;
    $("#source-file-tab").textContent = payload.path;
    $("#source-file-tab").className = "source-tab active";
    $("#source-explain-button").disabled = payload.kind !== "image" && payload.kind !== "binary" ? false : true;
    $("#source-meta").textContent = payload.kind === "image"
      ? `Image preview · ${formatNumber(payload.size_bytes || 0)} bytes`
      : payload.kind === "binary"
        ? `Binary file · ${formatNumber(payload.size_bytes || 0)} bytes`
        : `Read-only · ${displayLanguage(payload.language)} · ${formatNumber(payload.total_lines)} lines`;
    if ($("#source-toolbar")?.querySelector(".source-view-switcher")) {
      $("#source-toolbar").querySelectorAll("[data-source-view]").forEach((tab) => tab.addEventListener("click", () => switchSourceTab(tab.dataset.sourceView)));
      $("#source-copy-button")?.addEventListener("click", copySourceText);
      state.sourceViewMode = state.sourceViewMode || "code";
      renderSourceFileTab();
      markSourceBadge("live");
    } else if ($("#source-toolbar")) {
      $("#source-toolbar").innerHTML = `<div class="source-toolbar-row"><span class="source-chip">${escapeHtml(displayLanguage(payload.language))}</span><span class="source-chip">L${payload.start_line}–${payload.end_line} of ${payload.total_lines}</span><span class="source-note">Tracked source preview</span></div><div class="source-toolbar-row"><span class="source-editor-badge live" id="source-editor-badge">live</span><button class="source-toolbar-copy" type="button" id="source-copy-button">Copy</button><span class="source-toolbar-divider"></span><div class="source-view-switcher" role="tablist" aria-label="Source view mode"><button class="source-view-tab active" data-source-view="code" type="button" role="tab" aria-selected="true">Code</button><button class="source-view-tab" data-source-view="changes" type="button" role="tab" aria-selected="false">Changes</button><button class="source-view-tab" data-source-view="history" type="button" role="tab" aria-selected="false">History</button></div></div>`;
      $("#source-toolbar").querySelectorAll("[data-source-view]").forEach((tab) => tab.addEventListener("click", () => switchSourceTab(tab.dataset.sourceView)));
      $("#source-copy-button")?.addEventListener("click", copySourceText);
      state.sourceViewMode = "code";
      renderSourceFileTab();
      markSourceBadge("live");
    }
    if (payload.kind === "image") {
      $("#source-gutter").innerHTML = "";
      $("#source-view").innerHTML = `<div class="source-preview-image"><img src="${escapeHtml(payload.preview_url)}" alt="${escapeHtml(payload.path)}" /></div>`;
    } else if (payload.kind === "binary") {
      $("#source-gutter").innerHTML = "";
      $("#source-view").innerHTML = `<div class="source-binary-preview"><strong>Binary file</strong><span>${escapeHtml(payload.mime_type || "application/octet-stream")} · ${formatNumber(payload.size_bytes || 0)} bytes</span><a class="secondary-button" href="${escapeHtml(payload.download_url)}" download>Download file</a></div>`;
    } else if (payload.kind === "markdown") {
      $("#source-gutter").innerHTML = "";
      $("#source-view").innerHTML = `<article class="markdown-preview">${renderMarkdown(payload.lines || [], payload.path)}</article>`;
    } else {
      $("#source-gutter").innerHTML = payload.lines?.length ? payload.lines.map((line) => `<span>${line.number}</span>`).join("") : "";
      $("#source-view").innerHTML = payload.lines?.length ? payload.lines.map((line) => `<span class="source-line">${highlightSourceLine(line.text, payload.language)}</span>`).join("") : '<span class="empty-state">This tracked file is empty.</span>';
    }
    if ($("#source-explanation")) $("#source-explanation").innerHTML = '<div class="empty-state">Use “Explain with evidence” to ask Mnemo about this file using its recorded graph history.</div>';
    openEditorTab(payload.path);
    loadFileChanges(payload.path);
    renderSourceRelationGraph(payload.path);
  } catch (error) {
    setSourceError(error.message);
  }
}

function renderSourceFileTab () {
  const tab = document.getElementById("source-file-tab");
  if (!tab) return;
  const mode = state.sourceViewMode || "code";
  tab.classList.remove("modified", "saved", "unsaved");
  tab.classList.add(mode === "code" ? "saved" : mode === "changes" ? "modified" : "unsaved");
  tab.textContent = mode === "code"
    ? `${state.sourcePath || "No file selected"} — Code`
    : mode === "changes"
      ? `${state.sourcePath || "No file selected"} — Changes`
      : `${state.sourcePath || "No file selected"} — History`;
}

function markSourceBadge (stateName) {
  const badge = document.getElementById("source-editor-badge");
  if (!badge) return;
  badge.className = `source-editor-badge ${stateName}`;
  const labels = { live: "live", idle: "idle", modified: "modified", unsaved: "unsaved" };
  badge.textContent = labels[stateName] || "idle";
}

function switchSourceTab(mode) {
  if (!state.sourcePath) return;
  state.sourceViewMode = mode;
  const tabs = $("#source-toolbar")?.querySelectorAll("[data-source-view]");
  if (tabs) tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.sourceView === mode));
  renderSourceFileTab();
  markSourceBadge(mode === "code" ? "live" : mode === "changes" ? "modified" : "unsaved");
  const toolbars = document.querySelectorAll("#source-toolbar");
  toolbars.forEach((toolbar) => {
    const localTabs = toolbar.querySelectorAll("[data-source-view]");
    if (localTabs.length) {
      localTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.sourceView === mode));
    }
  });
  if (mode === "code") {
    loadSource(state.sourcePath, 1, state.sourceViewEndLine || 160);
    return;
  }
  if (mode === "changes") {
    renderSourceChanges(state.sourceHistoryPayload || {});
    return;
  }
  if (mode === "history") {
    loadSourceHistory(state.sourcePath);
    return;
  }
}

async function renderSourceChanges(historyPayload) {
  const steps = historyPayload?.steps || [];
  const path = state.sourcePath;
  if (!steps.length) {
    $("#source-view").innerHTML = `<div class="source-view-pane active" id="source-diff-view"><div class="empty-state">No recorded diff hunks were attached to this file’s commit history.</div></div>`;
    return;
  }
  const hunks = steps
    .map((step) => (step.modified || []).map((item) => item.diff_hunk || "").filter(Boolean).join("\n\n"))
    .filter(Boolean)
    .join("\n\n");
  if (!hunks) {
    $("#source-view").innerHTML = `<div class="source-view-pane active" id="source-diff-view"><div class="empty-state">The recorded history exists, but no diff hunks are attached to it.</div></div>`;
    return;
  }
  $("#source-view").innerHTML = `<div class="source-view-pane active diff" id="source-diff-view"><span class="source-history-filehead">File history diff · ${escapeHtml(path || "selected file")}</span>${hunks.split(/\n(?=@@)/).map((hunk, index) => `<details class="source-history-hunk" open><summary>Hunk ${index + 1}</summary>${escapeHtml(hunks.split(/\n(?=@@)/)[index])}</details>`).join("")}</div>`;
}

async function explainSelectedSource() {
  if (!state.sourcePath || !state.graphLoaded) return;
  const button = $("#source-explain-button");
  const explanation = $("#source-explanation");
  if (!button || !explanation) return;
  button.disabled = true;
  button.textContent = "Explaining…";
  explanation.innerHTML = '<div class="loading-state"><span class="loading-spinner" aria-hidden="true"></span><span>Following file history and graph evidence…</span></div>';
  try {
    const payload = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({
        question: `Explain how ${state.sourcePath} works, what changed over time, and why the recorded evidence supports those changes.`,
        ai_assist: $("#ai-assist")?.checked || false,
      }),
    });
    const result = payload.result || {};
    const evidence = result.evidence || [];
    explanation.innerHTML = `<div class="source-explanation-head"><span class="eyebrow">GROUNDED EXPLANATION</span><span class="confidence-pill">${escapeHtml(result.status || "unknown")}</span></div><p>${escapeHtml(result.answer || "No explanation was returned from the active evidence graph.")}</p>${payload.ai?.text ? `<div class="source-ai-note"><strong>AI explanation</strong><span>${escapeHtml(payload.ai.text)}</span></div>` : ""}${evidence.length ? `<div class="source-evidence-links">${evidence.map((item) => `<span>${escapeHtml(item.commit?.sha?.slice(0, 12) || "commit")} · ${escapeHtml(item.decision?.summary || item.commit?.message || "recorded change")}</span>`).join("")}</div>` : ""}`;
  } finally {
    button.disabled = false;
    button.textContent = "Explain with evidence";
  }
}

function renderModuleDetail(module) {
  if (!$("#entity-summary")) return;
  const imports = state.inspection?.analysis?.module_relationships?.imports || [];
  const children = state.inspection?.analysis?.module_symbols?.[module.id] || [];
  const outgoing = imports.filter((edge) => edge.source === module.id).length;
  const incoming = imports.filter((edge) => edge.target_module === module.id).length;
  const childMarkup = children.length
    ? `<div class="module-children"><strong>Symbols in this module</strong>${children.slice(0, 18).map((child) => `<button class="module-child" data-entity-id="${escapeHtml(child.id)}"><span>${escapeHtml(child.label)}</span>${escapeHtml(child.name || "symbol")}<small>L${escapeHtml(child.start_line || "?")}</small></button>`).join("")}</div>`
    : "";
  $("#entity-summary").innerHTML = `<div class="summary-title-row"><div class="summary-title" title="${escapeHtml(moduleDisplayName(module))}">${escapeHtml(moduleDisplayName(module))}</div><span class="summary-type">Module</span></div><div class="summary-subtitle" title="${escapeHtml(module.path || "")}">${escapeHtml(module.path || "")}</div><div class="summary-facts"><span class="summary-fact"><strong>Language</strong>${escapeHtml(displayLanguage(module.language))}</span><span class="summary-fact"><strong>Imports</strong>${formatNumber(outgoing)}</span><span class="summary-fact"><strong>Used by</strong>${formatNumber(incoming)}</span><span class="summary-fact"><strong>Symbols</strong>${formatNumber(children.length)}</span></div>${childMarkup}`;
  $("#entity-summary").querySelectorAll("[data-entity-id]").forEach((element) => element.addEventListener("click", () => selectEntity(element.dataset.entityId)));
  if ($("#evidence-count")) $("#evidence-count").textContent = "Select a symbol for provenance";
  if ($("#evidence-list")) $("#evidence-list").innerHTML = '<div class="empty-state">Architecture edges show structure. Select a file or symbol in the source explorer to follow commit-level intent.</div>';
}

async function selectModule(module) {
  state.selectedModule = module.id;
  state.selectedEntity = null;
  renderEntities();
  renderGraph(state.graph);
  renderFileTree(state.graph);
  renderModuleDetail(module);
  await loadSource(module.path);
}async function selectEntity (entityId) {
  state.selectedEntity = entityId;
  state.selectedModule = null;
  renderEntities();
  renderGraph(state.graph);
  renderFileTree(state.graph);
  renderDetailLoading();
  setSourceLoading();
  try {
    const [detail, evidence] = await Promise.all([
      api(`/api/entities/${encodeURIComponent(entityId)}`),
      api(`/api/entities/${encodeURIComponent(entityId)}/evidence`),
    ]);
    renderDetail(detail, evidence.evidence || []);
    const node = detail.node;
    const path = entityPath(node);
    state.sourceHistoryPayload = null;
    state.sourceHistoryPromise = null;
    await loadSource(path, node.start_line || 1, node.end_line || 160);
    if (path) {
      state.sourceHistoryPromise = loadFileHistory(path);
      state.sourceHistoryPayload = await state.sourceHistoryPromise;
      renderSourceFileTab();
      markSourceBadge("live");
    }
  } catch (error) {
    renderDetailError(error.message);
    setSourceError(error.message);
  }
}



function renderAnswer(payload) {
  const result = payload.result || {};
  const conversational = result.status === "chat";
  const verified = result.status === "verified";
  const evidence = result.evidence || [];
  const ai = payload.ai;
  const aiBlock = ai?.status === "ok"
    ? `<div class="ai-answer"><strong>AI paraphrase · ${escapeHtml(ai.provider)} · ${escapeHtml(ai.model)}</strong><p>${escapeHtml(ai.text)}</p></div>`
    : ai?.status === "fallback"
      ? `<div class="ai-answer fallback"><strong>Deterministic fallback · ${escapeHtml(ai.message || "External AI was unavailable")}</strong><p>${escapeHtml(ai.text || result.answer || "")}</p></div>`
    : ai && ai.status !== "unavailable"
      ? `<div class="ai-answer"><strong>AI assist unavailable</strong><p>${escapeHtml(ai.message || "The deterministic answer remains authoritative.")}</p></div>`
      : "";
  const statusLabel = conversational ? "MNEMO CHAT" : verified ? "VERIFIED FROM GRAPH" : "HONEST ABSTENTION";
  const confidenceText = conversational ? "repository-aware conversation" : `confidence ${Number(result.confidence || 0).toFixed(2)}`;
  const confidenceDescription = conversational
    ? "This is an orientation response. Ask about a symbol or change when you want a cited graph answer."
    : verified
      ? "Every displayed claim is backed by the linked graph evidence below."
      : "The repository contains structure, but no direct decision evidence supports an intent claim.";
  const grid = $("#answer-grid") || $("#ai-room-history");
  if (grid) {
    grid.innerHTML = `<article class="answer-card ${conversational ? "chat-answer" : ""}"><div class="answer-status ${verified || conversational ? "" : "abstain"}">${statusLabel}<span class="confidence-pill">${confidenceText}</span></div><div class="answer-text">${escapeHtml(result.answer || "Mnemo could not answer this from the active graph.")}</div><div class="answer-confidence">${confidenceDescription}</div>${aiBlock}${evidence.length ? `<div class="ask-evidence">${evidence.map((item) => renderEvidence({ ...item, decisions: [item.decision] })).join("")}</div>` : ""}</article>`;
  }
}

async function askQuestion() {
  const input = $("#question-input") || $("#ai-room-question");
  const question = input ? input.value.trim() : "";
  if (!question) {
    setNotice("ask-notice", "Ask a question about a file, symbol, or repository decision.", "error");
    return;
  }
  if (!state.graphLoaded) {
    setNotice("ask-notice", "Inspect a repository before asking a graph-grounded question.", "error");
    return;
  }
  const button = $("#ask-button") || $("#ai-room-send");
  if (button) {
    button.disabled = true;
    button.textContent = "Reasoning…";
  }
  const aiAssist = $("#ai-assist")?.checked ?? $("#ai-room-assist")?.checked ?? false;
  setNotice("ask-notice", aiAssist ? "Traversing graph evidence, then asking the optional AI provider…" : "Traversing deterministic graph evidence…");
  try {
    const payload = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        ai_assist: aiAssist,
        provider: $("#ai-provider")?.value || $("#ai-room-provider")?.value || undefined,
        model: $("#ai-model")?.value?.trim() || $("#ai-room-model")?.value?.trim() || undefined,
      }),
    });
    renderAnswer(payload);
    const resultStatus = payload.result?.status;
    setNotice("ask-notice", resultStatus === "verified" ? "Answer grounded in graph evidence." : resultStatus === "chat" ? "Conversational response from the active repository context." : "No direct intent edge found; Mnemo abstained.", resultStatus === "verified" || resultStatus === "chat" ? "success" : "");
  } catch (error) {
    setNotice("ask-notice", error.message, "error");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Ask Mnemo <span>✦</span>';
  }
}

function setAiControls() {
  const checkbox = $("#ai-assist");
  if (!checkbox) return;
  const enabled = checkbox.checked;
  if ($("#ai-provider")) $("#ai-provider").disabled = !enabled;
  if ($("#ai-model")) $("#ai-model").disabled = !enabled;
}

function setAiRoomControls() {
  const enabled = Boolean($("#ai-room-assist")?.checked);
  if ($("#ai-room-provider")) $("#ai-room-provider").disabled = !enabled;
  if ($("#ai-room-model")) $("#ai-room-model").disabled = !enabled;
  const chip = $("#ai-status-chip");
  if (chip && enabled) {
    chip.textContent = "AI enabled";
    chip.classList.add("is-active");
  } else if (chip && chip.classList.contains("is-ready")) {
    chip.textContent = "AI ready · off";
    chip.classList.remove("is-active");
  }
}

async function inspectGithub(useGet = false) {
  const input = $("#github-url");
  const value = input.value.trim();
  const canonical = canonicalGithubUrl(value);
  if (!canonical) {
    setNotice("ingest-notice", "Enter an HTTPS GitHub repository URL or owner/repo shorthand.", "error");
    input.focus();
    return;
  }
  const button = $("#inspect-button");
  button.disabled = true;
  button.textContent = "Inspecting…";
  $("#intake-progress").hidden = false;
  $("#intake-progress-label").textContent = useGet ? "Refreshing GitHub metadata…" : "Fetching repository metadata…";
  beginInspectionLoading();
  setNotice("ingest-notice", "Collecting repository data in metadata, source, and analysis segments…");
  state.githubUrl = canonical;
  state.githubHistoryLoading = false;
  state.githubInsightsLoading = false;
  try {
    const maxCommits = Number($("#max-commits")?.value || 500);
    const query = `url=${encodeURIComponent(canonical)}&max_commits=${encodeURIComponent(String(maxCommits))}&async=1`;
    const payload = useGet
      ? await api(`/api/github/inspect?${query}`)
      : await api("/api/github/inspect", { method: "POST", body: JSON.stringify({ github_url: canonical, max_commits: maxCommits, async: true }) });
    const completedPayload = payload.job_id ? await waitForInspectionJob(payload.job_id) : payload;
    state.inspection = completedPayload.inspection || null;
    setDashboardVisible(true);
    setStatsLoading();
    updateInspectionLoader(completedPayload.progress || {});
    renderInspection(state.inspection, completedPayload.summary || {});
    await hydrateGraph(completedPayload.summary || null, completedPayload.graph || null);
    await animateLoaderSnapshot(completedPayload.summary || {}, state.inspection, state.graph);
    renderFileTree(state.graph);
    updateInspectionLoader(completedPayload.progress || {});
    finishInspectionLoading();
    try {
      const storageStatus = await api("/api/storage/status");
      if (storageStatus?.storage_path) {
        setNotice("ingest-notice", `Loaded ${state.inspection?.github?.repository?.full_name || state.inspection?.repository?.full_name || canonical}. Graph-RAG local storage saved: ${storageStatus.storage_path} (${formatNumber(storageStatus.counts?.rag_chunks || 0)} chunks, ${formatNumber(storageStatus.counts?.embeddings || 0)} embeddings).`, "success");
      } else {
        setNotice("ingest-notice", `Loaded ${state.inspection?.github?.repository?.full_name || state.inspection?.repository?.full_name || canonical} in segmented stages.`, "success");
      }
    } catch (_e) {
      setNotice("ingest-notice", `Loaded ${state.inspection?.github?.repository?.full_name || state.inspection?.repository?.full_name || canonical} in segmented stages.`, "success");
    }
  } catch (error) {
    failInspectionLoading(error.message);
    setNotice("ingest-notice", error.message, "error");
    setGraphState("Inspection failed. Check the repository reference and try again.", "error");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Inspect repository <span>→</span>';
    $("#intake-progress").hidden = true;
  }
}

async function ingestLocalRepository() {
  const path = $("#repository-path")?.value?.trim() || "";
  if (!path) {
    setNotice("ingest-notice", "Enter a local Git repository path first.", "error");
    return;
  }
  const button = $("#ingest-button");
  if (button) {
    button.disabled = true;
    button.textContent = "Loading…";
  }
  beginInspectionLoading();
  setInspectionStage("source", "Reading the local repository", "Preparing tracked files and local commit history.");
  state.inspection = null;
  state.githubUrl = "";
  setNotice("ingest-notice", "Reading the local working tree and commit history…");
  try {
    const maxCommits = Number($("#max-commits")?.value || 500);
    const payload = await api("/api/ingest", { method: "POST", body: JSON.stringify({ repository_path: path, max_commits: maxCommits }) });
    setDashboardVisible(true);
    renderInspection(null, payload.summary || {});
    await animateLoaderSnapshot(payload.summary || {}, null, null);
    await hydrateGraph(payload.summary || null, null);
    await animateLoaderSnapshot(payload.summary || {}, null, state.graph);
    completeInspectionStagesThrough("source");
    setInspectionStage("tree", "Arranging the file tree", `${formatNumber(payload.summary?.counts?.files || 0)} files grouped into the repository tree.`);
    renderFileTree(state.graph);
    completeInspectionStagesThrough("tree");
    setInspectionStage("analysis", "Finishing architecture analysis", `${formatNumber(payload.summary?.counts?.nodes || 0)} graph nodes and ${formatNumber(payload.summary?.counts?.edges || 0)} relationships are ready.`);
    finishInspectionLoading();
    setNotice("ingest-notice", `Loaded local repository ${payload.summary?.repository?.name || "repository"}.`, "success");
  } catch (error) {
    failInspectionLoading(error.message);
    setNotice("ingest-notice", error.message, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Load local checkout";
    }
  }
}

async function openStoredRepository(repoName) {
  if (!repoName) return;
  closeStorageModal();
  setNotice("ingest-notice", `Loading ${repoName} from persistent storage…`);
  beginInspectionLoading();
  setInspectionStage("metadata", "Loading repository from storage", `Reading graph, source files, and Graph-RAG embeddings for ${repoName}…`);

  try {
    const payload = await api("/api/storage/open", {
      method: "POST",
      body: JSON.stringify({ repository: repoName }),
    });

    state.inspection = payload.inspection || null;
    state.githubUrl = payload.inspection?.repository?.url || "";
    setDashboardVisible(true);
    setStatsLoading();
    renderInspection(state.inspection, payload.summary || {});
    await hydrateGraph(payload.summary || null, payload.graph || null);
    await animateLoaderSnapshot(payload.summary || {}, state.inspection, state.graph);
    renderFileTree(state.graph);
    finishInspectionLoading();
    setNotice("ingest-notice", `Loaded ${payload.repository || repoName} directly from local storage. Ready!`, "success");
    showWorkspacePage("overview");
  } catch (error) {
    failInspectionLoading(error.message);
    setNotice("ingest-notice", error.message, "error");
  }
}

function renderStoredRepos(repositories) {
  const intakeList = $("#stored-repos-list");
  const modalList = $("#storage-modal-list");
  const card = $("#stored-repos-card");
  const repos = Array.isArray(repositories) ? repositories : [];

  if (card) {
    card.hidden = repos.length === 0;
  }

  const html = repos.length ? repos.map((repo) => {
    const displayName = repo.display_name || repo.name || "Repository";
    const files = formatNumber(repo.files_count || 0);
    const commits = formatNumber(repo.commits_count || 0);
    const nodes = formatNumber(repo.nodes_count || 0);
    const chunks = formatNumber(repo.chunks_count || 0);
    const date = formatDate(repo.saved_at);

    return `
      <div class="stored-repo-card">
        <div class="stored-repo-info">
          <div class="stored-repo-title-row">
            <span class="stored-repo-name" title="${escapeHtml(repo.name)}">${escapeHtml(displayName)}</span>
            <span class="stored-repo-date">${escapeHtml(date)}</span>
          </div>
          <div class="stored-repo-badges">
            <span class="stored-badge">${files} files</span>
            <span class="stored-badge">${commits} commits</span>
            ${nodes !== "0" ? `<span class="stored-badge">${nodes} nodes</span>` : ""}
            ${repo.has_rag ? `<span class="stored-badge rag">Graph-RAG (${chunks} chunks)</span>` : ""}
          </div>
        </div>
        <div class="stored-repo-actions">
          <button class="stored-repo-btn" type="button" data-open-stored-repo="${escapeHtml(repo.folder || repo.name)}">
            <span>Open Snapshot →</span>
          </button>
        </div>
      </div>
    `;
  }).join("") : '<div class="empty-state">No saved repositories found in local storage.</div>';

  if (intakeList) intakeList.innerHTML = html;
  if (modalList) modalList.innerHTML = html;
}

async function loadStoredRepositories() {
  try {
    const payload = await api("/api/storage/repositories");
    renderStoredRepos(payload.repositories || []);
  } catch (_e) {
    // Ignore if not ready
  }
}

function openStorageModal() {
  const modal = $("#storage-modal");
  if (modal) {
    modal.hidden = false;
    loadStoredRepositories();
  }
}

function closeStorageModal() {
  const modal = $("#storage-modal");
  if (modal) modal.hidden = true;
}

async function loadHealth() {
  setGraphAvailability(false);
  try {
    const health = await api("/api/health");
    $("#health-dot").className = "status-dot ready";
    $("#health-label").textContent = "Local server ready";
    const aiReady = Boolean(health.ai?.enabled);
    if ($("#ai-room-assist")) $("#ai-room-assist").checked = aiReady;
    if ($("#ai-assist")) $("#ai-assist").checked = aiReady;
    setAiRoomControls();
    setAiControls();
    renderProviders(health.ai);
    let catalog = health.ai?.catalog;
    // If catalog is missing or empty, fetch from API
    if (!catalog || !catalog.models || catalog.models.length === 0) {
      try {
        catalog = await api("/api/ai/catalog").catch(() => ({ models: [], providers: [] }));
      } catch (error) {
        catalog = { models: [], providers: [] };
      }
    }
    renderAiCatalog(catalog);
    renderNeo4jStatus(health.neo4j || { configured: false, connected: false });
    await checkNeo4j(false);
    await loadVercelStorageStatus();

    let inspection = health.inspection || null;
    if (!inspection) {
      try {
        const res = await api("/api/inspection");
        if (res?.inspection) inspection = res.inspection;
      } catch {}
    }
    state.inspection = inspection || state.inspection || null;

    if (health.graph_loaded) {
      setDashboardVisible(true);
      const summary = await api("/api/graph/summary");
      await hydrateGraph(summary, null);
      renderRepoOverview(state.inspection, summary);
      renderMetadata(state.inspection, summary);
      if (state.inspection) {
        renderInspection(state.inspection, summary);
      }
    }

    await loadStoredRepositories();
  } catch (error) {
    $("#health-dot").className = "status-dot error";
    $("#health-label").textContent = "Server unavailable";
    setNotice("ingest-notice", error.message, "error");
  }
}

function setupGraphPointerControls() {
  const wrap = $("#graph-wrap");
  if (!wrap) return;
  let drag = null;
  wrap.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".graph-node, .cg-node, .relationship-node, .architecture-node, .is-dragging-node")) return;
    drag = { x: event.clientX, y: event.clientY, startX: state.graphView.x, startY: state.graphView.y };
    wrap.classList.add("is-dragging");
    wrap.setPointerCapture(event.pointerId);
  });
  wrap.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const { width, height } = graphViewBoxSize();
    const rect = wrap.getBoundingClientRect();
    state.graphView.x = drag.startX + ((event.clientX - drag.x) / rect.width) * width;
    state.graphView.y = drag.startY + ((event.clientY - drag.y) / rect.height) * height;
    applyGraphTransform();
  });
  const endDrag = () => { drag = null; wrap.classList.remove("is-dragging"); };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);
  wrap.addEventListener("wheel", (event) => { event.preventDefault(); changeGraphZoom(event.deltaY < 0 ? .1 : -.1); }, { passive: false });
}

document.querySelectorAll("[data-page]").forEach((tab) => tab.addEventListener("click", () => showWorkspacePage(tab.dataset.page)));
window.addEventListener("hashchange", () => showWorkspacePage(window.location.hash.slice(1), false));

$("#inspect-button")?.addEventListener("click", () => inspectGithub(false));
$("#refresh-inspection")?.addEventListener("click", () => inspectGithub(true));
$("#new-inspection")?.addEventListener("click", () => {
  try {
    setDashboardVisible(false);
    const intake = $("#intake-screen");
    if (intake) intake.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    console.error("Failed to return to intake", error);
  }
});
$("#ingest-button")?.addEventListener("click", ingestLocalRepository);
$("#github-url")?.addEventListener("keydown", (event) => { if (event.key === "Enter") inspectGithub(false); });
document.querySelectorAll("[data-sample]").forEach((button) => button.addEventListener("click", () => {
  const input = $("#github-url");
  if (input) {
    input.value = button.dataset.sample;
    input.focus();
  }
}));
document.addEventListener("click", (event) => {
  const fileLink = event.target.closest?.("[data-open-source]");
  if (fileLink && fileLink.dataset.openSource) {
    event.preventDefault();
    const path = fileLink.dataset.openSource;
    showWorkspacePage("source");
    window.setTimeout(() => {
      if (typeof loadSource === "function") loadSource(path);
      if (typeof openEditorTab === "function") openEditorTab(path);
      if (typeof focusSourceGraphFile === "function") focusSourceGraphFile(path);
    }, 60);
    return;
  }
  const commitLink = event.target.closest?.("[data-open-commit]");
  if (commitLink && commitLink.dataset.openCommit) {
    event.preventDefault();
    const sha = commitLink.dataset.openCommit;
    showWorkspacePage("track");
    window.setTimeout(() => {
      if (typeof jumpToGitTrackCommit === "function") jumpToGitTrackCommit(sha);
    }, 60);
    return;
  }
  const action = event.target.closest?.("[data-goto-page]");
  if (!action) return;
  event.preventDefault();
  showWorkspacePage(action.dataset.gotoPage);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const action = event.target.closest?.("[data-goto-page]");
  if (!action) return;
  event.preventDefault();
  showWorkspacePage(action.dataset.gotoPage);
});
$("#ask-button")?.addEventListener("click", askQuestion);
$("#question-input")?.addEventListener("keydown", (event) => { if (event.key === "Enter") askQuestion(); });
$("#ai-room-send")?.addEventListener("click", askAiRoom);
$("#ai-room-question")?.addEventListener("keydown", (event) => { if (event.key === "Enter") askAiRoom(); });
$("#ai-room-assist")?.addEventListener("change", setAiRoomControls);
$("#file-tree")?.addEventListener("click", handleFileTreeClick);
$("#source-explain-button")?.addEventListener("click", explainSelectedSource);
$("#simulation-run")?.addEventListener("click", runSimulation);
$("#simulation-question")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runSimulation(); });
$("#compare-run")?.addEventListener("click", runCompare);
$("#ai-catalog-refresh")?.addEventListener("click", refreshAiCatalog);
$("#settings-ai-refresh")?.addEventListener("click", refreshAiCatalog);
$("#timeline-slider")?.addEventListener("input", (event) => renderTimelineDetail(Number(event.target.value)));
$("#timeline-axis")?.addEventListener("click", (event) => {
  const stop = event.target.closest("[data-timeline-index]");
  if (stop) renderTimelineDetail(Number(stop.dataset.timelineIndex));
});
$("#timeline-first")?.addEventListener("click", () => renderTimelineDetail(0));
$("#timeline-latest")?.addEventListener("click", () => renderTimelineDetail(Math.max(0, (state.timeline?.length || 1) - 1)));
$("#track-commit-search")?.addEventListener("input", () => { state.trackCommitLimit = 20; renderTrackCommits(); });
$("#track-commit-author")?.addEventListener("change", () => { state.trackCommitLimit = 20; renderTrackCommits(); });
$("#commit-history")?.addEventListener("click", (event) => {
  if (event.target.closest("#track-load-more")) {
    state.trackCommitLimit = (state.trackCommitLimit || 20) + 20;
    renderTrackCommits();
    return;
  }
  const focusButton = event.target.closest("[data-track-sha]");
  if (focusButton) {
    jumpToGitTrackCommit(focusButton.dataset.trackSha);
    return;
  }
  const fileButton = event.target.closest("[data-open-source-path]");
  if (fileButton) {
    const path = fileButton.dataset.openSourcePath;
    showWorkspacePage("source");
    window.setTimeout(() => {
      if (typeof focusSourceGraphFile === "function") focusSourceGraphFile(path);
      else if (typeof loadSource === "function") loadSource(path);
    }, 60);
  }
});
$("#evidence-search")?.addEventListener("input", (event) => {
  state.evidenceQuery = event.target.value || "";
  renderEvidenceChain();
});
document.querySelectorAll("[data-evidence-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.evidenceFilter = button.dataset.evidenceFilter || "all";
    document.querySelectorAll("[data-evidence-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderEvidenceChain();
  });
});
$("#neo4j-check-button")?.addEventListener("click", () => checkNeo4j(true));
$("#neo4j-sync-button")?.addEventListener("click", syncNeo4j);
$("#settings-neo4j-check")?.addEventListener("click", () => checkNeo4j(true));
$("#settings-neo4j-sync")?.addEventListener("click", syncNeo4j);
$("#ai-assist")?.addEventListener("change", setAiControls);
$("#graph-zoom-out")?.addEventListener("click", () => changeGraphZoom(-.1));
$("#graph-zoom-in")?.addEventListener("click", () => changeGraphZoom(.1));
$("#graph-zoom-reset")?.addEventListener("click", resetGraphView);
$("#graph-fullscreen")?.addEventListener("click", () => toggleFullscreen($("#graph-wrap")));
[ ["#ai-model", "#ai-provider"], ["#ai-room-model", "#ai-room-provider"] ].forEach(([modelSelector, providerSelector]) => {
  $(modelSelector)?.addEventListener("change", (event) => {
    const option = event.target.selectedOptions?.[0];
    const provider = option?.dataset?.provider || "";
    if (provider && $(providerSelector)) $(providerSelector).value = provider;
    state.aiSelectedProvider = $(providerSelector)?.value || "";
    state.aiSelectedModel = event.target.value;
  });
  // The model list always reflects the selected provider's free models.
  $(providerSelector)?.addEventListener("change", (event) => {
    selectAiProvider(event.target.value || "");
  });
});
document.querySelectorAll("[data-graph-mode]").forEach((button) => button.addEventListener("click", () => {
  state.graphMode = button.dataset.graphMode;
  document.querySelectorAll("[data-graph-mode]").forEach((item) => item.classList.toggle("active", item === button));
  if (state.graphLoaded) renderGraph(state.graph);
  if (state.graphMode === "code" && typeof loadGithubTimeline === "function") {
    loadGithubTimeline().then(() => { if (state.graphLoaded && state.graphMode === "code") renderGraph(state.graph); });
  }
  if (state.graphMode === "architecture") {
    generateArchitectureAIUnderstanding();
  }
}));
$("#architecture-ai-refresh")?.addEventListener("click", () => {
  state._architectureAiGenerated = false;
  generateArchitectureAIUnderstanding(true);
});

document.addEventListener("click", (event) => {
  const simTab = event.target.closest("[data-sim-tab]");
  if (simTab) {
    setSimulationTab(simTab.dataset.simTab);
    return;
  }
  const promptChip = event.target.closest("[data-sim-prompt]");
  if (promptChip) {
    runSimulation(promptChip.dataset.simPrompt);
    return;
  }
  const clearBtn = event.target.closest("#simulation-clear-btn");
  if (clearBtn) {
    state.simulationHistory = [];
    renderSimulationChatThread();
    return;
  }
  const switchTab = event.target.closest("[data-switch-sim-tab]");
  if (switchTab) {
    setSimulationTab(switchTab.dataset.switchSimTab);
    return;
  }
  const openStored = event.target.closest("[data-open-stored-repo]");
  if (openStored) {
    openStoredRepository(openStored.dataset.openStoredRepo);
    return;
  }
  if (event.target.closest("#open-storage-button")) {
    openStorageModal();
    return;
  }
  if (event.target.closest("#storage-modal-close")) {
    closeStorageModal();
    return;
  }
  if (event.target.classList.contains("storage-modal-overlay")) {
    closeStorageModal();
    return;
  }
});

setAiControls();
setAiRoomControls();
showWorkspacePage(window.location.hash.slice(1) || "overview", false);
loadHealth();

setupGraphPointerControls();
setupSvgPanZoom({
  wrapId: "source-graph-wrap",
  svgId: "source-relation-graph",
  viewKey: "sourceGraphView",
  labelId: "source-graph-zoom-reset",
  worldGetter: () => state.sourceGraphWorld,
});
$("#source-graph-zoom-out")?.addEventListener("click", () => zoomSurface("sourceGraphView", -.15));
$("#source-graph-zoom-in")?.addEventListener("click", () => zoomSurface("sourceGraphView", .15));
$("#source-graph-zoom-reset")?.addEventListener("click", () => resetSurface("sourceGraphView"));
$("#source-graph-fullscreen")?.addEventListener("click", () => toggleFullscreen($("#source-graph-wrap")));
$("#source-graph-fit")?.addEventListener("click", () => fitSurface("sourceGraphView"));

async function loadVercelStorageStatus() {
  const dot = $("#settings-vercel-dot");
  const label = $("#settings-vercel-label");
  try {
    const data = await api("/api/storage/vercel/status");
    if (dot && label) {
      if (data.configured) {
        dot.className = "status-dot ready";
        const count = data.repositories?.length || 0;
        label.textContent = `Connected (${count} stored repo${count === 1 ? "" : "s"}, ${data.blob_count} blobs)`;
      } else {
        dot.className = "status-dot";
        label.textContent = "Not configured (BLOB_READ_WRITE_TOKEN missing)";
      }
    }
  } catch (_e) {
    if (dot && label) {
      dot.className = "status-dot failed";
      label.textContent = "Vercel Storage check failed";
    }
  }
}

async function saveToVercelStorage(sourceNoticeId = "settings-vercel-notice") {
  const btn = $("#settings-vercel-save");
  const modalBtn = $("#modal-vercel-save-btn");
  const notice = $(`#${sourceNoticeId}`) || $("#settings-vercel-notice");
  [btn, modalBtn].filter(Boolean).forEach((b) => {
    b.disabled = true;
    b.textContent = "Saving to Vercel…";
  });
  if (notice) {
    notice.className = "notice info";
    notice.textContent = "Uploading repository snapshot to Vercel Blob Storage…";
  }
  try {
    const res = await api("/api/storage/vercel/save", { method: "POST" });
    const kb = Math.round((res.total_bytes || 0) / 1024);
    const msg = `Saved ${res.uploaded_files} files (${kb} KB) to Vercel Storage for ${res.repository}.`;
    if (notice) {
      notice.className = "notice ready";
      notice.textContent = msg;
    }
    await loadVercelStorageStatus();
  } catch (err) {
    if (notice) {
      notice.className = "notice failed";
      notice.textContent = `Vercel save error: ${err.message || err}`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save to Vercel Storage"; }
    if (modalBtn) { modalBtn.disabled = false; modalBtn.textContent = "Save to Vercel"; }
  }
}

async function restoreFromVercelStorage(sourceNoticeId = "settings-vercel-notice") {
  const btn = $("#settings-vercel-restore");
  const modalBtn = $("#modal-vercel-restore-btn");
  const notice = $(`#${sourceNoticeId}`) || $("#settings-vercel-notice");
  const repo = prompt("Enter the repository name to restore from Vercel Storage (e.g. attendx):");
  if (!repo || !repo.trim()) return;

  [btn, modalBtn].filter(Boolean).forEach((b) => {
    b.disabled = true;
    b.textContent = "Restoring…";
  });
  if (notice) {
    notice.className = "notice info";
    notice.textContent = `Restoring ${repo.trim()} from Vercel Blob Storage…`;
  }
  try {
    const res = await api("/api/storage/vercel/restore", {
      method: "POST",
      body: JSON.stringify({ repository: repo.trim() })
    });
    const msg = `Restored ${res.restored_files} files from Vercel Storage and loaded snapshot!`;
    if (notice) {
      notice.className = "notice ready";
      notice.textContent = msg;
    }
    await loadStoredRepositories();
    if (res.summary) {
      applyGraphSummary(res.summary);
      setGraphAvailability(true);
      closeStorageModal();
      showWorkspacePage("overview", true);
    }
  } catch (err) {
    if (notice) {
      notice.className = "notice failed";
      notice.textContent = `Vercel restore error: ${err.message || err}`;
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Restore from Vercel"; }
    if (modalBtn) { modalBtn.disabled = false; modalBtn.textContent = "Restore from Vercel"; }
  }
}

$("#settings-vercel-save")?.addEventListener("click", () => saveToVercelStorage("settings-vercel-notice"));
$("#settings-vercel-restore")?.addEventListener("click", () => restoreFromVercelStorage("settings-vercel-notice"));
$("#modal-vercel-save-btn")?.addEventListener("click", () => saveToVercelStorage("modal-vercel-notice"));
$("#modal-vercel-restore-btn")?.addEventListener("click", () => restoreFromVercelStorage("modal-vercel-notice"));
