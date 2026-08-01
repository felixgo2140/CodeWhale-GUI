import pathlib
import unittest
from unittest import mock

import server


ROOT = pathlib.Path(__file__).resolve().parents[1]


class GuiUpdateNoticeTests(unittest.TestCase):
    def test_newer_signed_manifest_is_reported_as_available(self):
        with mock.patch.object(server, "_gui_version", return_value="2.9.3"), \
             mock.patch.object(server, "_update_cfg", return_value={"repo": "example/repo"}), \
             mock.patch.object(server, "_get_manifest", return_value={
                 "version": "2.9.4", "notes": "首页更新提示修复"
             }):
            result = server.gui_update_check()

        self.assertTrue(result["available"])
        self.assertEqual(result["current"], "2.9.3")
        self.assertEqual(result["latest"], "2.9.4")

    def test_invalid_manifest_signature_returns_a_visible_error(self):
        with mock.patch.object(server, "_gui_version", return_value="2.9.3"), \
             mock.patch.object(server, "_update_cfg", return_value={"repo": "example/repo"}), \
             mock.patch.object(server, "_get_manifest", side_effect=server.InvalidSignature()):
            result = server.gui_update_check()

        self.assertEqual(result["error"], "发布清单签名无效")

    def test_homepage_has_a_persistent_gui_update_notice(self):
        index = (ROOT / "web/index.html").read_text(encoding="utf-8")
        css = (ROOT / "web/css/components.css").read_text(encoding="utf-8")
        panels = (ROOT / "web/js/panels.js").read_text(encoding="utf-8")
        main = (ROOT / "web/js/main.js").read_text(encoding="utf-8")

        self.assertIn('id="guiUpdateNotice"', index)
        self.assertIn('id="guiUpdateNoticeBtn"', index)
        self.assertIn("#guiUpdateNotice[hidden]", css)
        self.assertIn("renderGuiUpdateNotice(d);", panels)
        self.assertIn("CodeWhale GUI ${d.latest} 可用", panels)
        self.assertIn('title.textContent="GUI 更新检查失败"', panels)
        self.assertIn('guiUpdateNoticeBtn.onclick=openGuiUpdate', main)
        self.assertIn('renderUpdateCenter($("#modalBody"),"gui")', panels)


if __name__ == "__main__":
    unittest.main()
