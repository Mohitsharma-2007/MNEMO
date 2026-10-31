from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from mnemo.ai import AIClient, ProviderRegistry


class _Response:
    def __enter__(self) -> "_Response":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps({"choices": [{"message": {"content": "Hello from the repository assistant."}}]}).encode()


class _CatalogResponse:
    def __enter__(self) -> "_CatalogResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps({"data": [
            {"id": "provider/free-model:free", "pricing": {"prompt": "0", "completion": "0"}},
            {"id": "provider/paid-model", "pricing": {"prompt": "0.1", "completion": "0.2"}},
        ]}).encode()


class AIContextTests(unittest.TestCase):
    def test_chat_response_receives_repository_and_orchestrator_context(self) -> None:
        registry = ProviderRegistry(
            env_path="/tmp/mnemo-no-env",
            environment={
                "OPENROUTER_API_KEY": "test-key",
                "OPENROUTER_BASE_URL": "https://provider.example.test/v1",
                "OPENROUTER_MODEL": "test-model",
            },
        )
        client = AIClient(registry, timeout=1)
        with patch("mnemo.ai.urllib.request.urlopen", return_value=_Response()) as opener:
            result = client.explain(
                "hello",
                {"status": "chat", "confidence": 1.0, "evidence": []},
                context={"repository": {"name": "demo"}, "orchestration": None},
            )

        self.assertEqual(result["status"], "ok")
        request = opener.call_args.args[0]
        payload = json.loads(request.data.decode())
        self.assertIn("repository_context", payload["messages"][1]["content"])
        self.assertIn("repository-aware conversational assistant", payload["messages"][0]["content"])

    def test_model_catalog_is_fetched_and_free_models_are_sorted_first(self) -> None:
        registry = ProviderRegistry(
            env_path="/tmp/mnemo-no-env",
            environment={
                "OPENROUTER_API_KEY": "test-key",
                "OPENROUTER_BASE_URL": "https://provider.example.test/v1",
            },
        )
        client = AIClient(registry, timeout=1)
        with patch("mnemo.ai.urllib.request.urlopen", return_value=_CatalogResponse()):
            catalog = client.model_catalog(refresh=True)

        self.assertTrue(catalog["models"])
        self.assertTrue(catalog["models"][0]["is_free"])
        self.assertFalse(catalog["models"][-1]["is_free"])
        self.assertEqual(catalog["models"][0]["model"], "provider/free-model:free")


if __name__ == "__main__":
    unittest.main()
