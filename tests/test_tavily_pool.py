import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).parents[1] / "harness" / "bridge" / "tavily_pool.py"
)
SPEC = importlib.util.spec_from_file_location("tavily_pool_under_test", MODULE_PATH)
tavily_pool = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(tavily_pool)


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.data).encode("utf-8")


class TavilyPoolTests(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.credentials = root / "credentials.json"
        self.state = root / "state.json"
        self.credentials.write_text(
            json.dumps({"keys": ["slot-one", "slot-two"]}),
            encoding="utf-8",
        )
        self.credentials_patch = mock.patch.object(
            tavily_pool,
            "CREDENTIALS_FILE",
            self.credentials,
        )
        self.state_patch = mock.patch.object(
            tavily_pool,
            "STATE_FILE",
            self.state,
        )
        self.credentials_patch.start()
        self.state_patch.start()

    def tearDown(self):
        self.state_patch.stop()
        self.credentials_patch.stop()
        self.tempdir.cleanup()

    def test_search_rotates_after_quota_error(self):
        quota_error = tavily_pool.urllib.error.HTTPError(
            "https://api.tavily.com/search",
            429,
            "rate limited",
            {},
            None,
        )
        with mock.patch.object(
            tavily_pool.urllib.request,
            "urlopen",
            side_effect=[
                quota_error,
                FakeResponse({"results": [{"title": "ok"}]}),
            ],
        ) as urlopen:
            result = tavily_pool.tavily_search_json({"query": "test"})

        self.assertEqual(result["results"][0]["title"], "ok")
        self.assertEqual(urlopen.call_count, 2)
        state_text = self.state.read_text(encoding="utf-8")
        self.assertNotIn("slot-one", state_text)
        self.assertNotIn("slot-two", state_text)

    def test_select_skips_a_cooled_slot(self):
        first_hash = tavily_pool._fingerprint("slot-one")
        self.state.write_text(
            json.dumps(
                {
                    "cursor": 0,
                    "cooldowns": {first_hash: 9999999999},
                }
            ),
            encoding="utf-8",
        )

        self.assertEqual(tavily_pool.select_tavily_key(), "slot-two")

    def test_preferred_key_is_stable_and_skips_cooldown(self):
        self.assertEqual(tavily_pool.preferred_tavily_key(), "slot-one")
        first_hash = tavily_pool._fingerprint("slot-one")
        self.state.write_text(
            json.dumps(
                {
                    "cursor": 1,
                    "cooldowns": {first_hash: 9999999999},
                }
            ),
            encoding="utf-8",
        )

        self.assertEqual(tavily_pool.preferred_tavily_key(), "slot-two")


if __name__ == "__main__":
    unittest.main()
