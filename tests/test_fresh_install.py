import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class FreshInstallTests(unittest.TestCase):
    def test_installer_uses_a_user_local_pinned_cli_without_sudo(self):
        source = (ROOT / "installer" / "install.sh").read_text(encoding="utf-8")

        self.assertIn('REQUIRED_CLI_VERSION="${CODEWHALE_CLI_VERSION:-0.9.0}"', source)
        self.assertIn('npm install --prefix "$CLI_PREFIX"', source)
        self.assertNotIn("sudo npm install", source)
        self.assertNotIn("npm install -g", source)

    def test_reinstall_preserves_existing_mcp_and_token(self):
        source = (ROOT / "installer" / "install.sh").read_text(encoding="utf-8")

        self.assertIn('servers.setdefault("fetch"', source)
        self.assertIn('servers.setdefault("playwright"', source)
        self.assertNotIn('cat > "$HOME/.codewhale/mcp.json"', source)
        self.assertIn('[ -s "$HOME/.codewhale-gui/token" ] ||', source)

    def test_double_click_installer_reports_failure(self):
        source = (ROOT / "installer" / "install.command").read_text(encoding="utf-8")

        self.assertIn("if bash install.sh; then", source)
        self.assertIn("安装失败", source)
        self.assertIn('exit "$code"', source)

    def test_release_runs_isolated_installer_verification(self):
        publish = (ROOT / "publish-release.sh").read_text(encoding="utf-8")
        verify = (ROOT / "verify-release.sh").read_text(encoding="utf-8")

        self.assertIn('"$HERE/verify-release.sh" "$OUT/codewhale-installer.tar.gz"', publish)
        self.assertIn("CODEWHALE_INSTALL_TEST=1", verify)
        self.assertIn("custom-existing-server", verify)
        self.assertIn("codesign --verify --deep --strict", verify)
        self.assertIn("CODEWHALE_RELEASE_VERIFY=1", verify)


if __name__ == "__main__":
    unittest.main()
