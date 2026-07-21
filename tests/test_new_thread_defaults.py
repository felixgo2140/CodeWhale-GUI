from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class NewThreadDefaultTests(unittest.TestCase):
    def test_single_thread_creation_enables_shell_and_auto_approval(self):
        source = (ROOT / "web/js/threads.js").read_text(encoding="utf-8")
        start = source.index("async function createThread")
        end = source.index("async function loadAutoState", start)
        create = source[start:end]

        self.assertIn("auto_approve:true", create)
        self.assertIn("allow_shell:true", create)
        self.assertIn('method:"PATCH"', create)

    def test_existing_single_threads_keep_their_saved_flags(self):
        source = (ROOT / "web/js/stream.js").read_text(encoding="utf-8")
        start = source.index("async function openThread")
        end = source.index("function queueSnapshotEvent", start)
        opened = source[start:end]

        self.assertIn("loadAutoState(id)", opened)

    def test_new_compare_sessions_start_with_both_flags_enabled(self):
        source = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")

        self.assertIn("autoApprove:true, allowShell:true", source)
        start = source.index("async function cmpNewChat")
        end = source.index("function toggleMax", start)
        new_chat = source[start:end]
        self.assertIn("CMP.autoApprove=true", new_chat)
        self.assertIn("CMP.allowShell=true", new_chat)
        self.assertIn("renderCmpToggles()", new_chat)


if __name__ == "__main__":
    unittest.main()
