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

    def test_sidebar_uses_one_overflow_button_per_thread(self):
        source = (ROOT / "web/js/threads.js").read_text(encoding="utf-8")

        self.assertIn('class="act more"', source)
        self.assertNotIn('class="act rename"', source)
        self.assertNotIn('class="act cron', source)
        self.assertNotIn('class="act pin"', source)
        self.assertNotIn('class="act del"', source)

    def test_appserver_discards_animation_stdout_and_keeps_stderr(self):
        installer = (ROOT / "installer/install.sh").read_text(encoding="utf-8")
        marker = 'cat > "$LA/com.codewhale.appserver.plist" <<PLIST\n'
        appserver = installer.split(marker, 1)[1].split('\nPLIST', 1)[0]

        self.assertIn('<string>/dev/null</string>', appserver)
        self.assertIn('app-server.err.log', appserver)
        self.assertNotIn('app-server.log', appserver)

    def test_native_shell_recovers_web_content_without_quitting_on_close(self):
        source = (ROOT / "native/main.swift").read_text(encoding="utf-8")

        self.assertIn('webViewWebContentProcessDidTerminate', source)
        self.assertIn('applicationShouldTerminateAfterLastWindowClosed', source)
        self.assertIn('return false', source.split('applicationShouldTerminateAfterLastWindowClosed', 1)[1].split('}', 1)[0])

    def test_harness_progress_is_bounded_in_server_and_ui(self):
        server = (ROOT / "server.py").read_text(encoding="utf-8")
        panels = (ROOT / "web/js/panels.js").read_text(encoding="utf-8")

        self.assertIn('def _clamp_research_progress', server)
        self.assertIn('RESEARCH_PROGRESS_MAX_CHARS=24000', panels)

    def test_finished_turn_recovery_requires_explicit_user_action(self):
        source = (ROOT / "web/js/stream.js").read_text(encoding="utf-8")

        self.assertNotIn("startAutomaticRecovery", source)
        self.assertNotIn("AUTO_RECOVERY_KEY", source)
        self.assertIn('b.textContent="继续执行"', source)
        self.assertIn('b.textContent="继续总结产出"', source)

    def test_claude_provider_discovers_desktop_cli_and_rejects_false_health(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")

        self.assertIn("def _discover_claude_cli", source)
        self.assertIn("Application Support/Claude/claude-code", source)
        self.assertIn("def _claude_runtime_has_cli", source)
        self.assertIn('provider == "claude-code" and not _claude_runtime_has_cli(pid)', source)


if __name__ == "__main__":
    unittest.main()
