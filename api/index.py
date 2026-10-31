import os
import sys
from urllib.parse import parse_qs, urlsplit, urlunsplit

# Ensure root package is discoverable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from mnemo.web import MnemoRequestHandler


class handler(MnemoRequestHandler):
    """Vercel Serverless Function entry point."""

    def _resolve_vercel_path(self) -> None:
        forwarded = self.headers.get("x-forwarded-uri") or self.headers.get("x-matched-path")
        if forwarded and not forwarded.startswith("/api/index"):
            self.path = forwarded
            return

        parsed = urlsplit(self.path)
        qs = parse_qs(parsed.query)
        if "__path" in qs and qs["__path"]:
            actual_path = qs["__path"][0]
            # preserve original query parameters without __path
            remaining_qs = [(k, v) for k, vals in qs.items() if k != "__path" for v in vals]
            from urllib.parse import urlencode
            query_str = urlencode(remaining_qs) if remaining_qs else ""
            self.path = urlunsplit(("", "", actual_path, query_str, parsed.fragment))
        elif parsed.path in {"/api/index", "/api/index.py", ""}:
            self.path = "/"

    def do_GET(self) -> None:  # noqa: N802
        self._resolve_vercel_path()
        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        self._resolve_vercel_path()
        super().do_POST()
