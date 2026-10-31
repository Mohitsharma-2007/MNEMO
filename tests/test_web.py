from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest.mock import patch

from mnemo.ai import AIClient, ProviderRegistry
from mnemo.ingest import ingest_repository
from mnemo.neo4j import GraphSyncResult
from mnemo.web import AppState, create_server


def run_git(repository: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repository), *args],
        check=True,
        capture_output=True,
        text=True,
    )


class WebMVPTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        self.repository = Path(temporary_directory.name)
        run_git(self.repository, "init", "-b", "main")
        run_git(self.repository, "config", "user.name", "Ada Lovelace")
        run_git(self.repository, "config", "user.email", "ada@example.com")
        (self.repository / "settings.py").write_text(
            "MAX_RETRY = 3\nDEBUG = True\n\ndef fetch():\n    return MAX_RETRY\n",
            encoding="utf-8",
        )
        (self.repository / "README.md").write_text("# Mnemo\n\n![logo](logo.png)\n", encoding="utf-8")
        (self.repository / "CONTRIBUTING.md").write_text("# Contributing\n\n- Keep changes evidence-backed.\n", encoding="utf-8")
        (self.repository / "logo.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"preview")
        run_git(self.repository, "add", "settings.py", "README.md", "CONTRIBUTING.md", "logo.png")
        run_git(self.repository, "commit", "-m", "Add retry configuration")
        (self.repository / "settings.py").write_text(
            "MAX_RETRY = 5\nDEBUG = True\n\ndef fetch():\n    return MAX_RETRY\n",
            encoding="utf-8",
        )
        run_git(self.repository, "add", "settings.py")
        run_git(self.repository, "commit", "-m", "Increase retry limit because upstream rejects slow clients")

        registry = ProviderRegistry(
            env_path=self.repository / "missing.env",
            environment={
                "OPENROUTER_API_KEY": "test-secret-do-not-return",
                "OPENROUTER_BASE_URL": "https://provider.invalid/v1",
                "OPENROUTER_MODEL": "test-model",
            },
        )
        state = AppState(AIClient(registry, timeout=1))
        state.set_graph(ingest_repository(self.repository))
        self.server = create_server("127.0.0.1", 0, state)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.server.server_port}"
        self.addCleanup(self.stop_server)

    def stop_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request_json(self, path: str, method: str = "GET", payload: dict | None = None) -> dict:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            headers={"Content-Type": "application/json"},
            method=method,
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def test_health_summary_and_entity_search(self) -> None:
        health = self.request_json("/api/health")
        self.assertTrue(health["graph_loaded"])
        self.assertTrue(health["ai"]["enabled"])
        self.assertFalse(health["github"]["token_required"])
        self.assertNotIn("test-secret", json.dumps(health))
        self.assertNotIn("provider.invalid", json.dumps(health))

        summary = self.request_json("/api/graph/summary")
        self.assertEqual(summary["repository"]["name"], self.repository.name)
        self.assertGreaterEqual(summary["counts"]["files"], 1)

        files = self.request_json("/api/files?limit=100")
        self.assertIn("settings.py", {item["path"] for item in files["files"]})

        entities = self.request_json("/api/entities?query=MAX_RETRY&label=ConfigKey")
        self.assertEqual(len(entities["entities"]), 1)
        self.assertEqual(entities["entities"][0]["name"], "MAX_RETRY")

        agents = self.request_json("/api/agents?limit=1000")
        self.assertEqual(agents["agents"], [])
        self.assertFalse(agents["available"])

        view = self.request_json("/api/graph/view?level=directory&budget=20")
        self.assertEqual(view["view"]["level"], "directory")
        self.assertLessEqual(len(view["nodes"]), 20)
        self.assertTrue(all(node.get("labels") == ["Cluster"] for node in view["nodes"]))

        focused = self.request_json(
            "/api/graph/view?focus=file%3Asettings.py&depth=1&budget=10"
        )
        self.assertIn("file:settings.py", {node["id"] for node in focused["nodes"]})
        self.assertIn("view", focused)

    def test_ingest_route_rebuilds_active_graph(self) -> None:
        payload = self.request_json(
            "/api/ingest",
            method="POST",
            payload={"repository_path": str(self.repository), "max_commits": 10},
        )
        self.assertEqual(payload["summary"]["repository"]["name"], self.repository.name)
        self.assertGreaterEqual(payload["summary"]["counts"]["commits"], 2)

    def test_source_evidence_and_question_routes(self) -> None:
        source = self.request_json("/api/source?path=settings.py&start_line=1&end_line=3")
        self.assertEqual(source["path"], "settings.py")
        self.assertEqual(source["lines"][0]["text"], "MAX_RETRY = 5")

        entities = self.request_json("/api/entities?query=MAX_RETRY")
        entity_id = entities["entities"][0]["id"]
        encoded_id = urllib.parse.quote(entity_id, safe="")
        detail = self.request_json(f"/api/entities/{encoded_id}")
        self.assertEqual(detail["node"]["name"], "MAX_RETRY")
        evidence = self.request_json(f"/api/entities/{encoded_id}/evidence")
        self.assertTrue(evidence["evidence"])

        chain = self.request_json(f"/api/evidence/chain?entity_id={urllib.parse.quote(entity_id, safe='')}")
        self.assertTrue(chain["steps"])
        self.assertEqual(chain["target"]["id"], entity_id)

        timeline = self.request_json("/api/history/timeline?limit=20")
        self.assertEqual(timeline["count"], 2)
        self.assertEqual(timeline["commits"][0]["commit"]["commit_kind"], "commit")
        self.assertTrue(timeline["commits"][0]["modifications"])

        answer = self.request_json(
            "/api/ask",
            method="POST",
            payload={"question": "Why is MAX_RETRY set this way?", "ai_assist": False},
        )
        self.assertEqual(answer["result"]["status"], "verified")
        self.assertIsNone(answer["ai"])

        chat = self.request_json(
            "/api/ask",
            method="POST",
            payload={"question": "hello", "ai_assist": False},
        )
        self.assertEqual(chat["result"]["status"], "chat")
        self.assertIsNone(chat["orchestration"])

    def test_repository_documents_and_binary_source_preview(self) -> None:
        documents = self.request_json("/api/repository/documents")
        document_paths = {item["path"] for item in documents["documents"]}
        self.assertTrue({"README.md", "CONTRIBUTING.md"}.issubset(document_paths))

        readme = self.request_json("/api/source?path=README.md")
        self.assertEqual(readme["kind"], "markdown")
        self.assertIn("# Mnemo", readme["lines"][0]["text"])

        image = self.request_json("/api/source?path=logo.png")
        self.assertEqual(image["kind"], "image")
        with urllib.request.urlopen(self.base_url + image["preview_url"], timeout=5) as response:
            self.assertEqual(response.headers.get_content_type(), "image/png")
            self.assertTrue(response.read().startswith(b"\x89PNG"))

    def test_source_route_rejects_traversal_and_static_ui_loads(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as context:
            self.request_json("/api/source?path=../.env")
        self.assertEqual(context.exception.code, 403)

        request = urllib.request.Request(self.base_url + "/")
        with urllib.request.urlopen(request, timeout=5) as response:
            html = response.read().decode("utf-8")
        self.assertIn("Repository evidence workspace", html)
        self.assertIn("Neo4j: checking", html)
        self.assertIn('id="inspection-loader"', html)
        self.assertIn('id="loader-live-readout"', html)
        self.assertIn('data-loader-stat="files"', html)
        self.assertIn('id="loader-percent"', html)
        self.assertIn('id="source-explain-button"', html)
        self.assertIn('id="timeline-slider"', html)
        self.assertIn('id="track-insight-grid"', html)
        self.assertIn("source-panel", html)
        self.assertIn('data-page="agents"', html)
        self.assertIn('id="agent-workflow-graph"', html)
        self.assertIn('id="agent-code-graph"', html)
        self.assertIn('data-page="ai"', html)
        self.assertIn('id="ai-thread"', html)
        self.assertIn('id="ai-room-model"', html)
        self.assertIn('id="source-graph-zoom-in"', html)
        self.assertIn('id="shader-background"', html)
        self.assertIn('class="dither-overlay"', html)
        self.assertIn('data-page="simulation"', html)
        self.assertIn('data-page="compare"', html)
        self.assertIn('id="simulation-run"', html)
        self.assertIn('id="compare-run"', html)
        self.assertIn('id="simulation-trace"', html)
        self.assertIn('id="compare-result"', html)
        self.assertIn('id="ai-room-catalog-list"', html)
        self.assertIn('id="settings-ai-providers"', html)
        self.assertIn("/assets/vendor/codicon.css", html)
        self.assertNotIn('data-page="evidence"', html)
        self.assertIn('class="intake-copy"', html)
        self.assertIn('class="intake-entry"', html)
        app_js = (Path(__file__).parents[1] / "mnemo" / "web" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function renderInspection", app_js)
        self.assertIn("/api/github/history", app_js)
        self.assertIn("/api/github/progress", app_js)
        self.assertIn("/api/github/contributors", app_js)
        self.assertIn("async: true", app_js)
        self.assertIn("tree-generated-mark", app_js)
        self.assertNotIn("Simulated dynamic dual response", app_js)
        self.assertNotIn("verified zero circular dependencies", app_js)

    def test_ai_room_routes_timeline_context_and_flow(self) -> None:
        room = self.request_json(
            "/api/ai/room",
            method="POST",
            payload={"question": "Why is MAX_RETRY set this way?", "ai_assist": False},
        )
        self.assertEqual(room["result"]["status"], "verified")
        orchestration = room["orchestration"]
        self.assertEqual(orchestration["timeline"]["count"], 2)
        self.assertEqual(orchestration["timeline"]["focus"][0]["position"], 1)
        self.assertEqual(orchestration["timeline"]["focus"][-1]["position"], 2)
        self.assertTrue(any(node["kind"] == "orchestrator" for node in orchestration["flow"]["nodes"]))
        self.assertGreaterEqual(len(orchestration["flow"]["edges"]), 2)

        with patch.object(
            self.server.app_state.ai_client,
            "explain",
            return_value={"status": "ok", "provider": "test-provider", "model": "test-model", "text": "Timeline paraphrase"},
        ):
            assisted = self.request_json(
                "/api/ai/room",
                method="POST",
                payload={"question": "Why is MAX_RETRY set this way?", "ai_assist": True},
            )
        client_nodes = [node for node in assisted["orchestration"]["flow"]["nodes"] if node["kind"] == "ai_client"]
        self.assertEqual(client_nodes[0]["status"], "ok")
        self.assertEqual(assisted["orchestration"]["ai_client"]["provider"], "test-provider")

    def test_neo4j_status_and_sync_routes_use_safe_client_contract(self) -> None:
        class FakeNeo4jClient:
            def status(self) -> dict:
                return {
                    "configured": True,
                    "query_api_url": "https://graph.example.test/db/neo4j/query/v2",
                    "database": "neo4j",
                    "username_configured": True,
                    "password_configured": True,
                }

            def check_connection(self) -> dict:
                return {**self.status(), "connected": True}

            def sync_graph(self, graph: dict) -> GraphSyncResult:
                return GraphSyncResult(
                    nodes_synced=len(graph["nodes"]),
                    edges_synced=len(graph["edges"]),
                    requests=2,
                )

        self.server.app_state.neo4j_client = FakeNeo4jClient()  # type: ignore[assignment]
        status = self.request_json("/api/neo4j/status?check=1")
        self.assertTrue(status["connected"])
        self.assertNotIn("placeholder-password", json.dumps(status))

        synced = self.request_json("/api/neo4j/sync", method="POST", payload={})
        self.assertEqual(synced["status"], "synced")
        self.assertGreater(synced["sync"]["nodes_synced"], 0)

    def test_provider_status_only_exposes_safe_metadata(self) -> None:
        status = self.request_json("/api/ai/status")
        self.assertEqual(status["providers"][0]["name"], "openrouter")
        encoded = json.dumps(status)
        self.assertNotIn("test-secret", encoded)
        self.assertNotIn("provider.invalid", encoded)


if __name__ == "__main__":
    unittest.main()
