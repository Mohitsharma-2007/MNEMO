/* ==========================================================================
   MNEMO CODE GRAPH (GraphRAG view)
   Repository hub → contributors → pull requests / releases / commits →
   files → functions & classes, with import and call relations between them.
   ========================================================================== */

if (typeof window !== "undefined" && typeof window.state === "undefined" && typeof state === "undefined") {
  window.state = {};
}
if (typeof state !== "undefined") {
  state.codeGraphFocus = state.codeGraphFocus || "";
}

const CG_LIMITS = {
  contributors: 22,
  commitsPerContributor: 3,
  prs: 14,
  releases: 6,
  files: 30,
  symbols: 24,
  callees: 6,
};

function cgNode(layer, tag, attributes, className) {
  const element = svgElement(tag, Object.assign({ class: className }, attributes));
  layer.appendChild(element);
  return element;
}

function cgText(layer, x, y, text, className, anchor = "middle") {
  const element = svgElement("text", { x, y, class: className, "text-anchor": anchor });
  element.textContent = text;
  layer.appendChild(element);
  return element;
}

function cgCurve(from, to, bend = 0.45) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const c1x = from.x + dx * bend;
  const c1y = from.y + dy * 0.55 + Math.min(70, Math.abs(dx) * 0.12);
  const c2x = to.x - dx * bend;
  const c2y = to.y - dy * 0.4;
  return `M ${from.x} ${from.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${to.x} ${to.y}`;
}

function cgDeliveryData() {
  const source = state.githubTimeline || {};
  const github = state.inspection?.github || {};
  const pulls = (source.pull_requests?.length ? source.pull_requests : github.pull_requests || []);
  const releases = (source.releases?.length ? source.releases : github.releases || []);
  return { pulls, releases };
}

function cgContributorIdentity(node) {
  const username = node.username || "";
  return String(node.display_name || node.login || username || "contributor");
}

function cgLoginKey(value) {
  return String(value || "").toLowerCase().replace(/^@/, "").split("@")[0].trim();
}

function renderCodeGraph(graph) {
  const svg = document.getElementById("graph-canvas");
  const meta = document.getElementById("graph-meta");
  const stateEl = document.getElementById("graph-state");
  const targetGraph = (graph && Array.isArray(graph.nodes)) ? graph : state.graph;
  const nodes = targetGraph?.nodes || [];
  const edges = targetGraph?.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const world = createGraphWorld();
  if (stateEl) stateEl.hidden = true;

  const fileNodes = nodes.filter((node) => graphNodeType(node) === "File");
  const commitNodes = nodes.filter((node) => graphNodeType(node) === "Commit");
  const contributorNodes = nodes.filter((node) => graphNodeType(node) === "Contributor");
  const symbolNodes = nodes.filter((node) => ["Function", "Class"].includes(graphNodeType(node)));
  const repoNode = nodes.find((node) => graphNodeType(node) === "Repository") || { id: "repository:repo", name: "Repository" };
  const repo = graph?.repository || state.inspection?.repository || {};
  const repoName = repoNode.name || repo.name || "Repository";

  if (!nodes.length) {
    setGraphState("Inspect a repository to render its code graph.");
    if (meta) meta.textContent = "No graph data";
    return;
  }

  // --- ranked selections so a 1k-node graph stays readable ----------------
  const modifiedCount = new Map();
  const importsByFile = new Map();
  edges.forEach((edge) => {
    if (edge.type === "MODIFIED") modifiedCount.set(edge.target, (modifiedCount.get(edge.target) || 0) + 1);
    if (edge.type === "IMPORTS") {
      importsByFile.set(edge.source, (importsByFile.get(edge.source) || 0) + 1);
    }
  });
  const rankedFiles = [...fileNodes]
    .sort((a, b) => (modifiedCount.get(b.id) || 0) + (importsByFile.get(b.id) || 0) * 2
      - ((modifiedCount.get(a.id) || 0) + (importsByFile.get(a.id) || 0) * 2)
      || String(a.path).localeCompare(String(b.path)))
    .slice(0, CG_LIMITS.files);
  const visibleFiles = new Set(rankedFiles.map((node) => node.id));
  const focusId = visibleFiles.has(state.codeGraphFocus) ? state.codeGraphFocus : "";

  // newest commits first, at most 3 per contributor
  const commits = [...commitNodes].sort((a, b) => (b.history_index || 0) - (a.history_index || 0));
  const authorOf = new Map();
  edges.filter((edge) => edge.type === "AUTHORED").forEach((edge) => authorOf.set(edge.target, edge.source));
  const perContributor = new Map();
  const visibleCommits = [];
  commits.forEach((commit) => {
    const owner = authorOf.get(commit.id) || "unattributed";
    const count = perContributor.get(owner) || 0;
    if (count >= CG_LIMITS.commitsPerContributor) return;
    perContributor.set(owner, count + 1);
    visibleCommits.push(commit);
  });
  const visibleCommitIds = new Set(visibleCommits.map((node) => node.id));

  const delivery = cgDeliveryData();
  const prs = [...(delivery.pulls || [])]
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .slice(0, CG_LIMITS.prs);
  const releases = [...(delivery.releases || [])]
    .sort((a, b) => new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0))
    .slice(0, CG_LIMITS.releases);

  const contributors = [...contributorNodes]
    .sort((a, b) => (perContributor.get(b.id) || 0) - (perContributor.get(a.id) || 0))
    .slice(0, CG_LIMITS.contributors);

  // symbols: focused file first, otherwise the most-changed file's symbols
  const symbolOwner = focusId || rankedFiles.find((file) => symbolNodes.some((symbol) => symbol.path === file.path))?.id;
  const ownerPath = symbolOwner ? (byId.get(symbolOwner)?.path || "") : "";
  const visibleSymbols = symbolNodes
    .filter((symbol) => focusId ? symbol.path === ownerPath : true)
    .sort((a, b) => (a.start_line || 0) - (b.start_line || 0))
    .slice(0, CG_LIMITS.symbols);
  const visibleSymbolIds = new Set(visibleSymbols.map((node) => node.id));
  // Pull a few external callees in so call relations stay visible across files.
  const callCandidates = edges.filter((edge) => edge.type === "CALLS"
    && visibleSymbolIds.has(edge.source)
    && !visibleSymbolIds.has(edge.target));
  const externalCallees = [];
  callCandidates.forEach((edge) => {
    if (externalCallees.length >= CG_LIMITS.callees) return;
    if (externalCallees.some((node) => node.id === edge.target)) return;
    const target = byId.get(edge.target);
    if (target) externalCallees.push(target);
  });
  externalCallees.forEach((node) => { visibleSymbols.push(node); visibleSymbolIds.add(node.id); });

  // --- geometry ------------------------------------------------------------
  const width = Math.max(1180, contributors.length * 165);
  const repoHub = { x: width / 2, y: 56 };
  const contributorY = 152;
  const commitBaseY = 212;
  const fileTop = 348;
  const fileColumns = Math.min(5, Math.max(3, Math.ceil(rankedFiles.length / 4)));
  const fileRows = Math.ceil(rankedFiles.length / fileColumns);
  const fileGapX = (width - 450) / Math.max(1, fileColumns - 1 || 1);
  const fileRowGap = 78;
  const symbolRows = Math.ceil(visibleSymbols.length / Math.min(6, Math.max(2, Math.ceil(visibleSymbols.length / 3))));
  const symbolsTop = fileTop + fileRows * fileRowGap + 44;
  const height = Math.max(600, symbolsTop + (visibleSymbols.length ? symbolRows * 54 + 86 : 46));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const positions = new Map();
  positions.set(repoNode.id, { ...repoHub });

  const contributorX = (index, count) => {
    if (count === 1) return width / 2;
    const span = Math.min(width - 480, 840);
    return width / 2 - span / 2 + (span / (count - 1)) * index;
  };
  contributors.forEach((node, index) => {
    positions.set(node.id, { x: contributorX(index, contributors.length), y: contributorY });
  });

  // commits clustered under their author or spread across the width
  const commitSlots = new Map();
  const commitsPerAuthor = new Map();
  visibleCommits.forEach((c) => {
    const o = authorOf.get(c.id) || "unattributed";
    commitsPerAuthor.set(o, (commitsPerAuthor.get(o) || 0) + 1);
  });

  visibleCommits.forEach((commit, index) => {
    const owner = authorOf.get(commit.id);
    const ownerPosition = positions.get(owner);
    const slot = commitSlots.get(owner) || 0;
    commitSlots.set(owner, slot + 1);
    const totalForAuthor = commitsPerAuthor.get(owner) || 1;

    let cx, cy;
    if (ownerPosition && totalForAuthor > 1) {
      const cols = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(totalForAuthor))));
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const span = Math.min(width - 320, (cols - 1) * 156);
      const startX = ownerPosition.x - span / 2;
      cx = cols > 1 ? startX + col * (span / (cols - 1)) : ownerPosition.x;
      cy = commitBaseY + row * 38;
    } else if (ownerPosition) {
      cx = ownerPosition.x;
      cy = commitBaseY;
    } else {
      cx = 140 + ((index + 0.5) / Math.max(1, visibleCommits.length)) * (width - 280);
      cy = commitBaseY + (index % 2) * 38;
    }
    positions.set(commit.id, { x: cx, y: cy });
  });

  // pull requests + releases live in a right-hand delivery rail
  const railX = width - 92;
  const deliveryTop = 120;
  const deliveryPositions = [];
  prs.forEach((pull, index) => {
    const position = { x: railX, y: deliveryTop + index * 34 };
    deliveryPositions.push({ kind: "pr", pull, position });
    positions.set(`pr:#${pull.number}`, position);
  });
  releases.forEach((release, index) => {
    const position = { x: railX, y: deliveryTop + prs.length * 34 + 26 + index * 34 };
    deliveryPositions.push({ kind: "release", release, position });
    positions.set(`release:${release.tag_name || release.name || index}`, position);
  });

  rankedFiles.forEach((file, index) => {
    const row = Math.floor(index / fileColumns);
    const column = index % fileColumns;
    positions.set(file.id, {
      x: 90 + column * fileGapX,
      y: fileTop + row * fileRowGap,
    });
  });
  visibleSymbols.forEach((symbol, index) => {
    const columns = Math.min(6, Math.max(2, Math.ceil(visibleSymbols.length / 3)));
    const row = Math.floor(index / columns);
    const column = index % columns;
    positions.set(symbol.id, {
      x: width / 2 - ((columns - 1) / 2) * 190 + column * 190,
      y: symbolsTop + row * 58,
    });
  });

  // --- edges ---------------------------------------------------------------
  const edgeLayer = svgElement("g", { class: "cg-edge-layer" });
  world.appendChild(edgeLayer);
  const allDrawnEdges = [];
  const drawEdge = (fromId, toId, from, to, className, title, bend = 0.45) => {
    if (!from || !to) return;
    const path = svgElement("path", { d: cgCurve(from, to, bend), class: `cg-edge ${className}` });
    if (title) {
      const label = svgElement("title");
      label.textContent = title;
      path.appendChild(label);
    }
    edgeLayer.appendChild(path);
    allDrawnEdges.push({ path, fromId, toId, bend });
  };

  contributors.forEach((node) => {
    drawEdge(repoNode.id, node.id, repoHub, positions.get(node.id), "cg-edge-repo", `Repository → ${cgContributorIdentity(node)}`);
  });
  visibleCommits.forEach((commit) => {
    const owner = authorOf.get(commit.id);
    drawEdge(owner, commit.id, positions.get(owner), positions.get(commit.id), "cg-edge-author", "Authored commit");
  });
  edges.filter((edge) => edge.type === "MODIFIED" && visibleCommitIds.has(edge.source) && visibleFiles.has(edge.target)).forEach((edge) => {
    drawEdge(edge.source, edge.target, positions.get(edge.source), positions.get(edge.target), "cg-edge-modified", "Modified file");
  });
  edges.filter((edge) => edge.type === "CONTAINS" && visibleFiles.has(edge.source) && visibleSymbolIds.has(edge.target)).forEach((edge) => {
    drawEdge(edge.source, edge.target, positions.get(edge.source), positions.get(edge.target), "cg-edge-contains", "Defines");
  });
  const importEdges = edges.filter((edge) => edge.type === "IMPORTS" && visibleFiles.has(edge.source) && visibleFiles.has(edge.target));
  // Import webs are unreadable when every file is visible; draw them around the focused file.
  const drawnImports = focusId ? importEdges.filter((edge) => edge.source === focusId || edge.target === focusId) : [];
  drawnImports.forEach((edge) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return;
    const path = svgElement("path", {
      d: `M ${from.x} ${from.y + 15} C ${from.x} ${from.y + 90}, ${to.x} ${to.y + 90}, ${to.x} ${to.y + 15}`,
      class: `cg-edge cg-edge-import${focusId && (edge.source === focusId || edge.target === focusId) ? " is-focus" : ""}`,
      "marker-end": "url(#cg-arrow)",
    });
    const label = svgElement("title");
    label.textContent = `imports ${byId.get(edge.target)?.path || edge.target}${edge.module ? ` · ${edge.module}` : ""}`;
    path.appendChild(label);
    edgeLayer.appendChild(path);
  });
  const callEdges = edges.filter((edge) => edge.type === "CALLS" && visibleSymbolIds.has(edge.source) && visibleSymbolIds.has(edge.target));
  callEdges.slice(0, 160).forEach((edge) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return;
    const path = svgElement("path", {
      d: cgCurve(from, to, 0.2),
      class: "cg-edge cg-edge-call",
      "marker-end": "url(#cg-arrow)",
    });
    const label = svgElement("title");
    label.textContent = `calls ${byId.get(edge.target)?.name || "function"}`;
    path.appendChild(label);
    edgeLayer.appendChild(path);
  });
  deliveryPositions.forEach(({ kind, pull, release, position }) => {
    if (kind === "pr") {
      drawEdge(repoHub, position, "cg-edge-delivery", `Repository → pull request #${pull.number}`);
      const actor = contributors.find((node) => cgLoginKey(node.username) === cgLoginKey(pull.user?.login)
        || cgLoginKey(node.display_name) === cgLoginKey(pull.user?.login));
      if (actor) drawEdge(positions.get(actor.id), position, "cg-edge-author", `Opened by ${pull.user?.login}`);
    } else {
      drawEdge(repoHub, position, "cg-edge-release", `Repository → release ${release.tag_name || release.name || ""}`);
    }
  });

  const defs = svgElement("defs");
  const marker = svgElement("marker", { id: "cg-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", class: "cg-arrow-head" }));
  svg.prepend(defs);

  // --- nodes ---------------------------------------------------------------
  // repository hub
  const repoGroup = svgElement("g", { class: "cg-node cg-repo", tabindex: "0", role: "button", "aria-label": `Repository ${repoName}` });
  repoGroup.appendChild(svgElement("rect", { x: repoHub.x - 96, y: repoHub.y - 24, width: 192, height: 48, rx: 14, class: "cg-repo-box" }));
  const repoLabel = svgElement("text", { x: repoHub.x, y: repoHub.y + 1, class: "cg-repo-name", "text-anchor": "middle" });
  repoLabel.textContent = String(repoName).slice(0, 22);
  repoGroup.appendChild(repoLabel);
  const repoSub = svgElement("text", { x: repoHub.x, y: repoHub.y + 15, class: "cg-repo-sub", "text-anchor": "middle" });
  const repoTip = svgElement("title");
  repoTip.textContent = `Repository · ${repoName}`;
  repoGroup.appendChild(repoTip);
  repoGroup.addEventListener("click", () => { state.codeGraphFocus = ""; renderCodeGraph(state.graph); });
  if (typeof enableNodeDrag === "function") enableNodeDrag(repoGroup, repoNode.id, positions, allDrawnEdges);
  world.appendChild(repoGroup);

  contributors.forEach((node) => {
    const position = positions.get(node.id);
    const group = svgElement("g", { class: "cg-node cg-contributor", tabindex: "0", role: "button" });
    group.appendChild(svgElement("circle", { cx: position.x, cy: position.y, r: 21, class: "cg-contributor-ring" }));
    if (node.avatar_url) {
      group.appendChild(svgElement("image", { href: node.avatar_url, x: position.x - 18, y: position.y - 18, width: 36, height: 36, "clip-path": "circle(18px at 18px 18px)" }));
    } else {
      const initials = svgElement("text", { x: position.x, y: position.y + 5, class: "cg-avatar-initial", "text-anchor": "middle" });
      initials.textContent = cgContributorIdentity(node).slice(0, 1).toUpperCase();
      group.appendChild(initials);
    }
    const label = svgElement("text", { x: position.x, y: position.y + 39, class: "cg-contributor-name", "text-anchor": "middle" });
    label.textContent = cgContributorIdentity(node).split(" ")[0].slice(0, 16);
    group.appendChild(label);
    const count = svgElement("text", { x: position.x, y: position.y + 52, class: "cg-contributor-count", "text-anchor": "middle" });
    count.textContent = `${formatNumber(perContributor.get(node.id) || 0)} commits`;
    group.appendChild(count);
    const tip = svgElement("title");
    tip.textContent = `${cgContributorIdentity(node)} · ${node.username || node.email || ""}`;
    group.appendChild(tip);
    if (typeof enableNodeDrag === "function") enableNodeDrag(group, node.id, positions, allDrawnEdges);
    world.appendChild(group);
  });

  visibleCommits.forEach((commit) => {
    const position = positions.get(commit.id);
    const group = svgElement("g", { class: "cg-node cg-commit", tabindex: "0", role: "button" });
    group.appendChild(svgElement("rect", { x: position.x - 68, y: position.y - 12, width: 136, height: 24, rx: 7, class: "cg-commit-box" }));
    const sha = svgElement("text", { x: position.x - 60, y: position.y + 4, class: "cg-commit-sha", "text-anchor": "start" });
    sha.textContent = String(commit.sha || "").slice(0, 7);
    group.appendChild(sha);
    const message = svgElement("text", { x: position.x - 8, y: position.y + 4, class: "cg-commit-message", "text-anchor": "start" });
    message.textContent = String(commit.message || "commit").slice(0, 12);
    group.appendChild(message);
    const tip = svgElement("title");
    tip.textContent = `${String(commit.sha || "").slice(0, 8)} · ${commit.message || "commit"}`;
    group.appendChild(tip);
    group.addEventListener("click", () => { renderCommitDetail(commit); });
    if (typeof enableNodeDrag === "function") enableNodeDrag(group, commit.id, positions, allDrawnEdges);
    world.appendChild(group);
  });

  rankedFiles.forEach((file) => {
    const position = positions.get(file.id);
    const focused = file.id === focusId;
    const group = svgElement("g", { class: `cg-node cg-file${focused ? " is-focus" : ""}`, tabindex: "0", role: "button" });
    group.appendChild(svgElement("rect", { x: position.x - 68, y: position.y - 17, width: 136, height: 34, rx: 9, class: "cg-file-box" }));
    const name = svgElement("text", { x: position.x - 58, y: position.y - 2, class: "cg-file-name", "text-anchor": "start" });
    name.textContent = String(file.path || "").split("/").pop().slice(0, 22);
    group.appendChild(name);
    const detail = svgElement("text", { x: position.x - 58, y: position.y + 11, class: "cg-file-meta", "text-anchor": "start" });
    detail.textContent = `${modifiedCount.get(file.id) || 0} edits · ${importsByFile.get(file.id) || 0} imports`;
    group.appendChild(detail);
    const tip = svgElement("title");
    tip.textContent = `${file.path}${focused ? " · focused" : ""}`;
    group.appendChild(tip);
    group.addEventListener("click", () => {
      state.codeGraphFocus = focused ? "" : file.id;
      renderCodeGraph(state.graph);
    });
    if (typeof enableNodeDrag === "function") enableNodeDrag(group, file.id, positions, allDrawnEdges);
    world.appendChild(group);
  });

  if (visibleSymbols.length) {
    const bandLabel = svgElement("text", { x: 40, y: symbolsTop - 26, class: "cg-band-label" });
    bandLabel.textContent = `${ownerPath ? ownerPath.split("/").pop() : "MODULE"} · FUNCTIONS + CLASSES`;
    world.appendChild(bandLabel);
  }
  visibleSymbols.forEach((symbol) => {
    const position = positions.get(symbol.id);
    const isClass = graphNodeType(symbol) === "Class";
    const group = svgElement("g", { class: `cg-node ${isClass ? "cg-symbol-class" : "cg-symbol-function"}`, tabindex: "0", role: "button" });
    group.appendChild(svgElement("rect", { x: position.x - 84, y: position.y - 12, width: 168, height: 26, rx: 8, class: "cg-symbol-box" }));
    const name = svgElement("text", { x: position.x - 74, y: position.y + 4, class: "cg-symbol-name", "text-anchor": "start" });
    name.textContent = `${isClass ? "C" : "ƒ"} ${String(symbol.name || "").slice(0, 17)}`;
    group.appendChild(name);
    const line = svgElement("text", { x: position.x + 74, y: position.y + 4, class: "cg-symbol-line", "text-anchor": "end" });
    line.textContent = symbol.start_line ? `L${symbol.start_line}` : "";
    group.appendChild(line);
    const tip = svgElement("title");
    tip.textContent = `${graphNodeType(symbol)} · ${symbol.name} · ${symbol.path || ""}`;
    group.appendChild(tip);
    group.addEventListener("click", () => {
      if (typeof selectEntity === "function") selectEntity(symbol.id);
    });
    if (typeof enableNodeDrag === "function") enableNodeDrag(group, symbol.id, positions, allDrawnEdges);
    world.appendChild(group);
  });

  // delivery rail nodes (pull requests + releases)
  deliveryPositions.forEach(({ kind, pull, release, position }) => {
    const delId = kind === "pr" ? `pr:#${pull.number}` : `release:${release.tag_name || release.name || ""}`;
    if (kind === "pr") {
      const stateLabel = pull.merged_at ? "merged" : String(pull.state || "open").toLowerCase();
      const color = stateLabel === "merged" ? "#4fc4a3" : stateLabel === "closed" ? "#8b9cb3" : "#7ea2ff";
      const group = svgElement("g", { class: "cg-node cg-pr", tabindex: "0", role: "button", "aria-label": `Pull request ${pull.number}` });
      group.appendChild(svgElement("rect", { x: position.x - 78, y: position.y - 11, width: 156, height: 22, rx: 6, class: "cg-pr-box" }));
      group.appendChild(svgElement("circle", { cx: position.x - 66, cy: position.y, r: 3.6, class: "cg-pr-dot", fill: color }));
      const label = svgElement("text", { x: position.x - 57, y: position.y + 3.5, class: "cg-pr-label", "text-anchor": "start" });
      label.textContent = `#${pull.number} · ${stateLabel}`;
      group.appendChild(label);
      const tip = svgElement("title");
      tip.textContent = `#${pull.number} ${pull.title}`;
      group.appendChild(tip);
      group.addEventListener("click", () => { if (pull.html_url) window.open(pull.html_url, "_blank", "noopener"); });
      if (typeof enableNodeDrag === "function") enableNodeDrag(group, delId, positions, allDrawnEdges);
      world.appendChild(group);
    } else {
      const tag = release.tag_name || release.name || "release";
      const group = svgElement("g", { class: "cg-node cg-release", tabindex: "0", role: "button" });
      group.appendChild(svgElement("rect", { x: position.x - 78, y: position.y - 11, width: 156, height: 22, rx: 6, class: "cg-release-box" }));
      const label = svgElement("text", { x: position.x - 68, y: position.y + 3.5, class: "cg-release-label", "text-anchor": "start" });
      label.textContent = `release ${String(tag).slice(0, 14)}`;
      group.appendChild(label);
      const tip = svgElement("title");
      tip.textContent = `${release.name || tag} · published ${release.published_at || "unknown"}`;
      group.appendChild(tip);
      if (typeof enableNodeDrag === "function") enableNodeDrag(group, delId, positions, allDrawnEdges);
      world.appendChild(group);
    }
  });
  if (deliveryPositions.length) {
    cgText(world, railX, deliveryTop - 18, "DELIVERY", "cg-band-label");
  }

  // frame labels
  cgText(world, width / 2, 20, "CODE GRAPH", "cg-frame-title");
  if (!focusId) {
    cgText(world, width / 2, 34, "click a file to focus its definitions and draw its import arrows", "cg-frame-sub");
  }

  if (meta) {
    meta.textContent = `${formatNumber(contributors.length)} contributors · ${formatNumber(visibleFiles.size)} files · ${formatNumber(importEdges.length)} imports · ${formatNumber(callEdges.length)} calls${focusId ? ` · focus ${byId.get(focusId)?.path || ""}` : " · click a file to draw its imports"}`;
  }
  const wrap = document.getElementById("graph-wrap");
  if (wrap) wrap.classList.add("is-code");
  applyGraphTransform();
}

function renderCommitDetail(commit) {
  if (typeof selectEntity !== "function") return;
  selectEntity(commit.id);
}

window.renderCodeGraph = renderCodeGraph;
