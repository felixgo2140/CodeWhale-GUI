#!/usr/bin/env python3
"""LangChain Open Deep Research 桥接 — 与 deerflow_client 同契约(submit/progress/result)。

后端 = langgraph dev 服务(:2024,~/agent-harnesses/open_deep_research)。模型全配 deepseek,
搜索 Tavily(.env)。输出目录 ~/harness-output/odr/。
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import tomllib
from urllib.parse import urlparse

import requests

BASE = os.environ.get("ODR_BASE_URL", "http://127.0.0.1:2024")
OUT = os.path.expanduser("~/harness-output/odr")
ODR_DIR = os.path.expanduser("~/agent-harnesses/open_deep_research")
HARNESS_ENV = os.path.expanduser("~/agent-harnesses/harness.env")
CODEWHALE_CFG = os.path.expanduser("~/.codewhale/config.toml")
CODEWHALE_CMP_DIR = os.path.expanduser("~/.codewhale-gui/cmp")
SERVER_MODEL = os.path.join(OUT, "langgraph_model.txt")


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


def _model_key(model):
    m = (model or "").lower()
    if m in ("hunyuan", "custom", "hy3-preview"):
        return "hunyuan"
    if m in ("glm", "zai", "zhipu", "glm-5.2", "glm-5.2-air"):
        return "zai"
    if m in ("kimi", "moonshot", "kimi-for-coding", "moonshot-v1-128k"):
        return "kimi"
    if m in ("longcat", "longcat-2.0"):
        return "longcat"
    if m in ("volcengine", "doubao", "doubao-seed-2-1-pro-260628"):
        return "volcengine"
    if m in ("qwen", "qwen-plus", "qwen-max", "dashscope", "tongyi", "qianwen") or "qwen" in m:
        return "qwen"
    return "deepseek"


def _openai_spec(kind, vals=None):
    vals = vals or {}
    specs = {
        "hunyuan": ("custom", "https://tokenhub.tencentmaas.com/v1", "hy3-preview", "HUNYUAN_API_KEY"),
        "zai": ("zai", "https://api.z.ai/api/paas/v4", "GLM-5.2", "ZHIPU_API_KEY"),
        "kimi": ("moonshot", "https://api.kimi.com/coding/v1", "kimi-for-coding", "KIMI_API_KEY"),
        "longcat": ("longcat", "https://api.longcat.chat/openai", "LongCat-2.0", "LONGCAT_API_KEY"),
        "volcengine": ("volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-1-pro-260628", "VOLCENGINE_API_KEY"),
        "qwen": ("qwen", "https://ws-zazex2z3400vhsxs.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen3.7-max-2026-06-08", "DASHSCOPE_API_KEY"),
    }
    provider, base0, model0, env_key = specs[kind]
    key, base, model = _codewhale_provider_config(provider, base0, model0)
    key = key or vals.get(env_key, "")
    if not key:
        raise RuntimeError(f"{kind} 未配置:请先在 CodeWhale 模型设置里保存 API key")
    return key, base, model


def _model_env(model):
    vals = _read_env_file(HARNESS_ENV)
    env = {
        "TAVILY_API_KEY": vals.get("TAVILY_API_KEY", ""),
        "DEEPSEEK_API_KEY": vals.get("DEEPSEEK_API_KEY", ""),
        "GET_API_KEYS_FROM_CONFIG": "false",
        "LANGSMITH_TRACING": "false",
    }
    mk = _model_key(model)
    if mk in ("hunyuan", "zai", "kimi", "longcat", "volcengine", "qwen"):
        key, base, _ = _openai_spec(mk, vals)
        env.update({
            "OPENAI_API_KEY": key,
            "OPENAI_BASE_URL": base,
            "OPENAI_API_BASE": base,
        })
    else:
        if vals.get("DEEPSEEK_API_KEY"):
            env.update({
                "OPENAI_API_KEY": vals["DEEPSEEK_API_KEY"],
                "OPENAI_BASE_URL": "https://api.deepseek.com/v1",
                "OPENAI_API_BASE": "https://api.deepseek.com/v1",
            })
    if not env.get("TAVILY_API_KEY"):
        raise RuntimeError("~/agent-harnesses/harness.env 缺 TAVILY_API_KEY")
    return env


def _cfg(model):
    base = {
        "allow_clarification": False,   # API 场景不反问,直接研究
        "max_concurrent_research_units": 3,
        "max_researcher_iterations": 4,
    }
    mk = _model_key(model)
    if mk in ("hunyuan", "zai", "kimi", "longcat", "volcengine", "qwen"):
        _, _, model_name = _openai_spec(mk, _read_env_file(HARNESS_ENV))
        base.update({
            "research_model": f"openai:{model_name}", "research_model_max_tokens": 8000,
            "summarization_model": f"openai:{model_name}", "summarization_model_max_tokens": 4000,
            "compression_model": f"openai:{model_name}", "compression_model_max_tokens": 4000,
            "final_report_model": f"openai:{model_name}", "final_report_model_max_tokens": 10000,
        })
    else:
        base.update({
            "research_model": "deepseek:deepseek-v4-pro", "research_model_max_tokens": 8000,
            "summarization_model": "deepseek:deepseek-v4-flash", "summarization_model_max_tokens": 4000,
            "compression_model": "deepseek:deepseek-v4-flash", "compression_model_max_tokens": 4000,
            "final_report_model": "deepseek:deepseek-v4-pro", "final_report_model_max_tokens": 10000,
            # deepseek thinking 模式不接受强制 tool_choice → 显式关(配合 deep_researcher.py 的 extra_body configurable 补丁)
            "extra_body": {"thinking": {"type": "disabled"}},
        })
    return {"configurable": base}


def _write_env(env):
    path = os.path.join(ODR_DIR, ".env")
    with open(path, "w") as f:
        for k, v in env.items():
            f.write(f"{k}={v}\n")
    os.chmod(path, 0o600)


def _is_up():
    try:
        requests.get(f"{BASE}/ok", timeout=3)
        return True
    except Exception:
        return False


def _port():
    return urlparse(BASE).port or 2024


def _stop_up():
    try:
        r = subprocess.run(["lsof", "-tiTCP:%s" % _port(), "-sTCP:LISTEN"],
                           capture_output=True, text=True, timeout=5)
        for pid in [p for p in r.stdout.splitlines() if p.strip().isdigit()]:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except Exception:
                pass
        time.sleep(1.5)
    except Exception:
        pass


def _python312():
    for p in (shutil.which("python3.12"), "/opt/homebrew/bin/python3.12", "/usr/local/bin/python3.12"):
        if p and os.path.exists(p):
            return p
    return ""


def _ensure_py312_venv():
    py = _python312()
    if not py:
        raise RuntimeError("ODR 需要 python3.12:请先 brew install python@3.12")
    cfg = os.path.join(ODR_DIR, ".venv", "pyvenv.cfg")
    if os.path.exists(cfg):
        try:
            txt = open(cfg).read()
            if "3.12" not in txt:
                shutil.rmtree(os.path.join(ODR_DIR, ".venv"), ignore_errors=True)
        except Exception:
            pass
    return py


def _ensure_up(model=""):
    os.makedirs(OUT, exist_ok=True)
    desired = _model_key(model)
    env = _model_env(model)
    old = ""
    try:
        old = open(SERVER_MODEL).read().strip()
    except Exception:
        pass
    if _is_up() and old == desired:
        return True
    if _is_up():
        _stop_up()
    _write_env(env)
    log = os.path.join(OUT, "langgraph.log")
    uv = shutil.which("uv") or "/opt/homebrew/bin/uv" or "uv"
    py312 = _ensure_py312_venv()
    subprocess.Popen(
        [uv, "run", "--python", py312, "langgraph", "dev", "--port", str(_port()), "--no-browser"],
        cwd=ODR_DIR, start_new_session=True,
        stdout=open(log, "a"), stderr=subprocess.STDOUT,
        env={**os.environ, **env, "UV_PYTHON": py312, "PATH": "/opt/homebrew/bin:" + os.environ.get("PATH", "")},
    )
    for _ in range(45):
        time.sleep(2)
        if _is_up():
            with open(SERVER_MODEL, "w") as f:
                f.write(desired)
            return True
    return False


def cmd_submit(prompt, model=""):
    if not _ensure_up(model):
        print(json.dumps({"ok": False, "error": "langgraph dev(:2024) 起不来,查 ~/harness-output/odr/langgraph.log"}))
        return
    t = requests.post(f"{BASE}/threads", json={}, timeout=15).json()
    tid = t["thread_id"]
    if "中文" not in prompt:
        prompt += "\n\n(请用中文撰写完整报告)"   # felix 治理要求:研究引擎中文输出
    requests.post(f"{BASE}/threads/{tid}/runs", timeout=15, json={
        "assistant_id": "Deep Researcher",
        "input": {"messages": [{"role": "human", "content": prompt}]},
        "config": _cfg(model),
    }).raise_for_status()
    print(json.dumps({"ok": True, "thread_id": tid}))


def _last_run_status(tid):
    rs = requests.get(f"{BASE}/threads/{tid}/runs", timeout=15).json()
    return (rs[-1].get("status") if rs else "pending") or "unknown"


def _state(tid):
    return requests.get(f"{BASE}/threads/{tid}/state", timeout=20).json()


def _log_tail(n=2000):
    try:
        return open(os.path.join(OUT, "langgraph.log"), errors="replace").read()[-n:]
    except Exception:
        return ""


def _message_content(m):
    if isinstance(m, dict):
        c = m.get("content", "")
    else:
        c = getattr(m, "content", "")
    if isinstance(c, list):
        parts = []
        for item in c:
            if isinstance(item, dict):
                text = item.get("text") or item.get("content") or ""
                if text:
                    parts.append(str(text))
            elif item:
                parts.append(str(item))
        return "\n".join(parts)
    return str(c or "")


def _message_role(m):
    if not isinstance(m, dict):
        return ""
    return str(m.get("role") or m.get("type") or m.get("name") or "").lower()


def _status_like_report(text):
    s = str(text or "").strip().lower()
    return (not s) or s in {"ok", "done", "success", "completed", "complete", "finished"}


def _best_report(vals):
    vals = vals if isinstance(vals, dict) else {}
    report = vals.get("final_report") or vals.get("report") or ""
    if not _status_like_report(report):
        return str(report)

    candidates = []
    for m in vals.get("messages") or []:
        if _message_role(m) in {"human", "user"}:
            continue
        text = _message_content(m).strip()
        if not text or _status_like_report(text):
            continue
        score = len(text)
        if re.search(r"(?m)^#{1,3}\s|报告|结论|摘要|研究|分析|来源|引用", text):
            score += 5000
        candidates.append((score, text))
    return max(candidates, key=lambda x: x[0])[1] if candidates else ""


def _progress_tail(vals, msgs):
    report = vals.get("final_report") if isinstance(vals, dict) else ""
    if not _status_like_report(report):
        return str(report)[-2000:]
    for m in reversed(msgs):
        if _message_role(m) in {"human", "user"}:
            continue
        c = _message_content(m)
        if c and c.strip() and not _status_like_report(c):
            return c[-2000:]
    return ""


def cmd_progress(tid):
    try:
        st = _last_run_status(tid)
        vals = (_state(tid).get("values") or {})
        msgs = vals.get("messages") or []
        tail = _progress_tail(vals, msgs)
        if st == "running" and len(msgs) <= 1:
            tail = _log_tail() or tail
        status = {"pending": "running", "running": "running", "success": "success"}.get(st, st)
        print(json.dumps({"status": status, "tail": tail, "msg_count": len(msgs),
                          "llm_calls": 0, "in_tokens": 0, "out_tokens": 0}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"status": "pending", "error": str(e)[:200]}))


def cmd_result(tid):
    try:
        vals = (_state(tid).get("values") or {})
        report = _best_report(vals)
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
        sys.exit("用法: odr_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine|qwen] | progress|result <thread_id>")
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
        {"progress": cmd_progress, "result": cmd_result}[cmd](arg)


if __name__ == "__main__":
    main()
