from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class MessageContextActionTests(unittest.TestCase):
    def test_shared_chat_view_owns_copy_and_selection_actions(self):
        source = (ROOT / "web/js/chat-view.js").read_text(encoding="utf-8")

        self.assertIn("function installSelectionActions", source)
        self.assertIn('event.target.closest?.(".msg.assistant .content")', source)
        self.assertIn('action("copy-message","复制整条回复","⌘⇧C")', source)
        self.assertIn('action("copy-markdown","复制为 Markdown")', source)
        self.assertIn('action("attach-context","将所选内容附加为上下文")', source)
        self.assertIn("el._cwInputSel=inputSel", source)
        self.assertIn("ensureAssistantActions(el,id)", source)

    def test_selection_context_is_inserted_as_an_editable_quote(self):
        source = (ROOT / "web/js/chat-view.js").read_text(encoding="utf-8")

        self.assertIn("function appendSelectionContext", source)
        self.assertIn("引用回复片段", source)
        self.assertIn('inp.dispatchEvent(new Event("input"))', source)

    def test_selection_menu_has_scoped_styles(self):
        source = (ROOT / "web/css/components.css").read_text(encoding="utf-8")

        self.assertIn(".message-selection-menu", source)
        self.assertIn(".message-selection-sep", source)


if __name__ == "__main__":
    unittest.main()
