#!/usr/bin/env python3
"""STORM(斯坦福) 桥接 — 与 deerflow_client 同契约(submit/progress/result)。

多视角提问 → 大纲 → 维基级长文带引用。LLM=deepseek(litellm),搜索=Tavily。
任务模型同 gptr:job 文件 + 脱管子进程。输出 ~/harness-output/storm/。
"""
import json
import os
import subprocess
import sys
import time
import uuid

VENV_PY = os.path.expanduser("~/agent-harnesses/storm-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/storm")
JOBS = os.path.join(OUT, "jobs")


def _keys():
    """密钥统一从 ~/agent-harnesses/harness.env 读(脚本本身不含 key,可公开发布)"""
    d = {}
    envf = os.path.expanduser("~/agent-harnesses/harness.env")
    if os.path.exists(envf):
        for ln in open(envf):
            ln = ln.strip()
            if ln and not ln.startswith("#") and "=" in ln:
                k, v = ln.split("=", 1)
                d[k] = v.strip()
    return d


_K = _keys()
DEEPSEEK_KEY = _K.get("DEEPSEEK_API_KEY", "")
TAVILY_KEY = _K.get("TAVILY_API_KEY", "")


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
    job = json.load(open(f"{JOBS}/{jid}.json"))
    try:
        if not DEEPSEEK_KEY or not TAVILY_KEY:
            raise RuntimeError("~/agent-harnesses/harness.env 缺 DEEPSEEK_API_KEY / TAVILY_API_KEY")
        os.environ["DEEPSEEK_API_KEY"] = DEEPSEEK_KEY
        os.environ.pop("OPENAI_API_KEY", None)   # 防宿主 shell 的别家 key 干扰 litellm 路由
        from knowledge_storm import STORMWikiRunnerArguments, STORMWikiRunner, STORMWikiLMConfigs
        from knowledge_storm.lm import LitellmModel
        from knowledge_storm.rm import TavilySearchRM

        # deepseek thinking 模式对纯补全无碍,但显式关掉可避免 reasoning 占 token
        kw = {"api_key": DEEPSEEK_KEY, "extra_body": {"thinking": {"type": "disabled"}}, "temperature": 1.0, "top_p": 0.9}
        fast = LitellmModel(model="deepseek/deepseek-v4-flash", max_tokens=1500, **kw)
        smart = LitellmModel(model="deepseek/deepseek-v4-pro", max_tokens=4000, **kw)
        lm = STORMWikiLMConfigs()
        lm.set_conv_simulator_lm(fast)
        lm.set_question_asker_lm(fast)
        lm.set_outline_gen_lm(smart)
        lm.set_article_gen_lm(smart)
        lm.set_article_polish_lm(smart)
        rm = TavilySearchRM(tavily_search_api_key=TAVILY_KEY, k=5, include_raw_content=True)
        args = STORMWikiRunnerArguments(output_dir=os.path.join(OUT, "runs", jid),
                                        max_conv_turn=3, max_perspective=3, search_top_k=5, max_thread_num=3)
        runner = STORMWikiRunner(args, lm, rm)
        topic = job["query"].strip()
        runner.run(topic=topic, do_research=True, do_generate_outline=True,
                   do_generate_article=True, do_polish_article=True)
        runner.post_run()
        # 找产出文章(polished 优先)
        import glob
        cand = glob.glob(os.path.join(OUT, "runs", jid, "*", "storm_gen_article_polished.txt")) or \
               glob.glob(os.path.join(OUT, "runs", jid, "*", "storm_gen_article.txt"))
        if not cand:
            raise RuntimeError("STORM 未产出文章文件")
        article = open(cand[0], errors="replace").read()
        fn = f"storm_{time.strftime('%Y%m%d-%H%M%S')}_{jid}.md"
        path = os.path.join(OUT, fn)
        with open(path, "w") as f:
            f.write(f"# STORM 深度研究长文\n\n- **课题**: {topic[:200]}\n\n---\n\n")
            f.write(article)
        job.update(status="success", file=fn, path=path)
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
        sys.exit("用法: storm_client.py submit <topic> | run|progress|result <job_id>")
    cmd, arg = sys.argv[1], sys.argv[2]
    {"submit": cmd_submit, "run": cmd_run, "progress": cmd_progress, "result": cmd_result}[cmd](arg)


if __name__ == "__main__":
    main()
