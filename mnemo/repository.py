"""Git-backed local cache for GitHub repositories."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from .github import GitHubRepository, parse_github_repository


class RepositoryCacheError(RuntimeError):
    """Raised when a cached repository cannot be safely prepared."""


_BRANCH_PATTERN = re.compile(r"^[A-Za-z0-9._/-]+$")


def _run_git(args: list[str], *, cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError as error:
        raise RepositoryCacheError("Git executable is not installed or available in this environment.") from error
    if result.returncode != 0:
        # Do not include git's remote URL or stderr. A pre-existing local
        # configuration could contain a credential even though Mnemo never
        # puts one in its own clone URL.
        raise RepositoryCacheError("Git could not prepare the repository cache.")
    return result.stdout.strip()


def _remote_identity(value: str) -> tuple[str, str] | None:
    raw = value.strip()
    if raw.startswith("git@github.com:"):
        path = raw.removeprefix("git@github.com:")
    else:
        parsed = urlsplit(raw)
        if parsed.scheme not in {"https", "http"} or parsed.netloc.lower() != "github.com":
            return None
        if parsed.username or parsed.password:
            return None
        path = parsed.path.lstrip("/")
    path = path.removesuffix(".git").strip("/")
    pieces = path.split("/")
    if len(pieces) != 2 or not all(pieces):
        return None
    return pieces[0].lower(), pieces[1].lower()


class RepositoryCache:
    """Clone and refresh repositories below one local cache root."""

    def __init__(self, root: str | Path | None = None) -> None:
        configured = root or os.environ.get("MNEMO_REPOSITORY_CACHE") or os.environ.get("MNEMO_CACHE_DIR")
        if configured:
            self.root = Path(configured).expanduser()
        elif os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
            self.root = Path("/tmp/mnemo/repositories")
        else:
            try:
                candidate = Path.home() / ".cache" / "mnemo" / "repositories"
                candidate.mkdir(parents=True, exist_ok=True)
                self.root = candidate
            except Exception:
                import tempfile
                self.root = Path(tempfile.gettempdir()) / "mnemo" / "repositories"

    def path_for(self, repository: GitHubRepository | str) -> Path:
        parsed = parse_github_repository(repository) if isinstance(repository, str) else repository
        if not isinstance(parsed, GitHubRepository):
            raise RepositoryCacheError("Invalid GitHub repository reference.")
        return self.root / parsed.cache_key

    def _verify_remote(self, path: Path, repository: GitHubRepository) -> None:
        remote = _run_git(["-C", str(path), "remote", "get-url", "origin"])
        if _remote_identity(remote) != (repository.owner.lower(), repository.name.lower()):
            raise RepositoryCacheError("The cached repository belongs to a different GitHub repository.")

    def clone_or_update(
        self,
        repository: GitHubRepository | str,
        *,
        default_branch: str | None = None,
    ) -> Path:
        """Return a local checkout, cloning once and fetching later uses."""

        parsed = parse_github_repository(repository) if isinstance(repository, str) else repository
        if not isinstance(parsed, GitHubRepository):
            raise RepositoryCacheError("Invalid GitHub repository reference.")
        path = self.path_for(parsed)
        try:
            self.root.mkdir(parents=True, exist_ok=True)
        except OSError:
            import tempfile
            self.root = Path(tempfile.gettempdir()) / "mnemo" / "repositories"
            try:
                self.root.mkdir(parents=True, exist_ok=True)
                path = self.path_for(parsed)
            except OSError as error:
                raise RepositoryCacheError("The repository cache directory is not writable.") from error

        if not path.exists():
            try:
                result = subprocess.run(
                    ["git", "clone", "--no-tags", "--quiet", parsed.clone_url, str(path)],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
            except FileNotFoundError as error:
                raise RepositoryCacheError("Git executable is not installed or available in this environment.") from error
            if result.returncode != 0:
                raise RepositoryCacheError("Git could not clone the GitHub repository.")
            return path

        if not path.is_dir():
            raise RepositoryCacheError("The repository cache path is not a directory.")
        try:
            _run_git(["-C", str(path), "rev-parse", "--is-inside-work-tree"])
            self._verify_remote(path, parsed)
            _run_git(["-C", str(path), "fetch", "--quiet", "--prune", "--no-tags", "origin"])
            if default_branch and _BRANCH_PATTERN.fullmatch(default_branch) and ".." not in default_branch:
                # The cache is owned by Mnemo, so keeping the checkout on the
                # current default branch makes subsequent deterministic ingest
                # runs reflect the newest fetched repository state.
                _run_git(
                    [
                        "-C",
                        str(path),
                        "checkout",
                        "--quiet",
                        "--force",
                        "-B",
                        default_branch,
                        f"origin/{default_branch}",
                    ]
                )
                _run_git(["-C", str(path), "reset", "--hard", "--quiet", f"origin/{default_branch}"])
        except RepositoryCacheError:
            raise
        except (OSError, subprocess.SubprocessError) as error:
            raise RepositoryCacheError("Git could not update the repository cache.") from error
        return path


def clone_or_update_repository(
    repository: GitHubRepository | str,
    *,
    cache_dir: str | Path | None = None,
    default_branch: str | None = None,
) -> Path:
    """Convenience wrapper around :class:`RepositoryCache`."""

    return RepositoryCache(cache_dir).clone_or_update(repository, default_branch=default_branch)
