# Mnemo · Repository Evidence Workspace & Knowledge Graph

> **Philosophy**: *History is evidence. AI is opt-in.*

Mnemo is a developer intelligence platform that transforms codebases and their Git history into a deterministic, interactive knowledge graph. It provides deep architectural mapping, provenance tracking, agentic contributor inspection, and grounded AI synthesis without relying on opaque black-box indexes.

---

## 1. System Overview

Modern repositories lose context over time—why a function was introduced, what pull request decided an architectural trade-off, or which contributor owns a specific subsystem. Mnemo solves this by treating Git history and repository checkout as ground-truth evidence.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             MNEMO WORKSPACE                                 │
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                   ▼
┌───────────────────────────────┐                   ┌───────────────────────────┐
│     DETERMINISTIC ENGINE      │                   │     AGENT ORCHESTRATOR    │
│  • AST & Symbol Parsing       │                   │  • Contributor Agents     │
│  • Git Tree & Diff Extraction │                   │  • Timeline Evidence      │
│  • In-Memory Knowledge Graph  │                   │  • Grounded Routing       │
│  • Optional Neo4j Sync        │                   │  • Multi-Provider LLMs    │
└───────────────┬───────────────┘                   └─────────────┬─────────────┘
                │                                                 │
                └─────────────────────────┬───────────────────────┘
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      INTERACTIVE WEB USER INTERFACE                         │
│  [Overview] [Evidence Chain] [Architecture] [Source] [Agents] [AI Chat]     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Modules & How They Function

### 2.1 Repository Ingestion (`mnemo/ingest.py` & `mnemo/analysis.py`)
- **Local & Remote Support**: Ingests checked-out directories or clones remote Git repositories.
- **Git Commit Scanning**: Reads commits, commit timestamps, SHAs, messages, and author identities.
- **Diff & Change Impact**: Computes per-commit file changes, additions, deletions, and touched paths.
- **Syntactic Parsing**: Extracts source symbols (functions, classes, configurations) and import statements (`IMPORTS`, `CALLS`).

### 2.2 Deterministic Knowledge Graph (`mnemo/graph.py` & `mnemo/neo4j.py`)
- Nodes in the graph represent concrete repository entities:
  - `Repository`: The root repository identity and configuration.
  - `Contributor`: Authors identified by username and email signatures.
  - `Commit`: Point-in-time state changes with diff metadata.
  - `PullRequest` & `Release`: GitHub delivery milestones and merged PR records.
  - `File`: Tracked source files and configs.
  - `Function` & `Class`: Indexed code symbols with start/end line coordinates.
  - `Decision`: Recorded intents, architectural notes, or commit rationales.
- Edges model relationships:
  - `AUTHORED`: `Contributor` &rarr; `Commit`
  - `MODIFIED`: `Commit` &rarr; `File`
  - `CONTAINS`: `File` &rarr; `Function` / `Class`
  - `IMPORTS`: `File` &rarr; `File`
  - `CALLS`: `Function` &rarr; `Function`
  - `SUPERSEDES`: `Decision` &rarr; `Decision`
- Optional Neo4j AuraDB sync allows persistent remote graph queries.

### 2.3 Agent Orchestration (`mnemo/agents.py`)
- **Contributor-Centric Agents**: Instead of a generic code assistant, Mnemo spawns specialized contributor agents for each active committer.
- **Scope & Evidence**: Each agent maintains a bounded context of commits authored, files touched, and architectural decisions made by that author.
- **Repository Orchestrator**: Coordinates user queries, discovers matching contributor agents, inspects relevant diffs, and synthesizes answers backed by line-level citations.

### 2.4 Multi-Provider AI Engine (`mnemo/ai.py`)
- Pluggable registry supporting **OpenRouter**, **Groq**, **NVIDIA NIM**, **Conduit**, **TokenHarbor**, and **Vercel AI**.
- Automatic key detection from `.env` or process environment.
- Deterministic fallback: If no API key is configured or the provider is unavailable, Mnemo continues to provide deterministic timeline and relationship evidence.

### 2.5 High-Performance Server (`mnemo/web.py`)
- Zero-dependency HTTP server built on Python's native `ThreadingHTTPServer`.
- Serves static assets, REST API endpoints (`/api/health`, `/api/inspect`, `/api/graph`, `/api/ai/room`, `/api/source`, `/api/neo4j/status`), and brand media.

---

## 3. Web Interface & User Features

The interface uses a **Light Theme** aesthetic centered on **Pastel Lavender** (`#7c3aed`/`#ede9fe`) and **Mint Green** (`#10b981`/`#ecfdf5`), full-width layout, and zero clutter.

### 3.1 Overview Tab
- **Repository Pulse**: Live counters for tracked files, indexed symbols, commits, contributors, pull requests, and merges.
- **Recent Activity**: Chronological list of latest commits with authors and messages.
- **Snapshot Coverage**: Breakdown of file types, languages, and dependencies.

### 3.2 Evidence Chain Tab
- **Provenance & Intent**: Traces why lines of code changed, linking commits to recorded decisions.
- **Interactive Pull Request & Commit Timeline**:
  - Horizontal timeline scrubber with slider and navigation controls.
  - Visual playhead, commit ticks, and PR state nodes.
  - Detailed commit card showing SHA, author, and timestamp.
  - Filterable list of commits and pull requests with styled badges (`commit`, `merged`, `open`, `closed`).

### 3.3 Architecture Tab
- **Interactive Relationship Graph**: SVG canvas supporting drag-to-pan and scroll-to-zoom.
- **Switchable Modes**:
  1. *Evidence Mode*: Contributor lanes &rarr; Commits &rarr; Touched Files &rarr; Decisions.
  2. *Code Graph*: Repository hub &rarr; Authors &rarr; Files &rarr; Symbol calls/imports.
  3. *Modules View*: Folder-level import density and module coupling.

### 3.4 Source Explorer Tab
- **Three-Column Workstation**:
  - **Left Rail**: Interactive File Tree with directory hierarchy and file type badges.
  - **Center Viewer**: Multi-tab code editor with line numbering, read-only protection, and active tab management.
  - **Right Rail**: Dedicated file commit timeline showing every commit that modified the selected file.
- **Diff Inspector**: Side-by-side Git diff viewer highlighting additions and deletions.
- **File Relations Graph**: Dedicated SVG graph showing functions, classes, and cross-file import connections.

### 3.5 Agents Tab
- **Agent Orchestrator View**: Minimalist overview of parallel contributor agents.
- **Orchestration Graph**: Visual diagram of the orchestrator dispatching parallel contributor agents to scan commit slices.
- **Contributor-to-File Code Graph**: Maps which contributors touched which files and commits.

### 3.6 AI Chat Room Tab
- **Interactive Conversational AI**:
  - User message bubbles with custom avatar and gradient styling.
  - Animated routing status pill (`Repo Orchestrator → routing query to parallel agents`).
  - Orchestrator synthesis card with bot avatar, summary body, and contributor agent citations.
  - Optional LLM paraphrase card when an external model is active.
- **Model Controls**: Provider dropdown and model picker showing clean, un-cluttered names.

### 3.7 Git Track & Connections Tabs
- **Git Track**: Comprehensive audit of branches, push events, release milestones, and commit frequency.
- **Connections**: Live health check and graph synchronization with Neo4j AuraDB.

---

## 4. Technology Stack

| Layer | Technology |
|---|---|
| **Backend Runtime** | Python 3.10+ |
| **HTTP Server** | Python Standard Library (`http.server.ThreadingHTTPServer`) |
| **Persistence** | In-memory Graph + Optional Neo4j AuraDB (Cypher Query API v2) |
| **Frontend Logic** | Vanilla ES6+ JavaScript (`app.js`, `source-workspace.js`, `code-graph.js`, `agents-view.js`, `ai-console.js`) |
| **Styling** | Vanilla CSS (`styles.css`, `ui-polish.css`, `dark.css`) |
| **Visualizations** | Native SVG Vector Graphs (Pan, Zoom, Dynamic Layouts) |
| **Typography** | Inter, system sans-serif, and UI monospace fonts |
| **AI Integration** | Direct HTTPS REST clients for OpenRouter, Groq, NVIDIA, Conduit, Vercel |

---

## 5. Running and Using Mnemo

### 5.1 Starting the Server
From the project root:
```bash
python -m mnemo serve --host 127.0.0.1 --port 8000
```
Open your browser to:
```
http://127.0.0.1:8000/
```

### 5.2 Typical User Workflow
1. **Inspect a Repository**:
   - On first load, enter `.` to inspect the current repository, or enter a local folder path / GitHub clone URL.
   - Click **Inspect repository**. Mnemo parses commits, files, and symbol dependencies into memory.
2. **Explore Architecture**:
   - Click the **Architecture** tab to view how components depend on one another.
3. **Trace Why Code Changed**:
   - Open **Evidence chain** or **Source** to inspect a specific file, see its commit history, and examine the recorded diffs.
4. **Ask the Repository**:
   - Open the **AI chat** tab and ask questions like:
     - *"What changed in the recent commits?"*
     - *"Who worked on the web server interface?"*
     - *"Which files are most coupled to the graph module?"*
   - The orchestrator will route evidence to contributor agents and present a cited synthesis.
