#!/usr/bin/env python3
"""browser-use bridge for CodeWhale GUI."""
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_llm import looks_placeholder, now_stamp, openai_spec, redact, write_json

VENV_PY = os.path.expanduser("~/agent-harnesses/browseruse-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/browseruse")
JOBS = os.path.join(OUT, "jobs")


def _job_path(jid):
    return os.path.join(JOBS, f"{jid}.json")


def _load_job(jid):
    with open(_job_path(jid), errors="replace") as f:
        return json.load(f)


def _save_job(job):
    write_json(_job_path(job["id"]), job)


def _hist_value(history, name, default=None):
    try:
        val = getattr(history, name)
        return val() if callable(val) else val
    except Exception:
        return default


def _make_llm(model):
    from browser_use import ChatOpenAI

    key, base, mdl, label = openai_spec(model)
    if looks_placeholder(key):
        raise RuntimeError(f"{label} API key 未配置或还是占位符")
    return ChatOpenAI(
        model=mdl,
        api_key=key,
        base_url=base,
        temperature=0.1,
        max_completion_tokens=4096,
        timeout=90,
        dont_force_structured_output=True,
        add_schema_to_system_prompt=True,
    ), label, mdl


def _report(job, history):
    final = _hist_value(history, "final_result", "") or ""
    urls = _hist_value(history, "urls", []) or []
    actions = _hist_value(history, "action_names", []) or []
    extracts = _hist_value(history, "extracted_content", []) or []
    errors = [e for e in (_hist_value(history, "errors", []) or []) if e]
    steps = _hist_value(history, "number_of_steps", 0) or 0
    duration = _hist_value(history, "total_duration_seconds", 0) or 0
    lines = [
        "# browser-use 网页操作报告",
        "",
        f"- **任务**: {job['query'][:240]}",
        f"- **LLM**: {job.get('model_label') or ''} · {job.get('provider_model') or job.get('model') or ''}",
        f"- **步骤**: {steps}",
        f"- **耗时**: {duration:.1f}s" if isinstance(duration, (int, float)) else f"- **耗时**: {duration}",
        "",
        "---",
        "",
        "## 结论",
        str(final).strip() or "(browser-use 未返回最终结论)",
    ]
    if urls:
        lines += ["", "## 访问 URL"]
        lines += [f"- {u}" for u in urls[:30]]
    if actions:
        lines += ["", "## 动作轨迹"]
        lines += [f"- {a}" for a in actions[:80]]
    if extracts:
        lines += ["", "## 页面摘录"]
        for i, text in enumerate(extracts[:12], 1):
            s = str(text or "").strip()
            if s:
                lines += [f"### E{i}", s[:1800]]
    if errors:
        lines += ["", "## 错误/限制"]
        lines += [f"- {redact(e)}" for e in errors[:20] if e]
    return "\n".join(lines).strip() + "\n"


def cmd_submit(prompt, model=""):
    os.makedirs(JOBS, exist_ok=True)
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "query": prompt, "model": model, "started": time.time(), "stage": "queued"}
    _save_job(job)
    py = VENV_PY if os.path.exists(VENV_PY) else sys.executable
    subprocess.Popen(
        [py, os.path.abspath(__file__), "run", jid],
        start_new_session=True,
        stdout=open(os.path.join(JOBS, f"{jid}.log"), "w"),
        stderr=subprocess.STDOUT,
    )
    print(json.dumps({"ok": True, "thread_id": jid}, ensure_ascii=False))


def cmd_run(jid):
    job = _load_job(jid)
    profile_dir = os.path.join(OUT, "profiles", jid)
    try:
        from browser_use import Agent, BrowserSession

        llm, label, mdl = _make_llm(job.get("model", ""))
        job["stage"] = "running browser-use"
        job["model_label"] = label
        job["provider_model"] = mdl
        _save_job(job)
        task = (
            job["query"].strip()
            + "\n\n请用浏览器完成任务,不要登录、不要输入密码/密钥、不要提交表单或购买。"
            + "最终用简体中文输出:结论、证据、访问过的 URL、限制。"
        )
        shutil.rmtree(profile_dir, ignore_errors=True)
        os.makedirs(profile_dir, exist_ok=True)
        session = BrowserSession(
            headless=True,
            user_data_dir=profile_dir,
            viewport={"width": 1280, "height": 900},
            minimum_wait_page_load_time=1.0,
            wait_for_network_idle_page_load_time=2.0,
            enable_default_extensions=False,
        )
        agent = Agent(
            task=task,
            llm=llm,
            browser_session=session,
            use_vision=False,
            enable_planning=True,
            max_actions_per_step=4,
            step_timeout=120,
            use_judge=False,
        )
        max_steps = int(os.environ.get("BROWSERUSE_MAX_STEPS", "18"))
        history = agent.run_sync(max_steps=max_steps)
        md = _report(job, history)
        fn = f"browseruse_{now_stamp()}_{jid}.md"
        path = os.path.join(OUT, fn)
        os.makedirs(OUT, exist_ok=True)
        with open(path, "w") as f:
            f.write(md)
        job.update(status="success", file=fn, path=path, stage="done", updated=time.time())
    except Exception as e:
        job.update(status="error", error=redact(str(e))[:1500], stage="error", updated=time.time())
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)
    _save_job(job)


def cmd_progress(jid):
    if not os.path.exists(_job_path(jid)):
        print(json.dumps({"status": "error", "error": f"job 不存在: {jid}"}, ensure_ascii=False))
        return
    try:
        job = _load_job(jid)
    except Exception as e:
        print(json.dumps({"status": "error", "error": "job 文件读取失败: " + redact(str(e))[:300]}, ensure_ascii=False))
        return
    tail, nlines = "", 0
    try:
        log = open(os.path.join(JOBS, f"{jid}.log"), errors="replace").read()
        tail = redact(log[-3000:])
        nlines = len([l for l in log.splitlines() if l.strip()])
    except Exception:
        pass
    out = {
        "status": job.get("status", "unknown"),
        "tail": tail or job.get("stage", ""),
        "msg_count": nlines,
        "llm_calls": 0,
        "in_tokens": 0,
        "out_tokens": 0,
    }
    if job.get("error"):
        out["error"] = redact(job["error"])
    print(json.dumps(out, ensure_ascii=False))


def cmd_result(jid):
    try:
        job = _load_job(jid)
    except Exception:
        print(json.dumps({"ok": False, "error": "job 不存在"}, ensure_ascii=False))
        return
    if job.get("path") and os.path.exists(job["path"]):
        print(json.dumps({
            "ok": True,
            "output": open(job["path"], errors="replace").read(),
            "file": job.get("file"),
            "path": job.get("path"),
        }, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": redact(job.get("error") or "无结果")}, ensure_ascii=False))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: browseruse_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine|qwen] | run|progress|result <job_id>")
    cmd, arg = sys.argv[1], sys.argv[2]
    model = ""
    if "--model" in sys.argv:
        i = sys.argv.index("--model")
        if i + 1 < len(sys.argv):
            model = sys.argv[i + 1]
    if "-m" in sys.argv:
        i = sys.argv.index("-m")
        if i + 1 < len(sys.argv):
            model = sys.argv[i + 1]
    if cmd == "submit":
        cmd_submit(arg, model)
    else:
        {"run": cmd_run, "progress": cmd_progress, "result": cmd_result}[cmd](arg)


if __name__ == "__main__":
    main()
