# MNEMO — Gap Analysis, Target Architecture & Product Spec

**Audience:** Claude Code / development team. **Status:** pre-implementation blueprint.
**Inputs analyzed:** `system_architecture_blueprint.md` (call it **BLUEPRINT**) and `MNEMO_PROJECT_DOCUMENTATION.md` (call it **CURRENT**). Nothing below assumes implementation details beyond what those two files state. Where CURRENT is silent, the item is marked **UNDOCUMENTED** (it may exist in code but is not evidenced).

Contents: A Gap Analysis · B Target Architecture · C Knowledge Graph Model · D Multi-Agent Architecture · E Information Architecture · F UI/UX Template · G Graph Visualization Spec · H End-to-End Workflow · I Roadmap · Appendix (open questions, conflicts, acceptance tests)

---

# A. Architecture Gap Analysis

## A.1 One-paragraph read of each file

- **BLUEPRINT** is a hackathon-grade *intent* system ("Why The Code Is Like This"). Its center of gravity is **decisions, supersession, entity resolution, a verifier gate, and calibrated abstention**, on Neo4j AuraDB with Tree-sitter/SCIP, GitPython/PyGithub, LangGraph, Guardrails/RAGAS and Cytoscape.
- **CURRENT** is a working **evidence workspace**. Its center of gravity is **ingest → in-memory graph → web UI (7 tabs) → contributor agents + orchestrator → optional LLM paraphrase**, with a zero-dependency Python server, vanilla JS, SVG graphs, and optional Neo4j sync.

They describe the same product at two different layers: BLUEPRINT is the *reasoning* ambition; CURRENT is the *workspace* reality. The gap is mostly that CURRENT built the workspace and the contributor/orchestrator shell, but not the parts that make BLUEPRINT's claims true (supersession, verification, entity resolution, issues/incidents, confidence).

## A.2 Implemented (evidenced in CURRENT)

| Capability | Evidence in CURRENT |
|---|---|
| Local + remote repo ingestion | §2.1: checked-out dirs or cloned remote repos |
| Commit scanning (SHA, time, message, author) | §2.1 |
| Per-commit file changes, additions/deletions | §2.1 |
| Symbol extraction (functions, classes, configs) and imports/calls | §2.1 (`IMPORTS`, `CALLS`) |
| In-memory graph with node types Repository, Contributor, Commit, PullRequest, Release, File, Function, Class, Decision | §2.2 |
| Edges AUTHORED, MODIFIED, CONTAINS, IMPORTS, CALLS, SUPERSEDES (Decision→Decision) | §2.2 |
| Optional Neo4j AuraDB sync + status check | §2.2, §3.7 |
| One agent per active committer; orchestrator that routes, inspects diffs, cites | §2.3 |
| Multi-provider LLM registry with deterministic fallback | §2.4 |
| Pull request / release data model | §2.2, §3.2 (states: merged/open/closed) |
| UI: Overview, Evidence chain (timeline scrubber), Architecture (3 graph modes), Source explorer (tree, tabs, diff, relations), Agents, AI chat, Git track, Connections | §3 |
| Light theme, lavender/mint palette | §3 |
| Deterministic-first philosophy ("AI is opt-in") | title, §2.4 |

## A.3 Planned in BLUEPRINT but not evidenced in CURRENT (missing)

Ranked by how much they block the intended product.

| # | Missing item | BLUEPRINT ref | Why it matters |
|---|---|---|---|
| 1 | **Independent Verifier gate** (extract claims → Cypher/graph check → accept/reject) | §6.1 | Without it, "grounded" is a claim, not a property. CURRENT only says answers are "backed by line-level citations". |
| 2 | **Confidence signal + abstention protocol** | §6.2 | CURRENT's fallback is "deterministic timeline", not "refuse when graph has no edge". These are different behaviors. |
| 3 | **Supersession detection across commits/decisions with `EXPIRED` status** | §5.2 | CURRENT has a `SUPERSEDES` edge type but no documented algorithm that *creates* it. |
| 4 | **Decision extraction** (PR/issue/commit → `Decision` with context, status) | §4.1, `RESULTED_IN`, `GOVERNS` | CURRENT lists `Decision` as "recorded intents, architectural notes, or commit rationales" but not how they are produced or linked to code. |
| 5 | **Issues, ReviewComments, Incidents** as nodes; `Issue-RESOLVED_BY->PR`, `Incident-TRIGGERED->PR/Commit` | §4.1–4.2 | These carry the actual "why". CURRENT has no Issue/ReviewComment/Incident node. |
| 6 | **Entity resolution**: rename tracking (`git log --follow` + structural verification), `EntityAlias`, `ALIASED_AS{valid_until}` | §5.1 | Without it, history of a function breaks at every rename. |
| 7 | **Contributor alias disambiguation** (email/login/GPG → one node) | §5.1 | CURRENT says authors are identified "by username and email signatures" but no merge logic. Duplicate people = wrong ownership stats and duplicate agents. |
| 8 | **Hunk → AST symbol resolution** (`MODIFIED{start_line,end_line,diff_hunk}` onto Function/ConfigKey) | §4.2, §Phase 2 | CURRENT's MODIFIED is `Commit→File`. Function-level history (a core ask of your brief) needs `Commit→Function`. |
| 9 | **Deterministic AST tooling named** (Tree-sitter/SCIP) | §8 | CURRENT says "syntactic parsing" with no stated parser or language coverage. Multi-language support is undefined. |
| 10 | **`ConfigKey` and `Module` nodes**, `INHERITS_FROM`, `DEFINES` | §4.1–4.2 | CURRENT lists "configurations" as symbols but not as first-class nodes with current value and history. |
| 11 | **Temporal slider across graph state** ("time-travel") | §3, §Phase 5 | CURRENT has a *commit* scrubber on the Evidence tab, but the graph itself is not stated to be time-sliceable. |
| 12 | **Structured persona debate / consensus synthesizer** | §5.3 | CURRENT's orchestrator "synthesizes"; there is no debate loop or agent-to-agent protocol. |
| 13 | **PR review ingestion** (`REVIEWED`, `POSTED`) | §4.2 | Needs GitHub API; CURRENT only says PRs are "merged PR records". |
| 14 | **Graph DB as system of record** | §3, §8 | In CURRENT, Neo4j is optional sync; the in-memory graph is primary. See conflict C1. |
| 15 | **Evaluation harness** (RAGAS-style grounding, demo questions that docs cannot answer) | §6, §Phase 4 | No evaluation story in CURRENT. |

## A.4 Required by your brief but absent from *both* files

These are new requirements; neither file covers them. This is the larger half of the real gap.

| # | Gap | Notes |
|---|---|---|
| N1 | **Arbitrary GitHub URL as first-class entry point with a managed pipeline** (queue, progress, resumability, size limits, rate-limit handling, private repos) | CURRENT accepts a URL but describes a synchronous in-process load. |
| N2 | **System-level understanding**: APIs exposed/consumed, frontend→backend links, backend→DB links, services, infra/config (Docker, k8s, Terraform, CI) | Neither file mentions API endpoint extraction, HTTP client call detection, ORM/SQL detection, or IaC parsing. This is the single biggest missing analysis layer. |
| N3 | **Multi-level abstraction graph** (Project → Directory → File → Function → …) with a defined *rollup* model | CURRENT has three flat graph modes, not a zoomable hierarchy. |
| N4 | **Graph scalability strategy** (clustering, server-side aggregation, LOD, viewport queries) | CURRENT renders "native SVG" with pan/zoom. SVG will not scale past a few thousand nodes. |
| N5 | **Impact analysis** ("what breaks if this function is removed") | Needs reverse-reachability over CALLS/IMPORTS/API edges plus a confidence model (static analysis is incomplete). |
| N6 | **Release / "reached production" inference** | CURRENT has `Release` nodes; neither file defines how commit→release→distribution is inferred (tags, release branches, package registries, deploy workflows). |
| N7 | **Version comparison** ("what changed in the API layer between two versions") | Needs snapshot-diff over the graph, not just commit lists. |
| N8 | **Selection-scoped AI** (ask about a selected node/edge) | CURRENT's chat is a separate tab. Brief requires AI integrated in the graph. |
| N9 | **Dynamic multi-agent activation** driven by graph traversal (activate X + Y + orchestrator) | CURRENT: orchestrator "discovers matching contributor agents". Activation policy, budgets, and cross-agent protocol are undefined. |
| N10 | **Contributor ownership model** (primary-associated modules, bus factor, line-survival) | CURRENT shows counts; no ownership metric defined. |
| N11 | **Agent simulation as a separate environment** from the main graph | CURRENT places Agents and AI Chat as tabs sharing the same workspace. Brief wants conceptual separation with a shared graph backend. |
| N12 | **Incremental re-analysis** (new commits since last run) | Not covered. |
| N13 | **Security/privacy model** for private repos, tokens, LLM data egress | Not covered. CURRENT's AI provider list implies repo content leaves the machine when AI is enabled; that must be explicit and controllable. |

## A.5 Inconsistencies and conflicts (with recommended resolution)

**C1 — System of record: in-memory graph (CURRENT) vs Neo4j AuraDB (BLUEPRINT).**
BLUEPRINT assumes Neo4j holds the truth and Cypher does traversal and verification. CURRENT keeps an in-memory graph and treats Neo4j as optional.
*Recommendation:* introduce a **GraphStore interface** with two implementations (in-memory for local/offline/small repos; Neo4j for persistent/large repos). All query, verifier and agent-context code goes through the interface, and the verifier is specified against the *interface*, not raw Cypher. Keep CURRENT's "works with no database" property; keep BLUEPRINT's Cypher as the reference semantics. Reject "Neo4j required" (breaks the zero-dependency identity) and reject "Neo4j optional sync only" (blocks verification at scale).

**C2 — Agent philosophy: *persona debate* (BLUEPRINT §5.3) vs *evidence-footprint agents* (CURRENT §2.3 and your brief).**
BLUEPRINT's "simulated debate between personas" risks fabricated viewpoints about real people. Your brief explicitly says the agent is *not a chatbot with the contributor's name* but the contributor's *development footprint*.
*Recommendation:* retain **footprint agents**. Replace "debate" with **evidence exchange**: each agent returns structured findings (claims + edge citations), and the orchestrator reconciles. Never generate first-person speech attributed to a real contributor. If a "conversational" view is wanted, render it as quoted evidence (their actual commit messages, PR comments), not generated persona text.

**C3 — AI posture: "AI is opt-in" (CURRENT) vs LLM-driven reasoning, verification, and decision extraction (BLUEPRINT).**
Decision extraction and routing at the semantic level need a model.
*Recommendation:* make the rule precise: **AI never writes to the graph's factual layer.** Two graph layers:
- **Fact layer** (deterministic, always on): code entities, commits, authorship, calls, imports, diffs.
- **Interpretation layer** (optional, AI-assisted, flagged): `Decision`, `Rationale`, inferred links, supersession *candidates*. Every interpretation node carries `provenance: {method, model, prompt_hash, source_refs}` and `status: proposed | verified | rejected`.
Without AI, the interpretation layer is populated only by deterministic heuristics (PR→issue links via `Fixes #n`, ADR files, conventional-commit types).

**C4 — Verification vs fallback.**
CURRENT's fallback ("deterministic timeline and relationship evidence") answers *something* when there is no AI; BLUEPRINT's protocol answers *nothing* when the graph has no supporting edge. These are compatible only if defined: the **no-AI answer is a retrieval answer (a set of cited facts)**, and the **AI answer must pass the verifier**. A third outcome, **abstain**, is required when retrieval is empty.

**C5 — Naming and scope drift.**
BLUEPRINT's project title is "Codebase Intent Knowledge Graph"; CURRENT's tagline is "Repository Evidence Workspace". The product is both. *Recommendation:* one name with two surfaces: **Mnemo** = workspace (CURRENT) + **Intent Engine** (BLUEPRINT). Update docs accordingly.

**C6 — Edge semantics.**
BLUEPRINT: `SUPERSEDES` exists on `Commit→Commit` and `Decision→Decision`. CURRENT: only `Decision→Decision`. Commit-level supersession is ill-defined (a commit supersedes what, exactly?). *Recommendation:* keep supersession **only at Decision level** and at **symbol-version level** (`SymbolVersion→SymbolVersion`, see C.3). Drop `Commit→Commit SUPERSEDES`; use `REVERTS` for explicit reverts.

**C7 — "Zero hallucination" (BLUEPRINT §2) is an overclaim.**
A verifier checks *edges for claims it can extract*; it cannot prove that a fluent sentence has no unsupported implication. *Recommendation:* reword to "every factual assertion is checked against graph evidence, and unverifiable assertions are removed or flagged." Document the verifier's limits.

**C8 — Confidence formula.**
BLUEPRINT: `verified edges / total claims`, threshold 1.0. A single unparseable clause forces refusal and the metric ignores claim importance and edge strength (e.g., a `MODIFIED` edge vs an inferred link).
*Recommendation:* report **(a)** claim coverage ratio, **(b)** weakest-link evidence tier (see C.6), **(c)** abstain only if the *core* claim (answer to the question) fails verification; peripheral unverifiable sentences are dropped.

**C9 — Frontend stack.**
CURRENT: vanilla JS + native SVG. BLUEPRINT: Cytoscape.js / WebGL force graph. The brief demands zoom across thousands of nodes with clustering. *Recommendation:* adopt a **canvas/WebGL renderer** for the graph (Cytoscape.js with WebGL extension, Sigma.js, or similar) behind a small render adapter; keep SVG for small detail graphs (file relations, routing diagrams). Vanilla JS is acceptable but a component framework is advisable once the screen count reaches what is specified in E. This is a decision for the team; flag in Appendix.

**C10 — Light theme vs `dark.css`.**
CURRENT lists `dark.css`. The brief says light theme only. *Recommendation:* remove or park dark mode; do not ship it in v1. Also, CURRENT's palette is lavender/mint; the brief rejects "cheap-looking blue/purple AI gradients". Lavender as a restrained accent is defensible, but gradients on user bubbles (§3.6) conflict with the brief. See F.0 for the proposed palette.

**C11 — Server architecture.**
CURRENT's `ThreadingHTTPServer` with in-process analysis cannot support background ingestion jobs, streaming progress, or concurrent users. *Recommendation:* keep the stdlib server for the local single-user mode if desired, but specify a **job runner abstraction** (thread pool/process pool locally, queue worker for hosted) and an SSE/WebSocket progress channel.

## A.6 Documentation that must be reorganized

1. Split CURRENT into: *Product overview*, *Data model reference*, *API reference*, *Agent behavior reference*, *Operations*. Right now, §2 mixes modules, graph model and agent behavior.
2. Add a **Fact vs Interpretation** section (C3), which does not exist in either file.
3. Add a **limits and guarantees** page (what Mnemo cannot determine: dynamic dispatch, reflection, runtime-only config, squash-merged history).
4. Document the **API surface** completely; CURRENT lists six endpoints but only by name.
5. Add **language support matrix** (which languages have call-graph vs import-only vs file-only support).
6. Replace the single flat node/edge list with the schema in C below, including provenance and temporal fields.
7. Document the Evidence-tab "decisions" behavior: currently the doc shows a timeline of commits/PRs and says it links to "recorded decisions", but never says where decisions come from.

## A.7 Concrete architectural changes (summary)

1. Introduce `GraphStore` interface (memory + Neo4j).
2. Split graph into **Fact layer** and **Interpretation layer** with provenance.
3. Add the **Symbol versioning** model (C.3) so function history survives renames and edits.
4. Add the **System layer** (APIs, services, datastores, infra) with deterministic detectors.
5. Add **Issues/PRs/Reviews/Incidents** ingestion via GitHub API.
6. Build **Supersession engine** at decision and symbol-version level.
7. Build **Verifier** + **confidence/abstention** as a pipeline stage between agent output and user.
8. Build **Context Builder** (graph → bounded context packs) as an explicit component; agents never touch raw graph.
9. Introduce **hierarchical rollup** + **LOD graph service** for visualization.
10. Introduce **job pipeline** with progress events, caching, incremental update.
11. Selection-scoped AI everywhere.
12. Evaluation harness with golden questions per demo repo.

---

# B. Target Architecture

## B.1 Layered view (maps to your 10 required separations)

```
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ 10  PRESENTATION   Web app: graph, explorers, timeline, agent sim, chat    │
 ├───────────────────────────────────────────────────────────────────────────┤
 │ 9   MULTI-AGENT REASONING   findings exchange, reconciliation              │
 │ 8   CONTRIBUTOR AGENTS      footprint-bound, read-only                     │
 │ 7   ORCHESTRATOR            routing, activation, budget, synthesis         │
 │ 6   CONTEXT GENERATION      Context Builder → bounded Context Packs        │
 │ 5   GRAPH QUERY / RETRIEVAL GraphStore API, Cypher/native traversals      │
 │ 4   KNOWLEDGE GRAPH         Fact layer + Interpretation layer + Snapshots  │
 │ 3   HISTORICAL ANALYSIS     history walker, rename tracker, hunk→symbol    │
 │ 2   CODE ANALYSIS           AST, symbols, calls, system detectors          │
 │ 1   INGESTION               URL/local → mirror → inventory → job queue     │
 ├───────────────────────────────────────────────────────────────────────────┤
 │ CROSS-CUTTING: Verifier & Confidence · Provenance · Auth/Secrets · Jobs ·  │
 │                Cache · Telemetry · Evaluation harness                       │
 └───────────────────────────────────────────────────────────────────────────┘
```

## B.2 Component responsibilities

| Component | Responsibility | Deterministic? |
|---|---|---|
| **Ingestion Service** | Parse GitHub URL; shallow/full mirror clone; fetch GitHub metadata (PRs, issues, reviews, releases, tags) via API/GraphQL; produce a **Repo Inventory** (languages, size, manifest files). Enforce limits and rate-limit backoff. | Yes |
| **Code Analyzer** | Per-language AST parse (Tree-sitter; SCIP where an indexer exists). Emit files, modules, classes, functions, config keys, imports, calls, inheritance. | Yes |
| **System Detectors** | Plugin set that finds: HTTP route definitions, HTTP client calls, GraphQL/gRPC schemas, ORM models, SQL strings, DB connection configs, message queues, env vars, Dockerfile/compose/k8s/Terraform/CI. Emit `Endpoint`, `Service`, `DataStore`, `ExternalSystem`, `InfraResource`, and links between them. | Yes (pattern-based; every link carries a confidence tier) |
| **History Walker** | Walk commits (topologically), compute diffs, detect renames/moves, map hunks to symbol versions, attribute authorship per symbol version. | Yes |
| **Identity Resolver** | Merge author identities (email, noreply patterns, GitHub login, name similarity, `.mailmap`, `Co-authored-by`) into canonical `Contributor`. Keep merge audit trail; allow manual override. | Yes (+ user-confirmable merges) |
| **Delivery Mapper** | Link commits↔PRs (merge commits, squash patterns, `(#123)`), PRs↔issues (`Fixes #n`), commits↔tags/releases, releases↔distribution evidence (release workflows, package manifests). Output a **delivery state** per change: `local-branch / open-PR / merged / released(tag) / distributed(evidence)`. | Yes |
| **Intent Extractor** *(interpretation layer)* | Derive `Decision` candidates from ADR/design docs, PR descriptions, review threads, issue bodies, commit messages. Heuristic first (conventional commits, "Fixes", "Revert", ADR headings); optional LLM extraction. All outputs `status: proposed` until verified against source text spans. | Mixed |
| **Supersession Engine** | Detect `SUPERSEDES`, `REVERTS`, `REFINES` at decision and symbol-version level (see C.5). | Yes (rules) + optional LLM-assist flagged |
| **Graph Builder** | Idempotent upserts into GraphStore. Stable IDs (see C.1). Builds snapshots and rollups. | Yes |
| **GraphStore** | Interface: `get_node`, `neighbors`, `subgraph`, `path`, `rollup`, `snapshot_at`, `history_of`, `verify_edge`, `stats`. Impl A: in-memory. Impl B: Neo4j. | Yes |
| **Context Builder** | Given (scope, question, budget) assemble a **Context Pack**: ranked facts, edges, text spans, each with an ID. See D.3. | Yes |
| **Orchestrator** | Query understanding → entity linking → route/activate agents → collect findings → reconcile → synthesize → verify. See D. | Mixed |
| **Contributor Agents** | Footprint-bounded reasoners. See D. | Mixed (LLM optional) |
| **Verifier** | Parse candidate answer into claims, check each against GraphStore, assign evidence tier, drop/flag, compute confidence, trigger abstention. | Yes (claim extraction may be LLM-assisted; the *check* is deterministic) |
| **Graph Service (LOD)** | Server-side view builder returning *viewport-sized* subgraphs with cluster nodes, per zoom level and filter set. | Yes |
| **Job Runner** | Pipelines with stages, progress events, retries, caching by commit SHA, resume. | Yes |

## B.3 Deployment modes

1. **Local mode** (CURRENT-compatible): single process, in-memory GraphStore, stdlib server, optional AI keys from `.env`.
2. **Hosted mode**: API server + worker pool + Neo4j (Aura) + object storage for mirrors + auth. LLM calls via server-side provider registry.
Both modes share the same domain code; only GraphStore, JobRunner and auth differ.

## B.4 Data flow and trust boundaries

- Repo content and metadata → **Fact layer** (trusted, deterministic).
- LLM output → **Interpretation layer only** (untrusted until verified), or **answer text** (must pass Verifier).
- LLM providers receive only the **Context Pack** the user has opted to send. UI must show "what will leave this machine" before first AI use per repo.

## B.5 Key design decisions (stated explicitly)

| Decision | Choice | Rationale |
|---|---|---|
| Source of truth | Git mirror + GraphStore (rebuildable from the mirror) | Graph is derived; never hand-edited except identity merges/overrides, which are stored as an overlay. |
| Identity of code entities | Stable ID + per-commit `SymbolVersion` (C.3) | Names change; identity must not. |
| Call graph honesty | Every `CALLS` has `resolution: exact | inferred | heuristic | unresolved` | Static analysis cannot resolve dynamic dispatch; UI and impact analysis must show this. |
| Agent count | Bounded (top-N contributors + "long tail" pooled agent) | A 3,000-contributor repo cannot have 3,000 agents. See D.1. |
| Graph visual scale | Server-side LOD + canvas/WebGL | Brief forbids an unreadable giant graph. |

---

# C. Data / Knowledge Graph Model

## C.1 Identity rules

- `Repository.id = host/owner/name` (lowercased).
- `File.id = repo_id + ":" + file_uid`. `file_uid` is stable across renames (assigned at first appearance, carried by rename detection). `path` is a *versioned property* (see `FileVersion`).
- `Symbol.id = file_uid + ":" + symbol_uid`. Likewise stable across rename/move when structural similarity ≥ threshold (default 0.8 on normalized AST hash + signature); below threshold = new symbol and a `DERIVED_FROM{confidence}` edge if similarity ≥ 0.5.
- `Commit.id = sha`. `Contributor.id` = canonical ID from Identity Resolver.
- Every node carries: `created_in_snapshot`, `layer` (`fact|interpretation`), `source_refs[]`.

## C.2 Node types

**Project/system level**
- `Repository`, `Release{tag, date, notes_ref}`, `Branch{name, head_sha}`
- `Service{name, kind: backend|frontend|worker|lib|cli, root_path, detection_ref}`
- `Endpoint{method, path_pattern, handler_ref, framework}`
- `ExternalCall{target_pattern, client_lib, method?, path?}`
- `DataStore{kind: postgres|mysql|mongo|redis|…, connection_ref}`
- `DataEntity{name, kind: table|collection|model, schema_ref}`
- `InfraResource{kind: dockerfile|compose-service|k8s-object|tf-resource|ci-job, path}`
- `Dependency{ecosystem, name, version_spec, resolved_version?}` (from manifests/lockfiles)
- `ConfigKey{name, kind: env|file-key|flag}`

**Code level**
- `Directory`, `Module{name, path, boundary: package|namespace|dir}`, `File`, `FileVersion{path, commit}`
- `Class`, `Function` (includes methods), `Variable` (module-level/consts only)
- `SymbolVersion{symbol_id, commit, signature, ast_hash, start_line, end_line}`

**History/delivery level**
- `Contributor{canonical_name, identities[], first_seen, last_seen}`
- `Commit{sha, message, author_time, commit_time, parents[], stats}`
- `Change{commit, file, symbol?, kind: add|modify|delete|rename, hunk_ref, lines_added, lines_deleted}` *(makes "PR introduced Change" explicit)*
- `PullRequest{number, title, body, state, created, merged, base, head}`; `MergeRequest` is the same type with `platform: gitlab` (see Appendix on GitLab).
- `Review{state, submitted}`, `ReviewComment{body, path, line, time}`, `Issue{number, title, body, state, labels}`, `Incident{id, title, severity, source_ref}` (only from explicit sources: issue labels like `incident`, post-mortem docs; never inferred by AI alone)

**Interpretation layer**
- `Decision{summary, rationale_span_refs[], status: proposed|verified|rejected|superseded, valid_from, valid_to}`
- `Rationale`-as-property of `Decision` (stored as span refs to original text; the summary is a paraphrase, the *spans are the evidence*)
- `Topic/Capability{name}` (e.g., "authentication") — clustering labels derived from paths/symbols/docs; always `layer: interpretation`.

**Snapshot/rollup**
- `Snapshot{commit|tag, date}` — logical; nodes/edges carry `valid_from_commit`/`valid_to_commit` instead of duplicating graph copies.
- `Cluster{level, members[], label}` — materialized rollups for LOD.

## C.3 Symbol versioning (core of function-level history)

```
(Symbol)-[:HAS_VERSION]->(SymbolVersion)
(SymbolVersion)-[:INTRODUCED_BY|MODIFIED_BY|DELETED_BY]->(Commit)   // via Change
(SymbolVersion)-[:NEXT]->(SymbolVersion)
(SymbolVersion)-[:DERIVED_FROM {confidence}]->(SymbolVersion)       // split/merge/rename uncertainty
```
Authorship of a symbol = set of contributors of its `Change` records, weighted by surviving lines (blame-based `line_survival`).

## C.4 Edge types

| Category | Edge | Properties |
|---|---|---|
| Structure | `CONTAINS` (Dir→Dir/File, File→Class/Function/ConfigKey, Class→Function), `PART_OF` (File→Module→Service→Repository) | — |
| Code deps | `IMPORTS` (File/Module→File/Module), `CALLS` (Function→Function), `INHERITS_FROM`, `IMPLEMENTS`, `USES_DEPENDENCY` (Module→Dependency), `READS_CONFIG` (Function/File→ConfigKey) | `resolution`, `evidence_ref`, `weight` (call count/site count) |
| System | `EXPOSES` (Service→Endpoint), `HANDLED_BY` (Endpoint→Function), `CONSUMES` (Function/Module→Endpoint via ExternalCall), `CONNECTS_TO` (Service→DataStore), `READS`/`WRITES` (Function→DataEntity), `DEPLOYED_AS` (Service→InfraResource), `COMMUNICATES_WITH` (Service→Service; **derived** rollup of CONSUMES/EXPOSES) | `confidence_tier`, `detector`, `evidence_ref` |
| Authorship | `AUTHORED` (Contributor→Commit), `CO_AUTHORED`, `OPENED`/`MERGED`/`REVIEWED`/`COMMENTED` (Contributor→PR/Review/Comment), `AUTHORED_ISSUE` | `time` |
| Change | `INCLUDES` (PR→Commit), `HAS_CHANGE` (Commit→Change), `CHANGES` (Change→File/SymbolVersion), `REVERTS` (Commit→Commit), `RELEASED_IN` (Commit→Release) | `delivery_state` on PR/Commit |
| Intent | `CLOSES` (PR→Issue), `DISCUSSED_IN` (Decision→PR/Issue/ReviewComment/Commit), `RESULTED_IN` (PR→Decision), `GOVERNS` (Decision→Symbol/ConfigKey/File/Endpoint), `TRIGGERED` (Incident→PR/Commit), `SUPERSEDES`/`REFINES` (Decision→Decision) | `method`, `confidence_tier`, `evidence_span_refs`, `valid_from`, `valid_to` |
| Derived | `OWNS` (Contributor→Module/File/Symbol: computed), `COUPLED_WITH` (File↔File, co-change frequency), `ALIASED_AS` (Entity→alias, `valid_until`) | `score`, `window` |

User-requested relationships mapped:
- `Contributor → changed → File` = `AUTHORED → Commit → HAS_CHANGE → Change → CHANGES → File` (materialized as derived `TOUCHED{count, last}`).
- `Commit → modified → Function` = `Commit-HAS_CHANGE→Change-CHANGES→SymbolVersion`.
- `PR → introduced → Change` = `PR-INCLUDES→Commit-HAS_CHANGE→Change`.
- `Frontend → communicates with → Backend` = derived `COMMUNICATES_WITH` over `CONSUMES`/`EXPOSES`.
- `Backend → connects to → Database` = `CONNECTS_TO`.

## C.5 Supersession model (concrete algorithm)

1. **Target selection**: for a `ConfigKey`, `Function`, `Endpoint` or `File`, collect all `Decision`s linked by `GOVERNS` ordered by `valid_from`.
2. **Candidate detection (deterministic rules):**
   - R1 *Explicit*: PR/commit text contains "reverts", "supersedes", "replaces #n", "undo", or a `Revert "…"` commit → `REVERTS`/`SUPERSEDES` with tier `explicit`.
   - R2 *Same-target overwrite*: a later Decision `GOVERNS` the same target, and the Change at the target alters the governed property (e.g., the constant value changed) → candidate `SUPERSEDES`, tier `structural`.
   - R3 *Target deletion*: governed symbol deleted → Decision `valid_to` = deletion commit, status `obsolete` (not "superseded": nothing replaced it).
   - R4 *Semantic overlap* (optional, AI-assisted): later Decision text contradicts earlier one on the same topic → candidate, tier `inferred`, **never auto-verified**.
3. **Resolution**: a Decision with an incoming verified `SUPERSEDES` is `status: superseded`. Queries return the *latest non-superseded* decision plus an explicit "overrode earlier decision (PR #n, date)" note. The superseded decision remains retrievable with its date range.
4. **Time-scoped query**: every query accepts `as_of` (commit/tag/date); the "current governing decision" is computed at that point in history.

## C.6 Evidence tiers (used by verifier, UI badges, and impact analysis)

| Tier | Meaning | Example |
|---|---|---|
| T0 `exact` | Directly observed in VCS/AST | Commit authored by X; function F contains call to G (resolved) |
| T1 `explicit` | Stated in text by a human, machine-parsed | "Fixes #12" links PR→Issue |
| T2 `structural` | Deterministic inference from structure | Endpoint path match between fetch call and route |
| T3 `heuristic` | Pattern-based, may be wrong | Name-based call resolution; identity merge by name similarity |
| T4 `inferred` | Model-generated | LLM-extracted rationale, semantic supersession |

Rule: **an answer's headline claim must be backed by ≤T2 evidence, or be labeled "inferred".**

## C.7 Hierarchical rollup model (supports zoom)

Levels: `L0 Project` → `L1 Service/Package` → `L2 Module/Directory` → `L3 File` → `L4 Class/Function`.
Edges roll up by aggregation: an edge between two L4 nodes contributes `weight` to the edge between their L2 ancestors. Rollups are **materialized** per snapshot for L0–L3 and **computed on demand** for L4 subsets.

## C.8 Constraints and indexes (Neo4j reference)

Unique: `Commit.sha`, `Contributor.id`, `Symbol.id`, `File.id`, `PullRequest(repo,number)`, `Issue(repo,number)`. Indexes on `SymbolVersion.commit`, `Change.commit`, `Decision.status`, full-text on `Commit.message`, `PullRequest.title/body`, `Issue.title/body`, `Symbol.name`.

---

# D. Multi-Agent Architecture

## D.1 Agent roster

- **Orchestrator** (exactly one per repo session).
- **Contributor Agents**: one per *significant* contributor, where significance is defined by a configurable threshold (default: top 15 by weighted contribution or ≥ 2% of surviving lines/commits). Others pooled into **"Long-tail" agent** (aggregated footprint) so no query hits an empty void. Identity merges (A.3 #7) must happen *before* agent creation.
- **Optional specialist agents** (v2): `Verifier` (not an LLM agent; a service), `Impact Analyst` (graph algorithms + LLM narration), `Release Historian`.

## D.2 Orchestrator responsibilities

1. **Query understanding**: classify intent (`who`, `why`, `what-changed`, `depends-on`, `impact`, `compare-versions`, `explain`, `find`).
2. **Entity linking**: resolve mentions ("the auth system", "payment module") to graph entities using exact names, FTS, path heuristics and `Topic` nodes. If ambiguous → return candidates and ask (UI shows disambiguation chips) rather than guess.
3. **Scope computation**: given entities + selection context + `as_of`, compute the **relevant subgraph** (bounded k-hop + intent-specific traversal).
4. **Agent activation** (D.4).
5. **Task dispatch**: send each activated agent a **Task** (question + its Context Pack + budget).
6. **Reconciliation**: merge findings; detect conflicts/gaps; optionally one clarification round (max 1 by default).
7. **Synthesis**: draft answer using only findings.
8. **Verification & abstention** via Verifier (D.7).
9. **Trace emission**: every step logged as an event for the Orchestrator and Reasoning views.

Global knowledge for the orchestrator = **graph access through GraphStore queries plus summaries**, not the entire graph pasted into a prompt. State this plainly: "global knowledge" means *global queryable access*, not global context window. This resolves an ambiguity in the brief.

## D.3 Context boundaries (what each agent "knows")

**Contributor Agent footprint (read-only), computed by the Context Builder:**
- Commits authored/co-authored; PRs opened/reviewed/commented.
- Files and symbols touched, with `line_survival` and recency.
- Modules/services where `OWNS` score exceeds threshold.
- Dependencies/endpoints/datastores their changes touched.
- Decisions they participated in (authored text or review comments).
- Their own words: commit messages, PR bodies, review comments (as quotable spans).
- **Neighbor stubs**: for each touched symbol, one-hop callers/callees *as stubs* (name, owner contributor, id) so the agent can say "this depends on X, which is owned by Y" without having Y's data. Stubs are what enable cross-agent routing.

**Context Pack format** (all items have IDs so citations are checkable):
```
pack: { scope, as_of, budget_tokens,
  facts:   [{id, type, text, evidence_tier, refs[]}],
  edges:   [{id, from, to, type, tier}],
  spans:   [{id, source_id, text}],      // verbatim text from commits/PRs/issues
  stubs:   [{id, entity, owner_agent}],
  gaps:    [{what, why}]                 // e.g. "no PR linked to this change"
}
```
Packs are ranked by relevance (graph distance, recency, edge weight, query-term overlap) and truncated to budget with an explicit `truncated: true` flag.

An agent may **only cite IDs present in its pack** (or in packs it received from peers via the orchestrator). Citations to anything else fail verification.

## D.4 Query routing and activation policy

```
Query → intent + entities → relevant subgraph
  → owners(entity) = contributors ranked by OWNS/TOUCHED weight
  → decision:
      if one contributor holds ≥ 70% of weighted footprint on all target entities
            → SINGLE-AGENT route (orchestrator stays as verifier/synthesizer)
      elif 2–4 contributors cover ≥ 85% of footprint
            → MULTI-AGENT route (activate those + orchestrator)
      elif more
            → activate top-3 + Long-tail agent; orchestrator summarizes remainder
      if no owners found (no history for target)
            → ORCHESTRATOR-ONLY (structural answer) or ABSTAIN if intent is "why"
```
Thresholds are configuration, **not constants to be hard-coded**; expose them in Settings. Cross-contributor expansion via stubs: if an agent's findings reference a stub owned by another agent not yet activated and the reference is *material* (on a path between query entities), the orchestrator may activate that agent in a follow-up round. Max rounds default 2; max agents default 5; max tokens per agent configurable.

Special routes:
- `impact` queries: **no agent needed first**; run reverse reachability (D.6), then ask owners of impacted nodes for *context* (why those dependencies exist).
- `compare-versions`: graph snapshot diff first, agents for interpretation.
- `who implemented X`: pure graph (ownership ranking by `TOUCHED`/`line_survival` for the entity set) — LLM only narrates.

## D.5 Cross-agent communication protocol

Agents never talk freely. They exchange **structured messages** via the orchestrator:

```
Finding   { claim, entity_refs[], evidence_ids[], tier, confidence, scope_limits }
Question  { to_agent, about_entity, why_needed }       // routed via orchestrator; budgeted
Objection { finding_id, counter_evidence_ids[], reason }
Gap       { what_missing, where_searched }
```
Flow: (1) parallel `Finding` generation, (2) orchestrator detects overlaps/contradictions, (3) optional `Question`/`Objection` round, (4) final `Findings` set. Contradictions are *preserved and presented*, not smoothed ("X's PR #88 set the limit for reason A; Y's PR #402 overrode it for reason B").

**Replaces BLUEPRINT's persona debate** (conflict C2). Reasoning view (F.17, F.19) can display this as a *threaded evidence exchange*, using real quoted spans.

## D.6 Graph-assisted reasoning primitives (deterministic tools agents may call)

`ownership(entity)`, `history_of(entity, range)`, `callers(fn, depth)`, `callees(fn, depth)`, `reverse_reach(entity, edge_types, depth)` (impact), `path(a,b, edge_types)`, `co_change(entity)`, `decisions_governing(entity, as_of)`, `supersession_chain(decision)`, `diff_snapshots(a,b, scope)`, `delivery_state(change|commit|pr)`.
Impact analysis output must include: impacted set by resolution tier, **unresolved-call warning** ("N dynamic call sites could not be resolved"), tests touching impacted nodes (if test files identified), and owners.

## D.7 Verification, confidence and synthesis

1. Orchestrator drafts the answer from `Findings` and attaches citations (IDs).
2. **Claim extraction**: split into atomic claims (deterministic templates for the common patterns *who/when/which-PR/which-file/calls*; LLM-assisted extractor for free text, constrained to output structured claims referencing IDs).
3. **Deterministic check** of each claim via GraphStore (`verify_edge`, text-span containment for quotes, date comparison).
4. Outcome per claim: `verified (tier)`, `unsupported`, `contradicted`.
5. Compose: keep verified; drop unsupported (log them); if a **core claim** is unsupported/contradicted → **abstain** with the specific gap ("Graph has the definition of `flag_gamma` in `src/net.c` but no PR, commit message or issue records its intent.").
6. Report to user: answer, confidence summary (coverage, weakest tier), citations as clickable graph entities, "dropped statements" count.

Abstention is a first-class UI state (F.14, F.24).

## D.8 No-AI mode

With no LLM configured: Orchestrator uses intent templates + graph tools; answers are **cited fact lists** (timeline, ownership table, call chain, supersession chain). This is CURRENT's deterministic fallback, now formally defined as "retrieval answer".

---

# E. Product Information Architecture

## E.1 Sitemap

```
/                               Landing
/analyze                        Repository import
/r/:repo/loading                Analysis progress (job)
/r/:repo                        Workspace (shell, persistent)
  ├─ /dashboard                 Project dashboard
  ├─ /graph                     Main knowledge graph (LOD)
  ├─ /architecture              Code architecture explorer (modules, services, API map)
  ├─ /contributors              Contributor explorer
  │    └─ /:id                  Contributor detail
  ├─ /history
  │    ├─ /timeline             Repository timeline
  │    ├─ /commits              Commit history visualization
  │    └─ /changes              Pull request / change explorer
  │         └─ /pr/:n
  ├─ /code
  │    ├─ /files                File explorer (tree + viewer + file timeline + diff)
  │    └─ /calls                Function dependency / call graph
  ├─ /ask                       AI query interface (full-page)
  ├─ /simulation                Multi-agent simulation
  │    ├─ /orchestrator         Orchestrator view
  │    ├─ /agents/:id           Agent interaction / reasoning view
  │    ├─ /routing/:queryId     Query-to-agent routing visualization
  │    └─ /cross/:queryId       Cross-contributor reasoning view
  ├─ /compare?a=&b=             Version comparison
  ├─ /connections               Neo4j / providers / integrations
  └─ /settings                  Repo/project settings
Global overlays: Command palette (⌘K search), Ask Panel (docked), Detail Panel (right), Filter Bar, Graph Controls
```

## E.2 Navigation pattern

- **Left rail (collapsible)**: Dashboard, Graph, Architecture, Contributors, History, Code, Ask, Simulation, Compare. Bottom: Connections, Settings.
- **Top bar**: repo switcher, snapshot/as-of selector (global time context), global search (⌘K), analysis status chip, AI status chip (`AI off | provider/model`).
- **Right Detail Panel**: universal, context-dependent; opens from any entity click anywhere.
- **Ask Panel**: docked bottom or right; available on every screen; inherits selection.
- **Global state carried across screens**: `selection[]`, `as_of`, `filters`, `scope`. Deep links serialize this state into the URL.

Key principle: **every entity is a link** to its detail panel and "show in graph" / "show in source" actions.

---

# F. UI/UX Design Template

## F.0 Visual system (light theme only)

- **Background** `#FAFAF8` (warm off-white); **surface** `#FFFFFF`; **border** `#E4E4DF` 1px; **text** `#1B1D21`; **muted** `#6B6F76`.
- **Accent (single, restrained)**: deep teal `#0F6B6B` for primary actions and selection; **secondary** ochre `#B7791F` for warnings/uncertainty; **danger** `#B42318`. *No gradients anywhere.* (Replaces CURRENT's lavender gradient styling; lavender may remain as a very light tint for "contributor" entity type only.)
- **Entity colors** (low-saturation, distinguishable and colorblind-safe, always paired with shape/icon): contributor `#7A5C99`, commit `#4F6D7A`, PR `#2E7D6B`, file `#8C8C85`, function `#0F6B6B`, module `#A0522D`, service `#2F5D8A`, endpoint `#B7791F`, datastore `#5B6B2F`, decision `#8A3B5B`.
- **Typography**: Inter (UI) + JetBrains Mono (code/SHAs); 13px base, 12px dense tables, 20/28px headings; tabular numerals for counts. Strong hierarchy through weight and size, not color.
- **Density**: compact rows (28–32px), 8px grid, generous page margins, subtle 1px dividers, 6px radius, shadows only on floating panels.
- **Evidence badges**: tier chips `T0 exact`, `T1 explicit`, `T2 structural`, `T3 heuristic`, `T4 inferred` — monochrome with a fill intensity scale; T3/T4 additionally use dashed outlines on graph edges.

Common states (apply to every screen unless overridden): **Loading** = skeleton rows/cards (never a bare spinner); **Empty** = one-line explanation + primary action; **Error** = inline message with cause, retry, and "copy diagnostics"; **Partial** = banner "Analysis partial: 3 of 12 stages complete" with links to completed views.

## F.1 Landing page

- **Purpose**: explain Mnemo in 10 seconds and get a URL pasted.
- **Layout**: hero (headline "History is evidence. AI is opt-in.", one-line sub, URL input with Analyze button), below: three proof panels (a real graph screenshot, an evidence-chain answer with citations, an abstention example), "How it works" 4 steps, supported languages matrix, privacy statement.
- **Components**: URL field with validation as you type (detects `github.com/owner/repo`), recent repos list, example repos (chips, e.g. redis/redis).
- **Interactions**: paste → Enter → goes to F.2 pre-filled. Example chips load a *pre-analyzed demo* instantly.
- **AI**: none. **States**: invalid URL (inline hint); offline (banner).

## F.2 Repository import

- **Purpose**: configure and start analysis.
- **Layout**: centered card, 2 steps.
- **Components**: URL/local path; source tabs (GitHub URL | Local folder | Upload zip *(v2)*); **Access** (public / token for private; token stored per policy, shown masked); **Scope options**: history depth (full / since date / last N commits), branches (default / all), include PR/issues/reviews (needs token for rate limits), languages detected preview; **AI options**: "Enable AI interpretation layer" (off by default), provider/model, a **data-egress disclosure** ("Selected excerpts of commit/PR text and code snippets would be sent to <provider>").
- **Estimator**: after the inventory step, show repo size, commit count, estimated time and API calls; warn on limits and offer "analyze recent history only".
- **Interactions**: Start → F.3.
- **Errors**: not found/private, rate-limited (show reset time + "add token"), too large (suggest shallow), unsupported (no recognized languages → file-level only).

## F.3 Analysis / loading experience

- **Purpose**: transparent, resumable progress; first value early.
- **Layout**: left = pipeline stages list, right = live preview.
- **Stages** (each with state, counts, duration): Fetch → Inventory → Parse code → Detect system layer → Walk history → Resolve identities → Map delivery (PRs/issues/releases) → Build graph → Extract intent *(if AI/heuristics on)* → Compute rollups & ownership → Index search.
- **Live preview**: as soon as *Inventory* completes, show language mix and directory tree; after *Parse*, show top modules; after *Walk history*, show contributor leaderboard and commit sparkline. A "Open workspace now (partial)" button becomes enabled once the Fact-layer core is built.
- **Interactions**: pause/cancel, view log, see skipped files and reasons.
- **Errors**: stage-level with retry-from-stage; partial result retained.

## F.4 Main project dashboard

- **Purpose**: orient in the repo in one screen.
- **Layout**: KPI strip → 2×3 card grid.
- **Cards**: Repository pulse (files, symbols, commits, contributors, PRs, releases), Architecture mini-map (L1 cluster graph, click → F.5), Top contributors (ownership bars), Recent activity, Hot spots (high churn × high coupling), Decision health (# decisions, # superseded, # unrecorded-intent hot spots), Delivery state (open PRs / merged / released), Language & dependency breakdown, Data-quality panel (unresolved calls %, identity merges pending, partial stages).
- **Interactions**: every card element deep-links with filters preset. "Ask about this repo" prompt chips.
- **AI**: suggested questions generated deterministically from stats (e.g., "Why is `X` the most-changed file?").
- **States**: empty (analysis not run), partial.

## F.5 Main knowledge graph

- **Purpose**: the primary explorable map. See G for full spec.
- **Layout**: full-bleed canvas; top-left breadcrumbs (Project › Service › Module…); top-center search; top-right as-of selector; left floating **Graph Controls** (levels, layers, edge types, layout, filters); right **Detail Panel**; bottom **Ask strip** (selection-aware); bottom-left minimap.
- **Default view**: L1 (services/packages) clusters with contributor halo counts; never more than ~150 visible nodes.
- **Interactions**: double-click cluster = expand in place; click = select + panel; shift-click = multi-select; right-click = context menu (Expand, Collapse, Isolate, Trace callers/callees, Show history, Show owners, Open source, Ask AI).
- **AI**: selection chips: Explain this · Who changed this · Why does A depend on B (on edge selection) · What breaks if removed · Show relevant contributors · Trace dependency.
- **States**: >N nodes after filter → auto-cluster banner; no results → "No entities match; clear filters"; layout computing → progress bar.

## F.6 Code architecture explorer

- **Purpose**: system-level structure beyond files.
- **Layout**: tabs: **Services & Modules** | **API map** | **Data map** | **Dependencies** | **Infra**.
- **Components**: *Services & Modules*: layered diagram + coupling matrix (DSM) with cycles highlighted. *API map*: table of endpoints (method, path, handler, consumers count, owner) with a split pane graph "frontend components → endpoints → handlers → datastores". *Data map*: datastores → entities → readers/writers. *Dependencies*: manifest dependencies by module, version, outdated/duplicated flags. *Infra*: Dockerfile/compose/k8s/CI resources mapped to services.
- **Interactions**: click endpoint → shows consumers and handler; "Trace request path" highlights frontend → endpoint → handler → DB. Every link displays its evidence tier; T3 links dashed with "verify" affordance.
- **States**: "No endpoints detected for supported frameworks" with a list of frameworks checked (honesty over blank).

## F.7 Contributor explorer

- **Purpose**: who does what.
- **Layout**: table + matrix toggle. Table columns: contributor, commits, PRs opened/reviewed, symbols touched, surviving lines, primary modules, active range (sparkline), identity merges badge. Matrix: contributors × modules heatmap (ownership score).
- **Interactions**: filter by module/time; select multiple → compare; "Merge identities" action (opens dialog from Identity Resolver proposals); "Open agent" → F.17.
- **States**: bots detected and grouped (toggle).

## F.8 Contributor detail

- **Purpose**: the contextual footprint of one person (= what their agent knows).
- **Layout**: header (canonical name, identities, active range); tabs **Footprint** (mini-graph centered on them, expandable), **Ownership** (modules/files/functions ranked, line survival), **Timeline** (commits/PRs/reviews stripe chart), **Changes** (filterable list), **Decisions** (they authored/discussed), **Collaborators** (co-change and review graph), **Agent** (preview of context pack summary & scope).
- **Interactions**: click anything → graph focus; "Ask this contributor's footprint" opens F.17 prefilled.
- **Note**: show disclaimer "Footprint reflects recorded history, not total knowledge or opinion."

## F.9 Commit history visualization

- **Purpose**: shape and rhythm of change.
- **Layout**: top: stacked area/ribbon chart (commits per period by contributor); middle: commit lanes (git-graph style) with branch/merge; bottom: commit list.
- **Components**: filter bar (contributor, path, symbol, type via conventional-commit, date), brush selection to zoom time, commit card (SHA, author, message, stats, linked PR/issue, delivery state, touched symbols).
- **Interactions**: brushing updates every linked view; click commit → Detail Panel with diff stats and "show in graph".

## F.10 Pull request / change explorer

- **Purpose**: how change moved from proposal to delivery.
- **Layout**: list left (state, size, age, author, review count), PR detail right.
- **PR detail**: header + **delivery pipeline strip** (opened → reviewed → merged → released → distributed*), tabs: Discussion (reviews and comments with quoted spans), Commits, Changes (files → symbols), Linked issues/decisions, Impact preview. *Distributed only where evidence exists; otherwise "unknown".
- **Interactions**: "Show change in graph" highlights touched nodes; compare PR vs base in diff inspector.
- **States**: repo without PR data (non-GitHub or token missing): explain and show commit-only mode.

## F.11 File explorer

- **Purpose**: read code with history and graph relations.
- **Layout**: three columns as in CURRENT §3.4 (tree | viewer with tabs | file timeline), plus a collapsible bottom drawer with Diff and Relations.
- **Enhancements over CURRENT**: **symbol outline** in viewer gutter; **blame ribbon** by contributor color; **per-function history chip** above each function ("12 versions, 4 contributors"); hover a call site → peek definition and its owner; "show in graph" button; as-of selector re-renders file at that commit; decisions governing the file shown in a collapsible strip.
- **Interactions**: click symbol → Detail Panel; line range → "Ask about this selection".
- **States**: binary/large file placeholder; file not present at as-of commit.

## F.12 Function-level dependency / call graph

- **Purpose**: trace calls and impact.
- **Layout**: centered focus function, callers left, callees right (layered), depth slider 1–5.
- **Components**: edge style by `resolution` (solid exact, dashed heuristic, dotted unresolved); node badges (owner color, last changed, churn); toggles: include tests, include third-party, collapse by file/module.
- **Interactions**: click node = re-center; "Trace path to…" picks a second node; "Impact if removed" button runs reverse reach with result list grouped by module and unresolved warnings; "Highlight chain" persists a pinned path.
- **States**: recursion cycles marked; dynamic dispatch banner with count.

## F.13 Repository timeline

- **Purpose**: the history of the *system*, not just commits.
- **Layout**: horizontal multi-lane timeline: Releases, Major decisions (with supersession arcs), Architecture events (module created/removed/renamed, service split), Contributor arrivals/departures, Incidents, Large refactors.
- **Interactions**: scrubbing sets global `as_of`; graph/file/architecture views follow. "Compare with…" pins a second marker → F.20.
- **Notes**: architecture events are derived (T2/T3) and labeled so.

## F.14 AI query interface (full page)

- **Purpose**: deep Q&A with citations, history, and trust display.
- **Layout**: conversation center; left: saved/pinned queries; right: **Evidence panel** showing the current answer's citations as a mini-graph + list.
- **Answer card**: answer text with inline citation chips → hover shows source span, click highlights in graph; **Confidence block** (claim coverage, weakest tier, dropped statements); route chip (`Orchestrator → Agent X + Agent Y`) linking to F.18; "Show reasoning trace".
- **Scope selector**: whole repo | selection | module | contributor | time range.
- **States**: *Abstention card* (distinct style): states what the graph does contain, what is missing, and suggests where a human could look (e.g., the original author via `git blame`, issue tracker). *AI off*: answers as cited fact lists with banner "AI disabled — showing retrieval answers". *Ambiguous entity*: disambiguation chips.

## F.15 Multi-agent simulation interface (home)

- **Purpose**: a sandbox, separate from the main graph, to watch and steer multi-agent reasoning.
- **Layout**: left roster (Orchestrator pinned, contributor agents with footprint size, long-tail agent); center stage (selectable view: Orchestrator / Routing / Cross-contributor / Agent); right: query composer + run history.
- **Controls**: thresholds (activation %, max agents, max rounds, token budgets), mode (retrieval-only vs LLM), replay a previous run.
- **Principle**: the simulation reads the same GraphStore but renders **its own scene graph** (agents, messages, packs) — not the repo graph — satisfying the separation requirement.

## F.16 Orchestrator view

- **Purpose**: show what the orchestrator knows and decides.
- **Layout**: top: query and parsed intent/entities; middle: **relevant subgraph** (small, readable) with owner coloring; bottom: decision log (activation rule fired, thresholds, alternatives rejected).
- **Components**: global index stats (what's queryable), entity linking result with scores, activation scoreboard (agent, footprint coverage %, selected/not, reason).
- **Interactions**: override activation (force include/exclude an agent) and rerun.

## F.17 Agent interaction / reasoning view

- **Purpose**: inspect one agent's reasoning against its evidence.
- **Layout**: left: agent footprint summary and the context pack (items checkable); center: reasoning trace (steps: tool calls to graph, findings produced); right: findings with citations and tier.
- **Interactions**: click a finding → highlight evidence items; "Unsupported" flagged items shown struck-through with the verifier's reason.
- **Design rule**: no avatar chat-bubble impersonation; agents are labeled "Footprint of <name>", with a footnote that responses are derived from recorded work.

## F.18 Query-to-agent routing visualization

- **Purpose**: make routing legible.
- **Layout**: left-to-right flow diagram: Query → intent/entities → entities in graph → owners → activation → agents.
- **Visual**: Sankey-like bands whose width = footprint share per contributor for the query's entities; chosen agents solid, skipped faded with reason on hover.
- **Interactions**: click any band to open contributor detail; toggle to see "what if threshold = X".

## F.19 Cross-contributor reasoning view

- **Purpose**: show multi-agent exchange and contradictions.
- **Layout**: three columns: Agent A findings | Reconciliation (orchestrator: agreements, conflicts, gaps) | Agent B findings; temporal strip at the top showing which finding applies when (supersession awareness).
- **Interactions**: expand `Question`/`Objection` messages; toggle "show only conflicts"; export trace as JSON/Markdown.
- **Conflicts** use a clear "Disagreement" marker with both evidence sets side by side.

## F.20 Version comparison

- **Purpose**: "what changed between two versions".
- **Layout**: two selectors (tag/commit/date) → summary + tabs: Architecture diff (added/removed/changed modules, edges), API diff (endpoints added/removed/changed signature), Symbols diff, Dependencies diff, Contributors active, Decisions in range.
- **Interactions**: "Show diff in graph" overlays added (green outline), removed (red dashed), changed (amber).
- **AI**: "Summarize changes in <layer>" generates a summary subject to verification.

## F.21 Settings (repo/project)

- **Sections**: Analysis (history depth, branches, languages, re-analyze, incremental update schedule), Identity (merge rules, `.mailmap` import, bot patterns), Agents (significance threshold, activation thresholds, budgets), AI (provider, model, key status, **egress policy**: what text/code may be sent, redaction rules, per-repo opt-in), Graph store (memory/Neo4j, status, sync), Data (cache size, delete repo data, export graph as JSON/GraphML/Cypher), Access (private repo tokens).
- **States**: dangerous actions require typed confirmation.

## F.22 Search and filtering (global)

- **⌘K palette**: entity search across types with type chips and fuzzy match; recent; commands ("Go to…", "Ask…", "Filter by…").
- **Filter bar** (shared model across Graph, History, Contributors): contributor(s), path/module glob, commit range or time range, entity type, edge type, evidence tier ≥, delivery state, "only changed since". Filters are shown as removable pills and persisted in URL.
- **Empty result**: show which filter eliminated the most items.

## F.23 Graph controls and context/details panels

- **Graph Controls**: Level slider (L0–L4), Layers (Fact / Interpretation / System), Edge-type toggles with counts, Layout (hierarchical, force, radial-by-contributor, layered-by-call-depth), Cluster-by (module / contributor / service / topic), Size-by (churn / LOC / callers), Color-by (type / owner / age / delivery state), Hide-test-code, Reset view.
- **Detail Panel** (universal): header (type icon, name, id copy), summary facts, **Relationships** (grouped by edge type, counts, click to expand in graph), **History** (version timeline), **Owners** (ranked), **Decisions** (with status and supersession note), **Evidence** (tier and sources), actions (Open source · Show in graph · Trace callers/callees · Ask AI · Pin). For edges: shows both endpoints, evidence, and the `Why does A depend on B` button.
- **Loading** in panel = skeleton; **Missing data** is explicit: "No linked decision recorded".

## F.24 Error / loading / empty states catalog

| Situation | Treatment |
|---|---|
| Analysis failed at stage | Stage card in error, partial workspace available, retry-from-stage |
| GitHub rate limit | Banner with reset countdown; suggest token; continue with git-only data |
| Private repo / 404 | Explain; link to token setup |
| Unsupported language | File-level only badge; list supported languages |
| Graph too large for view | Auto-cluster; show counts and "Expand anyway (may be slow)" |
| No history for entity | "No recorded changes since analysis start (shallow history?)" |
| LLM unreachable/over quota | Fall back to retrieval answer; keep trace |
| Verifier abstains | Abstention card (F.14) |
| Neo4j disconnected | Chip in top bar; app continues in-memory; sync paused notice |
| Stale analysis (new commits upstream) | Soft banner "N new commits — update (incremental)" |

---

# G. Graph Visualization Specification

## G.1 Principles

1. **Never render more than the viewport can explain**: target ≤ 150 nodes / 300 edges visible by default; hard cap 2,000 with warning.
2. **Server-side LOD**: the client asks for `view(level, focus, filters, as_of, viewport_budget)`; the server returns nodes, clusters and *aggregated* edges. The client never receives the full graph for large repos.
3. **Progressive disclosure**: Project → Service → Module → File → Symbol, each expandable in place.
4. **Semantics over physics**: layout is chosen by meaning (hierarchical, layered by call depth, lanes by contributor), not generic force graphs, except as an option.
5. **Honesty**: uncertainty is visible (dashed/dotted edges, tier badges).

## G.2 Node types, shapes and encoding

| Type | Shape | Color token | Label | Size encodes |
|---|---|---|---|---|
| Project | rounded rect (large) | ink | repo name | — |
| Service | rounded rect | service | name | LOC |
| Module/Directory | folder tab rect | module | name | file count |
| File | rectangle | file | basename | churn |
| Class | rect with notch | function (lighter) | name | members |
| Function | circle | function | name | callers |
| Endpoint | hexagon | endpoint | `GET /path` | consumers |
| DataStore/Entity | cylinder | datastore | name | readers/writers |
| Contributor | circle with ring | contributor | name | surviving lines |
| Commit | small diamond | commit | short SHA | files changed |
| PullRequest | pill | pr | `#n` | size |
| Decision | rounded square | decision | summary (truncated) | — (border style = status) |
| Cluster | stacked-rounded rect | inherits dominant child | label + count | member count |

Overlays: badge (top-right) for tier T3/T4; red dot = unresolved incoming/outgoing; ring in contributor color = primary owner; strike-through label = deleted at `as_of`; muted fill = decision superseded.

## G.3 Edge types, styles

| Edge | Style | Direction |
|---|---|---|
| CONTAINS/PART_OF | thin neutral, drawn as nesting in hierarchical layout (no line) | parent→child |
| IMPORTS | thin solid gray | arrow |
| CALLS | solid teal; dashed if heuristic; dotted if unresolved | arrow |
| EXPOSES/HANDLED_BY/CONSUMES/CONNECTS_TO | solid ochre/blue/green by relation | arrow |
| AUTHORED/TOUCHED | thin contributor-colored; width = count | none |
| MODIFIED/INTRODUCED | commit-colored | arrow |
| GOVERNS/RESULTED_IN/DISCUSSED_IN | decision-colored thin | arrow |
| SUPERSEDES | curved bold arc in decision color with "overrode" label | newer→older |
| Aggregated (rollup) | single thicker edge, width ∝ log(weight), count label | — |

## G.4 Views (presets over the same model)

1. **Architecture view** (default): L1/L2 hierarchical clusters, system edges, contributor halos.
2. **Evidence view**: lanes by contributor → commits → changes → files/symbols → decisions (CURRENT's Evidence mode, retained).
3. **Code view**: repo → modules → files → symbols with calls/imports (CURRENT's Code graph, retained).
4. **Module coupling view**: DSM/chord layout (CURRENT's Modules, retained, plus coupling score and cycles).
5. **Ownership view**: modules/files colored by owner, size by churn.
6. **Call-chain view**: layered left-to-right from focus.
7. **Delivery view**: PR → commit → release lanes.
8. **Time view**: any view + as-of scrub; added/removed/changed styling.

## G.5 Expansion / collapse rules

- Expand: double-click, `+` key, or detail-panel "Expand". Children are laid out *inside* or *adjacent to* the parent with an animated transition (≤250ms), preserving the user's viewport anchor.
- **Expansion budget**: if children > 40, show top-K by relevance (churn, callers, recency) plus a "+N more" pseudo-node that opens a paged list.
- Collapse: `−`, double-click header; collapsed state persists in session.
- **Auto-collapse** triggers when visible nodes exceed budget: collapse least-relevant clusters first (lowest weight sum); notify non-modally.
- **Semantic zoom**: label and detail change with zoom: at far zoom only clusters with counts; mid-zoom adds edges; near zoom adds symbol names and badges; above L3 zoom, the canvas can morph into the code viewer split view.
- **Isolate**: show selection + n-hop neighborhood; "Restore" returns to the prior view (back stack).

## G.6 Filtering

All filters apply *server-side* and produce a new view; they combine with AND across categories and OR within a category. Supported: contributor, file/module glob, commit set, time range, relationship type, entity type, tier ≥, delivery state, layer. When a filter removes a node needed for connectivity, show a faint "ghost" connector to preserve paths (toggle).

## G.7 Path, trace and highlight behaviors

- **Hover**: highlight 1-hop neighbors; dim others to 20%.
- **Select**: highlight and open panel; **multi-select** enables "Find paths" (shortest/all up to k, by chosen edge types).
- **Trace callers/callees**: animated layered expansion to depth N with cycle markers.
- **Trace contributor**: highlights everything in the contributor footprint with a bright halo; shows other contributors' overlap in hatch.
- **Pin**: persist highlight sets; named "highlight layers" can be toggled.

## G.8 Time and comparison

- Global **as-of** control re-renders using `valid_from/valid_to`. Entities created later disappear; deleted ones appear until their deletion.
- **Compare mode**: split screen or overlay diff with legend (added/removed/changed), plus summary counters; selection stays synchronized.

## G.9 Navigation between graph and code

- Node → "Open source": jumps to File explorer at the symbol's start line with as-of set to the same commit.
- Code → graph: gutter icon and context menu "Show in graph" focusing the symbol with its 1-hop neighborhood.
- Breadcrumb always reflects the hierarchy path.

## G.10 Performance requirements

- 60fps pan/zoom up to 2,000 visible nodes (canvas/WebGL).
- View query p95 < 400ms (Neo4j) / < 150ms (in-memory) for ≤ 150-node views on a 100k-symbol repo.
- Layout computed server-side for hierarchical views, cached per (view, filters, snapshot); force layout runs client-side in a worker.
- Accessibility: keyboard navigation (arrow keys between neighbors, Enter to open panel, `E`/`C` expand/collapse), screen-reader list view equivalent of any graph ("Outline mode"), colorblind-safe palette with shape redundancy.

---

# H. End-to-End User Workflow

```
GitHub URL
  → [1 Ingestion]      validate · mirror clone · metadata fetch · inventory · estimate
  → [2 Code analysis]  AST per language · symbols · imports/calls · system detectors · manifests/infra
  → [3 History]        commit walk · diffs · rename tracking · hunk→symbol · identity resolution · delivery mapping
  → [4 Graph build]    fact layer upsert · rollups · ownership · coupling · search index
  → [4b Interpretation] (optional) decisions · supersession candidates · topics → status=proposed
  → [5 Graph query]    GraphStore API (as_of aware)
  → [6 Context]        Context Builder: scoped, ranked, budgeted packs with IDs
  → [7 Orchestrator]   intent · entity linking · routing · activation
  → [8 Agents]         footprint agents produce Findings (with graph-tool calls)
  → [9 Reasoning]      reconciliation · optional question/objection round
  → [Verifier]         claim check · drop/abstain · confidence
  → User answer        text + citations (clickable entities) + route + confidence (or abstention)
```

**Worked example** — "Why was this database function changed?" (selected: `Function db.save_order`)
1. Selection context sent: `Function:db.save_order`, `as_of=HEAD`.
2. Orchestrator: intent `why`; entity resolved exactly; fetches `history_of`, `decisions_governing`, `owners`.
3. Owners: Contributor X 62%, Y 31% → multi-agent route (2 agents + orchestrator).
4. Context packs include X's commits/PRs touching it plus Y's, linked issue #310, review comments.
5. Findings: X: "introduced transaction wrapper (PR #402) — cites span S1"; Y: "later removed retry loop (PR #511) — cites S2; PR #511 `SUPERSEDES` the retry decision in #402".
6. Reconciliation: preserves chronology; labels first decision superseded (R2).
7. Verifier: all claims verified at T0/T1 except one T3 inference → dropped or labeled.
8. Answer: chronological explanation, citations, "superseded" note, confidence panel. If no PR/issue text exists for the change → abstention card stating exactly that.

---

# I. Implementation Roadmap

Legend: **[E]** exists per CURRENT (verify, refactor behind new interfaces) · **[N1]** next priority · **[N2]** advanced · **[R]** research-grade/future.

## Phase 0 — Foundations and refactor (precondition)
- [E→refactor] Introduce `GraphStore` interface; port in-memory graph and Neo4j sync behind it.
- [N1] Stable IDs, provenance fields, fact/interpretation layer flags, evidence tiers on every edge.
- [N1] Job runner with stages, progress events (SSE), caching by SHA.
- [N1] Doc reorganization (A.6) and API reference.

## Phase 1 — Deep fact layer
- [E] Commit/diff/author ingestion; symbols/imports/calls (audit language coverage; document the matrix).
- [N1] Tree-sitter-based analyzers; resolution tags on calls.
- [N1] Hunk→symbol mapping, `Change` and `SymbolVersion` nodes, rename tracking (`--follow` + AST similarity).
- [N1] Identity Resolver (+ `.mailmap`, bot detection, merge UI).
- [N1] GitHub API ingestion: PRs, reviews, comments, issues, releases; commit↔PR↔issue linking.
- [N1] Ownership and `TOUCHED/OWNS` derivations, line survival.

## Phase 2 — System layer
- [N1] Manifests/lockfiles → `Dependency`; env/config keys; Dockerfile/compose/CI.
- [N2] Endpoint detectors for top frameworks (start with Express/FastAPI/Flask/Django/Spring/Gin per target demo repos), HTTP client detectors (fetch/axios/requests), ORM/SQL detectors.
- [N2] Derived `COMMUNICATES_WITH` and request-path tracing.
- [N2] Delivery Mapper: tags/releases, release workflows; distribution evidence (package manifests).

## Phase 3 — Visualization and workspace
- [E] Existing tabs retained; theme re-skin to F.0; remove dark mode.
- [N1] Graph Service (LOD, rollups) and canvas/WebGL renderer; Detail Panel; global filter model; ⌘K search.
- [N1] Dashboard, Contributor detail, PR explorer, Call graph, Timeline, as-of control.
- [N2] Architecture explorer (API/Data/Infra maps), Version comparison, Outline (accessible) mode.

## Phase 4 — Intelligence
- [N1] Context Builder + Context Pack with ID discipline.
- [N1] Orchestrator v2: intent classification, entity linking, activation policy (D.4), retrieval-only answers.
- [N1] Verifier (deterministic claim check on templated claims), confidence block, abstention card.
- [N2] LLM claim extractor, intent extraction (decisions) with span-grounded evidence, supersession rules R1–R3.
- [N2] Selection-scoped AI throughout the UI.
- [N2] Impact analysis with unresolved-call reporting.

## Phase 5 — Multi-agent simulation
- [N2] Simulation workspace (F.15–F.19), structured findings/objections, replay, threshold controls.
- [N2] Long-tail agent, dynamic follow-up activation via stubs.

## Phase 6 — Scale and rigor
- [N2] Incremental re-analysis; hosted mode (queue workers, auth, private repo token vault); Neo4j as default hosted store.
- [N2] Evaluation harness: golden questions per demo repo, grounding metrics, abstention precision/recall, routing accuracy.
- [R] Semantic supersession (R4) with calibration; cross-repo graphs (monorepo/multi-repo systems); runtime-trace ingestion (OpenTelemetry) to resolve dynamic calls; learned entity resolution; counterfactual impact simulation; GitLab/Bitbucket adapters.

---

# Appendix 1 — Open questions and flags (decisions needed, not assumed)

1. **Language scope for v1.** Which languages get full call graphs? Recommend: Python, JS/TS, Java, Go first; others import/file-level. *Needs a decision.*
2. **Scale target.** Maximum repo size supported in local mode (commits, symbols)? Affects in-memory feasibility and clone strategy (full vs blobless clone).
3. **GitHub data access.** Unauthenticated GitHub API limits make PR/issue/review ingestion of large repos impractical; tokens (or GraphQL batching) are effectively required. *Confirm that a token is acceptable UX.*
4. **Squash/rebase merges** erase original commit granularity; PR→commit mapping then relies on PR API data. Document as a known limit.
5. **"What reached production"** can only be inferred from tags/releases/workflows/package registries; many repos have no such evidence. Product must say "unknown" rather than infer.
6. **Impact analysis completeness** is bounded by static analysis; reflection, DI containers, dynamic imports and cross-language calls are blind spots. UI must show unresolved counts. Do not present the result as exhaustive.
7. **Agent personification risk.** Agents representing real people should be labeled as footprint-derived and never produce first-person speech. Confirm with stakeholders (privacy/HR sensitivity of per-person attribution, "ownership" metrics being misused as performance metrics). Consider an org-level setting to disable per-person agents/metrics.
8. **LLM data egress.** Code and text leave the machine when AI is on. Per-repo opt-in, redaction, and provider-level policies required; local models (Ollama) as an option.
9. **MR terminology.** "Merge requests" are a GitLab concept; v1 scope is GitHub-only unless adapters are prioritized.
10. **Claim extraction reliability** for free-text answers is the weakest point of the verifier; start with constrained, templated answer generation (LLM fills structured fields) before open-ended prose.
11. **Frontend framework** decision (stay vanilla vs adopt a framework + canvas/WebGL graph library) — recommended: adopt, given 20+ screens and shared state.
12. **Neo4j Aura limits** (node/relationship caps on tiers) vs repo size; keep in-memory fallback and export.

# Appendix 2 — Acceptance tests (for the evaluation harness)

1. **Supersession**: for a ConfigKey whose value was changed by a later PR, the answer cites the later decision and states the earlier one is superseded, with both dates. 
2. **Abstention**: for a symbol with no PR/issue/commit rationale, the answer abstains and names what the graph does contain.
3. **Routing**: a question about a file owned ≥70% by one contributor routes to a single agent; a cross-module question activates ≥2 agents and the trace shows why.
4. **Rename survival**: a function renamed twice shows one continuous `Symbol` with three `SymbolVersion`s and aliases.
5. **Identity merge**: three emails for one person yield one contributor and one agent.
6. **System layer**: a frontend `fetch('/api/x')` links to the matching handler and datastore with T2 evidence; unmatched calls remain unresolved (not guessed).
7. **Impact**: "what breaks if `f` is removed" returns impacted callers grouped by resolution tier plus an unresolved-call warning.
8. **Verifier**: an injected false claim in a drafted answer is dropped and logged; an injected false *core* claim triggers abstention.
9. **Scale**: a 100k-symbol repo opens in the Graph view with ≤150 visible nodes, pans at 60fps, and expands a module in <500ms.
10. **No-AI mode**: all primary queries still return cited retrieval answers with AI disabled.
