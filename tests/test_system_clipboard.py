import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codewhale_server_clipboard", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class SystemClipboardTests(unittest.TestCase):
    @mock.patch.object(SERVER.subprocess, "run")
    def test_copy_uses_macos_pbcopy(self, run):
        run.return_value = subprocess.CompletedProcess(["/usr/bin/pbcopy"], 0, b"", b"")

        result = SERVER._copy_system_clipboard("DeepSeek reply\n\nChatGPT reply")

        self.assertTrue(result["ok"])
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["/usr/bin/pbcopy"])
        self.assertEqual(kwargs["input"], b"DeepSeek reply\n\nChatGPT reply")

    def test_copy_rejects_empty_or_oversized_content(self):
        self.assertFalse(SERVER._copy_system_clipboard("")["ok"])
        self.assertFalse(SERVER._copy_system_clipboard("x" * (8 * 1024 * 1024 + 1))["ok"])

    def test_clipboard_endpoint_requires_authentication(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        route = source[source.index('if p == "/api/clipboard"'):source.index('if p == "/api/workspace/reveal"')]
        self.assertIn("if not self._authed()", route)
        self.assertIn("_copy_system_clipboard", route)


if __name__ == "__main__":
    unittest.main()
