import importlib.util
import json
import os
import pathlib
import subprocess
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codewhale_server_qwen", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class QwenUpgradeTests(unittest.TestCase):
    def test_all_supported_qwen_chat_models_require_token_plan(self):
        self.assertTrue(SERVER._qwen_requires_token_plan("qwen3.8-max-preview"))
        self.assertTrue(SERVER._qwen_requires_token_plan("qwen3.7-max"))
        self.assertTrue(SERVER._qwen_requires_token_plan("qwen-plus"))
        self.assertTrue(SERVER._qwen_requires_token_plan("qwq-plus"))
        self.assertFalse(SERVER._qwen_requires_token_plan("deepseek-v4-pro"))

    def test_failed_qwen38_probe_does_not_replace_working_config(self):
        with mock.patch.object(SERVER, "_provider_cfg", return_value={}), \
             mock.patch.object(SERVER, "_read_qwen_credential_profiles", return_value={}), \
             mock.patch.object(SERVER, "_qwen_probe") as probe, \
             mock.patch.object(SERVER, "_set_provider_table_values") as save_cfg, \
             mock.patch.object(SERVER, "_set_model_pref") as save_pref:
            result = SERVER.set_model("qwen", "qwen3.8-max-preview", "", SERVER._QWEN_TOKEN_PLAN_BASE_URL)

        self.assertIn("Qwen Token Plan API key 未配置", result["error"])
        probe.assert_not_called()
        save_cfg.assert_not_called()
        save_pref.assert_not_called()

    def test_validated_qwen38_saves_token_plan_base_and_model(self):
        with mock.patch.object(SERVER, "_provider_cfg", return_value={"api_key": "workspace-key", "base_url": SERVER._QWEN_BASE_URL}), \
             mock.patch.object(SERVER, "_read_qwen_credential_profiles", return_value={}), \
             mock.patch.object(SERVER, "_qwen_probe", return_value={"ok": True}), \
             mock.patch.object(SERVER, "_remember_qwen_credential_profile") as save_profile, \
             mock.patch.object(SERVER, "_set_provider_table_values") as save_cfg, \
             mock.patch.object(SERVER, "_set_model_pref") as save_pref, \
             mock.patch.object(SERVER, "_cmp_reset"), \
             mock.patch.object(SERVER, "_restart_litellm"):
            result = SERVER.set_model("qwen", "qwen3.8-max-preview", "token-plan-key", SERVER._QWEN_TOKEN_PLAN_BASE_URL)

        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], "qwen3.8-max-preview")
        self.assertEqual(result["credential_profile"], "token_plan")
        self.assertEqual(result["base_url"], SERVER._QWEN_TOKEN_PLAN_BASE_URL)
        saved = save_cfg.call_args.args[1]
        self.assertEqual(saved["base_url"], SERVER._QWEN_TOKEN_PLAN_BASE_URL)
        self.assertEqual(saved["model"], "qwen3.8-max-preview")
        self.assertEqual(saved["api_key"], "token-plan-key")
        save_profile.assert_called_once()
        self.assertEqual(save_profile.call_args.args[0], "token_plan")
        save_pref.assert_called_once_with("qwen", "qwen3.8-max-preview")

    def test_saved_token_plan_key_can_be_reused_without_workspace_key(self):
        profiles = {"token_plan": {
            "api_key": "saved-token-plan-key",
            "base_url": SERVER._QWEN_TOKEN_PLAN_BASE_URL,
            "model": "qwen3.8-max-preview",
        }}
        with mock.patch.object(SERVER, "_provider_cfg", return_value={
                 "api_key": "workspace-key", "base_url": SERVER._QWEN_BASE_URL,
                 "model": SERVER._QWEN_DEFAULT_MODEL,
             }), \
             mock.patch.object(SERVER, "_read_qwen_credential_profiles", return_value=profiles), \
             mock.patch.object(SERVER, "_qwen_probe", return_value={"ok": True}) as probe, \
             mock.patch.object(SERVER, "_remember_qwen_credential_profile"), \
             mock.patch.object(SERVER, "_set_provider_table_values") as save_cfg, \
             mock.patch.object(SERVER, "_set_model_pref"), \
             mock.patch.object(SERVER, "_cmp_reset"), \
             mock.patch.object(SERVER, "_restart_litellm"):
            result = SERVER.set_model("qwen", "qwen3.8-max-preview", "", "")

        self.assertTrue(result["ok"])
        probe.assert_called_once_with("saved-token-plan-key", SERVER._QWEN_TOKEN_PLAN_BASE_URL,
                                      "qwen3.8-max-preview")
        self.assertEqual(save_cfg.call_args.args[1]["api_key"], "saved-token-plan-key")

    def test_qwen_credential_status_exposes_only_token_plan(self):
        with mock.patch.object(SERVER, "_provider_cfg", return_value={
                 "api_key": "workspace-key", "base_url": SERVER._QWEN_BASE_URL,
                 "model": SERVER._QWEN_DEFAULT_MODEL,
             }), \
             mock.patch.object(SERVER, "_read_qwen_credential_profiles", return_value={}):
            status = SERVER._qwen_credential_status()

        self.assertEqual(status["active_profile"], "token_plan")
        self.assertNotIn("workspace", status)
        self.assertTrue(status["token_plan"]["configured"])
        self.assertEqual(status["token_plan"]["base_url"], SERVER._QWEN_TOKEN_PLAN_BASE_URL)

    def test_qwen38_lightweight_chat_omits_temperature(self):
        captured = {}

        def fake_post(url, payload, api_key, timeout=0):
            captured.update(payload)
            self.assertEqual(url, SERVER._QWEN_TOKEN_PLAN_BASE_URL + "/chat/completions")
            self.assertEqual(api_key, "key")
            return 200, {"choices": [{"message": {"content": "OK"}}]}, ""

        with mock.patch.object(SERVER, "_provider_cfg", return_value={"api_key": "key", "base_url": "https://token.invalid/v1"}), \
             mock.patch.object(SERVER, "_provider_key", return_value="key"), \
             mock.patch.object(SERVER, "_model_pref", return_value="qwen3.8-max-preview"), \
             mock.patch.object(SERVER, "_curl_json_post_ipv4", side_effect=fake_post):
            result = SERVER._qwen_chat_once("qwen", "hello")

        self.assertEqual(result["text"], "OK")
        self.assertNotIn("temperature", captured)

    def test_qwen_json_post_forces_ipv4_and_hides_key_from_argv(self):
        secret = "qwen-test-secret"
        payload = {"model": "qwen3.8-max-preview", "messages": [{"role": "user", "content": "hi"}]}
        observed = {}

        def fake_run(argv, **kwargs):
            observed["argv"] = list(argv)
            observed["input"] = kwargs["input"]
            config_path = argv[argv.index("--config") + 1]
            observed["config_path"] = config_path
            observed["config_mode"] = os.stat(config_path).st_mode & 0o777
            observed["config_text"] = pathlib.Path(config_path).read_text(encoding="utf-8")
            return subprocess.CompletedProcess(
                argv,
                0,
                stdout=b'{"choices":[{"message":{"content":"OK"}}]}\n200',
                stderr=b"",
            )

        with mock.patch.object(SERVER.subprocess, "run", side_effect=fake_run):
            status, data, _raw = SERVER._curl_json_post_ipv4(
                "https://token.invalid/v1/chat/completions",
                payload,
                secret,
                timeout=12,
            )

        self.assertEqual(status, 200)
        self.assertEqual(data["choices"][0]["message"]["content"], "OK")
        self.assertIn("-4", observed["argv"])
        self.assertNotIn(secret, " ".join(observed["argv"]))
        self.assertEqual(observed["config_mode"], 0o600)
        self.assertIn(secret, observed["config_text"])
        self.assertEqual(json.loads(observed["input"].decode()), payload)
        self.assertFalse(os.path.exists(observed["config_path"]))

    def test_qwen_json_get_forces_ipv4_and_hides_key_from_argv(self):
        secret = "qwen-model-catalog-secret"
        observed = {}

        def fake_run(argv, **kwargs):
            observed["argv"] = list(argv)
            config_path = argv[argv.index("--config") + 1]
            observed["config_path"] = config_path
            observed["config_mode"] = os.stat(config_path).st_mode & 0o777
            observed["config_text"] = pathlib.Path(config_path).read_text(encoding="utf-8")
            return subprocess.CompletedProcess(
                argv,
                0,
                stdout=b'{"data":[{"id":"qwen3.8-max-preview"}]}\n200',
                stderr=b"",
            )

        with mock.patch.object(SERVER.subprocess, "run", side_effect=fake_run):
            status, data, _raw = SERVER._curl_json_get_ipv4(
                SERVER._QWEN_TOKEN_PLAN_BASE_URL + "/models",
                secret,
                timeout=8,
            )

        self.assertEqual(status, 200)
        self.assertEqual(data["data"][0]["id"], "qwen3.8-max-preview")
        self.assertIn("-4", observed["argv"])
        self.assertNotIn(secret, " ".join(observed["argv"]))
        self.assertEqual(observed["config_mode"], 0o600)
        self.assertIn(secret, observed["config_text"])
        self.assertFalse(os.path.exists(observed["config_path"]))

    def test_qwen_model_catalog_keeps_all_chat_compatible_qwen_models(self):
        response = {
            "data": [
                {"id": "qwen3.8-max-preview", "display_name": "Qwen 3.8 Max"},
                {"id": "qwen3.8-flash", "display_name": "Qwen 3.8 Flash"},
                {"id": "qwen3.7-plus", "display_name": "Qwen 3.7 Plus"},
                {"id": "qwen-plus"},
                {"id": "qwen-coder-plus"},
                {"id": "qwen-vl-plus"},
                {"id": "qwq-plus"},
                {"id": "text-embedding-v4"},
                {"id": "qwen-tts"},
                {"id": "wan2.1-video"},
                {"id": "other-model"},
            ]
        }
        SERVER._PROVIDER_MODELS_CACHE.pop("qwen", None)
        with mock.patch.object(SERVER, "_provider_cfg", return_value={"api_key": "key"}), \
             mock.patch.object(SERVER, "_provider_key", return_value="key"), \
             mock.patch.object(SERVER, "_curl_json_get_ipv4", return_value=(200, response, json.dumps(response))):
            result = SERVER._provider_models("qwen", force=True)

        self.assertTrue(result["ok"])
        self.assertEqual(
            [item["id"] for item in result["models"]],
            [
                "qwen3.8-max-preview", "qwen3.8-flash", "qwen3.7-plus",
                "qwen-plus", "qwen-coder-plus", "qwen-vl-plus", "qwq-plus",
            ],
        )
        rendered = json.dumps(result)
        self.assertNotIn("text-embedding-v4", rendered)
        self.assertNotIn("qwen-tts", rendered)
        self.assertNotIn("wan2.1-video", rendered)

    def test_frontend_keeps_token_plan_model_in_curated_catalog(self):
        source = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")
        panels = (ROOT / "web/js/panels.js").read_text(encoding="utf-8")

        self.assertIn("qwen3.8-max-preview", source)
        self.assertIn("Token Plan", source)
        self.assertIn("const merged=[...curated", source)
        self.assertIn('id="mbase"', panels)
        self.assertIn("payload.base_url", panels)
        self.assertIn(SERVER._QWEN_TOKEN_PLAN_BASE_URL, panels)
        self.assertIn("provider_credentials", panels)
        self.assertIn("不按 key 前缀判断", panels)
        self.assertIn("/models", panels)


if __name__ == "__main__":
    unittest.main()
