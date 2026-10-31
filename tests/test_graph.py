from __future__ import annotations

import unittest

from mnemo.graph import InMemoryGraphStore, PropertyGraph


class InMemoryGraphStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        graph = PropertyGraph()
        graph.add_node("Repository", "repo:demo", name="demo")
        graph.add_node("File", "file:app.py", path="app.py")
        graph.add_node("Function", "function:app.py:main", name="main", path="app.py")
        graph.add_node("File", "file:lib.py", path="pkg/lib.py")
        graph.add_node("Function", "function:lib.py:helper", name="helper", path="pkg/lib.py")
        graph.add_edge("CONTAINS_FILE", "repo:demo", "file:app.py")
        graph.add_edge("CONTAINS", "file:app.py", "function:app.py:main")
        graph.add_edge("IMPORTS", "file:app.py", "file:lib.py")
        graph.add_edge("CONTAINS", "file:lib.py", "function:lib.py:helper")
        graph.add_edge("CALLS", "function:app.py:main", "function:lib.py:helper", resolution="exact")
        self.store = InMemoryGraphStore({**graph.to_dict(repository={"name": "demo"})})

    def test_neighbors_path_and_edge_verification(self) -> None:
        neighbors = self.store.neighbors("file:app.py", relationship_types=["IMPORTS"], direction="out")
        self.assertEqual([node["id"] for node in neighbors], ["file:lib.py"])

        path = self.store.path("function:app.py:main", "function:lib.py:helper", relationship_types=["CALLS"])
        self.assertIsNotNone(path)
        self.assertEqual(len(path["edges"]), 1)
        self.assertTrue(
            self.store.verify_edge(
                "function:app.py:main", "CALLS", "function:lib.py:helper"
            )["verified"]
        )

    def test_bounded_subgraph_and_rollup(self) -> None:
        view = self.store.subgraph("file:app.py", depth=1, budget=2)
        self.assertEqual(view["view"]["returned_nodes"], 2)
        self.assertTrue(view["view"]["truncated"])
        self.assertTrue(all(len(node["id"]) > 0 for node in view["nodes"]))

        rollup = self.store.rollup(level="directory", budget=10)
        self.assertEqual(rollup["view"]["level"], "directory")
        self.assertTrue(any(node["label"] == "pkg" for node in rollup["nodes"]))
        self.assertTrue(all("weight" in edge for edge in rollup["edges"]))

    def test_history_and_stats_are_json_compatible(self) -> None:
        history = self.store.history_of("file:app.py")
        self.assertEqual(history["node"]["id"], "file:app.py")
        self.assertTrue(any(edge["type"] == "IMPORTS" for edge in history["edges"]))

        stats = self.store.stats()
        self.assertEqual(stats["nodes"], 5)
        self.assertEqual(stats["edge_counts"]["CALLS"], 1)


if __name__ == "__main__":
    unittest.main()
