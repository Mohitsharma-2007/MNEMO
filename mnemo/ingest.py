"""Deterministic Git and source-code ingestion for Mnemo's local MVP."""

from __future__ import annotations

import ast
import re
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

from .graph import PropertyGraph


SOURCE_LANGUAGES = {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cs": "csharp",
    ".go": "go",
    ".java": "java",
    ".js": "javascript",
    ".jsx": "javascript",
    ".kt": "kotlin",
    ".php": "php",
    ".py": "python",
    ".rb": "ruby",
    ".rs": "rust",
    ".swift": "swift",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".sass": "sass",
    ".less": "less",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".ini": "ini",
    ".cfg": "config",
    ".conf": "config",
    ".sql": "sql",
    ".sh": "shell",
    ".bash": "shell",
    ".md": "markdown",
    ".mdx": "markdown",
    ".txt": "text",
}

INTENT_MARKERS = (
    "because",
    "compat",
    "default",
    "deprecat",
    "due to",
    "ensure",
    "incident",
    "issue",
    "limit",
    "migrat",
    "prevent",
    "regression",
    "revert",
    "retry",
    "security",
    "timeout",
    "workaround",
)

SUPERSESSION_MARKERS = (
    "deprecat",
    "migrat",
    "no longer",
    "replace",
    "revert",
    "supersed",
    "switch",
)


class IngestionError(RuntimeError):
    """Raised when a repository cannot be ingested safely."""


def _git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown git error"
        raise IngestionError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def _language(path: str) -> str:
    return SOURCE_LANGUAGES.get(Path(path).suffix.lower(), "unknown")


def _read_text(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:
        return None
    return raw.decode("utf-8", errors="replace")


def _python_symbols(text: str) -> list[dict[str, Any]]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []

    symbols: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            kind = "Function" if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else "Class"
            symbols.append(
                {
                    "label": kind,
                    "name": node.name,
                    "signature": f"{kind.lower()} {node.name}",
                    "start_line": node.lineno,
                    "end_line": getattr(node, "end_lineno", node.lineno),
                }
            )
    return symbols


GENERIC_SYMBOL_PATTERNS = (
    ("Function", re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(")),
    ("Function", re.compile(r"^\s*func\s+([A-Za-z_]\w*)\s*\(")),
    ("Function", re.compile(r"^\s*(?:def|fn)\s+([A-Za-z_]\w*)\s*\(")),
    ("Class", re.compile(r"^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b")),
    ("Class", re.compile(r"^\s*(?:public\s+)?class\s+([A-Za-z_]\w*)\b")),
)


def _generic_symbols(text: str) -> list[dict[str, Any]]:
    lines = text.splitlines()
    starts: list[tuple[int, str, str]] = []
    for line_number, line in enumerate(lines, start=1):
        for kind, pattern in GENERIC_SYMBOL_PATTERNS:
            match = pattern.search(line)
            if match:
                starts.append((line_number, kind, match.group(1)))
                break

    symbols: list[dict[str, Any]] = []
    for index, (start_line, kind, name) in enumerate(starts):
        next_start = starts[index + 1][0] if index + 1 < len(starts) else len(lines) + 1
        symbols.append(
            {
                "label": kind,
                "name": name,
                "signature": f"{kind.lower()} {name}",
                "start_line": start_line,
                "end_line": max(start_line, next_start - 1),
            }
        )
    return symbols


def _config_symbols(text: str) -> list[dict[str, Any]]:
    symbols: list[dict[str, Any]] = []
    assignment = re.compile(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*?)\s*$")
    environment = re.compile(
        r"(?:getenv|environ\.get|process\.env)\s*\(\s*['\"]([A-Za-z_][A-Za-z0-9_.-]*)['\"]"
    )
    for line_number, line in enumerate(text.splitlines(), start=1):
        match = assignment.search(line)
        if match:
            symbols.append(
                {
                    "label": "ConfigKey",
                    "name": match.group(1),
                    "current_value": match.group(2)[:200],
                    "start_line": line_number,
                    "end_line": line_number,
                }
            )
            continue
        match = environment.search(line)
        if match:
            symbols.append(
                {
                    "label": "ConfigKey",
                    "name": match.group(1),
                    "current_value": "environment-provided",
                    "start_line": line_number,
                    "end_line": line_number,
                }
            )
    return symbols


def _extract_symbols(path: str, text: str) -> list[dict[str, Any]]:
    language = _language(path)
    symbols = _python_symbols(text) if language == "python" else _generic_symbols(text)
    symbols.extend(_config_symbols(text))
    return symbols


def _parse_commit_log(raw: str) -> list[dict[str, Any]]:
    commits: list[dict[str, Any]] = []
    for record in raw.split("\x1e"):
        record = record.strip("\n")
        if not record:
            continue
        fields = record.split("\x1f", 5)
        if len(fields) != 6:
            continue
        sha, parents, author, email, timestamp, message = fields
        commits.append(
            {
                "sha": sha.strip(),
                "parents": [parent for parent in parents.strip().split() if parent],
                "author": author.strip(),
                "email": email.strip().lower(),
                "timestamp": timestamp.strip(),
                "message": message.strip(),
            }
        )
    return commits


def _changed_ranges(diff: str) -> tuple[dict[str, list[dict[str, Any]]], int, int]:
    ranges: dict[str, list[dict[str, Any]]] = defaultdict(list)
    current_path: str | None = None
    current_hunk: dict[str, Any] | None = None
    insertions = 0
    deletions = 0
    for line in diff.splitlines():
        if line.startswith("diff "):
            current_hunk = None
            continue
        if line.startswith("+++") and line.startswith("+++ b/"):
            current_path = line[6:]
            continue
        if line.startswith(("index ", "---")):
            continue
        if line.startswith("@@") and current_path:
            match = re.search(r"\+(\d+)(?:,(\d+))?", line)
            if match:
                start = int(match.group(1))
                count = int(match.group(2) or "1")
                current_hunk = {
                    "start_line": start,
                    "end_line": start + max(count, 1) - 1,
                    "diff_lines": [line],
                    "new_line": start,
                    "changed_start": None,
                    "changed_end": None,
                }
                ranges[current_path].append(current_hunk)
            continue
        if current_hunk is not None and len(current_hunk["diff_lines"]) < 180:
            current_hunk["diff_lines"].append(line)
        if current_hunk is not None and current_path and line and not line.startswith(("diff ", "index ", "---", "+++", "@@")):
            if line.startswith("+"):
                insertions += 1
                current_hunk["changed_start"] = current_hunk["changed_start"] or current_hunk["new_line"]
                current_hunk["changed_end"] = current_hunk["new_line"]
                current_hunk["new_line"] += 1
            elif line.startswith("-"):
                deletions += 1
                current_hunk["changed_start"] = current_hunk["changed_start"] or current_hunk["new_line"]
                current_hunk["changed_end"] = current_hunk["new_line"]
            elif line.startswith(" "):
                current_hunk["new_line"] += 1
    for hunks in ranges.values():
        for hunk in hunks:
            if hunk["changed_start"] is not None:
                hunk["start_line"] = hunk["changed_start"]
                hunk["end_line"] = hunk["changed_end"] or hunk["changed_start"]
            for key in ("new_line", "changed_start", "changed_end"):
                hunk.pop(key, None)
            hunk["diff_hunk"] = "\n".join(hunk.pop("diff_lines", []))[:18_000]
    return dict(ranges), insertions, deletions


def _is_decision_message(message: str) -> bool:
    lower = message.lower()
    return any(marker in lower for marker in INTENT_MARKERS)


def _is_superseding_message(message: str) -> bool:
    lower = message.lower()
    return any(marker in lower for marker in SUPERSESSION_MARKERS)


def _overlaps(symbol: dict[str, Any], start_line: int, end_line: int) -> bool:
    return symbol["start_line"] <= end_line and start_line <= symbol["end_line"]


MODULE_EXTENSIONS = ("", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte")
JS_IMPORT_PATTERN = re.compile(
    r"""(?:import\s+[^'\"]*?from\s*|require\s*\(\s*|import\s*\(\s*|import\s*)['\"]([^'\"]+)['\"]"""
)


def _python_module_index(paths: list[str]) -> dict[str, str]:
    index: dict[str, str] = {}
    for path in paths:
        if not path.endswith(".py"):
            continue
        module = path[:-3].replace("/", ".")
        if module.endswith(".__init__"):
            module = module[: -len(".__init__")]
        index.setdefault(module, path)
        index.setdefault(module.split(".")[-1], path)
    return index


def _js_module_index(paths: list[str]) -> dict[str, str]:
    index: dict[str, str] = {}
    for path in paths:
        if not path.endswith(MODULE_EXTENSIONS[1:]):
            continue
        stripped = re.sub(r"\.(jsx?|tsx?|mjs|cjs|vue|svelte)$", "", path)
        for key in (stripped, f"{stripped}/index", stripped.rsplit("/", 1)[-1]):
            index.setdefault(key, path)
    return index


def _resolve_relative(source: str, specifier: str, candidates: dict[str, str]) -> str | None:
    base = (Path(source).parent / specifier).as_posix()
    parts: list[str] = []
    for part in base.split("/"):
        if part in {"", "."}:
            continue
        if part == "..":
            if parts:
                parts.pop()
            continue
        parts.append(part)
    resolved = "/".join(parts)
    for suffix in MODULE_EXTENSIONS:
        if resolved + suffix in candidates:
            return candidates[resolved + suffix]
    for suffix in ("/index.js", "/index.ts", "/index.tsx", "/__init__.py"):
        if resolved + suffix in candidates:
            return candidates[resolved + suffix]
    return None


def _file_import_edges(root: Path, paths: list[str]) -> list[tuple[str, str, int, str]]:
    """Deterministic file → file import edges for Python and JS/TS sources."""

    python_index = _python_module_index(paths)
    js_index = _js_module_index(paths)
    direct = {path: path for path in paths}
    edges: list[tuple[str, str, int, str]] = []
    seen: set[tuple[str, str]] = set()
    for path in paths:
        if not (path.endswith(".py") or path.endswith(MODULE_EXTENSIONS[1:])):
            continue
        text = _read_text(root / path)
        if text is None:
            continue
        targets: list[tuple[str, int, str]] = []
        if path.endswith(".py"):
            try:
                tree = ast.parse(text)
            except SyntaxError:
                continue
            parent_parts = list(Path(path).parent.parts) if str(Path(path).parent) not in {"", "."} else []
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        target = python_index.get(alias.name)
                        if target:
                            targets.append((target, node.lineno, alias.name))
                elif isinstance(node, ast.ImportFrom):
                    prefix = ""
                    if node.level:
                        depth = max(0, len(parent_parts) - (node.level - 1))
                        prefix = ".".join(parent_parts[:depth])
                    module = ".".join(part for part in (prefix, node.module or "") if part)
                    for alias in node.names:
                        name = f"{module}.{alias.name}" if module else alias.name
                        target = python_index.get(name)
                        if target:
                            targets.append((target, node.lineno, name))
                    if module:
                        target = python_index.get(module)
                        if target:
                            targets.append((target, node.lineno, module))
        else:
            for match in JS_IMPORT_PATTERN.finditer(text):
                specifier = match.group(1)
                line = text.count("\n", 0, match.start()) + 1
                if specifier.startswith("."):
                    target = _resolve_relative(path, specifier, direct)
                else:
                    target = js_index.get(specifier) or js_index.get(specifier.rsplit("/", 1)[-1])
                if target:
                    targets.append((target, line, specifier))
        for target, line, module in targets:
            if target == path or (path, target) in seen:
                continue
            seen.add((path, target))
            edges.append((path, target, line, module))
            if len(edges) >= 1500:
                return edges
    return edges


GENERIC_CALL_NAMES = frozenset(
    {
        "add", "append", "clear", "close", "copy", "decode", "encode", "extend",
        "format", "get", "index", "insert", "items", "join", "keys", "lower",
        "pop", "push", "read", "remove", "replace", "run", "set", "sort", "split",
        "strip", "update", "upper", "values", "write",
    }
)


def _function_call_edges(
    root: Path,
    paths: list[str],
    symbols_by_file: dict[str, list[dict[str, Any]]],
) -> list[tuple[str, str, int]]:
    """Resolve Python call expressions to the function they most likely invoke."""

    by_name: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for path, symbols in symbols_by_file.items():
        for symbol in symbols:
            if symbol.get("label") != "Function" or not symbol.get("id"):
                continue
            by_name[symbol["name"]].append((symbol["id"], path))
    edges: list[tuple[str, str, int]] = []
    seen: set[tuple[str, str]] = set()
    for path, symbols in symbols_by_file.items():
        if not path.endswith(".py"):
            continue
        text = _read_text(root / path)
        if text is None:
            continue
        try:
            tree = ast.parse(text)
        except SyntaxError:
            continue
        functions = [node for node in ast.walk(tree) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for index, symbol in enumerate(symbols):
            if symbol.get("label") != "Function" or not symbol.get("id") or index >= len(functions):
                continue
            for call in (node for node in ast.walk(functions[index]) if isinstance(node, ast.Call)):
                callee = call.func
                name = callee.id if isinstance(callee, ast.Name) else callee.attr if isinstance(callee, ast.Attribute) else None
                if not name or name == symbol["name"] or name in GENERIC_CALL_NAMES:
                    continue
                candidates = by_name.get(name) or []
                local = [item for item in candidates if item[1] == path]
                chosen = local[0] if local else (candidates[0] if len(candidates) == 1 else None)
                if not chosen:
                    continue
                key = (symbol["id"], chosen[0])
                if key in seen:
                    continue
                seen.add(key)
                edges.append((symbol["id"], chosen[0], getattr(call, "lineno", 0)))
                if len(edges) >= 800:
                    return edges
    return edges


def ingest_repository(repository: str | Path, max_commits: int = 500) -> dict[str, Any]:
    """Build a deterministic JSON graph for a local Git repository."""

    repo = Path(repository).expanduser().resolve()
    if not repo.exists():
        raise IngestionError(f"repository does not exist: {repo}")
    root = Path(_git(repo, "rev-parse", "--show-toplevel").strip()).resolve()
    name = root.name
    remote = _git(root, "remote", "get-url", "origin", check=False).strip() or None
    default_branch = _git(root, "symbolic-ref", "--short", "HEAD", check=False).strip() or None

    graph = PropertyGraph()
    repository_id = f"repository:{name}"
    graph.add_node(
        "Repository",
        repository_id,
        name=name,
        url=remote,
        default_branch=default_branch,
        root_path=str(root),
    )

    symbols_by_file: dict[str, list[dict[str, Any]]] = {}
    line_counts: dict[str, int] = {}
    tracked_files = [path for path in _git(root, "ls-files", "-z").split("\x00") if path]
    for relative_path in tracked_files:
        file_path = root / relative_path
        file_id = f"file:{relative_path}"
        graph.add_node("File", file_id, path=relative_path, language=_language(relative_path))
        graph.add_edge("CONTAINS_FILE", repository_id, file_id)
        text = _read_text(file_path)
        if text is None:
            continue
        line_counts[relative_path] = len(text.splitlines())
        file_symbols = _extract_symbols(relative_path, text)
        symbols_by_file[relative_path] = file_symbols
        for symbol in file_symbols:
            label = symbol["label"]
            if label == "Function":
                symbol_id = f"function:{relative_path}:{symbol['name']}:{symbol['start_line']}"
                graph.add_node(
                    label,
                    symbol_id,
                    name=symbol["name"],
                    signature=symbol["signature"],
                    start_line=symbol["start_line"],
                    end_line=symbol["end_line"],
                    path=relative_path,
                )
            elif label == "Class":
                symbol_id = f"class:{relative_path}:{symbol['name']}:{symbol['start_line']}"
                graph.add_node(
                    label,
                    symbol_id,
                    name=symbol["name"],
                    start_line=symbol["start_line"],
                    end_line=symbol["end_line"],
                    path=relative_path,
                )
            else:
                symbol_id = f"config:{relative_path}:{symbol['name']}:{symbol['start_line']}"
                graph.add_node(
                    label,
                    symbol_id,
                    name=symbol["name"],
                    current_value=symbol.get("current_value"),
                    file_path=relative_path,
                    start_line=symbol["start_line"],
                    end_line=symbol["end_line"],
                    path=relative_path,
                )
            graph.add_edge("CONTAINS", file_id, symbol_id)
            symbol["id"] = symbol_id

    log_format = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%B%x1e"
    raw_log = _git(
        root,
        "log",
        "--all",
        f"--max-count={max(1, max_commits)}",
        "--date=iso-strict",
        f"--pretty=format:{log_format}",
    )
    commits = _parse_commit_log(raw_log)
    decision_targets: dict[str, list[tuple[str, str]]] = defaultdict(list)
    decision_nodes: dict[str, dict[str, Any]] = {}

    for history_index, commit in enumerate(commits):
        sha = commit["sha"]
        commit_id = f"commit:{sha}"
        graph.add_node(
            "Commit",
            commit_id,
            sha=sha,
            message=commit["message"],
            timestamp=commit["timestamp"],
            author_email=commit["email"],
            history_index=history_index,
            parents=commit.get("parents", []),
            parent_count=len(commit.get("parents", [])),
            commit_kind="merge" if len(commit.get("parents", [])) > 1 else "commit",
        )
        contributor_id = f"contributor:{commit['email']}"
        graph.add_node(
            "Contributor",
            contributor_id,
            username=commit["email"],
            emails=[commit["email"]],
            display_name=commit["author"],
        )
        graph.add_edge("AUTHORED", contributor_id, commit_id)

        # One precise diff call per commit keeps symbol ranges deterministic
        # while avoiding a second subprocess for the full-context rendering.
        # The recorded hunk is still the real Git hunk; the UI can show it
        # without re-running Git.
        diff = _git(root, "show", "--format=", "--unified=3", "--no-renames", sha)
        changed, insertions, deletions = _changed_ranges(diff)
        for node in graph.nodes:
            if node["id"] == commit_id:
                node["insertions"] = insertions
                node["deletions"] = deletions
                break

        for relative_path, hunks in changed.items():
            file_id = f"file:{relative_path}"
            if file_id not in {node["id"] for node in graph.nodes}:
                graph.add_node("File", file_id, path=relative_path, language=_language(relative_path))
            file_hunk_text = "\n".join(hunk["diff_hunk"] for hunk in hunks)
            graph.add_edge("MODIFIED", commit_id, file_id, diff_hunk=file_hunk_text)
            for hunk in hunks:
                # A root commit often has one hunk spanning the entire file.
                # It is safe to attach that hunk to the File node, but not to
                # every symbol inside it: doing so would manufacture intent
                # edges for unrelated functions and configuration keys.
                broad_file_hunk = (
                    hunk["start_line"] == 1
                    and hunk["end_line"] >= line_counts.get(relative_path, hunk["end_line"])
                )
                if broad_file_hunk:
                    continue
                for symbol in symbols_by_file.get(relative_path, []):
                    if not _overlaps(symbol, hunk["start_line"], hunk["end_line"]):
                        continue
                    graph.add_edge(
                        "MODIFIED",
                        commit_id,
                        symbol["id"],
                        start_line=hunk["start_line"],
                        end_line=hunk["end_line"],
                        diff_hunk=hunk["diff_hunk"],
                    )
                    if _is_decision_message(commit["message"]):
                        decision_targets[relative_path].append((commit_id, symbol["id"]))

        if _is_decision_message(commit["message"]):
            decision_id = f"decision:{sha}"
            summary = commit["message"].splitlines()[0] if commit["message"] else "Recorded repository decision"
            decision_node = graph.add_node(
                "Decision",
                decision_id,
                summary=summary,
                context=commit["message"],
                timestamp=commit["timestamp"],
                status="active",
                source_commit=sha,
            )
            decision_nodes[sha] = decision_node
            graph.add_edge("RESULTED_IN", commit_id, decision_id)

    # A conservative temporal rule: a later intent-bearing change marked as a
    # migration/replacement/revert supersedes earlier decisions on the same file.
    decisions_by_file: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for relative_path, targets in decision_targets.items():
        for commit_id, symbol_id in targets:
            sha = commit_id.removeprefix("commit:")
            if sha in decision_nodes:
                decisions_by_file[relative_path].append((sha, symbol_id))

    commit_timestamps = {commit["sha"]: commit["timestamp"] for commit in commits}
    for relative_path, entries in decisions_by_file.items():
        entries.sort(key=lambda item: commit_timestamps.get(item[0], ""))
        for index, (new_sha, _) in enumerate(entries):
            new_message = next((item["message"] for item in commits if item["sha"] == new_sha), "")
            if not _is_superseding_message(new_message):
                continue
            for old_sha, _ in entries[:index]:
                old_node = decision_nodes.get(old_sha)
                if old_node is not None:
                    old_node["status"] = "expired"
                graph.add_edge(
                    "SUPERSEDES",
                    f"decision:{new_sha}",
                    f"decision:{old_sha}",
                    timestamp=commit_timestamps.get(new_sha),
                    reason=new_message.splitlines()[0] if new_message else "Later repository decision",
                )

    import_edges = _file_import_edges(root, tracked_files)
    for source, target, line, module in import_edges:
        graph.add_edge("IMPORTS", f"file:{source}", f"file:{target}", line=line, module=module)
    call_edges = _function_call_edges(root, tracked_files, symbols_by_file)
    for source, target, line in call_edges:
        graph.add_edge("CALLS", source, target, line=line)

    return graph.to_dict(
        repository={"name": name, "root_path": str(root), "url": remote},
        ingestion={
            "tracked_files": len(tracked_files),
            "commits": len(commits),
            "max_commits": max_commits,
            "imports": len(import_edges),
            "calls": len(call_edges),
        },
    )
