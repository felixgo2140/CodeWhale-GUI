#!/usr/bin/env python3
"""Agent Loop bridge for CodeWhale GUI.

Contract:
  submit <prompt> [--model key] -> {"ok":true,"thread_id":"..."}
  progress <job_id>             -> {"status":"running|success|error",...}
  result <job_id>               -> {"ok":true,"output":"...","file":"...","path":"..."}
"""
import json
import os
import subprocess
import sys
import time
import uuid
from typing import TypedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_llm import chat, extract_json_obj, now_stamp, redact, tavily_search, write_json

VENV_PY = os.path.expanduser("~/agent-harnesses/agentloop-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/agentloop")
JOBS = os.path.join(OUT, "jobs")


class LoopState(TypedDict, total=False):
    job: dict
    plan: dict
    sources: list
    draft: str
    critique: dict
    final: str


def _job_path(jid):
    return os.path.join(JOBS, f"{jid}.json")


def _load_job(jid):
    with open(_job_path(jid), errors="replace") as f:
        return json.load(f)


def _save_job(job):
    write_json(_job_path(job["id"]), job)


def _log(msg):
    print(msg, flush=True)


def _bump_usage(job, meta):
    job["llm_calls"] = int(job.get("llm_calls") or 0) + 1
    job["in_tokens"] = int(job.get("in_tokens") or 0) + int(meta.get("in_tokens") or 0)
    job["out_tokens"] = int(job.get("out_tokens") or 0) + int(meta.get("out_tokens") or 0)
    job["model_label"] = meta.get("label") or job.get("model_label") or ""
    job["provider_model"] = meta.get("model") or job.get("provider_model") or ""
    _save_job(job)


def _require_content(content, stage):
    if not (content or "").strip():
        raise RuntimeError(f"{stage} 返回空内容,已停止写入空报告")
    return content


def _set_stage(job, stage):
    job["stage"] = stage
    job["updated"] = time.time()
    _save_job(job)
    _log(stage)


def _sources_md(sources):
    lines = []
    for i, src in enumerate(sources, 1):
        title = (src.get("title") or "source").strip()
        url = (src.get("url") or "").strip()
        body = (src.get("content") or "").strip().replace("\n", " ")
        lines.append(f"[S{i}] {title}\nURL: {url}\n摘要: {body[:900]}")
    return "\n\n".join(lines)


def _fallback_queries(prompt):
    base = prompt.strip().replace("\n", " ")
    return [base, f"{base} 最新 数据 来源", f"{base} 风险 竞争格局"]


def node_plan(state):
    job = state["job"]
    _set_stage(job, "1/6 规划研究问题和搜索路径")
    prompt = job["query"]
    content, meta = chat([
        {"role": "system", "content": "你是一个中文深度研究总编。先拆解问题,再决定搜索路径。只返回 JSON。"},
        {"role": "user", "content": (
            "请把下面课题拆成可执行研究计划。返回 JSON: "
            "{\"brief\":\"一句话课题\",\"questions\":[...],\"search_queries\":[...]}。"
            "search_queries 4-7 条,要包含最新信息、官方/权威来源、反方观点。\n\n课题:\n" + prompt
        )},
    ], job.get("model", ""), temperature=0.1, max_tokens=2500)
    _bump_usage(job, meta)
    plan = extract_json_obj(content)
    if not plan.get("search_queries"):
        plan = {"brief": prompt[:120], "questions": [], "search_queries": _fallback_queries(prompt)}
    return {"plan": plan}


def node_search(state):
    job = state["job"]
    _set_stage(job, "2/6 联网搜索并整理来源")
    sources, seen = [], set()
    for q in (state.get("plan", {}).get("search_queries") or _fallback_queries(job["query"]))[:7]:
        _log(f"search: {q}")
        for src in tavily_search(q, max_results=4):
            key = src.get("url") or (src.get("title") or "")[:80]
            if key in seen:
                continue
            seen.add(key)
            sources.append(src)
    job["msg_count"] = len(sources)
    _save_job(job)
    return {"sources": sources[:24]}


def node_draft(state):
    job = state["job"]
    _set_stage(job, "3/6 生成第一版研究报告")
    src_md = _sources_md(state.get("sources") or [])
    content, meta = chat([
        {"role": "system", "content": (
            "你是中文深度研究员。基于来源写结构化报告,每个关键事实用 [S数字] 引用。"
            "如果来源不足,明确标注不确定性,不要编造。"
        )},
        {"role": "user", "content": (
            f"课题:\n{job['query']}\n\n研究计划:\n{json.dumps(state.get('plan', {}), ensure_ascii=False)}"
            f"\n\n来源:\n{src_md}\n\n请写第一版报告,包含:结论、关键事实、多空/正反、风险、待验证信号。"
        )},
    ], job.get("model", ""), temperature=0.25, max_tokens=9000)
    _bump_usage(job, meta)
    _require_content(content, "第一版研究报告")
    return {"draft": content}


def node_critique(state):
    job = state["job"]
    _set_stage(job, "4/6 批判初稿,找缺口")
    content, meta = chat([
        {"role": "system", "content": "你是严格的研究审稿人。只返回 JSON。"},
        {"role": "user", "content": (
            "审稿下面报告。返回 JSON: "
            "{\"score\":0-10,\"gaps\":[\"缺口\"],\"followup_queries\":[\"补搜 query\"]}。"
            "重点检查:数字来源、时间点、反方观点、可证伪信号。\n\n" + (state.get("draft") or "")
        )},
    ], job.get("model", ""), temperature=0.1, max_tokens=2500)
    _bump_usage(job, meta)
    critique = extract_json_obj(content)
    if not critique:
        critique = {"score": 6, "gaps": [content[:500]], "followup_queries": []}
    return {"critique": critique}


def node_followup(state):
    job = state["job"]
    queries = (state.get("critique") or {}).get("followup_queries") or []
    if not queries:
        _set_stage(job, "5/6 无需补搜,进入定稿")
        return {}
    _set_stage(job, "5/6 按审稿意见补搜")
    sources = list(state.get("sources") or [])
    seen = {s.get("url") or s.get("title") for s in sources}
    for q in queries[:4]:
        _log(f"followup: {q}")
        for src in tavily_search(q, max_results=3):
            key = src.get("url") or (src.get("title") or "")[:80]
            if key in seen:
                continue
            seen.add(key)
            sources.append(src)
    job["msg_count"] = len(sources)
    _save_job(job)
    return {"sources": sources[:32]}


def node_final(state):
    job = state["job"]
    _set_stage(job, "6/6 定稿并落盘")
    src_md = _sources_md(state.get("sources") or [])
    critique = json.dumps(state.get("critique") or {}, ensure_ascii=False)
    content, meta = chat([
        {"role": "system", "content": (
            "你是中文研究总编。根据初稿、审稿意见和来源定稿。"
            "要求:结论明确,数字带时间点和来源,引用形如 [S1],末尾列来源 URL。"
        )},
        {"role": "user", "content": (
            f"课题:\n{job['query']}\n\n初稿:\n{state.get('draft','')}\n\n审稿意见:\n{critique}"
            f"\n\n完整来源:\n{src_md}\n\n请输出可直接发布的 Markdown 深度研究报告。"
        )},
    ], job.get("model", ""), temperature=0.2, max_tokens=12000)
    _bump_usage(job, meta)
    _require_content(content, "最终研究报告")
    header = (
        "# Agent Loop 深度研究报告\n\n"
        f"- **课题**: {job['query'][:240]}\n"
        f"- **LLM**: {job.get('model_label') or ''} · {job.get('provider_model') or job.get('model') or ''}\n"
        f"- **流程**: plan → search → draft → critique → follow-up → final\n\n---\n\n"
    )
    return {"final": header + content}


def _run_graph(job):
    try:
        from langgraph.graph import END, START, StateGraph
    except Exception:
        state = {"job": job}
        for fn in (node_plan, node_search, node_draft, node_critique, node_followup, node_final):
            state.update(fn(state))
        return state

    graph = StateGraph(LoopState)
    graph.add_node("plan", node_plan)
    graph.add_node("search", node_search)
    graph.add_node("draft", node_draft)
    graph.add_node("critique", node_critique)
    graph.add_node("followup", node_followup)
    graph.add_node("final", node_final)
    graph.add_edge(START, "plan")
    graph.add_edge("plan", "search")
    graph.add_edge("search", "draft")
    graph.add_edge("draft", "critique")
    graph.add_edge("critique", "followup")
    graph.add_edge("followup", "final")
    graph.add_edge("final", END)
    return graph.compile().invoke({"job": job})


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
        state = _run_graph(job)
        final = _require_content(state.get("final") or "", "最终研究报告")
        fn = f"agentloop_{now_stamp()}_{jid}.md"
        path = os.path.join(OUT, fn)
        os.makedirs(OUT, exist_ok=True)
        with open(path, "w") as f:
            f.write(final)
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
        sys.exit("用法: agentloop_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine] | run|progress|result <job_id>")
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
