"""Dependency-free Neo4j HTTPS Query API integration for Mnemo.

The local graph remains the source of truth for graph construction.  This
module only translates that graph into parameterized Cypher requests and
communicates with Neo4j through its HTTPS Query API using the Python standard
library.
"""

from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from .ai import parse_env_file


DEFAULT_DATABASE = "neo4j"
DEFAULT_TIMEOUT = 10.0
DEFAULT_BATCH_SIZE = 500
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_NEO4J_SCHEMES = {"bolt", "bolt+s", "bolt+ssc", "neo4j", "neo4j+s", "neo4j+ssc"}


class Neo4jError(RuntimeError):
    """Base class for safe, credential-free Neo4j integration errors."""


class Neo4jConfigurationError(Neo4jError):
    """Raised when the required process environment is incomplete or invalid."""


class Neo4jConnectionError(Neo4jError):
    """Raised when the HTTPS Query API cannot be reached."""


class Neo4jHTTPError(Neo4jError):
    """Raised for an HTTP failure returned by the Query API."""


class Neo4jResponseError(Neo4jError):
    """Raised when the Query API response is not valid JSON."""


class Neo4jQueryError(Neo4jError):
    """Raised when Neo4j reports a Cypher error."""


def _environment_value(environment: Mapping[str, str], name: str) -> str:
    return str(environment.get(name, "")).strip()


def _default_environment() -> dict[str, str]:
    """Load local dotenv settings, then let process variables override them."""

    configured_path = os.environ.get("MNEMO_ENV_FILE", "").strip()
    candidates = [Path(configured_path)] if configured_path else []
    candidates.extend((Path.cwd() / ".env", Path(__file__).resolve().parents[1] / ".env"))
    values: dict[str, str] = {}
    for candidate in candidates:
        if candidate.exists():
            values.update(parse_env_file(candidate))
            break
    values.update(os.environ)
    return values


def _validate_https_url(value: str, variable_name: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme.lower() != "https" or not parsed.netloc or not parsed.hostname:
        raise Neo4jConfigurationError(f"{variable_name} must be a complete HTTPS URL.")
    if parsed.username is not None or parsed.password is not None:
        raise Neo4jConfigurationError(f"{variable_name} must not contain credentials.")
    if parsed.query or parsed.fragment:
        raise Neo4jConfigurationError(f"{variable_name} must not contain a query or fragment.")
    return urllib.parse.urlunsplit(
        ("https", parsed.netloc, parsed.path.rstrip("/"), "", "")
    )


def _database_path(database: str) -> str:
    if not database or not _IDENTIFIER_PATTERN.fullmatch(database):
        raise Neo4jConfigurationError("The Neo4j database name must be a safe identifier.")
    return f"/db/{urllib.parse.quote(database, safe='')}/query/v2"


def _derive_query_api_url(uri: str, database: str) -> str:
    parsed = urllib.parse.urlsplit(uri)
    scheme = parsed.scheme.lower()
    if scheme not in _NEO4J_SCHEMES:
        raise Neo4jConfigurationError(
            "NEO4J_URI must use a Neo4j or Bolt URI scheme."
        )
    if not parsed.netloc or not parsed.hostname:
        raise Neo4jConfigurationError("NEO4J_URI must include a host.")
    if parsed.username is not None or parsed.password is not None:
        raise Neo4jConfigurationError("NEO4J_URI must not contain credentials.")
    if parsed.query or parsed.fragment:
        raise Neo4jConfigurationError("NEO4J_URI must not contain a query or fragment.")

    path = parsed.path.rstrip("/")
    if path.endswith("/query/v2"):
        query_path = path
    elif path.startswith("/db/"):
        query_path = f"{path}/query/v2"
    else:
        query_path = _database_path(database)

    return urllib.parse.urlunsplit(("https", parsed.netloc, query_path, "", ""))


def _database_from_query_api_url(url: str) -> str | None:
    """Extract a database name from a complete ``/db/<name>/query/v2`` URL."""

    path_parts = [part for part in urllib.parse.urlsplit(url).path.split("/") if part]
    if len(path_parts) >= 4 and path_parts[-2:] == ["query", "v2"] and path_parts[-4] == "db":
        candidate = path_parts[-3]
        if _IDENTIFIER_PATTERN.fullmatch(candidate):
            return candidate
    return None


@dataclass(frozen=True)
class Neo4jConfig:
    """Validated Query API configuration loaded from process environment."""

    query_api_url: str
    username: str = field(repr=False)
    password: str = field(repr=False)
    database: str = DEFAULT_DATABASE

    @classmethod
    def from_env(
        cls,
        environment: Mapping[str, str] | None = None,
        *,
        database: str = DEFAULT_DATABASE,
    ) -> "Neo4jConfig":
        """Load credentials and endpoint without reading a dotenv file.

        ``NEO4J_QUERY_API_URL`` takes precedence.  When it is absent,
        ``NEO4J_URI`` is converted from a Bolt/Neo4j URI to an HTTPS Query API
        endpoint using the supplied database name.
        """

        values = environment if environment is not None else _default_environment()
        explicit_url = _environment_value(values, "NEO4J_QUERY_API_URL")
        uri = _environment_value(values, "NEO4J_URI")
        username = _environment_value(values, "NEO4J_USERNAME")
        password = _environment_value(values, "NEO4J_PASSWORD")
        configured_database = _environment_value(values, "NEO4J_DATABASE")
        selected_database = configured_database or database

        missing = [
            name
            for name, value in (
                ("NEO4J_USERNAME", username),
                ("NEO4J_PASSWORD", password),
            )
            if not value
        ]
        if not explicit_url and not uri:
            missing.append("NEO4J_QUERY_API_URL or NEO4J_URI")
        if missing:
            raise Neo4jConfigurationError(
                "Missing Neo4j environment setting(s): " + ", ".join(missing) + "."
            )

        query_api_url = (
            _validate_https_url(explicit_url, "NEO4J_QUERY_API_URL")
            if explicit_url
            else _derive_query_api_url(uri, selected_database)
        )
        if not configured_database and explicit_url and database == DEFAULT_DATABASE:
            selected_database = _database_from_query_api_url(query_api_url) or database
        return cls(query_api_url, username, password, selected_database)

    @property
    def safe_status(self) -> dict[str, Any]:
        """Return configuration metadata without exposing credentials."""

        return {
            "configured": True,
            "query_api_url": self.query_api_url,
            "database": self.database,
            "username_configured": bool(self.username),
            "password_configured": bool(self.password),
        }


def neo4j_status(
    environment: Mapping[str, str] | None = None,
    *,
    database: str = DEFAULT_DATABASE,
) -> dict[str, Any]:
    """Describe environment configuration without making a network request."""

    try:
        config = Neo4jConfig.from_env(environment, database=database)
    except Neo4jConfigurationError as error:
        return {"configured": False, "error": str(error)}
    return config.safe_status


Urlopen = Callable[..., Any]


class Neo4jQueryClient:
    """Small HTTPS Query API client using only :mod:`urllib` and :mod:`json`."""

    def __init__(
        self,
        config: Neo4jConfig,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        opener: Urlopen | None = None,
    ) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be greater than zero")
        self.config = config
        self.timeout = timeout
        self._opener = opener or urllib.request.urlopen

    @classmethod
    def from_env(
        cls,
        environment: Mapping[str, str] | None = None,
        *,
        database: str = DEFAULT_DATABASE,
        timeout: float = DEFAULT_TIMEOUT,
        opener: Urlopen | None = None,
    ) -> "Neo4jQueryClient":
        return cls(
            Neo4jConfig.from_env(environment, database=database),
            timeout=timeout,
            opener=opener,
        )

    def status(self) -> dict[str, Any]:
        """Return safe local configuration metadata; never contacts Neo4j."""

        return self.config.safe_status

    def execute(
        self,
        statement: str,
        parameters: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Execute one parameterized Cypher statement through Query API v2."""

        if not isinstance(statement, str) or not statement.strip():
            raise ValueError("statement must be a non-empty string")
        if parameters is not None and not isinstance(parameters, Mapping):
            raise TypeError("parameters must be a mapping")

        payload = {
            "statement": statement,
            "parameters": dict(parameters or {}),
        }
        request = urllib.request.Request(
            self.config.query_api_url,
            data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            ),
            headers={
                "Accept": "application/json",
                "Authorization": self._authorization_header(),
                "Content-Type": "application/json",
            },
            method="POST",
        )

        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw_response = response.read()
        except urllib.error.HTTPError as error:
            raise Neo4jHTTPError(
                f"Neo4j Query API returned HTTP {error.code}."
            ) from None
        except urllib.error.URLError:
            raise Neo4jConnectionError("Could not reach the Neo4j Query API.") from None
        except OSError:
            raise Neo4jConnectionError("Could not reach the Neo4j Query API.") from None

        try:
            response = json.loads(raw_response.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise Neo4jResponseError("Neo4j Query API returned invalid JSON.") from None
        if not isinstance(response, dict):
            raise Neo4jResponseError("Neo4j Query API returned an invalid response shape.")

        if response.get("errors"):
            raise Neo4jQueryError("Neo4j rejected the Cypher statement.")
        return response

    def check_connection(self) -> dict[str, Any]:
        """Run a harmless query and return a credential-free connection report."""

        result = {
            **self.status(),
            "connected": False,
        }
        try:
            self.execute("RETURN 1 AS ok")
        except Neo4jError as error:
            result["error"] = str(error)
        else:
            result["connected"] = True
        return result

    def connection_status(self) -> dict[str, Any]:
        """Alias for :meth:`check_connection` with an explicit name."""

        return self.check_connection()

    def sync_graph(
        self,
        graph: Mapping[str, Any] | Any,
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> "GraphSyncResult":
        """Create or update all Mnemo nodes and edges in ``graph``."""

        return sync_graph(self, graph, batch_size=batch_size)

    def _authorization_header(self) -> str:
        encoded = base64.b64encode(
            f"{self.config.username}:{self.config.password}".encode("utf-8")
        ).decode("ascii")
        return f"Basic {encoded}"


@dataclass(frozen=True)
class GraphSyncResult:
    """Counts from one completed graph synchronization."""

    nodes_synced: int
    edges_synced: int
    requests: int

    def as_dict(self) -> dict[str, int]:
        return {
            "nodes_synced": self.nodes_synced,
            "edges_synced": self.edges_synced,
            "requests": self.requests,
        }


def _safe_cypher_identifier(value: Any, kind: str) -> str:
    identifier = str(value)
    if not _IDENTIFIER_PATTERN.fullmatch(identifier):
        raise ValueError(f"Invalid Cypher {kind} identifier in graph payload.")
    return identifier


def _graph_payload(graph: Mapping[str, Any] | Any) -> Mapping[str, Any]:
    if isinstance(graph, Mapping):
        payload = graph
    elif hasattr(graph, "to_dict"):
        payload = graph.to_dict()
    else:
        raise TypeError("graph must be a mapping or provide to_dict()")
    if not isinstance(payload.get("nodes"), list) or not isinstance(payload.get("edges"), list):
        raise ValueError("graph must contain nodes and edges lists")
    return payload


def _node_labels(node: Mapping[str, Any]) -> tuple[str, ...]:
    raw_labels = node.get("labels", [])
    if not isinstance(raw_labels, list):
        raise ValueError("node labels must be a list")
    labels = {_safe_cypher_identifier(label, "label") for label in raw_labels}
    labels.discard("MnemoEntity")
    return ("MnemoEntity", *sorted(labels))


def _node_row(node: Mapping[str, Any]) -> tuple[tuple[str, ...], dict[str, Any]]:
    node_id = node.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise ValueError("every graph node must have a non-empty string id")
    labels = _node_labels(node)
    properties = {
        key: value for key, value in node.items() if key not in {"id", "labels"}
    }
    return labels, {"id": node_id, "properties": properties}


def _edge_row(edge: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    relationship = _safe_cypher_identifier(edge.get("type", ""), "relationship")
    source = edge.get("source")
    target = edge.get("target")
    if not isinstance(source, str) or not source:
        raise ValueError("every graph edge must have a non-empty string source")
    if not isinstance(target, str) or not target:
        raise ValueError("every graph edge must have a non-empty string target")
    properties = {
        key: value for key, value in edge.items() if key not in {"source", "target", "type"}
    }
    return relationship, {
        "source": source,
        "target": target,
        "properties": properties,
    }


def _chunks(items: list[dict[str, Any]], batch_size: int) -> Iterable[list[dict[str, Any]]]:
    for start in range(0, len(items), batch_size):
        yield items[start : start + batch_size]


def _node_statement(labels: tuple[str, ...]) -> str:
    label_clause = "".join(f":{label}" for label in labels)
    return (
        "UNWIND $nodes AS node "
        f"MERGE (n{label_clause} {{id: node.id}}) "
        "SET n += node.properties"
    )


def _edge_statement(relationship: str) -> str:
    return (
        "UNWIND $edges AS edge "
        "MATCH (source:MnemoEntity {id: edge.source}) "
        "MATCH (target:MnemoEntity {id: edge.target}) "
        f"MERGE (source)-[relationship:{relationship}]->(target) "
        "SET relationship += edge.properties"
    )


def sync_graph(
    client: Neo4jQueryClient,
    graph: Mapping[str, Any] | Any,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> GraphSyncResult:
    """Synchronize a Mnemo graph with parameterized node and edge statements.

    Labels and relationship types are validated before they are inserted into
    Cypher.  All graph values remain query parameters, so node/edge properties
    and identifiers are never interpolated into the statements.
    """

    if not isinstance(client, Neo4jQueryClient):
        raise TypeError("client must be a Neo4jQueryClient")
    if batch_size < 1:
        raise ValueError("batch_size must be at least 1")

    payload = _graph_payload(graph)
    nodes_by_labels: dict[tuple[str, ...], list[dict[str, Any]]] = defaultdict(list)
    normalized_nodes: set[str] = set()
    for raw_node in payload["nodes"]:
        if not isinstance(raw_node, Mapping):
            raise ValueError("graph nodes must be mappings")
        labels, row = _node_row(raw_node)
        if row["id"] in normalized_nodes:
            raise ValueError(f"duplicate graph node id: {row['id']}")
        normalized_nodes.add(row["id"])
        nodes_by_labels[labels].append(row)

    edges_by_relationship: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for raw_edge in payload["edges"]:
        if not isinstance(raw_edge, Mapping):
            raise ValueError("graph edges must be mappings")
        relationship, row = _edge_row(raw_edge)
        if row["source"] not in normalized_nodes or row["target"] not in normalized_nodes:
            raise ValueError(
                f"edge {row['source']} -> {row['target']} references a missing graph node"
            )
        edges_by_relationship[relationship].append(row)

    request_count = 0
    for labels, rows in nodes_by_labels.items():
        statement = _node_statement(labels)
        for batch in _chunks(rows, batch_size):
            client.execute(statement, {"nodes": batch})
            request_count += 1

    for relationship, rows in edges_by_relationship.items():
        statement = _edge_statement(relationship)
        for batch in _chunks(rows, batch_size):
            client.execute(statement, {"edges": batch})
            request_count += 1

    return GraphSyncResult(
        nodes_synced=len(normalized_nodes),
        edges_synced=sum(len(rows) for rows in edges_by_relationship.values()),
        requests=request_count,
    )
