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
import tomllib
import uuid

VENV_PY = os.path.expanduser("~/agent-harnesses/storm-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/storm")
JOBS = os.path.join(OUT, "jobs")
CODEWHALE_CFG = os.path.expanduser("~/.codewhale/config.toml")
CODEWHALE_CMP_DIR = os.path.expanduser("~/.codewhale-gui/cmp")


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
    return "deepseek"


def _openai_spec(kind):
    specs = {
        "hunyuan": ("custom", "https://tokenhub.tencentmaas.com/v1", "hy3-preview", "HUNYUAN_API_KEY"),
        "zai": ("zai", "https://api.z.ai/api/paas/v4", "GLM-5.2", "ZHIPU_API_KEY"),
        "kimi": ("moonshot", "https://api.kimi.com/coding/v1", "kimi-for-coding", "KIMI_API_KEY"),
        "longcat": ("longcat", "https://api.longcat.chat/openai", "LongCat-2.0", "LONGCAT_API_KEY"),
        "volcengine": ("volcengine", "https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-2-1-pro-260628", "VOLCENGINE_API_KEY"),
    }
    provider, base0, model0, env_key = specs[kind]
    key, base, model = _codewhale_provider_config(provider, base0, model0)
    key = key or _K.get(env_key, "")
    if not key:
        raise RuntimeError(f"{kind} 未配置:请先在 CodeWhale 模型设置里保存 API key")
    return key, base, model


_K = _keys()
DEEPSEEK_KEY = _K.get("DEEPSEEK_API_KEY", "")
TAVILY_KEY = _K.get("TAVILY_API_KEY", "")


def cmd_submit(prompt, model=""):
    os.makedirs(JOBS, exist_ok=True)
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "query": prompt, "model": model, "started": time.time()}
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
        if not TAVILY_KEY:
            raise RuntimeError("~/agent-harnesses/harness.env 缺 TAVILY_API_KEY")
        from knowledge_storm import STORMWikiRunnerArguments, STORMWikiRunner, STORMWikiLMConfigs
        import knowledge_storm.lm as storm_lm
        from knowledge_storm.lm import LitellmModel
        from knowledge_storm.rm import TavilySearchRM

        class SafeLitellmModel(LitellmModel):
            def _completion_fn(self, cache):
                if self.model_type == "chat":
                    return storm_lm.cached_litellm_completion if cache else storm_lm.litellm_completion
                return storm_lm.cached_litellm_text_completion if cache else storm_lm.litellm_text_completion

            @staticmethod
            def _response_dict(response):
                if hasattr(response, "json"):
                    data = response.json()
                    if isinstance(data, str):
                        return json.loads(data)
                    return data
                return dict(response)

            @staticmethod
            def _choices(response, response_dict):
                try:
                    return response["choices"]
                except Exception:
                    return response_dict.get("choices", [])

            @staticmethod
            def _choice_content(choice):
                if isinstance(choice, dict):
                    message = choice.get("message")
                    if isinstance(message, dict):
                        return message.get("content")
                    return choice.get("text")
                message = getattr(choice, "message", None)
                if isinstance(message, dict):
                    return message.get("content")
                if message is not None:
                    return getattr(message, "content", None)
                return getattr(choice, "text", None)

            @staticmethod
            def _choice_finish_reason(choice):
                if isinstance(choice, dict):
                    return choice.get("finish_reason")
                return getattr(choice, "finish_reason", None)

            @staticmethod
            def _hidden_cost(response):
                try:
                    return response.get("_hidden_params", {}).get("response_cost")
                except Exception:
                    return None

            @staticmethod
            def _should_retry(outputs, finish_reasons):
                return any(
                    (content is None or content == "") and reason == "length"
                    for content, reason in zip(outputs, finish_reasons)
                )

            @staticmethod
            def _double_max_tokens(kwargs):
                try:
                    doubled = int(kwargs.get("max_tokens")) * 2
                except (TypeError, ValueError):
                    return None
                return doubled if doubled > 0 else None

            def _request_once(self, completion, messages, kwargs):
                response = completion(storm_lm.ujson.dumps(dict(model=self.model, messages=messages, **kwargs)))
                response_dict = self._response_dict(response)
                self.log_usage(response_dict)
                choices = self._choices(response, response_dict)
                outputs = [self._choice_content(choice) for choice in choices]
                finish_reasons = [self._choice_finish_reason(choice) for choice in choices]
                return response, response_dict, outputs, finish_reasons

            def __call__(self, prompt=None, messages=None, **kwargs):
                cache = kwargs.pop("cache", self.cache)
                messages = messages or [{"role": "user", "content": prompt}]
                kwargs = {**self.kwargs, **kwargs}
                completion = self._completion_fn(cache)

                response, response_dict, outputs, finish_reasons = self._request_once(completion, messages, kwargs)
                retried = False
                if self._should_retry(outputs, finish_reasons):
                    doubled = self._double_max_tokens(kwargs)
                    if doubled:
                        retry_kwargs = {**kwargs, "max_tokens": doubled}
                        print(f"[SafeLitellmModel] empty content with finish_reason=length; retrying once with max_tokens={doubled}")
                        response, response_dict, outputs, finish_reasons = self._request_once(completion, messages, retry_kwargs)
                        kwargs = retry_kwargs
                        retried = True
                    else:
                        print("[SafeLitellmModel] empty content with finish_reason=length; max_tokens unavailable, skip retry")

                if any(content is None for content in outputs):
                    print(f"[SafeLitellmModel] warning: provider returned None content after {'retry' if retried else 'request'}; using empty string")
                outputs = ["" if content is None else content for content in outputs]

                safe_kwargs = {k: v for k, v in kwargs.items() if not k.startswith("api_")}
                usage = response_dict.get("usage", {})
                entry = dict(
                    prompt=prompt,
                    messages=messages,
                    kwargs=safe_kwargs,
                    response=response_dict,
                    outputs=outputs,
                    usage=dict(usage) if isinstance(usage, dict) else {},
                    finish_reasons=finish_reasons,
                    retried=retried,
                )
                cost = self._hidden_cost(response)
                if cost is not None:
                    entry["cost"] = cost
                self.history.append(entry)

                return outputs

        mk = _model_key(job.get("model"))
        if mk in ("hunyuan", "zai", "kimi", "longcat", "volcengine"):
            key, base, model_name = _openai_spec(mk)
            kw = {"api_key": key, "api_base": base, "temperature": 1.0, "top_p": 0.9}
            fast = SafeLitellmModel(model=f"openai/{model_name}", max_tokens=3000, **kw)
            smart = SafeLitellmModel(model=f"openai/{model_name}", max_tokens=8000, **kw)
        else:
            if not DEEPSEEK_KEY:
                raise RuntimeError("~/agent-harnesses/harness.env 缺 DEEPSEEK_API_KEY")
            os.environ["DEEPSEEK_API_KEY"] = DEEPSEEK_KEY
            os.environ.pop("OPENAI_API_KEY", None)   # 防宿主 shell 的别家 key 干扰 litellm 路由
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
        sys.exit("用法: storm_client.py submit <topic> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine] | run|progress|result <job_id>")
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
