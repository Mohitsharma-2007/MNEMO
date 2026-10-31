from __future__ import annotations

import base64
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs

from mnemo.github import (
    GitHubClient,
    GitHubURLParseError,
    normalize_commit,
    normalize_contributor,
    normalize_event,
    normalize_pull_request,
    normalize_repository,
    parse_github_repository,
    summarize_contributor_activity,
)
from mnemo.workflow import inspect_github_repository


class JSONResponse:
    def __init__(self, payload: object, status: int = 200) -> None:
        self.status = status
        self._body = json.dumps(payload).encode("utf-8")

    def __enter__(self) -> "JSONResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self, *args: object) -> bytes:
        return self._body


class GitHubClientTests(unittest.TestCase):
    def test_repository_url_parser_accepts_url_and_shorthand(self) -> None:
        self.assertEqual(parse_github_repository("owner/repo").full_name, "owner/repo")
        parsed = parse_github_repository("https://github.com/owner/repo.git/")
        self.assertEqual(parsed.owner, "owner")
        self.assertEqual(parsed.name, "repo")
        self.assertEqual(parsed.clone_url, "https://github.com/owner/repo.git")

        with self.assertRaises(GitHubURLParseError):
            parse_github_repository("https://github.com/owner/repo/issues")
        with self.assertRaises(GitHubURLParseError):
            parse_github_repository("https://github.com/owner/repo?token=secret")
        with self.assertRaises(GitHubURLParseError):
            parse_github_repository("https://user:secret@github.com/owner/repo")

    def test_request_construction_uses_github_headers_without_token_in_url(self) -> None:
        client = GitHubClient(token="test-token", api_base_url="https://api.github.test")
        request = client.build_request("/repos/owner/repo/commits", {"per_page": 2, "page": 1})

        self.assertEqual(request.full_url, "https://api.github.test/repos/owner/repo/commits?per_page=2&page=1")
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(request.get_header("X-github-api-version"), "2022-11-28")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-token")
        self.assertNotIn("test-token", request.full_url)

    def test_normalizers_keep_metadata_needed_by_the_inspection(self) -> None:
        repository = normalize_repository(
            {
                "id": 1,
                "full_name": "owner/repo",
                "default_branch": "main",
                "owner": {"login": "owner", "avatar_url": "https://avatars.example/1"},
                "topics": ["python"],
            }
        )
        contributor = normalize_contributor(
            {
                "login": "ada",
                "avatar_url": "https://avatars.example/ada",
                "contributions": 12,
            }
        )
        commit = normalize_commit(
            {
                "sha": "abc123",
                "commit": {
                    "message": "Use the safer default",
                    "author": {"name": "Ada", "email": "ada@example.test", "date": "2026-01-02T03:04:05Z"},
                },
            }
        )
        pull_request = normalize_pull_request(
            {
                "number": 4,
                "title": "Merge compatibility fix",
                "mergeable": False,
                "mergeable_state": "dirty",
                "merged_at": None,
            }
        )

        self.assertEqual(repository["default_branch"], "main")
        self.assertEqual(repository["owner"]["login"], "owner")
        self.assertEqual(contributor["avatar_url"], "https://avatars.example/ada")
        self.assertEqual(contributor["contributions"], 12)
        self.assertEqual(commit["date"], "2026-01-02T03:04:05Z")
        self.assertFalse(pull_request["mergeable"])
        self.assertEqual(pull_request["mergeable_state"], "dirty")
        event = normalize_event(
            {
                "id": "push-1",
                "type": "PushEvent",
                "created_at": "2026-01-03T00:00:00Z",
                "actor": {"login": "ada"},
                "payload": {"ref": "refs/heads/main", "distinct_size": 2, "commits": [{"sha": "abc123", "message": "Push"}]},
            }
        )
        self.assertEqual(event["type"], "PushEvent")
        self.assertEqual(event["ref"], "refs/heads/main")
        self.assertEqual(event["commits"][0]["sha"], "abc123")

    def test_contributor_activity_aggregates_commit_dates_and_counts(self) -> None:
        activity = summarize_contributor_activity(
            [
                {"sha": "one", "date": "2026-01-01T00:00:00Z", "author": {"login": "ada"}},
                {"sha": "two", "date": "2026-01-03T00:00:00Z", "author": {"login": "ada"}},
            ],
            [{"login": "ada", "avatar_url": "https://avatars.example/ada", "contributions": 12}],
        )

        self.assertEqual(activity[0]["login"], "ada")
        self.assertEqual(activity[0]["commit_count"], 2)
        self.assertEqual(activity[0]["first_commit"], "2026-01-01T00:00:00Z")
        self.assertEqual(activity[0]["last_commit"], "2026-01-03T00:00:00Z")
        self.assertEqual(activity[0]["avatar_url"], "https://avatars.example/ada")

    def test_inspection_has_bounded_collections_and_graceful_stats_errors(self) -> None:
        calls: list[str] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            calls.append(url)
            path = url.split("?", 1)[0]
            if url.endswith("page=2"):
                return JSONResponse([])
            if path.endswith("/stats/code_frequency"):
                return JSONResponse({}, status=202)
            if path.endswith("/readme"):
                return JSONResponse(
                    {
                        "name": "README.md",
                        "encoding": "base64",
                        "content": base64.b64encode(b"# Mnemo").decode("ascii"),
                    }
                )
            if path.endswith("/languages"):
                return JSONResponse({"Python": 1200, "JavaScript": 100})
            if path.endswith("/commits"):
                return JSONResponse(
                    [
                        {
                            "sha": "abc123",
                            "commit": {"message": "Initial", "author": {"date": "2026-01-02T00:00:00Z"}},
                        }
                    ]
                )
            if path.endswith("/issues"):
                return JSONResponse(
                    [
                        {"number": 1, "title": "Issue"},
                        {"number": 2, "title": "Pull request", "pull_request": {"url": "https://example.test/pr/2"}},
                    ]
                )
            if path.endswith("/packages"):
                return JSONResponse([{"name": "mnemo", "package_type": "container"}])
            if path == "https://api.github.test/repos/owner/repo":
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if "/stats/" in path:
                return JSONResponse([] if path.endswith("commit_activity") else {})
            return JSONResponse([])

        client = GitHubClient(
            token="request-token",
            api_base_url="https://api.github.test",
            opener=opener,
            page_size=2,
            max_pages=2,
        )
        result = client.inspect("owner/repo")

        self.assertEqual(result["readme"]["content"], "# Mnemo")
        self.assertEqual(result["languages"]["Python"], 1200)
        self.assertEqual(len(result["issues"]), 1)
        self.assertEqual(result["packages"][0]["name"], "mnemo")
        self.assertEqual(result["errors"]["code_frequency"]["status"], 202)
        self.assertIn("forks", result)
        self.assertIn("discussions", result)
        self.assertIn("workflows", result)
        self.assertIn("workflow_runs", result)
        self.assertIn("community_profile", result)
        self.assertIn("traffic", result)
        self.assertIn("dependency_graph", result)
        self.assertFalse(result["coverage"]["network"]["complete"])
        self.assertLessEqual(sum("page=" in call for call in calls), 2 * 9)
        self.assertNotIn("request-token", json.dumps(result))

    def test_contributors_use_a_larger_bounded_window_than_other_collections(self) -> None:
        contributor_calls: list[int] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            path, query = url.split("?", 1) if "?" in url else (url, "")
            params = parse_qs(query)
            page = int(params.get("page", ["1"])[0])
            if path.endswith("/stats/contributors"):
                return JSONResponse([])
            if path.endswith("/contributors"):
                contributor_calls.append(page)
                if page <= 6:
                    return JSONResponse([{"login": f"user-{page}", "contributions": 1} for _ in range(100)])
                return JSONResponse([{"login": "user-645", "contributions": 1}])
            if path.endswith("/languages"):
                return JSONResponse({})
            if path == "https://api.github.test/repos/owner/repo":
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if "/stats/" in path:
                return JSONResponse([])
            return JSONResponse([])

        result = GitHubClient(
            api_base_url="https://api.github.test",
            opener=opener,
            page_size=100,
            max_pages=2,
        ).inspect("owner/repo")

        self.assertEqual(contributor_calls, list(range(1, 8)))
        self.assertEqual(len(result["contributors"]), 601)
        self.assertEqual(result["request"]["contributor_max_pages"], 50)

    def test_exhausted_rate_limit_short_circuits_optional_collections(self) -> None:
        calls: list[str] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            calls.append(url)
            if url.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 0, "reset": 123}}})
            if url.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            return JSONResponse([])

        result = GitHubClient(
            api_base_url="https://api.github.test",
            opener=opener,
            max_pages=50,
        ).inspect("owner/repo")

        self.assertEqual(result["errors"]["github_rate_limit"]["remaining"], 0)
        self.assertFalse(any("/commits" in call or "/issues" in call for call in calls))

    def test_core_inspection_defers_history_and_optional_insight_requests(self) -> None:
        calls: list[str] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            calls.append(url)
            if url.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 5000, "reset": 123}}})
            if url.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if url.endswith("/languages"):
                return JSONResponse({"Python": 10})
            return JSONResponse([])

        result = GitHubClient(api_base_url="https://api.github.test", opener=opener).inspect_core("owner/repo")

        self.assertTrue(result["core_loaded"])
        self.assertFalse(result["insights_loaded"])
        self.assertEqual(result["history_status"], "not_requested")
        self.assertFalse(any(path in call for path in ("/commits", "/pulls", "/issues", "/events") for call in calls))
        self.assertFalse(any(path in call for path in ("/contributors", "/stats/contributors", "/releases", "/tags", "/deployments") for call in calls))
        self.assertFalse(any(path in call for path in ("/forks", "/traffic/", "/actions/", "/dependency-graph/" ) for call in calls))

    def test_core_inspection_is_fast_and_full_history_can_be_loaded_separately(self) -> None:
        calls: list[str] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            calls.append(url)
            path, query = url.split("?", 1) if "?" in url else (url, "")
            page = int(parse_qs(query).get("page", ["1"])[0])
            if url.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 5000, "reset": 123}}})
            if path.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if path.endswith("/languages"):
                return JSONResponse({"Python": 10})
            if path.endswith(("/commits", "/pulls", "/issues", "/releases", "/tags", "/deployments", "/events")):
                return JSONResponse([] if page > 1 else [{"sha": "one", "commit": {"message": "one", "author": {"date": "2026-01-01T00:00:00Z"}}}])
            if path.endswith("/stats/contributors"):
                return JSONResponse([])
            return JSONResponse([])

        client = GitHubClient(api_base_url="https://api.github.test", opener=opener, page_size=1)
        core = client.inspect_core("owner/repo")
        self.assertTrue(core["core_loaded"])
        self.assertFalse(core["history_loaded"])
        self.assertEqual(core["history_status"], "not_requested")
        self.assertEqual(core["request"]["history_max_pages"], 0)

        calls.clear()
        history = client.inspect_history("owner/repo")
        self.assertTrue(history["history_loaded"])
        self.assertEqual(history["request"]["history_max_pages"], 50)
        self.assertTrue(any("page=2" in call for call in calls))

    def test_core_progress_reports_completed_collections(self) -> None:
        events: list[dict] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            path = url.split("?", 1)[0]
            if path.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 5000, "reset": 123}}})
            if path.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if path.endswith("/languages"):
                return JSONResponse({"Python": 10})
            return JSONResponse([])

        client = GitHubClient(api_base_url="https://api.github.test", opener=opener)
        result = client.inspect_core("owner/repo", progress_callback=events.append)

        self.assertEqual(result["history_status"], "not_requested")
        self.assertTrue(any(event.get("event") == "requests" for event in events))
        self.assertTrue(any(event.get("event") == "collection" and event.get("key") == "languages" for event in events))
        self.assertTrue(any(event.get("event") == "stage" and event.get("status") == "complete" for event in events))

    def test_contributors_are_a_separate_segment(self) -> None:
        calls: list[str] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            path = url.split("?", 1)[0]
            calls.append(path)
            if path.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 5000, "reset": 123}}})
            if path.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if path.endswith("/contributors"):
                return JSONResponse([{"login": "ada", "contributions": 4}])
            if path.endswith("/stats/contributors"):
                return JSONResponse([])
            return JSONResponse([])

        result = GitHubClient(api_base_url="https://api.github.test", opener=opener).inspect_contributors("owner/repo")

        self.assertEqual(result["contributors"][0]["login"], "ada")
        self.assertTrue(result["contributors_loaded"])
        self.assertTrue(any(path.endswith("/contributors") for path in calls))
        self.assertFalse(any(path.endswith("/languages") or path.endswith("/commits") for path in calls))

    def test_insights_do_not_request_history_collections(self) -> None:
        calls: list[str] = []

        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            calls.append(url)
            path = url.split("?", 1)[0]
            if path.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 5000, "reset": 123}}})
            if path.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if path.endswith("/graphql"):
                return JSONResponse({"data": {"repository": {"discussions": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}})
            if path.endswith("/actions/workflows"):
                return JSONResponse({"workflows": []})
            if path.endswith("/actions/runs"):
                return JSONResponse({"workflow_runs": []})
            if path.endswith("/dependency-graph/sbom"):
                return JSONResponse({"sbom": {"packages": []}})
            return JSONResponse([] if any(path.endswith(suffix) for suffix in ("/forks", "/packages")) else {})

        result = GitHubClient(token="test-token", api_base_url="https://api.github.test", opener=opener).inspect_insights("owner/repo")

        self.assertTrue(result["insights_loaded"])
        self.assertFalse(any(path in call for path in ("/commits", "/pulls", "/issues", "/events") for call in calls))

    def test_history_and_insight_statuses_report_partial_endpoint_failures(self) -> None:
        def opener(request: object, timeout: float) -> JSONResponse:
            url = request.full_url  # type: ignore[attr-defined]
            path = url.split("?", 1)[0]
            if path.endswith("/rate_limit"):
                return JSONResponse({"resources": {"core": {"remaining": 5000, "reset": 123}}})
            if path.endswith("/repos/owner/repo"):
                return JSONResponse({"full_name": "owner/repo", "default_branch": "main", "name": "repo"})
            if path.endswith("/commits") or path.endswith("/stats/code_frequency"):
                return JSONResponse({"error": "denied"}, status=403)
            if path.endswith("/actions/workflows"):
                return JSONResponse({"workflows": []})
            if path.endswith("/actions/runs"):
                return JSONResponse({"workflow_runs": []})
            if path.endswith("/dependency-graph/sbom"):
                return JSONResponse({"sbom": {"packages": []}})
            if path.endswith("/graphql"):
                return JSONResponse({"data": {"repository": {"discussions": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}})
            return JSONResponse([] if path.endswith(("/forks", "/packages")) else {})

        client = GitHubClient(token="test-token", api_base_url="https://api.github.test", opener=opener)
        history = client.inspect_history("owner/repo")
        insights = client.inspect_insights("owner/repo")

        self.assertFalse(history["history_loaded"])
        self.assertEqual(history["history_status"], "partial")
        self.assertFalse(insights["insights_loaded"])
        self.assertEqual(insights["insights_status"], "partial")


class GitHubWorkflowIntegrationTests(unittest.TestCase):
    def test_temporary_checkout_is_ingested_and_analyzed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "source"
            repository.mkdir()
            subprocess.run(["git", "-C", str(repository), "init", "-b", "main"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.name", "Ada"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.email", "ada@example.test"], check=True, capture_output=True)
            (repository / "pyproject.toml").write_text(
                "[project]\ndependencies = ['tomli>=2']\n",
                encoding="utf-8",
            )
            (repository / "app.py").write_text("import pathlib\n\ndef run():\n    return pathlib.Path('.')\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repository), "add", "."], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "commit", "-m", "Add initial module"], check=True, capture_output=True)

            class FakeClient:
                def inspect(self, parsed: object) -> dict:
                    return {"repository": {"default_branch": "main"}, "errors": {}}

            class FakeCache:
                def path_for(self, parsed: object) -> Path:
                    return repository

                def clone_or_update(self, parsed: object, *, default_branch: str | None = None) -> Path:
                    return repository

            result = inspect_github_repository(
                "owner/repo",
                github_client=FakeClient(),
                repository_cache=FakeCache(),
            )

        labels = {label for node in result["graph"]["nodes"] for label in node["labels"]}
        self.assertIn("Repository", labels)
        self.assertTrue(result["freshness"]["checkout_refreshed"])
        self.assertIn("inspected_at", result["freshness"])
        self.assertEqual(result["analysis"]["summary"]["top_language"], "python")
        self.assertEqual(result["analysis"]["summary"]["dependency_count"], 1)
        self.assertEqual(result["analysis"]["summary"]["import_count"], 1)


if __name__ == "__main__":
    unittest.main()
