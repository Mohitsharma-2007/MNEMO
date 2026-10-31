/* ==========================================================================
   MNEMO WORKSPACE MODULES
   - Open-file tabs for the Source viewer
   - Per-file commit timeline (right column)
   - Side-by-side "Git Commits Diff" renderer
   - Pull request timeline with slider + visual timeline graph (Evidence page)
   ========================================================================== */

if (typeof window !== "undefined" && typeof window.state === "undefined" && typeof state === "undefined") {
  window.state = {};
}
if (typeof state !== "undefined") {
  state.openFiles = state.openFiles || [];
  if (typeof state.activeFile === "undefined") state.activeFile = "";
  if (typeof state.fileChanges === "undefined") state.fileChanges = [];
  if (typeof state.selectedCommitSha === "undefined") state.selectedCommitSha = "";
  if (typeof state.githubTimeline === "undefined") state.githubTimeline = null;
  if (typeof state.githubTimelinePromise === "undefined") state.githubTimelinePromise = null;
}

/* ------------------------------ helpers ------------------------------ */

function timeAgo(value) {
  if (!value) return "unknown";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return String(value);
  const delta = Date.now() - then;
  const past = delta >= 0;
  const abs = Math.abs(delta);
  const steps = [
    [31536000000, "y"],
    [2592000000, "mo"],
    [604800000, "w"],
    [86400000, "d"],
    [3600000, "h"],
    [60000, "m"],
  ];
  for (const [ms, unit] of steps) {
    if (abs >= ms) return `${Math.max(1, Math.round(abs / ms))} ${unit} ${past ? "ago" : "from now"}`;
  }
  return "just now";
}

function fileNameOf(path) {
  return String(path || "").split("/").pop() || String(path || "");
}

function iconForPath(path) {
  const name = fileNameOf(path);
  return fileIconName({ name, extension: name.includes(".") ? name.split(".").pop() : "" });
}

/* --------------------------- open file tabs --------------------------- */

function renderEditorTabs() {
  const bar = document.getElementById("editor-tabs");
  if (!bar) return;
  if (!state.openFiles.length) {
    bar.innerHTML = '<span class="editor-tab-placeholder">No files open</span>';
    return;
  }
  bar.innerHTML = state.openFiles.map((path) => {
    const active = path === state.activeFile;
    const name = fileNameOf(path);
    const icon = iconForPath(path);
    return `<div class="editor-tab${active ? " active" : ""}" role="tab" tabindex="0" aria-selected="${active}" data-editor-tab="${escapeHtml(path)}"><span class="editor-tab-icon file-icon-${icon}">${iconSvg(icon)}</span><span class="editor-tab-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span><button class="editor-tab-close" type="button" data-editor-close="${escapeHtml(path)}" aria-label="Close ${escapeHtml(name)}">×</button></div>`;
  }).join("");
}

function openEditorTab(path) {
  if (!path) return;
  if (!state.openFiles.includes(path)) state.openFiles.push(path);
  if (state.openFiles.length > 8) state.openFiles.shift();
  state.activeFile = path;
  renderEditorTabs();
}

function closeEditorTab(path) {
  const index = state.openFiles.indexOf(path);
  if (index >= 0) state.openFiles.splice(index, 1);
  if (state.activeFile === path) {
    const next = state.openFiles[Math.min(index, Math.max(0, state.openFiles.length - 1))];
    state.activeFile = next || "";
    if (next) {
      loadSource(next);
    } else {
      state.sourcePath = "";
      setSourceEmpty("No file open. Pick one from the file tree.");
      renderFileTimeline("", []);
      renderCommitDiff("", null);
    }
  }
  renderEditorTabs();
}

/* ------------------------ per-file commit timeline ------------------------ */

function renderFileTimeline(path, changes) {
  const host = document.getElementById("file-timeline");
  const meta = document.getElementById("file-changes-meta");
  if (!host) return;
  state.fileChanges = changes || [];
  if (meta) meta.textContent = path ? `${formatNumber(state.fileChanges.length)} commit${state.fileChanges.length === 1 ? "" : "s"}` : "No file selected";
  if (!path || !state.fileChanges.length) {
    host.innerHTML = `<div class="empty-state">${path ? "No recorded commits touched this file." : "Select a file to see its commit timeline."}</div>`;
    return;
  }
  if (!state.selectedCommitSha || !state.fileChanges.some((c) => (c.commit?.sha || "") === state.selectedCommitSha)) {
    state.selectedCommitSha = state.fileChanges[0]?.commit?.sha || "";
  }
  host.innerHTML = state.fileChanges.map((change) => {
    const commit = change.commit || {};
    const author = change.author || {};
    const sha = commit.sha || "";
    const active = sha === state.selectedCommitSha;
    const authorName = author.display_name || author.username || author.login || author.email || "Unknown";
    return `<button class="ft-item${active ? " active" : ""}" type="button" data-commit-sha="${escapeHtml(sha)}" data-commit-path="${escapeHtml(path)}"><span class="ft-rail" aria-hidden="true"><i class="ft-dot"></i></span><span class="ft-body"><span class="ft-top"><code>${escapeHtml(sha.slice(0, 7) || "no-sha")}</code><time>${escapeHtml(timeAgo(commit.timestamp || change.timestamp))}</time></span><span class="ft-msg">${escapeHtml(commit.message || "Repository change")}</span><span class="ft-meta">${escapeHtml(authorName)} · ${escapeHtml(formatDateTime(commit.timestamp || change.timestamp))}</span></span></button>`;
  }).join("");
  host.querySelectorAll("[data-commit-sha]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedCommitSha = button.dataset.commitSha;
      const change = state.fileChanges.find((c) => (c.commit?.sha || "") === state.selectedCommitSha) || state.fileChanges[0];
      renderFileTimeline(path, state.fileChanges);
      renderCommitDiff(button.dataset.commitPath || path, change);
    });
  });
}

/* --------------------------- side-by-side diff --------------------------- */

function parseDiffRows(hunk) {
  const rows = [];
  let oldLine = null;
  let newLine = null;
  String(hunk || "").split("\n").forEach((raw) => {
    const header = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      rows.push({ kind: "hunk", text: raw.replace(/\s+$/, "") });
      return;
    }
    if (raw.startsWith("\\ No newline")) return;
    if (oldLine === null) {
      oldLine = 1;
      newLine = 1;
    }
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", text: raw.slice(1), newNo: newLine++ });
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", text: raw.slice(1), oldNo: oldLine++ });
    } else {
      const text = raw.startsWith(" ") ? raw.slice(1) : raw;
      rows.push({ kind: "ctx", text, oldNo: oldLine++, newNo: newLine++ });
    }
  });
  return rows;
}

function diffSides(rows) {
  const left = [];
  const right = [];
  rows.forEach((row) => {
    if (row.kind === "ctx") {
      left.push({ kind: "ctx", no: row.oldNo, text: row.text });
      right.push({ kind: "ctx", no: row.newNo, text: row.text });
    } else if (row.kind === "del") {
      left.push({ kind: "del", no: row.oldNo, text: row.text });
      right.push({ kind: "blank", no: "", text: "" });
    } else if (row.kind === "add") {
      left.push({ kind: "blank", no: "", text: "" });
      right.push({ kind: "add", no: row.newNo, text: row.text });
    } else {
      left.push({ kind: "hunk", no: "", text: row.text });
      right.push({ kind: "hunk", no: "", text: row.text });
    }
  });
  return { left, right };
}

function diffSideHtml(side, label, tone) {
  const rows = side.map((row) => {
    if (row.kind === "hunk") {
      return `<div class="diff-row hunk"><span class="diff-no"></span><span class="diff-text">${escapeHtml(row.text)}</span></div>`;
    }
    return `<div class="diff-row ${row.kind}"><span class="diff-no">${escapeHtml(String(row.no ?? ""))}</span><span class="diff-text">${escapeHtml(row.text) || " "}</span></div>`;
  }).join("");
  return `<section class="diff-side diff-side-${tone}"><header class="diff-side-head"><span>${escapeHtml(label)}</span></header><div class="diff-side-body">${rows}</div></section>`;
}

function renderCommitDiff(path, change) {
  const host = document.getElementById("commit-diff");
  const meta = document.getElementById("commit-diff-meta");
  if (!host) return;
  if (!path || !change) {
    host.innerHTML = '<div class="empty-state">Pick a file, then choose a commit from the timeline to inspect its recorded diff.</div>';
    if (meta) meta.textContent = "Select a file and a commit";
    return;
  }
  const commit = change.commit || {};
  const author = change.author || {};
  const rows = parseDiffRows(change.diff_hunk || "");
  const additions = rows.filter((r) => r.kind === "add").length;
  const deletions = rows.filter((r) => r.kind === "del").length;
  const sha = commit.sha || "";
  const authorName = author.display_name || author.username || author.login || author.email || "Unknown";
  if (meta) meta.textContent = `${sha.slice(0, 7)} · ${formatNumber(additions)} added · ${formatNumber(deletions)} removed · ${timeAgo(commit.timestamp)}`;
  if (!rows.length) {
    host.innerHTML = `<div class="commit-diff-head"><span class="diff-file">${escapeHtml(fileNameOf(path))}</span><span class="diff-fullpath">${escapeHtml(path)}</span></div><div class="empty-state">No diff hunks were recorded for this commit.</div>`;
    return;
  }
  const sides = diffSides(rows);
  host.innerHTML = `<div class="commit-diff-head"><span class="diff-file">${escapeHtml(fileNameOf(path))}</span><span class="diff-fullpath">${escapeHtml(path)}</span><span class="diff-commit"><code>${escapeHtml(sha.slice(0, 10))}</code><span>${escapeHtml(authorName)}</span><span>${escapeHtml(formatDateTime(commit.timestamp))}</span><span class="diff-stat add">+${formatNumber(additions)}</span><span class="diff-stat del">-${formatNumber(deletions)}</span></span></div><div class="commit-diff-body">${diffSideHtml(sides.left, `${path} (previous)`, "old")}${diffSideHtml(sides.right, `${path} (recorded)`, "new")}</div>`;
}

function renderMultiFileRecordDiff(records = []) {
  const visible = records.filter((record) => record?.path && record?.diff_hunk);
  if (!visible.length) return '<div class="empty-state timeline-diff-empty">No recorded diff hunks were attached to this commit.</div>';
  const shown = visible.slice(0, 60);
  const omitted = visible.length - shown.length;
  return `<section class="multi-file-diff"><div class="multi-file-diff-head"><div><span class="eyebrow">RECORDED DIFF</span><strong>${formatNumber(visible.length)} changed file${visible.length === 1 ? "" : "s"}${omitted ? ` · showing first ${formatNumber(shown.length)}` : ""}</strong></div><div class="diff-toggle-controls"><button type="button" class="diff-toggle-btn" id="diff-expand-all" title="Expand all file diffs">Expand all</button><button type="button" class="diff-toggle-btn" id="diff-collapse-all" title="Collapse all file diffs">Collapse all</button></div></div>${shown.map((record) => {
    const rows = parseDiffRows(record.diff_hunk);
    const additions = rows.filter((row) => row.kind === "add").length;
    const deletions = rows.filter((row) => row.kind === "del").length;
    const sides = diffSides(rows);
    return `<details class="record-file-diff" open><summary><span class="record-file-name">${escapeHtml(record.path)}</span><span class="record-file-stats"><b class="diff-stat add">+${formatNumber(additions)}</b><b class="diff-stat del">-${formatNumber(deletions)}</b></span></summary><div class="commit-diff-body">${diffSideHtml(sides.left, "previous", "old")}${diffSideHtml(sides.right, "recorded", "new")}</div></details>`;
  }).join("")}${omitted ? `<div class="diff-truncation">${formatNumber(omitted)} additional file records are available in the graph but omitted here to keep the history view responsive.</div>` : ""}</section>`;
}

document.addEventListener("click", (event) => {
  if (event.target.closest("#diff-expand-all")) {
    document.querySelectorAll(".record-file-diff, .compare-file-diff").forEach((el) => { el.open = true; });
  } else if (event.target.closest("#diff-collapse-all")) {
    document.querySelectorAll(".record-file-diff, .compare-file-diff").forEach((el) => { el.open = false; });
  }
});

function renderComparisonDiffMarkup(record) {
  const fromRows = parseDiffRows(record.from?.diff_hunk || "");
  const toRows = parseDiffRows(record.to?.diff_hunk || "");
  const fromSides = diffSides(fromRows);
  const toSides = diffSides(toRows);
  const fromAdditions = fromRows.filter((row) => row.kind === "add").length;
  const fromDeletions = fromRows.filter((row) => row.kind === "del").length;
  const toAdditions = toRows.filter((row) => row.kind === "add").length;
  const toDeletions = toRows.filter((row) => row.kind === "del").length;
  return `<details class="compare-file-diff" open><summary><span>${escapeHtml(record.path)}</span><span class="record-file-stats"><b class="diff-stat add">from +${formatNumber(fromAdditions)} / -${formatNumber(fromDeletions)}</b><b class="diff-stat del">to +${formatNumber(toAdditions)} / -${formatNumber(toDeletions)}</b></span></summary><div class="commit-diff-body">${diffSideHtml(fromRows.length ? fromSides.right : [], "From commit record", "old")}${diffSideHtml(toRows.length ? toSides.right : [], "To commit record", "new")}</div></details>`;
}

window.renderMultiFileRecordDiff = renderMultiFileRecordDiff;
window.renderComparisonDiffMarkup = renderComparisonDiffMarkup;

/* --------------------------- pull request timeline --------------------------- */

function resetGithubTimeline() {
  state.githubTimeline = null;
  state.githubTimelinePromise = null;
  state.prTimelineIndex = 0;
}

async function loadGithubTimeline(force = false) {
  if (state.githubTimeline && !force) return state.githubTimeline;
  if (state.githubTimelinePromise && !force) return state.githubTimelinePromise;
  state.githubTimelinePromise = api("/api/github/timeline")
    .then((payload) => {
      state.githubTimeline = payload || { pull_requests: [], commits: [] };
      renderPullRequestTimeline(state.prTimelineIndex || 0);
      return state.githubTimeline;
    })
    .catch(() => {
      state.githubTimeline = { pull_requests: [], commits: [] };
      return state.githubTimeline;
    })
    .finally(() => { state.githubTimelinePromise = null; });
  return state.githubTimelinePromise;
}

function timelineData() {
  const github = state.inspection?.github?.pull_requests?.length ? state.inspection.github : (state.githubTimeline || state.inspection?.github || {});
  const pulls = (github.pull_requests || [])
    .map((pull) => ({
      kind: "pr",
      number: pull.number,
      title: pull.title || "Pull request",
      state: pull.merged_at ? "merged" : String(pull.state || "open").toLowerCase(),
      author: pull.user?.login || "unknown",
      date: pull.created_at || pull.updated_at || null,
      mergedAt: pull.merged_at || null,
      updatedAt: pull.updated_at || null,
      url: pull.html_url || "",
      body: pull.body || "",
      commits: pull.commits,
      additions: pull.additions,
      deletions: pull.deletions,
    }))
    .filter((pull) => pull.date);
  pulls.sort((a, b) => new Date(a.date) - new Date(b.date));
  const graphCommits = (state.graph?.nodes || [])
    .filter((node) => graphNodeType(node) === "Commit")
    .map((node) => ({
      kind: "commit",
      sha: node.sha || String(node.id || "").replace(/^commit:/, ""),
      message: node.message || "Repository change",
      date: node.timestamp || null,
      author: node.author_name || node.username || "",
    }))
    .filter((commit) => commit.date);
  const githubCommits = (github.commits || []).map((commit) => ({
    kind: "commit",
    sha: commit.sha,
    message: commit.message || "Repository change",
    date: commit.date || null,
    author: commit.author?.login || commit.author?.name || "",
  })).filter((commit) => commit.date);
  const seen = new Set();
  const commits = [...graphCommits, ...githubCommits]
    .filter((commit) => {
      const key = commit.sha || commit.date;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  return { pulls, commits };
}

function renderPullRequestTimeline(selectedIndex = null) {
  const graph = document.getElementById("pr-timeline-graph");
  const empty = document.getElementById("pr-graph-empty");
  const meta = document.getElementById("pr-timeline-meta");
  const detail = document.getElementById("pr-timeline-detail");
  const list = document.getElementById("pr-timeline-list");
  const slider = document.getElementById("pr-timeline-slider");
  if (!graph || !detail || !list) return;

  const { pulls, commits } = timelineData();
  const items = pulls.length ? pulls : commits;
  state.prTimeline = items;
  state.prTimelineIndex = Math.max(0, Math.min(selectedIndex == null ? (state.prTimelineIndex || 0) : selectedIndex, Math.max(0, items.length - 1)));

  if (meta) {
    meta.textContent = pulls.length
      ? `${formatNumber(pulls.length)} pull request${pulls.length === 1 ? "" : "s"} · ${formatNumber(commits.length)} commits`
      : `${formatNumber(commits.length)} commit${commits.length === 1 ? "" : "s"} · no pull requests in snapshot`;
  }

  if (!items.length) {
    graph.innerHTML = "";
    if (empty) empty.hidden = false;
    if (slider) {
      slider.disabled = true;
      slider.max = "0";
      slider.value = "0";
    }
    detail.innerHTML = '<div class="empty-state">No pull request or commit timeline is available for this snapshot.</div>';
    list.innerHTML = '<div class="empty-state">Inspect a GitHub repository to collect pull requests and commits.</div>';
    return;
  }
  if (empty) empty.hidden = true;
  if (slider) {
    slider.disabled = false;
    slider.max = String(items.length - 1);
    slider.value = String(state.prTimelineIndex);
  }

  const dates = [...items.map((i) => new Date(i.date).getTime()), ...commits.map((c) => new Date(c.date).getTime())].filter((n) => Number.isFinite(n));
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const span = Math.max(1, max - min);
  const width = Math.max(560, Math.round(graph.getBoundingClientRect().width || 1120));
  const height = 168;
  const xFor = (value) => {
    const time = new Date(value).getTime();
    if (!Number.isFinite(time)) return 60;
    return Math.round(48 + ((time - min) / span) * (width - 96));
  };

  // Sample the commit ticks so a long history stays light in the DOM.
  const tickStride = Math.max(1, Math.ceil(commits.length / 420));
  const commitTicks = commits.filter((_, i) => i % tickStride === 0).map((commit) => {
    const x = xFor(commit.date);
    return `<line class="pr-tick" x1="${x}" y1="100" x2="${x}" y2="114"><title>${escapeHtml(`${(commit.sha || "").slice(0, 7)} · ${commit.message}`)}</title></line>`;
  }).join("");

  // With thousands of PRs only a readable sample gets a number label.
  const labelStride = Math.max(1, Math.ceil(items.length / 12));
  const prNodes = items.map((item, index) => {
    const x = xFor(item.date);
    const selected = index === state.prTimelineIndex;
    if (item.kind !== "pr") {
      return `<g class="pr-node is-commit${selected ? " is-selected" : ""}" data-pr-index="${index}"><circle cx="${x}" cy="72" r="5" fill="#4fc4a3"/><title>${escapeHtml(item.message)}</title></g>`;
    }
    const color = item.state === "merged" ? "#4fc4a3" : item.state === "closed" ? "#8b9cb3" : "#7ea2ff";
    const labelled = selected || index % labelStride === 0;
    return `<g class="pr-node${selected ? " is-selected" : ""}" data-pr-index="${index}" tabindex="0" role="button" aria-label="Pull request ${item.number}"><line class="pr-stem" x1="${x}" y1="72" x2="${x}" y2="100"/>${selected ? `<line class="pr-playhead" x1="${x}" y1="28" x2="${x}" y2="118"/><circle class="pr-playhead-dot" cx="${x}" cy="72" r="13"/>` : ""}<circle class="pr-diamond" cx="${x}" cy="72" r="${selected ? 7 : 4.5}" fill="${color}"/>${labelled || selected ? `<text class="pr-number" x="${x}" y="54" text-anchor="middle">#${escapeHtml(String(item.number ?? ""))}</text>` : ""}<title>${escapeHtml(`#${item.number} ${item.title}`)}</title></g>`;
  }).join("");

  graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
  graph.innerHTML = `<defs><linearGradient id="pr-axis" x1="0" x2="1"><stop offset="0" stop-color="#24304a"/><stop offset="1" stop-color="#5f7fd2"/></linearGradient></defs><line class="pr-axis" x1="48" y1="100" x2="${width - 48}" y2="100" stroke="url(#pr-axis)"/>${commitTicks}${prNodes}<text class="pr-edge-label" x="48" y="146" text-anchor="start">${escapeHtml(formatDate(new Date(min).toISOString()))}</text><text class="pr-edge-label" x="${width - 48}" y="146" text-anchor="end">${escapeHtml(formatDate(new Date(max).toISOString()))}</text>`;

  graph.querySelectorAll("[data-pr-index]").forEach((node) => {
    node.addEventListener("click", () => renderPullRequestTimeline(Number(node.dataset.prIndex)));
  });

  const selected = items[state.prTimelineIndex];
  detail.innerHTML = renderTimelineDetailCard(selected, state.prTimelineIndex, items.length);

  // Render a readable window around the selection instead of thousands of rows.
  const listWindow = 160;
  const listStart = Math.max(0, Math.min(state.prTimelineIndex - Math.floor(listWindow / 2), Math.max(0, items.length - listWindow)));
  const listEnd = Math.min(items.length, listStart + listWindow);
  const listNote = items.length > listWindow
    ? `<div class="pr-list-note">Showing ${formatNumber(listStart + 1)}–${formatNumber(listEnd)} of ${formatNumber(items.length)} · move the slider to travel the full history</div>`
    : "";
  list.innerHTML = listNote + items.slice(listStart, listEnd).map((item, offset) => {
    const index = listStart + offset;
    const active = index === state.prTimelineIndex;
    const label = item.kind === "pr" ? `#${item.number} ${item.title}` : item.message;
    const badge = item.kind === "pr" ? item.state : "commit";
    return `<button class="pr-list-item${active ? " active" : ""}" type="button" data-pr-index="${index}"><span class="pr-list-index">${String(index + 1).padStart(2, "0")}</span><span class="pr-list-body"><span class="pr-list-title">${escapeHtml(label)}</span><span class="pr-list-meta">${escapeHtml(item.kind === "pr" ? "" : (item.sha || "").slice(0, 7))}${item.kind === "pr" ? "" : " · "}${escapeHtml(formatDateTime(item.date))}</span></span><span class="pr-badge pr-badge-${escapeHtml(badge)}">${escapeHtml(badge)}</span></button>`;
  }).join("");
  list.querySelectorAll("[data-pr-index]").forEach((node) => {
    node.addEventListener("click", () => renderPullRequestTimeline(Number(node.dataset.prIndex)));
  });

  const first = document.getElementById("pr-first");
  const latest = document.getElementById("pr-latest");
  if (first) first.disabled = state.prTimelineIndex <= 0;
  if (latest) latest.disabled = state.prTimelineIndex >= items.length - 1;
}

function renderTimelineDetailCard(item, index, total) {
  if (!item) return '<div class="empty-state">No timeline entry selected.</div>';
  const position = `${formatNumber(index + 1)} of ${formatNumber(total)}`;
  if (item.kind === "commit") {
    return `<article class="pr-detail"><div class="pr-detail-head"><span class="pr-badge pr-badge-commit">commit</span><strong>${escapeHtml((item.sha || "").slice(0, 10))}</strong><span class="pr-detail-pos">${position}</span></div><h3>${escapeHtml(item.message)}</h3><div class="pr-detail-meta"><span>${escapeHtml(item.author || "Unknown author")}</span><span>${escapeHtml(formatDateTime(item.date))}</span></div></article>`;
  }
  const stateLabel = item.state;
  return `<article class="pr-detail"><div class="pr-detail-head"><span class="pr-badge pr-badge-${escapeHtml(stateLabel)}">${escapeHtml(stateLabel)}</span><strong>#${escapeHtml(String(item.number ?? ""))}</strong>${item.url ? `<a class="pr-detail-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Open on GitHub ↗</a>` : ""}<span class="pr-detail-pos">${position}</span></div><h3>${escapeHtml(item.title)}</h3><div class="pr-detail-meta"><span>by ${escapeHtml(item.author)}</span><span>opened ${escapeHtml(formatDateTime(item.date))}</span>${item.mergedAt ? `<span>merged ${escapeHtml(formatDateTime(item.mergedAt))}</span>` : ""}${item.additions != null ? `<span class="diff-stat add">+${formatNumber(item.additions)}</span><span class="diff-stat del">-${formatNumber(item.deletions || 0)}</span>` : ""}</div>${item.body ? `<p class="pr-detail-body">${escapeHtml(item.body.slice(0, 420))}${item.body.length > 420 ? "…" : ""}</p>` : ""}</article>`;
}

/* ------------------------------ wiring ------------------------------ */

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-editor-tab]");
  const close = event.target.closest("[data-editor-close]");
  if (close) {
    event.stopPropagation();
    closeEditorTab(close.dataset.editorClose);
    return;
  }
  if (tab) {
    const path = tab.dataset.editorTab;
    if (path && path !== state.activeFile) {
      state.activeFile = path;
      renderEditorTabs();
      loadSource(path);
    }
  }
});

document.addEventListener("keydown", (event) => {
  const tab = event.target.closest?.("[data-editor-tab]");
  if (!tab) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    tab.click();
  }
});

(() => {
  const slider = document.getElementById("pr-timeline-slider");
  if (slider) slider.addEventListener("input", (event) => renderPullRequestTimeline(Number(event.target.value)));
  const first = document.getElementById("pr-first");
  if (first) first.addEventListener("click", () => renderPullRequestTimeline(0));
  const latest = document.getElementById("pr-latest");
  if (latest) latest.addEventListener("click", () => renderPullRequestTimeline((state.prTimeline?.length || 1) - 1));
})();
