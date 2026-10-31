/* ==========================================================================
   MNEMO AGENTS VIEW
   Two relationship views for the Agents tab:
   1. Agents workflow — repository → orchestrator → contributor agents grouped
      by the area of the codebase they touched.
   2. Code graph — repository → contributors → the files they changed.
   Both canvases are pannable and zoomable.
   ========================================================================== */

if (typeof window !== "undefined" && typeof window.state === "undefined" && typeof state === "undefined") {
  window.state = {};
}

const AGENT_AREAS = [
  { key: "frontend", label: "Agents for Frontend" },
  { key: "backend", label: "Agents for Backend" },
  { key: "database", label: "Agents for Database" },
  { key: "tests", label: "Agents for Tests" },
  { key: "docs", label: "Agents for Docs" },
  { key: "core", label: "Agents for Core" },
];

function agentAreaFor(path) {
  const value = String(path || "").toLowerCase();
  if (/(^|\/)(tests?|__tests__|specs?)\//.test(value) || /\.(test|spec)\./.test(value)) return "tests";
  if (/(^|\/)docs?\//.test(value) || /\.(md|mdx|rst)$/.test(value)) return "docs";
  if (/(db|database|sql|schema|migration|neo4j|persistence|storage|query)/.test(value)) return "database";
  if (/(^|\/)(web|ui|frontend|client|components?|styles?|assets)\/|\.(css|scss|html|jsx|tsx)$/.test(value)) return "frontend";
  if (/(^|\/)(api|server|backend|routes?|services?|controllers?|handlers?)\/|\.py$/.test(value)) return "backend";
  return "core";
}

function agentContributors() {
  const nodes = state.graph?.nodes || [];
  const edges = state.graph?.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const commitOwner = new Map();
  edges.filter((edge) => edge.type === "AUTHORED").forEach((edge) => commitOwner.set(edge.target, edge.source));
  const modifications = new Map();
  edges.filter((edge) => edge.type === "MODIFIED").forEach((edge) => {
    if (!modifications.has(edge.source)) modifications.set(edge.source, []);
    modifications.get(edge.source).push(edge.target);
  });

  const agents = new Map();

  // 1. Populate directly from Contributor nodes in the graph
  nodes.filter((node) => graphNodeType(node) === "Contributor" || String(node.id || "").startsWith("contributor:")).forEach((contributor) => {
    const rawLogin = contributor.username || contributor.display_name || String(contributor.id).replace(/^contributor:/, "");
    const login = rawLogin.split("@")[0] || rawLogin;
    agents.set(contributor.id, {
      id: contributor.id,
      login,
      rawLogin,
      name: contributor.display_name || contributor.username || login,
      commits: contributor.contributions || contributor.commit_count || 0,
      avatar_url: contributor.avatar_url || "",
      files: new Map(),
      areas: new Map(),
      lastCommit: "",
    });
  });

  // 2. Link commits and touched files
  nodes.filter((node) => graphNodeType(node) === "Commit" || String(node.id || "").startsWith("commit:")).forEach((commit) => {
    let ownerId = commitOwner.get(commit.id);
    if (!ownerId && (commit.author_login || commit.author_email || commit.author)) {
      const auth = commit.author_login || commit.author_email || commit.author;
      ownerId = `contributor:${auth}`;
    }
    if (!ownerId && agents.size === 1) {
      ownerId = [...agents.keys()][0];
    }
    if (!ownerId) return;
    if (!agents.has(ownerId)) {
      const contributor = byId.get(ownerId);
      const rawLogin = contributor?.username || contributor?.display_name || String(ownerId).replace(/^contributor:/, "");
      const login = rawLogin.split("@")[0] || rawLogin;
      agents.set(ownerId, {
        id: ownerId,
        login,
        rawLogin,
        name: contributor?.display_name || contributor?.username || login,
        commits: 0,
        avatar_url: contributor?.avatar_url || "",
        files: new Map(),
        areas: new Map(),
        lastCommit: "",
      });
    }
    const agent = agents.get(ownerId);
    agent.commits = (agent.commits || 0) + 1;
    if (commit.timestamp && (!agent.lastCommit || commit.timestamp > agent.lastCommit)) agent.lastCommit = commit.timestamp;
    (modifications.get(commit.id) || []).forEach((fileId) => {
      const file = byId.get(fileId);
      const path = file?.path || file?.file_path;
      if (!path) return;
      agent.files.set(path, (agent.files.get(path) || 0) + 1);
      const area = agentAreaFor(path);
      agent.areas.set(area, (agent.areas.get(area) || 0) + 1);
    });
  });

  // 3. Populate and enrich from cached API agents if present
  if (Array.isArray(state.cachedAgents) && state.cachedAgents.length) {
    state.cachedAgents.forEach((person) => {
      const rawLogin = person.login || person.name || "contributor";
      const login = rawLogin.split("@")[0] || rawLogin;
      const key = `api:${login}`;
      const existing = [...agents.values()].find((a) => a.login === login || a.rawLogin === rawLogin || a.id === `contributor:${rawLogin}` || a.id === `contributor:${login}`);
      if (existing) {
        if (!existing.avatar_url && person.avatar_url) existing.avatar_url = person.avatar_url;
        if (person.contributions && existing.commits < person.contributions) existing.commits = person.contributions;
        (person.touched_files || []).forEach((p) => {
          if (!existing.files.has(p)) existing.files.set(p, 1);
          const a = agentAreaFor(p);
          existing.areas.set(a, (existing.areas.get(a) || 0) + 1);
        });
      } else {
        const fileMap = new Map((person.touched_files || []).map((p) => [p, 1]));
        const areaMap = new Map();
        (person.touched_files || []).forEach((p) => {
          const a = agentAreaFor(p);
          areaMap.set(a, (areaMap.get(a) || 0) + 1);
        });
        agents.set(key, {
          id: key,
          login,
          rawLogin,
          name: person.name || login,
          commits: person.commits || person.commit_count || person.contributions || 1,
          avatar_url: person.avatar_url || "",
          files: fileMap,
          areas: areaMap.size ? areaMap : new Map([["core", 1]]),
          lastCommit: person.last_commit || "",
        });
      }
    });
  }

  // 4. Fallback to inspection github data
  if (!agents.size) {
    const activity = state.inspection?.github?.contributor_activity || state.inspection?.github?.contributors || state.inspection?.contributors || [];
    activity.slice(0, 40).forEach((person) => {
      const rawLogin = person.login || person.username || "contributor";
      const login = rawLogin.split("@")[0] || rawLogin;
      agents.set(`github:${login}`, {
        id: `github:${login}`,
        login,
        rawLogin,
        name: person.name || login,
        commits: person.commit_count || person.contributions || 1,
        avatar_url: person.avatar_url || "",
        files: new Map(),
        areas: new Map([["core", 1]]),
        lastCommit: person.last_commit || "",
      });
    });
  }

  return [...agents.values()]
    .map((agent) => {
      const ranked = [...agent.areas.entries()].sort((a, b) => b[1] - a[1]);
      return {
        ...agent,
        area: ranked.length ? ranked[0][0] : "core",
        fileCount: agent.files.size,
        topFiles: [...agent.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
      };
    })
    .sort((a, b) => b.commits - a.commits);
}

function agentInitial(agent) {
  return String(agent?.login || agent?.name || "?").slice(0, 1).toUpperCase();
}

function agentCurve(from, to, bow = 0.2) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const controlX = midX + (-dy / distance) * Math.min(90, distance * bow);
  const controlY = midY + (dx / distance) * Math.min(90, distance * bow);
  return `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`;
}

function agNode(world, name, attributes = {}) {
  const element = svgElement(name, Object.assign({ class: "ag-node" }, attributes));
  world.appendChild(element);
  return element;
}

function agText(world, x, y, text, className, anchor = "middle") {
  const element = svgElement("text", { x, y, class: className, "text-anchor": anchor });
  element.textContent = text;
  world.appendChild(element);
  return element;
}

function agEdge(world, from, to, className, bow = 0.2) {
  const path = svgElement("path", { d: agentCurve(from, to, bow), class: `ag-edge ${className}` });
  world.appendChild(path);
  return path;
}

function agentEmptyState(stateId, metaId, message) {
  const stateEl = document.getElementById(stateId);
  const meta = document.getElementById(metaId);
  if (stateEl) {
    stateEl.hidden = false;
    stateEl.textContent = message;
  }
  if (meta) meta.textContent = "Awaiting repository";
}

function renderAgentWorkflow(agents) {
  const svg = document.getElementById("agent-workflow-graph");
  const stateEl = document.getElementById("agent-workflow-state");
  const meta = document.getElementById("agent-workflow-meta");
  if (!svg) return;
  if (!agents || !agents.length) {
    svg.replaceChildren();
    state.agentWorkflowWorld = null;
    agentEmptyState("agent-workflow-state", "agent-workflow-meta", (state.graphLoaded || state.graph?.nodes?.length)
      ? "No contributors were returned for this snapshot."
      : "Inspect a repository to reveal the agent workflow.");
    return;
  }
  if (stateEl) stateEl.hidden = true;

  const groups = AGENT_AREAS.map((area) => ({
    ...area,
    agents: agents.filter((agent) => agent.area === area.key),
  })).filter((group) => group.agents.length);
  const columns = Math.min(3, Math.max(1, groups.length));
  const groupWidth = 372;
  const groupGap = 28;
  const agentCell = { width: 166, height: 88 };
  const agentsPerRow = 2;
  const width = Math.max(1400, columns * groupWidth + (columns - 1) * groupGap + 140);
  const groupStartX = (width - (columns * groupWidth + (columns - 1) * groupGap)) / 2;

  const rowHeights = [];
  groups.forEach((group, index) => {
    const row = Math.floor(index / columns);
    const rows = Math.ceil(group.agents.length / agentsPerRow);
    rowHeights[row] = Math.max(rowHeights[row] || 0, 54 + rows * agentCell.height + 28);
  });
  const groupTop = 262;
  const rowTops = [];
  rowHeights.forEach((height, index) => {
    rowTops[index] = groupTop + rowHeights.slice(0, index).reduce((sum, value) => sum + value + 30, 0);
  });
  const height = Math.max(760, rowTops[rowTops.length - 1] + rowHeights[rowHeights.length - 1] + 90);

  const world = svgElement("g", { class: "ag-world" });
  svg.replaceChildren(world);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  state.agentWorkflowWorld = world;
  const view = viewState("agentWorkflowView");
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  applyPanZoom(view, world, document.getElementById("agent-workflow-zoom-reset"));

  const repository = state.inspection?.github?.repository || state.inspection?.repository || {};
  const repoName = repository.full_name || repository.name || "Repository";
  const centerX = width / 2;

  // Repository → orchestrator.
  const repoPosition = { x: centerX, y: 56 };
  agNode(world, "rect", { x: centerX - 150, y: 30, width: 300, height: 52, rx: 16, class: "ag-repo-box" });
  agText(world, centerX, 54, String(repoName).slice(0, 34), "ag-repo-name");
  agText(world, centerX, 70, `${formatNumber(agents.length)} contributor agents · ${formatNumber(groups.length)} areas`, "ag-repo-sub");

  const orchestrator = { x: centerX, y: 186 };
  const edge = svgElement("path", { d: `M ${repoPosition.x} ${repoPosition.y + 26} L ${orchestrator.x} ${orchestrator.y - 46}`, class: "ag-edge ag-edge-repo" });
  world.appendChild(edge);
  agNode(world, "circle", { cx: orchestrator.x, cy: orchestrator.y, r: 46, class: "ag-orchestrator-ring" });
  agNode(world, "circle", { cx: orchestrator.x, cy: orchestrator.y, r: 34, class: "ag-orchestrator-core" });
  agText(world, orchestrator.x, orchestrator.y + 4, "ORCH", "ag-orchestrator-label");
  agText(world, orchestrator.x, orchestrator.y + 70, "Orchestrator", "ag-node-title");
  agText(world, orchestrator.x, orchestrator.y + 86, "routes every question to parallel agents", "ag-node-sub");

  // Area groups with their contributor agents.
  groups.forEach((group, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = groupStartX + column * (groupWidth + groupGap);
    const y = rowTops[row];
    const rows = Math.ceil(group.agents.length / agentsPerRow);
    const groupHeight = 54 + rows * agentCell.height + 28;
    agNode(world, "rect", { x, y, width: groupWidth, height: groupHeight, rx: 20, class: "ag-group-box" });
    agText(world, x + 18, y + 26, group.label, "ag-group-label", "start");
    agText(world, x + groupWidth - 18, y + 26, `${formatNumber(group.agents.length)} agents`, "ag-group-count", "end");

    group.agents.slice(0, 6).forEach((agent, agentIndex) => {
      const agentRow = Math.floor(agentIndex / agentsPerRow);
      const agentColumn = agentIndex % agentsPerRow;
      const cx = x + 18 + agentCell.width / 2 + agentColumn * agentCell.width;
      const cy = y + 54 + agentCell.height / 2 + agentRow * agentCell.height;
      world.appendChild(svgElement("path", {
        d: agentCurve(orchestrator, { x: cx, y: cy - 22 }, 0.18),
        class: "ag-edge ag-edge-orchestrator",
      }));
      const group = svgElement("g", { class: "ag-node ag-agent", tabindex: "0", role: "button", "aria-label": `Agent ${agent.login}` });
      group.appendChild(svgElement("circle", { cx, cy, r: 24, class: "ag-agent-ring" }));
      const initial = svgElement("text", { x: cx, y: cy + 5, class: "ag-agent-initial", "text-anchor": "middle" });
      initial.textContent = agentInitial(agent);
      group.appendChild(initial);
      const name = svgElement("text", { x: cx, y: cy + 42, class: "ag-agent-name", "text-anchor": "middle" });
      name.textContent = String(agent.login).split("@")[0].slice(0, 20);
      group.appendChild(name);
      const count = svgElement("text", { x: cx, y: cy + 56, class: "ag-agent-count", "text-anchor": "middle" });
      count.textContent = `${formatNumber(agent.commits)} commits · ${formatNumber(agent.fileCount)} files`;
      group.appendChild(count);
      const title = svgElement("title");
      title.textContent = `${agent.login}${agent.name && agent.name !== agent.login ? ` · ${agent.name}` : ""} · ${agent.area}`;
      group.appendChild(title);
      group.addEventListener("click", () => showAgentDetail(agent));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showAgentDetail(agent);
        }
      });
      world.appendChild(group);
    });
    if (group.agents.length > 6) {
      agText(world, x + groupWidth / 2, y + groupHeight - 8, `+${formatNumber(group.agents.length - 6)} more agents`, "ag-group-more");
    }
  });

  if (meta) {
    meta.textContent = `${formatNumber(agents.length)} agents · ${formatNumber(groups.length)} areas · ${formatNumber(agents.reduce((sum, agent) => sum + agent.commits, 0))} commits routed`;
  }
  applyPanZoom(viewState("agentWorkflowView"), world, document.getElementById("agent-workflow-zoom-reset"));
}

function renderAgentCodeGraph(agents) {
  const svg = document.getElementById("agent-code-graph");
  const stateEl = document.getElementById("agent-code-state");
  const meta = document.getElementById("agent-code-meta");
  if (!svg) return;
  if (!agents || !agents.length) {
    svg.replaceChildren();
    state.agentCodeWorld = null;
    agentEmptyState("agent-code-state", "agent-code-meta", (state.graphLoaded || state.graph?.nodes?.length)
      ? "No contributor records were returned for this snapshot."
      : "Inspect a repository to render its code graph.");
    return;
  }
  if (stateEl) stateEl.hidden = true;

  const files = (state.graph?.nodes || []).filter((node) => graphNodeType(node) === "File" && (node.path || node.file_path));
  const fileScores = new Map();
  agents.forEach((agent) => agent.topFiles.forEach(([path, count]) => {
    fileScores.set(path, (fileScores.get(path) || 0) + count);
  }));
  let visibleFiles = [...fileScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([path]) => path);
  if (!visibleFiles.length && files.length) {
    visibleFiles = files.slice(0, 10).map((f) => f.path || f.file_path);
  }
  const visibleAgents = agents.slice(0, 8);
  const agentBandWidth = Math.max(visibleAgents.length * 165, Math.min(visibleFiles.length, 6) * 200);
  const width = Math.min(1800, Math.max(1400, agentBandWidth + 200));
  const height = 720;
  const world = svgElement("g", { class: "ag-world" });
  svg.replaceChildren(world);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  state.agentCodeWorld = world;
  const view = viewState("agentCodeView");
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  applyPanZoom(view, world, document.getElementById("agent-code-zoom-reset"));

  const repository = state.inspection?.github?.repository || state.inspection?.repository || {};
  const repoName = repository.full_name || repository.name || "Repository";
  const centerX = width / 2;
  const repoPosition = { x: centerX, y: 62 };
  agNode(world, "rect", { x: centerX - 170, y: 36, width: 340, height: 54, rx: 16, class: "ag-repo-box" });
  agText(world, centerX, 60, "REPO", "ag-repo-kicker");
  agText(world, centerX, 80, String(repoName).slice(0, 40), "ag-repo-name");

  const agentPositions = new Map();
  const agentStep = Math.min(160, (width - 220) / Math.max(1, visibleAgents.length));
  const agentStart = centerX - ((visibleAgents.length - 1) * agentStep) / 2;
  visibleAgents.forEach((agent, index) => {
    const cx = agentStart + index * agentStep;
    const cy = 230;
    agentPositions.set(agent.id, { x: cx, y: cy });
    world.appendChild(svgElement("path", {
      d: agentCurve(repoPosition, { x: cx, y: cy - 24 }, 0.16),
      class: "ag-edge ag-edge-repo",
    }));
    const group = svgElement("g", { class: "ag-node ag-agent", tabindex: "0", role: "button", "aria-label": `Contributor ${agent.login}` });
    group.appendChild(svgElement("circle", { cx, cy, r: 25, class: "ag-agent-ring" }));
    const initial = svgElement("text", { x: cx, y: cy + 5, class: "ag-agent-initial", "text-anchor": "middle" });
    initial.textContent = agentInitial(agent);
    group.appendChild(initial);
    const label = svgElement("text", { x: cx, y: cy + 44, class: "ag-agent-name", "text-anchor": "middle" });
    label.textContent = String(agent.login).split("@")[0].slice(0, 18);
    group.appendChild(label);
    const count = svgElement("text", { x: cx, y: cy + 58, class: "ag-agent-count", "text-anchor": "middle" });
    count.textContent = `${agent.area} · ${formatNumber(agent.commits)} commits`;
    group.appendChild(count);
    const title = svgElement("title");
    title.textContent = `${agent.login} · ${formatNumber(agent.commits)} commits · ${formatNumber(agent.fileCount)} files`;
    group.appendChild(title);
    group.addEventListener("click", () => showAgentDetail(agent));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showAgentDetail(agent);
      }
    });
    world.appendChild(group);
  });

  const filesPerRow = Math.min(6, Math.max(1, visibleFiles.length));
  const fileStep = Math.min(220, (width - 180) / Math.max(1, filesPerRow));
  const fileStart = centerX - ((Math.min(filesPerRow, visibleFiles.length) - 1) * fileStep) / 2;
  const filePositions = new Map();
  visibleFiles.forEach((path, index) => {
    const row = Math.floor(index / filesPerRow);
    const column = index % filesPerRow;
    const x = fileStart + column * fileStep;
    const y = 420 + row * 118;
    filePositions.set(path, { x, y });
    const group = svgElement("g", { class: "ag-node ag-file", tabindex: "0", role: "button", "aria-label": `File ${path}` });
    group.appendChild(svgElement("rect", { x: x - 90, y: y - 26, width: 180, height: 52, rx: 10, class: "ag-file-box" }));
    const name = svgElement("text", { x, y: y - 4, class: "ag-file-name", "text-anchor": "middle" });
    name.textContent = String(path).split("/").pop().slice(0, 24);
    group.appendChild(name);
    const detail = svgElement("text", { x, y: y + 13, class: "ag-file-path", "text-anchor": "middle" });
    detail.textContent = String(path).slice(0, 30);
    group.appendChild(detail);
    const title = svgElement("title");
    title.textContent = path;
    group.appendChild(title);
    group.addEventListener("click", () => {
      if (typeof focusSourceGraphFile === "function") {
        showWorkspacePage("source");
        setTimeout(() => focusSourceGraphFile(path), 40);
      }
    });
    world.appendChild(group);
  });

  visibleAgents.forEach((agent) => {
    const from = agentPositions.get(agent.id);
    if (!from) return;
    agent.topFiles.slice(0, 3).forEach(([path]) => {
      const to = filePositions.get(path);
      if (!to) return;
      world.appendChild(svgElement("path", {
        d: agentCurve({ x: from.x, y: from.y + 26 }, { x: to.x, y: to.y - 26 }, 0.12),
        class: "ag-edge ag-edge-file",
      }));
    });
  });

  agText(world, 28, 176, "CONTRIBUTORS", "ag-band-label", "start");
  agText(world, 28, 386, "TOUCHED FILES", "ag-band-label", "start");

  if (meta) {
    const shown = visibleAgents.length < agents.length ? `${formatNumber(visibleAgents.length)} of ${formatNumber(agents.length)} contributors` : `${formatNumber(visibleAgents.length)} contributors`;
    meta.textContent = `${shown} · ${formatNumber(visibleFiles.length)} shared files · ${formatNumber(files.length)} tracked files`;
  }
  applyPanZoom(viewState("agentCodeView"), world, document.getElementById("agent-code-zoom-reset"));
}

function showAgentDetail(agent) {
  const detail = document.getElementById("agent-code-detail");
  if (!detail) return;
  state.selectedAgent = agent.login;
  const files = agent.topFiles.length
    ? agent.topFiles.map(([path, count]) => `<li><code>${escapeHtml(path)}</code><span>${formatNumber(count)} change${count === 1 ? "" : "s"}</span></li>`).join("")
    : "<li><span>No file targets were recorded for this contributor.</span></li>";
  detail.innerHTML = `<article class="agent-detail-card"><header><span class="ag-agent-chip">${escapeHtml(agentInitial(agent))}</span><div><strong>${escapeHtml(agent.login)}</strong><span>${escapeHtml(agent.area)} agent${agent.lastCommit ? ` · last commit ${escapeHtml(formatDate(agent.lastCommit))}` : ""}</span></div><span class="agent-detail-count">${formatNumber(agent.commits)} commits · ${formatNumber(agent.fileCount)} files</span></header><ul>${files}</ul></article>`;
}

async function renderAgentsPage() {
  const workflowSvg = document.getElementById("agent-workflow-graph");
  if (!workflowSvg) return;
  if (!state.cachedAgents) {
    try {
      const res = await api("/api/agents?limit=100");
      if (res?.agents?.length) {
        state.cachedAgents = res.agents;
      }
    } catch (_e) {}
  }
  let agents = agentContributors();
  renderAgentWorkflow(agents);
  renderAgentCodeGraph(agents);
  if (agents.length) {
    const selected = (state.selectedAgent && agents.find((agent) => agent.login === state.selectedAgent)) || agents[0];
    if (selected) showAgentDetail(selected);
  }
}

(() => {
  const setupPan = typeof setupSvgPanZoom === "function" ? setupSvgPanZoom : (typeof window !== "undefined" && typeof window.setupSvgPanZoom === "function" ? window.setupSvgPanZoom : null);
  if (document.getElementById("agent-workflow-wrap")) {
    if (setupPan) {
      setupPan({
        wrapId: "agent-workflow-wrap",
        svgId: "agent-workflow-graph",
        viewKey: "agentWorkflowView",
        labelId: "agent-workflow-zoom-reset",
        worldGetter: () => state.agentWorkflowWorld,
      });
    }
    document.getElementById("agent-workflow-zoom-out")?.addEventListener("click", () => zoomSurface("agentWorkflowView", -.15));
    document.getElementById("agent-workflow-zoom-in")?.addEventListener("click", () => zoomSurface("agentWorkflowView", .15));
    document.getElementById("agent-workflow-zoom-reset")?.addEventListener("click", () => typeof resetSurface === "function" ? resetSurface("agentWorkflowView") : null);
    document.getElementById("agent-workflow-fullscreen")?.addEventListener("click", () => {
      const el = document.getElementById("agent-workflow-wrap");
      if (!el) return;
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(()=>{}); return; }
      el.requestFullscreen?.().catch(()=>{});
    });
  }
  if (document.getElementById("agent-code-wrap")) {
    if (setupPan) {
      setupPan({
        wrapId: "agent-code-wrap",
        svgId: "agent-code-graph",
        viewKey: "agentCodeView",
        labelId: "agent-code-zoom-reset",
        worldGetter: () => state.agentCodeWorld,
      });
    }
    document.getElementById("agent-code-zoom-out")?.addEventListener("click", () => typeof zoomSurface === "function" ? zoomSurface("agentCodeView", -.15) : null);
    document.getElementById("agent-code-zoom-in")?.addEventListener("click", () => typeof zoomSurface === "function" ? zoomSurface("agentCodeView", .15) : null);
    document.getElementById("agent-code-zoom-reset")?.addEventListener("click", () => typeof resetSurface === "function" ? resetSurface("agentCodeView") : null);
    document.getElementById("agent-code-fullscreen")?.addEventListener("click", () => {
      const el = document.getElementById("agent-code-wrap");
      if (!el) return;
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(()=>{}); return; }
      el.requestFullscreen?.().catch(()=>{});
    });
  }
  window.renderAgentsPage = renderAgentsPage;
  if (typeof renderAgentsPage === "function" && state.activePage === "agents") renderAgentsPage();
})();
