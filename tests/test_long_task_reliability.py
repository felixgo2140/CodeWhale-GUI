import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVER = load_module("codewhale_server_reliability", ROOT / "server.py")
GPTR = load_module("codewhale_gptr_bridge", ROOT / "harness/bridge/gptr_client.py")


class RuntimeFixture:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        for kind in ("threads", "turns", "items"):
            (self.root / kind).mkdir(parents=True, exist_ok=True)
        (self.root / "state.json").write_text('{"next_seq": 1}', encoding="utf-8")

    def write(self, kind, obj):
        (self.root / kind / f"{obj['id']}.json").write_text(json.dumps(obj), encoding="utf-8")


class LongTaskReliabilityTests(unittest.TestCase):
    def test_emergency_compaction_that_leaves_91_percent_triggers_preflight(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(SERVER, "RUNTIME_DIR", tmp):
            fx = RuntimeFixture(tmp)
            fx.write("threads", {"id": "thr_demo", "model": "hy3-preview"})
            fx.write("items", {
                "id": "item_compact", "kind": "context_compaction",
                "summary": "Emergency compaction complete: 74 → 72 messages (2 removed), ~123923 → ~119649 tokens",
            })
            fx.write("turns", {
                "id": "turn_compact", "thread_id": "thr_demo", "created_at": "2026-07-18T20:00:00+00:00",
                "status": "completed", "item_ids": ["item_compact"],
            })
            fx.write("turns", {
                "id": "turn_work", "thread_id": "thr_demo", "created_at": "2026-07-18T20:01:00+00:00",
                "status": "completed", "input_summary": "继续", "item_ids": [],
            })

            risk = SERVER.thread_context_risk("thr_demo")

        self.assertTrue(risk["needs_compaction"])
        self.assertEqual(risk["estimated_tokens"], 119649)
        self.assertGreater(risk["pressure"], 0.91)

    def test_generated_report_is_recovered_even_when_final_reply_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(SERVER, "RUNTIME_DIR", tmp):
            fx = RuntimeFixture(tmp)
            report = pathlib.Path(tmp) / "promise-ledger.md"
            report.write_text("# report", encoding="utf-8")
            fx.write("threads", {"id": "thr_demo", "model": "hy3-preview"})
            fx.write("items", {
                "id": "item_file", "kind": "file_change",
                "summary": f"write_file completed: {report}",
            })
            fx.write("turns", {
                "id": "turn_demo", "thread_id": "thr_demo", "created_at": "2026-07-18T20:00:00+00:00",
                "ended_at": "2026-07-18T20:10:00+00:00", "status": "completed",
                "input_summary": "生成报告", "item_ids": ["item_file"],
            })

            result = SERVER.thread_artifacts("thr_demo", "turn_demo")

        self.assertEqual([row["name"] for row in result["files"]], ["promise-ledger.md"])

    def test_frontend_compacts_before_sending_and_reconciles_artifacts(self):
        source = (ROOT / "web/js/stream.js").read_text(encoding="utf-8")
        send_body = source.split("async function send(queuedText){", 1)[1].split("function enterSend()", 1)[0]

        self.assertIn("await ensureContextCapacityBeforeSend()", send_body)
        self.assertIn("/api/thread-context-risk", source)
        self.assertIn("/api/thread-artifacts", source)
        self.assertIn("dedupeVisibleFileCards", source)
        self.assertIn('b.endsWith(homeA)', source)
        self.assertNotIn("startAutomaticRecovery", source)

    def test_gptr_k3_jobs_are_atomic_and_process_aware(self):
        self.assertEqual(GPTR._model_key("k3"), "kimi")
        self.assertTrue(GPTR._pid_alive(os.getpid()))
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "job.json"
            GPTR._atomic_write_json(str(path), {"status": "running"})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["status"], "running")

    def test_stale_harness_job_becomes_an_explicit_error(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            SERVER._HARNESS, {"gptr": {**SERVER._HARNESS["gptr"], "outdir": tmp}}
        ):
            jobs = pathlib.Path(tmp) / "jobs"
            jobs.mkdir()
            job = jobs / "stale-job.json"
            job.write_text(json.dumps({"id": "stale-job", "status": "running"}), encoding="utf-8")
            os.utime(job, (1, 1))

            result = SERVER._reconcile_harness_progress(
                "gptr", "stale-job", {"ok": True, "status": "running"}, stale_seconds=1
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertIn("没有进度", result["error"])

    def test_frontend_does_not_mark_empty_harness_delivery_as_success(self):
        source = (ROOT / "web/js/panels.js").read_text(encoding="utf-8")
        self.assertIn('status:"delivery_missing"', source)
        self.assertIn("完成但未交付产出", source)


if __name__ == "__main__":
    unittest.main()
