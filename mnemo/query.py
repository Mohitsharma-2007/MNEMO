"""Evidence-backed, dependency-free query logic for the local graph."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any


IDENTIFIER_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_./-]{2,}")
QUOTED_PATTERN = re.compile(r"[`\"']([^`\"']+)[`\"']")
GREETING_PATTERN = re.compile(r"^(?:hi|hello|hey|hiya|good morning|good afternoon|good evening|thanks|thank you)[!.?\s]*$", re.IGNORECASE)


def _node_index(graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {node["id"]: node for node in graph.get("nodes", [])}


def _candidate_score(token: str, node: dict[str, Any]) -> int:
    token = token.lower()
    name = str(node.get("name", "")).lower()
    path = str(node.get("path", node.get("file_path", ""))).lower()
    node_id = str(node.get("id", "")).lower()
    labels = set(node.get("labels", []))
    if not labels.intersection({"File", "Function", "Class", "ConfigKey"}):
        return 0
    if token == name or token == path or token == node_id:
        return 100
    if name and token in name:
        return 70
    if path and token in path:
        return 60
    if node_id and token in node_id:
        return 40
    return 0


def _find_target(question: str, nodes: list[dict[str, Any]]) -> dict[str, Any] | None:
    quoted = [match.group(1) for match in QUOTED_PATTERN.finditer(question)]
    tokens = quoted + IDENTIFIER_PATTERN.findall(question)
    best: tuple[int, dict[str, Any]] | None = None
    for token in tokens:
        for node in nodes:
            score = _candidate_score(token, node)
            if score and (best is None or score > best[0]):
                best = (score, node)
    return best[1] if best else None


def _edges_by_type(graph: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in graph.get("edges", []):
        grouped[edge["type"]].append(edge)
    return grouped


def _repository_context(graph: dict[str, Any]) -> tuple[str, dict[str, int]]:
    repository_value = graph.get("repository")
    repository = repository_value if isinstance(repository_value, dict) else {}
    name = str(repository.get("name") or "the active repository")
    counts: dict[str, int] = defaultdict(int)
    for node in graph.get("nodes", []):
        for label in node.get("labels", []):
            counts[label] += 1
    return name, dict(counts)


def _conversation_result(graph: dict[str, Any], question: str) -> dict[str, Any] | None:
    normalized = question.strip().lower()
    if not normalized:
        return None
    name, counts = _repository_context(graph)
    if GREETING_PATTERN.fullmatch(normalized):
        answer = (
            f"Hello — I'm Mnemo. I have {name} loaded, with {counts.get('File', 0)} files, "
            f"{counts.get('Function', 0)} functions, and {counts.get('Commit', 0)} commits in the current graph. "
            "Ask me what changed, why a symbol exists, who touched it, or how the evidence connects."
        )
    elif any(phrase in normalized for phrase in ("what can you do", "how can you help", "help me")):
        answer = (
            "I can explain this repository in two ways: conversationally for orientation, and with verified graph evidence for intent. "
            "Use the Architecture page for relationships, Source for symbols and code, People for contributors, Git track for branches and pull requests, "
            "and Evidence chain for commit → author → code → decision lineage."
        )
    elif "graph rag" in normalized or "graphrag" in normalized:
        answer = (
            "Graph RAG combines retrieval with relationships. Mnemo first builds a deterministic property graph from files, symbols, commits, authors, "
            "and decisions; it then traverses those edges to find evidence before answering. Optional AI is only an explanation layer, so it cannot invent "
            "an intent claim when the graph has no supporting edge."
        )
    elif normalized in {"what is this", "what is mnemo", "who are you"}:
        answer = (
            f"Mnemo is an evidence-first repository guide for {name}. It maps code structure and Git history, then answers 'why' questions only when "
            "the repository records a decision or change that supports the answer."
        )
    else:
        return None
    return {
        "status": "chat",
        "confidence": 1.0,
        "question": question,
        "answer": answer,
        "target": None,
        "evidence": [],
        "mode": "conversation",
    }


def query_graph(graph: dict[str, Any], question: str) -> dict[str, Any]:
    """Answer a question only when the graph contains a linked decision."""

    conversational = _conversation_result(graph, question)
    if conversational is not None:
        return conversational

    nodes = graph.get("nodes", [])
    by_id = _node_index(graph)
    edges = _edges_by_type(graph)
    target = _find_target(question, nodes)
    if target is None:
        return {
            "status": "abstain",
            "confidence": 0.0,
            "question": question,
            "answer": "Refusal: no code entity in the graph matches the question, so Mnemo will not fabricate intent.",
            "target": None,
            "evidence": [],
        }

    target_id = target["id"]
    target_ids = {target_id}
    for edge in edges.get("CONTAINS", []):
        if edge["source"] == target_id and by_id.get(edge["target"], {}).get("labels", []) == ["Function"]:
            target_ids.add(edge["target"])
    target_path = target.get("path", target.get("file_path"))
    # File-level history is valid evidence for a file question. For a symbol
    # or config-key question we require a direct hunk-to-symbol edge; falling
    # back to every commit touching the containing file would overclaim intent.
    if target_path and "File" in target.get("labels", []):
        for node in nodes:
            if "File" in node.get("labels", []) and node.get("path") == target_path:
                target_ids.add(node["id"])

    commit_ids: set[str] = set()
    modifications: list[dict[str, Any]] = []
    for edge in edges.get("MODIFIED", []):
        if edge["target"] in target_ids:
            commit_ids.add(edge["source"])
            modifications.append(edge)

    decisions_by_commit: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for edge in edges.get("RESULTED_IN", []):
        if edge["source"] in commit_ids:
            decision = by_id.get(edge["target"])
            if decision:
                decisions_by_commit[edge["source"]].append(decision)

    superseded_decisions = {
        edge["target"] for edge in edges.get("SUPERSEDES", []) if edge["source"] in by_id
    }
    candidates: list[dict[str, Any]] = []
    for commit_id in commit_ids:
        commit = by_id.get(commit_id)
        if not commit:
            continue
        for decision in decisions_by_commit.get(commit_id, []):
            if decision["id"] in superseded_decisions or decision.get("status") == "expired":
                continue
            candidates.append({"commit": commit, "decision": decision})

    # ``git log`` order is authoritative when two commits share a timestamp
    # (common in fast local test repositories).  The index is newest-first.
    candidates.sort(
        key=lambda item: (
            item["commit"].get("history_index", 10**9),
            str(item["commit"].get("timestamp", "")),
        )
    )
    if not candidates:
        labels = ", ".join(target.get("labels", []))
        return {
            "status": "abstain",
            "confidence": 0.0,
            "question": question,
            "answer": (
                f"Refusal: the graph contains the {labels or 'code'} entity "
                f"`{target.get('name', target.get('path', target_id))}`, but no linked commit decision records its intent; "
                "Mnemo will not fabricate intent."
            ),
            "target": target,
            "evidence": [],
        }

    contributor_by_commit: dict[str, dict[str, Any]] = {}
    for edge in edges.get("AUTHORED", []):
        if edge["target"] in commit_ids and edge["source"] in by_id:
            contributor_by_commit[edge["target"]] = by_id[edge["source"]]

    evidence = []
    for candidate in candidates[:3]:
        commit = candidate["commit"]
        decision = candidate["decision"]
        contributor = contributor_by_commit.get(commit["id"])
        evidence.append(
            {
                "decision": {
                    "id": decision["id"],
                    "summary": decision.get("summary"),
                    "status": decision.get("status", "active"),
                },
                "commit": {
                    "sha": commit.get("sha"),
                    "message": commit.get("message"),
                    "timestamp": commit.get("timestamp"),
                },
                "contributor": {
                    "display_name": contributor.get("display_name") if contributor else None,
                    "email": contributor.get("username") if contributor else commit.get("author_email"),
                },
                "modified_target": [
                    edge
                    for edge in modifications
                    if edge["source"] == commit["id"]
                ],
            }
        )

    primary = evidence[0]
    summary = primary["decision"]["summary"] or primary["commit"]["message"]
    author = primary["contributor"]["display_name"] or primary["contributor"]["email"] or "an unknown contributor"
    answer = (
        f"The latest recorded intent for `{target.get('name', target.get('path', target_id))}` is: "
        f"{summary} (committed by {author} on {primary['commit']['timestamp']})."
    )
    return {
        "status": "verified",
        "confidence": 1.0,
        "question": question,
        "answer": answer,
        "target": target,
        "evidence": evidence,
    }


def format_result(result: dict[str, Any]) -> str:
    """Render a query result for a human using the CLI."""

    lines = [result["answer"], f"Confidence: {result['confidence']:.2f}"]
    if result.get("target"):
        target = result["target"]
        target_name = target.get("name", target.get("path", target.get("id")))
        lines.append(f"Target: {target_name}")
    for index, evidence in enumerate(result.get("evidence", []), start=1):
        commit = evidence["commit"]
        contributor = evidence["contributor"]
        lines.extend(
            [
                f"\nEvidence {index}:",
                f"  Decision: {evidence['decision']['summary']}",
                f"  Commit: {commit['sha']} ({commit['timestamp']})",
                f"  Author: {contributor['display_name'] or contributor['email']}",
                f"  Message: {commit['message']}",
            ]
        )
    return "\n".join(lines)
