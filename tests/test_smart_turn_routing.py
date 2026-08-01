from pathlib import Path
from unittest import mock
import io
import json
import tempfile
import threading
import unittest

import server


ROOT = Path(__file__).resolve().parents[1]


class SmartTurnRouteTests(unittest.TestCase):
    def setUp(self):
        self.old_routes = dict(server._auto_turn_routes)
        server._auto_turn_routes.clear()

    def tearDown(self):
        server._auto_turn_routes.clear()
        server._auto_turn_routes.update(self.old_routes)

    def test_query_phrases_require_external_tools(self):
        self.assertTrue(server._turn_requires_external_tools("越早越好，你先查下票"))

    def test_fast_answer_feature_is_removed(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")

        self.assertNotIn("_SMART_FAST_MODEL_ROUTES", source)
        self.assertNotIn("classify_single_turn", source)
        self.assertNotIn("/api/turn-complexity", source)

    @mock.patch.object(server, "_save_auto_turn_routes")
    @mock.patch.object(server, "_switch_single_thread_provider")
    @mock.patch.object(server, "_thread_current_route")
    def test_plain_turn_keeps_selected_model(
        self, current, switch, _save
    ):
        current.return_value = {"provider": "deepseek", "model": "deepseek-v4-pro"}

        result = server.prepare_single_turn_route("thr_test", "你好")

        self.assertEqual(result["mode"], "standard")
        self.assertEqual(result["provider"], "deepseek")
        self.assertEqual(result["model"], "deepseek-v4-pro")
        self.assertEqual(result["reason"], "selected_model")
        switch.assert_not_called()
        self.assertNotIn("thr_test", server._auto_turn_routes)

    @mock.patch.object(server, "_save_auto_turn_routes")
    @mock.patch.object(server, "_switch_single_thread_provider")
    @mock.patch.object(server, "_thread_current_route")
    def test_legacy_fast_route_restores_saved_reasoning_model(
        self, current, switch, _save
    ):
        server._auto_turn_routes["thr_qwen_legacy"] = {
            "preferred": {"provider": "qwen", "model": "qwen3.8-max-preview"},
            "active": True,
        }
        current.return_value = {
            "provider": "qwen",
            "model": "qwen3.8-max-preview",
        }
        switch.return_value = {
            "provider": "qwen",
            "model": "qwen3.8-max-preview",
        }

        result = server.prepare_single_turn_route("thr_qwen_legacy", "你好")

        self.assertEqual(result["mode"], "standard")
        self.assertTrue(result["restored"])
        self.assertEqual(result["provider"], "qwen")
        self.assertEqual(result["model"], "qwen3.8-max-preview")
        self.assertEqual(result["compatibility_mode"], "qwen_text")
        switch.assert_called_once_with(
            "thr_qwen_legacy", "qwen", "qwen3.8-max-preview", persist_pref=False
        )
        self.assertNotIn("thr_qwen_legacy", server._auto_turn_routes)

    @mock.patch.object(server, "restore_single_turn_route")
    def test_startup_cleanup_targets_only_retired_fast_routes(self, restore):
        server._auto_turn_routes.update({
            "thr_legacy_fast": {
                "preferred": {"provider": "deepseek", "model": "deepseek-v4-pro"},
                "active": True,
            },
            "thr_tool_delegate": {
                "preferred": {"provider": "qwen", "model": "qwen3.8-max-preview"},
                "active": True,
                "kind": "compat_tool_delegate",
            },
        })
        restore.return_value = {"restored": True}

        count = server.restore_retired_fast_routes()

        self.assertEqual(count, 1)
        restore.assert_called_once_with("thr_legacy_fast")

    @mock.patch.object(server, "_save_auto_turn_routes")
    @mock.patch.object(server, "_enforce_single_route_compatibility")
    @mock.patch.object(server, "_switch_single_thread_provider")
    @mock.patch.object(server, "_thread_current_route")
    def test_kimi_code_model_keeps_selection_for_plain_text_chat(
        self, current, switch, enforce, _save
    ):
        current.return_value = {
            "provider": "moonshot",
            "model": "kimi-for-coding-highspeed",
        }
        enforce.side_effect = lambda _tid, route: {
            **route,
            "auto_approve_disabled": False,
            "shell_disabled": False,
            "plugin_tools_enabled": False,
            "text_only": True,
        }

        result = server.prepare_single_turn_route(
            "thr_kimi_code", "请你详细说明 Kimi 在长对话中的能力边界与适用场景"
        )

        switch.assert_not_called()
        self.assertEqual(result["model"], "kimi-for-coding-highspeed")
        self.assertEqual(result["compatibility_mode"], "moonshot_text")
        self.assertFalse(result["auto_approve_disabled"])
        self.assertFalse(result["shell_disabled"])
        self.assertFalse(result["plugin_tools_enabled"])
        self.assertNotIn("deny_all_tools", result)

    @mock.patch.object(server._LOCAL, "open")
    def test_k3_text_mode_does_not_mutate_runtime_flags(self, open_url):
        route = server._compatible_single_route({
            "provider": "moonshot",
            "model": "k3",
        })

        result = server._enforce_single_route_compatibility("thr_k3", route)

        open_url.assert_not_called()
        self.assertTrue(result["text_only"])
        self.assertFalse(result["auto_approve_disabled"])
        self.assertFalse(result["shell_disabled"])
        self.assertFalse(result["plugin_tools_enabled"])

    @mock.patch.object(server, "_save_auto_turn_routes")
    @mock.patch.object(server, "_switch_single_thread_provider")
    @mock.patch.object(server, "_thread_current_route")
    def test_restore_returns_to_original_model(self, current, switch, _save):
        server._auto_turn_routes["thr_test"] = {
            "preferred": {"provider": "openai-codex", "model": "gpt-5.6-sol"},
            "active": True,
        }
        current.return_value = {"provider": "qwen", "model": "qwen3.8-max-preview"}
        switch.return_value = {
            "provider": "openai-codex",
            "model": "gpt-5.6-sol",
        }

        result = server.restore_single_turn_route("thr_test")

        self.assertTrue(result["restored"])
        self.assertEqual(result["provider"], "openai-codex")
        self.assertEqual(result["model"], "gpt-5.6-sol")
        switch.assert_called_once_with(
            "thr_test",
            "openai-codex",
            "gpt-5.6-sol",
            persist_pref=False,
        )
        self.assertNotIn("thr_test", server._auto_turn_routes)

    @mock.patch.object(server, "_save_auto_turn_routes")
    @mock.patch.object(server, "_compatible_tool_executor")
    @mock.patch.object(server, "_switch_single_thread_provider")
    @mock.patch.object(server, "_thread_current_route")
    def test_qwen_tool_turn_delegates_once_then_restores_qwen(
        self, current, switch, executor, _save
    ):
        current.return_value = {
            "provider": "qwen",
            "model": "qwen3.8-max-preview",
        }
        executor.return_value = {
            "provider": "volcengine",
            "model": "doubao-seed-2-1-pro-260628",
            "display": "豆包",
        }
        switch.side_effect = [
            {
                "provider": "volcengine",
                "model": "doubao-seed-2-1-pro-260628",
            },
            {
                "provider": "qwen",
                "model": "qwen3.8-max-preview",
            },
        ]

        delegated = server.prepare_single_turn_route(
            "thr_qwen_tool", "读取这个链接并做视频总结：https://example.com"
        )

        self.assertTrue(delegated["delegated"])
        self.assertTrue(delegated["restore_after_turn"])
        self.assertEqual(delegated["provider"], "volcengine")
        self.assertEqual(
            server._auto_turn_routes["thr_qwen_tool"]["preferred"],
            {
                "provider": "qwen",
                "model": "qwen3.8-max-preview",
                "compatibility_mode": "qwen_text",
                "display": "qwen3.8-max-preview",
            },
        )

        restored = server.restore_single_turn_route("thr_qwen_tool")

        self.assertTrue(restored["restored"])
        self.assertEqual(restored["provider"], "qwen")
        self.assertEqual(restored["model"], "qwen3.8-max-preview")
        self.assertEqual(restored["compatibility_mode"], "qwen_text")
        self.assertNotIn("thr_qwen_tool", server._auto_turn_routes)
        self.assertEqual(
            switch.call_args_list,
            [
                mock.call(
                    "thr_qwen_tool",
                    "volcengine",
                    "doubao-seed-2-1-pro-260628",
                    persist_pref=False,
                ),
                mock.call(
                    "thr_qwen_tool",
                    "qwen",
                    "qwen3.8-max-preview",
                    persist_pref=False,
                ),
            ],
        )


class SmartTurnFrontendTests(unittest.TestCase):
    def test_preflight_runs_before_turn_creation(self):
        source = (ROOT / "web/js/stream.js").read_text(encoding="utf-8")
        route = source.index('api("/api/turn-route"')
        turn = source.index("`/v1/threads/${state.activeId}/turns`", route)
        self.assertLess(route, turn)
        self.assertIn('runStatusUpdate("准备模型","使用当前任务所选模型")', source)
        self.assertNotIn('route.mode==="fast"', source)
        self.assertNotIn("快速模型", source)

    def test_single_kimi_and_qwen_use_shared_persistent_text_route(self):
        source = (ROOT / "web/js/stream.js").read_text(encoding="utf-8")
        self.assertIn("let turnRoute=null", source)
        self.assertIn("turnRoute=route", source)
        self.assertIn(
            "Kimi 文本兼容模式 · 不发送 Moonshot 不支持的函数 Schema",
            source,
        )
        self.assertIn("Qwen 文本兼容模式 · 不发送函数工具参数", source)
        self.assertIn('api("/api/compat-text-turn"', source)
        self.assertIn('api("/api/compat-text-history?thread_id="', source)
        self.assertIn('turnRoute.compatibility_mode==="qwen_text"', source)
        self.assertIn('turnRoute.compatibility_mode==="moonshot_text"', source)
        self.assertNotIn("turnPayload.deny_all_tools", source)

    def test_compare_kimi_and_qwen_use_persistent_text_route_without_runtime_tools(self):
        source = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")
        self.assertIn("function cmpTextCompatibility(prov,text,rs,st", source)
        self.assertIn('api("/api/compat-text-turn"', source)
        self.assertIn('api(`/api/compat-text-history?thread_id=', source)
        self.assertIn("function cmpIsCompatSchemaError(prov,text)", source)
        self.assertIn('prov==="moonshot" || prov==="qwen"', source)
        self.assertNotIn('api("/api/qwen-chat"', source)


class MoonshotTextFallbackTests(unittest.TestCase):
    @mock.patch.object(server, "_open_url")
    @mock.patch.object(server, "_provider_chat_config")
    def test_text_fallback_does_not_send_function_schema(self, provider_config, open_url):
        provider_config.return_value = {
            "provider": "moonshot",
            "key": "test-secret",
            "base": "https://example.test/v1",
            "model": "k3",
        }

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(
                    {"choices": [{"message": {"content": "我是 Kimi K3。"}}]}
                ).encode()

        open_url.return_value = FakeResponse()
        result = server._combo_text_once("moonshot", "k3", "你是哪个模型")

        request = open_url.call_args.args[0]
        payload = json.loads(request.data.decode())
        self.assertEqual(payload["model"], "k3")
        self.assertNotIn("tools", payload)
        self.assertNotIn("functions", payload)
        self.assertNotIn("function_call", payload)
        self.assertNotIn("test-secret", request.data.decode())
        self.assertEqual(result["text"], "我是 Kimi K3。")

    @mock.patch.object(server.time, "sleep")
    @mock.patch.object(server, "_open_url")
    @mock.patch.object(server, "_provider_chat_config")
    def test_moonshot_overload_retries_before_succeeding(
        self, provider_config, open_url, sleep
    ):
        provider_config.return_value = {
            "provider": "moonshot",
            "key": "test-secret",
            "base": "https://example.test/v1",
            "model": "k3",
        }
        overload = lambda: server.urllib.error.HTTPError(
            "https://example.test/v1/chat/completions",
            429,
            "overloaded",
            {},
            io.BytesIO(b'{"error":{"message":"The engine is currently overloaded"}}'),
        )

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"choices":[{"message":{"content":"retry ok"}}]}'

        open_url.side_effect = [overload(), overload(), FakeResponse()]
        result = server._text_chat_once(
            "moonshot", "k3", [{"role": "user", "content": "hi"}], 64
        )

        self.assertEqual(result["text"], "retry ok")
        self.assertEqual(open_url.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    @mock.patch.object(server, "_text_chat_once")
    def test_persistent_text_turn_restores_history_without_tools(self, text_chat):
        text_chat.side_effect = [
            {"text": "第一轮回答", "model": "k3"},
            {"text": "第二轮回答", "model": "k3"},
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "moonshot_text_sessions.json"
            with mock.patch.object(server, "MOONSHOT_TEXT_SESSIONS_FILE", str(path)):
                first = server._moonshot_text_turn("thr_kimi", "k3", "第一轮问题")
                second = server._moonshot_text_turn("thr_kimi", "k3", "第二轮问题")
                restored = server._moonshot_text_snapshot("thr_kimi")

        self.assertEqual(first["snapshot"]["items"][-1]["detail"], "第一轮回答")
        self.assertEqual(second["snapshot"]["items"][-1]["detail"], "第二轮回答")
        self.assertEqual(restored["items"][-1]["detail"], "第二轮回答")
        sent_messages = text_chat.call_args_list[1].args[2]
        self.assertEqual(
            [message["content"] for message in sent_messages if message["role"] != "system"],
            ["第一轮问题", "第一轮回答", "第二轮问题"],
        )

    @mock.patch.object(server, "_text_chat_once")
    def test_qwen_and_kimi_text_histories_are_isolated(self, text_chat):
        text_chat.side_effect = [
            {"text": "Qwen 回答", "model": "qwen3.8-max-preview"},
            {"text": "Kimi 回答", "model": "k3"},
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "compat_text_sessions.json"
            with mock.patch.object(server, "MOONSHOT_TEXT_SESSIONS_FILE", str(path)):
                server._compat_text_turn(
                    "thr_shared", "qwen", "qwen3.8-max-preview", "Qwen 问题"
                )
                server._compat_text_turn("thr_shared", "moonshot", "k3", "Kimi 问题")
                qwen = server._compat_text_snapshot("thr_shared", "qwen")
                kimi = server._compat_text_snapshot("thr_shared", "moonshot")

        self.assertEqual(qwen["items"][-1]["detail"], "Qwen 回答")
        self.assertEqual(kimi["items"][-1]["detail"], "Kimi 回答")
        self.assertNotIn("Kimi 回答", json.dumps(qwen, ensure_ascii=False))
        self.assertNotIn("Qwen 回答", json.dumps(kimi, ensure_ascii=False))

    @mock.patch.object(server, "_text_chat_once")
    def test_history_remains_readable_while_provider_request_is_pending(self, text_chat):
        read_finished = threading.Event()

        def pending_call(*_args, **_kwargs):
            reader = threading.Thread(
                target=lambda: (
                    server._moonshot_text_snapshot("thr_kimi_pending"),
                    read_finished.set(),
                )
            )
            reader.start()
            reader.join(timeout=0.5)
            self.assertTrue(read_finished.is_set())
            return {"text": "完成", "model": "k3"}

        text_chat.side_effect = pending_call
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "moonshot_text_sessions.json"
            with mock.patch.object(server, "MOONSHOT_TEXT_SESSIONS_FILE", str(path)):
                result = server._moonshot_text_turn(
                    "thr_kimi_pending", "k3", "等待中的请求"
                )

        self.assertEqual(result["text"], "完成")


class QwenFastProxyTests(unittest.TestCase):
    def test_supported_qwen_chat_model_is_preserved(self):
        payload = server._qwen_proxy_payload(
            {"model": "qwen3.7-plus", "messages": [{"role": "user", "content": "hi"}]}
        )
        self.assertEqual(payload["model"], "qwen3.7-plus")
        self.assertNotIn("enable_thinking", payload)

    def test_reasoning_model_is_untouched(self):
        original = {"model": "qwen3.8-max-preview", "stream": True}
        self.assertEqual(server._qwen_proxy_payload(original), original)

    def test_non_chat_model_falls_back_to_default(self):
        payload = server._qwen_proxy_payload({"model": "text-embedding-v4"})
        self.assertEqual(payload["model"], "qwen3.8-max-preview")

    def test_only_canonical_token_plan_region_is_recognized(self):
        self.assertTrue(server._qwen_is_token_plan_base(
            "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
        ))
        self.assertFalse(server._qwen_is_token_plan_base(
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
        ))


if __name__ == "__main__":
    unittest.main()
