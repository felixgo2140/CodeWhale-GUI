import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class OptionPickerDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = (ROOT / "web/js/chat-view.js").read_text(encoding="utf-8")
        handle = tempfile.NamedTemporaryFile(
            mode="w", suffix=".mjs", encoding="utf-8", delete=False
        )
        handle.write(source)
        handle.close()
        cls.module_path = Path(handle.name)

    @classmethod
    def tearDownClass(cls):
        cls.module_path.unlink(missing_ok=True)

    def run_detection(self, text):
        script = f"""
          globalThis.window = globalThis;
          const mod = await import({json.dumps(self.module_path.as_uri())});
          const result = mod.chatViewTools.detectOptions({json.dumps(text)});
          process.stdout.write(JSON.stringify(result));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_analytical_numbered_summary_is_not_treated_as_choices(self):
        text = """## 冷静版总评
1. 真正新的信息：不是「收敛/不收敛」，而是数据质量缺陷。
2. 被重组确认的事实：杠杆 ETF 日度比率存在均值回归表象。
3. 决策影响：高——它把问题从「要不要赌收敛」改为先修数据。
4. 整体信息增益：中。下一步的单一动作是拿到 NAV 后重算。"""
        self.assertIsNone(self.run_detection(text))

    def test_explicit_question_before_options_is_detected(self):
        text = """你希望我接下来做哪一项？
1. 获取 07709 NAV 并核对数据
2. 按统一口径重新计算
3. 暂时停止"""
        result = self.run_detection(text)
        self.assertEqual(
            [item["label"] for item in result],
            ["获取 07709 NAV 并核对数据", "按统一口径重新计算", "暂时停止"],
        )

    def test_explicit_request_after_options_is_detected(self):
        text = """可执行方案：
A. 修正数据源
B. 重新计算统计
请选择一个。"""
        result = self.run_detection(text)
        self.assertEqual([item["n"] for item in result], ["A", "B"])


if __name__ == "__main__":
    unittest.main()
