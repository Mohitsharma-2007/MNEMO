from __future__ import annotations

import urllib.request
import threading
from pathlib import Path
import unittest

from mnemo.web import create_server


class WebHomePageCleanlinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = create_server("127.0.0.1", 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def _fetch_text(self, path: str) -> str:
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            return resp.read().decode("utf-8", "replace")

    def test_homepage_has_no_decorative_background_noise(self):
        page = self._fetch_text("/")
        css = self._fetch_text("/assets/styles.css")

        # Old dot-grid decor should not be shipped.
        self.assertNotIn("feTurbulence", page)
        # Atmospheric noise layer should be removed, not just dimmed.
        self.assertIn(".noise { display: none; }", css)
        self.assertNotIn("opacity: .46", css)
        # Shader blob behind the logo should be hidden.
        self.assertIn(".shader-background { display: none; }", css)
        # Workspace should keep a calm, clean off-white background.
        self.assertTrue(
            "background: #f9f8f6" in css or "background:#f9f8f6" in css,
            "expected a calm off-white workspace background",
        )
        # Intake card and lede must still be present.
        self.assertIn("intake-card", page)
        self.assertIn("intake-lede", page)
        self.assertIn('id="ai-room-assist" type="checkbox"', page)
        self.assertNotIn('id="ai-room-assist" type="checkbox" checked', page)
        self.assertIn("ai-privacy-note", page)
