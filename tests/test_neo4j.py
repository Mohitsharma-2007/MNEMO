from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, Mock

from mnemo.neo4j import (
    Neo4jConfig,
    Neo4jQueryClient,
    _edge_statement,
    _node_statement,
    neo4j_status,
)


def response_for(payload: dict) -> MagicMock:
    response = MagicMock()
    response.read.return_value = json.dumps(payload).encode("utf-8")
    response.__enter__.return_value = response
    return response


class Neo4jQueryApiTests(unittest.TestCase):
    def test_request_contains_parameterized_statement_and_safe_auth_header(self) -> None:
        opener = Mock(return_value=response_for({"data": {"values": []}}))
        client = Neo4jQueryClient.from_env(
            {
                "NEO4J_QUERY_API_URL": "https://graph.example.test/db/neo4j/query/v2/",
                "NEO4J_USERNAME": "placeholder-user",
                "NEO4J_PASSWORD": "placeholder-password",
            },
            opener=opener,
        )

        result = client.execute(
            "MATCH (n:File {id: $file_id}) RETURN n",
            {"file_id": "file:settings.py", "limit": 1},
        )

        self.assertEqual(result, {"data": {"values": []}})
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "https://graph.example.test/db/neo4j/query/v2")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(request.get_header("Accept"), "application/json")
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["statement"], "MATCH (n:File {id: $file_id}) RETURN n")
        self.assertEqual(body["parameters"], {"file_id": "file:settings.py", "limit": 1})
        self.assertEqual(
            request.get_header("Authorization"),
            "Basic "
            + base64.b64encode(b"placeholder-user:placeholder-password").decode("ascii"),
        )
        self.assertNotIn("placeholder-password", request.data.decode("utf-8"))

    def test_uri_is_derived_to_https_query_api_endpoint(self) -> None:
        config = Neo4jConfig.from_env(
            {
                "NEO4J_URI": "neo4j+s://graph.example.test",
                "NEO4J_USERNAME": "placeholder-user",
                "NEO4J_PASSWORD": "placeholder-password",
            },
            database="mnemo",
        )

        self.assertEqual(
            config.query_api_url,
            "https://graph.example.test/db/mnemo/query/v2",
        )
        self.assertEqual(config.safe_status["password_configured"], True)
        self.assertNotIn("placeholder-password", json.dumps(config.safe_status))

    def test_explicit_query_url_infers_database_name(self) -> None:
        config = Neo4jConfig.from_env(
            {
                "NEO4J_QUERY_API_URL": "https://graph.example.test/db/cd26fe69/query/v2",
                "NEO4J_USERNAME": "placeholder-user",
                "NEO4J_PASSWORD": "placeholder-password",
            }
        )

        self.assertEqual(config.database, "cd26fe69")

    def test_sync_statements_are_single_line(self) -> None:
        self.assertNotIn("\n", _node_statement(("MnemoEntity", "File")))
        self.assertNotIn("\n", _edge_statement("MODIFIED"))

    def test_connection_status_reports_failure_without_exposing_credentials(self) -> None:
        opener = Mock(side_effect=OSError("placeholder-password must not be surfaced"))
        client = Neo4jQueryClient.from_env(
            {
                "NEO4J_QUERY_API_URL": "https://graph.example.test/db/neo4j/query/v2",
                "NEO4J_USERNAME": "placeholder-user",
                "NEO4J_PASSWORD": "placeholder-password",
            },
            opener=opener,
        )

        status = client.check_connection()

        self.assertFalse(status["connected"])
        self.assertTrue(status["configured"])
        self.assertNotIn("placeholder-password", json.dumps(status))
        self.assertEqual(status["query_api_url"], "https://graph.example.test/db/neo4j/query/v2")

    def test_missing_configuration_status_is_safe(self) -> None:
        status = neo4j_status({})

        self.assertFalse(status["configured"])
        self.assertNotIn("placeholder", json.dumps(status))

    def test_default_configuration_loads_untracked_dotenv_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "NEO4J_QUERY_API_URL=https://graph.example.test/db/mnemo/query/v2\n"
                "NEO4J_DATABASE=mnemo\n"
                "NEO4J_USERNAME=dotenv-user\n"
                "NEO4J_PASSWORD=dotenv-password\n",
                encoding="utf-8",
            )
            previous = os.environ.get("MNEMO_ENV_FILE")
            os.environ["MNEMO_ENV_FILE"] = str(env_path)
            try:
                status = neo4j_status()
            finally:
                if previous is None:
                    os.environ.pop("MNEMO_ENV_FILE", None)
                else:
                    os.environ["MNEMO_ENV_FILE"] = previous

        self.assertTrue(status["configured"])
        self.assertEqual(status["database"], "mnemo")
        self.assertNotIn("dotenv-password", json.dumps(status))


class Neo4jGraphSyncTests(unittest.TestCase):
    def test_sync_uses_parameterized_node_and_edge_payloads(self) -> None:
        client = Neo4jQueryClient(
            Neo4jConfig(
                "https://graph.example.test/db/neo4j/query/v2",
                "placeholder-user",
                "placeholder-password",
            )
        )
        execute = Mock(return_value={"counters": {}})
        client.execute = execute  # type: ignore[method-assign]
        graph = {
            "nodes": [
                {
                    "id": "repository:mnemo'",
                    "labels": ["Repository"],
                    "name": "Mnemo",
                },
                {
                    "id": "file:settings.py",
                    "labels": ["File"],
                    "path": "settings.py",
                    "language": "python",
                },
            ],
            "edges": [
                {
                    "source": "repository:mnemo'",
                    "type": "CONTAINS_FILE",
                    "target": "file:settings.py",
                    "reason": "placeholder-edge-property",
                }
            ],
        }

        result = client.sync_graph(graph)

        self.assertEqual(result.as_dict(), {"nodes_synced": 2, "edges_synced": 1, "requests": 3})
        self.assertEqual(execute.call_count, 3)
        node_calls = [call for call in execute.call_args_list if "UNWIND $nodes" in call.args[0]]
        edge_calls = [call for call in execute.call_args_list if "UNWIND $edges" in call.args[0]]
        self.assertEqual(len(node_calls), 2)
        self.assertEqual(len(edge_calls), 1)

        for call in node_calls:
            statement, parameters = call.args
            self.assertIn("MERGE (n:MnemoEntity:", statement)
            self.assertNotIn("repository:mnemo'", statement)
            self.assertNotIn("settings.py", statement)
            self.assertIn("nodes", parameters)
        edge_statement, edge_parameters = edge_calls[0].args
        self.assertIn("MERGE (source)-[relationship:CONTAINS_FILE]->(target)", edge_statement)
        self.assertNotIn("repository:mnemo'", edge_statement)
        self.assertEqual(edge_parameters["edges"][0]["source"], "repository:mnemo'")
        self.assertEqual(edge_parameters["edges"][0]["properties"]["reason"], "placeholder-edge-property")

    def test_sync_rejects_edges_with_missing_nodes(self) -> None:
        client = Neo4jQueryClient(
            Neo4jConfig(
                "https://graph.example.test/db/neo4j/query/v2",
                "placeholder-user",
                "placeholder-password",
            )
        )
        with self.assertRaises(ValueError):
            client.sync_graph(
                {
                    "nodes": [{"id": "file:settings.py", "labels": ["File"]}],
                    "edges": [{"source": "file:missing.py", "type": "CONTAINS", "target": "file:settings.py"}],
                }
            )


if __name__ == "__main__":
    unittest.main()
