/* ==========================================================================
   MNEMO SOURCE RELATIONSHIP GRAPH
   Files connect to the files they import, functions and classes define what a
   file owns, and call edges show which function reaches into which other file.
   The canvas is pannable and zoomable; clicking a file focuses its relations.
   ========================================================================== */

const SG_COLORS = {
  File: "#7ea2ff",
  Function: "#a78bfa",
  Class: "#f0a35e",
  ConfigKey: "#9fb0cc",
  Commit: "#f2768b",
  Contributor: "#4fc4a3",
};

const SG_VIEW_WIDTH = 1600;
const SG_VIEW_HEIGHT = 900;

function sgPath(node) {
  return node?.path || node?.file_path || "";
}

function sgAlpha(hex, alpha) {
  const value = String(hex || "#7ea2ff").replace("#", "");
  const red = parseInt(value.slice(0, 2), 16) || 0;
  const green = parseInt(value.slice(2, 4), 16) || 0;
  const blue = parseInt(value.slice(4, 6), 16) || 0;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function sgClip(value, max = 26) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sgTitle(text) {
  const element = svgElement("title");
  element.textContent = text;
  return element;
}

function sgCenter(position) {
  return { x: position.x + position.width / 2, y: position.y + position.height / 2 };
}

function sgCard(world, options) {
  const { x, y, width, height, type, title, subtitle, badge, onClick, ariaLabel } = options;
  const color = SG_COLORS[type] || SG_COLORS.File;
  const group = svgElement("g", {
    class: `sg-node sg-node-${String(type || "entity").toLowerCase()}${options.focus ? " is-focus" : ""}`,
    tabindex: "0",
    role: "button",
    "aria-label": ariaLabel || `${type}: ${title}`,
  });
  group.appendChild(svgElement("rect", {
    x,
    y,
    width,
    height,
    rx: 11,
    class: "sg-node-box",
    fill: sgAlpha(color, options.focus ? 0.2 : 0.1),
    stroke: sgAlpha(color, options.focus ? 0.85 : 0.45),
  }));
  group.appendChild(svgElement("rect", { x, y, width: 3, height, rx: 1.5, fill: color, opacity: options.focus ? 1 : 0.7 }));
  const titleText = svgElement("text", { x: x + 13, y: y + (height > 50 ? 20 : 17), class: `sg-card-title${options.focus ? " is-focus" : ""}` });
  titleText.textContent = title;
  group.appendChild(titleText);
  const subtitleText = svgElement("text", { x: x + 13, y: y + (height > 50 ? 36 : 31), class: "sg-card-subtitle" });
  subtitleText.textContent = subtitle;
  group.appendChild(subtitleText);
  if (badge) {
    const badgeText = svgElement("text", { x: x + width - 11, y: y + (height > 50 ? 20 : 17), class: "sg-card-badge", "text-anchor": "end", fill: color });
    badgeText.textContent = badge;
    group.appendChild(badgeText);
  }
  group.appendChild(sgTitle(`${type} · ${title}${subtitle ? ` · ${subtitle}` : ""}`));
  if (onClick) {
    group.addEventListener("click", onClick);
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    });
  }
  world.appendChild(group);
  return { x, y, width, height };
}

function sgEdge(world, from, to, options = {}) {
  if (!from || !to) return;
  const color = options.color || "#7ea2ff";
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bow = options.bow == null ? 0.16 : options.bow;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const controlX = midX + (-dy / distance) * Math.min(80, distance * bow);
  const controlY = midY + (dx / distance) * Math.min(80, distance * bow);
  const path = svgElement("path", {
    d: `M ${from.x} ${from.y} Q ${controlX} ${controlY} ${to.x} ${to.y}`,
    class: `sg-link${options.dashed ? " is-dashed" : ""}${options.focus ? " is-focus" : ""}`,
    stroke: color,
    color,
    "marker-end": "url(#sg-arrow)",
  });
  path.appendChild(sgTitle(options.title || options.label || "relation"));
  world.appendChild(path);
  if (options.label) {
    const label = svgElement("text", {
      x: midX + (options.labelOffsetX || 0),
      y: midY + (options.labelOffsetY || 0),
      class: "sg-edge-label",
      fill: sgAlpha(color, 0.95),
      "text-anchor": "middle",
    });
    label.textContent = options.label;
    world.appendChild(label);
  }
}

function sourceGraphFiles(nodes) {
  return nodes.filter((node) => graphNodeType(node) === "File" && sgPath(node));
}

function focusSourceGraphFile(path) {
  if (!path || path === state.sourcePath && state.sourceGraphFocus === path) return;
  state.sourceGraphFocus = path;
  state.sourcePath = path;
  if (typeof openEditorTab === "function") openEditorTab(path);
  renderSourceRelationGraph(path);
  if (typeof loadSource === "function") loadSource(path);
  if (typeof loadFileChanges === "function") loadFileChanges(path);
}

function sgResetView(svg, world) {
  const view = viewState("sourceGraphView");
  view.scale = 1;
  view.x = 0;
  view.y = 0;
  applyPanZoom(view, world, document.getElementById("source-graph-zoom-reset"));
  svg.setAttribute("viewBox", `0 0 ${SG_VIEW_WIDTH} ${SG_VIEW_HEIGHT}`);
}

function renderSourceOverview(world, files, edges, byId, meta, focus = null) {
  const fileIds = new Set(files.map((node) => node.id));
  const importEdges = edges.filter((edge) => edge.type === "IMPORTS" && fileIds.has(edge.source) && fileIds.has(edge.target));
  const degree = new Map();
  importEdges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  });

  // Rank by connectivity, ensuring the active focus file is always included
  let ranked = [...files]
    .sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || String(sgPath(a)).localeCompare(String(sgPath(b))))
    .slice(0, 24);

  if (focus && !ranked.some((node) => node.id === focus.id)) {
    ranked.unshift(focus);
    if (ranked.length > 24) ranked.pop();
  }

  const visible = new Set(ranked.map((node) => node.id));
  const centerX = SG_VIEW_WIDTH / 2;
  const centerY = SG_VIEW_HEIGHT / 2 - 10;
  const cardWidth = 230;
  const cardHeight = 50;
  const positions = new Map();

  // Multi-tier orbital rings to prevent overlapping
  const innerCount = Math.min(8, ranked.length);
  const midCount = Math.min(8, Math.max(0, ranked.length - innerCount));
  const outerCount = Math.max(0, ranked.length - innerCount - midCount);

  const rings = [];
  if (innerCount > 0) rings.push({ items: ranked.slice(0, innerCount), radius: 360, offset: 0 });
  if (midCount > 0) rings.push({ items: ranked.slice(innerCount, innerCount + midCount), radius: 560, offset: Math.PI / 8 });
  if (outerCount > 0) rings.push({ items: ranked.slice(innerCount + midCount), radius: 740, offset: Math.PI / 16 });

  rings.forEach((ring) => {
    ring.items.forEach((node, index) => {
      const angle = -Math.PI / 2 + ring.offset + (index / Math.max(1, ring.items.length)) * Math.PI * 2;
      positions.set(node.id, {
        x: centerX + Math.cos(angle) * ring.radius - cardWidth / 2,
        y: centerY + Math.sin(angle) * ring.radius * 0.62 - cardHeight / 2,
        width: cardWidth,
        height: cardHeight,
        node,
      });
    });
  });

  const visibleEdges = importEdges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
  const drawEdges = visibleEdges.slice(0, 120);
  const labelEvery = drawEdges.length <= 22 ? 1 : Math.ceil(drawEdges.length / 22);

  drawEdges.forEach((edge, index) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (!from || !to) return;
    const isFocusEdge = focus && (edge.source === focus.id || edge.target === focus.id);
    sgEdge(world, sgCenter(from), sgCenter(to), {
      color: isFocusEdge ? "#4fc4a3" : "#7ea2ff",
      bow: isFocusEdge ? 0.28 : 0.20,
      focus: isFocusEdge,
      label: isFocusEdge || index % labelEvery === 0 ? sgClip(edge.module || sgPath(byId.get(edge.target)), 22) : "",
      title: `${sgPath(byId.get(edge.source))} imports ${sgPath(byId.get(edge.target))}${edge.module ? ` · ${edge.module}` : ""}`,
    });
  });

  ranked.forEach((node) => {
    const position = positions.get(node.id);
    if (!position) return;
    const isCurrent = focus && node.id === focus.id;
    const outgoing = importEdges.filter((edge) => edge.source === node.id && visible.has(edge.target)).length;
    const incoming = importEdges.filter((edge) => edge.target === node.id && visible.has(edge.source)).length;
    sgCard(world, {
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      type: "File",
      title: sgClip(String(sgPath(node)).split("/").pop(), 24),
      subtitle: sgClip(sgPath(node), 34),
      badge: isCurrent ? "ACTIVE FILE" : `${outgoing}→ ${incoming}←`,
      focus: isCurrent,
      onClick: () => focusSourceGraphFile(sgPath(node)),
      ariaLabel: `File ${sgPath(node)}`,
    });
  });

  const heading = svgElement("text", { x: SG_VIEW_WIDTH / 2, y: 44, class: "sg-canvas-title", "text-anchor": "middle" });
  heading.textContent = focus ? `REPOSITORY FILE WEB · ACTIVE: ${sgClip(String(sgPath(focus)).split("/").pop(), 32).toUpperCase()}` : "REPOSITORY FILE WEB";
  world.appendChild(heading);
  const note = svgElement("text", { x: SG_VIEW_WIDTH / 2, y: 66, class: "sg-canvas-sub", "text-anchor": "middle" });
  note.textContent = focus
    ? `highlighting open file and its import links across the repository · click any file to switch`
    : "import arrows connect files · click any file to open and inspect";
  world.appendChild(note);

  if (meta) {
    meta.textContent = `${formatNumber(files.length)} files · ${formatNumber(importEdges.length)} import links · showing ${formatNumber(ranked.length)} connected files${focus ? ` · Active: ${sgClip(sgPath(focus), 36)}` : ""}`;
  }
}

function renderSourceFocus(world, focus, edges, byId, meta) {
  const focusId = focus.id;
  const focusCard = { x: 640, y: 400, width: 380, height: 78 };
  const color = SG_COLORS.File;
  sgCard(world, {
    x: focusCard.x,
    y: focusCard.y,
    width: focusCard.width,
    height: focusCard.height,
    type: "File",
    title: sgClip(String(sgPath(focus)).split("/").pop(), 30),
    subtitle: sgClip(sgPath(focus), 44),
    badge: focus.language ? displayLanguage(focus.language) : "",
    focus: true,
    onClick: () => {},
    ariaLabel: `Selected file ${sgPath(focus)}`,
  });

  const contained = edges
    .filter((edge) => edge.type === "CONTAINS" && edge.source === focusId)
    .map((edge) => byId.get(edge.target))
    .filter((node) => node && ["Function", "Class", "ConfigKey"].includes(graphNodeType(node)))
    .slice(0, 12);
  const symbolIds = new Set(contained.map((node) => node.id));
  const importOut = edges.filter((edge) => edge.type === "IMPORTS" && edge.source === focusId);
  const importIn = edges.filter((edge) => edge.type === "IMPORTS" && edge.target === focusId);
  const callOut = edges.filter((edge) => edge.type === "CALLS" && symbolIds.has(edge.source) && !symbolIds.has(edge.target));
  const callIn = edges.filter((edge) => edge.type === "CALLS" && symbolIds.has(edge.target) && !symbolIds.has(edge.source));

  const symbolPositions = new Map();
  const columns = contained.length > 6 ? 3 : Math.max(1, contained.length);
  const symbolWidth = 214;
  const symbolHeight = 46;
  const gapX = 20;
  const gapY = 16;
  const symbolBlockWidth = columns * symbolWidth + (columns - 1) * gapX;
  const symbolStartX = SG_VIEW_WIDTH / 2 - symbolBlockWidth / 2;
  const symbolStartY = 560;
  contained.forEach((symbol, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const position = {
      x: symbolStartX + column * (symbolWidth + gapX),
      y: symbolStartY + row * (symbolHeight + gapY),
      width: symbolWidth,
      height: symbolHeight,
      node: symbol,
    };
    symbolPositions.set(symbol.id, position);
  });

  // Files this file imports (right column) and files importing it (left column).
  const seenOut = new Set();
  const outgoing = [];
  importOut.forEach((edge) => {
    if (seenOut.has(edge.target)) return;
    const target = byId.get(edge.target);
    if (!target) return;
    seenOut.add(edge.target);
    outgoing.push({ node: target, module: edge.module });
  });
  const seenIn = new Set();
  const incoming = [];
  importIn.forEach((edge) => {
    if (seenIn.has(edge.source)) return;
    const source = byId.get(edge.source);
    if (!source) return;
    seenIn.add(edge.source);
    incoming.push({ node: source, module: edge.module });
  });

  const columnCardWidth = 280;
  const columnCardHeight = 56;
  const columnStep = 76;
  const incomingLimit = incoming.slice(0, 6);
  const outgoingLimit = outgoing.slice(0, 6);
  const leftX = 70;
  const rightX = SG_VIEW_WIDTH - 70 - columnCardWidth;
  const columnTop = 140;

  incomingLimit.forEach((entry, index) => {
    const x = leftX;
    const y = columnTop + index * columnStep;
    sgCard(world, {
      x, y, width: columnCardWidth, height: columnCardHeight,
      type: "File",
      title: sgClip(String(sgPath(entry.node)).split("/").pop(), 24),
      subtitle: sgClip(sgPath(entry.node), 34),
      onClick: () => focusSourceGraphFile(sgPath(entry.node)),
      ariaLabel: `File importing ${sgPath(focus)}: ${sgPath(entry.node)}`,
    });
    sgEdge(world, { x: x + columnCardWidth, y: y + columnCardHeight / 2 }, { x: focusCard.x, y: focusCard.y + focusCard.height / 2 }, {
      color: "#7ea2ff",
      label: "imports",
      title: `${sgPath(entry.node)} imports ${sgPath(focus)}`,
      labelOffsetX: -6,
      bow: 0.1,
    });
  });

  outgoingLimit.forEach((entry, index) => {
    const x = rightX;
    const y = columnTop + index * columnStep;
    sgCard(world, {
      x, y, width: columnCardWidth, height: columnCardHeight,
      type: "File",
      title: sgClip(String(sgPath(entry.node)).split("/").pop(), 24),
      subtitle: sgClip(sgPath(entry.node), 34),
      onClick: () => focusSourceGraphFile(sgPath(entry.node)),
      ariaLabel: `File imported by ${sgPath(focus)}: ${sgPath(entry.node)}`,
    });
    sgEdge(world, { x: focusCard.x + focusCard.width, y: focusCard.y + focusCard.height / 2 }, { x, y: y + columnCardHeight / 2 }, {
      color: "#7ea2ff",
      label: entry.module ? sgClip(entry.module, 18) : "imports",
      title: `${sgPath(focus)} imports ${sgPath(entry.node)}${entry.module ? ` · ${entry.module}` : ""}`,
      labelOffsetX: 6,
      bow: 0.1,
    });
  });

  // Symbols defined in the selected file.
  contained.forEach((symbol) => {
    const position = symbolPositions.get(symbol.id);
    const type = graphNodeType(symbol);
    sgCard(world, {
      x: position.x,
      y: position.y,
      width: position.width,
      height: position.height,
      type,
      title: `${type === "Class" ? "C" : type === "ConfigKey" ? "K" : "ƒ"} ${sgClip(symbol.name, 20)}`,
      subtitle: symbol.start_line ? `line ${symbol.start_line}` : "defined here",
      onClick: () => {
        if (typeof selectEntity === "function") selectEntity(symbol.id);
      },
      ariaLabel: `${type} ${symbol.name} in ${sgPath(symbol)}`,
    });
    sgEdge(world, { x: focusCard.x + focusCard.width / 2, y: focusCard.y + focusCard.height }, { x: position.x + position.width / 2, y: position.y }, {
      color: sgAlpha(sgColorFor(type), 0.8),
      label: "defines",
      title: `${sgPath(focus)} defines ${symbol.name}`,
      bow: 0.05,
    });
  });

  // Cross-file calls: functions here reaching into other files, and callers.
  const targets = [];
  callOut.forEach((edge) => {
    if (targets.length >= 6) return;
    if (targets.some((entry) => entry.id === edge.target)) return;
    const target = byId.get(edge.target);
    if (!target) return;
    const source = byId.get(edge.source);
    targets.push({ id: edge.target, node: target, source });
  });
  const callerSymbols = [];
  callIn.forEach((edge) => {
    if (callerSymbols.length >= 6) return;
    if (callerSymbols.some((entry) => entry.id === edge.source)) return;
    const source = byId.get(edge.source);
    if (!source) return;
    callerSymbols.push({ id: edge.source, node: source, target: byId.get(edge.target) });
  });

  const callCardWidth = 226;
  const callCardHeight = 46;
  const callGap = 18;
  const placeRow = (entries, y, direction) => {
    const totalWidth = entries.length * callCardWidth + Math.max(0, entries.length - 1) * callGap;
    const startX = SG_VIEW_WIDTH / 2 - totalWidth / 2;
    entries.forEach((entry, index) => {
      const x = startX + index * (callCardWidth + callGap);
      const type = graphNodeType(entry.node);
      sgCard(world, {
        x, y, width: callCardWidth, height: callCardHeight,
        type,
        title: `${type === "Class" ? "C" : "ƒ"} ${sgClip(entry.node.name, 20)}`,
        subtitle: sgClip(sgPath(entry.node), 28),
        onClick: () => focusSourceGraphFile(sgPath(entry.node)),
        ariaLabel: `${type} ${entry.node.name} in ${sgPath(entry.node)}`,
      });
      if (direction === "out") {
        const owner = symbolPositions.get(entry.source?.id);
        const from = owner ? { x: owner.x + owner.width / 2, y: owner.y } : { x: focusCard.x + focusCard.width / 2, y: focusCard.y };
        sgEdge(world, from, { x: x + callCardWidth / 2, y: y + callCardHeight }, {
          color: "#4fc4a3",
          dashed: true,
          label: `calls ${sgClip(entry.node.name, 16)}()`,
          title: `${entry.source?.name || "function"} calls ${entry.node.name}`,
        });
      } else {
        const owner = symbolPositions.get(entry.node.id);
        const target = owner ? { x: owner.x + owner.width / 2, y: owner.y + owner.height } : { x: focusCard.x + focusCard.width / 2, y: focusCard.y + focusCard.height };
        sgEdge(world, { x: x + callCardWidth / 2, y }, target, {
          color: "#ffd479",
          dashed: true,
          label: `calls ${sgClip(entry.target?.name || "", 16)}()`,
          title: `${entry.node.name} calls into ${sgPath(focus)}`,
        });
      }
    });
  };
  placeRow(targets, 66, "out");
  placeRow(callerSymbols, SG_VIEW_HEIGHT - 76, "in");

  const bandLabel = (text, y) => {
    const label = svgElement("text", { x: 24, y, class: "sg-canvas-sub" });
    label.textContent = text;
    world.appendChild(label);
  };
  if (targets.length) bandLabel("CALLED FUNCTIONS · cross-file calls into this file", 50);
  if (callerSymbols.length) bandLabel("CALLERS · functions that call into this file", SG_VIEW_HEIGHT - 92);
  if (incomingLimit.length) bandLabel("FILES THAT IMPORT THIS FILE", 118);
  if (outgoingLimit.length) {
    const label = svgElement("text", { x: SG_VIEW_WIDTH - 24, y: 118, class: "sg-canvas-sub", "text-anchor": "end" });
    label.textContent = "FILES THIS FILE IMPORTS";
    world.appendChild(label);
  }
  if (contained.length) bandLabel(`FUNCTIONS + CLASSES DEFINED IN ${sgClip(String(sgPath(focus)).split("/").pop(), 28).toUpperCase()}`, 540);

  const title = svgElement("text", { x: SG_VIEW_WIDTH / 2, y: SG_VIEW_HEIGHT - 16, class: "sg-canvas-title", "text-anchor": "middle" });
  title.textContent = sgClip(sgPath(focus), 96);
  world.appendChild(title);

  if (meta) {
    const relationCount = incomingLimit.length + outgoingLimit.length + callOut.length + callIn.length;
    meta.textContent = `${sgPath(focus)} · ${formatNumber(contained.length)} functions/classes · ${formatNumber(incoming?.length || 0)} importers · ${formatNumber(outgoing?.length || 0)} imports · ${formatNumber(relationCount)} relations`;
  }
}

function sgColorFor(type) {
  return SG_COLORS[type] || SG_COLORS.File;
}

function renderSourceRelationGraph(path) {
  const svg = document.getElementById("source-relation-graph");
  const stateEl = document.getElementById("source-graph-state");
  const meta = document.getElementById("source-graph-meta");
  if (!svg) return;
  const nodes = state.graph?.nodes || [];
  const edges = state.graph?.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const files = sourceGraphFiles(nodes);
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = svgElement("defs");
    const marker = svgElement("marker", { id: "sg-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
    const head = svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "currentColor" });
    marker.appendChild(head);
    defs.appendChild(marker);
  }
  const world = svgElement("g", { class: "sg-world" });
  state.sourceGraphWorld = world;
  svg.replaceChildren(defs, world);
  sgResetView(svg, world);

  if (!state.graph || !files.length) {
    if (stateEl) {
      stateEl.hidden = false;
      stateEl.textContent = state.graph
        ? "No tracked files were returned for this snapshot."
        : "Inspect a repository to explore file relationships.";
    }
    if (meta) meta.textContent = "No data";
    return;
  }
  if (stateEl) stateEl.hidden = true;

  const requested = path || state.sourceGraphFocus || state.sourcePath || "";
  const focus = files.find((node) => sgPath(node) === requested) || null;
  renderSourceOverview(world, files, edges, byId, meta, focus);
  applyPanZoom(viewState("sourceGraphView"), world, document.getElementById("source-graph-zoom-reset"));
}

window.renderSourceRelationGraph = renderSourceRelationGraph;
