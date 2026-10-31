"""Deterministic repository analysis built on the local checkout.

This module intentionally favors small, conservative parsers over optional
runtime dependencies.  It produces useful language, dependency, and module
relationship data even when a repository only contains a subset of the
supported manifest/source formats.
"""

from __future__ import annotations

import ast
import json
import re
import subprocess
try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10 compatibility for Windows installs.
    import tomli as tomllib  # type: ignore[no-redef]
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

from .ingest import SOURCE_LANGUAGES


MAX_ANALYSIS_FILE_BYTES = 2 * 1024 * 1024
MAX_ANALYSIS_FILES = 20_000
MAX_IMPORTS = 20_000
MAX_DEPENDENCIES_PER_MANIFEST = 2_000

MANIFEST_NAMES = {
    "requirements.txt": "python-requirements",
    "requirements-dev.txt": "python-requirements",
    "pyproject.toml": "python-pyproject",
    "poetry.lock": "python-lock",
    "pipfile": "python-pipfile",
    "package.json": "node-package",
    "package-lock.json": "node-lock",
    "npm-shrinkwrap.json": "node-lock",
    "yarn.lock": "node-lock",
    "pnpm-lock.yaml": "node-lock",
    "go.mod": "go-module",
    "cargo.toml": "rust-cargo",
    "cargo.lock": "rust-lock",
    "gemfile": "ruby-bundler",
    "gemfile.lock": "ruby-lock",
    "composer.json": "php-composer",
    "pom.xml": "java-maven",
}


def _read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_ANALYSIS_FILE_BYTES:
            return None
        raw = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in raw:
        return None
    return raw.decode("utf-8", errors="replace")


def _tracked_paths(repository: Path, graph: dict[str, Any] | None) -> list[str]:
    if graph is not None:
        paths = {
            str(node.get("path"))
            for node in graph.get("nodes", [])
            if "File" in node.get("labels", []) and node.get("path")
        }
        return sorted(paths)[:MAX_ANALYSIS_FILES]
    result = subprocess.run(
        ["git", "-C", str(repository), "ls-files", "-z"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        return []
    return sorted(path for path in result.stdout.split("\x00") if path)[:MAX_ANALYSIS_FILES]


def _language(path: str) -> str:
    return SOURCE_LANGUAGES.get(Path(path).suffix.lower(), "unknown")


def _language_statistics(repository: Path, paths: Iterable[str]) -> dict[str, Any]:
    stats: dict[str, dict[str, int]] = defaultdict(lambda: {"files": 0, "bytes": 0, "lines": 0})
    for relative_path in paths:
        language = _language(relative_path)
        path = repository / relative_path
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        text = _read_text(path)
        stats[language]["files"] += 1
        stats[language]["bytes"] += size
        if text is not None:
            stats[language]["lines"] += len(text.splitlines())
    return {language: stats[language] for language in sorted(stats)}


def _dependency(name: str, spec: Any = None, group: str = "default") -> dict[str, Any]:
    result = {"name": name, "group": group}
    if spec is not None:
        result["spec"] = str(spec)
    return result


def _requirements_dependencies(text: str) -> list[dict[str, Any]]:
    dependencies = []
    for line in text.splitlines():
        value = line.strip()
        if not value or value.startswith("#") or value.startswith(("-", "--")):
            continue
        value = value.split(" #", 1)[0].split(";", 1)[0].strip()
        match = re.match(r"([A-Za-z0-9_.-]+)\s*(.*)", value)
        if match:
            dependencies.append(_dependency(match.group(1), match.group(2) or None))
    return dependencies


def _toml_dependency_table(table: Any, group: str) -> list[dict[str, Any]]:
    if not isinstance(table, dict):
        return []
    result = []
    for name, value in sorted(table.items()):
        if name in {"python", "version"}:
            continue
        if isinstance(value, dict):
            spec = value.get("version")
        else:
            spec = value
        result.append(_dependency(str(name), spec, group))
    return result


def _toml_dependencies(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    project = payload.get("project")
    if isinstance(project, dict):
        values = project.get("dependencies")
        if isinstance(values, list):
            for value in values:
                match = re.match(r"([A-Za-z0-9_.-]+)\s*(.*)", str(value).strip())
                if match:
                    result.append(_dependency(match.group(1), match.group(2) or None))
        optional = project.get("optional-dependencies")
        if isinstance(optional, dict):
            for group, values in sorted(optional.items()):
                if isinstance(values, list):
                    for value in values:
                        match = re.match(r"([A-Za-z0-9_.-]+)\s*(.*)", str(value).strip())
                        if match:
                            result.append(_dependency(match.group(1), match.group(2) or None, str(group)))
    tool = payload.get("tool")
    if isinstance(tool, dict):
        poetry = tool.get("poetry")
        if isinstance(poetry, dict):
            result.extend(_toml_dependency_table(poetry.get("dependencies"), "default"))
            groups = poetry.get("group")
            if isinstance(groups, dict):
                for group, group_payload in sorted(groups.items()):
                    if isinstance(group_payload, dict):
                        result.extend(_toml_dependency_table(group_payload.get("dependencies"), str(group)))
    for group in ("dependencies", "dev-dependencies", "build-dependencies"):
        result.extend(_toml_dependency_table(payload.get(group), group))
    return result


def _json_dependencies(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for group in ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"):
        values = payload.get(group)
        if isinstance(values, dict):
            result.extend(_dependency(str(name), spec, group) for name, spec in sorted(values.items()))
    return result


def _go_dependencies(text: str) -> list[dict[str, Any]]:
    result = []
    in_block = False
    for line in text.splitlines():
        value = line.strip()
        if value.startswith("require ("):
            in_block = True
            continue
        if in_block and value == ")":
            in_block = False
            continue
        if value.startswith("require "):
            value = value.removeprefix("require ").strip()
        elif not in_block:
            continue
        value = value.split("//", 1)[0].strip()
        match = re.match(r"([^\s]+)\s+([^\s]+)", value)
        if match:
            result.append(_dependency(match.group(1), match.group(2)))
    return result


def _gem_dependencies(text: str) -> list[dict[str, Any]]:
    result = []
    for match in re.finditer(r"^\s*gem\s+[\"']([^\"']+)[\"'](?:\s*,\s*[\"']([^\"']+)[\"'])?", text, re.MULTILINE):
        result.append(_dependency(match.group(1), match.group(2)))
    return result


def _maven_dependencies(text: str) -> list[dict[str, Any]]:
    result = []
    for block in re.findall(r"<dependency\b[^>]*>(.*?)</dependency>", text, re.DOTALL):
        group = re.search(r"<groupId>(.*?)</groupId>", block)
        artifact = re.search(r"<artifactId>(.*?)</artifactId>", block)
        version = re.search(r"<version>(.*?)</version>", block)
        if group and artifact:
            result.append(_dependency(f"{group.group(1).strip()}:{artifact.group(1).strip()}", version.group(1).strip() if version else None))
    return result


def _manifest_dependencies(path: Path, text: str, manifest_type: str) -> list[dict[str, Any]]:
    lower_name = path.name.lower()
    try:
        if lower_name in {"requirements.txt", "requirements-dev.txt"}:
            return _requirements_dependencies(text)
        if lower_name in {"pyproject.toml", "cargo.toml"}:
            payload = tomllib.loads(text)
            return _toml_dependencies(payload)
        if lower_name in {"package.json", "composer.json"}:
            payload = json.loads(text)
            return _json_dependencies(payload) if lower_name == "package.json" else _json_dependencies({"dependencies": payload.get("require", {})})
        if lower_name == "go.mod":
            return _go_dependencies(text)
        if lower_name == "gemfile":
            return _gem_dependencies(text)
        if lower_name == "pom.xml":
            return _maven_dependencies(text)
    except (OSError, ValueError, TypeError, tomllib.TOMLDecodeError, json.JSONDecodeError):
        return []
    return []


def _dependency_manifests(repository: Path, paths: Iterable[str]) -> list[dict[str, Any]]:
    manifests = []
    for relative_path in paths:
        manifest_type = MANIFEST_NAMES.get(Path(relative_path).name.lower())
        if not manifest_type:
            continue
        text = _read_text(repository / relative_path)
        dependencies = _manifest_dependencies(repository / relative_path, text or "", manifest_type) if text is not None else []
        manifests.append(
            {
                "path": relative_path,
                "type": manifest_type,
                "dependencies": dependencies[:MAX_DEPENDENCIES_PER_MANIFEST],
                "dependency_count": len(dependencies),
            }
        )
    return manifests


def _python_imports(text: str) -> list[tuple[str, str, int]]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend((alias.name, "import", node.lineno) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            prefix = "." * node.level
            imports.append((f"{prefix}{node.module or ''}", "from", node.lineno))
    return imports


def _go_imports(text: str) -> list[tuple[str, str, int]]:
    imports = []
    in_block = False
    for line_number, line in enumerate(text.splitlines(), start=1):
        value = line.strip()
        if value.startswith("import ("):
            in_block = True
            continue
        if in_block and value == ")":
            in_block = False
            continue
        if value.startswith("import "):
            value = value.removeprefix("import ").strip()
        elif not in_block:
            continue
        match = re.match(r"[\"']([^\"']+)[\"']", value)
        if match:
            imports.append((match.group(1), "import", line_number))
    return imports


_IMPORT_PATTERNS = {
    "javascript": re.compile(r"(?:import\s+(?:[^\"']+?\s+from\s+)?|export\s+[^\"']+?\s+from\s+|require\s*\()\s*[\"']([^\"']+)[\"']"),
    "typescript": re.compile(r"(?:import\s+(?:[^\"']+?\s+from\s+)?|export\s+[^\"']+?\s+from\s+|require\s*\()\s*[\"']([^\"']+)[\"']"),
    "go": re.compile(r"(?:import\s*\(?\s*)[\"']([^\"']+)[\"']"),
    "java": re.compile(r"^\s*import\s+([A-Za-z0-9_.]+)", re.MULTILINE),
    "kotlin": re.compile(r"^\s*import\s+([A-Za-z0-9_.]+)", re.MULTILINE),
    "ruby": re.compile(r"^\s*require\s+[\"']([^\"']+)[\"']", re.MULTILINE),
    "php": re.compile(r"^\s*(?:use|require|include)\s+[\"']?([^\"';\s]+)", re.MULTILINE),
}


def _module_name(relative_path: str) -> str:
    path = Path(relative_path)
    without_suffix = path.with_suffix("") if path.suffix else path
    parts = list(without_suffix.parts)
    if parts and parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts) or relative_path


def _module_relationships(repository: Path, paths: Iterable[str]) -> dict[str, Any]:
    source_paths = list(paths)
    modules = []
    module_by_name: dict[str, dict[str, Any]] = {}
    for relative_path in source_paths:
        language = _language(relative_path)
        if language == "unknown":
            continue
        module = {
            "id": f"module:{relative_path}",
            "name": _module_name(relative_path),
            "path": relative_path,
            "language": language,
        }
        modules.append(module)
        module_by_name[module["name"]] = module

    imports: list[dict[str, Any]] = []
    for module in modules:
        text = _read_text(repository / module["path"])
        if text is None:
            continue
        language = module["language"]
        if language == "python":
            extracted = _python_imports(text)
        elif language == "go":
            extracted = _go_imports(text)
        else:
            pattern = _IMPORT_PATTERNS.get(language)
            extracted = (
                [
                    (match.group(1), "import", text[: match.start()].count("\n") + 1)
                    for match in pattern.finditer(text)
                ]
                if pattern
                else []
            )
        for target, kind, line in extracted:
            target = target.strip()
            if not target:
                continue
            resolved = module_by_name.get(target)
            imports.append(
                {
                    "source": module["id"],
                    "source_path": module["path"],
                    "target": target,
                    "target_module": resolved["id"] if resolved else None,
                    "kind": kind,
                    "line": line,
                }
            )
            if len(imports) >= MAX_IMPORTS:
                break
        if len(imports) >= MAX_IMPORTS:
            break
    return {"modules": modules, "imports": imports}


def _architecture_map(repository: Path, paths: Iterable[str]) -> dict[str, Any]:
    """Infer a small, explainable CodeViz-style architecture map.

    The detector intentionally reports signals and paths instead of claiming a
    runtime topology. Every node is backed by a tracked file or dependency
    manifest so the UI can explain why it was placed in a layer.
    """

    tracked = sorted(set(paths))
    lower_paths = {path.lower() for path in tracked}
    texts: dict[str, str] = {}
    for path in tracked:
        if Path(path).suffix.lower() in {".py", ".js", ".jsx", ".ts", ".tsx", ".json", ".toml", ".yaml", ".yml", ".md"}:
            text = _read_text(repository / path)
            if text is not None:
                texts[path] = text[:200_000].lower()

    def matching(patterns: tuple[str, ...]) -> list[str]:
        return [path for path in tracked if any(pattern in path.lower() for pattern in patterns)]

    def contains(patterns: tuple[str, ...]) -> list[str]:
        return [path for path, text in texts.items() if any(pattern in text for pattern in patterns)]

    candidates: list[dict[str, Any]] = []

    def add_node(category: str, label: str, evidence: list[str], signals: list[str], confidence: str = "observed") -> None:
        paths_for_node = sorted(set(evidence))[:18]
        if not paths_for_node:
            return
        candidates.append(
            {
                "id": f"architecture:{category}",
                "category": category,
                "label": label,
                "confidence": confidence,
                "signals": signals[:8],
                "paths": paths_for_node,
                "explanation": f"{label} is supported by {', '.join(paths_for_node[:3])}{' and more files' if len(paths_for_node) > 3 else ''}.",
            }
        )

    frontend_paths = matching(("/components/", "/pages/", "/app/", "/public/", "/static/", ".html", ".css", ".jsx", ".tsx", ".vue", "vite.config", "next.config", "webpack", "dashboard", "/web/", "/ui/", "demo", "notebooks", ".ipynb"))
    frontend_files = contains(("react", "vue", "angular", "svelte", "next/", "vite", "streamlit", "gradio", "jupyter"))
    add_node("frontend", "Frontend & UI", frontend_paths + frontend_files, ["UI routes, components, styles, or browser assets detected"])

    backend_paths = matching(("/api/", "/server/", "/backend/", "/services/", "manage.py", "main.py", "app.py", "server.", "routes.", "pathway", "/src/", "/lib/", "engine", "core", "cargo.toml", "setup.py", "pyproject.toml", ".py", ".rs", ".go"))
    backend_files = contains(("fastapi", "flask", "django", "express", "fastify", "nest", "spring", "gin-gonic", "pathway", "rust", "tokio", "asyncio"))
    add_node("backend", "Backend / Core Engine", backend_paths + backend_files, ["Server, API, core compute, or backend language signals detected"])

    database_paths = matching(("/migrations/", "/prisma/", "/models/", ".sql", "schema.prisma", "alembic", "connectors", "storage", "tables", "kafka", "postgres", "redis", "sinks", "sources", "db"))
    database_files = contains(("postgres", "mysql", "sqlite", "mongodb", "redis", "sqlalchemy", "prisma", "typeorm", "kafka", "connector", "storage", "table", "io"))
    add_node("database", "Database & Storage", database_paths + database_files, ["Schema, migration, persistence, connectors, or database dependencies detected"])

    infrastructure_paths = matching(("dockerfile", "docker-compose", "/k8s/", "/kubernetes/", "/helm/", ".tf", "terraform", ".devcontainer", "nginx", "caddy", "requirements.txt", "cargo.lock", "docker", ".env"))
    add_node("infrastructure", "Infrastructure & Runtime", infrastructure_paths, ["Container, deployment, environment, or infrastructure configuration detected"])

    ci_paths = matching((".github/workflows/", ".github/", ".gitlab-ci", "jenkinsfile", ".circleci/", "azure-pipelines", "release.yml", "test.yml", "build.yml"))
    add_node("ci", "CI / Delivery", ci_paths, ["Automated workflow, test matrix, or delivery configuration detected"])

    docs_paths = matching(("readme", "contributing", "code_of_conduct", "license", "security", "support", ".md", "/docs/", "/tutorial/"))
    add_node("docs", "Documentation & Specs", docs_paths, ["Repository documentation, tutorials, and standards detected"])

    node_ids = {node["category"]: node["id"] for node in candidates}
    edge_rules = (
        ("frontend", "backend", "browser requests API / core engine"),
        ("backend", "database", "engine reads/writes storage & connectors"),
        ("ci", "infrastructure", "delivery configures deployment"),
        ("infrastructure", "backend", "deployment packages service & engine"),
        ("infrastructure", "frontend", "deployment packages UI assets"),
        ("backend", "ci", "workflows validate core changes"),
        ("docs", "backend", "documentation defines APIs & architecture"),
    )
    edges = [
        {"source": node_ids[source], "target": node_ids[target], "label": label, "confidence": "inferred"}
        for source, target, label in edge_rules
        if source in node_ids and target in node_ids
    ]
    return {
        "nodes": candidates,
        "edges": edges,
        "deterministic": True,
        "note": "Layers are inferred from tracked paths and dependency/configuration signals; they do not prove runtime traffic.",
    }


def analyze_repository(repository: str | Path, graph: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return deterministic language, dependency, and module analysis."""

    root = Path(repository).expanduser().resolve()
    paths = _tracked_paths(root, graph)
    language_statistics = _language_statistics(root, paths)
    dependency_manifests = _dependency_manifests(root, paths)
    module_relationships = _module_relationships(root, paths)
    architecture = _architecture_map(root, paths)
    total_files = sum(item["files"] for item in language_statistics.values())
    total_bytes = sum(item["bytes"] for item in language_statistics.values())
    total_lines = sum(item["lines"] for item in language_statistics.values())
    dependency_count = sum(item["dependency_count"] for item in dependency_manifests)
    symbol_summary = {"functions": 0, "classes": 0, "config_keys": 0}
    module_symbols: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if graph is not None:
        file_to_module = {
            node.get("id"): f"module:{node.get('path')}"
            for node in graph.get("nodes", [])
            if "File" in node.get("labels", []) and node.get("path")
        }
        contains_by_target: dict[str, list[str]] = defaultdict(list)
        for edge in graph.get("edges", []):
            if edge.get("type") == "CONTAINS" and edge.get("target"):
                contains_by_target[edge["target"]].append(edge.get("source"))

        for node in graph.get("nodes", []):
            labels = set(node.get("labels", []))
            label = next((item for item in ("Function", "Class", "ConfigKey") if item in labels), None)
            if label:
                symbol_summary[{"Function": "functions", "Class": "classes", "ConfigKey": "config_keys"}[label]] += 1
                for source in contains_by_target.get(node.get("id"), []):
                    module_id = file_to_module.get(source)
                    if module_id:
                        module_symbols[module_id].append(
                            {
                                "id": node.get("id"),
                                "label": label,
                                "name": node.get("name"),
                                "start_line": node.get("start_line"),
                                "end_line": node.get("end_line"),
                            }
                        )
    known_languages = {
        language: values
        for language, values in language_statistics.items()
        if language != "unknown"
    }
    top_language = max(
        known_languages or language_statistics,
        key=lambda language: (
            language_statistics[language]["files"],
            language_statistics[language]["bytes"],
            language,
        ),
        default=None,
    )
    summary = {
        "total_files": total_files,
        "total_bytes": total_bytes,
        "total_lines": total_lines,
        "language_count": len(language_statistics),
        "top_language": top_language,
        "dependency_manifest_count": len(dependency_manifests),
        "dependency_count": dependency_count,
        "module_count": len(module_relationships["modules"]),
        "import_count": len(module_relationships["imports"]),
        **symbol_summary,
    }
    return {
        "language_statistics": language_statistics,
        "dependency_manifests": dependency_manifests,
        "module_relationships": module_relationships,
        "architecture": architecture,
        "module_symbols": dict(module_symbols),
        "summary": summary,
    }
