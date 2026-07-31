from pathlib import Path
import json
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AgentEnvelopeSplitTests(unittest.TestCase):
    def run_split(self, text):
        script = f"""
          import {{ splitAgentEnvelope }} from {json.dumps((ROOT / "web/js/chat-view.js").as_uri())};
          process.stdout.write(JSON.stringify(splitAgentEnvelope({json.dumps(text)})));
        """
        result = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_splits_explicit_think_block(self):
        result = self.run_split("<think>private reasoning</think>\n这是给用户看的最终回答。")
        self.assertTrue(result["matched"])
        self.assertEqual(result["reason"], "private reasoning")
        self.assertEqual(result["answer"], "这是给用户看的最终回答。")

    def test_splits_leaked_english_reasoning_from_chinese_delivery(self):
        reasoning = (
            "The user asks for a grounded explanation. "
            + "I need to inspect the available evidence carefully. " * 25
            + "Let me write the answer. No more tool calls are needed. "
        )
        answer = "下面是最终结论。" + "这部分是面向用户的中文交付内容，保留完整结构和依据。" * 8
        result = self.run_split(reasoning + answer)
        self.assertTrue(result["matched"])
        self.assertIn("The user asks", result["reason"])
        self.assertEqual(result["answer"], answer)

    def test_keeps_normal_answer_unchanged(self):
        text = "下面是最终结论。\n\n- 第一项\n- 第二项"
        result = self.run_split(text)
        self.assertFalse(result["matched"])
        self.assertEqual(result["answer"], text)

    def test_keeps_short_transition_message_unchanged(self):
        text = (
            "The user asks for a check. "
            + "I should verify the exact command before answering. " * 12
            + "Let me check the file. 我先核验一下。"
        )
        result = self.run_split(text)
        self.assertFalse(result["matched"])
        self.assertEqual(result["answer"], text)


if __name__ == "__main__":
    unittest.main()
