#!/usr/bin/env python3
"""
DeerFlow Bridge Client — CodeWhale ↔ DeerFlow Gateway 桥接

用法：
  # 提交深度研究任务（阻塞等待）
  python deerflow_client.py research "深度分析 AMD AI 芯片竞争格局"

  # 提交并后台执行
  python deerflow_client.py submit "CORZ vs MARA 对比分析"
  python deerflow_client.py poll <thread_id> --timeout 600

  # 检查 Gateway 状态
  python deerflow_client.py status

  # 查看任务列表
  python deerflow_client.py list

  # 获取结果
  python deerflow_client.py result <thread_id>

  # 快速问答（不阻塞）
  python deerflow_client.py ask "AMD 最新股价多少"

配置（环境变量，可选）：
  DEERFLOW_BASE_URL   Gateway 地址 (默认 http://127.0.0.1:8002)
  DEERFLOW_OUTPUT_DIR  报告输出目录 (默认 ~/deerflow-output/)
  DEERFLOW_TIMEOUT     最长等待秒数 (默认 600)
  DEERFLOW_NO_AUTONOMY 设为 1 时关闭 submit 自主执行指令注入
"""

import argparse
import ast
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import tomllib
from pathlib import Path
from typing import Optional
from urllib.parse import urljoin

import requests

# ── 常量 ──────────────────────────────────────────────
BASE_URL = os.environ.get("DEERFLOW_BASE_URL", "http://127.0.0.1:8002")
OUTPUT_DIR = Path(os.environ.get("DEERFLOW_OUTPUT_DIR", os.path.expanduser("~/deerflow-output/")))
DEFAULT_TIMEOUT = int(os.environ.get("DEERFLOW_TIMEOUT", "600"))
GATEWAY_DIR = Path(os.environ.get("DEERFLOW_DIR", os.path.expanduser("~/deer-flow-tmp")))
COOKIE_JAR = Path(os.environ.get("DEERFLOW_COOKIE", os.path.expanduser("~/.deerflow_cookies.txt")))
CODEWHALE_CFG = Path(os.path.expanduser("~/.codewhale/config.toml"))

# 本地 gateway 管理员凭据(首次调用自动创建;服务仅绑 127.0.0.1)。可经环境变量覆盖默认值。
ADMIN_EMAIL = os.environ.get("DEERFLOW_ADMIN_EMAIL", "admin@deerflow.io")
ADMIN_PASSWORD = os.environ.get("DEERFLOW_ADMIN_PASSWORD", "DeerFlow2026!")

AUTONOMY_INSTRUCTION = (
    "（执行要求：全程自主完成，不要调用 ask_clarification 或向用户提问；"
    "遇到不确定项自行做合理假设并在报告开头列出。"
    "最终必须把完整报告写入 /mnt/user-data/outputs/ 下的 .md 文件，"
    "并在最后一条消息给出报告要点摘要。）"
)
CONTINUE_PROMPT = (
    "无需澄清，按以下默认继续：输出写入文件的完整深度研究报告"
    "（/mnt/user-data/outputs/ 下 .md），美元计价，所有未确认项按合理假设处理"
    "并在报告开头注明。请直接完成，不要再提问。"
)
MIN_SUBSTANTIVE_CHARS = 800
MAX_CONTINUES_PER_THREAD = 2


class ThreadNotFound(RuntimeError):
    pass


# ── Gateway 生命周期 ──────────────────────────────────
def is_gateway_alive() -> bool:
    try:
        r = requests.get(f"{BASE_URL}/api/v1/auth/setup-status", timeout=5)
        return r.status_code == 200
    except requests.ConnectionError:
        return False


def _codewhale_custom():
    try:
        cfg = tomllib.loads(CODEWHALE_CFG.read_text())
        custom = (cfg.get("providers") or {}).get("custom") or {}
        return custom.get("api_key") or "", (custom.get("base_url") or "https://tokenhub.tencentmaas.com/v1").rstrip("/")
    except Exception:
        return "", "https://tokenhub.tencentmaas.com/v1"


def _codewhale_moonshot():
    try:
        cfg = tomllib.loads(CODEWHALE_CFG.read_text())
        moonshot = (cfg.get("providers") or {}).get("moonshot") or {}
        return (
            (moonshot.get("api_key") or "").strip(),
            (moonshot.get("base_url") or "https://api.kimi.com/coding/v1").rstrip("/"),
            (moonshot.get("model") or "kimi-for-coding").strip(),
        )
    except Exception:
        return "", "https://api.kimi.com/coding/v1", "kimi-for-coding"


def _codewhale_deepseek():
    try:
        cfg = tomllib.loads(CODEWHALE_CFG.read_text())
        providers = cfg.get("providers") or {}
        deepseek = providers.get("deepseek") or {}
        key = (deepseek.get("api_key") or "").strip()
        if not key and (cfg.get("provider") or "").strip() == "deepseek":
            key = (cfg.get("api_key") or "").strip()
        return key
    except Exception:
        return ""


def _codewhale_glm():
    try:
        cfg = tomllib.loads(CODEWHALE_CFG.read_text())
        zai = (cfg.get("providers") or {}).get("zai") or {}
        return (zai.get("api_key") or "").strip()
    except Exception:
        return ""


def _update_model_block(model_name: str, *, api_key: str = "", base_url: str = "", model: str = "", display_name: str = "") -> bool:
    cfg = GATEWAY_DIR / "config.yaml"
    if not cfg.exists():
        return False
    lines = cfg.read_text().splitlines()
    changed = False
    i = 0
    while i < len(lines):
        if not lines[i].startswith("- api_key:"):
            i += 1
            continue
        j = i + 1
        while j < len(lines) and not lines[j].startswith("- api_key:"):
            j += 1
        block = lines[i:j]
        if any(ln.strip() == f"name: {model_name}" for ln in block):
            for k in range(i, j):
                stripped = lines[k].strip()
                prefix = lines[k][:len(lines[k]) - len(lines[k].lstrip())]
                new = None
                if api_key and lines[k].startswith("- api_key:"):
                    new = f"- api_key: {api_key}"
                elif base_url and stripped.startswith("base_url:"):
                    new = f"{prefix}base_url: {base_url}"
                elif model and stripped.startswith("model:"):
                    new = f"{prefix}model: {model}"
                elif display_name and stripped.startswith("display_name:"):
                    new = f"{prefix}display_name: {display_name}"
                if new is not None and lines[k] != new:
                    lines[k] = new
                    changed = True
            break
        i = j
    if changed:
        cfg.write_text("\n".join(lines) + "\n")
        os.chmod(cfg, 0o600)
    return changed


def _sync_hunyuan_config() -> bool:
    """Keep DeerFlow's hunyuan block aligned with CodeWhale's custom provider key."""
    key, base = _codewhale_custom()
    if not key:
        return False
    return _update_model_block("hunyuan", api_key=key, base_url=base)


def _sync_kimi_config() -> bool:
    """Keep DeerFlow's kimi block aligned with CodeWhale's moonshot provider."""
    key, base, model = _codewhale_moonshot()
    if not key:
        return False
    return _update_model_block(
        "kimi",
        api_key=key,
        base_url=base,
        model=model,
        display_name=f"Kimi ({model})",
    )


def _sync_deepseek_config() -> bool:
    """Keep DeerFlow's deepseek block aligned with CodeWhale's deepseek provider key."""
    key = _codewhale_deepseek()
    if not key:
        return False
    return _update_model_block("deepseek", api_key=key)


def _sync_glm_config() -> bool:
    """Keep DeerFlow's glm block aligned with CodeWhale's zai provider key."""
    key = _codewhale_glm()
    if not key:
        return False
    return _update_model_block("glm", api_key=key)


def _stop_gateway():
    try:
        r = subprocess.run(["lsof", "-tiTCP:%s" % _port_from_url(), "-sTCP:LISTEN"],
                           capture_output=True, text=True, timeout=5)
        for pid in [p for p in r.stdout.splitlines() if p.strip().isdigit()]:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except Exception:
                pass
        time.sleep(1.5)
    except Exception:
        pass


def start_gateway():
    """启动 Gateway（如未运行）"""
    config_changed = False
    for sync in (
        _sync_hunyuan_config,
        _sync_kimi_config,
        _sync_deepseek_config,
        _sync_glm_config,
    ):
        config_changed = sync() or config_changed
    if is_gateway_alive() and not config_changed:
        return True
    if is_gateway_alive() and config_changed:
        _stop_gateway()

    log_dir = GATEWAY_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    for d in [".deer-flow/data", "backend/.deer-flow", "backend/sandbox"]:
        (GATEWAY_DIR / d).mkdir(parents=True, exist_ok=True)

    uv = shutil.which("uv") or "/opt/homebrew/bin/uv" or "uv"
    subprocess.Popen(
        [
            uv, "run", "uvicorn", "app.gateway.app:app",
            "--host", "127.0.0.1", "--port", str(_port_from_url()),
        ],
        cwd=str(GATEWAY_DIR / "backend"),
        env={**os.environ, "PYTHONPATH": ".", "DEER_FLOW_PROJECT_ROOT": str(GATEWAY_DIR)},
        stdin=subprocess.DEVNULL,
        stdout=open(log_dir / "gateway.log", "a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
        close_fds=True,
    )

    # 等待就绪
    for _ in range(30):
        time.sleep(1)
        if is_gateway_alive():
            return True
    return False


def _port_from_url() -> int:
    from urllib.parse import urlparse
    port = urlparse(BASE_URL).port
    return port or 8002


# ── 认证 ──────────────────────────────────────────────
def _get_cookies() -> dict:
    """获取认证 cookie，必要时登录"""
    if COOKIE_JAR.exists():
        try:
            data = json.loads(COOKIE_JAR.read_text())
            # 验证 cookie 未过期
            r = requests.get(
                f"{BASE_URL}/api/threads",
                cookies={"access_token": data["access_token"], "csrf_token": data["csrf_token"]},
                timeout=5,
            )
            if r.status_code == 200:
                return {"access_token": data["access_token"], "csrf_token": data["csrf_token"]}
        except Exception:
            pass

    return _login()


def _login() -> dict:
    """登录 DeerFlow Gateway"""
    # Step 1: 获取 CSRF cookie（setup-status 不需要认证）
    s = requests.Session()
    r = s.get(f"{BASE_URL}/api/v1/auth/setup-status", timeout=5)
    status = r.json()

    # 如果是首次启动，初始化管理员
    if status.get("needs_setup"):
        print("[deerflow] 首次启动，正在初始化管理员...")
        r = s.post(
            f"{BASE_URL}/api/v1/auth/initialize",
            json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD, "name": "Felix"},
            timeout=10,
        )
        if r.status_code == 201:
            print("[deerflow] 管理员创建成功")
        elif r.status_code == 409:
            print("[deerflow] 管理员已存在")
        else:
            print(f"[deerflow] 初始化失败: {r.status_code} {r.text[:200]}")

        # 重新获取 CSRF
        s = requests.Session()
        s.get(f"{BASE_URL}/api/v1/auth/setup-status", timeout=5)

    # Step 2: 登录
    r = s.post(
        f"{BASE_URL}/api/v1/auth/login/local",
        data={"username": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    if r.status_code != 200:
        raise RuntimeError(f"登录失败: {r.status_code} {r.text[:200]}")

    # 提取 cookies
    cookies = {}
    for c in s.cookies:
        cookies[c.name] = c.value

    # 持久化
    COOKIE_JAR.parent.mkdir(parents=True, exist_ok=True)
    COOKIE_JAR.write_text(json.dumps({
        "access_token": cookies.get("access_token", ""),
        "csrf_token": cookies.get("csrf_token", ""),
    }))

    return cookies


def _csrf_token(cookies: dict) -> str:
    return cookies.get("csrf_token", "")


def _autonomy_enabled() -> bool:
    return os.environ.get("DEERFLOW_NO_AUTONOMY", "") != "1"


def _with_autonomy_instruction(prompt: str) -> str:
    prompt = prompt or ""
    if not _autonomy_enabled() or AUTONOMY_INSTRUCTION in prompt:
        return prompt
    return f"{prompt.rstrip()}\n\n---\n\n{AUTONOMY_INSTRUCTION}"


def _run_payload(prompt: str, model: str = "", *, add_autonomy: bool = True) -> dict:
    content = _with_autonomy_instruction(prompt) if add_autonomy else (prompt or "")
    payload = {"input": {"messages": [{"role": "user", "content": content}]}}
    config = {}
    if model:
        config["model"] = model
    # 默认设置递归限制为 1000，避免循环
    config["recursion_limit"] = 1000
    if config:
        payload["config"] = {"configurable": config}
    return payload


def _create_run(thread_id: str, prompt: str, model: str = "", *, cookies: Optional[dict] = None,
                add_autonomy: bool = True) -> dict:
    cookies = cookies or _get_cookies()
    csrf = _csrf_token(cookies)
    r = requests.post(
        f"{BASE_URL}/api/threads/{thread_id}/runs",
        json=_run_payload(prompt, model, add_autonomy=add_autonomy),
        cookies=cookies,
        headers={"X-CSRF-Token": csrf},
        timeout=10,
    )
    if r.status_code == 404:
        raise ThreadNotFound(f"thread 不存在: {thread_id}")
    r.raise_for_status()
    return r.json()


def _continue_count_path(thread_id: str) -> Path:
    safe_tid = re.sub(r"[^A-Za-z0-9_.-]", "_", thread_id)
    return OUTPUT_DIR / ".continues" / f"{safe_tid}.count"


def _read_continue_count(thread_id: str) -> int:
    try:
        return int(_continue_count_path(thread_id).read_text().strip() or "0")
    except Exception:
        return 0


def _write_continue_count(thread_id: str, count: int) -> None:
    path = _continue_count_path(thread_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(count))


def _start_continuation(thread_id: str, model: str = "") -> dict:
    count = _read_continue_count(thread_id)
    if count >= MAX_CONTINUES_PER_THREAD:
        return {"ok": False, "over_limit": True, "count": count}
    run = _create_run(thread_id, CONTINUE_PROMPT, model=model)
    count += 1
    _write_continue_count(thread_id, count)
    return {"ok": True, "count": count, "run_id": run.get("run_id", "")}


# ── API 操作 ──────────────────────────────────────────
def submit_task(prompt: str, thread_name: str = "", model: str = "") -> dict:
    """提交研究任务，返回 {thread_id, run_id}"""
    cookies = _get_cookies()
    csrf = _csrf_token(cookies)

    # 创建 thread
    r = requests.post(
        f"{BASE_URL}/api/threads",
        json={"name": thread_name or prompt[:50]},
        cookies=cookies,
        headers={"X-CSRF-Token": csrf},
        timeout=10,
    )
    r.raise_for_status()
    thread_id = r.json()["thread_id"]

    # 创建 run（可选指定模型 + 递归限制）
    run_id = _create_run(thread_id, prompt, model=model, cookies=cookies)["run_id"]

    return {"thread_id": thread_id, "run_id": run_id, "thread_name": thread_name or prompt[:50]}


def poll_run(thread_id: str, run_id: str = "", timeout: int = DEFAULT_TIMEOUT) -> dict:
    """轮询直到 run 完成或超时"""
    cookies = _get_cookies()
    csrf = _csrf_token(cookies)

    deadline = time.time() + timeout

    # 如果没有指定 run_id，获取最新的
    if not run_id:
        r = requests.get(
            f"{BASE_URL}/api/threads/{thread_id}/runs",
            cookies=cookies,
            timeout=10,
        )
        runs = r.json()
        if isinstance(runs, list) and runs:
            run_id = runs[-1].get("run_id", "")
        elif isinstance(runs, dict) and "data" in runs:
            run_id = runs["data"][-1].get("run_id", "") if runs["data"] else ""

        if not run_id:
            return {"status": "error", "error": "No runs found"}

    last_status = ""
    while time.time() < deadline:
        r = requests.get(
            f"{BASE_URL}/api/threads/{thread_id}/runs/{run_id}",
            cookies=cookies,
            timeout=10,
        )
        state = r.json()
        status = state.get("status", "unknown")

        if status != last_status:
            tokens = f"{state.get('total_input_tokens', 0)}/{state.get('total_output_tokens', 0)}"
            print(f"  [{status}] tokens: {tokens} | LLM calls: {state.get('llm_call_count', 0)}")
            last_status = status

        if status in ("success", "error", "failed", "cancelled"):
            return state

        time.sleep(10 if timeout > 60 else 3)

    return {"status": "timeout", "thread_id": thread_id, "run_id": run_id}


def get_messages(thread_id: str, run_id: str = "") -> list:
    """获取 AI 回复消息"""
    items = _get_message_items(thread_id, run_id)
    messages = []
    for ev in items:
        if _message_type(ev) == "ai":
            text = _message_text(ev)
            if text.strip():
                messages.append(text)
    return messages


def _get_message_items(thread_id: str, run_id: str = "") -> list:
    cookies = _get_cookies()
    url = f"{BASE_URL}/api/threads/{thread_id}/runs/{run_id}/messages" if run_id else \
          f"{BASE_URL}/api/threads/{thread_id}/messages"
    r = requests.get(url, cookies=cookies, timeout=10)
    if r.status_code == 404:
        raise ThreadNotFound(f"thread 不存在: {thread_id}")
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, list) else data.get("data", [])


def _message_content_obj(event) -> dict:
    if not isinstance(event, dict):
        return {}
    content = event.get("content")
    return content if isinstance(content, dict) else {}


def _message_type(event) -> str:
    content = _message_content_obj(event)
    return (content.get("type") or content.get("role") or
            (event.get("type") if isinstance(event, dict) else "") or
            (event.get("role") if isinstance(event, dict) else "") or "")


def _text_from_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    return str(value)


def _message_text(event) -> str:
    content = _message_content_obj(event)
    if content:
        return _text_from_value(content.get("content") or content.get("text") or "")
    if isinstance(event, dict):
        return _text_from_value(event.get("text") or event.get("message") or "")
    return ""


def _collect_tool_calls(value, depth: int = 0) -> list:
    if depth > 3 or not isinstance(value, dict):
        return []
    calls = []
    for key in ("tool_calls", "invalid_tool_calls"):
        found = value.get(key)
        if isinstance(found, list):
            calls.extend(found)
    for key in ("additional_kwargs", "kwargs", "content"):
        inner = value.get(key)
        if isinstance(inner, dict):
            calls.extend(_collect_tool_calls(inner, depth + 1))
    return calls


def _tool_call_name(call) -> str:
    if not isinstance(call, dict):
        return ""
    fn = call.get("function")
    return str(call.get("name") or (fn.get("name") if isinstance(fn, dict) else "") or "")


def _tool_call_args(call):
    if not isinstance(call, dict):
        return {}
    args = call.get("args")
    if args is None and isinstance(call.get("function"), dict):
        args = call["function"].get("arguments")
    if isinstance(args, str):
        try:
            return json.loads(args)
        except Exception:
            return {"raw": args}
    return args if isinstance(args, dict) else {}


def _ask_question_from_call(call) -> str:
    if _tool_call_name(call) != "ask_clarification":
        return ""
    args = _tool_call_args(call)
    question = args.get("question") or args.get("context") or args.get("raw") or ""
    if not question and args:
        question = json.dumps(args, ensure_ascii=False)
    return str(question).strip()


def _ai_message_records(items: list) -> list:
    records = []
    for ev in items:
        if _message_type(ev) != "ai":
            continue
        content = _message_content_obj(ev)
        tool_calls = _collect_tool_calls(content)
        if isinstance(ev, dict):
            top_level = {k: v for k, v in ev.items() if k != "content"}
            tool_calls.extend(_collect_tool_calls(top_level))
        records.append({"text": _message_text(ev), "tool_calls": tool_calls})
    return records


def _tool_message_question(items: list) -> str:
    for ev in reversed(items):
        content = _message_content_obj(ev)
        name = content.get("name") or (ev.get("name") if isinstance(ev, dict) else "")
        if _message_type(ev) == "tool" and name == "ask_clarification":
            text = _message_text(ev)
            if text.strip():
                return text.strip()
    return ""


def _truncate_question(text: str, limit: int = 300) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return text[:limit]


def _completion_diagnosis(thread_id: str, run_id: str = "") -> dict:
    reports = _sandbox_reports(thread_id)
    items = _get_message_items(thread_id, run_id)
    ai_records = _ai_message_records(items)
    substantive = []
    for rec in ai_records:
        text = (rec.get("text") or "").strip()
        if not text or text.startswith("## SESSION INTENT"):
            continue
        substantive.append(text)
    total_len = sum(len(s) for s in substantive)
    last_ai = ai_records[-1] if ai_records else {}
    ask_question = ""
    last_has_ask = False
    for call in last_ai.get("tool_calls", []):
        if _tool_call_name(call) == "ask_clarification":
            last_has_ask = True
            ask_question = _ask_question_from_call(call) or ask_question
    ask_question = ask_question or _tool_message_question(items)
    incomplete = (not reports) and (last_has_ask or total_len < MIN_SUBSTANTIVE_CHARS)
    reason = "ask_clarification" if last_has_ask else ("short_output" if incomplete else "")
    return {
        "reports": reports,
        "substantive_messages": substantive,
        "substantive_chars": total_len,
        "last_has_ask_clarification": last_has_ask,
        "ask_question": ask_question,
        "incomplete": incomplete,
        "reason": reason,
    }


def save_result(thread_id: str, messages: list, topic: str = "") -> Path:
    """保存结果到文件"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    name = topic[:40].replace(" ", "_").replace("/", "_") if topic else thread_id[:8]
    fname = f"deerflow_{name}_{time.strftime('%Y%m%d-%H%M%S')}.md"
    path = OUTPUT_DIR / fname

    with open(path, "w") as f:
        f.write(f"# DeerFlow 深度研究报告\n\n")
        f.write(f"- **Thread**: `{thread_id}`\n")
        f.write(f"- **时间**: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"- **话题**: {topic}\n\n")
        f.write("---\n\n")
        for i, msg in enumerate(messages, 1):
            f.write(msg)
            f.write("\n\n")

    return path


# ── 命令入口 ──────────────────────────────────────────
def cmd_research(args):
    """完整的深度研究流程：提交 → 等待 → 保存 → 输出"""
    if not start_gateway():
        print("[deerflow] Gateway 未运行，正在启动...")
        print("[deerflow] ❌ Gateway 启动失败")
        sys.exit(1)

    prompt = args.prompt
    topic = args.name or prompt[:50]
    model = getattr(args, 'model', '') or ''

    if model:
        print(f"🤖 模型: {model}")
    print(f"\n🔬 DeerFlow 深度研究")
    print(f"📝 问题: {prompt[:100]}{'...' if len(prompt) > 100 else ''}")
    print(f"⏳ 提交任务...")

    task = submit_task(prompt, thread_name=topic, model=model)
    print(f"📋 Thread: {task['thread_id'][:8]}...")
    print(f"⏱️  等待完成 (最长 {args.timeout}s)...\n")

    state = poll_run(task["thread_id"], task["run_id"], timeout=args.timeout)

    if state.get("status") == "success":
        print("\n✅ 研究完成！获取结果...\n")
        messages = get_messages(task["thread_id"], task["run_id"])

        if messages:
            path = save_result(task["thread_id"], messages, topic)
            print(f"📄 报告已保存: {path}")

            # 输出摘要
            print("\n" + "=" * 60)
            for msg in messages:
                # 只显示前 2000 字符
                print(msg[:2000])
                if len(msg) > 2000:
                    print(f"\n... (共 {len(msg)} 字符，完整报告见 {path})")
            print("=" * 60)

            # Token 统计
            tokens_in = state.get("total_input_tokens", 0)
            tokens_out = state.get("total_output_tokens", 0)
            llm_calls = state.get("llm_call_count", 0)
            print(f"\n📊 统计: {tokens_in:,} in / {tokens_out:,} out | {llm_calls} LLM calls")
        else:
            print("⚠️ 无 AI 回复内容")

    elif state.get("status") == "timeout":
        print(f"\n⚠️ 超时 (>{args.timeout}s)")
        print(f"   Thread: {task['thread_id']}")
        print(f"   稍后可用以下命令获取结果:")
        print(f"   python deerflow_client.py result {task['thread_id']}")

    else:
        print(f"\n❌ 研究失败: {state.get('status')}")
        error = state.get("error", "")
        if error:
            print(f"   错误: {error}")


def cmd_submit(args):
    """提交任务后立即返回"""
    if not start_gateway():
        print(json.dumps({"ok": False, "error": "Gateway 启动失败"}, ensure_ascii=False))
        return

    model = getattr(args, 'model', '') or ''
    task = submit_task(args.prompt, thread_name=args.name or args.prompt[:50], model=model)
    print(f"✅ 任务已提交")
    print(f"   Thread: {task['thread_id']}")
    print(f"   Run:    {task['run_id']}")
    print(f"\n   轮询: python deerflow_client.py poll {task['thread_id']}")
    print(f"   结果: python deerflow_client.py result {task['thread_id']}")


def cmd_poll(args):
    """轮询已有任务"""
    state = poll_run(args.thread_id, timeout=args.timeout)
    if state.get("status") == "success":
        messages = get_messages(args.thread_id)
        if messages:
            print(messages[0][:2000])
    elif state.get("status") == "timeout":
        print(f"⏳ 仍在运行中，稍后重试")
        sys.exit(1)
    else:
        print(f"状态: {state.get('status')}")


def _redact_error_text(text: str) -> str:
    text = re.sub(r"sk-[A-Za-z0-9_-]{8,}", "sk-<redacted>", text)
    text = re.sub(r"Bearer\s+[^\s,}\]]+", "Bearer <redacted>", text)
    return text


def _error_message_from_obj(value) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        inner = value.get("error")
        if inner is not None:
            msg = _error_message_from_obj(inner)
            if msg:
                return msg
        for key in ("message", "detail", "error_message", "exception"):
            msg = _error_message_from_obj(value.get(key))
            if msg:
                code = value.get("code") or value.get("type")
                return f"{msg} ({code})" if code else msg
        return ""
    if isinstance(value, list):
        for item in reversed(value):
            msg = _error_message_from_obj(item)
            if msg:
                return msg
        return ""
    text = str(value).strip()
    if not text:
        return ""
    for candidate in (text, text.split(" - ", 1)[-1]):
        candidate = candidate.strip()
        if not (candidate.startswith("{") or candidate.startswith("[")):
            continue
        try:
            parsed = json.loads(candidate)
        except Exception:
            try:
                parsed = ast.literal_eval(candidate)
            except Exception:
                continue
        msg = _error_message_from_obj(parsed)
        if msg:
            prefix = text.split(" - ", 1)[0].strip() if " - " in text else ""
            return f"{prefix} - {msg}" if prefix else msg
    return text


def _lookup_run_record(thread_id: str, run_id: str = "") -> dict:
    db_path = GATEWAY_DIR / "backend" / ".deer-flow" / "data" / "deerflow.db"
    if not db_path.exists():
        return {}
    try:
        import sqlite3
        with sqlite3.connect(str(db_path)) as con:
            con.row_factory = sqlite3.Row
            if run_id:
                row = con.execute(
                    """
                    select run_id, status, error, total_input_tokens, total_output_tokens,
                           llm_call_count, message_count
                    from runs where run_id = ?
                    """,
                    (run_id,),
                ).fetchone()
            else:
                row = con.execute(
                    """
                    select run_id, status, error, total_input_tokens, total_output_tokens,
                           llm_call_count, message_count
                    from runs where thread_id = ? order by updated_at desc limit 1
                    """,
                    (thread_id,),
                ).fetchone()
        return dict(row) if row else {}
    except Exception:
        return {}


def _lookup_run_error(thread_id: str, run_id: str = "") -> str:
    record = _lookup_run_record(thread_id, run_id)
    if record:
        return (record.get("error") or "").strip()
    return ""


def _apply_db_run_snapshot(out: dict, thread_id: str, run_id: str = "") -> str:
    record = _lookup_run_record(thread_id, run_id)
    if not record:
        return ""
    rid = record.get("run_id") or run_id
    out["status"] = record.get("status") or out.get("status", "unknown")
    out["in_tokens"] = record.get("total_input_tokens") or 0
    out["out_tokens"] = record.get("total_output_tokens") or 0
    out["llm_calls"] = record.get("llm_call_count") or 0
    out["msg_count"] = record.get("message_count") or out.get("msg_count", 0)
    if out.get("status") in ("error", "failed", "cancelled"):
        out["error"] = _run_error_text(thread_id, rid, record) or f"Run ended with status: {out['status']}"
    return rid


def _run_error_text(thread_id: str, run_id: str, *states: dict) -> str:
    for state in states:
        if not isinstance(state, dict):
            continue
        for value in (
            state.get("error"),
            state.get("exception"),
            state.get("detail"),
            (state.get("metadata") or {}).get("error") if isinstance(state.get("metadata"), dict) else None,
        ):
            msg = _error_message_from_obj(value)
            if msg:
                return _redact_error_text(msg)[-2000:]
    msg = _error_message_from_obj(_lookup_run_error(thread_id, run_id))
    return _redact_error_text(msg)[-2000:] if msg else ""


def _thread_not_found_error(thread_id: str) -> dict:
    return {"status": "error", "error": f"thread 不存在: {thread_id}"}


def _local_thread_known(thread_id: str) -> bool:
    if _lookup_run_record(thread_id):
        return True
    try:
        import glob
        patterns = [
            GATEWAY_DIR / ".deer-flow" / "users" / "*" / "threads" / thread_id,
            GATEWAY_DIR / "backend" / ".deer-flow" / "users" / "*" / "threads" / thread_id,
        ]
        return any(glob.glob(str(pat)) for pat in patterns)
    except Exception:
        return False



_ACTIVE_RUN_STATES = ("running", "pending", "queued", "created", "in_progress")

def _pick_current_run(runs: list) -> dict:
    """网关 runs 列表新→旧排序。优先取活跃 run(有 run 在飞时状态应为 running,绝不再触发续跑);
    否则取最新完成的 run(按 created_at 兜底,取不到就取列表第一个)。"""
    if not runs:
        return {}
    for x in runs:
        if str(x.get("status", "")).lower() in _ACTIVE_RUN_STATES:
            return x
    try:
        return max(runs, key=lambda x: str(x.get("created_at") or ""))
    except Exception:
        return runs[0]

def _fetch_runs(thread_id: str, cookies: dict) -> list:
    r = requests.get(f"{BASE_URL}/api/threads/{thread_id}/runs", cookies=cookies, timeout=10)
    if r.status_code == 404:
        raise ThreadNotFound(f"thread 不存在: {thread_id}")
    r.raise_for_status()
    data = r.json()
    runs = data if isinstance(data, list) else data.get("data", [])
    if not runs:
        raise ThreadNotFound(f"thread 不存在: {thread_id}")
    return runs


def _incomplete_error_text(diagnosis: dict) -> str:
    question = _truncate_question(diagnosis.get("ask_question") or "")
    if question:
        return f"自动续跑已达上限，模型澄清问题: {question}"
    if diagnosis.get("reason") == "short_output":
        return "自动续跑已达上限，仍未产生足够实质输出"
    return "自动续跑已达上限，任务未产生完整报告"


def cmd_progress(args):
    """一次性进度快照(JSON):run 状态 + tokens + LLM 调用数 + 最新中间消息尾部。
    供 GUI 轮询展示"过程推理进展"——不阻塞(poll 会等到状态变化/超时,这个立即返回)。"""
    tid = args.thread_id
    out = {"status": "pending", "in_tokens": 0, "out_tokens": 0, "llm_calls": 0, "msg_count": 0, "tail": ""}
    try:
        cookies = _get_cookies()
        latest_run = {}
        run_state = {}
        rid = ""
        runs = _fetch_runs(tid, cookies)
        latest_run = _pick_current_run(runs)
        rid = latest_run.get("run_id", "")
        r = requests.get(f"{BASE_URL}/api/threads/{tid}/runs/{rid}", cookies=cookies, timeout=10)
        if r.status_code == 404:
            raise ThreadNotFound(f"thread 不存在: {tid}")
        r.raise_for_status()
        run_state = r.json()
        out["status"] = run_state.get("status", "unknown")
        out["in_tokens"] = run_state.get("total_input_tokens", 0)
        out["out_tokens"] = run_state.get("total_output_tokens", 0)
        out["llm_calls"] = run_state.get("llm_call_count", 0)
        reports = _sandbox_reports(tid)
        if reports:
            out["has_report"] = True
            out["report_path"] = reports[0]
        msgs = _substantive_messages(get_messages(tid))   # 中间消息边跑边累积(planner/researcher 阶段产出)→ 取最新一条尾部当"进展"
        out["msg_count"] = len(msgs)
        if msgs:
            out["tail"] = msgs[-1][-2000:]
        msg_chars = sum(len((m or "").strip()) for m in msgs)
        if out.get("status") in ("error", "failed", "cancelled") and (reports or msg_chars >= MIN_SUBSTANTIVE_CHARS):
            out["recovered_from_status"] = out["status"]
            out["status"] = "success"
        if out.get("status") == "success":
            diagnosis = _completion_diagnosis(tid)
            out["substantive_chars"] = diagnosis["substantive_chars"]
            if diagnosis["reports"]:
                out["has_report"] = True
                out["report_path"] = diagnosis["reports"][0]
            elif diagnosis["incomplete"]:
                out["completion_guard"] = diagnosis["reason"]
                model = run_state.get("model_name") or latest_run.get("model_name") or ""
                try:
                    continuation = _start_continuation(tid, model=model)
                except Exception as e:
                    if "409" in str(e):   # 线程已有 run 在飞(并发轮询窗口) → 良性,按 running 处理
                        out["status"] = "running"
                        out["auto_continue_pending"] = True
                        continuation = {}
                    else:
                        out["status"] = "error"
                        out["error"] = f"自动续跑失败: {str(e)[:200]}"
                        continuation = {}
                if continuation.get("ok"):
                    out["status"] = "running"
                    out["auto_continue"] = True
                    out["continue_count"] = continuation["count"]
                    out["continued_run_id"] = continuation.get("run_id", "")
                    if diagnosis.get("ask_question"):
                        out["ask_clarification"] = _truncate_question(diagnosis["ask_question"])
                elif continuation:
                    out["status"] = "error"
                    out["continue_count"] = continuation.get("count", MAX_CONTINUES_PER_THREAD)
                    out["error"] = _incomplete_error_text(diagnosis)
        if out.get("status") in ("error", "failed", "cancelled") and not out.get("error"):
            out["error"] = _run_error_text(tid, rid, run_state, latest_run) or f"Run ended with status: {out['status']}"
    except ThreadNotFound:
        out = _thread_not_found_error(tid)
    except Exception as e:
        if isinstance(e, requests.RequestException) and not _local_thread_known(tid):
            out = _thread_not_found_error(tid)
        elif not _apply_db_run_snapshot(out, tid):
            out["status"] = "error"
            out["error"] = str(e)[:200]
    print(json.dumps(out, ensure_ascii=False))


def _sandbox_reports(thread_id: str) -> list:
    """DeerFlow lead agent 常把最终报告写进 sandbox(/mnt/user-data/outputs/**),宿主路径在
    .deer-flow/users/*/threads/<tid>/user-data/outputs/ 下 —— 这才是真报告,
    消息流里的 ai 消息大多是记忆检查点(SESSION INTENT)等内务噪音。返回按修改时间倒序的 .md 列表。"""
    import glob
    patterns = [
        GATEWAY_DIR / ".deer-flow" / "users" / "*" / "threads" / thread_id / "user-data" / "outputs" / "**" / "*.md",
        GATEWAY_DIR / "backend" / ".deer-flow" / "users" / "*" / "threads" / thread_id / "user-data" / "outputs" / "**" / "*.md",
    ]
    files = []
    for pat in patterns:
        files.extend(glob.glob(str(pat), recursive=True))
    files = list(dict.fromkeys(files))
    files.sort(key=os.path.getmtime, reverse=True)
    return files


def _substantive_messages(messages: list) -> list:
    """过滤 lead agent 的内务消息:SESSION INTENT/SUMMARY 记忆检查点、空串。保留真正面向用户的回答。"""
    out = []
    for m in messages:
        s = (m or "").strip()
        if not s or s.startswith("## SESSION INTENT"):
            continue
        out.append(m)
    return out


def cmd_result(args):
    """获取已有任务结果:优先 sandbox 里的报告文件(真报告),其次取最长的实质 ai 消息"""
    # 获取 run 列表
    try:
        cookies = _get_cookies()
        runs = _fetch_runs(args.thread_id, cookies)
    except ThreadNotFound:
        print(json.dumps(_thread_not_found_error(args.thread_id), ensure_ascii=False))
        sys.exit(1)
    except requests.RequestException as e:
        if not _local_thread_known(args.thread_id):
            print(json.dumps(_thread_not_found_error(args.thread_id), ensure_ascii=False))
        else:
            print(json.dumps({"status": "error", "error": str(e)[:200]}, ensure_ascii=False))
        sys.exit(1)

    latest = _pick_current_run(runs)
    run_id = latest.get("run_id", "")
    status = latest.get("status", "?")

    print(f"状态: {status}")
    sb = _sandbox_reports(args.thread_id)
    if sb:
        content = open(sb[0], errors="replace").read()
        print("\n" + content)
        save_result(args.thread_id, [content], f"thread_{args.thread_id[:8]}")
        return

    diagnosis = _completion_diagnosis(args.thread_id, run_id) if status == "success" else {"incomplete": False}
    if diagnosis["incomplete"]:
        model = latest.get("model_name") or ""
        try:
            continuation = _start_continuation(args.thread_id, model=model)
        except Exception as e:
            print(f"自动续跑失败: {str(e)[:200]}")
            sys.exit(1)
        if continuation.get("ok"):
            print(f"未检测到完整报告，已自动续跑: {continuation.get('run_id', '')}")
            print(f"续跑次数: {continuation.get('count', 0)}/{MAX_CONTINUES_PER_THREAD}")
        else:
            print(_incomplete_error_text(diagnosis))
        sys.exit(1)

    messages = _substantive_messages(get_messages(args.thread_id, run_id))
    if messages:
        final = max(messages, key=lambda s: len(s or ""))   # DeerFlow 最后一条常是"报告已完成"摘要,最长消息更像真报告
        print("\n" + final)
        save_result(args.thread_id, [final], f"thread_{args.thread_id[:8]}")
    else:
        print("(无输出内容)")


def cmd_status(args):
    """检查 Gateway 状态"""
    alive = is_gateway_alive()
    print(f"Gateway ({BASE_URL}): {'✅ 运行中' if alive else '❌ 未运行'}")

    if alive:
        r = requests.get(f"{BASE_URL}/api/v1/auth/setup-status", timeout=5)
        print(f"初始化状态: {'✅ 已完成' if not r.json().get('needs_setup') else '⚠️ 待初始化'}")


def cmd_list(args):
    """列出最近的 threads"""
    cookies = _get_cookies()
    r = requests.get(f"{BASE_URL}/api/threads", cookies=cookies, timeout=10)
    data = r.json()

    threads = data if isinstance(data, list) else data.get("data", [])
    print(f"共 {len(threads)} 个线程:\n")
    for t in reversed(threads[-20:]):
        tid = t.get("thread_id", "")[:8]
        status = t.get("status", "?")
        created = t.get("created_at", "")[:19]
        name = t.get("metadata", {}).get("name", "") or (t.get("values", {}) or {}).get("name", "") or "-"
        print(f"  {tid}  [{status:8s}]  {created}  {name[:50]}")


def cmd_ask(args):
    """快速问答（短，非深度研究）"""
    cmd_research(args)


# ── CLI ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="DeerFlow Bridge Client")
    sub = parser.add_subparsers(dest="command", help="命令")

    # research
    p = sub.add_parser("research", aliases=["r"], help="完整深度研究流程")
    p.add_argument("prompt", help="研究问题")
    p.add_argument("--name", "-n", help="任务名称")
    p.add_argument("--model", "-m", default="", help="指定模型 (kimi/glm/claude，默认用 config.yaml 的 default_model)")
    p.add_argument("--timeout", "-t", type=int, default=DEFAULT_TIMEOUT, help="超时秒数")
    p.set_defaults(func=cmd_research)

    # submit
    p = sub.add_parser("submit", aliases=["s"], help="提交任务后立即返回")
    p.add_argument("prompt", help="研究问题")
    p.add_argument("--name", "-n", help="任务名称")
    p.add_argument("--model", "-m", default="", help="指定模型")
    p.set_defaults(func=cmd_submit)

    # poll
    p = sub.add_parser("poll", aliases=["p"], help="轮询任务状态")
    p.add_argument("thread_id", help="Thread ID")
    p.add_argument("--timeout", "-t", type=int, default=300, help="超时秒数")
    p.set_defaults(func=cmd_poll)

    # progress(GUI 过程展示用,一次性 JSON 快照)
    p = sub.add_parser("progress", aliases=["pg"], help="进度快照 JSON(状态+tokens+最新中间消息)")
    p.add_argument("thread_id", help="Thread ID")
    p.set_defaults(func=cmd_progress)

    # result
    p = sub.add_parser("result", aliases=["res"], help="获取任务结果")
    p.add_argument("thread_id", help="Thread ID")
    p.set_defaults(func=cmd_result)

    # status
    p = sub.add_parser("status", aliases=["st"], help="检查 Gateway 状态")
    p.set_defaults(func=cmd_status)

    # list
    p = sub.add_parser("list", aliases=["ls"], help="列出最近 threads")
    p.set_defaults(func=cmd_list)

    # ask
    p = sub.add_parser("ask", help="快速问答")
    p.add_argument("prompt", help="问题")
    p.add_argument("--timeout", "-t", type=int, default=120, help="超时秒数")
    p.set_defaults(func=cmd_ask)

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    args.func(args)


if __name__ == "__main__":
    main()
