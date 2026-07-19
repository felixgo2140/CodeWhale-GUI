import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ProviderLifecycleTests(unittest.TestCase):
    def test_opening_compare_view_does_not_reset_all_backends(self):
        source = (ROOT / "web/js/compare.js").read_text(encoding="utf-8")
        open_compare = source.split("async function openCompare(){", 1)[1].split("function closeCompare()", 1)[0]

        self.assertNotIn('/api/compare/reset', open_compare)
        self.assertIn('/api/compare/ensure', open_compare)

    def test_frontend_launch_agent_preserves_provider_children(self):
        installer = (ROOT / "installer/install.sh").read_text(encoding="utf-8")
        marker = 'cat > "$LA/com.codewhale.frontend.plist" <<PLIST\n'
        frontend = installer.split(marker, 1)[1].split('\nPLIST', 1)[0]

        self.assertIn('AbandonProcessGroup', frontend)

    def test_finished_turn_recovery_requires_explicit_user_action(self):
        source = (ROOT / "web/js/stream.js").read_text(encoding="utf-8")

        self.assertNotIn("startAutomaticRecovery", source)
        self.assertNotIn("AUTO_RECOVERY_KEY", source)
        self.assertIn('b.textContent="继续执行"', source)
        self.assertIn('b.textContent="继续总结产出"', source)


if __name__ == "__main__":
    unittest.main()
