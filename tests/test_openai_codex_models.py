import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codewhale_server_openai_models", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class OpenAICodexModelCatalogTests(unittest.TestCase):
    def test_reads_visible_oauth_models_in_priority_order(self):
        catalog = {
            "models": [
                {"slug": "gpt-5.6-luna", "display_name": "GPT-5.6-Luna", "priority": 3, "visibility": "list", "supported_in_api": True},
                {"slug": "gpt-hidden", "display_name": "Hidden", "priority": 0, "visibility": "hide", "supported_in_api": True},
                {"slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol", "priority": 1, "visibility": "list", "supported_in_api": True,
                 "supported_reasoning_levels": [{"effort": "low"}, {"effort": "ultra"}]},
                {"slug": "not-gpt", "display_name": "Other", "priority": 2, "visibility": "list", "supported_in_api": True},
                {"slug": "gpt-no-api", "display_name": "No API", "priority": 2, "visibility": "list", "supported_in_api": False},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "models_cache.json"
            path.write_text(json.dumps(catalog), encoding="utf-8")
            result = SERVER._codex_oauth_models(str(path))

        self.assertTrue(result["ok"])
        self.assertEqual([item["id"] for item in result["models"]], ["gpt-5.6-sol", "gpt-5.6-luna"])
        self.assertEqual(result["models"][0]["reasoning_levels"], ["low", "ultra"])

    def test_missing_cache_uses_current_bundled_oauth_catalog(self):
        result = SERVER._codex_oauth_models("/definitely/missing/models_cache.json")
        ids = [item["id"] for item in result["models"]]

        self.assertEqual(ids[:3], ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
        with mock.patch.object(SERVER, "_model_prefs", return_value={}):
            self.assertEqual(SERVER._model_pref("openai-codex"), SERVER._OPENAI_CODEX_DEFAULT_MODEL)

    def test_frontend_lists_all_three_gpt_56_variants(self):
        compare = (ROOT / "web" / "js" / "compare.js").read_text(encoding="utf-8")
        for model in ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"):
            self.assertIn(model, compare)


if __name__ == "__main__":
    unittest.main()
