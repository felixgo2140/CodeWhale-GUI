#!/usr/bin/env python3
"""GPT Researcher 桥接 — 与 deerflow_client 同契约(submit/progress/result),供 CodeWhale GUI 调用。

任务模型:无常驻服务。submit 写 job 文件 + 起脱管子进程跑研究;progress 读 job 状态 + 日志尾;
result 读报告文件。输出目录 ~/harness-output/gptr/。
"""
import json
import os
import subprocess
import sys
import time
import uuid

VENV_PY = os.path.expanduser("~/agent-harnesses/gptr-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/gptr")
JOBS = os.path.join(OUT, "jobs")
ENVFILE = os.path.expanduser("~/agent-harnesses/gptr.env")


def _load_env():
    # 强制覆盖(不能 setdefault):宿主 shell 可能已有别家 OPENAI_API_KEY,会让 deepseek 调用 401
    for ln in open(ENVFILE):
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            os.environ[k] = v


def cmd_submit(prompt):
    os.makedirs(JOBS, exist_ok=True)
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "query": prompt, "started": time.time()}
    json.dump(job, open(f"{JOBS}/{jid}.json", "w"), ensure_ascii=False)
    subprocess.Popen(
        [VENV_PY, os.path.abspath(__file__), "run", jid],
        start_new_session=True,
        stdout=open(f"{JOBS}/{jid}.log", "w"),
        stderr=subprocess.STDOUT,
    )
    print(json.dumps({"ok": True, "thread_id": jid}))


def cmd_run(jid):
    _load_env()
    import asyncio

    job = json.load(open(f"{JOBS}/{jid}.json"))
    try:
        from gpt_researcher import GPTResearcher

        async def go():
            r = GPTResearcher(query=job["query"], report_type="research_report")
            await r.conduct_research()
            report = await r.write_report()
            return report, r

        report, r = asyncio.run(go())
        fn = f"gptr_{time.strftime('%Y%m%d-%H%M%S')}_{jid}.md"
        path = os.path.join(OUT, fn)
        with open(path, "w") as f:
            f.write(f"# GPT Researcher 深度研究报告\n\n- **课题**: {job['query'][:200]}\n\n---\n\n")
            f.write(report)
        costs = 0
        try:
            costs = r.get_costs()
        except Exception:
            pass
        srcs = 0
        try:
            srcs = len(r.visited_urls or [])
        except Exception:
            pass
        job.update(status="success", file=fn, path=path, costs=costs, sources=srcs)
    except Exception as e:
        job.update(status="error", error=str(e)[:500])
    json.dump(job, open(f"{JOBS}/{jid}.json", "w"), ensure_ascii=False)


def cmd_progress(jid):
    try:
        job = json.load(open(f"{JOBS}/{jid}.json"))
    except Exception:
        print(json.dumps({"status": "pending"}))
        return
    tail, nlines = "", 0
    try:
        log = open(f"{JOBS}/{jid}.log", errors="replace").read()
        tail = log[-2000:]
        nlines = len([l for l in log.splitlines() if l.strip()])
    except Exception:
        pass
    out = {"status": job.get("status", "unknown"), "tail": tail, "msg_count": nlines,
           "llm_calls": 0, "in_tokens": 0, "out_tokens": 0}
    if job.get("error"):
        out["error"] = job["error"]
    if job.get("sources"):
        out["msg_count"] = job["sources"]
    print(json.dumps(out, ensure_ascii=False))


def cmd_result(jid):
    try:
        job = json.load(open(f"{JOBS}/{jid}.json"))
    except Exception:
        print(json.dumps({"ok": False, "error": "job 不存在"}))
        return
    if job.get("path") and os.path.exists(job["path"]):
        print(json.dumps({"ok": True, "output": open(job["path"], errors="replace").read(),
                          "file": job.get("file"), "path": job.get("path")}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": job.get("error") or "无结果"}, ensure_ascii=False))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: gptr_client.py submit <prompt> | run|progress|result <job_id>")
    cmd, arg = sys.argv[1], sys.argv[2]
    {"submit": cmd_submit, "run": cmd_run, "progress": cmd_progress, "result": cmd_result}[cmd](arg)


if __name__ == "__main__":
    main()
