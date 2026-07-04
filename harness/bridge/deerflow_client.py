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
"""

import argparse
import json
import os
import subprocess
import sys
import time
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

# 本地 gateway 管理员凭据(首次调用自动创建;服务仅绑 127.0.0.1)。可经环境变量覆盖默认值。
ADMIN_EMAIL = os.environ.get("DEERFLOW_ADMIN_EMAIL", "admin@deerflow.io")
ADMIN_PASSWORD = os.environ.get("DEERFLOW_ADMIN_PASSWORD", "DeerFlow2026!")


# ── Gateway 生命周期 ──────────────────────────────────
def is_gateway_alive() -> bool:
    try:
        r = requests.get(f"{BASE_URL}/api/v1/auth/setup-status", timeout=5)
        return r.status_code == 200
    except requests.ConnectionError:
        return False


def start_gateway():
    """启动 Gateway（如未运行）"""
    if is_gateway_alive():
        return True

    log_dir = GATEWAY_DIR / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    for d in [".deer-flow/data", "backend/.deer-flow", "backend/sandbox"]:
        (GATEWAY_DIR / d).mkdir(parents=True, exist_ok=True)

    subprocess.Popen(
        [
            "uv", "run", "uvicorn", "app.gateway.app:app",
            "--host", "127.0.0.1", "--port", str(_port_from_url()),
        ],
        cwd=str(GATEWAY_DIR / "backend"),
        env={**os.environ, "PYTHONPATH": ".", "DEER_FLOW_PROJECT_ROOT": str(GATEWAY_DIR)},
        stdout=open(log_dir / "gateway.log", "a"),
        stderr=subprocess.STDOUT,
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
    payload = {"input": {"messages": [{"role": "user", "content": prompt}]}}
    config = {}
    if model:
        config["model"] = model
    # 默认设置递归限制为 1000，避免循环
    config["recursion_limit"] = 1000
    if config:
        payload["config"] = {"configurable": config}

    r = requests.post(
        f"{BASE_URL}/api/threads/{thread_id}/runs",
        json=payload,
        cookies=cookies,
        headers={"X-CSRF-Token": csrf},
        timeout=10,
    )
    r.raise_for_status()
    run_id = r.json()["run_id"]

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
    cookies = _get_cookies()
    csrf = _csrf_token(cookies)

    url = f"{BASE_URL}/api/threads/{thread_id}/runs/{run_id}/messages" if run_id else \
          f"{BASE_URL}/api/threads/{thread_id}/messages"

    r = requests.get(url, cookies=cookies, timeout=10)
    data = r.json()

    items = data if isinstance(data, list) else data.get("data", [])
    messages = []
    for ev in items:
        content = ev.get("content", {})
        if isinstance(content, dict) and content.get("type") == "ai":
            text = content.get("content", "")
            if text.strip():
                messages.append(text)
    return messages


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
    if not is_gateway_alive():
        print("[deerflow] Gateway 未运行，正在启动...")
        if not start_gateway():
            print("[deerflow] ❌ Gateway 启动失败")
            sys.exit(1)
        print("[deerflow] ✅ Gateway 已启动")

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
    if not is_gateway_alive():
        start_gateway()

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


def cmd_progress(args):
    """一次性进度快照(JSON):run 状态 + tokens + LLM 调用数 + 最新中间消息尾部。
    供 GUI 轮询展示"过程推理进展"——不阻塞(poll 会等到状态变化/超时,这个立即返回)。"""
    cookies = _get_cookies()
    tid = args.thread_id
    out = {"status": "pending", "in_tokens": 0, "out_tokens": 0, "llm_calls": 0, "msg_count": 0, "tail": ""}
    try:
        r = requests.get(f"{BASE_URL}/api/threads/{tid}/runs", cookies=cookies, timeout=10)
        runs = r.json()
        runs = runs if isinstance(runs, list) else runs.get("data", [])
        if runs:
            rid = runs[-1].get("run_id", "")
            r = requests.get(f"{BASE_URL}/api/threads/{tid}/runs/{rid}", cookies=cookies, timeout=10)
            st = r.json()
            out["status"] = st.get("status", "unknown")
            out["in_tokens"] = st.get("total_input_tokens", 0)
            out["out_tokens"] = st.get("total_output_tokens", 0)
            out["llm_calls"] = st.get("llm_call_count", 0)
        msgs = get_messages(tid)   # 中间消息边跑边累积(planner/researcher 阶段产出)→ 取最新一条尾部当"进展"
        out["msg_count"] = len(msgs)
        if msgs:
            out["tail"] = msgs[-1][-2000:]
    except Exception as e:
        out["error"] = str(e)[:200]
    print(json.dumps(out, ensure_ascii=False))


def _sandbox_reports(thread_id: str) -> list:
    """DeerFlow lead agent 常把最终报告写进 sandbox(/mnt/user-data/outputs/**),宿主路径在
    backend/.deer-flow/users/*/threads/<tid>/user-data/outputs/ 下 —— 这才是真报告,
    消息流里的 ai 消息大多是记忆检查点(SESSION INTENT)等内务噪音。返回按修改时间倒序的 .md 列表。"""
    import glob
    pat = str(GATEWAY_DIR / "backend" / ".deer-flow" / "users" / "*" / "threads" / thread_id / "user-data" / "outputs" / "**" / "*.md")
    files = [f for f in glob.glob(pat, recursive=True)]
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
    """获取已有任务结果:优先 sandbox 里的报告文件(真报告),其次过滤后的最后一条实质 ai 消息"""
    cookies = _get_cookies()
    csrf = _csrf_token(cookies)

    # 获取 run 列表
    r = requests.get(f"{BASE_URL}/api/threads/{args.thread_id}/runs", cookies=cookies, timeout=10)
    runs = r.json() if isinstance(r.json(), list) else r.json().get("data", [])

    if not runs:
        print("⚠️ 该 thread 无 run 记录")
        sys.exit(1)

    latest = runs[-1]
    run_id = latest.get("run_id", "")
    status = latest.get("status", "?")

    print(f"状态: {status}")
    sb = _sandbox_reports(args.thread_id)
    if sb:
        content = open(sb[0], errors="replace").read()
        print("\n" + content[:3000])
        save_result(args.thread_id, [content], f"thread_{args.thread_id[:8]}")
        return
    messages = _substantive_messages(get_messages(args.thread_id, run_id))
    if messages:
        final = messages[-1]   # 最后一条实质回答 = 最终结论;拼接全部会混进过程碎片
        print("\n" + final[:3000])
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
