import importlib.util
import io
import json
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codewhale_server_qwen", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class QwenUpgradeTests(unittest.TestCase):
    def test_qwen38_requires_token_plan(self):
        self.assertTrue(SERVER._qwen_requires_token_plan("qwen3.8-max-preview"))
        self.assertFalse(SERVER._qwen_requires_token_plan("qwen3.7-max"))

    def test_failed_qwen38_probe_does_not_replace_working_config(self):
        with mock.patch.object(SERVER, "_provider_cfg", return_value={"api_key": "old", "base_url": "https://old.invalid/v1"}), \
             mock.patch.object(SERVER, "_qwen_probe", return_value={"fatal": True, "error": "Token Plan required"}), \
             mock.patch.object(SERVER, "_set_provider_table_values") as save_cfg, \
             mock.patch.object(SERVER, "_set_model_pref") as save_pref:
            result = SERVER.set_model("qwen", "qwen3.8-max-preview", "", SERVER._QWEN_TOKEN_PLAN_BASE_URL)

        self.assertEqual(result["error"], "Token Plan required")
        save_cfg.assert_not_called()
        save_pref.assert_not_called()

    def test_validated_qwen38_saves_token_plan_base_and_model(self):
        with mock.patch.object(SERVER, "_provider_cfg", return_value={"api_key": "token-plan-key"}), \
             mock.patch.object(SERVER, "_qwen_probe", return_value={"ok": True}), \
             mock.patch.object(SERVER, "_set_provider_table_values") as save_cfg, \
             mock.patch.object(SERVER, "_set_model_pref") as save_pref, \
             mock.patch.object(SERVER, "_cmp_reset"):
            result = SERVER.set_model("qwen", "qwen3.8-max-preview", "", SERVER._QWEN_TOKEN_PLAN_BASE_URL)

        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "qwen3.8-max-preview")
        self.assertEqual(result["base_url"], SERVER._QWEN_TOKEN_PLAN_BASE_URL)
        saved = save_cfg.call_args.args[1]
        self.assertEqual(saved["base_url"], SERVER._QWEN_TOKEN_PLAN_BASE_URL)
        self.assertEqual(saved["model"], "qwen3.8-max-preview")
        save_pref.assert_called_once_with("qwen", "qwen3.8-max-preview")

    def test_qwen38_lightweight_chat_omits_temperature(self):
        response = io.BytesIO(json.dumps({
            "choices": [{"message": {"content": "OK"}}],
        }).encode())
        captured = {}

        def fake_open(req, timeout=0):
            captured.update(json.loads(req.data.decode()))
            response.seek(0)
            return response

        with mock.patch.object(SERVER, "_provider_cfg", return_value={"api_key": "key", "base_url": "https://token.invalid/v1"}), \
             mock.patch.object(SERVER, "_provider_key", return_value="key"), \
             mock.patch.object(SERVER, "_model_pref", return_value="qwen3.8-max-preview"), \
             mock.patch.object(SERVER._LOCAL, "open", side_effect=fake_open):
            result = SERVER._qwen_chat_once("qwen", "hello")

        self.assertEqual(result["text"], "OK")
        self.assertNotIn("temperature", captured)

    def test_frontend_keeps_token_plan_model_in_curated_catalog(self):
        source = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")
        panels = (ROOT / "web/js/panels.js").read_text(encoding="utf-8")

        self.assertIn("qwen3.8-max-preview", source)
        self.assertIn("Token Plan", source)
        self.assertIn("const merged=[...curated", source)
        self.assertIn('id="mbase"', panels)
        self.assertIn("payload.base_url", panels)
        self.assertIn(SERVER._QWEN_TOKEN_PLAN_BASE_URL, panels)


if __name__ == "__main__":
    unittest.main()
