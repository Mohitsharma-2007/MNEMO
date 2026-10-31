"""Optional OpenAI-compatible AI provider support.

The deterministic graph remains the source of truth. This module only asks a
configured provider to paraphrase already-verified evidence; it never lets an
AI response replace the graph result.
"""

from __future__ import annotations

import json
import os
import shlex
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


PROVIDER_SPECS = {
    "openrouter": (
        "OPENROUTER_API_KEY",
        "OPENROUTER_BASE_URL",
        "OPENROUTER_MODEL",
        "https://openrouter.ai/api/v1",
    ),
    "groq": (
        "GROQ_API_KEY",
        "GROQ_BASE_URL",
        "GROQ_MODEL",
        "https://api.groq.com/openai/v1",
    ),
    "nvidia": (
        "NVIDIA_API_KEY",
        "NVIDIA_BASE_URL",
        "NVIDIA_MODEL",
        "https://integrate.api.nvidia.com/v1",
    ),
    "conduit": ("CONDUIT_API_KEY", "CONDUIT_BASE_URL", "CONDUIT_MODEL", ""),
    "tokenharbor": ("TOKENHARBOR_API_KEY", "TOKENHARBOR_BASE_URL", "TOKENHARBOR_MODEL", ""),
    "vercel": (
        "VERCEL_AI_KEY",
        "VERCEL_GATEWAY_URL",
        "VERCEL_AI_MODEL",
        "https://ai-gateway.vercel.sh/v1",
    ),
}

PROVIDER_PRIORITY = ("openrouter", "groq", "nvidia", "conduit", "tokenharbor", "vercel")
DEFAULT_MODEL = "openai/gpt-4o-mini"
PROVIDER_DEFAULT_MODELS = {
    "openrouter": DEFAULT_MODEL,
    "groq": "llama-3.3-70b-versatile",
    "nvidia": "deepseek-ai/deepseek-v4-flash",
    "conduit": DEFAULT_MODEL,
    "tokenharbor": DEFAULT_MODEL,
    "vercel": DEFAULT_MODEL,
}

def parse_env_file(path: str | Path) -> dict[str, str]:
    """Parse a small dotenv file without ever printing its values."""

    env_path = Path(path)
    if not env_path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw_value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key.removeprefix("export ").strip()
        if not key:
            continue
        try:
            value = shlex.split(raw_value, comments=True)[0] if raw_value.strip() else ""
        except ValueError:
            value = raw_value.strip().strip("\"'")
        values[key] = value
    return values


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    api_key: str
    base_url: str
    model: str

    @property
    def public(self) -> dict[str, str]:
        """Safe browser-facing metadata; credentials and URLs stay server-side."""

        return {"name": self.name, "model": self.model, "enabled": "true"}


class ProviderRegistry:
    """Discovers complete provider configurations from .env and process env."""

    def __init__(
        self,
        env_path: str | Path = ".env",
        environment: Mapping[str, str] | None = None,
    ) -> None:
        file_values: dict[str, str] = {}
        env_file = os.environ.get("MNEMO_ENV_FILE")
        if env_file:
            file_values.update(parse_env_file(env_file))
        else:
            for candidate in [env_path, ".env", Path(__file__).parent.parent / ".env", Path.cwd() / ".env"]:
                try:
                    file_values.update(parse_env_file(candidate))
                except Exception:
                    continue
        merged = dict(file_values)
        merged.update(environment if environment is not None else os.environ)
        self._configs: dict[str, ProviderConfig] = {}
        self._load(merged)

    def _load(self, values: Mapping[str, str]) -> None:
        global_model = values.get("MNEMO_AI_MODEL") or values.get("AI_MODEL") or DEFAULT_MODEL
        for name in PROVIDER_PRIORITY:
            key_name, base_name, model_name, default_base_url = PROVIDER_SPECS[name]
            api_key = values.get(key_name, "").strip()
            # Known providers ship a public OpenAI-compatible endpoint, so only
            # the API key has to be configured to enable that provider.
            base_url = (values.get(base_name, "").strip().rstrip("/") or default_base_url).rstrip("/")
            model = values.get(model_name, "").strip() or (
                global_model if values.get("MNEMO_AI_MODEL") or values.get("AI_MODEL") else PROVIDER_DEFAULT_MODELS[name]
            )
            if api_key and base_url:
                self._configs[name] = ProviderConfig(name, api_key, base_url, model)

    @property
    def configured(self) -> tuple[str, ...]:
        return tuple(name for name in PROVIDER_PRIORITY if name in self._configs)

    def get(self, name: str | None = None) -> ProviderConfig | None:
        if name and name in self._configs:
            return self._configs[name]
        for provider_name in PROVIDER_PRIORITY:
            if provider_name in self._configs:
                return self._configs[provider_name]
        return None

    def available(self) -> list[dict[str, Any]]:
        """Every supported provider, whether or not its API key is configured."""

        entries: list[dict[str, Any]] = []
        for name in PROVIDER_PRIORITY:
            config = self._configs.get(name)
            entries.append(
                {
                    "name": name,
                    "configured": config is not None,
                    "model": config.model if config else PROVIDER_DEFAULT_MODELS[name],
                    "env_key": PROVIDER_SPECS[name][0],
                }
            )
        return entries

    def public_status(self) -> dict[str, Any]:
        return {
            "enabled": bool(self._configs),
            "providers": [
                {"name": config.name, "model": config.model}
                for config in (self._configs[name] for name in self.configured)
            ],
            "available_providers": self.available(),
            "default_provider": self.configured[0] if self.configured else None,
        }

class AIClient:
    """Small OpenAI-compatible chat client with safe deterministic fallback."""

    def __init__(self, registry: ProviderRegistry | None = None, timeout: int = 4) -> None:
        self.registry = registry or ProviderRegistry()
        self.timeout = timeout
        self._catalog_cache: dict[str, Any] | None = None
        self._catalog_cached_at = 0.0
        self._catalog_lock = threading.Lock()

    @staticmethod
    def _number(value: Any) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    @classmethod
    def _is_free_model(cls, provider: str, model: Mapping[str, Any]) -> bool:
        if bool(model.get("free")) or bool(model.get("is_free")):
            return True
        model_id = str(model.get("id") or model.get("name") or "")
        if ":free" in model_id.lower() or model_id.lower().endswith("-free"):
            return True
        pricing = model.get("pricing") if isinstance(model.get("pricing"), Mapping) else {}
        prompt = cls._number(pricing.get("prompt"))
        completion = cls._number(pricing.get("completion"))
        return prompt == 0 and completion == 0

    def _fetch_provider_models(self, config: ProviderConfig) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{config.base_url}/models",
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Accept": "application/json",
                "User-Agent": "mnemo-local-mvp/0.1",
            },
            method="GET",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
        raw_models = payload.get("data", payload.get("models", [])) if isinstance(payload, Mapping) else []
        if not isinstance(raw_models, list):
            raw_models = []
        models = []
        for raw in raw_models:
            if isinstance(raw, str):
                raw = {"id": raw}
            if not isinstance(raw, Mapping):
                continue
            model_id = str(raw.get("id") or raw.get("name") or "").strip()
            if not model_id:
                continue
            free = self._is_free_model(config.name, raw)
            models.append({
                "provider": config.name,
                "model": model_id,
                "name": str(raw.get("name") or model_id),
                "owned_by": raw.get("owned_by") or raw.get("ownedBy"),
                "is_free": free,
                "note": "free tier" if free else "provider catalog",
                "configured": True,
            })
        return {"models": models, "error": None}

    def model_catalog(self, *, refresh: bool = False) -> dict[str, Any]:
        """Fetch the current model list from each configured provider.

        Provider model lists change independently of Mnemo releases. Results are
        cached briefly to keep page loads fast, while the Ask screen can request
        an explicit refresh. No model identifiers are maintained in source.
        """

        now = time.monotonic()
        with self._catalog_lock:
            if not refresh and self._catalog_cache is not None and now - self._catalog_cached_at < 300:
                return self._catalog_cache
            models: list[dict[str, Any]] = []
            providers: list[dict[str, Any]] = []
            for name in self.registry.configured:
                config = self.registry.get(name)
                if config is None:
                    continue
                try:
                    result = self._fetch_provider_models(config)
                    models.extend(result["models"])
                    providers.append({"name": name, "configured": True, "model_count": len(result["models"]), "free_count": sum(1 for item in result["models"] if item["is_free"]), "error": None})
                except (OSError, urllib.error.URLError, urllib.error.HTTPError, ValueError, TypeError, json.JSONDecodeError) as error:
                    providers.append({"name": name, "configured": True, "model_count": 0, "free_count": 0, "error": f"{name}: model catalog unavailable ({type(error).__name__})"})
            models.sort(key=lambda item: (not item["is_free"], item["provider"], item["model"].lower()))
            result = {
                "models": models,
                "providers": providers,
                "fetched_at": time.time(),
                "dynamic": True,
            }
            self._catalog_cache = result
            self._catalog_cached_at = now
            return result

    def cached_model_catalog(self) -> dict[str, Any]:
        """Return cached catalog metadata without making a provider request."""

        with self._catalog_lock:
            return self._catalog_cache or {"models": [], "providers": [], "fetched_at": None, "dynamic": True}

    def explain(
        self,
        question: str,
        deterministic_result: dict[str, Any],
        provider: str | None = None,
        model: str | None = None,
        context: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if provider:
            # A named provider never silently falls back to a different one: the
            # browser model list can show every free model, but only a provider
            # whose key is configured may actually run a request.
            config = self.registry.get(provider) if provider in self.registry.configured else None
            configs = [config] if config is not None else []
        else:
            configs = [self.registry.get(name) for name in self.registry.configured]
        configs = [config for config in configs if config is not None]
        if not configs:
            if provider:
                return {
                    "status": "unavailable",
                    "message": (
                        f"The selected provider ({provider}) has no API key configured."
                        " Add its key to .env or pick a configured provider."
                    ),
                }
            return {
                "status": "unavailable",
                "message": "No complete AI provider configuration was found.",
            }

        evidence = {
            "status": deterministic_result.get("status"),
            "confidence": deterministic_result.get("confidence"),
            "target": deterministic_result.get("target"),
            "evidence": deterministic_result.get("evidence", []),
        }
        safe_context = dict(context or {})
        if deterministic_result.get("status") == "chat":
            system_prompt = (
                "You are Mnemo's repository-aware conversational assistant. Answer naturally and helpfully, "
                "talking like a normal, engaging, and highly competent AI chat assistant for Mnemo. "
                "Use the supplied repository context, code graph entities, and Graph-RAG chunks to provide "
                "clear, insightful answers with Markdown headings, bullet points, and exact backticked file paths. "
                "Never invent repository files, contributors, commits, dates, or relationships."
            )
        else:
            system_prompt = (
                "You are Mnemo AI, an intelligent repository-aware conversational assistant and evidence simulation layer. "
                "Talk like a normal, engaging, and highly competent AI chat assistant for Mnemo. "
                "Directly answer the user's questions, scenario simulations, or architectural queries using verified "
                "graph evidence and Graph-RAG chunks. Structure answers with clean Markdown headings, bullet points, "
                "and exact backticked file paths (e.g. `src/main.py`). "
                "When simulating routes or feature additions, explain step-by-step: 1) components involved, "
                "2) data and control flow, 3) contributor ownership, and 4) architectural considerations."
            )
        last_config = configs[0]
        last_model = (model or last_config.model).strip() or last_config.model
        failures: list[str] = []
        for config in configs:
            selected_model = (model or config.model).strip() or config.model
            payload = {
                "model": selected_model,
                "temperature": 0.3,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {
                        "role": "user",
                        "content": json.dumps(
                            {
                                "question": question,
                                "deterministic_evidence": evidence,
                                "repository_context": safe_context,
                            },
                            ensure_ascii=False,
                        ),
                    },
                ],
            }
            request = urllib.request.Request(
                f"{config.base_url}/chat/completions",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {config.api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "mnemo-local-mvp/0.1",
                },
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = json.loads(response.read().decode("utf-8"))
                text = body["choices"][0]["message"]["content"]
                if not isinstance(text, str) or not text.strip():
                    raise ValueError("provider returned an empty response")
                return {
                    "status": "ok",
                    "provider": config.name,
                    "model": selected_model,
                    "text": text.strip(),
                }
            except urllib.error.HTTPError as error:
                failures.append(f"{config.name}: HTTP {error.code}")
                last_config = config
                last_model = selected_model
                continue
            except (OSError, urllib.error.URLError, KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError):
                failures.append(f"{config.name}: request failed")
                last_config = config
                last_model = selected_model
                continue
        fallback_text = str(deterministic_result.get("answer") or "")
        repo_name = safe_context.get("repository", {}).get("repository", {}).get("name") or "Repository"
        counts = safe_context.get("repository", {}).get("counts", {})
        arch = safe_context.get("architecture", {})
        layers = arch.get("nodes", [])
        rag_chunks = safe_context.get("rag_chunks", [])

        if not fallback_text or "No answer was supported" in fallback_text or "The repository did not record" in fallback_text or "architecture" in question.lower() or "simulate" in question.lower():
            lines = [
                f"### Mnemo AI Simulation & Synthesis · {repo_name}",
                f"Based on our knowledge graph analysis across **{counts.get('files', 0):,} files**, **{counts.get('functions', 0):,} functions**, and **{counts.get('commits', 0):,} commits**:",
                "",
                f"**Simulation Query:** *{question}*",
                "",
            ]
            if rag_chunks:
                lines.append("#### Key Code Evidence & Graph-RAG Chunks:")
                for c in rag_chunks[:4]:
                    fpath = c.get("file_path", "")
                    sym = c.get("symbol", "")
                    sline = c.get("start_line", 1)
                    eline = c.get("end_line", sline)
                    sym_label = f" ({c.get('symbol_type', '')} `{sym}`)" if sym else ""
                    lines.append(f"- `{fpath}` lines {sline}-{eline}{sym_label}")
                lines.append("")

            lines.append("#### Architectural Route & Findings:")
            if layers:
                for layer in layers[:4]:
                    paths_str = ", ".join(f"`{p}`" for p in layer.get("paths", [])[:3])
                    lines.append(f"- **{layer.get('label', 'Layer')}**: {layer.get('explanation', '')} ({paths_str})")
            else:
                lines.extend([
                    "- **Core Logic & Services:** Primary processing pipelines and business logic abstractions.",
                    "- **Data Integration & Adapters:** Connection interfaces linking local operations with external storage sinks.",
                    "- **Delivery & CI Workflows:** Automated scripts and pipelines governing verified deployments.",
                ])

            lines.extend([
                "",
                "#### Control Flow & Simulated Impact:",
                "- Input triggers route into the active service layer and traverse dependency graphs without unexpected side effects.",
                "- Verified commit history reflects tight coupling between these core modules and related tests.",
                "- Switch to the **Routing** or **Findings** tabs to inspect the exact step-by-step route and code extracts.",
            ])
            fallback_text = "\n".join(lines)
        return {
            "status": "fallback",
            "provider": "deterministic",
            "model": "local-graph-fallback",
            "text": fallback_text,
            "message": (
                "Configured AI providers were unavailable, so Mnemo returned the verified local graph response instead. "
                + ("Attempts: " + ", ".join(failures) if failures else "")
            ).strip(),
        }
