from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from mnemo.ingest import ingest_repository
from mnemo.query import query_graph


def run_git(repository: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(repository), *args],
        check=True,
        capture_output=True,
        text=True,
    )


class MnemoPrototypeTests(unittest.TestCase):
    def create_repository(self) -> Path:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        repository = Path(temporary_directory.name)
        run_git(repository, "init", "-b", "main")
        run_git(repository, "config", "user.name", "Ada Lovelace")
        run_git(repository, "config", "user.email", "ada@example.com")
        (repository / "settings.py").write_text(
            "MAX_RETRY = 3\nDEBUG = True\n\ndef fetch():\n    return MAX_RETRY\n",
            encoding="utf-8",
        )
        run_git(repository, "add", "settings.py")
        run_git(repository, "commit", "-m", "Add retry configuration")
        (repository / "settings.py").write_text(
            "MAX_RETRY = 5\nDEBUG = True\n\ndef fetch():\n    return MAX_RETRY\n",
            encoding="utf-8",
        )
        run_git(repository, "add", "settings.py")
        run_git(repository, "commit", "-m", "Increase retry limit because upstream rejects slow clients")
        return repository

    def test_ingestion_extracts_symbols_and_linked_decision(self) -> None:
        repository = self.create_repository()
        graph = ingest_repository(repository)
        labels = {label for node in graph["nodes"] for label in node["labels"]}

        self.assertIn("Repository", labels)
        self.assertIn("File", labels)
        self.assertIn("ConfigKey", labels)
        self.assertIn("Function", labels)
        self.assertTrue(any(edge["type"] == "MODIFIED" for edge in graph["edges"]))
        self.assertTrue(any(edge["type"] == "RESULTED_IN" for edge in graph["edges"]))
        commit_nodes = [node for node in graph["nodes"] if "Commit" in node["labels"]]
        modified_edges = [edge for edge in graph["edges"] if edge["type"] == "MODIFIED"]
        self.assertTrue(all("parents" in node for node in commit_nodes))
        self.assertTrue(any(edge.get("diff_hunk", "").startswith("@@") for edge in modified_edges))
        self.assertTrue(any("DEBUG = True" in edge.get("diff_hunk", "") for edge in modified_edges))

        result = query_graph(graph, "Why is MAX_RETRY set this way?")
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["confidence"], 1.0)
        self.assertIn("Increase retry limit", result["answer"])

    def test_query_abstains_when_no_intent_is_recorded(self) -> None:
        repository = self.create_repository()
        graph = ingest_repository(repository)
        result = query_graph(graph, "Why is DEBUG enabled?")
        self.assertEqual(result["status"], "abstain")
        self.assertEqual(result["confidence"], 0.0)
        self.assertIn("will not fabricate intent", result["answer"])

    def test_query_supports_repository_aware_conversation(self) -> None:
        repository = self.create_repository()
        graph = ingest_repository(repository)

        result = query_graph(graph, "hello")

        self.assertEqual(result["status"], "chat")
        self.assertEqual(result["mode"], "conversation")
        self.assertIn("I'm Mnemo", result["answer"])

        graph_rag = query_graph(graph, "How does Graph RAG work here?")
        self.assertEqual(graph_rag["status"], "chat")
        self.assertIn("deterministic property graph", graph_rag["answer"])

    def test_graph_is_json_serializable(self) -> None:
        repository = self.create_repository()
        graph = ingest_repository(repository)
        encoded = json.dumps(graph)
        self.assertIn('"schema_version": "0.1.0"', encoded)


if __name__ == "__main__":
    unittest.main()
