"""Command-line interface for Mnemo's local deterministic prototype."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from .ingest import IngestionError, ingest_repository
from .neo4j import Neo4jError, Neo4jQueryClient
from .query import format_result, query_graph


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mnemo",
        description="Build and question a deterministic code-intent graph.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest = subparsers.add_parser("ingest", help="ingest a local Git repository")
    ingest.add_argument("repository", type=Path, help="path to a local Git repository")
    ingest.add_argument("--output", "-o", type=Path, required=True, help="JSON graph output path")
    ingest.add_argument(
        "--max-commits",
        type=int,
        default=500,
        help="maximum number of commits to inspect (default: 500)",
    )

    ask = subparsers.add_parser("ask", help="ask a question against a JSON graph")
    ask.add_argument("graph", type=Path, help="graph JSON created by ingest")
    ask.add_argument("question", help="natural-language question")
    ask.add_argument("--json", action="store_true", help="emit the structured result as JSON")

    serve = subparsers.add_parser("serve", help="start the local web interface")
    serve.add_argument("--host", default="127.0.0.1", help="bind address (default: 127.0.0.1)")
    serve.add_argument("--port", type=int, default=8000, help="bind port (default: 8000)")
    serve.add_argument(
        "--graph",
        type=Path,
        help="optional graph JSON to load when the server starts",
    )

    neo4j_status = subparsers.add_parser("neo4j-status", help="check Neo4j configuration and connectivity")
    neo4j_status.add_argument("--database", default="neo4j", help="Neo4j database name")
    neo4j_status.add_argument("--no-check", action="store_true", help="only inspect local configuration")

    neo4j_sync = subparsers.add_parser("neo4j-sync", help="sync a graph JSON file to Neo4j")
    neo4j_sync.add_argument("graph", type=Path, help="graph JSON created by ingest")
    neo4j_sync.add_argument("--database", default="neo4j", help="Neo4j database name")
    neo4j_sync.add_argument("--batch-size", type=int, default=500, help="nodes/edges per request")
    return parser


def _run_ingest(args: argparse.Namespace) -> int:
    if args.max_commits < 1:
        raise IngestionError("--max-commits must be at least 1")
    graph = ingest_repository(args.repository, max_commits=args.max_commits)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(graph, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(
        f"Wrote {len(graph['nodes'])} nodes and {len(graph['edges'])} edges "
        f"to {args.output}"
    )
    return 0


def _run_ask(args: argparse.Namespace) -> int:
    if not args.graph.exists():
        raise IngestionError(f"graph file does not exist: {args.graph}")
    graph = json.loads(args.graph.read_text(encoding="utf-8"))
    result = query_graph(graph, args.question)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(format_result(result))
    return 0 if result["status"] == "verified" else 2


def _run_serve(args: argparse.Namespace) -> int:
    from .web import AppState, serve

    state = AppState()
    if args.graph:
        graph = json.loads(args.graph.read_text(encoding="utf-8"))
        if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
            raise IngestionError("Invalid Mnemo graph JSON.")
        state.set_graph(graph)
    if not 1 <= args.port <= 65535:
        raise IngestionError("--port must be between 1 and 65535")
    serve(args.host, args.port, state)
    return 0


def _load_graph(path: Path) -> dict:
    if not path.exists():
        raise IngestionError(f"graph file does not exist: {path}")
    graph = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) or not isinstance(graph.get("edges"), list):
        raise IngestionError("Invalid Mnemo graph JSON.")
    return graph


def _run_neo4j_status(args: argparse.Namespace) -> int:
    client = Neo4jQueryClient.from_env(database=args.database)
    status = client.status() if args.no_check else client.check_connection()
    print(json.dumps(status, indent=2, sort_keys=True))
    return 0 if args.no_check or status.get("connected") else 1


def _run_neo4j_sync(args: argparse.Namespace) -> int:
    if args.batch_size < 1:
        raise IngestionError("--batch-size must be at least 1")
    graph = _load_graph(args.graph)
    client = Neo4jQueryClient.from_env(database=args.database)
    connection = client.check_connection()
    if not connection.get("connected"):
        print(json.dumps(connection, indent=2, sort_keys=True))
        return 1
    result = client.sync_graph(graph, batch_size=args.batch_size)
    print(json.dumps({"connection": connection, "sync": result.as_dict()}, indent=2, sort_keys=True))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "ingest":
            return _run_ingest(args)
        if args.command == "ask":
            return _run_ask(args)
        if args.command == "serve":
            return _run_serve(args)
        if args.command == "neo4j-status":
            return _run_neo4j_status(args)
        if args.command == "neo4j-sync":
            return _run_neo4j_sync(args)
    except (IngestionError, Neo4jError, OSError, json.JSONDecodeError) as error:
        print(f"mnemo: {error}", file=sys.stderr)
        return 1
    parser.error("unknown command")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
