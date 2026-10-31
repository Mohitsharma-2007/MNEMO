from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

from mnemo.web import AppState, create_server


class GitHubRouteTests(unittest.TestCase):
    def test_github_inspect_route_loads_graph_without_local_paths_or_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repo"
            repository.mkdir()
            subprocess.run(["git", "-C", str(repository), "init", "-b", "main"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.name", "Ada"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "config", "user.email", "ada@example.test"], check=True, capture_output=True)
            (repository / "main.py").write_text("VALUE = 3\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(repository), "add", "main.py"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(repository), "commit", "-m", "Add source"], check=True, capture_output=True)

            class FakeClient:
                def inspect(self, parsed: object) -> dict:
                    return {
                        "repository": {"default_branch": "main"},
                        "languages": {"Python": 20},
                        "contributors": [{"login": "ada", "avatar_url": "https://avatars.example/ada", "contributions": 1}],
                        "commits": [{"sha": "abc123", "message": "Add source", "date": "2026-01-01T00:00:00Z", "author": {"login": "ada"}}],
                        "errors": {},
                        "request": {"authenticated": True},
                    }

                def inspect_insights(self, parsed: object) -> dict:
                    return {
                        "forks": [{"full_name": "owner/fork"}],
                        "coverage": {"forks": {"collection": "forks", "count": 1, "complete": False, "truncated": True}},
                        "errors": {},
                        "insights": {"forks": 1},
                        "request": {"authenticated": True, "insights_loaded": True},
                        "insights_loaded": True,
                    }

                def inspect_contributors(self, parsed: object) -> dict:
                    return {
                        "contributors": [{"login": "ada", "contributions": 3}],
                        "contributor_count": 1,
                        "contributor_activity": [{"login": "ada", "commit_count": 3}],
                        "contributors_loaded": True,
                        "contributors_status": "loaded",
                        "errors": {},
                        "request": {"authenticated": True, "contributors_loaded": True},
                    }

                def inspect_history(self, parsed: object) -> dict:
                    return {
                        "commits": [{"sha": "full-history-sha", "message": "Older change"}],
                        "pull_requests": [{"number": 7, "title": "Historical pull request"}],
                        "issues": [{"number": 3, "title": "Historical issue"}],
                        "pull_request_summary": {"total": 1, "merged": 1, "feature_like": 0},
                        "coverage": {
                            "commits": {"collection": "commits", "count": 1, "complete": False, "truncated": True},
                            "pull_requests": {"collection": "pull_requests", "count": 1, "complete": False, "truncated": True},
                        },
                        "errors": {},
                        "request": {"authenticated": True, "history_loaded": True},
                        "history_loaded": True,
                    }

            class FakeCache:
                def path_for(self, parsed: object) -> Path:
                    return repository

                def clone_or_update(self, parsed: object, *, default_branch: str | None = None) -> Path:
                    return repository

            state = AppState(github_client=FakeClient(), repository_cache=FakeCache())  # type: ignore[arg-type]
            server = create_server("127.0.0.1", 0, state)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.shutdown)
            self.addCleanup(server.server_close)
            self.addCleanup(lambda: thread.join(timeout=3))

            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/github/inspect",
                data=json.dumps({"github_url": "owner/repo", "max_commits": 10}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.loads(response.read().decode("utf-8"))

            async_request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_port}/api/github/inspect",
                data=json.dumps({"github_url": "owner/repo", "max_commits": 10, "async": True}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(async_request, timeout=5) as response:
                queued = json.loads(response.read().decode("utf-8"))
            self.assertEqual(response.status, 202)
            self.assertIn("job_id", queued)
            for _ in range(40):
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{server.server_port}/api/github/progress?job_id={queued['job_id']}",
                    timeout=5,
                ) as response:
                    progress = json.loads(response.read().decode("utf-8"))
                if progress["status"] == "complete":
                    break
                time.sleep(0.025)
            self.assertEqual(progress["status"], "complete")
            self.assertEqual(progress["progress"]["percent"], 100)
            self.assertIn("counts", progress["progress"])
            self.assertTrue({"metadata", "contributors", "history", "insights", "tree", "analysis"}.issubset(set(progress["progress"]["chunks"])))

            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/api/github/progress/stream?job_id={queued['job_id']}",
                timeout=5,
            ) as response:
                stream = response.read().decode("utf-8")
            self.assertIn("event: job", stream)
            self.assertIn("All requested GitHub chunks received.", stream)

            with urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/api/github/contributors?url=owner%2Frepo",
                timeout=5,
            ) as response:
                contributors = json.loads(response.read().decode("utf-8"))
            self.assertTrue(contributors["inspection"]["github"]["contributors_loaded"])

        self.assertIn("inspection", payload)
        self.assertIn("analysis", payload["inspection"])
        self.assertGreater(payload["summary"]["counts"]["files"], 0)
        encoded = json.dumps(payload)
        self.assertNotIn("_local_path", encoded)
        self.assertNotIn("root_path", encoded)
        self.assertNotIn("GITHUB_TOKEN", encoded)
        self.assertEqual(payload["inspection"]["github"]["languages"]["Python"], 20)

        with urllib.request.urlopen(
            f"http://127.0.0.1:{server.server_port}/api/github/insights?url=owner%2Frepo",
            timeout=5,
        ) as response:
            insights = json.loads(response.read().decode("utf-8"))
        self.assertEqual(insights["inspection"]["github"]["forks"][0]["full_name"], "owner/fork")
        self.assertTrue(insights["inspection"]["github"]["insights_loaded"])

        with urllib.request.urlopen(
            f"http://127.0.0.1:{server.server_port}/api/github/history?url=owner%2Frepo",
            timeout=5,
        ) as response:
            history = json.loads(response.read().decode("utf-8"))
        self.assertEqual(history["inspection"]["github"]["commits"][0]["sha"], "full-history-sha")
        self.assertTrue(history["inspection"]["github"]["history_loaded"])

        with self.assertRaises(urllib.error.HTTPError) as mismatch:
            urllib.request.urlopen(
                f"http://127.0.0.1:{server.server_port}/api/github/history?url=other%2Frepo",
                timeout=5,
            )
        self.assertEqual(mismatch.exception.code, 400)

        with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}/api/agents?limit=1000", timeout=5) as response:
            agents = json.loads(response.read().decode("utf-8"))
        self.assertEqual(agents["count"], 1)
        self.assertEqual(agents["agents"][0]["login"], "ada")

        agent_path = f"http://127.0.0.1:{server.server_port}/api/agents/ada"
        with urllib.request.urlopen(agent_path, timeout=5) as response:
            agent_detail = json.loads(response.read().decode("utf-8"))
        self.assertEqual(agent_detail["agent"]["login"], "ada")

        question = urllib.request.Request(
            f"http://127.0.0.1:{server.server_port}/api/ask",
            data=json.dumps({"question": "Why was source added?", "ai_assist": False}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(question, timeout=5) as response:
            answer = json.loads(response.read().decode("utf-8"))
        self.assertIsNotNone(answer["orchestration"])
        self.assertEqual(answer["orchestration"]["orchestrator"], "Mnemo Orchestrator")


if __name__ == "__main__":
    unittest.main()
