import importlib.util
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = load_module("codewhale_server_combo", ROOT / "server.py")


class ComboWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.html = (ROOT / "web/index.html").read_text(encoding="utf-8")
        self.combo = (ROOT / "web/js/combo.js").read_text(encoding="utf-8")
        self.threads = (ROOT / "web/js/threads.js").read_text(encoding="utf-8")

    def test_combo_toolbar_exposes_two_configurable_roles(self):
        for role, title in (
            ("controller", "总调度"),
            ("executor", "执行模型"),
        ):
            self.assertIn(f'data-role="{role}"', self.html)
            self.assertIn(title, self.html)
        self.assertIn('id="comboConfigure"', self.html)
        self.assertIn('id="comboIntervene"', self.html)
        self.assertNotIn('data-role="worker"', self.html)
        self.assertNotIn('data-role="operator"', self.html)
        self.assertNotIn('data-role="dispatcher"', self.html)
        self.assertNotIn('data-role="planAuditor"', self.html)

    def test_pipeline_is_adaptive_and_has_checkpoints(self):
        pipeline = self.combo.split(
            "async function comboRunPipeline(task){", 1
        )[1].split("async function comboSteer(raw){", 1)[0]
        controller = pipeline.index('comboRunRole("controller",comboControllerPlanPrompt')
        executor = pipeline.index('comboRunRole("executor",comboExecutorPrompt')
        audit = pipeline.index('comboRunRole("controller",comboControllerAuditPrompt')
        self.assertLess(controller, executor)
        self.assertLess(executor, audit)
        self.assertIn('comboRecordCheckpoint("plan"', pipeline)
        self.assertIn('comboRecordCheckpoint("execute"', pipeline)
        self.assertIn('comboRecordCheckpoint("audit"', pipeline)
        self.assertIn('comboRecordCheckpoint("complete"', pipeline)
        self.assertIn('if(taskMode==="simple"&&!comboTaskNeedsTools(task))', pipeline)
        self.assertIn('?"EXECUTOR_WITH_TOOLS"', pipeline)
        self.assertIn('if(artifacts.risk==="HIGH"&&!COMBO.session.high_risk_confirmed)', pipeline)
        self.assertIn('for(let round=Number(artifacts.repairRound||0);round<=COMBO.maxRepairRounds;round++)', pipeline)
        self.assertIn('maxRepairRounds:1', self.combo)

    def test_controller_audit_only_blocks_delivery_critical_problems(self):
        self.assertIn("只把会导致错误、安全问题、关键遗漏或不可交付的事项视为阻断", self.combo)
        self.assertIn("格式偏好和可选优化不得阻断", self.combo)
        self.assertIn("FINAL_AUDIT: PASS | REPAIR_EXECUTOR | BLOCK", self.combo)
        self.assertIn("ROUTE: DIRECT | EXECUTOR | EXECUTOR_WITH_TOOLS | CLARIFY", self.combo)

    def test_guidance_and_stop_remain_available_during_work(self):
        self.assertIn("async function comboSteer(raw)", self.combo)
        self.assertIn("用户实时引导", self.combo)
        self.assertIn("后续阶段也会继承", self.combo)
        self.assertIn("async function comboStop()", self.combo)
        self.assertIn('error.code="COMBO_STOPPED"', self.combo)
        self.assertIn("确认高风险操作并继续", self.combo)
        self.assertIn("从当前任务重新规划", self.combo)

    def test_only_executor_can_use_the_hidden_tool_fallback(self):
        self.assertIn('if(comboRoleKey(roleKey)==="executor"&&allowTools) return [];', self.combo)
        self.assertIn('comboExecutionProfile(true)', self.combo)
        self.assertIn('toolProvider', self.combo)
        self.assertIn('toolModel', self.combo)
        self.assertIn("禁止改文件、跑命令或调用工具", self.combo)
        self.assertIn("不改文件、不跑命令", self.combo)

    def test_attachments_paths_and_links_never_take_the_no_tool_direct_path(self):
        self.assertIn("function comboTaskNeedsTools(task)", self.combo)
        self.assertIn("<attachment_ocr>", self.combo)
        self.assertIn("原图\\s*:", self.combo)
        self.assertIn("EXECUTOR_WITH_TOOLS；不要要求用户重复粘贴已有文件内容", self.combo)

    def test_direct_text_response_is_persisted_once(self):
        direct = self.combo.split("async function comboRunDirectTextRole", 1)[1].split(
            "async function comboRunRole", 1
        )[0]
        self.assertEqual(direct.count('comboAddMessage("agent_message",text'), 1)

    def test_role_settings_use_human_facing_quality_controls(self):
        for label in ("思考强度", "对话长度", "标准", "进阶", "极致", "超长"):
            self.assertIn(label, self.combo)
        for raw_label in ("Reasoning effort", "Temperature", "Max tokens / 输出预算"):
            self.assertNotIn(raw_label, self.combo)
        self.assertIn("输出长度由模型能力自动选择", self.combo)
        self.assertIn("function comboOpenRolesConfig()", self.combo)
        self.assertIn("角色可随时替换，不写死品牌或模型", self.combo)

    def test_old_records_migrate_to_two_roles_without_losing_threads(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            SERVER, "COMBO_SESSIONS_FILE", str(pathlib.Path(tmp) / "combo.json")
        ):
            saved = SERVER.upsert_combo_sessions(
                [{
                    "id": "cmbs_legacy",
                    "topic": "旧组合任务",
                    "ts": 1,
                    "roles": {
                        "planner": {"provider": "moonshot", "model": "k3"},
                        "executor": {"provider": "deepseek", "model": "deepseek-v4-pro"},
                        "auditor": {"provider": "openai-codex", "model": "gpt-5.6-sol"},
                    },
                    "threads": {
                        "planner": "thr_worker",
                        "executor": "thr_operator",
                        "auditor": "thr_controller",
                    },
                    "messages": [{"id": "m1", "kind": "agent_message", "text": "保留的历史"}],
                }]
            )
            record = saved[0]
            self.assertEqual(record["threads"], {
                "controller": "thr_controller",
                "executor": "thr_worker",
            })
            self.assertEqual(record["tool_threads"], {"executor": "thr_operator"})
            self.assertEqual(record["roles"]["controller"]["provider"], "openai-codex")
            self.assertEqual(record["roles"]["executor"]["provider"], "moonshot")
            self.assertEqual(record["messages"][0]["text"], "保留的历史")
            self.assertEqual(
                SERVER.combo_thread_index()["thr_worker"]["role"], "executor"
            )

    def test_child_registration_uses_normalized_roles(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            SERVER, "COMBO_SESSIONS_FILE", str(pathlib.Path(tmp) / "combo.json")
        ):
            record = SERVER.upsert_combo_session_thread(
                "cmbs_live", "实时组合", "planner", "moonshot", "thr_live",
                roles={"planner": {"provider": "moonshot", "model": "k3"}},
            )
            self.assertIsNotNone(record)
            self.assertEqual(record["threads"]["executor"], "thr_live")
            self.assertEqual(record["roles"]["executor"]["model"], "k3")

    def test_tool_threads_and_fallback_metadata_survive_concurrent_saves(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            SERVER, "COMBO_SESSIONS_FILE", str(pathlib.Path(tmp) / "combo.json")
        ):
            SERVER.upsert_combo_sessions([{
                "id": "cmbs_tools", "topic": "工具任务", "ts": 1,
                "roles": {"executor": {"provider": "moonshot", "model": "k3", "toolProvider": "deepseek", "toolModel": "deepseek-v4-pro"}},
                "threads": {"executor": "thr_exec"},
                "tool_threads": {"executor": "thr_tools"},
            }])
            saved = SERVER.upsert_combo_sessions([{
                "id": "cmbs_tools", "topic": "工具任务", "ts": 2,
                "roles": {"controller": {"provider": "openai-codex", "model": "gpt-5.6-sol"}},
                "threads": {"controller": "thr_control"},
            }])[0]
            self.assertEqual(saved["tool_threads"]["executor"], "thr_tools")
            self.assertEqual(saved["roles"]["executor"]["toolProvider"], "deepseek")

    def test_combo_is_always_a_separate_window(self):
        opener = self.combo.split('function openComboWindow(sessionId=""){', 1)[1].split(
            "async function initComboWindow", 1
        )[0]
        self.assertIn('window.open(target,"_blank")', opener)
        self.assertNotIn("location.href=target", opener)
        self.assertIn("需要独立窗口", opener)

    def test_combo_sidebar_stays_grouped_by_session_identity(self):
        self.assertIn("function comboContextActions(s)", self.threads)
        self.assertIn("function comboSessionsForSidebar()", self.threads)
        self.assertIn('label:"组合模型"', self.threads)
        self.assertIn("归档整组组合任务", self.threads)
        self.assertIn("复制组合任务 ID", self.threads)


if __name__ == "__main__":
    unittest.main()
