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
import tomllib
import uuid
import re

BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
if BRIDGE_DIR not in sys.path:
    sys.path.insert(0, BRIDGE_DIR)

from tavily_pool import select_tavily_key

VENV_PY = os.path.expanduser("~/agent-harnesses/gptr-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/gptr")
JOBS = os.path.join(OUT, "jobs")
ENVFILE = os.path.expanduser("~/agent-harnesses/gptr.env")
HARNESS_ENV = os.path.expanduser("~/agent-harnesses/harness.env")
CODEWHALE_CFG = os.path.expanduser("~/.codewhale/config.toml")
CODEWHALE_CMP_DIR = os.path.expanduser("~/.codewhale-gui/cmp")


def _atomic_write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def _pid_alive(pid):
    try:
        pid = int(pid or 0)
        if pid <= 0:
            return False
        os.kill(pid, 0)
        return True
    except (OSError, TypeError, ValueError):
        return False


def _read_env_file(path):
    vals = {}
    if not os.path.exists(path):
        return vals
    for ln in open(path):
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            vals[k] = v
    return vals


def _codewhale_custom():
    key, base, _ = _codewhale_provider_config("custom", "https://tokenhub.tencentmaas.com/v1")
    return key, base


def _looks_placeholder(value):
    v = (value or "").strip().lower()
    return (not v) or "xxxx" in v or v in {"sk-", "your-key", "your_api_key", "changeme"}


def _redact(text):
    s = str(text or "")
    s = re.sub(r"\b(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})\b", r"\1…\2", s)
    return re.sub(r"\b(sk-[A-Za-z0-9_-]{4,})\*+([A-Za-z0-9_-]{4})\b", r"\1…\2", s)


def _read_toml(path):
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except Exception:
        return {}


def _provider_result(prov, default_base, default_model):
    if not isinstance(prov, dict):
        return None
    key = (prov.get("api_key") or "").strip()
    if not key:
        return None
    return (
        key,
        (prov.get("base_url") or default_base).rstrip("/"),
        prov.get("model") or default_model,
    )


def _codewhale_provider_config(name, default_base="", default_model=""):
    cfg = _read_toml(CODEWHALE_CFG)

    providers = cfg.get("providers") or {}
    prov = providers.get(name) if isinstance(providers, dict) else {}
    result = _provider_result(prov, default_base, default_model)
    if result:
        return result

    if cfg.get("provider") == name:
        result = _provider_result(cfg, default_base, default_model)
        if result:
            return result

    cmp_cfg = _read_toml(os.path.join(CODEWHALE_CMP_DIR, f"{name}.toml"))
    providers = cmp_cfg.get("providers") or {}
    prov = providers.get(name) if isinstance(providers, dict) else {}
    result = _provider_result(prov, default_base, default_model)
    if result:
        return result

    return "", default_base.rstrip("/"), default_model


def _codewhale_provider(name, default_base=""):
    key, base, _ = _codewhale_provider_config(name, default_base)
    return key, base


def _model_key(model):
    m = (model or "").lower()
    if m in ("hunyuan", "custom", "hy3-preview"):
        return "hunyuan"
    if m in ("glm", "zai", "zhipu", "glm-5.2", "glm-5.2-air"):
        return "zai"
    if m in ("kimi", "moonshot", "k3", "kimi-for-coding", "moonshot-v1-128k") or m.startswith("kimi"):
        return "kimi"
    if m in ("longcat", "longcat-2.0"):
        return "longcat"
    if m in ("volcengine", "doubao", "doubao-seed-2-1-pro-260628"):
        return "volcengine"
    if m in ("qwen", "qwen-plus", "qwen-max", "dashscope", "tongyi", "qianwen") or "qwen" in m:
        return "qwen"
    return "deepseek"


def _set_embedding(vals):
    key, base = _codewhale_provider("moonshot", "https://api.kimi.com/coding/v1")
    key = key or vals.get("KIMI_API_KEY", "")
    if _looks_placeholder(key):
        raise RuntimeError("GPT Researcher 需要 Kimi embedding key:请在 CodeWhale 的 Kimi/Moonshot 配置里保存可用 key")
    os.environ["EMBEDDING"] = "openai:moonshot-v1-embedding"
    os.environ["EMBEDDING_KWARGS"] = json.dumps({
        "openai_api_base": base or "https://api.kimi.com/coding/v1",
        "openai_api_key": key,
        # Kimi embedding endpoint accepts text input, but returns 500 for the
        # token-id arrays produced by LangChain's length-safe preprocessing.
        "check_embedding_ctx_length": False,
    }, ensure_ascii=False)


def _set_openai_compat(key, base, model, temperature=None):
    if _looks_placeholder(key):
        raise RuntimeError(f"{model} 的 API key 未配置或还是占位符")
    base = (base or "").rstrip("/")
    os.environ["OPENAI_API_KEY"] = key
    os.environ["OPENAI_BASE_URL"] = base
    os.environ["OPENAI_API_BASE"] = base
    os.environ["FAST_LLM"] = f"openai:{model}"
    os.environ["SMART_LLM"] = f"openai:{model}"
    os.environ["STRATEGIC_LLM"] = f"openai:{model}"
    if temperature is None:
        os.environ.pop("TEMPERATURE", None)
    else:
        os.environ["TEMPERATURE"] = str(temperature)
    # 推理型模型(doubao-seed/LongCat/混元等)思考会吃掉输出预算,gpt-researcher 默认 3000/6000/4000
    # 太小 → 正文为空("LLM returned empty response")。统一拉高,普通模型也无害(只是上限)。
    os.environ.setdefault("FAST_TOKEN_LIMIT", "8000")
    os.environ.setdefault("SMART_TOKEN_LIMIT", "16000")
    os.environ.setdefault("STRATEGIC_TOKEN_LIMIT", "8000")


def _set_deepseek(vals):
    key, _ = _codewhale_provider("deepseek", "https://api.deepseek.com")
    key = key or vals.get("DEEPSEEK_API_KEY", "")
    if _looks_placeholder(key):
        raise RuntimeError("DeepSeek API key 未配置:请先在 CodeWhale 模型设置里保存 DeepSeek key")
    os.environ["DEEPSEEK_API_KEY"] = key
    os.environ["FAST_LLM"] = "deepseek:deepseek-v4-flash"
    os.environ["SMART_LLM"] = "deepseek:deepseek-v4-pro"
    os.environ["STRATEGIC_LLM"] = "deepseek:deepseek-v4-pro"


def _load_env(model=""):
    # 强制覆盖(不能 setdefault):宿主 shell/gptr.env 可能已有别家 OPENAI_API_KEY,会让调用串到 OpenAI 官方 401
    vals = _read_env_file(ENVFILE)
    vals.update({k: v for k, v in _read_env_file(HARNESS_ENV).items() if k not in vals})
    shadowed = {
        "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
        "FAST_LLM", "SMART_LLM", "STRATEGIC_LLM",
        "EMBEDDING", "EMBEDDING_KWARGS", "LLM_KWARGS", "TEMPERATURE",
    }
    for k, v in vals.items():
        if k in shadowed:
            continue
        os.environ[k] = v
    for k in shadowed:
        os.environ.pop(k, None)
    os.environ["TAVILY_API_KEY"] = select_tavily_key(
        os.environ.get("TAVILY_API_KEY") or vals.get("TAVILY_API_KEY", "")
    )
    if not os.environ.get("TAVILY_API_KEY"):
        raise RuntimeError("Tavily 凭据池为空或所有槽位暂时不可用")
    os.environ["LANGUAGE"] = "chinese"
    os.environ.setdefault("TOTAL_WORDS", "1800")
    os.environ.setdefault("MAX_ITERATIONS", "3")
    _set_embedding(vals)

    mk = _model_key(model)
    if mk == "hunyuan":
        key, base = _codewhale_custom()
        key = key or vals.get("HUNYUAN_API_KEY", "")
        _set_openai_compat(key, base, "hy3-preview")
    elif mk == "zai":
        key, base = _codewhale_provider("zai", "https://api.z.ai/api/paas/v4")
        key = key or vals.get("ZHIPU_API_KEY", "")
        _set_openai_compat(key, base or "https://api.z.ai/api/paas/v4", "GLM-5.2")
    elif mk == "kimi":
        key, base, mdl = _codewhale_provider_config("moonshot", "https://api.kimi.com/coding/v1", "k3")
        if not key:
            key, base, mdl = _codewhale_provider_config("kimi", "https://api.kimi.com/coding/v1", "k3")
        key = key or vals.get("KIMI_API_KEY", "")
        _set_openai_compat(key, base or "https://api.kimi.com/coding/v1", mdl or "k3", temperature=1)
    elif mk == "longcat":
        key, base, mdl = _codewhale_provider_config("longcat", "https://api.longcat.chat/openai", "LongCat-2.0")
        _set_openai_compat(key, base, mdl or "LongCat-2.0")
    elif mk == "volcengine":
        key, base, mdl = _codewhale_provider_config("volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-1-pro-260628")
        _set_openai_compat(key, base, mdl or "doubao-seed-2-1-pro-260628")
    elif mk == "qwen":
        key, base, mdl = _codewhale_provider_config("qwen", "https://ws-zazex2z3400vhsxs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen3.7-max-2026-06-08")
        key = key or vals.get("DASHSCOPE_API_KEY", "")
        _set_openai_compat(key, base, mdl or "qwen3.7-max-2026-06-08")
    else:
        _set_deepseek(vals)


def _patch_model_compatibility(model):
    """Register models that reject GPT Researcher's per-call temperature.

    GPT Researcher passes per-call temperatures after LLM_KWARGS, so an env
    override alone cannot fix it. Registering the active model in the package's
    shared no-temperature list makes every retry omit that unsupported field.
    """
    raw = str(model or "").split(":", 1)[-1].strip()
    lower = raw.lower()
    kimi_fixed_temperature = _model_key(raw) == "kimi" and lower in {"k3", "kimi-for-coding"}
    qwen_thinking_only = _model_key(raw) == "qwen" and lower.startswith("qwen3.8-")
    if not (kimi_fixed_temperature or qwen_thinking_only):
        return
    candidates = {raw, raw.lower(), raw.upper()}
    try:
        from gpt_researcher.llm_provider.generic import base as generic_base
        for name in candidates:
            if name not in generic_base.NO_SUPPORT_TEMPERATURE_MODELS:
                generic_base.NO_SUPPORT_TEMPERATURE_MODELS.append(name)
    except Exception:
        pass
    try:
        from gpt_researcher.utils import llm as llm_utils
        for name in candidates:
            if name not in llm_utils.NO_SUPPORT_TEMPERATURE_MODELS:
                llm_utils.NO_SUPPORT_TEMPERATURE_MODELS.append(name)
    except Exception:
        pass


def cmd_submit(prompt, model=""):
    os.makedirs(JOBS, exist_ok=True)
    jid = uuid.uuid4().hex[:12]
    job_path = f"{JOBS}/{jid}.json"
    job = {"id": jid, "status": "running", "stage": "starting", "query": prompt, "model": model,
           "started": time.time(), "updated": time.time()}
    _atomic_write_json(job_path, job)
    logf = open(f"{JOBS}/{jid}.log", "w", encoding="utf-8")
    try:
        proc = subprocess.Popen(
            [VENV_PY, os.path.abspath(__file__), "run", jid],
            start_new_session=True,
            stdout=logf,
            stderr=subprocess.STDOUT,
        )
    finally:
        logf.close()
    try:
        with open(job_path, encoding="utf-8") as f:
            current = json.load(f)
    except Exception:
        current = job
    current.update(pid=proc.pid, updated=time.time())
    if current.get("stage") == "starting":
        current["stage"] = "booting"
    _atomic_write_json(job_path, current)
    print(json.dumps({"ok": True, "thread_id": jid}))


def cmd_run(jid):
    import asyncio

    job_path = f"{JOBS}/{jid}.json"
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    job.update(pid=os.getpid(), stage="configuring", updated=time.time())
    _atomic_write_json(job_path, job)
    try:
        _load_env(job.get("model", ""))
        active_model = os.environ.get("FAST_LLM", "").split(":", 1)[-1]
        _patch_model_compatibility(active_model)
        job.update(stage="researching", active_model=active_model, updated=time.time())
        _atomic_write_json(job_path, job)
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
        job.update(status="success", stage="completed", file=fn, path=path, costs=costs, sources=srcs,
                   ended=time.time(), updated=time.time())
    except Exception as e:
        job.update(status="error", stage="failed", error=_redact(str(e))[:500], ended=time.time(), updated=time.time())
    _atomic_write_json(job_path, job)


def cmd_progress(jid):
    job_path = f"{JOBS}/{jid}.json"
    try:
        with open(job_path, encoding="utf-8") as f:
            job = json.load(f)
    except Exception:
        print(json.dumps({"status": "pending"}))
        return
    if job.get("status") == "running" and job.get("pid") and time.time() - float(job.get("started") or 0) > 5:
        if not _pid_alive(job.get("pid")):
            job.update(status="error", stage="failed", ended=time.time(), updated=time.time(),
                       error="GPT Researcher 子进程已退出,但未生成结果。请查看任务日志后重试。")
            _atomic_write_json(job_path, job)
    tail, nlines = "", 0
    try:
        log = open(f"{JOBS}/{jid}.log", errors="replace").read()
        tail = _redact(log[-2000:])
        nlines = len([l for l in log.splitlines() if l.strip()])
    except Exception:
        pass
    out = {"status": job.get("status", "unknown"), "stage": job.get("stage", ""), "tail": tail, "msg_count": nlines,
           "llm_calls": 0, "in_tokens": 0, "out_tokens": 0}
    if job.get("error"):
        out["error"] = _redact(job["error"])
    if job.get("sources"):
        out["msg_count"] = job["sources"]
    print(json.dumps(out, ensure_ascii=False))


def cmd_result(jid):
    try:
        with open(f"{JOBS}/{jid}.json", encoding="utf-8") as f:
            job = json.load(f)
    except Exception:
        print(json.dumps({"ok": False, "error": "job 不存在"}))
        return
    if job.get("path") and os.path.exists(job["path"]):
        with open(job["path"], errors="replace") as f:
            output = f.read()
        print(json.dumps({"ok": True, "output": output, "file": job.get("file"),
                          "path": job.get("path")}, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": _redact(job.get("error") or "无结果")}, ensure_ascii=False))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: gptr_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|k3|longcat|volcengine|qwen] | run|progress|result <job_id>")
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
