import json
import pathlib
import tempfile
import unittest
from unittest import mock

import server


ROOT = pathlib.Path(__file__).resolve().parents[1]


def _catalog(*model_ids):
    return {
        "items": {
            "qwen": {
                "provider": "qwen",
                "ok": True,
                "source": "https://example.test/v1/models",
                "models": [{"id": model_id, "name": model_id} for model_id in model_ids],
            }
        }
    }


class ModelUpdateCatalogTests(unittest.TestCase):
    def test_first_sync_is_baseline_and_later_ids_are_reported_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = str(pathlib.Path(tmp) / "catalog.json")
            with (
                mock.patch.object(server, "_MODEL_CATALOG_STATE_FILE", state_file),
                mock.patch.object(server, "_MODEL_UPDATE_PROVIDER_IDS", ("qwen",)),
                mock.patch.object(server, "provider_models", side_effect=[
                    _catalog("qwen-a"),
                    _catalog("qwen-a", "qwen-b"),
                ]),
            ):
                baseline = server.check_model_updates(force=True)
                changed = server.check_model_updates(force=True)

            self.assertTrue(baseline["initialized"])
            self.assertEqual(baseline["total_new"], 0)
            self.assertEqual(changed["total_new"], 1)
            self.assertEqual(changed["providers"][0]["new_models"][0]["id"], "qwen-b")

    def test_acknowledge_clears_notice_without_removing_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_file = pathlib.Path(tmp) / "catalog.json"
            state_file.write_text(json.dumps({
                "initialized": True,
                "checked_at": 1,
                "providers": {
                    "qwen": {
                        "ok": True,
                        "models": [{"id": "qwen-a"}, {"id": "qwen-b"}],
                        "pending_new": [{"id": "qwen-b"}],
                    }
                },
            }), encoding="utf-8")
            with (
                mock.patch.object(server, "_MODEL_CATALOG_STATE_FILE", str(state_file)),
                mock.patch.object(server, "_MODEL_UPDATE_PROVIDER_IDS", ("qwen",)),
            ):
                result = server.acknowledge_model_updates()

            self.assertEqual(result["total_new"], 0)
            self.assertEqual(result["total_models"], 2)

    def test_claude_cli_catalog_is_deduplicated(self):
        result = server._provider_models("claude-code", force=True)
        ids = [item["id"] for item in result["models"]]

        self.assertTrue(result["ok"])
        self.assertEqual(len(ids), len(set(ids)))
        self.assertIn("claude-fable-5", ids)

    def test_update_center_has_exactly_three_primary_lanes(self):
        panels = (ROOT / "web/js/panels.js").read_text(encoding="utf-8")
        overview = panels.split("function renderUpdateOverview(target){", 1)[1].split(
            "async function loadUpdateOverviewStatus()", 1
        )[0]
        main = (ROOT / "web/js/main.js").read_text(encoding="utf-8")

        self.assertIn('renderUpdateCard("gui"', overview)
        self.assertIn('renderUpdateCard("backend"', overview)
        self.assertIn('renderUpdateCard("models"', overview)
        self.assertNotIn('renderUpdateCard("harness"', overview)
        self.assertNotIn('renderUpdateCard("skills"', overview)
        self.assertIn("checkModelUpdates({startup:true,force:true})", main)
        self.assertIn("不会自动切换现有对话", panels)


if __name__ == "__main__":
    unittest.main()
