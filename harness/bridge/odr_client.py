#!/usr/bin/env python3
"""LangChain Open Deep Research 桥接 — 与 deerflow_client 同契约(submit/progress/result)。

后端 = langgraph dev 服务(:2024,~/agent-harnesses/open_deep_research)。模型全配 deepseek,
搜索 Tavily(.env)。输出目录 ~/harness-output/odr/。
"""
import json
import os
import subprocess
import sys
import time

import requests

BASE = os.environ.get("ODR_BASE_URL", "http://127.0.0.1:2024")
OUT = os.path.expanduser("~/harness-output/odr")
ODR_DIR = os.path.expanduser("~/agent-harnesses/open_deep_research")

CFG = {"configurable": {
    "research_model": "deepseek:deepseek-v4-pro", "research_model_max_tokens": 8000,
    "summarization_model": "deepseek:deepseek-v4-flash", "summarization_model_max_tokens": 4000,
    "compression_model": "deepseek:deepseek-v4-flash", "compression_model_max_tokens": 4000,
    "final_report_model": "deepseek:deepseek-v4-pro", "final_report_model_max_tokens": 10000,
    "allow_clarification": False,   # API 场景不反问,直接研究
    "max_concurrent_research_units": 3, "max_researcher_iterations": 4,
    # deepseek thinking 模式不接受强制 tool_choice → 显式关(配合 deep_researcher.py 的 extra_body configurable 补丁)
    "extra_body": {"thinking": {"type": "disabled"}},
}}


def _ensure_up():
    try:
        requests.get(f"{BASE}/ok", timeout=3)
        return True
    except Exception:
        pass
    log = os.path.join(OUT, "langgraph.log")
    os.makedirs(OUT, exist_ok=True)
    subprocess.Popen(
        ["uv", "run", "langgraph", "dev", "--port", "2024", "--no-browser"],
        cwd=ODR_DIR, start_new_session=True,
        stdout=open(log, "a"), stderr=subprocess.STDOUT,
        env={**os.environ, "PATH": "/opt/homebrew/bin:" + os.environ.get("PATH", "")},
    )
    for _ in range(45):
        time.sleep(2)
        try:
            requests.get(f"{BASE}/ok", timeout=3)
            return True
        except Exception:
            continue
    return False


def cmd_submit(prompt):
    if not _ensure_up():
        print(json.dumps({"ok": False, "error": "langgraph dev(:2024) 起不来,查 ~/harness-output/odr/langgraph.log"}))
        return
    t = requests.post(f"{BASE}/threads", json={}, timeout=15).json()
    tid = t["thread_id"]
    if "中文" not in prompt:
        prompt += "\n\n(请用中文撰写完整报告)"   # felix 治理要求:研究引擎中文输出
    requests.post(f"{BASE}/threads/{tid}/runs", timeout=15, json={
        "assistant_id": "Deep Researcher",
        "input": {"messages": [{"role": "human", "content": prompt}]},
        "config": CFG,
    }).raise_for_status()
    print(json.dumps({"ok": True, "thread_id": tid}))


def _last_run_status(tid):
    rs = requests.get(f"{BASE}/threads/{tid}/runs", timeout=15).json()
    return (rs[-1].get("status") if rs else "pending") or "unknown"


def _state(tid):
    return requests.get(f"{BASE}/threads/{tid}/state", timeout=20).json()


def cmd_progress(tid):
    try:
        st = _last_run_status(tid)
        vals = (_state(tid).get("values") or {})
        msgs = vals.get("messages") or []
        tail = ""
        for m in reversed(msgs):
            c = m.get("content")
            if isinstance(c, list):
                c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
            if c and str(c).strip():
                tail = str(c)[-2000:]
                break
        if vals.get("final_report"):
            tail = str(vals["final_report"])[-2000:]
        status = {"pending": "running", "running": "running", "success": "success"}.get(st, st)
        print(json.dumps({"status": status, "tail": tail, "msg_count": len(msgs),
                          "llm_calls": 0, "in_tokens": 0, "out_tokens": 0}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"status": "pending", "error": str(e)[:200]}))


def cmd_result(tid):
    try:
        vals = (_state(tid).get("values") or {})
        report = vals.get("final_report") or ""
        if not report:
            msgs = vals.get("messages") or []
            report = str(msgs[-1].get("content", "")) if msgs else ""
        if not report:
            print(json.dumps({"ok": False, "error": "报告为空"}))
            return
        os.makedirs(OUT, exist_ok=True)
        fn = f"odr_{time.strftime('%Y%m%d-%H%M%S')}_{tid[:8]}.md"
        path = os.path.join(OUT, fn)
        with open(path, "w") as f:
            f.write("# Open Deep Research 报告\n\n---\n\n")
            f.write(report)
        print(json.dumps({"ok": True, "output": report, "file": fn, "path": path}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: odr_client.py submit <prompt> | progress|result <thread_id>")
    cmd, arg = sys.argv[1], sys.argv[2]
    {"submit": cmd_submit, "progress": cmd_progress, "result": cmd_result}[cmd](arg)


if __name__ == "__main__":
    main()
