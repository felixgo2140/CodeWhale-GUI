#!/usr/bin/env python3
"""Pydantic AI structured research bridge for CodeWhale GUI."""
import json
import os
import subprocess
import sys
import time
import uuid
from typing import List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_llm import chat, now_stamp, openai_spec, redact, tavily_search, write_json

VENV_PY = os.path.expanduser("~/agent-harnesses/pydai-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/pydai")
JOBS = os.path.join(OUT, "jobs")


def _job_path(jid):
    return os.path.join(JOBS, f"{jid}.json")


def _load_job(jid):
    with open(_job_path(jid), errors="replace") as f:
        return json.load(f)


def _save_job(job):
    write_json(_job_path(job["id"]), job)


def _sources_md(sources):
    lines = []
    for i, src in enumerate(sources, 1):
        lines.append(f"[S{i}] {src.get('title') or 'source'}\nURL: {src.get('url') or ''}\n摘要: {(src.get('content') or '')[:900]}")
    return "\n\n".join(lines)


def _queries(prompt, model):
    content, meta = chat([
        {"role": "system", "content": "你是研究助理。只输出 JSON。"},
        {"role": "user", "content": (
            "为下面研究课题生成 4-6 条 Tavily 搜索 query。返回 JSON: {\"queries\":[...]}。\n\n" + prompt
        )},
    ], model, temperature=0.1, max_tokens=1800)
    qs = []
    try:
        import re
        m = re.search(r"\{[\s\S]*\}", content)
        if m:
            qs = json.loads(m.group(0)).get("queries") or []
    except Exception:
        pass
    if not qs:
        qs = [prompt, f"{prompt} 最新 数据 来源", f"{prompt} 风险 竞争格局"]
    return qs[:6], meta


def _run_pydantic_ai(job, sources):
    from pydantic import BaseModel, Field
    from pydantic_ai import Agent
    try:
        from pydantic_ai import PromptedOutput
    except Exception:
        PromptedOutput = None
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    class Finding(BaseModel):
        title: str = Field(description="关键发现标题")
        evidence: str = Field(description="证据,必须包含数字/时间点/来源编号")
        implication: str = Field(description="对研究结论的影响")
        confidence: int = Field(ge=0, le=10, description="置信度 0-10")

    class Risk(BaseModel):
        risk: str = Field(description="风险")
        trigger: str = Field(description="触发条件")
        signal: str = Field(description="可观察信号")

    class ResearchReport(BaseModel):
        title: str
        executive_summary: str
        key_findings: List[Finding]
        bull_case: List[str]
        bear_case: List[str]
        timeline: List[str]
        risks: List[Risk]
        watchlist: List[str]
        conclusion: str
        confidence: int = Field(ge=0, le=10)

    key, base, mdl, label = openai_spec(job.get("model", ""))
    model = OpenAIChatModel(mdl, provider=OpenAIProvider(base_url=base, api_key=key))
    output_type = PromptedOutput(ResearchReport) if PromptedOutput else ResearchReport
    agent = Agent(
        model,
        output_type=output_type,
        instructions=(
            "你是中文深度研究员。你必须输出可验证、结构化的研究结论。"
            "所有关键事实都要引用来源编号如 [S1],不要编造来源之外的数字。"
        ),
    )
    prompt = (
        f"研究课题:\n{job['query']}\n\n"
        f"来源材料:\n{_sources_md(sources)}\n\n"
        "请生成结构化研究报告。重点:关键发现、多空/正反、未来时间线、风险清单、观察信号、最终结论。"
    )
    result = agent.run_sync(prompt)
    out = result.output
    usage = getattr(result, "usage", None)
    if callable(usage):
        usage = usage()
    in_tok = int(getattr(usage, "input_tokens", 0) or getattr(usage, "request_tokens", 0) or 0)
    out_tok = int(getattr(usage, "output_tokens", 0) or getattr(usage, "response_tokens", 0) or 0)
    job["llm_calls"] = int(job.get("llm_calls") or 0) + 1
    job["in_tokens"] = int(job.get("in_tokens") or 0) + in_tok
    job["out_tokens"] = int(job.get("out_tokens") or 0) + out_tok
    job["model_label"] = label
    job["provider_model"] = mdl
    _save_job(job)
    return out


def _report_to_md(job, report, sources):
    def val(obj, name, default=""):
        return getattr(obj, name, default)

    lines = [
        "# Pydantic AI 结构化研究报告",
        "",
        f"- **课题**: {job['query'][:240]}",
        f"- **LLM**: {job.get('model_label') or ''} · {job.get('provider_model') or job.get('model') or ''}",
        "- **流程**: search → typed schema → validation → markdown",
        "",
        "---",
        "",
        f"# {val(report, 'title', '研究报告')}",
        "",
        "## 执行摘要",
        val(report, "executive_summary", ""),
        "",
        "## 关键发现",
    ]
    for i, f in enumerate(val(report, "key_findings", []) or [], 1):
        lines += [f"{i}. **{val(f, 'title')}**", f"   - 证据: {val(f, 'evidence')}", f"   - 含义: {val(f, 'implication')}", f"   - 置信度: {val(f, 'confidence', 0)}/10"]
    lines += ["", "## 多头/正方", *[f"- {x}" for x in (val(report, "bull_case", []) or [])]]
    lines += ["", "## 空头/反方", *[f"- {x}" for x in (val(report, "bear_case", []) or [])]]
    lines += ["", "## 时间线/观察节点", *[f"- {x}" for x in (val(report, "timeline", []) or [])]]
    lines += ["", "## 风险清单"]
    for r in val(report, "risks", []) or []:
        lines += [f"- **{val(r, 'risk')}**: 触发={val(r, 'trigger')}; 信号={val(r, 'signal')}"]
    lines += ["", "## 观察清单", *[f"- {x}" for x in (val(report, "watchlist", []) or [])]]
    lines += ["", "## 结论", val(report, "conclusion", ""), "", f"**总体置信度: {val(report, 'confidence', 0)}/10**"]
    lines += ["", "## 来源"]
    for i, s in enumerate(sources, 1):
        lines.append(f"- [S{i}] {s.get('title') or 'source'} — {s.get('url') or ''}")
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
    try:
        print("1/3 生成搜索 query", flush=True)
        job["stage"] = "1/3 生成搜索 query"; _save_job(job)
        queries, meta = _queries(job["query"], job.get("model", ""))
        job["llm_calls"] = 1
        job["in_tokens"] = meta.get("in_tokens", 0)
        job["out_tokens"] = meta.get("out_tokens", 0)
        job["model_label"] = meta.get("label", "")
        job["provider_model"] = meta.get("model", "")
        _save_job(job)
        print("2/3 联网搜索", flush=True)
        job["stage"] = "2/3 联网搜索"; _save_job(job)
        sources, seen = [], set()
        for q in queries:
            print("search: " + q, flush=True)
            for src in tavily_search(q, max_results=4):
                key = src.get("url") or src.get("title")
                if key in seen:
                    continue
                seen.add(key); sources.append(src)
        job["msg_count"] = len(sources); _save_job(job)
        print("3/3 Pydantic AI 结构化生成", flush=True)
        job["stage"] = "3/3 Pydantic AI 结构化生成"; _save_job(job)
        report = _run_pydantic_ai(job, sources[:24])
        md = _report_to_md(job, report, sources[:24])
        fn = f"pydai_{now_stamp()}_{jid}.md"
        path = os.path.join(OUT, fn)
        os.makedirs(OUT, exist_ok=True)
        with open(path, "w") as f:
            f.write(md)
        job.update(status="success", file=fn, path=path, stage="done", updated=time.time())
    except Exception as e:
        job.update(status="error", error=redact(str(e))[:1200], stage="error", updated=time.time())
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
        sys.exit("用法: pydai_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine] | run|progress|result <job_id>")
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
