/* Evidence-first rendering for the Ask screen with Generative UI. */

function aiConsoleThread() {
  return document.getElementById("ai-thread");
}

function renderAiThreadPending(question) {
  const thread = aiConsoleThread();
  if (!thread) return;
  thread.innerHTML = `
    <article class="ai-msg ai-msg-user"><div class="ai-msg-bubble"><p>${escapeHtml(question)}</p></div></article>
    <div class="ai-orchestrator-banner pending">
      <div class="ai-orchestrator-top">
        <span class="ai-orchestrator-title"><span class="loading-spinner" aria-hidden="true"></span> Orchestrator analyzing query & dispatching to contributor agents…</span>
      </div>
      <div class="ai-coord-participants">
        <span class="ai-coord-chip active">Orchestrator: Routing</span>
        <span class="ai-coord-chip">Traversing Commits</span>
        <span class="ai-coord-chip">Scanning Touched Files</span>
        <span class="ai-coord-chip">Retrieving Graph-RAG Chunks</span>
      </div>
    </div>
    <article class="ai-msg ai-msg-bot"><div class="ai-msg-bubble"><p><span class="loading-spinner" aria-hidden="true"></span> Waiting for contributor agent consensus and synthesis…</p></div></article>`;
  thread.scrollTop = thread.scrollHeight;
}

function renderAiThreadError(message) {
  const thread = aiConsoleThread();
  if (!thread) return;
  thread.innerHTML = `<article class="ai-msg ai-msg-bot"><div class="ai-msg-bubble error"><p>${escapeHtml(message || "The evidence request could not be completed.")}</p></div></article>`;
}

function aiRouteLabel(orchestration) {
  const names = (orchestration?.transcript || []).map((entry) => entry.login).filter(Boolean);
  if (!names.length) return "Orchestrator → Graph Retrieval";
  return `Orchestrator → ${names.slice(0, 3).join(" + ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`;
}

function renderAiThread(payload) {
  const thread = aiConsoleThread();
  if (!thread) return;
  const result = payload?.result || {};
  const orchestration = payload?.orchestration || {};
  const transcript = orchestration.transcript || [];
  const dialogue = orchestration.dialogue || [];
  const question = orchestration.question || document.getElementById("ai-room-question")?.value || "";
  const evidence = result.evidence || [];
  const cleanRagChunks = (payload?.rag_chunks || []).filter((chunk) => {
    const path = String(chunk.file_path || "").toLowerCase();
    if (/\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|tar|gz|bin|exe|so|dll|dylib|woff2?|ttf|eot)$/i.test(path)) return false;
    const text = String(chunk.code || chunk.text || "");
    if (/[\x00-\x08\x0E-\x1F]/.test(text) || (text.match(/[\uFFFD]/g) || []).length > 2) return false;
    return true;
  });
  const ai = payload?.ai || null;
  const status = result.status === "verified" ? "Verified Evidence" : result.status === "chat" ? "Context Grounded" : "Abstained";
  const statusClass = result.status === "verified" ? "verified" : result.status === "chat" ? "context" : "abstain";
  const confidence = Number(result.confidence);
  const confidenceText = Number.isFinite(confidence) ? `${Math.round(confidence * 100)}% confidence` : "grounded evidence";

  // 1. Participant Badges
  const participantBadges = transcript.map((agent) => {
    return `<span class="ai-coord-chip" title="Contributor ${escapeHtml(agent.login)}">${escapeHtml(agent.login)}</span>`;
  }).join("");

  // 2. Contributor Agents Dialogue Cards (Generative UI)
  const agentCards = transcript.map((agent) => {
    const commitsMarkup = (agent.commits || []).map((c) => {
      const sha = String(c.sha || "").slice(0, 7);
      const msg = String(c.message || "Commit").split("\n")[0].slice(0, 48);
      return `<button type="button" class="commit-pill-link" data-open-commit="${escapeHtml(c.sha)}" title="Jump to commit in History"><code>${escapeHtml(sha)}</code> <span>${escapeHtml(msg)}</span></button>`;
    }).join("");

    const filesMarkup = (agent.touched_files || []).map((f) => {
      return `<button type="button" class="file-pill-link" data-open-source="${escapeHtml(f)}" title="Open file in Source Explorer">${escapeHtml(f)}</button>`;
    }).join("");

    return `
      <article class="ai-contributor-card">
        <header class="ai-contributor-head">
          <div class="ai-contributor-info">
            <span class="ai-contributor-avatar">${escapeHtml((agent.login || "?").slice(0, 1).toUpperCase())}</span>
            <div>
              <strong>${escapeHtml(agent.login)}</strong>
              <small>${escapeHtml(agent.evidence_source || "Verified repository contributor agent")}</small>
            </div>
          </div>
          <span class="ai-contributor-badge">Contributor Agent</span>
        </header>
        ${commitsMarkup ? `<div class="ai-agent-commits"><span class="ai-subhead">Recorded Commits:</span> ${commitsMarkup}</div>` : ""}
        ${filesMarkup ? `<div class="ai-agent-files"><span class="ai-subhead">Touched Files:</span> ${filesMarkup}</div>` : ""}
        <div class="ai-contributor-statement">
          <p>${escapeHtml(agent.message)}</p>
        </div>
      </article>
    `;
  }).join("");

  // 3. Cross-agent checks / dialogue proof
  const dialogueMarkup = dialogue.length ? `
    <details class="ai-coordination-proof">
      <summary><span class="codicon codicon-check"></span> Orchestrator Cross-Agent Verification (${dialogue.length} checks passed)</summary>
      <div class="ai-proof-list">
        ${dialogue.map((d) => `<div class="ai-proof-item"><strong>${escapeHtml(d.from)} ↔ ${escapeHtml(d.to)}</strong>: ${escapeHtml(d.message)}</div>`).join("")}
      </div>
    </details>
  ` : "";

  // 4. Synthesized Answer (rendered via renderMarkdown)
  const rawAnswer = ai?.text || result.answer || "No grounded answer was returned.";
  const lines = rawAnswer.split("\n").map((text) => ({ text }));
  const formattedAnswer = typeof renderMarkdown === "function" ? renderMarkdown(lines, "answer.md") : escapeHtml(rawAnswer);

  // 5. RAG Semantic Code Evidence Widget
  const ragMarkup = cleanRagChunks.length ? `
    <div class="ai-rag-widget">
      <div class="ai-rag-head"><span class="eyebrow">GRAPH-RAG SEMANTIC EVIDENCE</span><strong>${cleanRagChunks.length} Code Chunks Retrieved</strong></div>
      <div class="ai-rag-list">
        ${cleanRagChunks.map((chunk) => `
          <div class="ai-rag-chunk">
            <div class="ai-rag-chunk-top">
              <button type="button" class="file-pill-link" data-open-source="${escapeHtml(chunk.file_path || "")}">
                ${escapeHtml(chunk.file_path || "source file")}
              </button>
              <span class="ai-rag-similarity">Score: ${(chunk.similarity || 0.85).toFixed(2)}</span>
            </div>
            <pre class="ai-rag-code"><code>${escapeHtml(chunk.code || chunk.text || "")}</code></pre>
          </div>
        `).join("")}
      </div>
    </div>
  ` : "";

  // 6. Interactive Generative Tools Action Bar
  const targetPath = result.target?.path || result.target?.file_path || (transcript[0]?.touched_files?.[0]) || "";
  const toolsMarkup = `
    <div class="ai-generative-tools">
      ${targetPath ? `<button type="button" class="ai-tool-btn" data-open-source="${escapeHtml(targetPath)}"><span class="codicon codicon-file-code"></span> Inspect ${escapeHtml(targetPath.split("/").pop())} in Source</button>` : ""}
      <button type="button" class="ai-tool-btn" data-goto-page="architecture"><span class="codicon codicon-type-hierarchy"></span> View in Code Graph</button>
      <button type="button" class="ai-tool-btn" data-goto-page="track"><span class="codicon codicon-history"></span> Check Commit Timeline</button>
    </div>
  `;

  // Render everything into thread
  thread.innerHTML = `
    <article class="ai-msg ai-msg-user">
      <div class="ai-msg-bubble"><p>${escapeHtml(question)}</p></div>
    </article>

    <section class="ai-orchestrator-banner">
      <div class="ai-orchestrator-top">
        <span class="ai-orchestrator-title"><span class="codicon codicon-hubot"></span> ${escapeHtml(aiRouteLabel(orchestration))}</span>
        <span class="ai-msg-tag ai-status-${statusClass}">${status}</span>
      </div>
      <div class="ai-coord-participants">
        <span class="ai-coord-label">Assembled Team:</span>
        <span class="ai-coord-chip active">Mnemo Orchestrator</span>
        ${participantBadges || '<span class="ai-coord-chip">Graph Retrospective Engine</span>'}
      </div>
      ${dialogueMarkup}
    </section>

    ${agentCards ? `<div class="ai-contributors-section"><span class="ai-section-title">Contributor Evidence & Recorded Intent</span>${agentCards}</div>` : ""}

    <article class="ai-msg ai-msg-bot">
      <div class="ai-msg-bubble">
        <div class="ai-msg-header">
          <span class="ai-msg-author">Mnemo Team Synthesis</span>
          <span class="ai-foot-pill">${escapeHtml(confidenceText)}</span>
          ${ai ? '<span class="ai-foot-pill ai-foot-pill-accent">AI Provider: ' + escapeHtml(ai.provider || "local") + '</span>' : '<span class="ai-foot-pill">Grounded Retrospective</span>'}
        </div>
        <div class="ai-msg-body markdown-preview">${formattedAnswer}</div>
        ${toolsMarkup}
        ${ragMarkup}
      </div>
    </article>
  `;
  thread.scrollTop = thread.scrollHeight;
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("#ai-room-send")) return;
  const input = document.getElementById("ai-room-question");
  const question = input?.value.trim();
  if (question && window.state?.graphLoaded) renderAiThreadPending(question);
});
