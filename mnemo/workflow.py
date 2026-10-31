"""GitHub-first repository inspection workflow."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .analysis import analyze_repository
from .github import GitHubClient, GitHubRepository, parse_github_repository
from .ingest import IngestionError, ingest_repository
from .repository import RepositoryCache, RepositoryCacheError
from .storage import RepositoryStorage


class GitHubInspectionError(RuntimeError):
    """Raised when the local checkout or deterministic ingest cannot complete."""


def inspect_github_repository(
    repository: GitHubRepository | str,
    *,
    github_client: GitHubClient | Any | None = None,
    repository_cache: RepositoryCache | Any | None = None,
    max_commits: int = 500,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Inspect GitHub metadata, cache the checkout, ingest it, and analyze it."""

    if max_commits < 1 or max_commits > 10_000:
        raise GitHubInspectionError("max_commits must be between 1 and 10000.")
    parsed = parse_github_repository(repository) if isinstance(repository, str) else repository
    if not isinstance(parsed, GitHubRepository):
        raise GitHubInspectionError("Invalid GitHub repository reference.")

    client = github_client or GitHubClient()
    def report(stage: str, status: str, message: str, **extra: Any) -> None:
        if progress_callback is None:
            return
        try:
            progress_callback({"event": "stage", "stage": stage, "status": status, "message": message, **extra})
        except Exception:
            pass

    report("metadata", "active", "Collecting bounded repository metadata.")
    inspect_core = getattr(client, "inspect_core", None)
    if callable(inspect_core):
        try:
            metadata = inspect_core(parsed, progress_callback=progress_callback)
        except TypeError:
            # Keep compatible fake/test clients that still expose the older
            # single-argument inspect_core contract.
            metadata = inspect_core(parsed)
    else:
        metadata = client.inspect(parsed)
    report(
        "metadata",
        "complete",
        "Repository metadata collected.",
        counts={
            "contributors": len(metadata.get("contributors", [])),
            "commits": len(metadata.get("commits", [])),
        },
    )
    cache = repository_cache or RepositoryCache()
    cache_path = cache.path_for(parsed)
    was_cached = cache_path.exists()
    try:
        report("checkout", "active", "Refreshing the local repository cache.")
        local_path = cache.clone_or_update(
            parsed,
            default_branch=metadata.get("repository", {}).get("default_branch"),
        )
        report("checkout", "complete", "Local checkout is ready.")
        report("source", "active", "Indexing tracked files and commit relationships.")
        graph = ingest_repository(local_path, max_commits=max_commits)
        report(
            "source",
            "complete",
            "Source files and local history collected.",
            counts={
                "files": sum("File" in node.get("labels", []) for node in graph.get("nodes", [])),
                "commits": sum("Commit" in node.get("labels", []) for node in graph.get("nodes", [])),
                "functions": sum("Function" in node.get("labels", []) for node in graph.get("nodes", [])),
                "edges": len(graph.get("edges", [])),
            },
        )
        report("analysis", "active", "Linking modules, imports, and architecture evidence.")
        analysis = analyze_repository(local_path, graph)
        report(
            "analysis",
            "complete",
            "Architecture analysis is ready.",
            counts={
                "imports": analysis.get("summary", {}).get("import_count", 0),
                "modules": analysis.get("summary", {}).get("module_count", 0),
            },
        )
    except (RepositoryCacheError, IngestionError, OSError) as error:
        raise GitHubInspectionError(str(error)) from error

    try:
        storage = RepositoryStorage(parsed.cache_key)
        storage.save_all(
            parsed.as_dict(),
            local_path=local_path,
            graph=graph,
            inspection_metadata={"github": metadata},
            analysis=analysis,
        )
    except Exception:
        pass

    return {
        "repository": parsed.as_dict(),
        "github": metadata,
        "analysis": analysis,
        "graph": graph,
        "freshness": {
            "inspected_at": datetime.now(timezone.utc).isoformat(),
            "github_api_authenticated": bool(metadata.get("request", {}).get("authenticated")),
            "checkout_refreshed": True,
            "errors": metadata.get("errors", {}),
        },
        "cache": {
            "key": parsed.cache_key,
            "reused": was_cached,
        },
        # Kept server-side by web.py; callers of this function can use it for
        # local post-processing without exposing a host path in JSON APIs.
        "_local_path": str(Path(local_path).resolve()),
    }


def public_inspection(result: dict[str, Any]) -> dict[str, Any]:
    """Remove local-only fields before an inspection crosses the web boundary."""

    return {
        key: value
        for key, value in result.items()
        if key not in {"graph", "_local_path"}
    }
