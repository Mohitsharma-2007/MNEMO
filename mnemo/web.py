"""Dependency-free web interface for the Mnemo local MVP."""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter, defaultdict
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .ai import AIClient
from .agents import ContributorOrchestrator, attach_ai_result
from .analysis import analyze_repository
from .graph import InMemoryGraphStore
from .github import CORE_CONTRIBUTOR_MAX_PAGES, CORE_HISTORY_MAX_PAGES, GITHUB_HISTORY_KEYS, GITHUB_INSIGHT_KEYS, GitHubClient, GitHubError, parse_github_repository
from .ingest import IngestionError, ingest_repository
from .neo4j import Neo4jError, Neo4jQueryClient, neo4j_status
from .query import query_graph
from .repository import RepositoryCache
from .workflow import GitHubInspectionError, inspect_github_repository, public_inspection
from .storage import RepositoryStorage, list_stored_repositories, get_default_storage_root, VercelBlobStorage


WEB_ROOT = Path(__file__).parent / "web"
BRAND_ASSET_ROOT = WEB_ROOT.parent.parent / "Assets"
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_SOURCE_BYTES = 1 * 1024 * 1024
MAX_BINARY_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_SOURCE_LINES = 500
MAX_FILE_CATALOG = 20_000
DEFAULT_WEB_MAX_COMMITS = 10_000
MAX_INSPECTION_JOBS = 12


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _repository_node(graph: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (node for node in graph.get("nodes", []) if "Repository" in node.get("labels", [])),
        None,
    )


class AppState:
    """One in-memory graph session for the local single-user web app."""

    def __init__(
        self,
        ai_client: AIClient | None = None,
        neo4j_client: Neo4jQueryClient | None = None,
        github_client: GitHubClient | None = None,
        repository_cache: RepositoryCache | None = None,
    ) -> None:
        self.graph: dict[str, Any] | None = None
        self.repository_root: Path | None = None
        self.loaded_at: str | None = None
        self.inspection: dict[str, Any] | None = None
        self.agent_orchestrator: ContributorOrchestrator | None = None
        self.storage: RepositoryStorage | None = None
        self.ai_client = ai_client or AIClient()
        if neo4j_client is not None:
            self.neo4j_client = neo4j_client
        else:
            try:
                self.neo4j_client = Neo4jQueryClient.from_env()
            except Neo4jError:
                # Missing or incomplete local settings should not prevent the
                # dependency-free local graph from starting.
                self.neo4j_client = None
        self.github_client = github_client or GitHubClient()
        self.repository_cache = repository_cache or RepositoryCache()
        self.lock = threading.RLock()
        self.inspection_jobs: dict[str, dict[str, Any]] = {}

    def _inspection_job_payload(self, job: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "job_id": job["job_id"],
            "repository": job["repository"],
            "status": job["status"],
            "error": job.get("error"),
            "progress": job["progress"],
        }
        if job.get("result") is not None:
            payload.update(job["result"])
        return payload

    def inspection_job(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            job = self.inspection_jobs.get(job_id)
            if job is None:
                raise LookupError("Inspection job not found.")
            return self._inspection_job_payload(job)

    def inspection_events(self, job_id: str, after: int = 0) -> tuple[list[dict[str, Any]], bool]:
        with self.lock:
            job = self.inspection_jobs.get(job_id)
            if job is None:
                raise LookupError("Inspection job not found.")
            events = [event for event in job.get("events", []) if int(event.get("id", 0)) > after]
            return events, job.get("status") in {"complete", "error"}

    def _record_inspection_event(self, job: dict[str, Any], event: dict[str, Any]) -> None:
        events = job.setdefault("events", [])
        events.append(
            {
                "id": len(events) + 1,
                "event": event.get("event", "progress"),
                "data": event,
                "status": job.get("status"),
                "progress": {
                    "percent": job["progress"].get("percent", 0),
                    "stage": job["progress"].get("stage"),
                    "message": job["progress"].get("message"),
                    "counts": dict(job["progress"].get("counts", {})),
                    "collections": dict(job["progress"].get("collections", {})),
                    "chunks": list(job["progress"].get("chunks", [])),
                },
            }
        )

    def _update_inspection_job(self, job_id: str, event: dict[str, Any]) -> None:
        stage_ranges = {
            "metadata": (0, 15),
            "checkout": (15, 25),
            "source": (25, 40),
            "tree": (40, 45),
            "analysis": (45, 55),
            "contributors": (55, 70),
            "history": (70, 85),
            "insights": (85, 100),
        }
        collection_to_count = {
            "contributors": "contributors",
            "commits": "commits",
            "pull_requests": "pull_requests",
            "issues_raw": "issues",
            "languages": "languages",
            "readme": "readme",
        }
        with self.lock:
            job = self.inspection_jobs.get(job_id)
            if job is None:
                return
            progress = job["progress"]
            event_type = event.get("event")
            if event_type == "requests":
                total = max(0, int(event.get("total") or 0))
                progress["requests"]["total"] = total
                progress["requests"]["completed"] = min(progress["requests"]["completed"], total)
                if progress["stage"] == "metadata" and total:
                    progress["percent"] = max(
                        progress["percent"],
                        round(stage_ranges["metadata"][1] * progress["requests"]["completed"] / total),
                    )
            elif event_type == "collection":
                key = str(event.get("key") or "collection")
                count = max(0, int(event.get("count") or 0))
                progress["collections"][key] = count
                count_key = collection_to_count.get(key)
                if count_key:
                    progress["counts"][count_key] = count
                if event.get("total"):
                    progress["requests"]["total"] = max(progress["requests"]["total"], int(event["total"]) + 2)
                    progress["requests"]["completed"] = max(
                        progress["requests"]["completed"],
                        min(progress["requests"]["total"], int(event.get("completed") or 0) + 2),
                    )
                    if progress["stage"] == "metadata":
                        progress["percent"] = max(
                            progress["percent"],
                            round(stage_ranges["metadata"][1] * progress["requests"]["completed"] / progress["requests"]["total"]),
                        )
                elif event.get("completed"):
                    progress["requests"]["completed"] = max(progress["requests"]["completed"], int(event["completed"]))
                if key == "contributors":
                    for segment in progress["segments"]:
                        if segment["key"] == "contributors":
                            segment["status"] = "active"
            elif event_type == "stage":
                stage = str(event.get("stage") or event.get("segment") or "metadata")
                status = str(event.get("status") or "active")
                progress["stage"] = stage
                progress["message"] = str(event.get("message") or "Collecting repository evidence.")
                chunk = event.get("chunk")
                if status == "complete" and chunk and str(chunk) not in progress["chunks"]:
                    progress["chunks"].append(str(chunk))
                if isinstance(event.get("counts"), dict):
                    for key, value in event["counts"].items():
                        try:
                            progress["counts"][key] = max(0, int(value))
                        except (TypeError, ValueError):
                            continue
                start, end = stage_ranges.get(stage, (0, 100))
                if stage == "metadata" and progress["requests"]["total"]:
                    fraction = progress["requests"]["completed"] / progress["requests"]["total"]
                    progress["percent"] = max(progress["percent"], round(start + (end - start) * min(1, fraction)))
                elif status == "complete":
                    progress["percent"] = max(progress["percent"], end)
                else:
                    progress["percent"] = max(progress["percent"], start)
                for segment in progress["segments"]:
                    segment_key = segment["key"]
                    if segment_key == stage or (stage == "checkout" and segment_key == "source"):
                        segment["status"] = status
            if event_type == "stage" and event.get("stage") == "source" and event.get("status") == "complete":
                for segment in progress["segments"]:
                    if segment["key"] == "tree":
                        segment["status"] = "active"
            if event_type == "stage" and event.get("stage") == "analysis" and event.get("status") == "complete":
                for segment in progress["segments"]:
                    if segment["key"] == "tree":
                        segment["status"] = "complete"
            self._record_inspection_event(job, event)

    def start_github_inspection(self, repository: str, max_commits: int) -> dict[str, Any]:
        parsed = parse_github_repository(repository)
        job_id = uuid.uuid4().hex
        segments = [
            {"key": "metadata", "label": "Repository metadata", "status": "queued"},
            {"key": "contributors", "label": "Contributors", "status": "queued"},
            {"key": "history", "label": "History and discussions", "status": "queued"},
            {"key": "insights", "label": "Analytics and Actions", "status": "queued"},
            {"key": "source", "label": "Source and symbols", "status": "queued"},
            {"key": "tree", "label": "File tree", "status": "queued"},
            {"key": "analysis", "label": "Architecture analysis", "status": "queued"},
        ]
        job = {
            "job_id": job_id,
            "repository": parsed.full_name,
            "status": "queued",
            "error": None,
            "result": None,
            "progress": {
                "percent": 0,
                "stage": "metadata",
                "message": "Queued segmented repository inspection.",
                "counts": {},
                "collections": {},
                "requests": {"completed": 0, "total": 0},
                "chunks": [],
                "segments": segments,
            },
            "events": [],
        }
        with self.lock:
            self.inspection_jobs[job_id] = job
            while len(self.inspection_jobs) > MAX_INSPECTION_JOBS:
                oldest = next(iter(self.inspection_jobs))
                if oldest == job_id:
                    break
                self.inspection_jobs.pop(oldest, None)

        def run() -> None:
            with self.lock:
                current = self.inspection_jobs.get(job_id)
                if current is not None:
                    current["status"] = "running"
                    self._record_inspection_event(current, {"event": "job", "status": "running", "message": "Inspection started."})
            try:
                result = inspect_github_repository(
                    parsed,
                    github_client=self.github_client,
                    repository_cache=self.repository_cache,
                    max_commits=max_commits,
                    progress_callback=lambda event: self._update_inspection_job(job_id, event),
                )
                self.set_inspection(result)
                graph = self.require_graph()
                with self.lock:
                    current = self.inspection_jobs.get(job_id)
                    if current is None:
                        return
                    current["result"] = {
                        "inspection": self.public_inspection(),
                        "summary": graph_summary(self),
                        "graph": _public_graph(graph, limit=1000),
                    }
                self._update_inspection_job(job_id, {"event": "stage", "stage": "metadata", "chunk": "metadata", "status": "complete", "message": "Core repository metadata received.", "counts": current["result"]["summary"]["counts"]})
                chunk_specs = {
                    "contributors": {
                        "loader": self.github_client.inspect_contributors,
                        "merger": self.merge_github_contributors,
                        "message": "Initial contributor window received; full contributor history remains available.",
                        "kwargs": {"max_pages": CORE_CONTRIBUTOR_MAX_PAGES},
                    },
                    "history": {
                        "loader": self.github_client.inspect_history,
                        "merger": self.merge_github_history,
                        "message": "Initial history window received; full history remains available.",
                        "kwargs": {"max_pages": CORE_HISTORY_MAX_PAGES},
                    },
                    "insights": {
                        "loader": self.github_client.inspect_insights,
                        "merger": self.merge_github_insights,
                        "message": "Analytics, dependencies, traffic, and Actions data received.",
                        "kwargs": {},
                    },
                }

                def load_chunk(chunk_name: str, spec: dict[str, Any]) -> dict[str, Any]:
                    callback = lambda event: self._update_inspection_job(job_id, {**event, "segment": chunk_name})
                    try:
                        return spec["loader"](parsed, progress_callback=callback, **spec["kwargs"])
                    except TypeError:
                        try:
                            return spec["loader"](parsed, **spec["kwargs"])
                        except TypeError:
                            return spec["loader"](parsed)

                for chunk_name in chunk_specs:
                    self._update_inspection_job(job_id, {"event": "stage", "stage": chunk_name, "chunk": chunk_name, "status": "active", "message": f"Loading {chunk_name} in parallel bounded requests."})
                with ThreadPoolExecutor(max_workers=len(chunk_specs), thread_name_prefix="mnemo-github") as executor:
                    futures = {executor.submit(load_chunk, name, spec): name for name, spec in chunk_specs.items()}
                    for future in as_completed(futures):
                        chunk_name = futures[future]
                        spec = chunk_specs[chunk_name]
                        metadata = future.result()
                        spec["merger"](metadata)
                        with self.lock:
                            current = self.inspection_jobs.get(job_id)
                            if current is not None:
                                current["result"]["inspection"] = self.public_inspection()
                        self._update_inspection_job(job_id, {"event": "stage", "stage": chunk_name, "chunk": chunk_name, "status": "complete", "message": spec["message"]})
                with self.lock:
                    current = self.inspection_jobs.get(job_id)
                    if current is not None:
                        current["result"]["summary"] = graph_summary(self)
                self._update_inspection_job(job_id, {"event": "stage", "stage": "tree", "chunk": "tree", "status": "complete", "message": "File tree is ready.", "counts": current["result"]["summary"]["counts"]})
                self._update_inspection_job(job_id, {"event": "stage", "stage": "analysis", "chunk": "analysis", "status": "complete", "message": "Repository architecture is ready.", "counts": current["result"]["summary"]["counts"]})
                with self.lock:
                    current = self.inspection_jobs.get(job_id)
                    if current is not None:
                        current["progress"]["percent"] = 100
                        current["progress"]["message"] = "Repository workspace is ready."
                        current["status"] = "complete"
                        self._record_inspection_event(current, {"event": "job", "status": "complete", "message": "All requested GitHub chunks received."})
            except Exception as error:
                with self.lock:
                    current = self.inspection_jobs.get(job_id)
                    if current is not None:
                        current["status"] = "error"
                        current["error"] = str(error)
                        current["progress"]["message"] = str(error)
                        self._record_inspection_event(current, {"event": "job", "status": "error", "message": str(error)})

        threading.Thread(target=run, name=f"mnemo-inspection-{job_id[:8]}", daemon=True).start()
        return self.inspection_job(job_id)

    def set_graph(self, graph: dict[str, Any]) -> None:
        repository = _repository_node(graph) or {}
        root_path = repository.get("root_path") or graph.get("repository", {}).get("root_path")
        with self.lock:
            self.graph = graph
            self.repository_root = Path(root_path).resolve() if root_path else None
            self.loaded_at = _now()
            analysis = {}
            if self.repository_root and self.repository_root.exists():
                try:
                    analysis = analyze_repository(self.repository_root, graph)
                except Exception:
                    analysis = {}

            contributors = []
            commits = []
            prs = []
            for node in graph.get("nodes", []):
                labels = node.get("labels", [])
                node_id = str(node.get("id", ""))
                if "Contributor" in labels or "Author" in labels or node_id.startswith("contributor:"):
                    raw_login = node.get("login") or node.get("username") or node.get("name") or node.get("display_name") or node_id.removeprefix("contributor:")
                    login = str(raw_login or "").strip()
                    if login:
                        contributors.append({
                            "login": login,
                            "name": node.get("name") or node.get("display_name") or login,
                            "contributions": node.get("commits_count") or node.get("contributions", 1),
                            "avatar_url": node.get("avatar_url") or "",
                        })
                elif "Commit" in labels or node_id.startswith("commit:"):
                    commits.append({
                        "sha": node.get("sha") or node.get("hash") or node_id.removeprefix("commit:"),
                        "message": node.get("message") or "",
                        "author": node.get("author") or node.get("author_login") or node.get("author_email") or "",
                        "date": node.get("date") or node.get("committed_at") or node.get("timestamp") or "",
                    })
                elif "PullRequest" in labels:
                    prs.append({
                        "number": node.get("number"),
                        "title": node.get("title") or "",
                        "state": node.get("state") or "merged",
                        "author": node.get("author") or "",
                    })

            self.inspection = {
                "repository": {
                    "name": repository.get("name"),
                    "url": repository.get("url"),
                    "default_branch": repository.get("default_branch", "main"),
                },
                "github": {
                    "contributors": contributors,
                    "contributor_count": len(contributors),
                    "commits": commits,
                    "pull_requests": prs,
                    "coverage": {
                        "contributors_count": len(contributors),
                        "commits_count": len(commits),
                        "prs_count": len(prs),
                    },
                },
                "analysis": analysis,
                "freshness": {
                    "inspected_at": _now(),
                    "github_api_authenticated": False,
                    "checkout_refreshed": True,
                },
            }
            self.agent_orchestrator = None
            if self.storage is None and root_path:
                try:
                    self.storage = RepositoryStorage(Path(root_path).name)
                    threading.Thread(
                        target=self.storage.save_all,
                        args=({"name": Path(root_path).name},),
                        kwargs={
                            "local_path": self.repository_root,
                            "graph": graph,
                            "analysis": analysis,
                        },
                        daemon=True,
                    ).start()
                except Exception:
                    pass

    def set_inspection(self, result: dict[str, Any]) -> None:
        graph = result.get("graph")
        if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
            raise ValueError("Invalid GitHub inspection graph.")
        self.set_graph(graph)
        with self.lock:
            self.inspection = public_inspection(result)
            self.agent_orchestrator = ContributorOrchestrator.from_inspection(
                self.inspection,
                graph,
            )
            repo_slug = (
                result.get("repository", {}).get("full_name")
                or result.get("cache", {}).get("key")
                or "default-repository"
            )
            self.storage = RepositoryStorage(repo_slug)
            try:
                self.storage.save_all(
                    result.get("repository"),
                    local_path=result.get("_local_path") or self.repository_root,
                    graph=graph,
                    inspection_metadata=result,
                    analysis=result.get("analysis"),
                )
            except Exception:
                pass

    def get_or_create_storage(self) -> RepositoryStorage | None:
        with self.lock:
            if self.storage is not None:
                return self.storage
            name = None
            if self.inspection:
                repo_meta = self.inspection.get("repository", {})
                name = repo_meta.get("full_name") or repo_meta.get("name")
            if not name and self.graph:
                repo_node = _repository_node(self.graph)
                name = repo_node.get("name") if repo_node else None
            if not name and self.repository_root:
                name = self.repository_root.name
            name = name or "default-repository"
            try:
                self.storage = RepositoryStorage(name)
                return self.storage
            except Exception:
                return None

    def require_graph(self) -> dict[str, Any]:
        with self.lock:
            if self.graph is None:
                raise LookupError("No repository has been ingested yet.")
            return self.graph

    def public_repository(self) -> dict[str, Any] | None:
        graph = self.require_graph()
        repository = _repository_node(graph) or {}
        return {
            key: repository.get(key)
            for key in ("name", "url", "default_branch")
            if repository.get(key) is not None
        }

    def public_inspection(self) -> dict[str, Any] | None:
        with self.lock:
            return self.inspection

    def merge_github_contributors(self, metadata: dict[str, Any]) -> None:
        """Merge the contributor segment without replacing core evidence."""

        with self.lock:
            if self.inspection is None:
                raise LookupError("No GitHub inspection is loaded yet.")
            github = self.inspection.setdefault("github", {})
            for key in ("contributors", "contributor_count", "contributor_activity", "contributors_loaded", "contributors_status"):
                if key in metadata:
                    github[key] = metadata[key]
            coverage = github.setdefault("coverage", {})
            if isinstance(metadata.get("coverage"), dict):
                coverage.update(metadata["coverage"])
            errors = github.setdefault("errors", {})
            if isinstance(metadata.get("errors"), dict):
                errors.update(metadata["errors"])
            request = github.setdefault("request", {})
            if isinstance(metadata.get("request"), dict):
                request.update(metadata["request"])
            if self.graph is not None:
                self.agent_orchestrator = ContributorOrchestrator.from_inspection(self.inspection, self.graph)

    def merge_github_insights(self, metadata: dict[str, Any]) -> None:
        """Merge optional GitHub collections without replacing core evidence."""

        with self.lock:
            if self.inspection is None:
                raise LookupError("No GitHub inspection is loaded yet.")
            github = self.inspection.setdefault("github", {})
            for key in GITHUB_INSIGHT_KEYS:
                if key in metadata:
                    github[key] = metadata[key]
            coverage = github.setdefault("coverage", {})
            insight_coverage = metadata.get("coverage", {})
            for key in (*GITHUB_INSIGHT_KEYS, "network", "pulse", "community_standards", "actions_metrics"):
                if isinstance(insight_coverage, dict) and key in insight_coverage:
                    coverage[key] = insight_coverage[key]
            errors = github.setdefault("errors", {})
            if isinstance(metadata.get("errors"), dict):
                errors.update(metadata["errors"])
            if isinstance(metadata.get("insights"), dict):
                github["insights"] = metadata["insights"]
            github["insights_loaded"] = bool(metadata.get("insights_loaded"))
            github["insights_status"] = metadata.get("insights_status", "partial")
            request = github.setdefault("request", {})
            if isinstance(metadata.get("request"), dict):
                request.update(metadata["request"])
            if self.graph is not None:
                self.agent_orchestrator = ContributorOrchestrator.from_inspection(self.inspection, self.graph)
            freshness = self.inspection.setdefault("freshness", {})
            freshness_errors = freshness.setdefault("errors", {})
            if isinstance(metadata.get("errors"), dict):
                freshness_errors.update(metadata["errors"])

    def merge_github_history(self, metadata: dict[str, Any]) -> None:
        """Merge the full bounded GitHub history without replacing local graph data."""

        with self.lock:
            if self.inspection is None:
                raise LookupError("No GitHub inspection is loaded yet.")
            github = self.inspection.setdefault("github", {})
            for key in GITHUB_HISTORY_KEYS:
                if key in metadata:
                    github[key] = metadata[key]
            coverage = github.setdefault("coverage", {})
            history_coverage = metadata.get("coverage", {})
            if isinstance(history_coverage, dict):
                for key in GITHUB_HISTORY_KEYS:
                    if key in history_coverage:
                        coverage[key] = history_coverage[key]
            errors = github.setdefault("errors", {})
            if isinstance(metadata.get("errors"), dict):
                errors.update(metadata["errors"])
            github["history_loaded"] = bool(metadata.get("history_loaded"))
            github["history_status"] = metadata.get("history_status", "partial")
            request = github.setdefault("request", {})
            if isinstance(metadata.get("request"), dict):
                request.update(metadata["request"])
            if self.graph is not None:
                self.agent_orchestrator = ContributorOrchestrator.from_inspection(self.inspection, self.graph)
            freshness = self.inspection.setdefault("freshness", {})
            freshness_errors = freshness.setdefault("errors", {})
            if isinstance(metadata.get("errors"), dict):
                freshness_errors.update(metadata["errors"])

    def require_agents(self) -> ContributorOrchestrator:
        with self.lock:
            if self.agent_orchestrator is None:
                raise LookupError("No contributor agents are available until a GitHub inspection is loaded.")
            return self.agent_orchestrator

    def neo4j_configuration_status(self) -> dict[str, Any]:
        """Return local Neo4j configuration without making a network request."""

        if self.neo4j_client is not None:
            return self.neo4j_client.status()
        return neo4j_status()

    def neo4j_connection_status(self) -> dict[str, Any]:
        """Check the configured Neo4j service without exposing credentials."""

        try:
            client = self.neo4j_client or Neo4jQueryClient.from_env()
        except Neo4jError as error:
            return {"configured": False, "connected": False, "error": str(error)}
        return client.check_connection()

    def require_neo4j_client(self) -> Neo4jQueryClient:
        if self.neo4j_client is None:
            self.neo4j_client = Neo4jQueryClient.from_env()
        return self.neo4j_client

    def list_stored_repositories(self) -> list[dict[str, Any]]:
        return list_stored_repositories()

    def load_from_storage(self, repo_identifier: str) -> dict[str, Any]:
        storage = RepositoryStorage(repo_identifier)
        if not storage.root.exists():
            candidates = [
                d for d in storage.storage_base.iterdir()
                if d.is_dir() and (d.name.lower() == repo_identifier.lower() or repo_identifier.lower() in d.name.lower())
            ]
            if candidates:
                storage = RepositoryStorage(candidates[0].name)
            else:
                raise FileNotFoundError(f"Stored repository '{repo_identifier}' not found in {storage.storage_base}.")

        loaded = storage.load_all()
        graph = loaded.get("graph")
        if not graph or not isinstance(graph.get("nodes"), list):
            raise ValueError(f"No valid graph found in storage for '{repo_identifier}'.")

        with self.lock:
            self.graph = graph
            self.repository_root = loaded.get("files_dir")
            self.loaded_at = _now()
            self.storage = storage
            self.inspection = loaded.get("inspection")
            if not self.inspection:
                self.set_graph(graph)
            self.agent_orchestrator = ContributorOrchestrator.from_inspection(
                self.inspection or {},
                graph,
            )

        return {
            "status": "loaded",
            "repository": storage.repo_name,
            "path": str(storage.root),
            "summary": graph_summary(self),
            "inspection": self.public_inspection(),
            "graph": _public_graph(graph, limit=1000),
        }


def _labels(node: dict[str, Any]) -> set[str]:
    return set(node.get("labels", []))


def _public_node(node: dict[str, Any]) -> dict[str, Any]:
    """Remove server-only repository paths before returning graph data."""

    return {key: value for key, value in node.items() if key != "root_path"}


def _public_graph(graph: dict[str, Any], limit: int = 250, label: str | None = None) -> dict[str, Any]:
    nodes = graph.get("nodes", [])
    if label:
        nodes = [node for node in nodes if label in _labels(node)]
    limit = max(1, min(limit, 1000))
    if not label and len(nodes) > limit:
        # Keep the overview useful on larger repositories: a first-page slice
        # can otherwise contain only files and symbols, hiding all history.
        priority = ("Repository", "File", "Function", "Class", "ConfigKey", "Commit", "Contributor", "Decision")
        grouped = {
            item: [node for node in nodes if item in _labels(node)]
            for item in priority
        }
        selected = []
        quota = max(1, limit // len(priority))
        for item in priority:
            selected.extend(grouped[item][:quota])
        selected_ids = {node["id"] for node in selected}
        for node in nodes:
            if len(selected) >= limit:
                break
            if node["id"] not in selected_ids:
                selected.append(node)
                selected_ids.add(node["id"])
    else:
        selected = nodes[:limit]
    selected_ids = {node["id"] for node in selected}
    edges = [
        edge
        for edge in graph.get("edges", [])
        if edge["source"] in selected_ids and edge["target"] in selected_ids
    ]
    metadata = {
        key: value
        for key, value in graph.items()
        if key not in {"nodes", "edges"}
    }
    if "repository" in metadata:
        metadata["repository"] = {
            key: value for key, value in metadata["repository"].items() if key != "root_path"
        }
    return {
        **metadata,
        "nodes": [_public_node(node) for node in selected],
        "edges": edges,
    }


def graph_summary(state: AppState) -> dict[str, Any]:
    graph = state.require_graph()
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    counts = Counter(label for node in nodes for label in node.get("labels", []))
    file_ids = {node["id"] for node in nodes if "File" in _labels(node)}
    commit_ids = {node["id"] for node in nodes if "Commit" in _labels(node)}
    decision_commit_ids = {
        edge["source"]
        for edge in edges
        if edge["type"] == "RESULTED_IN" and edge["source"] in commit_ids
    }
    linked_files = {
        edge["target"]
        for edge in edges
        if edge["type"] == "MODIFIED"
        and edge["target"] in file_ids
        and edge["source"] in decision_commit_ids
    }
    repository = state.public_repository() or {}
    return {
        "repository": repository,
        "loaded_at": state.loaded_at,
        "ingestion": graph.get("ingestion", {}),
        "counts": {
            "nodes": len(nodes),
            "edges": len(edges),
            "files": counts.get("File", 0),
            "functions": counts.get("Function", 0),
            "classes": counts.get("Class", 0),
            "config_keys": counts.get("ConfigKey", 0),
            "commits": counts.get("Commit", 0),
            "contributors": counts.get("Contributor", 0),
            "decisions": counts.get("Decision", 0),
        },
        "labels": dict(sorted(counts.items())),
        "active_decisions": sum(
            1
            for node in nodes
            if "Decision" in _labels(node) and node.get("status") == "active"
        ),
        "evidence_coverage": round((len(linked_files) / len(file_ids)) * 100, 1) if file_ids else 0.0,
    }


def graph_view(state: AppState, params: dict[str, list[str]]) -> dict[str, Any]:
    """Return a bounded, server-side graph view for the workspace renderer."""

    store = InMemoryGraphStore(state.require_graph())
    focus_value = params.get("focus", [""])[0].strip()
    focus = [item for item in focus_value.split(",") if item] or None
    level = params.get("level", [""])[0].strip().lower()
    budget = int(params.get("budget", ["150"])[0])
    if level in {"project", "directory", "file"} and not focus:
        view = store.rollup(level=level, budget=budget)
    else:
        relationships = [item for item in params.get("edge", []) if item]
        labels = [item for item in params.get("label", []) if item]
        view = store.subgraph(
            focus,
            depth=int(params.get("depth", ["1"])[0]),
            relationship_types=relationships or None,
            labels=labels or None,
            budget=budget,
            as_of=params.get("as_of", [None])[0],
        )
    metadata = {
        key: value for key, value in view.items() if key not in {"nodes", "edges"}
    }
    if isinstance(metadata.get("repository"), dict):
        metadata["repository"] = {
            key: value for key, value in metadata["repository"].items() if key != "root_path"
        }
    return {
        **metadata,
        "nodes": [_public_node(node) for node in view.get("nodes", [])],
        "edges": view.get("edges", []),
    }


def _find_node(graph: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    return next((node for node in graph.get("nodes", []) if node.get("id") == node_id), None)


def search_entities(graph: dict[str, Any], query: str = "", label: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    needle = query.strip().lower()
    allowed = {"File", "Function", "Class", "ConfigKey"}
    results = []
    for node in graph.get("nodes", []):
        node_labels = _labels(node)
        if not node_labels.intersection(allowed):
            continue
        if label and label not in node_labels:
            continue
        searchable = " ".join(
            str(node.get(key, ""))
            for key in ("id", "name", "path", "file_path", "signature")
        ).lower()
        if needle and needle not in searchable:
            continue
        result = _public_node(node)
        result["label"] = next((item for item in node.get("labels", []) if item in allowed), "Entity")
        results.append(result)
    return results[: max(1, min(limit, 250))]


def entity_detail(graph: dict[str, Any], node_id: str) -> dict[str, Any] | None:
    node = _find_node(graph, node_id)
    if node is None:
        return None
    by_id = {item["id"]: item for item in graph.get("nodes", [])}
    relationships = []
    for edge in graph.get("edges", []):
        if edge["source"] != node_id and edge["target"] != node_id:
            continue
        other_id = edge["target"] if edge["source"] == node_id else edge["source"]
        relationships.append(
            {
                "direction": "out" if edge["source"] == node_id else "in",
                "type": edge["type"],
                "properties": {
                    key: value for key, value in edge.items() if key not in {"source", "target", "type"}
                },
                "node": _public_node(by_id[other_id]) if other_id in by_id else {"id": other_id},
            }
        )
    return {"node": _public_node(node), "relationships": relationships}


def entity_evidence(graph: dict[str, Any], node_id: str) -> list[dict[str, Any]]:
    by_id = {node["id"]: node for node in graph.get("nodes", [])}
    commit_ids = {
        edge["source"]
        for edge in graph.get("edges", [])
        if edge["type"] == "MODIFIED" and edge["target"] == node_id
    }
    decisions_by_commit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    authors_by_commit: dict[str, dict[str, Any]] = {}
    modifications_by_commit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in graph.get("edges", []):
        if edge["type"] == "RESULTED_IN" and edge["source"] in commit_ids:
            decision = by_id.get(edge["target"])
            if decision and decision.get("status") != "expired":
                decisions_by_commit[edge["source"]].append(decision)
        elif edge["type"] == "AUTHORED" and edge["target"] in commit_ids:
            author = by_id.get(edge["source"])
            if author:
                authors_by_commit[edge["target"]] = author
        elif edge["type"] == "MODIFIED" and edge["source"] in commit_ids and edge["target"] == node_id:
            modifications_by_commit[edge["source"]].append(edge)

    commits = [by_id[commit_id] for commit_id in commit_ids if commit_id in by_id]
    commits.sort(key=lambda commit: commit.get("history_index", 10**9))
    evidence = []
    for commit in commits:
        decisions = decisions_by_commit.get(commit["id"], [])
        author = authors_by_commit.get(commit["id"])
        evidence.append(
            {
                "commit": {
                    key: commit.get(key)
                    for key in ("sha", "message", "timestamp", "history_index")
                },
                "author": {
                    "display_name": author.get("display_name") if author else None,
                    "email": author.get("username") if author else commit.get("author_email"),
                },
                "decisions": [
                    {
                        key: decision.get(key)
                        for key in ("id", "summary", "context", "timestamp", "status")
                    }
                    for decision in decisions
                ],
                "modifications": modifications_by_commit.get(commit["id"], []),
            }
        )
    return evidence


def evidence_chain(graph: dict[str, Any], node_id: str | None = None, limit: int = 24) -> dict[str, Any]:
    """Build a readable commit → code → decision chain from graph edges."""

    by_id = {node.get("id"): node for node in graph.get("nodes", []) if node.get("id")}
    target = by_id.get(node_id) if node_id else None
    if node_id and target is None:
        raise LookupError("Evidence target not found.")

    commits = [node for node in graph.get("nodes", []) if "Commit" in _labels(node)]
    commits.sort(key=lambda node: (node.get("history_index", 10**9), node.get("timestamp", "")))
    if target:
        commit_ids = {
            edge["source"]
            for edge in graph.get("edges", [])
            if edge.get("type") == "MODIFIED" and edge.get("target") == node_id
        }
        commits = [node for node in commits if node.get("id") in commit_ids]
    else:
        commits = [
            node
            for node in commits
            if any(
                edge.get("source") == node.get("id") and edge.get("type") in {"MODIFIED", "RESULTED_IN"}
                for edge in graph.get("edges", [])
            )
        ]

    commits = list(reversed(commits[-max(1, min(limit, 100)) :]))
    steps: list[dict[str, Any]] = []
    for commit in commits:
        commit_id = commit.get("id")
        author_id = next(
            (
                edge.get("source")
                for edge in graph.get("edges", [])
                if edge.get("type") == "AUTHORED" and edge.get("target") == commit_id
            ),
            None,
        )
        modified_edges = [
            edge for edge in graph.get("edges", [])
            if edge.get("type") == "MODIFIED" and edge.get("source") == commit_id
        ]
        modified = [
            {
                **_public_node(by_id[edge["target"]]),
                **{
                    key: value
                    for key, value in edge.items()
                    if key not in {"source", "target", "type"}
                },
            }
            for edge in modified_edges
            if edge.get("target") in by_id
        ]
        decision_edges = [
            edge for edge in graph.get("edges", [])
            if edge.get("type") == "RESULTED_IN" and edge.get("source") == commit_id
        ]
        decisions = [_public_node(by_id[edge["target"]]) for edge in decision_edges if edge.get("target") in by_id]
        superseded: list[dict[str, Any]] = []
        for decision in decisions:
            superseded.extend(
                _public_node(by_id[edge["target"]])
                for edge in graph.get("edges", [])
                if edge.get("type") == "SUPERSEDES"
                and edge.get("source") == decision.get("id")
                and edge.get("target") in by_id
            )
        steps.append(
            {
                "commit": _public_node(commit),
                "author": _public_node(by_id[author_id]) if author_id in by_id else None,
                "modified": modified,
                "decisions": decisions,
                "superseded": superseded,
            }
        )
    return {
        "target": _public_node(target) if target else None,
        "steps": steps,
        "count": len(steps),
        "message": "No linked commit evidence was found for this selection." if not steps else None,
    }


def history_timeline(graph: dict[str, Any], limit: int = 10_000) -> dict[str, Any]:
    """Return the complete locally ingested commit timeline with real diffs."""

    by_id = {node.get("id"): node for node in graph.get("nodes", []) if node.get("id")}
    commits = [node for node in graph.get("nodes", []) if "Commit" in _labels(node)]
    commits.sort(key=lambda node: (-int(node.get("history_index", 10**9)), node.get("timestamp", "")), reverse=False)
    commits = commits[: max(1, min(limit, 10_000))]

    author_by_commit: dict[str, str] = {}
    modifications_by_commit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in graph.get("edges", []):
        edge_type = edge.get("type")
        if edge_type == "AUTHORED":
            author_by_commit[edge.get("target")] = edge.get("source")
        elif edge_type == "MODIFIED":
            src = edge.get("source")
            target = by_id.get(edge.get("target"))
            if target:
                modifications_by_commit[src].append(
                    {
                        "path": target.get("path") or target.get("file_path"),
                        "label": next((label for label in target.get("labels", []) if label != "File"), "File"),
                        "start_line": edge.get("start_line"),
                        "end_line": edge.get("end_line"),
                        "diff_hunk": edge.get("diff_hunk", ""),
                    }
                )

    timeline: list[dict[str, Any]] = []
    for commit in commits:
        commit_id = commit.get("id")
        author_id = author_by_commit.get(commit_id)
        timeline.append(
            {
                "commit": _public_node(commit),
                "author": _public_node(by_id[author_id]) if author_id in by_id else None,
                "modifications": modifications_by_commit.get(commit_id, []),
            }
        )
    return {"commits": timeline, "count": len(timeline), "first": timeline[0] if timeline else None, "latest": timeline[-1] if timeline else None}


def _safe_source(state: AppState, relative_path: str, start_line: int, end_line: int) -> dict[str, Any]:
    candidate, file_node = _safe_file_candidate(state, relative_path)
    raw = candidate.read_bytes()
    suffix = candidate.suffix.lower()
    mime_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
    language = (file_node or {}).get("language", "unknown")
    image_suffixes = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".avif", ".svg"}
    if suffix in image_suffixes:
        if len(raw) > MAX_BINARY_PREVIEW_BYTES:
            raise ValueError("Image is too large for the browser preview.")
        return {
            "path": relative_path,
            "kind": "image",
            "mime_type": mime_type,
            "language": language,
            "size_bytes": len(raw),
            "preview_url": f"/api/source/raw?path={quote(relative_path, safe='')}&mode=inline",
            "start_line": 0,
            "end_line": 0,
            "total_lines": 0,
            "lines": [],
        }
    if b"\x00" in raw:
        if len(raw) > MAX_BINARY_PREVIEW_BYTES:
            raise ValueError("Binary file is too large for the browser preview.")
        return {
            "path": relative_path,
            "kind": "binary",
            "mime_type": mime_type,
            "language": language,
            "size_bytes": len(raw),
            "download_url": f"/api/source/raw?path={quote(relative_path, safe='')}&mode=download",
            "start_line": 0,
            "end_line": 0,
            "total_lines": 0,
            "lines": [],
        }
    if len(raw) > MAX_SOURCE_BYTES:
        raise ValueError("Source file is too large for the browser preview.")
    text = raw.decode("utf-8", errors="replace")
    all_lines = text.splitlines()
    start = max(1, start_line)
    end = min(len(all_lines), max(start, end_line), start + MAX_SOURCE_LINES - 1)
    kind = "markdown" if suffix in {".md", ".mdx", ".markdown"} else "text"
    return {
        "path": relative_path,
        "kind": kind,
        "mime_type": mime_type,
        "language": language,
        "size_bytes": len(raw),
        "start_line": start,
        "end_line": end,
        "total_lines": len(all_lines),
        "lines": [
            {"number": number, "text": all_lines[number - 1]}
            for number in range(start, end + 1)
        ],
    }


def _safe_file_candidate(state: AppState, relative_path: str) -> tuple[Path, dict[str, Any] | None]:
    graph = state.require_graph()
    root = state.repository_root
    if root is None:
        raise LookupError("The active graph has no local repository root.")
    tracked_paths = {
        node.get("path")
        for node in graph.get("nodes", [])
        if "File" in _labels(node) and node.get("path")
    }
    normalized = Path(relative_path)
    sensitive_name = normalized.name.startswith(".env") or normalized.suffix.lower() in {".key", ".pem", ".p12", ".pfx"}
    if normalized.is_absolute() or ".." in normalized.parts or relative_path not in tracked_paths or sensitive_name:
        raise PermissionError("Only tracked repository-relative source files can be viewed.")
    root = root.resolve()
    candidate = (root / normalized).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise PermissionError("Source path escapes the repository root.") from error
    if not candidate.is_file():
        raise FileNotFoundError(relative_path)
    file_node = next((node for node in graph.get("nodes", []) if "File" in _labels(node) and node.get("path") == relative_path), None)
    return candidate, file_node


def _safe_source_bytes(state: AppState, relative_path: str) -> tuple[bytes, str, str]:
    candidate, _file_node = _safe_file_candidate(state, relative_path)
    raw = candidate.read_bytes()
    if len(raw) > MAX_BINARY_PREVIEW_BYTES:
        raise ValueError("File is too large for the browser preview.")
    return raw, mimetypes.guess_type(candidate.name)[0] or "application/octet-stream", candidate.name


IMPORTANT_DOCUMENT_TERMS = ("readme", "code_of_conduct", "contributing", "license", "licence", "security", "support")


def _repository_documents(state: AppState) -> dict[str, Any]:
    graph = state.require_graph()
    documents = []
    for node in graph.get("nodes", []):
        path = node.get("path") if "File" in _labels(node) else None
        if not path or Path(path).suffix.lower() not in {".md", ".mdx", ".markdown", ".rst", ".txt"}:
            continue
        name = Path(path).name.lower()
        important = any(term in name for term in IMPORTANT_DOCUMENT_TERMS)
        if important or Path(path).parent == Path(".") or "/docs/" in f"/{path.lower()}/" or path.lower().startswith("docs/"):
            try:
                size = (state.repository_root / path).stat().st_size if state.repository_root else 0
            except OSError:
                size = 0
            documents.append(
                {
                    "path": path,
                    "title": Path(path).stem.replace("_", " ").replace("-", " ").title(),
                    "important": important,
                    "size_bytes": size,
                    "preview_url": f"/api/source?path={quote(path, safe='')}",
                }
            )
    documents.sort(key=lambda item: (not item["important"], item["path"].lower()))
    return {"documents": documents[:100], "count": min(len(documents), 100)}


def _file_catalog(state: AppState, limit: int = MAX_FILE_CATALOG, query: str = "") -> dict[str, Any]:
    """Return a bounded file-only catalog independent of the graph viewport."""

    graph = state.require_graph()
    needle = query.strip().lower()
    files = []
    for node in graph.get("nodes", []):
        if "File" not in _labels(node) or not node.get("path"):
            continue
        path = str(node["path"])
        if needle and needle not in path.lower():
            continue
        files.append(_public_node(node))
    files.sort(key=lambda node: str(node.get("path", "")).lower())
    bounded = files[: max(1, min(int(limit), MAX_FILE_CATALOG))]
    return {"files": bounded, "count": len(bounded), "total": len(files), "truncated": len(files) > len(bounded)}


class MnemoRequestHandler(BaseHTTPRequestHandler):
    """HTTP API and static file handler."""

    server_version = "MnemoHTTP/0.1"

    @property
    def app_state(self) -> AppState:
        if hasattr(self.server, "app_state"):
            return self.server.app_state  # type: ignore[attr-defined]
        if not hasattr(MnemoRequestHandler, "_global_state"):
            MnemoRequestHandler._global_state = AppState()
        return MnemoRequestHandler._global_state

    def log_message(self, format: str, *args: Any) -> None:
        # Keep credentials, source contents, and provider request details out
        # of logs. The CLI prints the server URL when it starts.
        return

    def _send_json(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body: bytes, content_type: str, status: int = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, message: str, status: int = HTTPStatus.BAD_REQUEST) -> None:
        self._send_json({"error": message}, status)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        if length < 0 or length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large.")
        raw = self.rfile.read(length)
        payload = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(payload, dict):
            raise ValueError("JSON request body must be an object.")
        return payload

    def _send_sse_event(self, event: dict[str, Any]) -> None:
        body = (
            f"id: {event.get('id', '')}\n"
            f"event: {event.get('event', 'progress')}\n"
            f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        ).encode("utf-8")
        self.wfile.write(body)
        self.wfile.flush()

    def _stream_inspection_sse(self, query: dict[str, list[str]]) -> None:
        job_id = query.get("job_id", [None])[0]
        if not job_id:
            raise ValueError("job_id is required.")
        try:
            cursor = int(query.get("after", [self.headers.get("Last-Event-ID", "0")])[0] or 0)
        except ValueError as error:
            raise ValueError("after must be an integer.") from error
        self.app_state.inspection_job(job_id)
        # A bounded stream prevents an abandoned browser tab from holding a
        # server thread forever. The client can reconnect with Last-Event-ID.
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            events, terminal = self.app_state.inspection_events(job_id, cursor)
            for event in events:
                self._send_sse_event(event)
                cursor = max(cursor, int(event.get("id", cursor)))
            if terminal and not events:
                break
            if not events:
                self.wfile.write(b": keep-alive\n\n")
                self.wfile.flush()
            time.sleep(0.12)
        self.close_connection = True

    @staticmethod
    def _websocket_frame(payload: str) -> bytes:
        encoded = payload.encode("utf-8")
        length = len(encoded)
        if length < 126:
            header = bytes((0x81, length))
        elif length < 65_536:
            header = bytes((0x81, 126)) + length.to_bytes(2, "big")
        else:
            header = bytes((0x81, 127)) + length.to_bytes(8, "big")
        return header + encoded

    def _stream_inspection_websocket(self, query: dict[str, list[str]]) -> None:
        job_id = query.get("job_id", [None])[0]
        if not job_id:
            raise ValueError("job_id is required.")
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or "websocket" not in self.headers.get("Upgrade", "").lower():
            self._error("A WebSocket upgrade is required.", HTTPStatus.BAD_REQUEST)
            return
        try:
            cursor = int(query.get("after", ["0"])[0] or 0)
        except ValueError as error:
            raise ValueError("after must be an integer.") from error
        self.app_state.inspection_job(job_id)
        accept = base64.b64encode(
            hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            events, terminal = self.app_state.inspection_events(job_id, cursor)
            for event in events:
                self.wfile.write(self._websocket_frame(json.dumps(event, ensure_ascii=False)))
                self.wfile.flush()
                cursor = max(cursor, int(event.get("id", cursor)))
            if terminal and not events:
                break
            time.sleep(0.12)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        try:
            query = parse_qs(parsed.query)
            if parsed.path == "/api/github/progress/stream":
                self._stream_inspection_sse(query)
            elif parsed.path == "/api/github/progress/ws":
                self._stream_inspection_websocket(query)
            elif parsed.path == "/":
                self._serve_static("index.html")
            elif parsed.path in {"/favicon.ico", "/favicon.png"}:
                if (WEB_ROOT / "favicon.ico").is_file():
                    self._serve_static("favicon.ico")
                elif (BRAND_ASSET_ROOT / "Logo.png").is_file():
                    self._serve_static("Logo.png", BRAND_ASSET_ROOT)
                else:
                    self.send_response(HTTPStatus.NO_CONTENT)
                    self.end_headers()
            elif parsed.path.startswith("/assets/"):
                self._serve_static(parsed.path.removeprefix("/assets/"))
            elif parsed.path.startswith("/brand-assets/"):
                self._serve_static(parsed.path.removeprefix("/brand-assets/"), BRAND_ASSET_ROOT)
            elif parsed.path == "/api/health":
                self._send_json(
                    {
                        "status": "ok",
                        "graph_loaded": self.app_state.graph is not None,
                        "repository": self.app_state.public_repository() if self.app_state.graph else None,
                        "ai": {
                            **self.app_state.ai_client.registry.public_status(),
                            "catalog": self._build_ai_catalog(fetch=False),
                        },
                        "github": {
                            "authenticated": self.app_state.github_client.authenticated,
                            "token_required": False,
                            "note": "A token only raises GitHub API rate limits; cloning and local analysis work without one.",
                        },
                        "neo4j": self.app_state.neo4j_configuration_status(),
                        "contributor_agents": len(self.app_state.agent_orchestrator.agents) if self.app_state.agent_orchestrator else 0,
                        "inspection": self.app_state.public_inspection(),
                    }
                )
            elif parsed.path == "/api/inspection":
                self._send_json({
                    "inspection": self.app_state.public_inspection(),
                    "summary": graph_summary(self.app_state) if self.app_state.graph else None,
                })
            elif parsed.path == "/api/ai/status":
                self._send_json(self.app_state.ai_client.registry.public_status())
            elif parsed.path == "/api/ai/providers":
                status = self.app_state.ai_client.registry.public_status()
                self._send_json({"providers": status.get("providers", []), "configured": self.app_state.ai_client.registry.configured})
            elif parsed.path == "/api/ai/catalog":
                params = parse_qs(parsed.query)
                refresh = params.get("refresh", ["0"])[0].lower() in {"1", "true", "yes"}
                catalog = self._build_ai_catalog(refresh=refresh)
                self._send_json(catalog)
            elif parsed.path == "/api/neo4j/status":
                params = parse_qs(parsed.query)
                check = params.get("check", ["1"])[0].lower() not in {"0", "false", "no"}
                status = (
                    self.app_state.neo4j_connection_status()
                    if check
                    else self.app_state.neo4j_configuration_status()
                )
                self._send_json(status)
            elif parsed.path == "/api/github/inspect":
                params = parse_qs(parsed.query)
                repository = (
                    params.get("url", [None])[0]
                    or params.get("github_url", [None])[0]
                    or params.get("repository", [None])[0]
                )
                if not repository:
                    raise ValueError("url is required.")
                max_commits = params.get("max_commits", [str(DEFAULT_WEB_MAX_COMMITS)])[0]
                async_requested = params.get("async", ["0"])[0].lower() in {"1", "true", "yes"}
                response = (
                    self.app_state.start_github_inspection(repository, int(max_commits))
                    if async_requested
                    else self._inspect_github(repository, max_commits)
                )
                self._send_json(response, HTTPStatus.ACCEPTED if async_requested else HTTPStatus.OK)
            elif parsed.path == "/api/github/progress":
                params = query
                job_id = params.get("job_id", [None])[0]
                if not job_id:
                    raise ValueError("job_id is required.")
                self._send_json(self.app_state.inspection_job(job_id))
            elif parsed.path == "/api/github/contributors":
                params = parse_qs(parsed.query)
                repository = (
                    params.get("url", [None])[0]
                    or params.get("github_url", [None])[0]
                    or params.get("repository", [None])[0]
                )
                if not repository:
                    raise ValueError("url is required.")
                self._send_json(self._load_github_contributors(repository))
            elif parsed.path == "/api/github/insights":
                params = parse_qs(parsed.query)
                repository = (
                    params.get("url", [None])[0]
                    or params.get("github_url", [None])[0]
                    or params.get("repository", [None])[0]
                )
                if not repository:
                    raise ValueError("url is required.")
                self._send_json(self._load_github_insights(repository))
            elif parsed.path == "/api/github/history":
                params = parse_qs(parsed.query)
                repository = (
                    params.get("url", [None])[0]
                    or params.get("github_url", [None])[0]
                    or params.get("repository", [None])[0]
                )
                if not repository:
                    raise ValueError("url is required.")
                self._send_json(self._load_github_history(repository))
            elif parsed.path == "/api/github/timeline":
                self._send_json(self._github_timeline_payload())
            elif parsed.path == "/api/repository/documents":
                self._send_json(_repository_documents(self.app_state))
            elif parsed.path == "/api/files":
                params = parse_qs(parsed.query)
                self._send_json(
                    _file_catalog(
                        self.app_state,
                        int(params.get("limit", [str(MAX_FILE_CATALOG)])[0]),
                        params.get("query", [""])[0],
                    )
                )
            elif parsed.path == "/api/agents":
                params = parse_qs(parsed.query)
                if self.app_state.agent_orchestrator is None:
                    self._send_json(
                        {
                            "agents": [],
                            "count": 0,
                            "available": False,
                            "message": "Verified contributor agents are available only after a fresh GitHub inspection.",
                        }
                    )
                else:
                    agents = self.app_state.require_agents().summaries(
                        params.get("query", [""])[0],
                        int(params.get("limit", ["250"])[0]),
                    )
                    self._send_json({"agents": agents, "count": len(self.app_state.require_agents().agents), "available": True})
            elif parsed.path.startswith("/api/agents/"):
                login = unquote(parsed.path.removeprefix("/api/agents/"))
                agent = self.app_state.require_agents().get(login)
                if agent is None:
                    self._error("Contributor agent not found.", HTTPStatus.NOT_FOUND)
                else:
                    self._send_json({"agent": agent.detail()})
            elif parsed.path == "/api/graph/summary":
                self._send_json(graph_summary(self.app_state))
            elif parsed.path == "/api/graph/view":
                self._send_json(graph_view(self.app_state, parse_qs(parsed.query)))
            elif parsed.path == "/api/graph":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", ["250"])[0])
                label = params.get("label", [None])[0]
                self._send_json(_public_graph(self.app_state.require_graph(), limit, label))
            elif parsed.path == "/api/entities":
                params = parse_qs(parsed.query)
                result = search_entities(
                    self.app_state.require_graph(),
                    params.get("query", [""])[0],
                    params.get("label", [None])[0],
                    int(params.get("limit", ["100"])[0]),
                )
                self._send_json({"entities": result})
            elif parsed.path == "/api/evidence/chain":
                params = parse_qs(parsed.query)
                node_id = params.get("entity_id", [None])[0]
                limit = int(params.get("limit", ["24"])[0])
                self._send_json(evidence_chain(self.app_state.require_graph(), node_id, limit))
            elif parsed.path == "/api/history/timeline":
                params = parse_qs(parsed.query)
                limit = int(params.get("limit", [str(DEFAULT_WEB_MAX_COMMITS)])[0])
                self._send_json(history_timeline(self.app_state.require_graph(), limit))
            elif parsed.path == "/api/commits/chronology":
                graph = self.app_state.require_graph()
                commit_nodes = [node for node in graph.get("nodes", []) if "Commit" in _labels(node)]
                commit_nodes.sort(key=lambda n: n.get("timestamp", ""))
                commits = [
                    {
                        "sha": n.get("id"),
                        "timestamp": n.get("timestamp"),
                        "message": n.get("message") or "Commit",
                        "author": n.get("author") or n.get("author_email") or "contributor",
                    }
                    for n in commit_nodes
                ]
                self._send_json({"commits": commits, "count": len(commits)})
            elif parsed.path.startswith("/api/entities/") and parsed.path.endswith("/evidence"):
                node_id = unquote(parsed.path[len("/api/entities/") : -len("/evidence")].rstrip("/"))
                graph = self.app_state.require_graph()
                if _find_node(graph, node_id) is None:
                    self._error("Entity not found.", HTTPStatus.NOT_FOUND)
                else:
                    self._send_json({"entity_id": node_id, "evidence": entity_evidence(graph, node_id)})
            elif parsed.path.startswith("/api/entities/"):
                node_id = unquote(parsed.path.removeprefix("/api/entities/"))
                detail = entity_detail(self.app_state.require_graph(), node_id)
                if detail is None:
                    self._error("Entity not found.", HTTPStatus.NOT_FOUND)
                else:
                    self._send_json(detail)
            elif parsed.path == "/api/source":
                params = parse_qs(parsed.query)
                relative_path = params.get("path", [""])[0]
                start = int(params.get("start_line", ["1"])[0])
                end = int(params.get("end_line", [str(start + MAX_SOURCE_LINES - 1)])[0])
                self._send_json(_safe_source(self.app_state, relative_path, start, end))
            elif parsed.path == "/api/source/raw":
                params = parse_qs(parsed.query)
                relative_path = params.get("path", [""])[0]
                body, content_type, filename = _safe_source_bytes(self.app_state, relative_path)
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                mode = params.get("mode", ["inline"])[0]
                disposition = "attachment" if mode == "download" else "inline"
                self.send_header("Content-Disposition", f'{disposition}; filename="{filename.replace(chr(34), "")}"')
                self.end_headers()
                self.wfile.write(body)
            elif parsed.path == "/api/storage/status":
                if self.app_state.storage is None:
                    repo_node = _repository_node(self.app_state.graph) if self.app_state.graph else None
                    name = (repo_node.get("name") if repo_node else None) or "default-repository"
                    self.app_state.storage = RepositoryStorage(name)
                self._send_json(self.app_state.storage.status())
            elif parsed.path == "/api/storage/repositories":
                self._send_json({"repositories": self.app_state.list_stored_repositories()})
            elif parsed.path == "/api/storage/vercel/status":
                client = VercelBlobStorage()
                blobs = []
                if client.configured:
                    try:
                        blobs = client.list_blobs(prefix="repositories/")
                    except Exception:
                        pass
                repos = set()
                for b in blobs:
                    pn = b.get("pathname", "")
                    parts = pn.split("/")
                    if len(parts) >= 2 and parts[0] == "repositories":
                        repos.add(parts[1])
                self._send_json({
                    "configured": client.configured,
                    "store_id": client.store_id,
                    "blob_count": len(blobs),
                    "repositories": sorted(list(repos)),
                })
            elif parsed.path == "/api/ai/chats":
                storage = self.app_state.get_or_create_storage()
                chats = storage.get_conversations() if storage else []
                self._send_json({"conversations": chats, "count": len(chats)})
            else:
                self._error("Route not found.", HTTPStatus.NOT_FOUND)
        except LookupError as error:
            self._error(str(error), HTTPStatus.CONFLICT)
        except PermissionError as error:
            self._error(str(error), HTTPStatus.FORBIDDEN)
        except FileNotFoundError as error:
            self._error(str(error), HTTPStatus.NOT_FOUND)
        except (GitHubError, GitHubInspectionError) as error:
            self._error(str(error), HTTPStatus.BAD_REQUEST)
        except (ValueError, TypeError) as error:
            self._error(str(error), HTTPStatus.BAD_REQUEST)

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urlsplit(self.path)
        try:
            payload = self._read_json()
            if parsed.path == "/api/ingest":
                repository = payload.get("repository_path") or payload.get("repository")
                if not isinstance(repository, str) or not repository.strip():
                    raise ValueError("repository_path is required.")
                max_commits = int(payload.get("max_commits", DEFAULT_WEB_MAX_COMMITS))
                if max_commits < 1 or max_commits > 10000:
                    raise ValueError("max_commits must be between 1 and 10000.")
                graph = ingest_repository(repository, max_commits=max_commits)
                self.app_state.set_graph(graph)
                self._send_json({"summary": graph_summary(self.app_state)})
            elif parsed.path in {"/api/github/inspect", "/api/github/import", "/api/github"}:
                repository = (
                    payload.get("github_url")
                    or payload.get("repository_url")
                    or payload.get("url")
                    or payload.get("repository")
                )
                if not isinstance(repository, str) or not repository.strip():
                    raise ValueError("github_url is required.")
                max_commits = int(payload.get("max_commits", DEFAULT_WEB_MAX_COMMITS))
                async_requested = payload.get("async") is True or str(payload.get("async", "")).lower() in {"1", "true", "yes"}
                response = (
                    self.app_state.start_github_inspection(repository, max_commits)
                    if async_requested
                    else self._inspect_github(repository, max_commits)
                )
                self._send_json(response, HTTPStatus.ACCEPTED if async_requested else HTTPStatus.OK)
            elif parsed.path == "/api/graph/load":
                graph_path = payload.get("graph_path")
                if not isinstance(graph_path, str) or not graph_path.strip():
                    raise ValueError("graph_path is required.")
                path = Path(graph_path).expanduser().resolve()
                graph = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
                    raise ValueError("Invalid Mnemo graph JSON.")
                self.app_state.set_graph(graph)
                self._send_json({"summary": graph_summary(self.app_state)})
            elif parsed.path == "/api/storage/open":
                repo = (
                    payload.get("repository")
                    or payload.get("repo_name")
                    or payload.get("name")
                    or payload.get("folder")
                )
                if not isinstance(repo, str) or not repo.strip():
                    raise ValueError("repository name is required.")
                result = self.app_state.load_from_storage(repo.strip())
                self._send_json(result)
            elif parsed.path == "/api/storage/vercel/save":
                client = VercelBlobStorage()
                if not client.configured:
                    raise ValueError("Vercel Blob Storage is not configured (missing BLOB_READ_WRITE_TOKEN).")
                repo = (
                    payload.get("repository")
                    or payload.get("repo_name")
                    or (self.app_state.storage.repo_name if self.app_state.storage else None)
                )
                if not repo and self.app_state.graph:
                    repo_node = _repository_node(self.app_state.graph)
                    repo = repo_node.get("name") if repo_node else None
                if not repo:
                    raise ValueError("No active repository to save to Vercel Storage.")
                storage = RepositoryStorage(repo)
                result = client.backup_repository(storage)
                self._send_json(result)
            elif parsed.path == "/api/storage/vercel/restore":
                client = VercelBlobStorage()
                if not client.configured:
                    raise ValueError("Vercel Blob Storage is not configured (missing BLOB_READ_WRITE_TOKEN).")
                repo = payload.get("repository") or payload.get("repo_name")
                if not repo or not isinstance(repo, str):
                    raise ValueError("repository name is required to restore from Vercel Storage.")
                result = client.restore_repository(repo.strip())
                load_res = self.app_state.load_from_storage(repo.strip())
                self._send_json({**result, "loaded": load_res.get("status") == "ok", "summary": load_res.get("summary")})
            elif parsed.path == "/api/ai/room":
                question = payload.get("question")
                if not isinstance(question, str) or not question.strip():
                    raise ValueError("question is required.")
                graph = self.app_state.require_graph()
                result = query_graph(graph, question.strip())
                orchestrator = self.app_state.agent_orchestrator
                if orchestrator is None:
                    orchestrator = ContributorOrchestrator.from_inspection(self.app_state.inspection or {}, graph)
                    self.app_state.agent_orchestrator = orchestrator
                orchestration = orchestrator.ask(
                    question.strip(),
                    result.get("target") if isinstance(result, dict) else None,
                    graph=graph,
                    ai_requested=bool(payload.get("ai_assist")),
                )
                ai_result = None
                rag_chunks = []
                storage = self.app_state.get_or_create_storage()
                if storage is not None:
                    try:
                        target_id = result.get("target", {}).get("id") if isinstance(result.get("target"), dict) else None
                        nids = [target_id] if target_id else []
                        rag_chunks = storage.retrieve_rag_chunks(question.strip(), graph_node_ids=nids, top_k=5)
                    except Exception:
                        rag_chunks = []
                if payload.get("ai_assist"):
                    ai_result = self.app_state.ai_client.explain(
                        question.strip(),
                        result,
                        provider=payload.get("provider") if isinstance(payload.get("provider"), str) else None,
                        model=payload.get("model") if isinstance(payload.get("model"), str) else None,
                        context={
                            "repository": graph_summary(self.app_state),
                            "orchestration": orchestration,
                            "timeline": orchestration.get("timeline"),
                            "architecture": (self.app_state.public_inspection() or {}).get("analysis", {}).get("architecture", {}),
                            "rag_chunks": rag_chunks,
                        },
                    )
                    attach_ai_result(orchestration, ai_result)
                if storage is not None:
                    try:
                        answer_text = (ai_result.get("text") if isinstance(ai_result, dict) and ai_result.get("text") else result.get("answer", ""))
                        storage.save_ai_chat(
                            question=question.strip(),
                            answer=answer_text,
                            provider=payload.get("provider"),
                            model=payload.get("model"),
                            retrieved_nodes=[result.get("target", {}).get("id")] if isinstance(result.get("target"), dict) and result.get("target", {}).get("id") else [],
                            retrieved_chunks=rag_chunks,
                            confidence=result.get("confidence"),
                        )
                    except Exception:
                        pass
                self._send_json({"result": result, "orchestration": orchestration, "ai": ai_result, "rag_chunks": rag_chunks})
            elif parsed.path == "/api/ask":
                question = payload.get("question")
                if not isinstance(question, str) or not question.strip():
                    raise ValueError("question is required.")
                graph = self.app_state.require_graph()
                result = query_graph(graph, question.strip())
                orchestrator = self.app_state.agent_orchestrator
                if orchestrator is None and graph:
                    orchestrator = ContributorOrchestrator.from_inspection(self.app_state.inspection or {}, graph)
                    self.app_state.agent_orchestrator = orchestrator
                orchestration = None
                if result.get("status") != "chat" and orchestrator is not None:
                    orchestration = orchestrator.ask(
                        question.strip(),
                        result.get("target") if isinstance(result, dict) else None,
                        graph=graph,
                    )
                ai_result = None
                rag_chunks = []
                storage = self.app_state.get_or_create_storage()
                if storage is not None:
                    try:
                        target_id = result.get("target", {}).get("id") if isinstance(result.get("target"), dict) else None
                        nids = [target_id] if target_id else []
                        rag_chunks = storage.retrieve_rag_chunks(question.strip(), graph_node_ids=nids, top_k=5)
                    except Exception:
                        rag_chunks = []
                if payload.get("ai_assist"):
                    ai_result = self.app_state.ai_client.explain(
                        question.strip(),
                        result,
                        provider=payload.get("provider") if isinstance(payload.get("provider"), str) else None,
                        model=payload.get("model") if isinstance(payload.get("model"), str) else None,
                        context={
                            "repository": graph_summary(self.app_state),
                            "orchestration": orchestration,
                            "architecture": (self.app_state.public_inspection() or {}).get("analysis", {}).get("architecture", {}),
                            "rag_chunks": rag_chunks,
                        },
                    )
                if storage is not None:
                    try:
                        answer_text = (ai_result.get("text") if isinstance(ai_result, dict) and ai_result.get("text") else result.get("answer", ""))
                        storage.save_ai_chat(
                            question=question.strip(),
                            answer=answer_text,
                            provider=payload.get("provider"),
                            model=payload.get("model"),
                            retrieved_nodes=[result.get("target", {}).get("id")] if isinstance(result.get("target"), dict) and result.get("target", {}).get("id") else [],
                            retrieved_chunks=rag_chunks,
                            confidence=result.get("confidence"),
                        )
                    except Exception:
                        pass
                self._send_json({"result": result, "orchestration": orchestration, "ai": ai_result, "rag_chunks": rag_chunks})
            elif parsed.path == "/api/neo4j/sync":
                graph = self.app_state.require_graph()
                client = self.app_state.require_neo4j_client()
                connection = client.check_connection()
                if not connection.get("connected"):
                    raise Neo4jError(connection.get("error", "Neo4j is not reachable."))
                sync_result = client.sync_graph(graph)
                self._send_json(
                    {
                        "status": "synced",
                        "connection": connection,
                        "sync": sync_result.as_dict(),
                    }
                )
            else:
                self._error("Route not found.", HTTPStatus.NOT_FOUND)
        except IngestionError as error:
            self._error(str(error), HTTPStatus.BAD_REQUEST)
        except (GitHubError, GitHubInspectionError) as error:
            self._error(str(error), HTTPStatus.BAD_REQUEST)
        except LookupError as error:
            self._error(str(error), HTTPStatus.CONFLICT)
        except Neo4jError as error:
            self._error(str(error), HTTPStatus.BAD_GATEWAY)
        except (OSError, PermissionError, ValueError, TypeError, json.JSONDecodeError) as error:
            self._error(str(error), HTTPStatus.BAD_REQUEST)

    def _inspect_github(self, repository: str, max_commits: Any) -> dict[str, Any]:
        try:
            bounded_max_commits = int(max_commits)
        except (TypeError, ValueError) as error:
            raise ValueError("max_commits must be an integer.") from error
        result = inspect_github_repository(
            repository,
            github_client=self.app_state.github_client,
            repository_cache=self.app_state.repository_cache,
            max_commits=bounded_max_commits,
        )
        self.app_state.set_inspection(result)
        graph = self.app_state.require_graph()
        return {
            "inspection": self.app_state.public_inspection(),
            "summary": graph_summary(self.app_state),
            "graph": _public_graph(graph, limit=1000),
        }

    def _github_timeline_payload(self) -> dict[str, Any]:
        """Return the compact pull request + commit history for the timeline view."""

        inspection = self.app_state.public_inspection() or {}
        github = inspection.get("github") or {}
        pull_requests: list[dict[str, Any]] = []
        for pull in github.get("pull_requests") or []:
            if not isinstance(pull, dict):
                continue
            user = pull.get("user") if isinstance(pull.get("user"), dict) else {}
            body = pull.get("body") or ""
            labels = [
                label.get("name")
                for label in pull.get("labels") or []
                if isinstance(label, dict) and label.get("name")
            ]
            pull_requests.append(
                {
                    "number": pull.get("number"),
                    "title": pull.get("title") or "Pull request",
                    "state": pull.get("state") or "open",
                    "draft": bool(pull.get("draft")),
                    "created_at": pull.get("created_at"),
                    "updated_at": pull.get("updated_at"),
                    "closed_at": pull.get("closed_at"),
                    "merged_at": pull.get("merged_at"),
                    "html_url": pull.get("html_url"),
                    "user": {"login": user.get("login")} if user.get("login") else None,
                    "labels": labels[:6],
                    "body": body[:600],
                }
            )
        commits: list[dict[str, Any]] = []
        for commit in github.get("commits") or []:
            if not isinstance(commit, dict):
                continue
            author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
            commits.append(
                {
                    "sha": commit.get("sha"),
                    "message": (commit.get("message") or "Repository change").splitlines()[0],
                    "date": commit.get("date"),
                    "author": author.get("login") or author.get("name") or "",
                    "html_url": commit.get("html_url"),
                }
            )
        releases: list[dict[str, Any]] = []
        for release in github.get("releases") or []:
            if not isinstance(release, dict):
                continue
            releases.append(
                {
                    "tag_name": release.get("tag_name") or release.get("name"),
                    "name": release.get("name") or release.get("tag_name"),
                    "published_at": release.get("published_at") or release.get("created_at"),
                    "html_url": release.get("html_url"),
                }
            )
        return {
            "repository": inspection.get("repository") or {},
            "pull_requests": pull_requests,
            "releases": releases,
            "commits": commits,
            "summary": github.get("pull_request_summary") or {},
            "github": {
                "history_loaded": bool(github.get("history_loaded")),
                "history_status": github.get("history_status", "not_requested"),
                "insights_loaded": bool(github.get("insights_loaded")),
                "insights_status": github.get("insights_status", "not_requested"),
                "coverage": github.get("coverage") or {},
            },
        }

    def _load_github_insights(self, repository: str) -> dict[str, Any]:
        self._assert_active_github_repository(repository)
        metadata = self.app_state.github_client.inspect_insights(repository)
        self.app_state.merge_github_insights(metadata)
        return {
            "inspection": self.app_state.public_inspection(),
            "github": metadata,
        }

    def _load_github_contributors(self, repository: str) -> dict[str, Any]:
        self._assert_active_github_repository(repository)
        inspector = getattr(self.app_state.github_client, "inspect_contributors", None)
        if callable(inspector):
            metadata = inspector(repository)
        else:
            try:
                metadata = self.app_state.github_client.inspect(
                    repository,
                    include_core=False,
                    include_history=False,
                    include_insights=False,
                )
            except TypeError:
                metadata = self.app_state.github_client.inspect(repository)
        self.app_state.merge_github_contributors(metadata)
        return {
            "inspection": self.app_state.public_inspection(),
            "github": metadata,
        }

    def _load_github_history(self, repository: str) -> dict[str, Any]:
        self._assert_active_github_repository(repository)
        metadata = self.app_state.github_client.inspect_history(repository)
        self.app_state.merge_github_history(metadata)
        return {
            "inspection": self.app_state.public_inspection(),
            "github": metadata,
        }

    def _assert_active_github_repository(self, repository: str) -> None:
        active = self.app_state.public_inspection()
        if not active:
            raise LookupError("No GitHub inspection is loaded yet.")
        requested = parse_github_repository(repository).full_name.lower()
        github = active.get("github") if isinstance(active.get("github"), dict) else {}
        metadata = github.get("repository") if isinstance(github.get("repository"), dict) else {}
        current = metadata.get("full_name") or active.get("repository", {}).get("full_name")
        if current and str(current).lower() != requested:
            raise ValueError("The requested GitHub repository does not match the active workspace.")

    def _build_ai_catalog(self, *, refresh: bool = False, fetch: bool = True) -> dict[str, Any]:
        """Return the current server-fetched catalog without exposing secrets."""

        registry = self.app_state.ai_client.registry
        catalog = self.app_state.ai_client.model_catalog(refresh=refresh) if fetch else self.app_state.ai_client.cached_model_catalog()
        return {
            **catalog,
            "configured_providers": registry.configured,
            "available_providers": registry.available(),
        }

    def _serve_static(self, relative_path: str, root: Path = WEB_ROOT) -> None:
        candidate = (root / relative_path).resolve()
        try:
            candidate.relative_to(root.resolve())
        except ValueError as error:
            raise PermissionError("Static path escapes the web root.") from error
        if not candidate.is_file():
            self._error("Static asset not found.", HTTPStatus.NOT_FOUND)
            return
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self._send_bytes(candidate.read_bytes(), f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)


class MnemoHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: AppState) -> None:
        super().__init__(address, MnemoRequestHandler)
        self.app_state = state


def create_server(host: str = "127.0.0.1", port: int = 8000, state: AppState | None = None) -> MnemoHTTPServer:
    return MnemoHTTPServer((host, port), state or AppState())


def serve(host: str = "127.0.0.1", port: int = 8000, state: AppState | None = None) -> None:
    server = create_server(host, port, state)
    print(f"Mnemo web interface: http://{host}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nMnemo server stopped.")
    finally:
        server.server_close()
