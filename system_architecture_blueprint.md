# Mnemo: Codebase Intent Knowledge Graph & Multi-Agent Reasoning Architecture

**Project Name:** Mnemo  
**Codename:** WTCLT (Why The Code Is Like This)  
**Document Version:** 1.0.0-PROD  
**Target Environment:** Neo4j AuraDB / Aura Agents / GraphRAG + Deterministic AST Pipeline + Multi-Agent Consensus  

---

## 1.1 Why The Code Is Like This

**Build type:** Applied AI  
**Goal:** Answer the question code cannot answer: *why is it like this.*

### The Situation
In every engineering team there is one person who knows why. Why the retry limit is three. Why that service was never migrated. Why a configuration flag nobody understands has to stay switched on. That knowledge lives in commit messages, closed pull requests, incident threads, design documents and inside one senior engineer's head. When that engineer leaves, the codebase stays and the reasoning walks out of the door.

### The Problem
A new developer can read code. They cannot read intent. Search gives them keywords, not decisions. Build a system that answers *why is this the way it is*, for a real codebase, with evidence attached to every answer.

### Why the Current Answers Fail
- **Vector search over documents** returns text that mentions the topic, not the decision that governs it.
- **Documentation is written once and drifts**, while commits and pull requests keep telling the truth.
- **A decision that was reversed two years later** still sits in the archive looking authoritative.
- **Nobody records the link** between an incident and the line of code that changed because of it.

### What We Expect You to Build
- **Ingest a public repository's history:** Commits, pull request discussions, issues, and any design documents inside the repository.
- **Construct a graph:** Code entities such as files, modules, functions, and configuration keys connect to decisions, people, incidents, and to each other.
- **Answer natural language questions with a chain of evidence:** The decision, the discussion that produced it, the person to ask, and the date.
- **Detect supersession:** When a later decision quietly overrode an earlier one, your system says so instead of quoting the dead one.
- **Show a confidence signal:** Refuse to invent an answer when the graph does not contain one.

### Data and Stack
Pick any large public repository with a long and messy history. This is a graph problem end to end, because the value sits in the relationships and not in the text, so **Neo4j AuraDB** is the natural home and **GraphRAG** is the natural retrieval pattern. The Build Sprint flow on AuraDB, GraphRAG, and Aura Agents maps almost directly onto this problem statement, which makes it a strong choice for teams attending a city Build Sprint.

### The Layer Beneath
- **Entity resolution is the hard part:** The same module carries four different names across five years, used by three people, described in two vocabularies.
- **Temporal reasoning is the second hard part:** Relevance decays and decisions expire. Teams that treat this as retrieval will build a search box. Teams that treat it as a graph of decisions moving through time will build a product.

### What the Judges Will Reward
- A question we can ask your demonstration that the project documentation could not answer.
- Honest behaviour when the answer is not in the graph.
- Evidence that the graph structure, and not the model, is doing the work.

---

## 2. Core Architectural Philosophy of Mnemo

```
+-------------------------------------------------------------------------------------------------+
|                                     THE MNEMO PARADIGM                                          |
|                                                                                                 |
|   1. DETERMINISTIC DISCOVERY (NO AI)         2. GRAPH-FIRST REASONING     3. ZERO HALLUCINATION |
|   AST parsing, Git commit trees, diff        Neo4j AuraDB holds the       Every claim requires  |
|   hunks, and symbol extraction use pure      timeline, links, and         a direct Node & Edge  |
|   compiler tools (Tree-sitter/SCIP).         temporal supersessions.      provenance citation.  |
+-------------------------------------------------------------------------------------------------+
```

1. **Non-AI Graph Ingestion Engine:** The code parsing, Abstract Syntax Tree (AST) symbol extraction, Git commit linking, and entity resolution are handled by deterministic software tools. AI is never trusted to parse syntax or build repository topology.
2. **Graph Structure Does the Heavy Lifting:** The LLM acts purely as a translator and synthesizer. Traversal, chronological ordering, and dependency chains are resolved via Cypher queries against Neo4j AuraDB.
3. **Calibrated Abstention (Honest Refusal):** If there is no edge in the graph connecting an issue/PR to a function or config flag, Mnemo explicitly states that the reasoning is unrecorded in repository history.

---

## 3. End-to-End System Blueprint

```
                                  +---------------------------------------+
                                  |         GitHub / Git Repository       |
                                  |   (Commits, PRs, Issues, Diffs, Code) |
                                  +---------------------------------------+
                                                      |
                    +---------------------------------+---------------------------------+
                    |                                                                   |
                    v                                                                   v
+---------------------------------------+                           +---------------------------------------+
|      PIPELINE 1: CODE TOPOLOGY        |                           |       PIPELINE 2: AUDIT & VCS         |
|         (Deterministic / AST)         |                           |         (Deterministic / API)         |
+---------------------------------------+                           +---------------------------------------+
| * Tree-sitter / SCIP / Babel Engine   |                           | * GitPython / PyGithub Ingestion      |
| * Extracts: Files, Modules, Functions |                           | * Commits, Tree Diffs, AST Hunks      |
| * Extracts: Config Keys, Variables    |                           | * PR Reviews, Comments, Debates       |
| * Maps: CALLS, IMPORTS, DEFINES       |                           | * Issue Tickets, Incident Threads     |
+---------------------------------------+                           +---------------------------------------+
                    |                                                                   |
                    +---------------------------------+---------------------------------+
                                                      |
                                                      v
                                    +-----------------------------------+
                                    |     MNEMO GRAPH LINKER ENGINE     |
                                    |  - Contributor Disambiguation     |
                                    |  - Hunk -> AST Symbol Resolution  |
                                    |  - Temporal Graph Builder         |
                                    +-----------------------------------+
                                                      |
                                                      v
                                    +-----------------------------------+
                                    |         NEO4J AURADB              |
                                    |  (Historical Property Graph)      |
                                    +-----------------------------------+
                                                      |
                      +-------------------------------+-------------------------------+
                      |                                                               |
                      v                                                               v
+-------------------------------------------+                   +-------------------------------------------+
|       CONTRIBUTOR SUB-AGENT LAYER         |                   |      TEMPORAL NARRATIVE VISUALIZER        |
|  - Agent(Dev_X): Context of PRs by Dev_X  |                   |  - WebGL / Cytoscape Interactive Graph    |
|  - Agent(Dev_Y): Context of PRs by Dev_Y  |                   |  - AST Hierarchy & Symbol Dependencies    |
|  - Structured Persona Debate/Colloquy     |                   |  - Time-Travel Historical Slider          |
+-------------------------------------------+                   +-------------------------------------------+
                      \                                                               /
                       \------------------------------+------------------------------/
                                                      |
                                                      v
                                    +-----------------------------------+
                                    |   TEMPORAL SUPERSESSION ENGINE    |
                                    |  Detects newer decisions that     |
                                    |  quietly overturned older logic   |
                                    +-----------------------------------+
                                                      |
                                                      v
                                    +-----------------------------------+
                                    |     SAFETY & VERIFIER AGENT       |
                                    |  1. Verifies edges in Neo4j       |
                                    |  2. Rejects unbacked statements   |
                                    |  3. Confidence score & Abstention |
                                    +-----------------------------------+
                                                      |
                                                      v
                                    +-----------------------------------+
                                    |    EVIDENCE-BACKED EXPLANATION    |
                                    | Decision + PR + Author + Date     |
                                    +-----------------------------------+
```

---

## 4. Neo4j Graph Schema Specification

### 4.1 Node Labels & Schema Definition

```cypher
// 1. Code Entities (Extracted via AST Parser)
(:Repository   { id: STRING, name: STRING, url: STRING, default_branch: STRING })
(:File         { id: STRING, path: STRING, language: STRING })
(:Module       { id: STRING, name: STRING, path: STRING })
(:Function     { id: STRING, name: STRING, signature: STRING, start_line: INT, end_line: INT })
(:Class        { id: STRING, name: STRING, start_line: INT, end_line: INT })
(:ConfigKey    { id: STRING, name: STRING, current_value: STRING, file_path: STRING })

// 2. People & VCS Artifacts (Extracted via Git & Issue Trackers)
(:Contributor  { id: STRING, username: STRING, emails: LIST<STRING>, display_name: STRING })
(:Commit       { sha: STRING, message: STRING, timestamp: DATETIME, insertions: INT, deletions: INT })
(:PullRequest  { number: INT, title: STRING, body: STRING, state: STRING, merged_at: DATETIME })
(:ReviewComment{ id: STRING, body: STRING, path: STRING, line: INT, timestamp: DATETIME })
(:Issue        { number: INT, title: STRING, body: STRING, state: STRING, closed_at: DATETIME })
(:Incident     { id: STRING, title: STRING, severity: STRING, post_mortem_url: STRING, timestamp: DATETIME })

// 3. Extracted Decisions (Semantic Graph Nodes)
(:Decision     { id: STRING, summary: STRING, context: STRING, timestamp: DATETIME, status: STRING })
```

### 4.2 Relationships & Temporal Properties

```cypher
// Code Dependencies (Deterministic AST)
(:File)-[:CONTAINS]->(:Function | :Class | :ConfigKey)
(:Function)-[:CALLS]->(:Function)
(:Class)-[:INHERITS_FROM]->(:Class)
(:Module)-[:IMPORTS]->(:Module)

// Historical Authorship & Modifications (Deterministic VCS)
(:Contributor)-[:AUTHORED]->(:Commit)
(:Contributor)-[:OPENED]->(:PullRequest)
(:Contributor)-[:REVIEWED]->(:PullRequest)
(:Contributor)-[:POSTED]->(:ReviewComment)
(:PullRequest)-[:MERGED_COMMIT]->(:Commit)
(:Commit)-[:MODIFIED { start_line: INT, end_line: INT, diff_hunk: STRING }]->(:Function | :ConfigKey | :File)

// Causality & Decision Links
(:Incident)-[:TRIGGERED]->(:PullRequest | :Commit)
(:Issue)-[:RESOLVED_BY]->(:PullRequest)
(:PullRequest)-[:RESULTED_IN]->(:Decision)
(:Decision)-[:GOVERNS]->(:Function | :ConfigKey | :File)

// Temporal Supersession Linkage
(:Commit)-[:SUPERSEDES { timestamp: DATETIME, reason: STRING }]->(:Commit)
(:Decision)-[:SUPERSEDES { timestamp: DATETIME, reason: STRING }]->(:Decision)
```

---

## 5. Solving the Hardest Engineering Problems

### 5.1 Hard Problem 1: Entity Resolution (Vocabulary & Refactoring Drift)
* **The Challenge:** Over 5 years, `auth_service` was renamed to `user_gateway`, its config `MAX_RETRY` was renamed to `CLIENT_RETRY_LIMIT`, and three engineers used conflicting terminology across commit logs.
* **Mnemo's Deterministic Solution:**
  1. **AST Node Tracking across Commits:** Track functions not merely by raw text string, but by syntax AST signature across Git rename events (`git log --follow` with structural diff verification).
  2. **Contributor Alias Disambiguation:** Deterministic identity reconciliation matching commit PGP keys, author emails, and GitHub login IDs into unified `(:Contributor)` nodes.
  3. **Lexical Aliasing:** An explicit `(:EntityAlias)` node that stores historical symbol names, connected via `[:ALIASED_AS { valid_until: DATETIME }]`.

### 5.2 Hard Problem 2: Temporal Reasoning & Supersession Detection
* **The Challenge:** In 2021, an incident set a connection pool limit to 50. In 2023, a refactor to connection multiplexing changed the requirement, making 50 obsolete. Vector search still pulls the 2021 incident as authoritative.
* **Mnemo's Supersession Algorithm:**
  1. For any query target (e.g., `ConfigKey: POOL_SIZE`), traverse incoming `[:MODIFIED]` edges sorted by `Commit.timestamp DESC`.
  2. Evaluate graph edges for intervening `SUPERSEDES` relationships between commits modifying the same AST boundary.
  3. Flag any node with an incoming `[:SUPERSEDES]` target as `STATUS: EXPIRED`.
  4. The query engine surfaces the newest governing decision, explicitly attaching a note: *"Overrode earlier decision from March 2021 (PR #402)."*

### 5.3 Hard Problem 3: Contributor Sub-Agents
* When multiple developers have touched a subsystem, Mnemo spawns specialized **Contributor Personas**:
  * **Agent(Engineer_A):** Context window isolated to Engineer A's authored PRs, commit messages, and review objections.
  * **Agent(Engineer_B):** Context window isolated to Engineer B's follow-up changes and incident post-mortems.
  * **Consensus Synthesizer:** Coordinates a simulated debate between the personas to extract *why* the implementation shifted, preserving authentic viewpoints rather than a generalized summary.

---

## 6. AI Safety, Verification & Honest Abstention Protocol

### 6.1 The Independent Verifier Gate
```
                     +---------------------------------------+
                     |    Candidate Answer from Reasoning    |
                     |  "Config X is 3 due to Incident #88"  |
                     +---------------------------------------+
                                         |
                                         v
                     +---------------------------------------+
                     |       INDEPENDENT VERIFIER AGENT      |
                     +---------------------------------------+
                     | 1. Extract assertion pairs:           |
                     |    (Config X) <-[:TRIGGERED]- (Inc #88)|
                     | 2. Run deterministic Cypher check     |
                     |    against Neo4j AuraDB.              |
                     +---------------------------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                  (Edge Exists)                     (No Edge in Graph)
                       v                                   v
         +---------------------------+       +---------------------------+
         |     VERIFIED RESPONSE     |       |   ABSTENTION PROTOCOL     |
         |  Emit with full lineage,  |       |  Refuse to answer.        |
         |  SHA, and author context. |       |  State honestly that info |
         |                           |       |  is missing from history. |
         +---------------------------+       +---------------------------+
```

### 6.2 Grounding Metric & Abstention Logic
$$
\text{Confidence Signal} = \frac{|\text{Verified Graph Edges in Assertion}|}{|\text{Total Claims in Synthesized Answer}|}
$$
* If $\text{Confidence Signal} < 1.0$: The system rejects speculative sentences.
* If a question asks about code with zero connected PR or issue discussions:
  > *"Refusal: The graph contains the structural definition of `flag_gamma` in `src/net.c`, but no PR, commit discussion, or incident records the intent behind its value. Mnemo will not fabricate reasoning."*

---

## 7. Recommended Public Repositories for Demonstration

To satisfy the hackathon criteria (*"Pick any large public repository with a long and messy history"*):
1. **`redis/redis` (C):** Over 14 years of history, intricate design trade-offs, configuration flags with obscure rationale, and clear incident-driven decisions.
2. **`prometheus/prometheus` (Go):** Rich issue and PR history, complex retention/compaction tuning rules, and well-documented architectural shifts.
3. **`curl/curl` (C):** Massive, decade-long commit history where single configuration defaults have subtle, security-critical reasons.

---

## 8. Technology Stack & Key References

| Layer | Technology | Role |
|---|---|---|
| **Graph Database** | **Neo4j AuraDB** | Cloud-native property graph storing all historical and code entities. |
| **Graph Query Engine** | **Neo4j Cypher / Aura Agents** | Declarative graph queries, pathfinding, and GraphRAG retrieval patterns. |
| **Code AST Parsing** | **Tree-sitter** / **SCIP** | Deterministic syntax and symbol relationship extractor (non-AI). |
| **VCS Metadata** | **GitPython / PyGithub** | Ingestion of Git commit hunks, PR discussions, and issues. |
| **Agent Orchestration** | **LangGraph** | Multi-agent state machines for Contributor Sub-Agents and debate loops. |
| **Verification & Safety**| **Guardrails AI / RAGAS** | Grounding metrics, citation validation, and hallucination rejection. |
| **Visualization** | **Cytoscape.js / WebGL Force Graph** | Narrative graph explorer with interactive temporal slider. |

---

## 9. Phased Execution Roadmap

### Phase 1: Ingestion Pipeline & Schema Setup (Sprint Days 1–2)
- Deploy Neo4j AuraDB instance; establish constraints and indexes on `(:Commit {sha})`, `(:Function {id})`, `(:File {path})`.
- Build deterministic Git history extractor pulling commits, diff hunks, PR comments, and issues.
- Build Tree-sitter parser to extract files, functions, and config variables.

### Phase 2: Entity Resolution & Graph Linking (Sprint Days 3–4)
- Link Git diff hunk line ranges directly to parsed AST symbols.
- Unify developer identities into canonical `(:Contributor)` nodes.
- Ingest public repository dataset (e.g., target subsystem of `redis/redis`).

### Phase 3: Temporal Supersession & Contributor Sub-Agents (Sprint Days 5–6)
- Implement Cypher traversal to detect and mark superseded commits and decisions.
- Build Contributor Sub-Agent persona factory in LangGraph.
- Build reasoning agent that generates responses exclusively using graph traversal paths.

### Phase 4: Alignment, Verifier Gate & Evaluation (Sprint Days 7–8)
- Implement Independent Verifier to check every LLM claim against Neo4j relationships.
- Enforce strict refusal/abstention when graph traversal returns empty sets.
- Prepare demonstration queries comparing outdated static docs vs. Mnemo's temporal truth.

### Phase 5: Narrative Visualizer & Final Polish (Sprint Days 9–10)
- Build frontend visualization showing the code topology connected to human decisions.
- Add historical time-scrubbing slider to watch decisions evolve and expire.
- Rehearse judge demonstration showing honest failure on unrecorded intent.