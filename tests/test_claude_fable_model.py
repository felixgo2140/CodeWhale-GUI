import importlib.util
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codewhale_server_claude_fable", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class ClaudeFableModelTests(unittest.TestCase):
    def test_fable_is_the_default_claude_subscription_model(self):
        with mock.patch.object(SERVER, "_model_prefs", return_value={}):
            self.assertEqual(SERVER._model_pref("claude-code"), "fable")

    def test_fable_identity_uses_the_official_model_id(self):
        identity = SERVER._claude_identity("fable")
        self.assertIn("Claude Fable 5", identity)
        self.assertIn("`claude-fable-5`", identity)

        full_identity = SERVER._claude_identity("claude-fable-5")
        self.assertIn("Claude Fable 5", full_identity)
        self.assertIn("`claude-fable-5`", full_identity)

    def test_frontend_lists_fable_first(self):
        compare = (ROOT / "web" / "js" / "compare.js").read_text(encoding="utf-8")
        variants = compare.split('"claude-code":[', 1)[1].split('],', 1)[0]
        self.assertTrue(variants.startswith('{id:"fable",name:"Fable 5"}'))

    def test_changing_claude_model_resets_an_unadopted_runtime(self):
        with mock.patch.object(SERVER, "_cmp_reset", return_value=1) as reset:
            restarted = SERVER._reset_provider_after_model_pref("claude-code", "fable", False)

        self.assertTrue(restarted)
        reset.assert_called_once_with("claude-code")

    def test_non_claude_model_change_does_not_restart_runtime(self):
        with mock.patch.object(SERVER, "_cmp_reset") as reset:
            restarted = SERVER._reset_provider_after_model_pref("openai-codex", "gpt-5.6-sol", False)

        self.assertFalse(restarted)
        reset.assert_not_called()


if __name__ == "__main__":
    unittest.main()
