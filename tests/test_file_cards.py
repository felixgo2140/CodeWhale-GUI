from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class FileCardTests(unittest.TestCase):
    def test_file_cards_require_backend_existence_check(self):
        source = (ROOT / "web/js/tools.js").read_text(encoding="utf-8")
        start = source.index("function appendFileDownloadCards")
        end = source.index("const pdfPathsFromText", start)
        renderer = source[start:end]

        self.assertIn("async function verifiedFileCardPath", source)
        self.assertIn('const q=`/api/file/stat?path=', source)
        self.assertNotIn("paths.forEach(p=>addCard(p))", renderer)
        self.assertIn("const verified=await verifiedFileCardPath(p)", renderer)
        self.assertIn("const verified=await verifiedFileCardPath(rel,ws)", renderer)

    def test_file_stat_endpoint_uses_safe_download_policy(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        start = source.index('if p == "/api/file/stat"')
        endpoint = source[start : start + 700]

        self.assertIn("target = _safe_download_file(raw)", endpoint)
        self.assertIn('"exists": bool(target)', endpoint)


if __name__ == "__main__":
    unittest.main()
