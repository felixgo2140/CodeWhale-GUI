#!/usr/bin/env python3
"""CrewAI multi-role research bridge for CodeWhale GUI."""
import json
import os
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_llm import chat, looks_placeholder, now_stamp, openai_spec, redact, tavily_search, write_json

VENV_PY = os.path.expanduser("~/agent-harnesses/crewai-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/crewai")
JOBS = os.path.join(OUT, "jobs")


def _job_path(jid):
    return os.path.join(JOBS, f"{jid}.json")


def _load_job(jid):
    with open(_job_path(jid), errors="replace") as f:
        return json.load(f)


def _save_job(job):
    write_json(_job_path(job["id"]), job)


def _bump(job, meta):
    job["llm_calls"] = int(job.get("llm_calls") or 0) + 1
    job["in_tokens"] = int(job.get("in_tokens") or 0) + int(meta.get("in_tokens") or 0)
    job["out_tokens"] = int(job.get("out_tokens") or 0) + int(meta.get("out_tokens") or 0)
    job["model_label"] = meta.get("label") or job.get("model_label") or ""
    job["provider_model"] = meta.get("model") or job.get("provider_model") or ""
    _save_job(job)


def _queries(job):
    content, meta = chat([
        {"role": "system", "content": "你是研究总监。只输出 JSON。"},
        {"role": "user", "content": (
            "为下面课题生成 4-6 条联网搜索 query,覆盖事实、正方、反方、最新进展。"
            "返回 JSON: {\"queries\":[...]}。\n\n" + job["query"]
        )},
    ], job.get("model", ""), temperature=0.1, max_tokens=1400)
    _bump(job, meta)
    try:
        import re
        m = re.search(r"\{[\s\S]*\}", content)
        qs = json.loads(m.group(0)).get("queries") if m else []
    except Exception:
        qs = []
    return (qs or [job["query"], f"{job['query']} 最新 来源", f"{job['query']} 风险 反方观点"])[:5]


def _sources_md(sources):
    out = []
    for i, s in enumerate(sources, 1):
        out.append(
            f"[S{i}] {s.get('title') or 'source'}\n"
            f"URL: {s.get('url') or ''}\n"
            f"摘要: {(s.get('content') or '')[:1000]}"
        )
    return "\n\n".join(out)


def _collect_sources(job):
    job["stage"] = "1/3 生成搜索 query"
    _save_job(job)
    queries = _queries(job)
    job["stage"] = "2/3 Tavily 搜索"
    _save_job(job)
    sources, seen = [], set()
    for q in queries:
        print("search: " + q, flush=True)
        for src in tavily_search(q, max_results=3):
            key = src.get("url") or src.get("title")
            if key in seen:
                continue
            seen.add(key)
            sources.append(src)
    job["msg_count"] = len(sources)
    _save_job(job)
    return sources[:12]


def _make_llm(job):
    from crewai import LLM

    key, base, mdl, label = openai_spec(job.get("model", ""))
    if looks_placeholder(key):
        raise RuntimeError(f"{label} API key 未配置或还是占位符")
    os.environ["OPENAI_API_KEY"] = key
    os.environ["OPENAI_API_BASE"] = base
    os.environ["OPENAI_BASE_URL"] = base
    job["model_label"] = label
    job["provider_model"] = mdl
    _save_job(job)
    return LLM(model=mdl, api_key=key, api_base=base, max_tokens=4500, temperature=0.2, timeout=120)


def _run_crewai(job, sources):
    from crewai import Agent, Crew, Process, Task

    llm = _make_llm(job)
    src_md = _sources_md(sources)
    base_goal = "只基于给定来源和合理推理,不要编造来源之外的数字。所有关键事实引用 [S数字]。"

    fact = Agent(
        role="事实研究员",
        goal="提取可验证事实、时间点、数字、来源和不确定性。",
        backstory="你谨慎、讨厌空泛结论,优先整理证据。",
        llm=llm,
        verbose=False,
        max_iter=2,
    )
    bull = Agent(
        role="正方/多头分析师",
        goal="提出最强正方论据,说明哪些证据支持乐观判断。",
        backstory="你会寻找增长、催化剂、结构性优势,但不能忽略来源限制。",
        llm=llm,
        verbose=False,
        max_iter=2,
    )
    bear = Agent(
        role="反方/空头分析师",
        goal="提出最强反方论据,寻找估值、竞争、执行、监管和数据缺口风险。",
        backstory="你负责拆台和防止过度乐观。",
        llm=llm,
        verbose=False,
        max_iter=2,
    )
    editor = Agent(
        role="总编",
        goal="综合事实、正方和反方,输出清晰、有引用、可行动的中文报告。",
        backstory="你负责最终判断、置信度和观察清单。",
        llm=llm,
        verbose=False,
        max_iter=2,
    )

    t_fact = Task(
        description=f"课题:\n{job['query']}\n\n来源:\n{src_md}\n\n{base_goal}\n输出事实表、来源质量、缺口。",
        expected_output="简明事实清单、关键数字/时间点、来源质量和缺口。",
        agent=fact,
        markdown=True,
    )
    t_bull = Task(
        description=f"课题:\n{job['query']}\n\n来源:\n{src_md}\n\n{base_goal}\n输出 3-5 条最强正方/多头论据。",
        expected_output="3 条以内最强正方论据、证据引用、触发条件。",
        agent=bull,
        context=[t_fact],
        markdown=True,
    )
    t_bear = Task(
        description=f"课题:\n{job['query']}\n\n来源:\n{src_md}\n\n{base_goal}\n输出 3-5 条最强反方/空头论据。",
        expected_output="3 条以内最强反方论据、证据引用、风险触发条件。",
        agent=bear,
        context=[t_fact],
        markdown=True,
    )
    t_final = Task(
        description=(
            f"课题:\n{job['query']}\n\n请综合前面三位 agent 的输出,形成最终中文报告。"
            "必须包含:执行摘要、事实表、正方、反方、关键分歧、未来观察清单、结论和置信度。全文控制在 1800 中文字以内。"
        ),
        expected_output="可直接阅读的 Markdown 报告,含引用和来源列表。",
        agent=editor,
        context=[t_fact, t_bull, t_bear],
        markdown=True,
    )
    crew = Crew(
        agents=[fact, bull, bear, editor],
        tasks=[t_fact, t_bull, t_bear, t_final],
        process=Process.sequential,
        verbose=False,
        memory=False,
    )
    result = crew.kickoff()
    text = getattr(result, "raw", None) or str(result)
    usage = getattr(crew, "usage_metrics", None) or getattr(result, "token_usage", None)
    if usage:
        try:
            job["in_tokens"] = int(job.get("in_tokens") or 0) + int(getattr(usage, "prompt_tokens", 0) or 0)
            job["out_tokens"] = int(job.get("out_tokens") or 0) + int(getattr(usage, "completion_tokens", 0) or 0)
        except Exception:
            pass
    return text


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
    try:
        sources = _collect_sources(job)
        job["stage"] = "3/3 CrewAI 多角色研究"
        _save_job(job)
        report = _run_crewai(job, sources)
        lines = [
            "# CrewAI 多角色研究报告",
            "",
            f"- **课题**: {job['query'][:240]}",
            f"- **LLM**: {job.get('model_label') or ''} · {job.get('provider_model') or job.get('model') or ''}",
            "- **流程**: search → fact agent → bull agent → bear agent → editor",
            "",
            "---",
            "",
            report.strip(),
            "",
            "## 来源",
        ]
        for i, s in enumerate(sources, 1):
            lines.append(f"- [S{i}] {s.get('title') or 'source'} — {s.get('url') or ''}")
        fn = f"crewai_{now_stamp()}_{jid}.md"
        path = os.path.join(OUT, fn)
        os.makedirs(OUT, exist_ok=True)
        with open(path, "w") as f:
            f.write("\n".join(lines).strip() + "\n")
        job.update(status="success", file=fn, path=path, stage="done", updated=time.time())
    except Exception as e:
        job.update(status="error", error=redact(str(e))[:1500], stage="error", updated=time.time())
    _save_job(job)


def cmd_progress(jid):
    try:
        job = _load_job(jid)
    except Exception:
        print(json.dumps({"status": "pending"}, ensure_ascii=False))
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
        "msg_count": job.get("msg_count") or nlines,
        "llm_calls": job.get("llm_calls", 0),
        "in_tokens": job.get("in_tokens", 0),
        "out_tokens": job.get("out_tokens", 0),
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
        sys.exit("用法: crewai_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine] | run|progress|result <job_id>")
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
