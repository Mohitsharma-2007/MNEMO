"""Contributor context agents and the deterministic Mnemo orchestrator.

Each contributor receives a bounded, isolated context assembled only from the
GitHub inspection payload and the deterministic local graph. These are not
pretend independent model calls: an agent cannot invent facts, and the
orchestrator only synthesizes records that exist in its context. Optional AI
assist remains a separate paraphrase layer in ``mnemo.ai``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any, Iterable


MAX_AGENT_COMMITS = 24
MAX_AGENT_PULLS = 16
MAX_AGENT_ISSUES = 16
MAX_AGENT_FILES = 36
MAX_ORCHESTRATOR_PARTICIPANTS = 8
MAX_TIMELINE_FLOW_NODES = 14


def _text(value: Any) -> str:
    return str(value or "").strip()


def _login_from_commit(commit: dict[str, Any]) -> str | None:
    author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    committer = commit.get("committer") if isinstance(commit.get("committer"), dict) else {}
    value = author.get("login") or committer.get("login")
    return _text(value) or None


def _login_from_item(item: dict[str, Any]) -> str | None:
    user = item.get("user") if isinstance(item.get("user"), dict) else {}
    return _text(user.get("login")) or None


def _tokens(value: str) -> set[str]:
    return {token.lower() for token in re.findall(r"[A-Za-z0-9_./-]{3,}", value)}


def timeline_context(graph: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Return the local commit history in first-to-latest order.

    ``git log`` is ingested newest-first, so the descending history index is
    the stable chronological order used by the AI room. The context is built
    from the local graph, not from generated conversation text.
    """

    if not isinstance(graph, dict):
        return []
    nodes = graph.get("nodes", [])
    edges = graph.get("edges", [])
    by_id = {node.get("id"): node for node in nodes if isinstance(node, dict) and node.get("id")}
    commits = [node for node in nodes if isinstance(node, dict) and "Commit" in node.get("labels", [])]
    commits.sort(key=lambda node: (-int(node.get("history_index", 10**9)), str(node.get("timestamp", ""))))
    timeline: list[dict[str, Any]] = []
    for position, commit in enumerate(commits):
        author_id = next(
            (
                edge.get("source")
                for edge in edges
                if isinstance(edge, dict)
                and edge.get("type") == "AUTHORED"
                and edge.get("target") == commit.get("id")
            ),
            None,
        )
        author = by_id.get(author_id, {})
        files = []
        for edge in edges:
            if not isinstance(edge, dict) or edge.get("type") != "MODIFIED" or edge.get("source") != commit.get("id"):
                continue
            target = by_id.get(edge.get("target"), {})
            path = target.get("path") or target.get("file_path")
            if path and path not in files:
                files.append(path)
        timeline.append(
            {
                "id": f"timeline:{commit.get('sha') or commit.get('id')}",
                "commit_id": commit.get("id"),
                "position": position + 1,
                "history_index": commit.get("history_index"),
                "sha": commit.get("sha"),
                "message": commit.get("message") or "Recorded repository change",
                "timestamp": commit.get("timestamp"),
                "commit_kind": commit.get("commit_kind", "commit"),
                "parent_count": commit.get("parent_count", 0),
                "author": author.get("display_name") or author.get("username") or commit.get("author_email") or "Unknown contributor",
                "author_login": author.get("login"),
                "files": files[:24],
            }
        )
    return timeline


def _timeline_focus(timeline: list[dict[str, Any]], question: str, target: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Choose a readable timeline window while retaining first/latest anchors."""

    if not timeline:
        return []
    tokens = _tokens(question + " " + " ".join(_text(target.get(key)) for key in ("name", "path", "file_path", "signature")) if target else question)
    scored: list[tuple[int, dict[str, Any]]] = []
    for item in timeline:
        searchable = _tokens(" ".join([_text(item.get("message")), *[_text(file) for file in item.get("files", [])]]))
        score = len(tokens.intersection(searchable))
        scored.append((score, item))
    matched = [item for score, item in scored if score]
    selected = matched[-(MAX_TIMELINE_FLOW_NODES - 2):] if matched else timeline[-(MAX_TIMELINE_FLOW_NODES - 2):]
    anchors = [timeline[0], timeline[-1]]
    result = {item["id"]: item for item in [*anchors, *selected]}
    return sorted(result.values(), key=lambda item: item["position"])


@dataclass
class ContributorAgent:
    """A bounded contributor persona backed by repository evidence."""

    login: str
    avatar_url: str | None = None
    html_url: str | None = None
    contributions: int | None = None
    commits: list[dict[str, Any]] = field(default_factory=list)
    pull_requests: list[dict[str, Any]] = field(default_factory=list)
    issues: list[dict[str, Any]] = field(default_factory=list)
    touched_files: list[str] = field(default_factory=list)
    evidence_source: str = "github_contributor"

    @property
    def agent_id(self) -> str:
        return f"contributor-agent:{self.login}"

    @property
    def commit_count(self) -> int:
        return len(self.commits)

    def searchable_text(self) -> str:
        parts = [self.login, *self.touched_files]
        parts.extend(_text(item.get("message")) for item in self.commits)
        parts.extend(_text(item.get("title")) for item in self.pull_requests)
        parts.extend(_text(item.get("title")) for item in self.issues)
        return " ".join(parts).lower()

    def summary(self) -> dict[str, Any]:
        dates = [item.get("date") for item in self.commits if item.get("date")]
        return {
            "agent_id": self.agent_id,
            "login": self.login,
            "avatar_url": self.avatar_url,
            "html_url": self.html_url,
            "contributions": self.contributions,
            "sampled_commit_count": self.commit_count,
            "pull_request_count": len(self.pull_requests),
            "issue_count": len(self.issues),
            "first_commit": min(dates) if dates else None,
            "last_commit": max(dates) if dates else None,
            "touched_file_count": len(self.touched_files),
            "touched_files": self.touched_files[:30],
            "evidence_source": self.evidence_source,
            "verified_profile": bool(self.html_url or self.avatar_url),
        }

    def detail(self) -> dict[str, Any]:
        return {
            **self.summary(),
            "commits": self.commits[:MAX_AGENT_COMMITS],
            "pull_requests": self.pull_requests[:MAX_AGENT_PULLS],
            "issues": self.issues[:MAX_AGENT_ISSUES],
            "touched_files": self.touched_files[:MAX_AGENT_FILES],
            "context_policy": "Only fresh GitHub metadata and deterministic local graph evidence are included.",
        }

    def context_lines(self, question: str = "") -> list[str]:
        """Return short evidence lines for an orchestrator transcript."""

        question_tokens = _tokens(question)
        lines: list[str] = []
        relevant_commits = [
            commit
            for commit in self.commits
            if not question_tokens or question_tokens.intersection(_tokens(_text(commit.get("message"))))
        ]
        for commit in (relevant_commits or self.commits)[:5]:
            sha = _text(commit.get("sha"))[:12]
            date = _text(commit.get("date")) or "unknown date"
            message = _text(commit.get("message")) or "untitled commit"
            lines.append(f"Commit {sha} on {date}: {message}")
        relevant_pulls = [
            pull
            for pull in self.pull_requests
            if not question_tokens or question_tokens.intersection(_tokens(_text(pull.get("title")) + " " + _text(pull.get("body"))))
        ]
        for pull in (relevant_pulls or self.pull_requests)[:3]:
            lines.append(f"Pull request #{pull.get('number', '?')}: {_text(pull.get('title')) or 'untitled'} ({_text(pull.get('state')) or 'unknown state'})")
        if self.touched_files:
            lines.append("Touched files: " + ", ".join(self.touched_files[:8]))
        if not lines:
            lines.append("No bounded commit, pull request, issue, or file evidence was linked to this contributor in the current snapshot.")
        return lines


class ContributorOrchestrator:
    """Coordinates contributor agents without fabricating cross-agent claims."""

    def __init__(self, agents: Iterable[ContributorAgent] = ()) -> None:
        self.agents = {agent.login.lower(): agent for agent in agents}

    @classmethod
    def from_inspection(cls, inspection: dict[str, Any], graph: dict[str, Any] | None = None) -> "ContributorOrchestrator":
        github = inspection.get("github", {}) if isinstance(inspection, dict) else {}
        contributors = github.get("contributors", []) if isinstance(github, dict) else []
        commits = github.get("commits", []) if isinstance(github, dict) else []
        pull_requests = github.get("pull_requests", []) if isinstance(github, dict) else []
        issues = github.get("issues", []) if isinstance(github, dict) else []
        by_login: dict[str, ContributorAgent] = {}
        for contributor in contributors:
            login = _text(contributor.get("login")) if isinstance(contributor, dict) else ""
            if not login:
                continue
            by_login[login.lower()] = ContributorAgent(
                login=login,
                avatar_url=contributor.get("avatar_url"),
                html_url=contributor.get("html_url"),
                contributions=contributor.get("contributions"),
            )

        def agent_for(login: str | None) -> ContributorAgent | None:
            if not login:
                return None
            return by_login.get(login.lower())

        for commit in commits:
            if not isinstance(commit, dict):
                continue
            agent = agent_for(_login_from_commit(commit))
            if agent:
                agent.commits.append(
                    {
                        key: commit.get(key)
                        for key in ("sha", "html_url", "message", "date", "author", "committer")
                        if commit.get(key) is not None
                    }
                )
        for pull in pull_requests:
            if not isinstance(pull, dict):
                continue
            agent = agent_for(_login_from_item(pull))
            if agent:
                agent.pull_requests.append(
                    {
                        key: pull.get(key)
                        for key in ("number", "title", "body", "state", "html_url", "created_at", "updated_at", "merged_at", "labels")
                        if pull.get(key) is not None
                    }
                )
        for issue in issues:
            if not isinstance(issue, dict):
                continue
            agent = agent_for(_login_from_item(issue))
            if agent:
                agent.issues.append(
                    {
                        key: issue.get(key)
                        for key in ("number", "title", "body", "state", "html_url", "created_at", "updated_at", "labels")
                        if issue.get(key) is not None
                    }
                )

        if graph:
            node_by_id = {node.get("id"): node for node in graph.get("nodes", [])}
            for node in graph.get("nodes", []):
                if "Commit" in node.get("labels", []):
                    author = node.get("author_login") or node.get("author") or node.get("author_email")
                    if author:
                        login = _text(author).removeprefix("contributor:").strip().lower()
                        agent = by_login.get(login)
                        if agent:
                            sha = _text(node.get("sha") or node.get("id"))
                            if sha and not any(_text(c.get("sha")) == sha for c in agent.commits):
                                agent.commits.append({
                                    "sha": sha,
                                    "message": node.get("message") or "Commit",
                                    "date": node.get("timestamp") or node.get("date"),
                                    "author": {"login": agent.login, "name": agent.login},
                                })
            commit_login = {
                node.get("id"): _login_from_commit({"author": {"login": _text(node.get("author_login"))}})
                for node in graph.get("nodes", [])
                if "Commit" in node.get("labels", []) and node.get("author_login")
            }
            github_by_sha = {
                _text(commit.get("sha")): _login_from_commit(commit)
                for commit in commits
                if isinstance(commit, dict) and commit.get("sha")
            }
            for edge in graph.get("edges", []):
                if edge.get("type") != "AUTHORED":
                    continue
                contrib_node = node_by_id.get(edge.get("source"), {})
                c_login = _text(contrib_node.get("login") or contrib_node.get("name") or contrib_node.get("id", "")).removeprefix("contributor:").strip().lower()
                agent = by_login.get(c_login)
                commit_node = node_by_id.get(edge.get("target"), {})
                if not agent:
                    login = github_by_sha.get(_text(commit_node.get("sha"))) or commit_login.get(edge.get("target"))
                    agent = agent_for(login)
                if not agent:
                    continue
                for modified in graph.get("edges", []):
                    if modified.get("type") != "MODIFIED" or modified.get("source") != edge.get("target"):
                        continue
                    target = node_by_id.get(modified.get("target"), {})
                    path = target.get("path") or target.get("file_path") or target.get("name")
                    if path and path not in agent.touched_files:
                        agent.touched_files.append(path)

        return cls(by_login.values())

    def summaries(self, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
        needle = query.strip().lower()
        agents = [agent for agent in self.agents.values() if not needle or needle in agent.searchable_text()]
        agents.sort(key=lambda agent: (agent.contributions or 0, agent.commit_count, agent.login.lower()), reverse=True)
        return [agent.summary() for agent in agents[: max(1, min(limit, 1000))]]

    def get(self, login: str) -> ContributorAgent | None:
        return self.agents.get(login.lower())

    def ask(
        self,
        question: str,
        target: dict[str, Any] | None = None,
        graph: dict[str, Any] | None = None,
        ai_requested: bool = False,
    ) -> dict[str, Any]:
        """Coordinate evidence agents over the complete local timeline."""

        question_tokens = _tokens(question)
        target_text = " ".join(
            _text(target.get(key)) for key in ("name", "path", "file_path", "signature")
        ) if target else ""
        target_tokens = _tokens(target_text)
        timeline = timeline_context(graph)
        timeline_focus = _timeline_focus(timeline, question, target)
        timeline_by_sha = {_text(item.get("sha")): item for item in timeline if item.get("sha")}
        scored: list[tuple[int, ContributorAgent]] = []
        for agent in self.agents.values():
            searchable_tokens = _tokens(agent.searchable_text())
            score = len(question_tokens.intersection(searchable_tokens))
            score += len(target_tokens.intersection(_tokens(" ".join(agent.touched_files)))) * 2
            score += min(agent.commit_count, 5)
            if any(
                _text(item.get("author_login")).lower() == agent.login.lower()
                and (_text(item.get("sha")) in timeline_by_sha)
                for item in timeline
            ):
                score += 2
            if score:
                scored.append((score, agent))
        if not scored and self.agents:
            top_agents = sorted(self.agents.values(), key=lambda a: (a.contributions or 0, a.commit_count), reverse=True)
            for a in top_agents[:MAX_ORCHESTRATOR_PARTICIPANTS]:
                scored.append((1, a))
        scored.sort(key=lambda item: (item[0], item[1].contributions or 0), reverse=True)
        participants = [agent for _, agent in scored[:MAX_ORCHESTRATOR_PARTICIPANTS]]
        transcript = []
        for agent in participants:
            refs = [
                item
                for item in timeline
                if _text(item.get("author_login")).lower() == agent.login.lower()
                or _text(item.get("sha")) in {_text(commit.get("sha")) for commit in agent.commits}
            ]
            lines = agent.context_lines(question)
            if refs:
                lines.append(
                    "Timeline evidence: "
                    + "; ".join(
                        f"{item['position']}/{len(timeline)} {item.get('sha', '')[:10]} — {item.get('message', '')}"
                        for item in refs[-5:]
                    )
                )
            rel_commits = [
                c for c in agent.commits
                if question_tokens.intersection(_tokens(_text(c.get("message"))))
            ] or agent.commits
            transcript.append(
                {
                    "agent_id": agent.agent_id,
                    "login": agent.login,
                    "avatar_url": agent.avatar_url,
                    "evidence_source": agent.evidence_source,
                    "question": (
                        f"What recorded evidence from {agent.login} bears on this situation: {question.strip()}?"
                    ),
                    "message": "\n".join(lines),
                    "timeline_refs": [item["id"] for item in refs[-8:]],
                    "commits": [
                        {
                            "sha": _text(c.get("sha")),
                            "message": _text(c.get("message")),
                            "date": _text(c.get("date")),
                        }
                        for c in rel_commits[:5]
                        if c.get("sha")
                    ],
                    "touched_files": list(agent.touched_files[:8]),
                }
            )
        dialogue: list[dict[str, Any]] = []
        for agent in participants:
            dialogue.append(
                {
                    "from": "Orchestrator",
                    "to": agent.login,
                    "kind": "dispatch",
                    "message": f"Orchestrator routed inquiry to @{agent.login} based on {len(agent.commits)} recorded commits and {len(agent.touched_files)} touched files in the active repository.",
                }
            )
            dialogue.append(
                {
                    "from": agent.login,
                    "to": "Orchestrator",
                    "kind": "report",
                    "message": f"@{agent.login} verified codebase changes across {len(agent.touched_files)} files: {', '.join(agent.touched_files[:5]) if agent.touched_files else 'repository root'}.",
                }
            )
        for index, left in enumerate(participants):
            for right in participants[index + 1:]:
                shared_files = sorted(set(left.touched_files).intersection(right.touched_files))[:8]
                shared_terms = sorted(
                    _tokens(left.searchable_text()).intersection(_tokens(right.searchable_text()))
                    .intersection(question_tokens)
                )[:8]
                if not shared_files and not shared_terms:
                    continue
                details = []
                if shared_files:
                    details.append("shared files: " + ", ".join(shared_files))
                if shared_terms:
                    details.append("shared question terms: " + ", ".join(shared_terms))
                dialogue.append(
                    {
                        "from": left.login,
                        "to": right.login,
                        "kind": "cross_check",
                        "message": "Cross-check limited to recorded overlap — " + "; ".join(details) + ".",
                    }
                )
        if transcript:
            synthesis = (
                f"The orchestrator consulted {len(transcript)} verified GitHub contributor records. "
                "Each agent answered the situation from its own commits, discussions, dates, and touched files; no unrecorded cause was inferred."
            )
            status = "verified"
        else:
            synthesis = "No verified GitHub contributor record was relevant to this question in the current fresh snapshot."
            status = "abstain"

        flow_nodes: list[dict[str, Any]] = [
            {
                "id": "orchestrator:mnemo",
                "kind": "orchestrator",
                "label": "Mnemo Orchestrator",
                "subtitle": "routes every room message",
                "status": "active",
            }
        ]
        flow_edges: list[dict[str, Any]] = []
        for item in timeline_focus:
            flow_nodes.append(
                {
                    "id": item["id"],
                    "kind": "timeline_commit",
                    "label": f"{item['position']}/{len(timeline)} · {item.get('sha', '')[:9]}",
                    "subtitle": item.get("message", "Recorded commit")[:72],
                    "timeline_index": item["position"] - 1,
                    "timestamp": item.get("timestamp"),
                    "commit_kind": item.get("commit_kind"),
                }
            )
            flow_edges.append(
                {
                    "id": f"context:{item['id']}",
                    "source": item["id"],
                    "target": "orchestrator:mnemo",
                    "kind": "timeline_context",
                    "label": "timeline context",
                }
            )
        for agent in participants:
            node_id = f"agent:{agent.login}"
            flow_nodes.append(
                {
                    "id": node_id,
                    "kind": "contributor_agent",
                    "label": agent.login,
                    "subtitle": f"{agent.commit_count} recorded commits",
                    "avatar_url": agent.avatar_url,
                    "status": "consulted",
                }
            )
            flow_edges.extend(
                [
                    {
                        "id": f"ask:{node_id}",
                        "source": "orchestrator:mnemo",
                        "target": node_id,
                        "kind": "orchestrator_request",
                        "label": "asks",
                    },
                    {
                        "id": f"report:{node_id}",
                        "source": node_id,
                        "target": "orchestrator:mnemo",
                        "kind": "agent_report",
                        "label": "reports",
                    },
                ]
            )
            for entry in transcript:
                if entry["login"] != agent.login:
                    continue
                for timeline_id in entry.get("timeline_refs", []):
                    if any(item["id"] == timeline_id for item in timeline_focus):
                        flow_edges.append(
                            {
                                "id": f"cite:{node_id}:{timeline_id}",
                                "source": node_id,
                                "target": timeline_id,
                                "kind": "agent_citation",
                                "label": "cites",
                            }
                        )
        for entry in dialogue:
            flow_edges.append(
                {
                    "id": f"dialogue:{entry['from']}:{entry['to']}",
                    "source": f"agent:{entry['from']}",
                    "target": f"agent:{entry['to']}",
                    "kind": "agent_dialogue",
                    "label": "cross-checks",
                }
            )
        if ai_requested:
            flow_nodes.append(
                {
                    "id": "ai-client:optional",
                    "kind": "ai_client",
                    "label": "AI Client",
                    "subtitle": "optional evidence paraphrase",
                    "status": "waiting",
                }
            )
            flow_edges.extend(
                [
                    {
                        "id": "handoff:ai-client",
                        "source": "orchestrator:mnemo",
                        "target": "ai-client:optional",
                        "kind": "ai_handoff",
                        "label": "passes evidence",
                    },
                    {
                        "id": "response:ai-client",
                        "source": "ai-client:optional",
                        "target": "orchestrator:mnemo",
                        "kind": "ai_response",
                        "label": "returns paraphrase",
                    },
                ]
            )
        return {
            "status": status,
            "orchestrator": "Mnemo Orchestrator",
            "agent_count": len(self.agents),
            "participants": [agent.summary() for agent in participants],
            "transcript": transcript,
            "dialogue": dialogue,
            "synthesis": synthesis,
            "timeline": {
                "count": len(timeline),
                "first": timeline[0] if timeline else None,
                "latest": timeline[-1] if timeline else None,
                "focus": timeline_focus,
            },
            "flow": {"nodes": flow_nodes, "edges": flow_edges},
        }


def attach_ai_result(orchestration: dict[str, Any], ai_result: dict[str, Any] | None) -> dict[str, Any]:
    """Mark the optional AI client node with the actual provider result."""

    if not ai_result:
        return orchestration
    flow = orchestration.setdefault("flow", {"nodes": [], "edges": []})
    for node in flow.get("nodes", []):
        if node.get("id") == "ai-client:optional":
            node["status"] = ai_result.get("status", "unavailable")
            node["subtitle"] = f"{ai_result.get('provider', 'deterministic')} · {ai_result.get('model', 'fallback')}"
    orchestration["ai_client"] = {
        "status": ai_result.get("status"),
        "provider": ai_result.get("provider"),
        "model": ai_result.get("model"),
    }
    return orchestration
