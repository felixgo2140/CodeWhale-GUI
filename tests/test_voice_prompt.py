import importlib.util
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("codewhale_server", ROOT / "server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class VoicePromptTests(unittest.TestCase):
    def test_fallback_removes_stacked_fillers_without_losing_constraints(self):
        prompt = SERVER._voice_prompt_fallback(
            "嗯那个帮我分析 NVDA，重点看未来 3 年增长，输出表格。",
            "请使用最新公开数据并标注来源。",
        )

        self.assertNotIn("嗯", prompt)
        self.assertNotIn("那个", prompt)
        self.assertIn("NVDA", prompt)
        self.assertIn("3 年", prompt)
        self.assertIn("输出表格", prompt)
        self.assertTrue(prompt.startswith("请使用最新公开数据并标注来源。"))

    def test_refine_uses_local_fallback_when_no_direct_provider_exists(self):
        with mock.patch.object(SERVER, "_provider_chat_config", side_effect=RuntimeError("offline")):
            result = SERVER.refine_voice_prompt("啊整理这份报告，保留所有数字。", "用中文。")

        self.assertTrue(result["ok"])
        self.assertFalse(result["refined"])
        self.assertIn("用中文。", result["prompt"])
        self.assertIn("保留所有数字", result["prompt"])

    def test_refine_retries_next_provider_after_primary_failure(self):
        configs = {
            "moonshot": {"provider": "moonshot", "key": "bad", "base": "https://bad.invalid/v1", "model": "k3"},
            "deepseek": {"provider": "deepseek", "key": "good", "base": "https://good.invalid/v1", "model": "deepseek-v4-pro"},
        }

        def config_for(provider):
            if provider in configs:
                return configs[provider]
            raise RuntimeError("unavailable")

        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = (
            b'{"choices":[{"message":{"content":"\\u8bf7\\u6574\\u7406\\u62a5\\u544a\\uff0c\\u4fdd\\u7559\\u6240\\u6709\\u6570\\u5b57\\u3002"}}]}'
        )
        with mock.patch.object(SERVER, "_cfg_get", return_value="moonshot"), \
             mock.patch.object(SERVER, "_provider_chat_config", side_effect=config_for), \
             mock.patch.object(SERVER, "_open_url", side_effect=[RuntimeError("HTTP 400"), response]) as open_url:
            result = SERVER.refine_voice_prompt("整理这份报告，保留所有数字。", provider="moonshot")

        self.assertTrue(result["refined"])
        self.assertEqual(result["provider"], "deepseek")
        self.assertEqual(result["model"], "deepseek-chat")
        self.assertEqual(open_url.call_count, 2)


class ProviderRuntimeAdoptionTests(unittest.TestCase):
    def test_adopts_healthy_existing_provider_without_killing_it(self):
        cfg = pathlib.Path(SERVER.CMP_DIR) / "moonshot.toml"
        ps = mock.MagicMock()
        ps.stdout = "\n".join((
            f'101 node codewhale app-server --config "{cfg}" --http --port 7904',
            f'102 codewhale-tui --config "{cfg}" serve --port 7904',
            f'201 codewhale-tui --config "{pathlib.Path(SERVER.CMP_DIR) / "qwen.toml"}" serve --port 7905',
        ))

        with mock.patch.dict(SERVER.CMP_PORTS, {}, clear=True), \
             mock.patch.object(SERVER.subprocess, "run", return_value=ps), \
             mock.patch.object(SERVER, "_port_up", side_effect=lambda port: port == 7904), \
             mock.patch.object(SERVER, "_kill_gracefully") as kill:
            adopted = SERVER._adopt_cmp_backends()

            self.assertEqual(SERVER.CMP_PORTS, {"moonshot": 7904})
            self.assertEqual(adopted["moonshot"]["port"], 7904)
            self.assertEqual(adopted["moonshot"]["pid"], 102)
            self.assertNotIn("qwen", adopted)
            kill.assert_not_called()


class ThreadStatusOverlayTests(unittest.TestCase):
    def test_runtime_turn_status_overrides_stale_sidebar_summary(self):
        cached = [{
            "id": "thr_demo",
            "title": "旧标题",
            "updated_at": "2026-07-18T20:00:00Z",
            "model": "old-model",
            "latest_turn_id": "turn_old",
            "latest_turn_status": "in_progress",
        }]

        def runtime_json(kind, obj_id):
            if (kind, obj_id) == ("threads", "thr_demo"):
                return {
                    "id": "thr_demo",
                    "title": "新标题",
                    "updated_at": "2026-07-18T20:02:00Z",
                    "model": "k3",
                    "model_provider_id": "moonshot",
                    "latest_turn_id": "turn_current",
                    "archived": False,
                }
            if (kind, obj_id) == ("turns", "turn_current"):
                return {"id": "turn_current", "status": "completed"}
            return None

        with mock.patch.object(SERVER, "_runtime_json", side_effect=runtime_json):
            result = SERVER._overlay_runtime_thread_state(cached)

        self.assertEqual(result[0]["latest_turn_id"], "turn_current")
        self.assertEqual(result[0]["latest_turn_status"], "completed")
        self.assertEqual(result[0]["provider"], "moonshot")
        self.assertEqual(result[0]["model"], "k3")
        self.assertEqual(cached[0]["latest_turn_status"], "in_progress")


if __name__ == "__main__":
    unittest.main()
