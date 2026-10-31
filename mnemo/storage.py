"""Local Graph-RAG storage and caching subsystem for Mnemo.

Saves repository artifacts locally on disk for every inspected repository
(e.g. pathwaycom/pathway -> ~/.cache/mnemo/storage/pathwaycom--pathway/):
- source/: Tracked source file manifest and content snapshots
- commits/: Git commits, authors, diffs, and push events
- graph/: Graph nodes, edges, architecture summary, and module topology
- rag/: Graph-RAG chunks, vector embeddings, and entity-chunk inverted index
- ai_chats/: Full history of all AI questions, graph context, RAG chunks, and answers
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _slugify_repo(repo: str) -> str:
    cleaned = repo.strip().replace("https://github.com/", "").replace("github.com/", "").removesuffix(".git").strip("/")
    parts = cleaned.split("/")
    if len(parts) >= 2:
        return f"{parts[0].lower()}--{parts[1].lower()}"
    return cleaned.replace("/", "--").lower() or "default-repository"


def _extract_repo_name(repo: str) -> str:
    cleaned = repo.strip().replace("https://github.com/", "").replace("github.com/", "").removesuffix(".git").strip("/")
    if "--" in cleaned and "/" not in cleaned:
        return cleaned.split("--")[-1].lower()
    parts = [p for p in cleaned.split("/") if p]
    if parts:
        return parts[-1].lower()
    return cleaned.lower() or "repository"


def get_default_storage_root() -> Path:
    custom = os.environ.get("MNEMO_STORAGE_DIR")
    if custom:
        return Path(custom).expanduser()
    default_path = Path(__file__).resolve().parent.parent / "storage"
    if os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        tmp_path = Path("/tmp/mnemo/storage")
        try:
            tmp_path.mkdir(parents=True, exist_ok=True)
            if default_path.is_dir() and not (tmp_path / "attendx").exists() and (default_path / "attendx").exists():
                shutil.copytree(default_path / "attendx", tmp_path / "attendx", dirs_exist_ok=True)
            return tmp_path
        except Exception:
            pass
    return default_path


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _tokenize(text: str) -> list[str]:
    # Extract code identifiers and word tokens (lowercase, alphanumeric)
    words = re.findall(r"[A-Za-z0-9_]{2,}", text.lower())
    stop_words = {
        "the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
        "then", "also", "have", "has", "had", "not", "but", "what", "which",
        "self", "def", "return", "class", "function", "const", "let", "var", "import",
    }
    return [w for w in words if w not in stop_words]


class RepositoryStorage:
    """Manages persistent Graph-RAG storage for a single repository."""

    def __init__(self, repo_identifier: str, base_root: str | Path | None = None) -> None:
        self.repo_name = _extract_repo_name(repo_identifier)
        self.repo_slug = _slugify_repo(repo_identifier)
        storage_base = Path(base_root).expanduser() if base_root else get_default_storage_root()

        # Primary storage folder named by the Repo Name inside the MNEMO storage folder
        # (Check if a slug directory already exists to maintain continuity)
        slug_dir = storage_base / self.repo_slug
        name_dir = storage_base / self.repo_name
        if slug_dir.exists() and not name_dir.exists():
            self.root = name_dir
            # We will populate name_dir and keep slug_dir synced
        else:
            self.root = name_dir

        self.storage_base = storage_base

        # Subdirectories
        self.files_dir = self.root / "files"
        self.source_dir = self.root / "source"
        self.commits_dir = self.root / "commits"
        self.graph_dir = self.root / "graph"
        self.rag_dir = self.root / "rag"
        self.ai_chats_dir = self.root / "ai_chats"

        # Key file paths
        self.manifest_file = self.source_dir / "manifest.json"
        self.commits_file = self.commits_dir / "commits.json"
        self.pushes_file = self.commits_dir / "pushes.json"
        self.pull_requests_file = self.commits_dir / "pull_requests.json"
        self.branches_file = self.commits_dir / "branches.json"
        self.contributors_file = self.commits_dir / "contributors.json"
        self.graph_file = self.graph_dir / "graph.json"
        self.architecture_file = self.graph_dir / "architecture.json"
        self.modules_file = self.graph_dir / "modules.json"
        self.chunks_file = self.rag_dir / "chunks.json"
        self.embeddings_file = self.rag_dir / "embeddings.json"
        self.rag_index_file = self.rag_dir / "graph_rag_index.json"
        self.conversations_file = self.ai_chats_dir / "conversations.json"
        self.metadata_file = self.root / "metadata.json"
        self.inspection_file = self.root / "inspection.json"

        # The Main Unified Graph-RAG Embeddings File
        self.main_graph_rag_file = self.root / "graph_rag_embeddings.json"
        self.root_embeddings_file = self.root / "embeddings.json"

    def ensure_directories(self) -> None:
        """Create all required directory structures."""
        for directory in (
            self.root,
            self.files_dir,
            self.source_dir,
            self.commits_dir,
            self.graph_dir,
            self.rag_dir,
            self.ai_chats_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def is_cached(self) -> bool:
        """Check if local storage contains an existing graph and RAG index."""
        if self.graph_file.exists() and self.chunks_file.exists():
            return True
        if self.repo_slug != self.repo_name:
            alt_root = self.storage_base / self.repo_slug
            if (alt_root / "graph" / "graph.json").exists() and (alt_root / "rag" / "chunks.json").exists():
                return True
        return False

    def status(self) -> dict[str, Any]:
        """Return a rich status summary of all stored artifacts."""
        chunk_count = 0
        embedding_count = 0
        if self.chunks_file.exists():
            try:
                data = json.loads(self.chunks_file.read_text(encoding="utf-8"))
                chunk_count = len(data) if isinstance(data, list) else 0
            except Exception:
                pass

        if self.embeddings_file.exists():
            try:
                data = json.loads(self.embeddings_file.read_text(encoding="utf-8"))
                embedding_count = len(data) if isinstance(data, list) else 0
            except Exception:
                pass

        conv_count = 0
        if self.conversations_file.exists():
            try:
                data = json.loads(self.conversations_file.read_text(encoding="utf-8"))
                conv_count = len(data) if isinstance(data, list) else 0
            except Exception:
                pass

        graph_nodes = 0
        graph_edges = 0
        if self.graph_file.exists():
            try:
                data = json.loads(self.graph_file.read_text(encoding="utf-8"))
                graph_nodes = len(data.get("nodes", []))
                graph_edges = len(data.get("edges", []))
            except Exception:
                pass

        copied_files = 0
        if self.files_dir.exists():
            try:
                copied_files = sum(1 for _ in self.files_dir.rglob("*") if _.is_file())
            except Exception:
                pass

        return {
            "repo_name": self.repo_name,
            "repo_slug": self.repo_slug,
            "storage_path": str(self.root.resolve()),
            "files_path": str(self.files_dir.resolve()),
            "cached": self.is_cached(),
            "counts": {
                "source_files": copied_files,
                "graph_nodes": graph_nodes,
                "graph_edges": graph_edges,
                "rag_chunks": chunk_count,
                "embeddings": embedding_count,
                "ai_conversations": conv_count,
            },
            "files": {
                "manifest": self.manifest_file.exists(),
                "repo_files": self.files_dir.exists() and copied_files > 0,
                "commits": self.commits_file.exists(),
                "pushes": self.pushes_file.exists(),
                "pull_requests": self.pull_requests_file.exists(),
                "branches": self.branches_file.exists(),
                "contributors": self.contributors_file.exists(),
                "graph": self.graph_file.exists(),
                "architecture": self.architecture_file.exists(),
                "modules": self.modules_file.exists(),
                "chunks": self.chunks_file.exists(),
                "embeddings": self.embeddings_file.exists(),
                "rag_index": self.rag_index_file.exists(),
                "conversations": self.conversations_file.exists(),
                "metadata": self.metadata_file.exists(),
                "inspection": self.inspection_file.exists(),
                "graph_rag_embeddings": self.main_graph_rag_file.exists(),
            },
        }

    def save_all(
        self,
        repository_info: dict[str, Any] | None,
        local_path: str | Path | None,
        graph: dict[str, Any] | None,
        inspection_metadata: dict[str, Any] | None = None,
        analysis: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Save repo files, commits, pushes, graph, RAG chunks, embeddings, and main Graph-RAG master file."""
        self.ensure_directories()
        local_dir = Path(local_path).resolve() if local_path else None
        inspection = inspection_metadata or {}
        analysis_data = analysis or {}

        # 1. Copy repository files directly into self.files_dir
        copied_files_count = self._copy_repo_files(local_dir)

        # 2. Source files manifest
        manifest = self._save_source_manifest(local_dir, graph)

        # 3. Commits, pushes, pull requests, branches & contributors
        self._save_commits_and_pushes(inspection, graph)

        # 4. Graph, architecture & modules
        if graph:
            self.graph_file.write_text(json.dumps(graph, indent=2), encoding="utf-8")
        if analysis_data:
            arch = analysis_data.get("architecture") or analysis_data
            self.architecture_file.write_text(json.dumps(arch, indent=2), encoding="utf-8")
            mod_rel = analysis_data.get("module_relationships") or {}
            self.modules_file.write_text(json.dumps(mod_rel, indent=2), encoding="utf-8")

        # 5. Full Inspection Record
        if inspection:
            try:
                self.inspection_file.write_text(
                    json.dumps(inspection, indent=2, default=str),
                    encoding="utf-8",
                )
            except Exception:
                pass

        # 6. Generate RAG Chunks, Embeddings, and Inverted Index
        chunks = self._generate_chunks(local_dir, graph, manifest)
        self.chunks_file.write_text(json.dumps(chunks, indent=2), encoding="utf-8")

        embeddings = self._generate_embeddings(chunks)
        self.embeddings_file.write_text(json.dumps(embeddings, indent=2), encoding="utf-8")

        rag_index = self._generate_rag_index(chunks, graph)
        self.rag_index_file.write_text(json.dumps(rag_index, indent=2), encoding="utf-8")

        # 7. Generate THE MAIN FILE having all embeddings and proper Graph RAG
        self._save_master_graph_rag_file(
            repository_info=repository_info,
            graph=graph,
            analysis_data=analysis_data,
            chunks=chunks,
            embeddings=embeddings,
            rag_index=rag_index,
            manifest=manifest,
        )

        # 8. Metadata
        meta = {
            "repository": repository_info or {"name": self.repo_name, "slug": self.repo_slug},
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "storage_path": str(self.root.resolve()),
            "files_path": str(self.files_dir.resolve()),
            "stats": {
                "copied_source_files": copied_files_count,
                "manifest_files": len(manifest),
                "graph_nodes": len(graph.get("nodes", [])) if graph else 0,
                "graph_edges": len(graph.get("edges", [])) if graph else 0,
                "chunks": len(chunks),
                "embeddings": len(embeddings),
            },
        }
        self.metadata_file.write_text(json.dumps(meta, indent=2), encoding="utf-8")

        # Sync slug directory if different
        self._sync_slug_alias()

        return self.status()

    def _sync_slug_alias(self) -> None:
        """Keep the slug directory in sync with the repo_name directory for compatibility."""
        if self.repo_slug and self.repo_slug != self.repo_name:
            slug_root = self.storage_base / self.repo_slug
            if slug_root != self.root:
                try:
                    for subdir in ("graph", "rag", "source", "commits", "ai_chats"):
                        src_sub = self.root / subdir
                        if src_sub.exists():
                            dst_sub = slug_root / subdir
                            dst_sub.mkdir(parents=True, exist_ok=True)
                            for f in src_sub.glob("*.json"):
                                shutil.copy2(f, dst_sub / f.name)
                    for mf in ("metadata.json", "inspection.json", "graph_rag_embeddings.json", "embeddings.json"):
                        if (self.root / mf).exists():
                            slug_root.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(self.root / mf, slug_root / mf)
                except Exception:
                    pass

    def _copy_repo_files(self, local_dir: Path | None) -> int:
        """Copy actual repository source files into files/, omitting VCS and heavy caches."""
        if not local_dir or not local_dir.is_dir():
            return 0
        self.files_dir.mkdir(parents=True, exist_ok=True)
        ignored_dirs = {
            ".git", ".svn", ".hg", "node_modules", "__pycache__", ".pytest_cache",
            ".mypy_cache", ".tox", ".venv", "venv", "env", ".idea", ".vscode",
            "dist", "build", ".next", ".nuxt", ".cache", "target", "coverage",
        }
        ignored_extensions = {
            ".pyc", ".pyo", ".pyd", ".exe", ".dll", ".so", ".dylib", ".bin",
            ".zip", ".tar", ".gz", ".7z", ".rar", ".iso", ".apk", ".jar",
            ".whl", ".o", ".obj", ".class",
        }
        max_file_size = 10 * 1024 * 1024  # 10MB per file
        copied_count = 0

        for root, dirs, files in os.walk(local_dir):
            dirs[:] = [d for d in dirs if d not in ignored_dirs and not d.startswith(".git")]
            try:
                rel_root = Path(root).relative_to(local_dir)
            except ValueError:
                continue
            dest_root = self.files_dir / rel_root
            dest_root.mkdir(parents=True, exist_ok=True)

            for filename in files:
                ext = Path(filename).suffix.lower()
                if ext in ignored_extensions:
                    continue
                src_file = Path(root) / filename
                try:
                    if src_file.is_file() and not src_file.is_symlink():
                        if src_file.stat().st_size <= max_file_size:
                            shutil.copy2(src_file, dest_root / filename)
                            copied_count += 1
                except (OSError, PermissionError):
                    continue

        return copied_count

    def _save_master_graph_rag_file(
        self,
        repository_info: dict[str, Any] | None,
        graph: dict[str, Any] | None,
        analysis_data: dict[str, Any] | None,
        chunks: list[dict[str, Any]],
        embeddings: list[dict[str, Any]],
        rag_index: dict[str, Any],
        manifest: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Construct and save the single unified Graph-RAG embeddings master file for AI models."""
        embeddings_by_id = {e["chunk_id"]: e for e in embeddings}

        # Merge vector and keywords directly into each chunk for instant one-lookup AI Graph-RAG
        enriched_chunks = []
        for chunk in chunks:
            cid = chunk["chunk_id"]
            emb = embeddings_by_id.get(cid, {})
            enriched_chunk = dict(chunk)
            enriched_chunk["vector"] = emb.get("vector", {})
            enriched_chunk["keywords"] = emb.get("keywords", [])
            enriched_chunk["dimension"] = emb.get("dimension", 0)
            if "file_path" in chunk and chunk["file_path"] != "git_history":
                enriched_chunk["relative_source_path"] = f"files/{chunk['file_path']}"
            enriched_chunks.append(enriched_chunk)

        master_doc = {
            "repository": repository_info or {"name": self.repo_name, "slug": self.repo_slug},
            "schema": "mnemo-graph-rag-v2",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "storage_paths": {
                "root": str(self.root.resolve()),
                "files": str(self.files_dir.resolve()),
                "graph_rag_file": str(self.main_graph_rag_file.resolve()),
            },
            "stats": {
                "files_count": len(manifest),
                "chunks_count": len(chunks),
                "embeddings_count": len(embeddings),
                "graph_nodes_count": len(graph.get("nodes", [])) if graph else 0,
                "graph_edges_count": len(graph.get("edges", [])) if graph else 0,
            },
            "graph": {
                "nodes": graph.get("nodes", []) if graph else [],
                "edges": graph.get("edges", []) if graph else [],
                "architecture": analysis_data.get("architecture") if analysis_data else {},
                "modules": analysis_data.get("module_relationships") if analysis_data else {},
            },
            "chunks": enriched_chunks,
            "inverted_index": rag_index,
            "retrieval_metadata": {
                "embedding_dimension": 24,
                "algorithm": "normalized_tf_idf_cosine_similarity_with_graph_prior",
                "instructions_for_ai": (
                    "Load this master file to execute comprehensive Graph-RAG. "
                    "Use 'graph' to navigate dependencies, callers/callees, and architecture, "
                    "use 'chunks' for code snippets with precomputed embedding vectors, "
                    "and use 'inverted_index' for fast node-to-chunk and symbol-to-chunk lookups. "
                    "Actual repository files are located in the adjacent 'files/' directory."
                ),
            },
        }

        content = json.dumps(master_doc, indent=2)
        self.main_graph_rag_file.write_text(content, encoding="utf-8")
        self.root_embeddings_file.write_text(content, encoding="utf-8")
        return master_doc

    def _save_source_manifest(
        self,
        local_dir: Path | None,
        graph: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        manifest: list[dict[str, Any]] = []
        file_nodes = [
            node for node in (graph.get("nodes", []) if graph else [])
            if "File" in node.get("labels", [])
        ]

        if local_dir and local_dir.is_dir():
            for node in file_nodes:
                rel_path = node.get("path") or node.get("file_path") or ""
                if not rel_path:
                    continue
                full_path = local_dir / rel_path
                file_info = {
                    "path": rel_path,
                    "language": node.get("language", "unknown"),
                    "lines": node.get("lines", 0),
                    "size_bytes": 0,
                    "exists": False,
                }
                if full_path.exists() and full_path.is_file():
                    try:
                        stat = full_path.stat()
                        file_info["size_bytes"] = stat.st_size
                        file_info["exists"] = True
                    except OSError:
                        pass
                manifest.append(file_info)
        elif file_nodes:
            for node in file_nodes:
                manifest.append({
                    "path": node.get("path") or node.get("id", ""),
                    "language": node.get("language", "unknown"),
                    "lines": node.get("lines", 0),
                    "size_bytes": 0,
                    "exists": False,
                })

        self.manifest_file.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return manifest

    def _save_commits_and_pushes(
        self,
        inspection: dict[str, Any],
        graph: dict[str, Any] | None,
    ) -> None:
        github_data = inspection.get("github") or {}
        commits = github_data.get("commits") or []
        pushes = [event for event in github_data.get("events", []) if event.get("type") == "PushEvent"]
        branches = github_data.get("branches") or []

        if not commits and graph:
            # Fallback to commits stored in graph nodes
            commit_nodes = [
                node for node in graph.get("nodes", [])
                if "Commit" in node.get("labels", [])
            ]
            commits = [
                {
                    "sha": node.get("sha") or node.get("id", "").removeprefix("commit:"),
                    "message": node.get("message", ""),
                    "timestamp": node.get("timestamp", ""),
                    "author": node.get("author_email") or node.get("author", ""),
                }
                for node in commit_nodes
            ]

        self.commits_file.write_text(json.dumps(commits, indent=2), encoding="utf-8")
        self.pushes_file.write_text(
            json.dumps({"pushes": pushes, "branches": branches}, indent=2),
            encoding="utf-8",
        )
        pull_requests = github_data.get("pull_requests") or []
        self.pull_requests_file.write_text(json.dumps(pull_requests, indent=2), encoding="utf-8")
        self.branches_file.write_text(json.dumps(branches, indent=2), encoding="utf-8")
        contributors = github_data.get("contributors") or []
        self.contributors_file.write_text(json.dumps(contributors, indent=2), encoding="utf-8")

    def _generate_chunks(
        self,
        local_dir: Path | None,
        graph: dict[str, Any] | None,
        manifest: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        chunks: list[dict[str, Any]] = []
        chunk_idx = 1

        # 1. Chunks from Functions / Classes in the Graph
        symbol_nodes = [
            node for node in (graph.get("nodes", []) if graph else [])
            if any(l in node.get("labels", []) for l in ("Function", "Class", "Module", "Decision"))
        ]
        for node in symbol_nodes:
            lbl = next((l for l in ("Function", "Class", "Module", "Decision") if l in node.get("labels", [])), "Symbol")
            path = node.get("path") or node.get("file_path") or ""
            name = node.get("name") or node.get("id", "")
            start = node.get("start_line", 1)
            end = node.get("end_line", start)
            text_desc = f"{lbl} {name} declared in {path} (lines {start}-{end})."
            if node.get("docstring"):
                text_desc += f"\nDocstring: {node['docstring']}"
            if node.get("summary"):
                text_desc += f"\nSummary: {node['summary']}"

            chunks.append({
                "chunk_id": f"chunk_sym_{chunk_idx:05d}",
                "file_path": path,
                "start_line": start,
                "end_line": end,
                "chunk_type": "symbol",
                "symbol": name,
                "symbol_type": lbl,
                "text": text_desc,
                "token_count": _estimate_tokens(text_desc),
                "graph_node_ids": [node.get("id")],
            })
            chunk_idx += 1

        # 2. Chunks from actual source code files
        if local_dir and local_dir.is_dir():
            for item in manifest[:120]:  # Bound to top 120 files for responsiveness
                rel_path = item.get("path", "")
                if not rel_path:
                    continue
                full_path = local_dir / rel_path
                if not (full_path.exists() and full_path.is_file()):
                    continue
                try:
                    content = full_path.read_text(encoding="utf-8", errors="replace")
                except Exception:
                    continue

                lines = content.splitlines()
                if not lines:
                    continue

                window_size = 60
                overlap = 15
                step = window_size - overlap
                for start_line_0 in range(0, len(lines), step):
                    chunk_lines = lines[start_line_0 : start_line_0 + window_size]
                    chunk_text = "\n".join(chunk_lines).strip()
                    if not chunk_text:
                        continue
                    chunks.append({
                        "chunk_id": f"chunk_code_{chunk_idx:05d}",
                        "file_path": rel_path,
                        "start_line": start_line_0 + 1,
                        "end_line": min(len(lines), start_line_0 + window_size),
                        "chunk_type": "code",
                        "symbol": None,
                        "symbol_type": None,
                        "text": chunk_text[:2000],
                        "token_count": _estimate_tokens(chunk_text[:2000]),
                        "graph_node_ids": [f"file:{rel_path}"],
                    })
                    chunk_idx += 1

        # 3. Chunks from Commit Intent & Decisions
        if graph:
            commit_nodes = [
                node for node in graph.get("nodes", [])
                if "Commit" in node.get("labels", [])
            ]
            for commit in commit_nodes[:60]:
                msg = commit.get("message", "")
                sha = commit.get("sha") or commit.get("id", "")
                if not msg:
                    continue
                chunk_text = f"Commit {sha[:8]}: {msg}\nAuthor: {commit.get('author_email', '')}\nTimestamp: {commit.get('timestamp', '')}"
                chunks.append({
                    "chunk_id": f"chunk_intent_{chunk_idx:05d}",
                    "file_path": "git_history",
                    "start_line": 1,
                    "end_line": 1,
                    "chunk_type": "intent",
                    "symbol": sha[:8],
                    "symbol_type": "Commit",
                    "text": chunk_text,
                    "token_count": _estimate_tokens(chunk_text),
                    "graph_node_ids": [commit.get("id")],
                })
                chunk_idx += 1

        return chunks

    def _generate_embeddings(self, chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Compute normalized token frequency embeddings for each chunk."""
        # Step 1: Document frequencies
        df: Counter[str] = Counter()
        tokenized_chunks = []
        for chunk in chunks:
            tokens = _tokenize(chunk.get("text", ""))
            tokenized_chunks.append(tokens)
            df.update(set(tokens))

        total_docs = max(1, len(chunks))
        embeddings: list[dict[str, Any]] = []

        for idx, chunk in enumerate(chunks):
            tokens = tokenized_chunks[idx]
            if not tokens:
                embeddings.append({
                    "chunk_id": chunk["chunk_id"],
                    "vector": {},
                    "keywords": [],
                    "dimension": 0,
                })
                continue

            tf = Counter(tokens)
            # Calculate TF-IDF weights
            weights: dict[str, float] = {}
            for token, count in tf.items():
                idf = math.log((total_docs + 1) / (df[token] + 1)) + 1.0
                weights[token] = round(count * idf, 4)

            # Keep top 24 features
            top_features = sorted(weights.items(), key=lambda kv: kv[1], reverse=True)[:24]
            # Normalize vector
            norm = math.sqrt(sum(v * v for _, v in top_features)) or 1.0
            norm_vector = {k: round(v / norm, 4) for k, v in top_features}

            embeddings.append({
                "chunk_id": chunk["chunk_id"],
                "vector": norm_vector,
                "keywords": [k for k, _ in top_features[:8]],
                "dimension": len(norm_vector),
            })

        return embeddings

    def _generate_rag_index(
        self,
        chunks: list[dict[str, Any]],
        graph: dict[str, Any] | None,
    ) -> dict[str, Any]:
        """Construct inverted index mapping graph nodes, symbols, and keywords to chunk IDs."""
        node_to_chunks: dict[str, list[str]] = defaultdict(list)
        symbol_to_chunks: dict[str, list[str]] = defaultdict(list)
        file_to_chunks: dict[str, list[str]] = defaultdict(list)
        token_to_chunks: dict[str, list[str]] = defaultdict(list)

        for chunk in chunks:
            cid = chunk["chunk_id"]
            for nid in chunk.get("graph_node_ids", []):
                node_to_chunks[nid].append(cid)
            if chunk.get("symbol"):
                symbol_to_chunks[chunk["symbol"].lower()].append(cid)
            if chunk.get("file_path"):
                file_to_chunks[chunk["file_path"]].append(cid)

            # Index top tokens
            for token in _tokenize(chunk.get("text", ""))[:15]:
                token_to_chunks[token].append(cid)

        # De-duplicate lists
        return {
            "node_to_chunks": {k: sorted(set(v)) for k, v in node_to_chunks.items()},
            "symbol_to_chunks": {k: sorted(set(v)) for k, v in symbol_to_chunks.items()},
            "file_to_chunks": {k: sorted(set(v)) for k, v in file_to_chunks.items()},
            "token_to_chunks": {k: sorted(set(v))[:100] for k, v in token_to_chunks.items()},
            "chunk_count": len(chunks),
        }

    def save_ai_chat(
        self,
        question: str,
        answer: str,
        *,
        provider: str | None = None,
        model: str | None = None,
        retrieved_nodes: list[str] | None = None,
        retrieved_chunks: list[dict[str, Any]] | None = None,
        confidence: float | None = None,
        status: str = "ok",
    ) -> dict[str, Any]:
        """Persist an AI interaction in conversations.json."""
        self.ensure_directories()
        conversations: list[dict[str, Any]] = []
        if self.conversations_file.exists():
            try:
                conversations = json.loads(self.conversations_file.read_text(encoding="utf-8"))
            except Exception:
                conversations = []

        entry = {
            "id": f"chat_{len(conversations) + 1:04d}_{hashlib.md5(question.encode()).hexdigest()[:8]}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "question": question,
            "provider": provider or "auto",
            "model": model or "auto",
            "answer": answer,
            "confidence": confidence,
            "status": status,
            "retrieved_nodes": retrieved_nodes or [],
            "retrieved_chunks": (retrieved_chunks or [])[:5],
        }
        conversations.append(entry)
        self.conversations_file.write_text(json.dumps(conversations, indent=2), encoding="utf-8")
        return entry

    def get_conversations(self) -> list[dict[str, Any]]:
        """Return all persisted chat history for this repository."""
        if not self.conversations_file.exists():
            return []
        try:
            return json.loads(self.conversations_file.read_text(encoding="utf-8"))
        except Exception:
            return []

    def retrieve_rag_chunks(
        self,
        query: str,
        graph_node_ids: list[str] | None = None,
        top_k: int = 5,
    ) -> list[dict[str, Any]]:
        """Hybrid Graph-RAG retrieval: combines graph-linked chunks and token overlap."""
        if not self.chunks_file.exists() or not self.rag_index_file.exists():
            return []

        try:
            chunks = json.loads(self.chunks_file.read_text(encoding="utf-8"))
            by_id = {c["chunk_id"]: c for c in chunks}
            index = json.loads(self.rag_index_file.read_text(encoding="utf-8"))
        except Exception:
            return []

        scores: Counter[str] = Counter()

        # 1. Boost chunks directly linked to graph nodes
        node_map = index.get("node_to_chunks", {})
        for nid in (graph_node_ids or []):
            for cid in node_map.get(nid, []):
                scores[cid] += 3.0

        # 2. Boost chunks matching symbols
        sym_map = index.get("symbol_to_chunks", {})
        query_tokens = _tokenize(query)
        for token in query_tokens:
            for cid in sym_map.get(token, []):
                scores[cid] += 2.5

        # 3. Boost chunks matching token inverted index
        token_map = index.get("token_to_chunks", {})
        for token in query_tokens:
            for cid in token_map.get(token, []):
                scores[cid] += 1.0

        binary_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".tar", ".gz", ".bin", ".exe", ".so", ".dll", ".dylib", ".woff", ".woff2", ".ttf", ".eot", ".jar", ".class", ".apk"}
        results = []
        for cid, _ in scores.most_common(max(top_k * 3, 20)):
            if cid in by_id:
                chunk = by_id[cid]
                ext = Path(str(chunk.get("file_path", ""))).suffix.lower()
                if ext not in binary_exts:
                    results.append(chunk)
                if len(results) >= top_k:
                    break
        return results

    def save_ai_chat(
        self,
        question: str,
        answer: str,
        provider: str | None = None,
        model: str | None = None,
        retrieved_nodes: list[str] | None = None,
        retrieved_chunks: list[dict[str, Any]] | None = None,
        confidence: float | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Save a question/answer interaction and its RAG context to conversations.json."""
        self.ensure_directories()
        conversations = self.get_conversations()

        import uuid
        chat_entry = {
            "id": f"chat_{uuid.uuid4().hex[:12]}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "question": question,
            "answer": answer,
            "provider": provider,
            "model": model,
            "confidence": confidence,
            "retrieved_nodes": retrieved_nodes or [],
            "retrieved_chunks_count": len(retrieved_chunks or []),
            "retrieved_chunks": retrieved_chunks or [],
            **(extra or {}),
        }
        conversations.append(chat_entry)

        try:
            self.conversations_file.write_text(
                json.dumps(conversations, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except Exception:
            pass

        blob_client = VercelBlobStorage()
        if blob_client.configured:
            def _sync_cloud() -> None:
                try:
                    remote_path = f"repositories/{self.repo_name}/ai_chats/conversations.json"
                    blob_client.upload_bytes(
                        remote_path,
                        self.conversations_file.read_bytes(),
                        "application/json",
                    )
                except Exception:
                    pass

            import threading
            threading.Thread(target=_sync_cloud, daemon=True).start()

        return chat_entry

    def get_conversations(self) -> list[dict[str, Any]]:
        """Retrieve all saved AI conversations for this repository."""
        if not self.conversations_file.exists():
            return []
        try:
            data = json.loads(self.conversations_file.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return data
            return []
        except Exception:
            return []

    def clear_conversations(self) -> None:
        """Clear all conversation history for this repository."""
        self.ensure_directories()
        try:
            self.conversations_file.write_text("[]", encoding="utf-8")
        except Exception:
            pass

    def load_all(self) -> dict[str, Any]:
        """Load all stored repository data (graph, inspection, metadata, manifest)."""
        graph = None
        if self.graph_file.exists():
            try:
                graph = json.loads(self.graph_file.read_text(encoding="utf-8"))
            except Exception:
                pass
        elif (self.root / "graph.json").exists():
            try:
                graph = json.loads((self.root / "graph.json").read_text(encoding="utf-8"))
            except Exception:
                pass
        elif self.main_graph_rag_file.exists():
            try:
                master = json.loads(self.main_graph_rag_file.read_text(encoding="utf-8"))
                graph = master.get("graph")
            except Exception:
                pass

        inspection = None
        if self.inspection_file.exists():
            try:
                inspection = json.loads(self.inspection_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        metadata = {}
        if self.metadata_file.exists():
            try:
                metadata = json.loads(self.metadata_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        commits = []
        if self.commits_file.exists():
            try:
                commits = json.loads(self.commits_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        contributors = []
        if self.contributors_file.exists():
            try:
                contributors = json.loads(self.contributors_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        prs = []
        if self.pull_requests_file.exists():
            try:
                prs = json.loads(self.pull_requests_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        arch = {}
        if self.architecture_file.exists():
            try:
                arch = json.loads(self.architecture_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        modules = {}
        if self.modules_file.exists():
            try:
                modules = json.loads(self.modules_file.read_text(encoding="utf-8"))
            except Exception:
                pass

        if not inspection and graph:
            repo_name = metadata.get("repository", {}).get("name") or self.repo_name
            inspection = {
                "repository": {
                    "name": repo_name,
                    "url": f"https://github.com/{repo_name.replace('--', '/')}" if "--" in repo_name else "",
                    "default_branch": "main",
                },
                "github": {
                    "commits": commits,
                    "contributors": contributors,
                    "pull_requests": prs,
                    "contributor_count": len(contributors),
                    "coverage": {
                        "commits_count": len(commits),
                        "contributors_count": len(contributors),
                        "prs_count": len(prs),
                    },
                },
                "analysis": {
                    "architecture": arch,
                    "module_relationships": modules,
                },
                "freshness": {
                    "inspected_at": metadata.get("saved_at", datetime.now(timezone.utc).isoformat()),
                    "github_api_authenticated": False,
                    "checkout_refreshed": True,
                },
            }

        return {
            "graph": graph,
            "inspection": inspection,
            "metadata": metadata,
            "files_dir": self.files_dir if self.files_dir.exists() else None,
            "root": self.root,
        }


def list_stored_repositories(base_root: str | Path | None = None) -> list[dict[str, Any]]:
    """Scan the persistent storage folder and list all available repository snapshots."""
    storage_base = Path(base_root).expanduser() if base_root else get_default_storage_root()
    if not storage_base.exists():
        return []

    repos: list[dict[str, Any]] = []
    seen: set[str] = set()

    for entry in sorted(storage_base.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not entry.is_dir() or entry.name.startswith("tmp"):
            continue

        has_graph = (entry / "graph" / "graph.json").exists() or (entry / "graph.json").exists() or (entry / "graph_rag_embeddings.json").exists()
        if not has_graph:
            continue

        meta = {}
        if (entry / "metadata.json").exists():
            try:
                meta = json.loads((entry / "metadata.json").read_text(encoding="utf-8"))
            except Exception:
                pass

        stats = meta.get("stats", {})
        repo_info = meta.get("repository", {})
        raw_name = repo_info.get("name") or entry.name

        norm_key = raw_name.split("--")[-1].lower()
        if norm_key in seen:
            continue
        seen.add(norm_key)

        commits_count = 0
        if (entry / "commits" / "commits.json").exists():
            try:
                c_data = json.loads((entry / "commits" / "commits.json").read_text(encoding="utf-8"))
                commits_count = len(c_data) if isinstance(c_data, list) else 0
            except Exception:
                pass

        has_rag = (entry / "graph_rag_embeddings.json").exists() or (entry / "rag" / "embeddings.json").exists()
        files_count = stats.get("copied_source_files") or stats.get("manifest_files")
        if not files_count and (entry / "files").exists():
            files_count = len([f for f in (entry / "files").rglob("*") if f.is_file()])

        display_name = raw_name.replace("--", "/") if "--" in raw_name else raw_name

        repos.append({
            "name": raw_name,
            "folder": entry.name,
            "display_name": display_name,
            "path": str(entry),
            "files_count": files_count or 0,
            "commits_count": commits_count or stats.get("commits", 0),
            "nodes_count": stats.get("graph_nodes", 0),
            "chunks_count": stats.get("chunks", 0),
            "embeddings_count": stats.get("embeddings", 0),
            "saved_at": meta.get("saved_at") or datetime.fromtimestamp(entry.stat().st_mtime, tz=timezone.utc).isoformat(),
            "has_rag": has_rag,
            "has_files": (entry / "files").exists(),
        })

    return repos


class VercelBlobStorage:
    """Manages remote repository persistence using Vercel Blob Storage."""

    def __init__(self, token: str | None = None) -> None:
        self.token = token or os.environ.get("BLOB_READ_WRITE_TOKEN", "")
        self.store_id = self._extract_store_id(self.token)

    @staticmethod
    def _extract_store_id(token: str) -> str:
        if not token:
            return ""
        parts = token.split("_")
        if len(parts) >= 4:
            return parts[3]
        return ""

    @property
    def configured(self) -> bool:
        return bool(self.token)

    def upload_bytes(self, pathname: str, data: bytes, content_type: str = "application/json") -> dict[str, Any]:
        if not self.configured:
            raise RuntimeError("BLOB_READ_WRITE_TOKEN is not configured.")
        import urllib.request
        pathname = pathname.lstrip("/")
        url = f"https://blob.vercel-storage.com/{pathname}"
        headers = {
            "authorization": f"Bearer {self.token}",
            "x-api-version": "7",
            "x-vercel-blob-access": "private",
            "content-type": content_type,
        }
        if self.store_id:
            headers["x-vercel-blob-store-id"] = self.store_id
        req = urllib.request.Request(url, data=data, headers=headers, method="PUT")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def list_blobs(self, prefix: str = "") -> list[dict[str, Any]]:
        if not self.configured:
            return []
        import urllib.request
        from urllib.parse import urlencode
        params = {}
        if prefix:
            params["prefix"] = prefix
        query = f"?{urlencode(params)}" if params else ""
        url = f"https://blob.vercel-storage.com{query}"
        headers = {
            "authorization": f"Bearer {self.token}",
            "x-api-version": "7",
        }
        if self.store_id:
            headers["x-vercel-blob-store-id"] = self.store_id
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("blobs", [])

    def download_bytes(self, download_url: str) -> bytes:
        if not self.configured:
            raise RuntimeError("BLOB_READ_WRITE_TOKEN is not configured.")
        import urllib.request
        headers = {
            "authorization": f"Bearer {self.token}",
        }
        req = urllib.request.Request(download_url, headers=headers, method="GET")
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()

    def backup_repository(self, storage: RepositoryStorage) -> dict[str, Any]:
        if not self.configured:
            return {"status": "error", "message": "BLOB_READ_WRITE_TOKEN is not configured."}
        repo_name = storage.repo_name
        uploaded = 0
        total_bytes = 0
        prefix = f"repositories/{repo_name}"

        key_files = [
            (storage.metadata_file, f"{prefix}/metadata.json"),
            (storage.inspection_file, f"{prefix}/inspection.json"),
            (storage.graph_file, f"{prefix}/graph/graph.json"),
            (storage.architecture_file, f"{prefix}/graph/architecture.json"),
            (storage.modules_file, f"{prefix}/graph/modules.json"),
            (storage.chunks_file, f"{prefix}/rag/chunks.json"),
            (storage.embeddings_file, f"{prefix}/rag/embeddings.json"),
            (storage.rag_index_file, f"{prefix}/rag/graph_rag_index.json"),
            (storage.main_graph_rag_file, f"{prefix}/graph_rag_embeddings.json"),
            (storage.manifest_file, f"{prefix}/source/manifest.json"),
            (storage.commits_file, f"{prefix}/commits/commits.json"),
            (storage.contributors_file, f"{prefix}/commits/contributors.json"),
            (storage.branches_file, f"{prefix}/commits/branches.json"),
            (storage.pushes_file, f"{prefix}/commits/pushes.json"),
            (storage.pull_requests_file, f"{prefix}/commits/pull_requests.json"),
            (storage.conversations_file, f"{prefix}/ai_chats/conversations.json"),
        ]

        for file_path, remote_path in key_files:
            if file_path.is_file():
                raw = file_path.read_bytes()
                self.upload_bytes(remote_path, raw, "application/json")
                uploaded += 1
                total_bytes += len(raw)

        return {
            "status": "ok",
            "repository": repo_name,
            "uploaded_files": uploaded,
            "total_bytes": total_bytes,
            "synced_at": datetime.now(timezone.utc).isoformat(),
        }

    def restore_repository(self, repo_name: str, target_base: Path | None = None) -> dict[str, Any]:
        if not self.configured:
            return {"status": "error", "message": "BLOB_READ_WRITE_TOKEN is not configured."}
        base = target_base or get_default_storage_root()
        prefix = f"repositories/{repo_name}"
        blobs = self.list_blobs(prefix=prefix)
        if not blobs:
            return {"status": "error", "message": f"No blobs found in Vercel Storage for repository '{repo_name}'."}

        repo_root = base / repo_name
        restored = 0
        total_bytes = 0

        for blob in blobs:
            pathname = blob.get("pathname", "")
            if not pathname.startswith(prefix):
                continue
            rel_path = pathname[len(prefix):].lstrip("/")
            local_target = repo_root / rel_path
            local_target.parent.mkdir(parents=True, exist_ok=True)
            data = self.download_bytes(blob["url"])
            local_target.write_bytes(data)
            restored += 1
            total_bytes += len(data)

        return {
            "status": "ok",
            "repository": repo_name,
            "restored_files": restored,
            "total_bytes": total_bytes,
            "local_path": str(repo_root),
        }
