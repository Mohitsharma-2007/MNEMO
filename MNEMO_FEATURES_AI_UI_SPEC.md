# MNEMO — Features, AI/GraphRAG, Verifiers & UI Rebuild

**Purpose:** single source of truth for Claude Code. Scope is limited to what Mnemo needs. Nothing decorative.
**Tagline:** *History is evidence. AI is opt-in.*
**One-line product:** Paste a GitHub URL → Mnemo builds a knowledge graph of the code, its history and its people → you ask *why is it like this* and get a cited, verified answer, or an honest refusal.

---

## 0. How everything fits (read this first)

```
GitHub URL
  → Ingest (git mirror + GitHub API)
  → Analyze code (Tree-sitter AST)           ┐
  → Analyze history (commits, diffs, PRs)    ├─ FACT LAYER  (deterministic, no AI)
  → Detect system layer (APIs, DB, infra)    ┘
  → Build Knowledge Graph (GraphStore)
  → [optional] Extract intent (Decisions)       ─ INTERPRETATION LAYER (AI-assisted, flagged)
  → Ask a question
       → GraphRAG retrieval (graph traversal + text search)
       → Context Pack (every item has an ID)
       → Orchestrator → Contributor Agents
       → Draft answer
       → VERIFIER (checks every claim against graph)
       → Answer with citations + confidence  |  or  ABSTAIN
```

**Three rules the whole product obeys**
1. **AI never writes facts.** Code entities, commits, authorship, calls, imports are built by parsers and git only.
2. **Graph does the work, model only phrases.** Traversal, ordering and ownership come from graph queries. The LLM turns findings into prose.
3. **No evidence, no answer.** If the graph has no supporting edge, Mnemo says so.

---

## 1. Features and explanation

Each feature: what it does → how we use it.

### 1.1 Repository ingestion
- **What:** accepts a GitHub URL or local path; mirrors the repo; pulls PRs, issues, reviews, releases via GitHub API; produces an inventory (languages, size, commit count) and a time/size estimate.
- **How we use it:** it is the only entry point. The inventory decides which analyzers run. Rate-limit handling and optional GitHub token live here.
- **Limits stated in UI:** history depth option (full / since date / last N), private repos need a token.

### 1.2 Code analysis (deterministic)
- **What:** Tree-sitter parses each supported language into files, modules, classes, functions, config keys, imports, calls, inheritance.
- **How we use it:** produces the code half of the graph. Every `CALLS` edge is tagged `exact | inferred | heuristic | unresolved`, because static analysis cannot resolve dynamic calls. Impact analysis and the call-graph UI show this honestly.
- **v1 languages:** Python, JS/TS, Java, Go (full call graph). Others: file + import level only.

### 1.3 System-layer detection
- **What:** pattern detectors find HTTP routes, HTTP client calls, ORM models/SQL, DB connection configs, env vars, dependency manifests, Dockerfile/compose/CI.
- **How we use it:** creates `Service`, `Endpoint`, `DataStore`, `Dependency`, `InfraResource` nodes and links: frontend call → endpoint → handler → database. This answers "how does the frontend connect to the backend".
- **Honesty rule:** a frontend call that matches no route stays `unresolved`; it is never guessed.

### 1.4 History analysis
- **What:** walks every commit, computes diffs, maps each diff hunk to the function/class it changed, tracks renames and moves.
- **How we use it:** gives function-level history ("who changed this function, when, in which PR"). Symbols keep one stable identity across renames, with one version record per change.

### 1.5 Identity resolution
- **What:** merges author emails, GitHub logins, `.mailmap`, `Co-authored-by` into one canonical contributor; groups bots.
- **How we use it:** must run before agents are created. Otherwise one person becomes three agents and ownership numbers are wrong. User can confirm or undo merges in Settings.

### 1.6 Delivery mapping
- **What:** links commit ↔ PR ↔ issue (`Fixes #n`, `(#123)`), commit ↔ tag/release; sets a delivery state per change: `open PR → merged → released → distributed`.
- **How we use it:** shows how a change moved to production. "Distributed" is shown only where evidence exists (release workflow, package manifest); otherwise "unknown".

### 1.7 Ownership and coupling
- **What:** computes who owns which file/function (surviving lines + recency + commits), and which files change together.
- **How we use it:** drives agent routing ("who should answer this"), the contributor heatmap, and hotspot detection (high churn × high coupling).

### 1.8 Intent extraction (Decisions) — interpretation layer
- **What:** finds the "why": ADR/design docs, PR descriptions, review threads, issue bodies, commit messages → `Decision` nodes linked to the code they govern.
- **How we use it:** deterministic first (conventional commits, `Fixes`, `Revert`, ADR headings). Optional LLM extraction adds more. Every Decision stores **pointers to the exact source text**, a `status` (`proposed → verified | rejected | superseded`) and the method used.
- **Rule:** a Decision is never shown as fact unless a source span backs it.

### 1.9 Supersession detection
- **What:** finds later decisions that overrode earlier ones.
- **Rules:** (R1) explicit text: "reverts", "supersedes", "replaces #n"; (R2) a later change overwrote the same governed value; (R3) governed code deleted → decision marked obsolete; (R4, optional, AI) semantic contradiction → stays `proposed`, never auto-verified.
- **How we use it:** answers return the latest governing decision plus "overrode earlier decision (PR #402, Mar 2021)". Superseded decisions stay viewable with date ranges.

### 1.10 Impact analysis
- **What:** reverse reachability over `CALLS`, `IMPORTS`, endpoint and data links: "what breaks if X is removed".
- **How we use it:** returns impacted nodes grouped by evidence tier, owners, related tests, and an explicit warning with the count of unresolved dynamic calls. Never presented as exhaustive.

### 1.11 Version comparison
- **What:** diff of two points in history (tag/commit/date): modules, endpoints, symbols, dependencies, active contributors, decisions.
- **How we use it:** answers "what changed in the API layer between these versions" from graph facts first; AI only summarizes.

### 1.12 Time travel (`as_of`)
- **What:** a global time control. Every graph, file and answer can be viewed at a past commit/tag/date.
- **How we use it:** entities carry `valid_from`/`valid_to`, so the "current governing decision" is always computed for the chosen date.

### 1.13 Contributor agents + orchestrator
See section 2.3.

### 1.14 Verifier + abstention
See section 3.

### 1.15 Search and filters
- **What:** ⌘K entity search (fuzzy, typed), plus one shared filter model: contributor, module/path, time range, relationship type, entity type, evidence tier, delivery state.
- **How we use it:** same filters apply in Graph, History, Contributors and Ask, and are stored in the URL.

### 1.16 Export and settings
- Export graph as JSON / GraphML / Cypher; delete repo data; configure thresholds, AI provider, token, store (memory/Neo4j). Details in section 6.

---

## 2. Main AI features and GraphRAG

### 2.1 Why GraphRAG (not plain vector RAG)
Plain vector search returns text that *mentions* a topic, not the decision that *governs* it, and cannot tell a reversed decision from a live one. Mnemo retrieves by **walking the graph from the code entity outward** (decision → PR → issue → author → date, plus supersession links), then uses text search only to find the starting entity. Structure picks the evidence; the model only writes it up.

### 2.2 GraphRAG pipeline (step by step)

| Step | What happens | AI used? |
|---|---|---|
| 1. Intent classify | Question → one of: `who`, `why`, `what-changed`, `depends-on`, `impact`, `compare`, `explain`, `find`. Rules + keywords first; small LLM fallback. | Optional |
| 2. Entity linking | Resolve mentions ("auth system", `db.save_order`) to graph nodes via exact name → full-text search → path heuristics → topic labels. Selected node in UI overrides. Ambiguous → show disambiguation chips, do not guess. | No |
| 3. Anchor | Pick anchor nodes (function, file, config key, endpoint). | No |
| 4. Graph traversal | Intent-specific expansion from anchors. `why`: `GOVERNS` ← Decision → `DISCUSSED_IN` → PR/Issue/Review, plus `SUPERSEDES` chain, `as_of` aware. `who`: ownership ranking. `impact`: reverse reachability. `compare`: snapshot diff. | No |
| 5. Text span fetch | Pull verbatim text (commit message, PR body, review comment) for the nodes found. Spans are quoted, never paraphrased in the store. | No |
| 6. Rank and budget | Score by graph distance, recency, edge weight, evidence tier, keyword overlap; cut to token budget; flag `truncated`. | No |
| 7. Context Pack | Assemble `facts`, `edges`, `spans`, `stubs` (neighbors owned by other agents), `gaps` (what is missing). **Every item has an ID.** | No |
| 8. Agent reasoning | Orchestrator routes to agents (2.3). Agents may only cite IDs in their pack. | Yes (LLM) or none in no-AI mode |
| 9. Verify | Section 3. | Claim parsing may use LLM; check is deterministic |
| 10. Answer | Text + citations + route + confidence, or abstention. | — |

**Context Pack shape (for implementation)**
```json
{
  "scope": {"entities": ["fn:db.save_order"], "as_of": "HEAD"},
  "budget_tokens": 6000, "truncated": false,
  "facts":  [{"id":"f1","type":"commit","text":"...","tier":"T0","refs":["c:ab12"]}],
  "edges":  [{"id":"e1","from":"d:77","to":"fn:db.save_order","type":"GOVERNS","tier":"T1"}],
  "spans":  [{"id":"s1","source":"pr:402","text":"verbatim quote"}],
  "stubs":  [{"id":"t1","entity":"fn:db.retry","owner_agent":"contrib:Y"}],
  "gaps":   [{"what":"no PR or issue linked to change c:ab12"}]
}
```

### 2.3 Orchestrator and contributor agents

**Contributor agent = the recorded footprint of one person**, not a chatbot with their name. Its context: commits and PRs they authored or reviewed, files and functions they touched (with surviving-line share), modules they own, endpoints/datastores their changes touched, decisions they took part in, their own quotable words (commit messages, PR comments), and *stubs* for neighbors owned by others. It cannot see anything outside its pack. It never speaks in first person.

**Orchestrator** responsibilities: classify intent → link entities → compute relevant subgraph → decide which agents to activate → dispatch tasks with packs → reconcile findings → draft → send to verifier → emit a trace of every step.

**Routing rule (thresholds configurable in Settings)**
```
owners = contributors ranked by weighted footprint on the target entities
one contributor ≥ 70%           → single-agent route
2–4 contributors cover ≥ 85%    → multi-agent route (activate them + orchestrator)
more                            → top 3 + "long-tail" agent
no owners / no history          → orchestrator only; if intent is "why" → abstain
```
Follow-up: if a finding references a stub owned by an inactive agent and it lies on the path between query entities, activate it in a second round. Defaults: max 5 agents, max 2 rounds.

**Agent messages (structured only, no free chat)**
`Finding {claim, entity_refs, evidence_ids, tier}` · `Question {to_agent, about, why}` · `Objection {finding_id, counter_evidence_ids}` · `Gap {what_missing}`.
Contradictions are kept and shown ("PR #88 set it for reason A; PR #402 overrode it for reason B"), not blended.

**Shortcuts that skip agents:** `who implemented X` → pure ownership query; `impact` → graph algorithm first, agents only add the "why" for impacted nodes; `compare` → snapshot diff first.

### 2.4 AI modes
| Mode | Behavior |
|---|---|
| **AI off** (default) | Orchestrator uses intent templates + graph tools. Answers are cited fact lists (timeline, ownership table, call chain, supersession chain). Still verified, never fabricated. |
| **AI on** | LLM drafts prose from findings, optionally extracts decisions. Output goes through the verifier. |

**LLM layer:** OpenRouter free tier as default; provider registry keeps Groq, NVIDIA NIM etc. and a local model option (Ollama). Keys from `.env`. UI shows exactly what text will leave the machine before first use per repo.

### 2.5 Selection-scoped AI
Any selected node, edge, file, line range, contributor or commit becomes the query scope. Fixed actions: *Explain this · Who changed this · Why does A depend on B · What breaks if removed · Show relevant contributors · Trace dependency.* The selection is passed as the anchor in step 3, so no entity linking guess is needed.

---

## 3. Verifiers and trust

### 3.1 Evidence tiers (shown as badges everywhere)
| Tier | Meaning | Example |
|---|---|---|
| T0 exact | Observed in git/AST | commit authored by X; resolved call |
| T1 explicit | Human wrote it, machine parsed | "Fixes #12" |
| T2 structural | Deterministic inference | fetch path matches route |
| T3 heuristic | Pattern-based, may be wrong | name-based call match; fuzzy identity merge |
| T4 inferred | Model-generated | LLM rationale; semantic supersession |

**Headline claim must be T0–T2, or be labeled "inferred".**

### 3.2 Verifier pipeline
1. **Claim extraction:** split draft into atomic claims. Templated claim types (`who`, `when`, `which PR`, `which file`, `calls`, `quoted text`) are parsed by deterministic code; free text uses an LLM constrained to output structured claims with IDs.
2. **Deterministic check** per claim: edge exists in GraphStore (`verify_edge`), quote is contained in cited span, dates match, cited ID exists in the pack.
3. **Outcome per claim:** `verified(tier)`, `unsupported`, or `contradicted`.
4. **Compose:** keep verified claims; drop unsupported ones (log them); label T3/T4.
5. **Abstain** if the *core* claim (the direct answer) is unsupported or contradicted.
6. **Report:** claim coverage (verified / total), weakest evidence tier used, number of dropped statements.

**Abstention example:** "The graph has `flag_gamma` defined in `src/net.c` and 4 commits touching it, but no PR, issue or commit message records why its value is set. Mnemo will not guess."

**Stated limits:** the verifier checks claims it can extract; it cannot prove that fluent prose has no unsupported implication. Documented, not hidden.

### 3.3 Other verifiers (data-side)
| Verifier | What it checks |
|---|---|
| Identity merge review | fuzzy merges (T3) are listed for confirm/undo before agents are built |
| Decision span check | a Decision without a source span stays `proposed`; shown dashed |
| Supersession check | R1–R3 auto-verify; R4 needs a human click |
| Call-resolution report | % of calls exact / heuristic / unresolved per module |
| Analysis data-quality panel | unresolved calls, pending merges, skipped files, partial stages |
| Golden-question tests | per demo repo: expected answer, expected abstention, expected routing (see 7) |

---

## 4. Additional functionalities (only what supports the above)

| Function | Why it exists |
|---|---|
| Incremental re-analysis | "N new commits upstream — update" without rebuilding |
| Job pipeline with live progress | analysis takes minutes; user must see stages, pause, resume, retry-from-stage |
| Partial workspace | open the app as soon as the fact layer is ready |
| Bot grouping | stops bots dominating ownership |
| Hotspot detection | churn × coupling highlights risky files |
| Request-path trace | frontend → endpoint → handler → DB highlighted on the graph |
| Query history + pinned answers | re-open past answers with their evidence |
| Trace export (JSON/Markdown) | audit how an answer was produced |
| Privacy controls | per-repo AI opt-in, redaction rules, option to disable per-person agents/metrics |
| GraphStore switch | in-memory (local, zero setup) or Neo4j (persistent, large repos) behind one interface |

---

## 5. Data model (compact reference)

**Nodes**
- System: `Repository, Service, Endpoint, ExternalCall, DataStore, DataEntity, InfraResource, Dependency, ConfigKey, Release, Branch`
- Code: `Directory, Module, File, Class, Function, SymbolVersion`
- History: `Contributor, Commit, Change, PullRequest, Review, ReviewComment, Issue, Incident`
- Interpretation: `Decision, Topic`
- Rollup: `Cluster`

**Key edges**
- Structure: `CONTAINS, PART_OF`
- Code: `IMPORTS, CALLS{resolution}, INHERITS_FROM, USES_DEPENDENCY, READS_CONFIG`
- System: `EXPOSES, HANDLED_BY, CONSUMES, CONNECTS_TO, READS, WRITES, DEPLOYED_AS, COMMUNICATES_WITH(derived)`
- History: `AUTHORED, CO_AUTHORED, OPENED, REVIEWED, INCLUDES, HAS_CHANGE, CHANGES, REVERTS, RELEASED_IN, CLOSES`
- Intent: `GOVERNS, DISCUSSED_IN, RESULTED_IN, TRIGGERED, SUPERSEDES, REFINES`
- Derived: `OWNS, TOUCHED, COUPLED_WITH, ALIASED_AS`

**Every node/edge carries:** `layer (fact|interpretation)`, `tier (T0–T4)`, `source_refs`, `valid_from/valid_to`. Decisions also carry `method`, `model`, `status`.

**Identity:** stable IDs for files and symbols across renames (rename detected by git + AST similarity ≥ 0.8); a symbol version per change; contributor IDs from the resolver.

**Change from the old design:** `SUPERSEDES` only between Decisions (and symbol versions). Reverts use `REVERTS`. Commit-to-commit `SUPERSEDES` is dropped.

---

## 6. UI REBUILD

### 6.1 Principles
- **Light theme only.** No dark mode, no gradients, no purple/blue AI look.
- **Graph-first, evidence-first.** Every entity is clickable and opens the same Detail Panel. Every answer shows its citations.
- **Dense but calm:** 13px base, 28–32px rows, 8px grid, 1px borders, 6px radius, shadows only on floating panels.
- **Uncertainty is visible:** tier badges, dashed edges for T3/T4, "unknown" instead of guessing.

### 6.2 Tokens
| Token | Value |
|---|---|
| bg | `#FAFAF8` |
| surface | `#FFFFFF` |
| border | `#E4E4DF` |
| text / muted | `#1B1D21` / `#6B6F76` |
| accent (primary actions, selection) | `#0F6B6B` |
| warn / danger | `#B7791F` / `#B42318` |
| entity colors (always paired with shape) | contributor `#7A5C99`, commit `#4F6D7A`, PR `#2E7D6B`, file `#8C8C85`, function `#0F6B6B`, module `#A0522D`, service `#2F5D8A`, endpoint `#B7791F`, datastore `#5B6B2F`, decision `#8A3B5B` |
| fonts | Inter (UI), JetBrains Mono (code, SHAs); tabular numerals |

### 6.3 Shell (present on every screen)
- **Top bar:** repo switcher · **as-of selector** · ⌘K search · analysis status · AI status chip (`AI off` / provider+model).
- **Left rail:** Dashboard · Graph · Architecture · Contributors · History · Code · Ask · Simulation · Compare · (bottom) Connections · Settings.
- **Right Detail Panel (universal):** header, facts, relationships by edge type, history, owners, decisions (with supersession note), evidence + tier, actions: *Open source · Show in graph · Trace · Ask AI · Pin*. Missing data is stated: "No linked decision recorded".
- **Ask strip (docked, every screen):** inherits current selection and filters; shows the six selection actions as chips.
- **Shared state in URL:** selection, as-of, filters, scope.

### 6.4 Screens (only these)

| # | Screen | Purpose | Key content | Graph / AI behavior |
|---|---|---|---|---|
| 1 | **Landing** | get a URL pasted | headline, URL field, example repos (pre-analyzed demos), 3 proof panels (graph, cited answer, abstention), privacy line | none |
| 2 | **Import** | configure analysis | URL/local path, token, history depth, branches, include PR/issues, AI toggle (off default) with data-egress notice, size/time estimate | none |
| 3 | **Analysis progress** | transparent, resumable | stage list: Fetch → Inventory → Parse → System layer → History → Identities → Delivery → Graph → Intent (if on) → Rollups → Index; live preview (language mix, top modules, contributor board); "Open workspace (partial)" | none |
| 4 | **Dashboard** | orient in one screen | KPI strip; architecture mini-map; top contributors; recent activity; hotspots; decision health (superseded, unrecorded); delivery state; data-quality panel | suggested questions built from stats |
| 5 | **Graph** | main knowledge graph | canvas, breadcrumb, search, graph controls, minimap, detail panel (see 6.5) | selection-aware Ask |
| 6 | **Architecture** | system structure | tabs: Services & Modules (with coupling matrix, cycles) · API map · Data map · Dependencies · Infra; "Trace request path" | tier badges, dashed T3 links |
| 7 | **Contributors** | who does what | table (commits, PRs, symbols, surviving lines, primary modules, active range) + contributor × module heatmap; merge-identities action; bots grouped | "Open footprint" |
| 8 | **Contributor detail** | one footprint | tabs: Footprint mini-graph · Ownership · Timeline · Changes · Decisions · Collaborators · Agent scope; note: "reflects recorded history, not total knowledge" | "Ask this footprint" |
| 9 | **History** | change over time | tabs: Timeline (releases, decisions with supersession arcs, architecture events) · Commits (ribbon chart + lanes + list, brush to zoom) · Pull requests (list + detail with delivery pipeline strip, discussion, commits, changes, linked decisions) | brush/scrub sets as-of |
| 10 | **Code** | read code with history | tabs: Files (tree · viewer with symbol outline, blame ribbon, per-function history chip · file timeline · diff/relations drawer) · Call graph (callers left, callees right, depth 1–5, edge style by resolution, "Impact if removed") | "Ask about this selection" |
| 11 | **Ask** | full-page Q&A | conversation, scope selector (repo/selection/module/contributor/time), answer card, evidence panel (mini-graph + list), saved queries | see 6.6 |
| 12 | **Simulation** | watch agents work | roster (orchestrator + agents), views: Orchestrator · Routing · Agent reasoning · Cross-contributor; thresholds panel; run history/replay | see 6.7 |
| 13 | **Compare** | two versions | selectors; tabs: Architecture · API · Symbols · Dependencies · Contributors · Decisions; overlay on graph (added green, removed red dashed, changed amber) | "Summarize changes" (verified) |
| 14 | **Connections / Settings** | operate | graph store, providers, token; analysis, identity, agent thresholds, AI egress policy, data export/delete | — |

### 6.5 Graph screen spec
- **Levels:** Project → Service → Module → File → Class/Function. Default view L1 clusters, ≤150 visible nodes.
- **Server-side view:** client requests `view(level, focus, filters, as_of, budget)`; server returns nodes, clusters and aggregated edges. Never ships the whole graph.
- **Renderer:** canvas/WebGL (e.g. Cytoscape.js or Sigma.js) behind an adapter. SVG only for small detail graphs.
- **Expand/collapse:** double-click cluster expands in place (≤250ms animation); children >40 → top-K + "+N more"; auto-collapse least relevant clusters when over budget; Isolate with back stack.
- **Semantic zoom:** far = clusters + counts; mid = edges; near = names + badges.
- **Hover:** highlight 1-hop, dim rest. **Multi-select:** "Find paths". **Trace:** callers/callees to depth N with cycle markers; contributor trace halos their footprint.
- **Presets:** Architecture (default) · Evidence (contributor → commit → change → file/symbol → decision) · Code · Module coupling · Ownership · Call chain · Delivery · Time.
- **Controls panel:** level slider, layers (Fact / Interpretation / System), edge toggles with counts, layout, cluster-by, size-by, color-by, hide tests, reset.
- **Filters (server-side):** contributor, path/module, commit, time range, relationship type, entity type, tier, delivery state. Optional ghost connectors keep paths visible.
- **Jump links:** node → source at that commit; code line → "Show in graph".

**Node shapes:** service/project rounded rect · module folder-tab · file rectangle · function circle · endpoint hexagon · datastore cylinder · contributor ringed circle · commit diamond · PR pill · decision rounded square (dashed if proposed, muted if superseded) · cluster stacked rect.
**Edge styles:** CALLS solid teal (dashed heuristic, dotted unresolved) · IMPORTS thin gray · system edges ochre/blue/green · AUTHORED/TOUCHED contributor-colored, width = count · SUPERSEDES bold curved arc labeled "overrode" · rollups thicker, width ∝ log(weight) with count.

### 6.6 Answer card (Ask screen and Ask strip)
- Answer text with **inline citation chips** (hover shows source span, click highlights in graph and opens Detail Panel).
- **Route chip:** `Orchestrator → Agent X + Agent Y` (opens Simulation routing view).
- **Confidence block:** claim coverage, weakest tier, dropped-statements count.
- **Supersession note** when relevant.
- **Abstention card (distinct style):** what the graph does contain, what is missing, where a human could look.
- **AI off banner:** "Showing retrieval answer from graph evidence."
- **Ambiguous entity:** disambiguation chips before answering.

### 6.7 Simulation screen spec (kept separate from the repo graph)
It reads the same GraphStore but draws its own scene (agents, packs, messages).
- **Orchestrator view:** parsed intent and entities → small relevant subgraph colored by owner → activation scoreboard (agent, footprint coverage %, picked/skipped, reason) → decision log. User can force include/exclude an agent and rerun.
- **Routing view:** Query → intent/entities → entities in graph → owners → activation, as bands whose width = footprint share; chosen agents solid, skipped faded with reason.
- **Agent reasoning view:** footprint summary + context pack (left), reasoning trace of graph-tool calls (center), findings with citations and tier (right); unsupported items struck through with verifier reason. Agents labeled "Footprint of <name>", no chat avatars.
- **Cross-contributor view:** Agent A findings | reconciliation (agreements, conflicts, gaps) | Agent B findings, with a time strip showing which finding applies when; "only conflicts" toggle; export trace.

### 6.8 States (all screens)
| Situation | Treatment |
|---|---|
| Loading | skeleton rows/cards, never a bare spinner |
| Empty | one line of explanation + primary action |
| Stage failed | stage card in error, partial workspace stays usable, retry-from-stage |
| GitHub rate limit | banner with reset time; suggest token; continue git-only |
| Private / 404 | explain + token setup |
| Unsupported language | "file-level only" badge + supported list |
| Graph too large | auto-cluster, counts, "expand anyway" |
| No history for entity | "No recorded changes in analyzed history (shallow clone?)" |
| LLM unreachable | fall back to retrieval answer, keep trace |
| Verifier abstains | abstention card |
| Neo4j disconnected | top-bar chip, continue in-memory |
| New upstream commits | soft banner with incremental update |

### 6.9 Accessibility and performance
Keyboard navigation in graph (arrows between neighbors, Enter opens panel, E/C expand/collapse); "Outline mode" list equivalent of any graph; shape + color redundancy. Targets: 60fps up to 2,000 visible nodes; view query p95 <150ms in-memory, <400ms Neo4j for ≤150-node views.

### 6.10 What changes from the current UI
| Current | Rebuild |
|---|---|
| 7 tabs on one page | 14 screens under one shell with shared selection, filters, as-of |
| SVG graph, 3 modes | server-side level-of-detail + canvas renderer, 8 presets |
| Separate AI chat tab | Ask strip on every screen + full Ask page, selection-aware |
| Agents tab as overview | Simulation workspace with 4 views, separate from repo graph |
| Lavender/mint with gradients, dark.css | single teal accent, no gradients, light only |
| Answer = text + agent citations | answer + clickable citations + confidence + abstention |
| Source tab | Code screen adds symbol outline, blame ribbon, function history, call graph |

---

## 7. Build order (minimal)

1. **Foundation:** `GraphStore` interface (memory + Neo4j), stable IDs, tiers/provenance on every item, job runner with progress events.
2. **Fact layer:** Tree-sitter analyzers, hunk→symbol, renames, identity resolver, GitHub PR/issue/review ingestion, ownership.
3. **System layer:** manifests, env/config, Docker/CI, endpoint and client detectors, DB detectors.
4. **UI shell + Graph + Detail Panel + filters + as-of + search**, then Dashboard, Contributors, History, Code, Architecture.
5. **Intelligence:** Context Builder, orchestrator routing, retrieval (AI-off) answers, verifier + abstention card.
6. **AI on:** LLM drafting, claim extraction, Decision extraction, supersession R1–R3, selection-scoped AI, impact analysis.
7. **Simulation screens**, Compare, incremental update, export.

**Acceptance tests (golden questions)**
1. Config value changed by a later PR → answer cites the later decision and says the earlier was superseded, both dated.
2. Symbol with no rationale anywhere → abstains and states what the graph does contain.
3. File ≥70% owned by one person → single-agent route; cross-module question → ≥2 agents and the trace says why.
4. Function renamed twice → one symbol, three versions, aliases listed.
5. Three emails of one person → one contributor, one agent.
6. `fetch('/api/x')` → linked to its handler and DB at T2; unmatched calls stay unresolved.
7. "What breaks if f is removed" → grouped by tier + unresolved-call warning.
8. Injected false claim → dropped and logged; injected false core claim → abstain.
9. 100k-symbol repo → ≤150 visible nodes, 60fps pan, module expands <500ms.
10. AI off → every primary question still returns a cited retrieval answer.

---

## 8. Known limits (shown in the product, not hidden)
- Static analysis misses reflection, dynamic dispatch, DI containers; impact results show unresolved counts.
- Squash/rebase merges lose commit granularity; PR data fills the gap when available.
- "Reached production" is only inferred from tags, releases, workflows, package manifests; otherwise "unknown".
- Per-person ownership is derived from history only; it is not a performance metric. Org setting can disable per-person agents/metrics.
- v1 is GitHub only (merge requests/GitLab later).
