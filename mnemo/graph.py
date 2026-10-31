"""Small JSON property-graph helpers used by the local prototype."""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Protocol, Sequence


GraphPayload = Mapping[str, Any]


class GraphStore(Protocol):
    """Query boundary shared by local and persistent graph implementations.

    The store deliberately returns JSON-compatible dictionaries.  This keeps
    the local mode dependency-free while giving query, context, and UI code a
    stable surface that a Neo4j-backed implementation can provide later.
    """

    def get_node(self, node_id: str) -> dict[str, Any] | None: ...

    def neighbors(
        self,
        node_id: str,
        *,
        relationship_types: Sequence[str] | None = None,
        direction: str = "both",
        limit: int | None = None,
    ) -> list[dict[str, Any]]: ...

    def subgraph(
        self,
        focus: str | Iterable[str] | None = None,
        *,
        depth: int = 1,
        relationship_types: Sequence[str] | None = None,
        labels: Sequence[str] | None = None,
        budget: int = 150,
        as_of: str | int | None = None,
    ) -> dict[str, Any]: ...

    def path(
        self,
        source: str,
        target: str,
        *,
        relationship_types: Sequence[str] | None = None,
        max_depth: int = 6,
    ) -> dict[str, Any] | None: ...

    def rollup(self, *, level: str = "directory", budget: int = 150) -> dict[str, Any]: ...

    def snapshot_at(self, as_of: str | int | None) -> "InMemoryGraphStore": ...

    def history_of(self, node_id: str, *, as_of: str | int | None = None) -> dict[str, Any]: ...

    def verify_edge(self, source: str, relationship: str, target: str) -> dict[str, Any]: ...

    def stats(self) -> dict[str, Any]: ...


@dataclass
class PropertyGraph:
    """In-memory graph that serializes to a stable, inspectable JSON shape."""

    nodes: list[dict[str, Any]] = field(default_factory=list)
    edges: list[dict[str, Any]] = field(default_factory=list)
    _node_ids: set[str] = field(default_factory=set, init=False, repr=False)
    _edge_keys: set[tuple[str, str, str]] = field(default_factory=set, init=False, repr=False)

    def add_node(self, label: str, node_id: str, **properties: Any) -> dict[str, Any]:
        if node_id in self._node_ids:
            for node in self.nodes:
                if node["id"] == node_id:
                    node.setdefault("labels", []).append(label) if label not in node["labels"] else None
                    node.update({key: value for key, value in properties.items() if value is not None})
                    return node

        node = {
            "id": node_id,
            "labels": [label],
            **{key: value for key, value in properties.items() if value is not None},
        }
        self.nodes.append(node)
        self._node_ids.add(node_id)
        return node

    def add_edge(
        self,
        relationship: str,
        source: str,
        target: str,
        **properties: Any,
    ) -> dict[str, Any]:
        edge_key = (source, relationship, target)
        if edge_key in self._edge_keys:
            for edge in self.edges:
                if (edge["source"], edge["type"], edge["target"]) == edge_key:
                    edge.update({key: value for key, value in properties.items() if value is not None})
                    return edge

        edge = {
            "source": source,
            "type": relationship,
            "target": target,
            **{key: value for key, value in properties.items() if value is not None},
        }
        self.edges.append(edge)
        self._edge_keys.add(edge_key)
        return edge

    def to_dict(self, **metadata: Any) -> dict[str, Any]:
        return {
            "schema_version": "0.1.0",
            **metadata,
            "nodes": self.nodes,
            "edges": self.edges,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PropertyGraph":
        graph = cls()
        for node in payload.get("nodes", []):
            labels = node.get("labels", ["Unknown"])
            graph.add_node(labels[0], node["id"], **{k: v for k, v in node.items() if k not in {"id", "labels"}})
            for label in labels[1:]:
                graph.add_node(label, node["id"])
        for edge in payload.get("edges", []):
            graph.add_edge(
                edge["type"],
                edge["source"],
                edge["target"],
                **{k: v for k, v in edge.items() if k not in {"source", "type", "target"}},
            )
        return graph

    def nodes_with_label(self, label: str) -> Iterable[dict[str, Any]]:
        return (node for node in self.nodes if label in node.get("labels", []))

    def as_store(self) -> "InMemoryGraphStore":
        """Expose this mutable builder through the read-oriented store API."""

        return InMemoryGraphStore(self)


def _labels(node: Mapping[str, Any]) -> set[str]:
    return {str(label) for label in node.get("labels", [])}


def _edge_matches(
    edge: Mapping[str, Any],
    relationship_types: set[str] | None,
    *,
    source: str | None = None,
    target: str | None = None,
) -> bool:
    if relationship_types and edge.get("type") not in relationship_types:
        return False
    if source is not None and edge.get("source") != source:
        return False
    if target is not None and edge.get("target") != target:
        return False
    return True


class InMemoryGraphStore:
    """Read-oriented GraphStore implementation over the local JSON graph."""

    def __init__(self, graph: GraphPayload | PropertyGraph) -> None:
        if isinstance(graph, PropertyGraph):
            self._metadata: dict[str, Any] = {}
            self._property_graph = graph
        else:
            self._metadata = {
                key: value for key, value in graph.items() if key not in {"nodes", "edges"}
            }
            self._property_graph = PropertyGraph.from_dict(dict(graph))

        self._nodes = {node["id"]: node for node in self._property_graph.nodes}
        self._edges = list(self._property_graph.edges)
        self._outgoing: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._incoming: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for edge in self._edges:
            self._outgoing[edge["source"]].append(edge)
            self._incoming[edge["target"]].append(edge)

    def to_dict(self) -> dict[str, Any]:
        return {
            **self._metadata,
            "nodes": list(self._property_graph.nodes),
            "edges": list(self._property_graph.edges),
        }

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        return self._nodes.get(node_id)

    def neighbors(
        self,
        node_id: str,
        *,
        relationship_types: Sequence[str] | None = None,
        direction: str = "both",
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        if direction not in {"in", "out", "both"}:
            raise ValueError("direction must be 'in', 'out', or 'both'")
        allowed = set(relationship_types or ())
        edges: list[dict[str, Any]] = []
        if direction in {"out", "both"}:
            edges.extend(edge for edge in self._outgoing.get(node_id, []) if _edge_matches(edge, allowed))
        if direction in {"in", "both"}:
            edges.extend(edge for edge in self._incoming.get(node_id, []) if _edge_matches(edge, allowed))
        seen: set[str] = set()
        nodes: list[dict[str, Any]] = []
        for edge in edges:
            other_id = edge["target"] if edge["source"] == node_id else edge["source"]
            if other_id in seen or other_id not in self._nodes:
                continue
            seen.add(other_id)
            nodes.append(self._nodes[other_id])
            if limit is not None and len(nodes) >= max(0, limit):
                break
        return nodes

    def _node_is_visible(self, node: Mapping[str, Any], as_of: str | int | None) -> bool:
        if as_of is None:
            return True
        if isinstance(as_of, int) or (isinstance(as_of, str) and as_of.isdigit()):
            history_index = node.get("history_index")
            return history_index is None or int(history_index) <= int(as_of)
        timestamp = str(node.get("timestamp") or node.get("author_time") or "")
        return not timestamp or timestamp <= str(as_of)

    def _visible_node_ids(self, as_of: str | int | None) -> set[str]:
        return {
            node_id
            for node_id, node in self._nodes.items()
            if self._node_is_visible(node, as_of)
        }

    def subgraph(
        self,
        focus: str | Iterable[str] | None = None,
        *,
        depth: int = 1,
        relationship_types: Sequence[str] | None = None,
        labels: Sequence[str] | None = None,
        budget: int = 150,
        as_of: str | int | None = None,
    ) -> dict[str, Any]:
        if depth < 0:
            raise ValueError("depth must be non-negative")
        budget = max(1, min(int(budget), 2_000))
        visible_ids = self._visible_node_ids(as_of)
        allowed_relationships = set(relationship_types or ())
        allowed_labels = set(labels or ())
        if focus is None:
            focus_ids = []
        elif isinstance(focus, str):
            focus_ids = [focus]
        else:
            focus_ids = list(focus)

        selected: list[str] = []
        selected_set: set[str] = set()
        queue: deque[tuple[str, int]] = deque()
        for node_id in focus_ids:
            if node_id in visible_ids and node_id in self._nodes and node_id not in selected_set:
                selected.append(node_id)
                selected_set.add(node_id)
                queue.append((node_id, 0))

        if focus_ids:
            while queue and len(selected) < budget:
                node_id, current_depth = queue.popleft()
                if current_depth >= depth:
                    continue
                for edge in [*self._outgoing.get(node_id, []), *self._incoming.get(node_id, [])]:
                    if not _edge_matches(edge, allowed_relationships):
                        continue
                    other_id = edge["target"] if edge["source"] == node_id else edge["source"]
                    if other_id not in visible_ids or other_id in selected_set:
                        continue
                    selected.append(other_id)
                    selected_set.add(other_id)
                    queue.append((other_id, current_depth + 1))
                    if len(selected) >= budget:
                        break
        else:
            selected.extend(node_id for node_id in self._nodes if node_id in visible_ids)

        if allowed_labels:
            selected = [node_id for node_id in selected if _labels(self._nodes[node_id]).intersection(allowed_labels)]
            selected_set = set(selected)
        selected = selected[:budget]
        selected_set = set(selected)
        edges = [
            edge
            for edge in self._edges
            if edge["source"] in selected_set
            and edge["target"] in selected_set
            and _edge_matches(edge, allowed_relationships)
            and edge["source"] in visible_ids
            and edge["target"] in visible_ids
        ]
        return {
            **self._metadata,
            "nodes": [self._nodes[node_id] for node_id in selected],
            "edges": edges,
            "view": {
                "focus": focus_ids,
                "depth": depth,
                "budget": budget,
                "returned_nodes": len(selected),
                "returned_edges": len(edges),
                "truncated": len(selected) >= budget and len(selected) < len(visible_ids),
                "as_of": as_of,
            },
        }

    def path(
        self,
        source: str,
        target: str,
        *,
        relationship_types: Sequence[str] | None = None,
        max_depth: int = 6,
    ) -> dict[str, Any] | None:
        if source not in self._nodes or target not in self._nodes:
            return None
        if source == target:
            return {"nodes": [self._nodes[source]], "edges": []}
        allowed = set(relationship_types or ())
        queue: deque[str] = deque([source])
        previous: dict[str, tuple[str, dict[str, Any]]] = {}
        depths = {source: 0}
        while queue:
            current = queue.popleft()
            if depths[current] >= max_depth:
                continue
            for edge in self._outgoing.get(current, []):
                if not _edge_matches(edge, allowed):
                    continue
                next_id = edge["target"]
                if next_id in depths:
                    continue
                previous[next_id] = (current, edge)
                depths[next_id] = depths[current] + 1
                if next_id == target:
                    queue.clear()
                    break
                queue.append(next_id)
        if target not in previous:
            return None
        node_ids = [target]
        edges: list[dict[str, Any]] = []
        current = target
        while current != source:
            parent, edge = previous[current]
            node_ids.append(parent)
            edges.append(edge)
            current = parent
        node_ids.reverse()
        edges.reverse()
        return {"nodes": [self._nodes[node_id] for node_id in node_ids], "edges": edges}

    def rollup(self, *, level: str = "directory", budget: int = 150) -> dict[str, Any]:
        if level not in {"project", "directory", "file"}:
            raise ValueError("level must be 'project', 'directory', or 'file'")
        budget = max(1, min(int(budget), 2_000))
        groups: dict[str, list[str]] = defaultdict(list)
        for node in self._nodes.values():
            path = str(node.get("path") or node.get("file_path") or "")
            if level == "project":
                key = "project"
            elif level == "file":
                key = path or str(node.get("id"))
            else:
                key = path.rsplit("/", 1)[0] if "/" in path else "."
            groups[key].append(node["id"])
        ordered_groups = sorted(groups.items(), key=lambda item: (-len(item[1]), item[0]))[:budget]
        group_ids = {key: f"cluster:{level}:{key}" for key, _ in ordered_groups}
        clusters = [
            {
                "id": group_ids[key],
                "labels": ["Cluster"],
                "level": level,
                "label": key,
                "members": members,
                "member_count": len(members),
            }
            for key, members in ordered_groups
        ]
        node_to_group = {
            member: group_ids[key]
            for key, members in ordered_groups
            for member in members
        }
        aggregated: dict[tuple[str, str, str], int] = defaultdict(int)
        for edge in self._edges:
            source_group = node_to_group.get(edge["source"])
            target_group = node_to_group.get(edge["target"])
            if not source_group or not target_group or source_group == target_group:
                continue
            aggregated[(source_group, edge["type"], target_group)] += 1
        edges = [
            {"source": source, "type": relationship, "target": target, "weight": weight}
            for (source, relationship, target), weight in sorted(aggregated.items())
        ]
        return {
            **self._metadata,
            "nodes": clusters,
            "edges": edges,
            "view": {"level": level, "budget": budget, "truncated": len(groups) > len(clusters)},
        }

    def snapshot_at(self, as_of: str | int | None) -> "InMemoryGraphStore":
        return InMemoryGraphStore(self.subgraph(as_of=as_of, budget=2_000))

    def history_of(self, node_id: str, *, as_of: str | int | None = None) -> dict[str, Any]:
        if node_id not in self._nodes:
            return {"node": None, "nodes": [], "edges": []}
        visible = self._visible_node_ids(as_of)
        edges = [
            edge
            for edge in self._edges
            if node_id in {edge["source"], edge["target"]}
            and edge["source"] in visible
            and edge["target"] in visible
        ]
        node_ids = {node_id}
        node_ids.update(edge["source"] for edge in edges)
        node_ids.update(edge["target"] for edge in edges)
        return {
            "node": self._nodes[node_id],
            "nodes": [self._nodes[item] for item in node_ids if item in self._nodes],
            "edges": edges,
        }

    def verify_edge(self, source: str, relationship: str, target: str) -> dict[str, Any]:
        edge = next(
            (
                candidate
                for candidate in self._edges
                if candidate["source"] == source
                and candidate["type"] == relationship
                and candidate["target"] == target
            ),
            None,
        )
        return {
            "verified": edge is not None,
            "source": source,
            "relationship": relationship,
            "target": target,
            "edge": edge,
            "evidence_tier": (edge or {}).get("evidence_tier", "T0") if edge else None,
        }

    def stats(self) -> dict[str, Any]:
        node_counts: dict[str, int] = defaultdict(int)
        edge_counts: dict[str, int] = defaultdict(int)
        for node in self._nodes.values():
            for label in node.get("labels", []):
                node_counts[label] += 1
        for edge in self._edges:
            edge_counts[str(edge.get("type"))] += 1
        return {
            "nodes": len(self._nodes),
            "edges": len(self._edges),
            "node_counts": dict(sorted(node_counts.items())),
            "edge_counts": dict(sorted(edge_counts.items())),
        }
