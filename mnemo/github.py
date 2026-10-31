"""Small, safe GitHub REST API client for public repository inspection.

The client deliberately uses only the Python standard library.  It keeps the
GitHub token in memory for request headers, never puts it in a URL or error
message, and returns bounded collections so an inspection cannot accidentally
turn into an unbounded API crawl.
"""

from __future__ import annotations

import base64
import binascii
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from .ai import parse_env_file


GITHUB_API_URL = "https://api.github.com"
GITHUB_API_VERSION = "2022-11-28"
DEFAULT_USER_AGENT = "Mnemo-GitHub-Client/0.1"
DEFAULT_PAGE_SIZE = 100
DEFAULT_MAX_PAGES = 2
DEFAULT_CONTRIBUTOR_MAX_PAGES = 50
FULL_HISTORY_MAX_PAGES = 50
CORE_HISTORY_MAX_PAGES = 2
CORE_CONTRIBUTOR_MAX_PAGES = 2
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_README_CHARS = 250_000
PACKAGE_TYPES = ("container", "npm", "maven", "nuget", "rubygems", "docker")
DEFAULT_PARALLEL_REQUESTS = 8
DISCUSSION_MAX_PAGES = 10
ProgressCallback = Callable[[dict[str, Any]], None]

GITHUB_INSIGHT_KEYS = (
    "forks",
    "discussions",
    "workflows",
    "workflow_runs",
    "actions_usage",
    "community_profile",
    "traffic",
    "dependency_graph",
    "packages",
    "code_frequency",
    "commit_activity",
    "participation",
    "punch_card",
)

GITHUB_HISTORY_KEYS = (
    "commits",
    "pull_requests",
    "issues",
    "releases",
    "tags",
    "deployments",
    "events",
    "pull_request_summary",
    "contributor_activity",
)

HISTORY_ERROR_KEYS = {
    "commits",
    "pull_requests",
    "issues",
    "releases",
    "tags",
    "deployments",
    "events",
}

INSIGHT_ERROR_KEYS = {
    "forks",
    "discussions",
    "workflows",
    "workflow_runs",
    "actions_usage",
    "community_profile",
    "traffic_views",
    "traffic_clones",
    "traffic_paths",
    "traffic_referrers",
    "sbom",
    "code_frequency",
    "commit_activity",
    "participation",
    "punch_card",
    "packages",
}
INSIGHT_ERROR_KEYS.update(f"packages:{package_type}" for package_type in PACKAGE_TYPES)

_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")


class GitHubError(RuntimeError):
    """Base class for safe GitHub workflow errors."""


class GitHubURLParseError(GitHubError, ValueError):
    """Raised when an input is not a supported GitHub repository reference."""


class GitHubRequestError(GitHubError):
    """Raised for an individual GitHub API request failure.

    Only the HTTP status and a short, endpoint-independent message are kept so
    an upstream response cannot accidentally echo credentials or large bodies.
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class GitHubRepository:
    """Normalized owner/repository identity accepted by the workflow."""

    owner: str
    name: str

    @property
    def repo(self) -> str:
        """Compatibility alias for callers that use ``repo`` terminology."""

        return self.name

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def web_url(self) -> str:
        return f"https://github.com/{self.owner}/{self.name}"

    @property
    def clone_url(self) -> str:
        return f"{self.web_url}.git"

    @property
    def api_path(self) -> str:
        return f"/repos/{urllib.parse.quote(self.owner, safe='')}/{urllib.parse.quote(self.name, safe='')}"

    @property
    def cache_key(self) -> str:
        return f"{self.owner.lower()}--{self.name.lower()}"

    def as_dict(self) -> dict[str, str]:
        return {
            "owner": self.owner,
            "name": self.name,
            "full_name": self.full_name,
            "url": self.web_url,
            "clone_url": self.clone_url,
        }


def parse_github_repository(value: str) -> GitHubRepository:
    """Parse ``owner/repo`` or an HTTPS ``github.com/owner/repo`` URL."""

    if not isinstance(value, str) or not value.strip():
        raise GitHubURLParseError("A GitHub repository URL or owner/repo is required.")

    raw = value.strip()
    candidate = raw if "://" in raw else f"https://github.com/{raw}"
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.scheme != "https" or parsed.netloc.lower() != "github.com":
        raise GitHubURLParseError("Use an HTTPS GitHub URL or owner/repo shorthand.")
    if parsed.username or parsed.password:
        raise GitHubURLParseError("GitHub repository URLs must not include credentials.")
    if parsed.query or parsed.fragment:
        raise GitHubURLParseError("GitHub repository references must not include a query or fragment.")

    segments = [urllib.parse.unquote(segment) for segment in parsed.path.split("/") if segment]
    if len(segments) != 2:
        raise GitHubURLParseError("GitHub repository references must contain exactly owner/repo.")
    owner, name = segments
    if name.endswith(".git"):
        name = name[:-4]
    if not owner or not name or not _NAME_PATTERN.fullmatch(owner) or not _NAME_PATTERN.fullmatch(name):
        raise GitHubURLParseError("GitHub owner and repository names contain unsupported characters.")
    return GitHubRepository(owner=owner, name=name)


# This name is intentionally exported because it reads naturally at API call
# sites and makes the accepted input contract easy to discover.
parse_github_url = parse_github_repository


def _safe_error(error: GitHubRequestError) -> dict[str, Any]:
    payload: dict[str, Any] = {"message": error.message}
    if error.status is not None:
        payload["status"] = error.status
    return payload


def _coverage_record(
    collection: str,
    value: Any,
    *,
    requested_from: str | None,
    requested_until: str,
    complete: bool = False,
    reason: str | None = None,
) -> dict[str, Any]:
    """Describe what the API snapshot actually covers without overclaiming."""

    items = value if isinstance(value, list) else []
    timestamps: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        for key in ("updated_at", "updatedAt", "created_at", "createdAt", "date", "published_at"):
            if item.get(key):
                timestamps.append(str(item[key]))
                break
    observed_until = max(timestamps) if timestamps else None
    return {
        "collection": collection,
        "requested_from": requested_from,
        "requested_until": requested_until,
        "observed_until": observed_until,
        "count": len(items),
        "complete": complete,
        "truncated": not complete,
        "reason": reason or "Bounded API snapshot; GitHub does not expose complete historical data for every collection.",
    }


def _user(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    return {
        key: value.get(key)
        for key in ("login", "id", "name", "email", "avatar_url", "html_url", "type")
        if value.get(key) is not None
    } or None


def normalize_repository(payload: Any) -> dict[str, Any]:
    """Normalize the repository endpoint into a stable, non-secret shape."""

    if not isinstance(payload, dict):
        return {}
    owner = _user(payload.get("owner"))
    result: dict[str, Any] = {
        key: payload.get(key)
        for key in (
            "id",
            "node_id",
            "name",
            "full_name",
            "private",
            "fork",
            "archived",
            "description",
            "default_branch",
            "html_url",
            "clone_url",
            "ssh_url",
            "language",
            "size",
            "stargazers_count",
            "watchers_count",
            "forks_count",
            "open_issues_count",
            "subscribers_count",
            "created_at",
            "updated_at",
            "pushed_at",
        )
        if payload.get(key) is not None
    }
    if owner:
        result["owner"] = owner
    license_payload = payload.get("license")
    if isinstance(license_payload, dict):
        result["license"] = {
            key: license_payload.get(key)
            for key in ("key", "name", "spdx_id", "url")
            if license_payload.get(key) is not None
        }
    topics = payload.get("topics")
    if isinstance(topics, list):
        result["topics"] = [str(topic) for topic in topics[:100]]
    return result


def normalize_readme(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    content = payload.get("content")
    decoded: str | None = None
    truncated = False
    if isinstance(content, str):
        try:
            decoded = base64.b64decode(content.replace("\n", ""), validate=False).decode("utf-8", errors="replace")
        except (binascii.Error, ValueError):
            decoded = None
    if decoded is not None and len(decoded) > MAX_README_CHARS:
        decoded = decoded[:MAX_README_CHARS]
        truncated = True
    return {
        key: payload.get(key)
        for key in ("name", "path", "sha", "size", "encoding", "html_url", "download_url")
        if payload.get(key) is not None
    } | {"content": decoded, "truncated": truncated}


def normalize_contributor(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload.get(key)
        for key in ("login", "id", "node_id", "avatar_url", "html_url", "type", "contributions")
        if payload.get(key) is not None
    }


def normalize_contributor_stat(payload: Any) -> dict[str, Any]:
    """Normalize the richer stats/contributors response."""

    if not isinstance(payload, dict):
        return {}
    author = _user(payload.get("author"))
    if not author or not author.get("login"):
        return {}
    return {
        key: author.get(key)
        for key in ("login", "id", "node_id", "name", "email", "avatar_url", "html_url", "type")
        if author.get(key) is not None
    } | {
        "contributions": payload.get("total", 0),
        "source": "stats/contributors",
    }


def normalize_commit(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    commit = payload.get("commit") if isinstance(payload.get("commit"), dict) else {}
    author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    committer = commit.get("committer") if isinstance(commit.get("committer"), dict) else {}
    return {
        "sha": payload.get("sha"),
        "html_url": payload.get("html_url"),
        "url": payload.get("url"),
        "message": commit.get("message"),
        "date": author.get("date") or committer.get("date"),
        "author": _user(payload.get("author"))
        or {
            key: author.get(key)
            for key in ("name", "email", "date")
            if author.get(key) is not None
        },
        "committer": _user(payload.get("committer"))
        or {
            key: committer.get(key)
            for key in ("name", "email", "date")
            if committer.get(key) is not None
        },
    }


def normalize_pull_request(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    result = {
        key: payload.get(key)
        for key in (
            "number",
            "title",
            "body",
            "state",
            "draft",
            "locked",
            "html_url",
            "created_at",
            "updated_at",
            "closed_at",
            "merged_at",
            "merge_commit_sha",
            "mergeable",
            "mergeable_state",
            "rebaseable",
            "comments",
            "review_comments",
            "commits",
            "additions",
            "deletions",
            "changed_files",
        )
        if payload.get(key) is not None
    }
    for name in ("user", "assignee", "merged_by"):
        user = _user(payload.get(name))
        if user:
            result[name] = user
    for name in ("head", "base"):
        branch = payload.get(name)
        if isinstance(branch, dict):
            result[name] = {
                key: branch.get(key)
                for key in ("label", "ref", "sha", "repo")
                if branch.get(key) is not None
            }
    labels = payload.get("labels")
    if isinstance(labels, list):
        result["labels"] = [label.get("name") for label in labels if isinstance(label, dict) and label.get("name")]
    return result


def normalize_issue(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    result = {
        key: payload.get(key)
        for key in (
            "number",
            "title",
            "body",
            "state",
            "locked",
            "html_url",
            "created_at",
            "updated_at",
            "closed_at",
            "comments",
        )
        if payload.get(key) is not None
    }
    if "pull_request" in payload:
        result["_is_pull_request"] = True
    user = _user(payload.get("user"))
    if user:
        result["user"] = user
    labels = payload.get("labels")
    if isinstance(labels, list):
        result["labels"] = [label.get("name") for label in labels if isinstance(label, dict) and label.get("name")]
    return result


def normalize_release(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    result = {
        key: payload.get(key)
        for key in (
            "id",
            "tag_name",
            "target_commitish",
            "name",
            "body",
            "draft",
            "prerelease",
            "created_at",
            "published_at",
            "html_url",
            "tarball_url",
            "zipball_url",
        )
        if payload.get(key) is not None
    }
    author = _user(payload.get("author"))
    if author:
        result["author"] = author
    return result


def normalize_tag(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    commit = payload.get("commit") if isinstance(payload.get("commit"), dict) else {}
    return {
        key: payload.get(key)
        for key in ("name", "zipball_url", "tarball_url")
        if payload.get(key) is not None
    } | {
        "commit": {
            key: commit.get(key)
            for key in ("sha", "url")
            if commit.get(key) is not None
        }
    }


def normalize_branch(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    commit = payload.get("commit") if isinstance(payload.get("commit"), dict) else {}
    return {
        key: payload.get(key)
        for key in ("name", "protected")
        if payload.get(key) is not None
    } | {
        "commit": {
            key: commit.get(key)
            for key in ("sha", "url")
            if commit.get(key) is not None
        }
    }


def normalize_event(payload: Any) -> dict[str, Any]:
    """Keep the repository event fields needed for a truthful push timeline."""

    if not isinstance(payload, dict):
        return {}
    actor = _user(payload.get("actor"))
    event_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    commits = event_payload.get("commits") if isinstance(event_payload.get("commits"), list) else []
    return {
        key: payload.get(key)
        for key in ("id", "type", "created_at", "public")
        if payload.get(key) is not None
    } | {
        "actor": actor,
        "ref": event_payload.get("ref"),
        "before": event_payload.get("before"),
        "head": event_payload.get("head"),
        "size": event_payload.get("size"),
        "distinct_size": event_payload.get("distinct_size"),
        "commits": [
            {
                key: commit.get(key)
                for key in ("sha", "message", "distinct")
                if isinstance(commit, dict) and commit.get(key) is not None
            }
            for commit in commits[:100]
            if isinstance(commit, dict)
        ],
    }


def normalize_deployment(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    result = {
        key: payload.get(key)
        for key in (
            "id",
            "sha",
            "ref",
            "task",
            "environment",
            "description",
            "created_at",
            "updated_at",
            "statuses_url",
            "repository_url",
        )
        if payload.get(key) is not None
    }
    creator = _user(payload.get("creator"))
    if creator:
        result["creator"] = creator
    return result


def normalize_package(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    result = {
        key: payload.get(key)
        for key in (
            "id",
            "name",
            "package_type",
            "html_url",
            "url",
            "version_count",
            "visibility",
            "created_at",
            "updated_at",
        )
        if payload.get(key) is not None
    }
    owner = _user(payload.get("owner"))
    if owner:
        result["owner"] = owner
    return result


def normalize_fork(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    owner = _user(payload.get("owner"))
    parent = payload.get("parent") if isinstance(payload.get("parent"), dict) else {}
    return {
        key: payload.get(key)
        for key in ("id", "full_name", "name", "html_url", "created_at", "updated_at", "pushed_at", "forks_count", "stargazers_count")
        if payload.get(key) is not None
    } | {
        "owner": owner,
        "parent": {key: parent.get(key) for key in ("full_name", "html_url") if parent.get(key) is not None},
    }


def normalize_workflow(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload.get(key)
        for key in ("id", "name", "path", "state", "created_at", "updated_at", "url", "html_url", "badge_url")
        if payload.get(key) is not None
    }


def normalize_workflow_run(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    actor = _user(payload.get("actor"))
    return {
        key: payload.get(key)
        for key in (
            "id",
            "name",
            "event",
            "status",
            "conclusion",
            "workflow_id",
            "run_number",
            "run_attempt",
            "created_at",
            "updated_at",
            "run_started_at",
            "head_branch",
            "head_sha",
            "html_url",
            "jobs_url",
            "logs_url",
            "workflow_url",
        )
        if payload.get(key) is not None
    } | {"actor": actor}


def normalize_job(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {
        key: payload.get(key)
        for key in ("id", "run_id", "name", "status", "conclusion", "started_at", "completed_at", "html_url", "run_url")
        if payload.get(key) is not None
    }


def normalize_discussion(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    category = payload.get("category") if isinstance(payload.get("category"), dict) else {}
    author = _user(payload.get("author"))
    comments = payload.get("comments") if isinstance(payload.get("comments"), dict) else {}
    comment_nodes = comments.get("nodes") if isinstance(comments.get("nodes"), list) else []
    return {
        key: payload.get(key)
        for key in ("id", "number", "title", "body", "url", "createdAt", "updatedAt", "answerChosenAt")
        if payload.get(key) is not None
    } | {
        "category": {key: category.get(key) for key in ("name", "emoji") if category.get(key) is not None},
        "author": author,
        "comments": [
            {
                "id": comment.get("id"),
                "body": comment.get("body"),
                "createdAt": comment.get("createdAt"),
                "author": _user(comment.get("author")),
            }
            for comment in comment_nodes
            if isinstance(comment, dict)
        ],
        "comment_count": comments.get("totalCount", len(comment_nodes)),
    }


def summarize_contributor_activity(
    commits: list[dict[str, Any]],
    contributors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Aggregate the bounded commit sample by contributor identity."""

    contributor_map = {
        str(person.get("login")): person
        for person in contributors
        if person.get("login")
    }
    activity: dict[str, dict[str, Any]] = {}
    for commit in commits:
        author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
        committer = commit.get("committer") if isinstance(commit.get("committer"), dict) else {}
        login = author.get("login") or committer.get("login") or author.get("email") or author.get("name")
        if not login:
            login = "unknown-contributor"
        key = str(login)
        entry = activity.setdefault(
            key,
            {
                "login": key,
                "avatar_url": None,
                "html_url": None,
                "commit_count": 0,
                "first_commit": None,
                "last_commit": None,
                "commit_shas": [],
            },
        )
        profile = contributor_map.get(key)
        if profile:
            entry["avatar_url"] = profile.get("avatar_url")
            entry["html_url"] = profile.get("html_url")
            entry["contributions"] = profile.get("contributions")
        date = commit.get("date")
        entry["commit_count"] += 1
        if isinstance(commit.get("sha"), str):
            entry["commit_shas"].append(commit["sha"])
        if date and (entry["first_commit"] is None or str(date) < str(entry["first_commit"])):
            entry["first_commit"] = date
        if date and (entry["last_commit"] is None or str(date) > str(entry["last_commit"])):
            entry["last_commit"] = date
    return sorted(
        activity.values(),
        key=lambda item: (item.get("commit_count", 0), item.get("last_commit") or ""),
        reverse=True,
    )


Normalizer = Callable[[Any], dict[str, Any]]


class GitHubClient:
    """Bounded GitHub REST client with safe per-endpoint fallback behavior."""

    def __init__(
        self,
        token: str | None = None,
        *,
        api_base_url: str = GITHUB_API_URL,
        opener: Callable[..., Any] = urllib.request.urlopen,
        timeout: float = 20.0,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
    ) -> None:
        dotenv_values: dict[str, str] = {}
        env_file = os.environ.get("MNEMO_ENV_FILE")
        if env_file:
            dotenv_values.update(parse_env_file(env_file))
        else:
            # Try multiple locations for .env
            for candidate in [".env", Path(__file__).parent.parent / ".env", Path.cwd() / ".env"]:
                try:
                    dotenv_values.update(parse_env_file(candidate))
                except Exception:
                    continue
        configured_token = os.environ.get("GITHUB_TOKEN") or dotenv_values.get("GITHUB_TOKEN") or dotenv_values.get("GH_TOKEN")
        self._token = (
            token.strip()
            if isinstance(token, str) and token.strip()
            else configured_token.strip()
            if isinstance(configured_token, str) and configured_token.strip()
            else None
        )
        self.api_base_url = api_base_url.rstrip("/")
        self.opener = opener
        self.timeout = timeout
        self.page_size = max(1, min(page_size, 100))
        self.max_pages = max(1, min(max_pages, 10))

    @property
    def authenticated(self) -> bool:
        return bool(self._token)

    def build_request(self, path: str, params: dict[str, Any] | None = None) -> urllib.request.Request:
        endpoint = path if path.startswith("/") else f"/{path}"
        query = {key: value for key, value in (params or {}).items() if value is not None}
        url = f"{self.api_base_url}{endpoint}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query, doseq=True)}"
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": DEFAULT_USER_AGENT,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return urllib.request.Request(url, headers=headers, method="GET")

    def request_json(self, path: str, params: dict[str, Any] | None = None) -> Any:
        request = self.build_request(path, params)
        try:
            with self.opener(request, timeout=self.timeout) as response:
                status = getattr(response, "status", None)
                if isinstance(status, int) and (status >= 400 or status == 202):
                    if status == 202:
                        raise GitHubRequestError("GitHub has not generated this statistics response yet.", status=status)
                    raise GitHubRequestError("GitHub API request failed.", status=status)
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except GitHubRequestError:
            raise
        except urllib.error.HTTPError as error:
            raise GitHubRequestError("GitHub API request failed.", status=error.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GitHubRequestError("GitHub API request could not be completed.") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise GitHubRequestError("GitHub API response was too large.")
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GitHubRequestError("GitHub API returned invalid JSON.") from error

    def request_graphql(self, query: str, variables: dict[str, Any]) -> Any:
        """Run a bounded authenticated GraphQL request for Discussions."""

        if not self._token:
            raise GitHubRequestError("GitHub Discussions require an authenticated token.")
        request = urllib.request.Request(
            f"{self.api_base_url}/graphql",
            data=json.dumps({"query": query, "variables": variables}).encode("utf-8"),
            headers={
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": DEFAULT_USER_AGENT,
                "X-GitHub-Api-Version": GITHUB_API_VERSION,
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            with self.opener(request, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise GitHubRequestError("GitHub GraphQL request failed.", status=error.code) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise GitHubRequestError("GitHub GraphQL request could not be completed.") from error
        if len(raw) > MAX_RESPONSE_BYTES:
            raise GitHubRequestError("GitHub GraphQL response was too large.")
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise GitHubRequestError("GitHub GraphQL returned invalid JSON.") from error
        if not isinstance(body, dict):
            raise GitHubRequestError("GitHub GraphQL returned an unexpected response.")
        if body.get("errors"):
            raise GitHubRequestError("GitHub GraphQL returned an error.")
        return body.get("data")

    def _paginate(
        self,
        path: str,
        *,
        normalizer: Normalizer,
        errors: dict[str, dict[str, Any]],
        error_key: str,
        params: dict[str, Any] | None = None,
        max_pages: int | None = None,
    ) -> list[dict[str, Any]]:
        values: list[dict[str, Any]] = []
        page_limit = max(1, min(max_pages if max_pages is not None else self.max_pages, 50))
        for page in range(1, page_limit + 1):
            request_params = {**(params or {}), "per_page": self.page_size, "page": page}
            try:
                payload = self.request_json(path, request_params)
            except GitHubRequestError as error:
                errors[error_key] = _safe_error(error)
                break
            if not isinstance(payload, list):
                errors[error_key] = {"message": "GitHub returned an unexpected collection response."}
                break
            normalized = [item for item in (normalizer(value) for value in payload) if item]
            values.extend(normalized)
            if len(payload) < self.page_size:
                break
        return values

    def _optional(
        self,
        path: str,
        *,
        errors: dict[str, dict[str, Any]],
        error_key: str,
        default: Any,
        params: dict[str, Any] | None = None,
    ) -> Any:
        try:
            payload = self.request_json(path, params)
        except GitHubRequestError as error:
            errors[error_key] = _safe_error(error)
            return default
        return payload

    def _parallel(
        self,
        operations: dict[str, Callable[[], Any]],
        *,
        errors: dict[str, dict[str, Any]],
        progress_callback: ProgressCallback | None = None,
        segment: str = "github",
    ) -> dict[str, Any]:
        """Run independent API collections concurrently while preserving safe errors."""

        results: dict[str, Any] = {}
        total = len(operations)
        completed = 0
        with ThreadPoolExecutor(max_workers=min(DEFAULT_PARALLEL_REQUESTS, max(1, len(operations)))) as executor:
            futures = {executor.submit(operation): key for key, operation in operations.items()}
            for future in as_completed(futures):
                key = futures[future]
                try:
                    results[key] = future.result()
                except GitHubRequestError as error:
                    errors[key] = _safe_error(error)
                    results[key] = None
                except (OSError, TypeError, ValueError) as error:
                    errors[key] = {"message": "GitHub collection failed safely."}
                    results[key] = None
                    _ = error
                completed += 1
                if progress_callback is not None:
                    try:
                        value = results.get(key)
                        count = len(value) if isinstance(value, (list, tuple)) else (
                            len(value) if isinstance(value, dict) else int(value is not None)
                        )
                        progress_callback(
                            {
                                "event": "collection",
                                "segment": segment,
                                "key": key,
                                "count": count,
                                "completed": completed,
                                "total": total,
                            }
                        )
                    except Exception:
                        # Progress reporting is advisory and must never break
                        # an otherwise safe GitHub inspection.
                        pass
        return results

    def _collect_discussions(
        self,
        parsed: GitHubRepository,
        *,
        errors: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not self.authenticated:
            errors["discussions"] = {"message": "GitHub Discussions require an authenticated GraphQL token."}
            return []
        query = """
        query($owner: String!, $name: String!, $first: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            discussions(first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes {
                id number title body url createdAt updatedAt answerChosenAt
                category { name emoji }
                author { login id avatarUrl url }
                comments(first: 20) { totalCount nodes { id body createdAt author { login id avatarUrl url } } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
        """
        values: list[dict[str, Any]] = []
        cursor: str | None = None
        for _page in range(DISCUSSION_MAX_PAGES):
            data = self.request_graphql(query, {"owner": parsed.owner, "name": parsed.name, "first": 100, "after": cursor})
            repository = data.get("repository") if isinstance(data, dict) else None
            connection = repository.get("discussions") if isinstance(repository, dict) else None
            if not isinstance(connection, dict):
                break
            nodes = connection.get("nodes") if isinstance(connection.get("nodes"), list) else []
            values.extend(item for item in (normalize_discussion(node) for node in nodes) if item)
            page_info = connection.get("pageInfo") if isinstance(connection.get("pageInfo"), dict) else {}
            if not page_info.get("hasNextPage"):
                break
            cursor = page_info.get("endCursor")
            if not cursor:
                break
        return values

    def inspect(
        self,
        repository: GitHubRepository | str,
        *,
        include_core: bool = True,
        include_history: bool = True,
        include_insights: bool = True,
        history_max_pages: int | None = None,
        include_contributors: bool | None = None,
        contributor_max_pages: int | None = None,
        include_extended_core: bool = True,
        progress_callback: ProgressCallback | None = None,
        progress_segment: str = "github",
    ) -> dict[str, Any]:
        """Fetch bounded metadata without failing the whole inspection.

        Core metadata is kept separate from optional history and insight
        collections so the web workflow can load the fast, useful snapshot
        first and defer expensive or permission-heavy endpoints until the user
        requests them.
        """

        parsed = parse_github_repository(repository) if isinstance(repository, str) else repository
        if not isinstance(parsed, GitHubRepository):
            raise GitHubURLParseError("Invalid GitHub repository reference.")

        errors: dict[str, dict[str, Any]] = {}
        repo_payload: dict[str, Any] = {}
        contributors_requested = include_core if include_contributors is None else include_contributors
        bounded_contributor_pages = max(1, min(contributor_max_pages or DEFAULT_CONTRIBUTOR_MAX_PAGES, DEFAULT_CONTRIBUTOR_MAX_PAGES))
        if progress_callback is not None:
            try:
                progress_callback({"event": "stage", "segment": progress_segment, "status": "active", "message": "Reading repository metadata."})
            except Exception:
                pass
        try:
            raw_repository = self.request_json(parsed.api_path)
            repo_payload = normalize_repository(raw_repository)
            if not repo_payload:
                errors["repository"] = {"message": "GitHub returned an unexpected repository response."}
        except GitHubRequestError as error:
            errors["repository"] = _safe_error(error)
        if progress_callback is not None:
            try:
                progress_callback({"event": "collection", "segment": progress_segment, "key": "repository", "count": int(bool(repo_payload)), "completed": 1, "total": 0})
            except Exception:
                pass

        rate_limit = self._optional(
            "/rate_limit",
            errors=errors,
            error_key="rate_limit",
            default={},
        )
        if progress_callback is not None:
            try:
                progress_callback({"event": "collection", "segment": progress_segment, "key": "rate_limit", "count": int(bool(rate_limit)), "completed": 2, "total": 0})
            except Exception:
                pass
        core_rate = rate_limit.get("resources", {}).get("core", {}) if isinstance(rate_limit, dict) else {}
        api_exhausted = isinstance(core_rate, dict) and core_rate.get("remaining") == 0
        if api_exhausted:
            reset_epoch = core_rate.get("reset")
            errors["github_rate_limit"] = {
                "message": "GitHub API core rate limit is exhausted. Set GITHUB_TOKEN for authenticated collection.",
                "status": 403,
                "remaining": 0,
                "reset": reset_epoch,
            }

        operations: dict[str, Callable[[], Any]] = {}
        bounded_history_pages = max(1, min(history_max_pages or FULL_HISTORY_MAX_PAGES, FULL_HISTORY_MAX_PAGES))
        if include_core:
            operations.update(
                {
                    "readme": lambda: normalize_readme(self.request_json(f"{parsed.api_path}/readme")),
                    "languages": lambda: self.request_json(f"{parsed.api_path}/languages"),
                    "branches": lambda: self._paginate(f"{parsed.api_path}/branches", normalizer=normalize_branch, errors=errors, error_key="branches"),
                }
            )
            if include_extended_core:
                operations.update(
                    {
                        "contributor_stats": lambda: self.request_json(f"{parsed.api_path}/stats/contributors"),
                        "releases": lambda: self._paginate(f"{parsed.api_path}/releases", normalizer=normalize_release, errors=errors, error_key="releases"),
                        "tags": lambda: self._paginate(f"{parsed.api_path}/tags", normalizer=normalize_tag, errors=errors, error_key="tags"),
                        "deployments": lambda: self._paginate(f"{parsed.api_path}/deployments", normalizer=normalize_deployment, errors=errors, error_key="deployments"),
                    }
                )
        if contributors_requested:
            operations["contributors"] = lambda: self._paginate(
                f"{parsed.api_path}/contributors",
                normalizer=normalize_contributor,
                errors=errors,
                error_key="contributors",
                max_pages=bounded_contributor_pages,
                params={"anon": "1"},
            )
        if include_history:
            operations.update(
                {
                    "commits": lambda: self._paginate(f"{parsed.api_path}/commits", normalizer=normalize_commit, errors=errors, error_key="commits", max_pages=bounded_history_pages),
                    "pull_requests": lambda: self._paginate(
                        f"{parsed.api_path}/pulls",
                        normalizer=normalize_pull_request,
                        errors=errors,
                        error_key="pull_requests",
                        params={"state": "all", "sort": "updated", "direction": "desc"},
                        max_pages=bounded_history_pages,
                    ),
                    "issues_raw": lambda: self._paginate(
                        f"{parsed.api_path}/issues",
                        normalizer=normalize_issue,
                        errors=errors,
                        error_key="issues",
                        params={"state": "all", "sort": "updated", "direction": "desc"},
                        max_pages=bounded_history_pages,
                    ),
                    "releases": lambda: self._paginate(f"{parsed.api_path}/releases", normalizer=normalize_release, errors=errors, error_key="releases", max_pages=bounded_history_pages),
                    "tags": lambda: self._paginate(f"{parsed.api_path}/tags", normalizer=normalize_tag, errors=errors, error_key="tags", max_pages=bounded_history_pages),
                    "deployments": lambda: self._paginate(f"{parsed.api_path}/deployments", normalizer=normalize_deployment, errors=errors, error_key="deployments", max_pages=bounded_history_pages),
                    "events": lambda: self._paginate(f"{parsed.api_path}/events", normalizer=normalize_event, errors=errors, error_key="events", max_pages=bounded_history_pages),
                }
            )
        if include_insights:
            operations.update(
                {
                    "code_frequency": lambda: self.request_json(f"{parsed.api_path}/stats/code_frequency"),
                    "commit_activity": lambda: self.request_json(f"{parsed.api_path}/stats/commit_activity"),
                    "participation": lambda: self.request_json(f"{parsed.api_path}/stats/participation"),
                    "forks": lambda: self._paginate(f"{parsed.api_path}/forks", normalizer=normalize_fork, errors=errors, error_key="forks"),
                    "community_profile": lambda: self.request_json(f"{parsed.api_path}/community/profile"),
                    "punch_card": lambda: self.request_json(f"{parsed.api_path}/stats/punch_card"),
                    "traffic_views": lambda: self.request_json(f"{parsed.api_path}/traffic/views"),
                    "traffic_clones": lambda: self.request_json(f"{parsed.api_path}/traffic/clones"),
                    "traffic_paths": lambda: self.request_json(f"{parsed.api_path}/traffic/popular/paths"),
                    "traffic_referrers": lambda: self.request_json(f"{parsed.api_path}/traffic/popular/referrers"),
                    "sbom": lambda: self.request_json(f"{parsed.api_path}/dependency-graph/sbom"),
                    "workflows": lambda: self.request_json(f"{parsed.api_path}/actions/workflows"),
                    "workflow_runs": lambda: self.request_json(f"{parsed.api_path}/actions/runs"),
                    "actions_usage": lambda: self.request_json(f"{parsed.api_path}/actions/usage"),
                    "discussions": lambda: self._collect_discussions(parsed, errors=errors),
                }
            )
        if progress_callback is not None:
            try:
                progress_callback({"event": "requests", "segment": progress_segment, "total": len(operations) + 2})
            except Exception:
                pass
        collections = {} if api_exhausted or not operations else self._parallel(
            operations,
            errors=errors,
            progress_callback=progress_callback,
            segment=progress_segment,
        )
        history_requested = include_history
        insights_requested = include_insights
        history_errors = history_requested and bool(HISTORY_ERROR_KEYS.intersection(errors))
        insight_errors = insights_requested and bool(INSIGHT_ERROR_KEYS.intersection(errors))
        history_status = (
            "not_requested"
            if not history_requested
            else "rate_limited"
            if api_exhausted
            else "partial"
            if history_errors
            else "deferred"
            if bounded_history_pages < FULL_HISTORY_MAX_PAGES
            else "loaded"
        )
        insights_status = (
            "not_requested"
            if not insights_requested
            else "rate_limited"
            if api_exhausted
            else "partial"
            if insight_errors
            else "loaded"
        )
        contributor_errors = "contributors" in errors or "contributor_stats" in errors
        contributors_status = (
            "not_requested"
            if not contributors_requested
            else "partial"
            if contributor_errors
            else "deferred"
            if bounded_contributor_pages < DEFAULT_CONTRIBUTOR_MAX_PAGES
            else "loaded"
        )
        readme = collections.get("readme")
        languages = collections.get("languages")
        if include_core and not isinstance(languages, dict):
            errors["languages"] = {"message": "GitHub returned an unexpected language response."}
            languages = {}
        elif not isinstance(languages, dict):
            languages = {}

        contributors = collections.get("contributors") if isinstance(collections.get("contributors"), list) else []
        contributor_stats = collections.get("contributor_stats")
        if isinstance(contributor_stats, list):
            by_login = {
                str(person.get("login")).lower(): person
                for person in contributors
                if person.get("login")
            }
            for raw_stat in contributor_stats:
                stat = normalize_contributor_stat(raw_stat)
                login = str(stat.get("login", "")).lower()
                if not login:
                    continue
                existing = by_login.get(login)
                if existing is None:
                    contributors.append(stat)
                    by_login[login] = stat
                else:
                    existing["contributions"] = max(
                        int(existing.get("contributions") or 0),
                        int(stat.get("contributions") or 0),
                    )
                    for key in ("avatar_url", "html_url", "id", "node_id", "type"):
                        if not existing.get(key) and stat.get(key):
                            existing[key] = stat[key]
        commits = collections.get("commits") if isinstance(collections.get("commits"), list) else []
        pull_requests = collections.get("pull_requests") if isinstance(collections.get("pull_requests"), list) else []
        issues_raw = collections.get("issues_raw") if isinstance(collections.get("issues_raw"), list) else []
        issues = [
            {key: value for key, value in item.items() if key != "_is_pull_request"}
            for item in issues_raw
            if not item.get("_is_pull_request")
        ]
        releases = collections.get("releases") if isinstance(collections.get("releases"), list) else []
        tags = collections.get("tags") if isinstance(collections.get("tags"), list) else []
        branches = collections.get("branches") if isinstance(collections.get("branches"), list) else []
        deployments = collections.get("deployments") if isinstance(collections.get("deployments"), list) else []
        events = collections.get("events") if isinstance(collections.get("events"), list) else []
        forks = collections.get("forks") if isinstance(collections.get("forks"), list) else []
        discussions = collections.get("discussions") if isinstance(collections.get("discussions"), list) else []
        packages: list[dict[str, Any]] = []
        package_errors: dict[str, dict[str, Any]] = {}
        for package_type in () if api_exhausted or not include_insights else PACKAGE_TYPES:
            package_values = self._paginate(
                f"{parsed.api_path}/packages",
                normalizer=normalize_package,
                errors=errors,
                error_key=f"packages:{package_type}",
                params={"package_type": package_type},
            )
            packages.extend(package_values)
            if f"packages:{package_type}" in errors:
                package_errors[package_type] = errors[f"packages:{package_type}"]
        if package_errors:
            errors["packages"] = {
                "message": "Some GitHub package types were unavailable.",
                "types": package_errors,
            }
        unique_packages: list[dict[str, Any]] = []
        seen_packages: set[tuple[Any, ...]] = set()
        for package in packages:
            identity = (
                package.get("id"),
                package.get("package_type"),
                package.get("name"),
                package.get("url"),
            )
            if identity in seen_packages:
                continue
            seen_packages.add(identity)
            unique_packages.append(package)
        packages = unique_packages

        if progress_callback is not None:
            try:
                progress_callback({"event": "stage", "segment": progress_segment, "status": "complete", "message": "GitHub collections received."})
            except Exception:
                pass

        code_frequency = collections.get("code_frequency", [])
        commit_activity = collections.get("commit_activity", [])
        participation = collections.get("participation", {})
        if not isinstance(code_frequency, list):
            code_frequency = []
        if not isinstance(commit_activity, list):
            commit_activity = []
        if not isinstance(participation, dict):
            participation = {}

        workflows_payload = collections.get("workflows") if isinstance(collections.get("workflows"), dict) else {}
        workflows = [
            item
            for item in (normalize_workflow(value) for value in workflows_payload.get("workflows", []))
            if item
        ]
        workflow_runs_payload = collections.get("workflow_runs") if isinstance(collections.get("workflow_runs"), dict) else {}
        workflow_runs = [
            item
            for item in (normalize_workflow_run(value) for value in workflow_runs_payload.get("workflow_runs", []))
            if item
        ]
        actions_usage = collections.get("actions_usage") if isinstance(collections.get("actions_usage"), dict) else {}
        community_profile = collections.get("community_profile") if isinstance(collections.get("community_profile"), dict) else {}
        traffic: dict[str, Any] = {}
        for key in ("traffic_views", "traffic_clones", "traffic_paths", "traffic_referrers"):
            value = collections.get(key)
            name = key.removeprefix("traffic_")
            if isinstance(value, dict) and name in {"views", "clones"}:
                traffic[name] = value.get(name, []) if isinstance(value.get(name, []), list) else []
            elif isinstance(value, list):
                traffic[name] = value
        sbom = collections.get("sbom") if isinstance(collections.get("sbom"), dict) else {}
        requested_from = repo_payload.get("created_at") if isinstance(repo_payload, dict) else None
        requested_until = datetime.now(timezone.utc).isoformat()
        coverage = {
            name: _coverage_record(name, value, requested_from=requested_from, requested_until=requested_until)
            for name, value in {
                "contributors": contributors,
                "commits": commits,
                "pull_requests": pull_requests,
                "issues": issues,
                "branches": branches,
                "forks": forks,
                "discussions": discussions,
                "workflows": workflows,
                "workflow_runs": workflow_runs,
                "releases": releases,
                "deployments": deployments,
                "events": events,
            }.items()
        }
        coverage.update(
            {
                "code_frequency": _coverage_record("code_frequency", code_frequency, requested_from=requested_from, requested_until=requested_until, reason="GitHub returns aggregate weekly statistics, not every historical code event."),
                "punch_card": _coverage_record("punch_card", collections.get("punch_card", []), requested_from=requested_from, requested_until=requested_until, reason="GitHub returns aggregate day-of-week/hour statistics, not individual historical events."),
                "traffic": _coverage_record("traffic", traffic.get("views") if isinstance(traffic.get("views"), list) else [], requested_from=requested_from, requested_until=requested_until, reason="GitHub traffic endpoints retain a limited rolling window."),
                "dependency_graph": {
                    "collection": "dependency_graph",
                    "requested_from": requested_from,
                    "requested_until": requested_until,
                    "observed_until": requested_until if sbom else None,
                    "count": len(sbom.get("sbom", {}).get("packages", [])) if isinstance(sbom.get("sbom"), dict) else 0,
                    "complete": bool(sbom),
                    "truncated": not bool(sbom),
                    "reason": "SBOM endpoint may require repository permissions and only describes the current dependency graph.",
                },
                "network": {
                    "collection": "network",
                    "requested_from": requested_from,
                    "requested_until": requested_until,
                    "observed_until": None,
                    "count": 0,
                    "complete": False,
                    "truncated": True,
                    "reason": "GitHub does not expose the complete web Network graph through this REST client.",
                },
                "pulse": {
                    "collection": "pulse",
                    "requested_from": requested_from,
                    "requested_until": requested_until,
                    "observed_until": None,
                    "count": 0,
                    "complete": False,
                    "truncated": True,
                    "reason": "The GitHub Pulse web view is not exposed as a stable public REST collection.",
                },
                "community_standards": {
                    "collection": "community_standards",
                    "requested_from": requested_from,
                    "requested_until": requested_until,
                    "observed_until": requested_until if community_profile else None,
                    "count": 1 if community_profile else 0,
                    "complete": bool(community_profile),
                    "truncated": not bool(community_profile),
                    "reason": "Community profile data is permission-dependent.",
                },
                "actions_metrics": {
                    "collection": "actions_metrics",
                    "requested_from": requested_from,
                    "requested_until": requested_until,
                    "observed_until": requested_until if actions_usage else None,
                    "count": len(actions_usage),
                    "complete": bool(actions_usage),
                    "truncated": not bool(actions_usage),
                    "reason": "Actions usage and timing metrics are permission-dependent and current-state oriented.",
                },
            }
        )

        contributor_activity = summarize_contributor_activity(commits, contributors)
        merged_pull_requests = [
            pull
            for pull in pull_requests
            if pull.get("merged_at")
        ]
        feature_pull_requests = [
            pull
            for pull in pull_requests
            if any(
                "feature" in str(label).lower() or str(label).lower() in {"feat", "enhancement"}
                for label in pull.get("labels", [])
            )
            or str(pull.get("title", "")).lower().startswith(("feat:", "feature:"))
        ]

        # The parsed identity is the fallback when the repository endpoint is
        # unavailable, which keeps a public 404 or rate-limit response useful.
        repository_metadata = {
            **parsed.as_dict(),
            **repo_payload,
        }
        return {
            "repository": repository_metadata,
            "readme": readme,
            "languages": {str(name): value for name, value in languages.items()},
            "contributors": contributors,
            "contributor_count": len(contributors),
            "contributors_loaded": contributors_status == "loaded",
            "contributors_status": contributors_status,
            "contributor_activity": contributor_activity,
            "commits": commits,
            "pull_requests": pull_requests,
            "pull_request_summary": {
                "total": len(pull_requests),
                "merged": len(merged_pull_requests),
                "feature_like": len(feature_pull_requests),
            },
            "issues": issues,
            "releases": releases,
            "tags": tags,
            "branches": branches,
            "deployments": deployments,
            "events": events,
            "forks": forks,
            "discussions": discussions,
            "workflows": workflows,
            "workflow_runs": workflow_runs,
            "actions_usage": actions_usage,
            "community_profile": community_profile,
            "traffic": traffic,
            "dependency_graph": sbom,
            "packages": packages,
            "punch_card": collections.get("punch_card", []) if isinstance(collections.get("punch_card"), list) else [],
            "code_frequency": code_frequency,
            "commit_activity": commit_activity,
            "participation": participation,
            "stats": {
                "code_frequency": code_frequency,
                "commit_activity": commit_activity,
                "participation": participation,
            },
            "insights": {
                "code_frequency_weeks": len(code_frequency),
                "commit_activity_weeks": len(commit_activity),
                "participation_available": bool(participation),
                "community_profile_available": bool(community_profile),
                "traffic_collections": sorted(traffic),
                "actions_workflows": len(workflows),
                "actions_runs": len(workflow_runs),
            },
            "core_loaded": include_core,
            "history_loaded": history_status == "loaded",
            "history_status": history_status,
            "insights_loaded": insights_status == "loaded",
            "insights_status": insights_status,
            "coverage": coverage,
            "errors": errors,
            "request": {
                "authenticated": self.authenticated,
                "page_size": self.page_size,
                "max_pages": self.max_pages,
                "contributor_max_pages": DEFAULT_CONTRIBUTOR_MAX_PAGES,
                "contributors_loaded": contributors_status == "loaded",
                "contributors_status": contributors_status,
                "rate_limit": rate_limit,
                "core_loaded": include_core,
                "history_max_pages": bounded_history_pages if include_history else 0,
                "history_loaded": history_status == "loaded",
                "history_status": history_status,
                "insights_loaded": insights_status == "loaded",
                "insights_status": insights_status,
            },
        }

    def inspect_core(
        self,
        repository: GitHubRepository | str,
        *,
        progress_callback: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        """Fetch the fast metadata collections used to build the workspace."""

        return self.inspect(
            repository,
            include_core=True,
            include_history=False,
            include_insights=False,
            include_contributors=False,
            contributor_max_pages=CORE_CONTRIBUTOR_MAX_PAGES,
            include_extended_core=False,
            history_max_pages=0,
            progress_callback=progress_callback,
            progress_segment="metadata",
        )

    def inspect_history(
        self,
        repository: GitHubRepository | str,
        *,
        progress_callback: ProgressCallback | None = None,
        max_pages: int | None = None,
    ) -> dict[str, Any]:
        """Fetch the full bounded GitHub history collections without core duplication."""

        return self.inspect(
            repository,
            include_core=False,
            include_history=True,
            include_insights=False,
            history_max_pages=max_pages or FULL_HISTORY_MAX_PAGES,
            progress_callback=progress_callback,
            progress_segment="history",
        )

    def inspect_contributors(
        self,
        repository: GitHubRepository | str,
        *,
        progress_callback: ProgressCallback | None = None,
        max_pages: int | None = None,
    ) -> dict[str, Any]:
        """Fetch the bounded contributor collection as its own segment."""

        return self.inspect(
            repository,
            include_core=False,
            include_history=False,
            include_insights=False,
            include_contributors=True,
            contributor_max_pages=max_pages or DEFAULT_CONTRIBUTOR_MAX_PAGES,
            progress_callback=progress_callback,
            progress_segment="contributors",
        )

    def inspect_insights(
        self,
        repository: GitHubRepository | str,
        *,
        progress_callback: ProgressCallback | None = None,
    ) -> dict[str, Any]:
        """Fetch optional GitHub insights without repeating core collections."""

        return self.inspect(
            repository,
            include_core=False,
            include_history=False,
            include_insights=True,
            progress_callback=progress_callback,
            progress_segment="insights",
        )


def inspect_github_repository(repository: GitHubRepository | str, **client_kwargs: Any) -> dict[str, Any]:
    """Convenience wrapper for one bounded public API inspection."""

    return GitHubClient(**client_kwargs).inspect(repository)
