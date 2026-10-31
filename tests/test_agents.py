from __future__ import annotations

import unittest

from mnemo.agents import ContributorOrchestrator, attach_ai_result


class ContributorAgentTests(unittest.TestCase):
    def test_builds_an_agent_for_every_github_contributor(self) -> None:
        inspection = {
            "github": {
                "contributors": [
                    {"login": "ada", "avatar_url": "https://avatars.test/ada", "contributions": 12},
                    {"login": "grace", "avatar_url": "https://avatars.test/grace", "contributions": 7},
                ],
                "commits": [
                    {
                        "sha": "abc123",
                        "message": "Keep the compatibility shim",
                        "date": "2026-01-01T00:00:00Z",
                        "author": {"login": "ada"},
                    }
                ],
                "pull_requests": [
                    {"number": 4, "title": "Fix compatibility", "user": {"login": "ada"}}
                ],
                "issues": [{"number": 9, "title": "Compatibility report", "user": {"login": "grace"}}],
            }
        }
        graph = {
            "nodes": [
                {"id": "commit:abc123", "labels": ["Commit"], "sha": "abc123"},
                {"id": "file:compat.py", "labels": ["File"], "path": "compat.py"},
            ],
            "edges": [
                {"source": "contributor:ada", "type": "AUTHORED", "target": "commit:abc123"},
                {"source": "commit:abc123", "type": "MODIFIED", "target": "file:compat.py"},
            ],
        }

        orchestrator = ContributorOrchestrator.from_inspection(inspection, graph)

        self.assertEqual(len(orchestrator.agents), 2)
        self.assertEqual(orchestrator.get("ada").pull_requests[0]["number"], 4)  # type: ignore[union-attr]
        self.assertEqual(orchestrator.get("ada").touched_files, ["compat.py"])  # type: ignore[union-attr]
        result = orchestrator.ask("Why is compatibility kept?", {"path": "compat.py"})
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["participants"][0]["login"], "ada")
        self.assertIn("compatibility shim", result["transcript"][0]["message"])

        flow_result = orchestrator.ask(
            "Why is compatibility kept?",
            {"path": "compat.py"},
            graph=graph,
            ai_requested=True,
        )
        self.assertEqual(flow_result["timeline"]["count"], 1)
        self.assertTrue(any(node["kind"] == "ai_client" for node in flow_result["flow"]["nodes"]))
        attach_ai_result(flow_result, {"status": "fallback", "provider": "deterministic", "model": "local"})
        self.assertEqual(flow_result["flow"]["nodes"][-1]["status"], "fallback")

    def test_local_graph_contributors_do_not_become_fake_github_agents(self) -> None:
        orchestrator = ContributorOrchestrator.from_inspection(
            {"github": {"contributors": [], "commits": []}},
            {
                "nodes": [
                    {"id": "contributor:ada@example.test", "labels": ["Contributor"], "username": "ada@example.test", "display_name": "Ada"}
                ],
                "edges": [],
            },
        )

        self.assertEqual(len(orchestrator.agents), 0)
        self.assertEqual(orchestrator.summaries(), [])


if __name__ == "__main__":
    unittest.main()
