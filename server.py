#!/usr/bin/env python3
"""CodeWhale GUI server.

- Serves the static web app.
- /api/balance: DeepSeek balance proxy (reads codewhale config key).
- /v1/* and /health: token-gated reverse proxy (incl. SSE streaming) to the
  loopback-only codewhale app-server. The phone (PWA) talks ONLY to this server
  (same-origin, no CORS); codewhale itself never leaves 127.0.0.1.

Security: when bound to a non-loopback host (LAN), a token is REQUIRED. Without
one it fails closed to 127.0.0.1, so the agent API is never exposed unprotected.
"""
import http.server, socketserver, json, re, os, time, subprocess, shutil, urllib.request, urllib.error, urllib.parse
import base64, hashlib, tarfile, tempfile, io, threading

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CFG = os.path.expanduser("~/.codewhale/config.toml")
TOKEN_FILE = os.path.expanduser("~/.codewhale-gui/token")
PINS_FILE = os.path.expanduser("~/.codewhale-gui/pins.json")
UPSTREAM = "http://127.0.0.1:7878"
BIND = os.environ.get("CW_BIND", "0.0.0.0")
PORT = int(os.environ.get("CW_PORT", "3000"))

# ── 安全在线更新(签名验证)──
# 内嵌发布公钥(Ed25519,验签锚点)。私钥仅发布者持有,绝不随包分发。
# 安全保证:更新清单必须用对应私钥签名,本端用此公钥验签 + 校验 SHA-256 后才应用;
# 服务器/GitHub 即使被黑也推不了未签名/被篡改的更新。
GUI_UPDATE_PUBKEY_B64 = "c9Cx493xoX5YLHoZ9E84DMIUkliRLmMOvgNg7VUggrU="
UPDATE_CFG = os.path.expanduser("~/.codewhale-gui/update.json")   # {"repo":"owner/repo","enabled":true,"base_url":可选覆盖}
VERSION_FILE = os.path.join(ROOT, "VERSION")
try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    _HAVE_CRYPTO = True
except Exception:
    _HAVE_CRYPTO = False   # 缺 cryptography → 更新功能失效保护(绝不退化成不验签)

def read_token():
    try:
        return (open(TOKEN_FILE).read().strip() or None)
    except FileNotFoundError:
        return None
TOKEN = read_token()

# Fail closed: no token + non-loopback bind => refuse to expose the agent.
if BIND not in ("127.0.0.1", "localhost") and not TOKEN:
    print("[security] no token at ~/.codewhale-gui/token — refusing LAN bind, falling back to 127.0.0.1")
    BIND = "127.0.0.1"

_proxy_cache = {"t": 0.0, "v": None}
def _local_proxy():
    # launchd 起的 server.py 不继承 shell 的 HTTP_PROXY;若本机在跑假 IP 代理(DNS→198.18.x.x),
    # 直连会断。这里按"环境变量 → macOS 系统代理 → 探测常见本地 HTTP 代理端口"找一个可用代理。
    now = time.time()
    if _proxy_cache["v"] is not None and now - _proxy_cache["t"] < 30:
        return _proxy_cache["v"] or None
    p = (os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
         or os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy"))
    if not p:
        try:   # macOS 系统网络设置里的 HTTP(S) 代理
            out = subprocess.run(["/usr/sbin/scutil", "--proxy"], capture_output=True, text=True, timeout=3).stdout
            host = re.search(r'HTTPSProxy\s*:\s*(\S+)', out) or re.search(r'HTTPProxy\s*:\s*(\S+)', out)
            port = re.search(r'HTTPSPort\s*:\s*(\d+)', out) or re.search(r'HTTPPort\s*:\s*(\d+)', out)
            if ("HTTPSEnable : 1" in out or "HTTPEnable : 1" in out) and host and port:
                p = f"http://{host.group(1)}:{port.group(1)}"
        except Exception:
            pass
    if not p:
        import socket
        for port in (1082, 7890, 7897, 1087, 8889, 8080):   # Clash/Surge/V2ray 等常见本地 HTTP 代理口
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.25).close()
                p = f"http://127.0.0.1:{port}"; break
            except Exception:
                pass
    _proxy_cache.update(t=now, v=(p or ""))
    return p or None
def _open_url(req, timeout):
    # 直连优先(TUN 能兜住就成);失败再走探测到的本机代理。失败也不抛新错,沿用原异常。
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except Exception:
        proxy = _local_proxy()
        if not proxy:
            raise
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        return opener.open(req, timeout=timeout)

_bal = {"t": 0.0, "d": None}
def deepseek_key():
    s = open(CFG, encoding="utf-8").read()
    m = re.search(r'\[providers\.deepseek\][^\[]*?api_key\s*=\s*"([^"]+)"', s, re.S) \
        or re.search(r'^api_key\s*=\s*"([^"]+)"', s, re.M)
    return m.group(1) if m else None
def _provider_key(prov):   # 读 [providers.<prov>] api_key
    try:
        s = open(CFG, encoding="utf-8").read()
    except Exception:
        return None
    m = re.search(r'\[providers\.' + re.escape(prov) + r'\][^\[]*?api_key\s*=\s*"([^"]+)"', s, re.S)
    return m.group(1) if m else None
def _zai_usage(key):
    # z.ai GLM Coding Plan 用量(prompts/tokens 每 5 小时窗口,非美元余额)。仅 Coding Plan 用户可读。
    url = "https://api.z.ai/api/monitor/usage/quota/limit"
    last = None
    for authval in (key, "Bearer " + key):   # 官方扩展先裸 key 再 Bearer
        try:
            req = urllib.request.Request(url, headers={
                "Authorization": authval, "Accept-Language": "en-US,en", "Content-Type": "application/json"})
            body = json.load(_open_url(req, 15))
            if not body.get("success", True):
                msg = body.get("msg") or "zai error"
                if "coding plan" in msg:                       # 没订阅 Coding Plan
                    return {"provider": "zai", "glm": True, "no_plan": True}
                last = msg; continue
            data = body.get("data") or body
            limits = (data.get("limits") if isinstance(data, dict) else None) or body.get("limits") or []
            tok = next((l for l in limits if l.get("type") == "TOKENS_LIMIT"), (limits[0] if limits else None))
            if tok:
                return {"provider": "zai", "glm": True,
                        "percent": tok.get("percentage"),
                        "used": tok.get("currentValue"), "limit": tok.get("usage")}
            last = "无 limits 字段"
        except Exception as e:
            last = str(e)[:120]
    return {"provider": "zai", "glm": True, "error": last or "zai 用量读取失败"}
def balance():
    now = time.time()
    prov = _cfg_get("provider") or "deepseek"
    if _bal["d"] and _bal.get("prov") == prov and now - _bal["t"] < 60:   # 缓存按 provider 区分,切换后不再返回旧 provider 余额
        return _bal["d"]
    if prov == "zai":   # GLM:读 Coding Plan 5h 用量额度
        key = _provider_key("zai")
        d = _zai_usage(key) if key else {"provider": "zai", "error": "no zai key"}
        _bal.update(t=now, d=d, prov=prov)
        return d
    if prov != "deepseek":   # 其它 provider 暂无简单余额接口;不误显 DeepSeek 余额
        d = {"provider": prov, "unavailable": True}
        _bal.update(t=now, d=d, prov=prov)
        return d
    key = deepseek_key()
    if not key:
        d = {"provider": "deepseek", "error": "no deepseek key"}
        _bal.update(t=now, d=d, prov=prov)
        return d
    try:
        req = urllib.request.Request("https://api.deepseek.com/user/balance",
                                     headers={"Authorization": "Bearer " + key})
        d = json.load(_open_url(req, 15))
        d["provider"] = "deepseek"
    except Exception as e:
        d = {"provider": "deepseek", "error": str(e)[:120]}
    _bal.update(t=now, d=d, prov=prov)
    return d

def _find_codewhale():   # Apple Silicon=/opt/homebrew, Intel=/usr/local, 直装=~/.local/bin
    for p in ("/opt/homebrew/bin/codewhale", "/usr/local/bin/codewhale", os.path.expanduser("~/.local/bin/codewhale")):
        if os.path.exists(p):
            return p
    return shutil.which("codewhale") or "codewhale"
CODEWHALE = _find_codewhale()
_PATH = "/opt/homebrew/bin:/usr/local/bin:" + os.path.expanduser("~/.local/bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"
def _run(cmd, timeout=120):
    try:
        env = {**os.environ, "PATH": _PATH}  # launchd PATH 太精简,codewhale 是 node 脚本需 node 在 PATH;兼容 arm64/Intel
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as e:
        return -1, str(e)
def check_update():
    code, out = _run([CODEWHALE, "update", "--check"], timeout=40)
    cur = lat = None
    avail = False
    for line in out.splitlines():
        if "Current version:" in line:
            cur = line.split(":", 1)[-1].strip()
        elif "Latest stable release:" in line:
            lat = line.split(":", 1)[-1].strip()
        elif "Update available" in line:
            avail = True
    if cur and lat and cur != lat:
        avail = True
    return {"current": cur, "latest": lat, "available": bool(avail)}
def apply_update():
    code, out = _run([CODEWHALE, "update"], timeout=240)
    # reload the launchd-managed app-server so the new binary takes effect
    _run(["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.codewhale.appserver"], timeout=30)
    return {"ok": code == 0, "output": out[-1500:]}

# ── GUI 在线更新(签名验证)──
def _gui_version():
    try:
        return (open(VERSION_FILE).read().strip() or "0.0.0")
    except Exception:
        return "0.0.0"
def _vtuple(v):
    nums = [int(x) for x in re.findall(r"\d+", str(v))][:4]
    return tuple(nums) if nums else (0,)
def _update_cfg():
    try:
        d = json.load(open(UPDATE_CFG))
        return d if d.get("enabled", True) else {}
    except Exception:
        return {}
def _release_url(cfg, asset):
    base = (cfg.get("base_url") or "").rstrip("/")
    if base:
        return base + "/" + asset                                   # 自托管 / 测试覆盖
    repo = (cfg.get("repo") or "").strip().strip("/")
    return f"https://github.com/{repo}/releases/latest/download/{asset}"   # GitHub Releases 最新版
def _https_or_local(url):
    return url.startswith("https://") or url.startswith("http://127.0.0.1") or url.startswith("http://localhost")
def _fetch(url, timeout=30, maxbytes=64 * 1024):
    if not _https_or_local(url):
        raise ValueError("仅允许 HTTPS 更新源")                       # 防降级到明文 http(本机测试除外)
    req = urllib.request.Request(url, headers={"User-Agent": "CodeWhale-GUI-Updater"})
    with _open_url(req, timeout) as r:
        data = r.read(maxbytes + 1)
    if len(data) > maxbytes:
        raise ValueError("更新文件超出大小上限")
    return data
def _verify_sig(data_bytes, sig_b64):
    if not _HAVE_CRYPTO:
        raise RuntimeError("缺 cryptography,无法验签 —— 拒绝更新(失效保护)")
    pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(GUI_UPDATE_PUBKEY_B64))
    pub.verify(base64.b64decode(sig_b64), data_bytes)               # 签名不对会抛异常 → 更新中止
def _get_manifest(cfg):
    man = _fetch(_release_url(cfg, "manifest.json"), maxbytes=64 * 1024)
    sig = _fetch(_release_url(cfg, "manifest.json.sig"), maxbytes=4 * 1024).decode().strip()
    _verify_sig(man, sig)                                           # ★ 安全核心:验签通过才信任清单
    return json.loads(man)

def gui_update_check():
    cur = _gui_version()
    cfg = _update_cfg()
    if not (cfg.get("repo") or cfg.get("base_url")):
        return {"enabled": False, "current": cur}
    if not _HAVE_CRYPTO:
        return {"enabled": True, "current": cur, "error": "本机缺 cryptography,更新已禁用(装上即恢复)"}
    try:
        m = _get_manifest(cfg)
        avail = _vtuple(m.get("version", "0")) > _vtuple(cur)
        return {"enabled": True, "current": cur, "latest": m.get("version"),
                "available": bool(avail), "notes": (m.get("notes") or "")[:600]}
    except Exception as e:
        return {"enabled": True, "current": cur, "error": str(e)[:160]}

def gui_update_apply():
    cfg = _update_cfg()
    if not (cfg.get("repo") or cfg.get("base_url")):
        return {"error": "更新未配置(~/.codewhale-gui/update.json 填 repo)"}
    m = _get_manifest(cfg)                                          # 拉 + 验签
    new_v = m.get("version", "0")
    if _vtuple(new_v) <= _vtuple(_gui_version()):
        return {"error": f"已是最新或更高({_gui_version()}),不降级"}
    bundle = str(m.get("bundle", ""))
    if not bundle or "/" in bundle or ".." in bundle:
        return {"error": "清单 bundle 名非法"}
    size = int(m.get("size") or 0)
    if size <= 0 or size > 60 * 1024 * 1024:
        return {"error": "清单 size 非法或过大"}
    blob = _fetch(_release_url(cfg, bundle), timeout=180, maxbytes=size)
    if len(blob) != size:
        return {"error": "下载大小与清单不符"}
    if hashlib.sha256(blob).hexdigest() != str(m.get("sha256", "")).lower():
        return {"error": "SHA-256 不匹配 —— 拒绝应用(文件可能被篡改)"}   # ★ 完整性校验
    # 解包到 temp,逐成员校验:只许 web/** + server.py + VERSION,禁符号链接/路径穿越
    tmp = tempfile.mkdtemp(prefix="cwgui-upd-")
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
            members = tf.getmembers()
            for mem in members:
                name = mem.name.lstrip("./")
                if mem.issym() or mem.islnk():
                    return {"error": f"含链接,拒绝:{name}"}
                parts = name.split("/")
                if name.startswith("/") or ".." in parts:
                    return {"error": f"路径穿越,拒绝:{name}"}
                if not (name == "server.py" or name == "VERSION" or name == "web" or name.startswith("web/")):
                    return {"error": f"不允许的文件,拒绝:{name}"}
            tf.extractall(tmp)                                       # 已逐一校验通过
        # 备份当前 → 原子替换 → 失败回滚
        bak = ROOT + ".bak"
        shutil.rmtree(bak, ignore_errors=True)
        os.makedirs(bak, exist_ok=True)
        applied = []
        try:
            for rel in ("web", "server.py", "VERSION"):
                src = os.path.join(tmp, rel)
                if not os.path.exists(src):
                    continue
                dst = os.path.join(ROOT, rel)
                if os.path.exists(dst):
                    shutil.move(dst, os.path.join(bak, rel))        # 备份旧
                shutil.move(src, dst)                                # 换新
                applied.append((rel, dst))
        except Exception as e:
            for rel, dst in applied:                                # 回滚
                shutil.rmtree(dst, ignore_errors=True) if os.path.isdir(dst) else (os.remove(dst) if os.path.exists(dst) else None)
                b = os.path.join(bak, rel)
                if os.path.exists(b):
                    shutil.move(b, dst)
            return {"error": "替换失败,已回滚:" + str(e)[:120]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    threading.Timer(1.5, lambda: _run(["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.codewhale.frontend"], timeout=30)).start()
    return {"ok": True, "version": new_v, "restarting": True}

def read_pins():   # 置顶存服务端 → 所有窗口/手机共享一份,不再各浏览器各管各的
    try:
        d = json.load(open(PINS_FILE))
        return [str(x) for x in d] if isinstance(d, list) else []
    except Exception:
        return []
def write_pins(ids):
    ids = [str(x) for x in ids if isinstance(x, (str, int))][:500]
    os.makedirs(os.path.dirname(PINS_FILE), exist_ok=True)
    tmp = PINS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ids, f)
    os.replace(tmp, PINS_FILE)   # 原子写,防并发半截文件
    return ids

# ── 文件上传:存到 ~/codewhale-uploads(在 agent workspace=$HOME 下,read_file 能读)──
UPLOAD_DIR = os.path.expanduser("~/codewhale-uploads")
def save_upload(raw, filename):
    name = os.path.basename(filename or "file")
    name = re.sub(r"[^A-Za-z0-9._一-鿿 -]", "_", name).strip() or "file"
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    base, ext = os.path.splitext(name)
    dest = os.path.join(UPLOAD_DIR, name); n = 1
    while os.path.exists(dest):
        dest = os.path.join(UPLOAD_DIR, f"{base}-{n}{ext}"); n += 1
    with open(dest, "wb") as f:
        f.write(raw)
    return {"path": dest, "name": os.path.basename(dest), "size": len(raw)}

# ── doctor --json:取 MCP server 健康 + skills 目录(带 3s 缓存)──
MCP_FILE = os.path.expanduser("~/.codewhale/mcp.json")
_doc = {"t": 0.0, "d": None}
def doctor():
    now = time.time()
    if _doc["d"] and now - _doc["t"] < 3:
        return _doc["d"]
    code, out = _run([CODEWHALE, "doctor", "--json"], timeout=30)
    try:
        d = json.loads(out[out.index("{"):out.rindex("}") + 1])
    except Exception:
        d = {}
    _doc.update(t=now, d=d)
    return d

def read_mcp():
    try:
        return json.load(open(MCP_FILE))
    except Exception:
        return {"servers": {}}
def write_mcp(cfg):
    os.makedirs(os.path.dirname(MCP_FILE), exist_ok=True)
    tmp = MCP_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, MCP_FILE)
def list_mcp():   # 合并 mcp.json 配置 + doctor 实时状态
    cfg = read_mcp().get("servers", {}) or {}
    status = {s.get("name"): s for s in (doctor().get("mcp", {}).get("servers") or [])}
    out = []
    for name, sv in cfg.items():
        st = status.get(name, {})
        out.append({"name": name, "command": sv.get("command", ""), "args": sv.get("args", []),
                    "url": sv.get("url"), "disabled": bool(sv.get("disabled")),
                    "enabled": sv.get("enabled", True) and not sv.get("disabled"),
                    "status": st.get("status", "unknown"), "detail": st.get("detail", "")})
    return out

def list_skills():   # 扫各 skills 目录下含 SKILL.md 的子目录
    sk = doctor().get("skills", {}) or {}
    seen = {}
    for key, info in sk.items():
        if not isinstance(info, dict):
            continue
        d = info.get("path")
        if not d or not info.get("present") or not os.path.isdir(d):
            continue
        try:
            for entry in sorted(os.listdir(d)):
                sub = os.path.join(d, entry)
                md = os.path.join(sub, "SKILL.md")
                if os.path.isdir(sub) and os.path.isfile(md) and entry not in seen:
                    seen[entry] = {"name": entry, "path": sub, "source": key,
                                   "has_templates": os.path.isdir(os.path.join(sub, "templates"))}
        except Exception:
            pass
    return sorted(seen.values(), key=lambda x: x["name"])
def read_skill(path):   # 安全读 <skill dir>/SKILL.md
    rp = os.path.realpath(path)
    if "/skills/" not in rp + "/" and not rp.endswith("/skills"):
        return {"error": "path not under a skills dir"}
    md = os.path.join(rp, "SKILL.md")
    try:
        return {"path": md, "content": open(md, encoding="utf-8", errors="replace").read()[:60000]}
    except Exception as e:
        return {"error": str(e)[:200]}

# ── 模型 / Provider 切换 ──
def _cfg_get(key):
    # 直接读 config.toml 的顶层键(provider / default_text_model)。
    # 不再 shell 出 `codewhale config get`:那步依赖 PATH、还可能被 DEBUG 噪音污染,
    # 在别的机器上会让 provider 读错 → 余额误判为不可用。读文件最稳、无依赖。
    k = key.split(".")[-1]
    try:
        s = open(CFG, encoding="utf-8").read()
        m = re.search(r'(?m)^' + re.escape(k) + r'\s*=\s*"([^"]*)"', s)   # 行首顶层 key = "value"
        return m.group(1).strip() if m else ""
    except Exception:
        return ""
def current_model():
    return {"provider": _cfg_get("provider") or "deepseek", "model": _cfg_get("default_text_model")}
def provider_key_status():   # 哪些 provider 已有凭证(含 OAuth)
    code, out = _run([CODEWHALE, "auth", "status"], timeout=20)
    keyed = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 5 and "-" * 5 not in line and parts[0] not in ("provider", "active"):
            keyed[parts[0]] = ("set" in parts[1:4]) or ("oauth" in line.lower())
    return keyed
def _restart_appserver():
    _run(["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.codewhale.appserver"], timeout=30)
def _appserver_healthy(tries=18, delay=0.6):
    for _ in range(tries):
        try:
            urllib.request.urlopen("http://127.0.0.1:7878/health", timeout=2)
            return True
        except Exception:
            time.sleep(delay)
    return False
def set_model(provider, model, api_key):
    provider = (provider or "").strip()
    if not provider:
        return {"error": "provider required"}
    prev_p = _cfg_get("provider") or "deepseek"          # 记下当前可用配置,失败回退用
    prev_m = _cfg_get("default_text_model") or "deepseek-v4-pro"
    if api_key:
        try:
            subprocess.run([CODEWHALE, "auth", "set", "--provider", provider, "--api-key-stdin"],
                           input=api_key, capture_output=True, text=True, timeout=30,
                           env={**os.environ, "PATH": _PATH})
        except Exception as e:
            return {"error": "存 key 失败: " + str(e)[:150]}
    _run([CODEWHALE, "config", "set", "provider", provider], timeout=15)
    if model:
        _run([CODEWHALE, "config", "set", "default_text_model", model], timeout=15)
    _restart_appserver()
    time.sleep(2)                                        # 等旧实例退出,避免拿旧实例的 health 误判成功
    if _appserver_healthy():
        return {"ok": True, "provider": provider, "model": model, "restarted": True}
    # 新配置后端起不来(模型名/key 错等)→ 事务性回退到上一个可用配置,绝不把后端搞崩
    _run([CODEWHALE, "config", "set", "provider", prev_p], timeout=15)
    _run([CODEWHALE, "config", "set", "default_text_model", prev_m], timeout=15)
    _restart_appserver(); _appserver_healthy()
    return {"error": f"切到 {provider}/{model or '默认'} 后后端起不来(多半 key 不对、或模型名被当 DeepSeek 校验)。已自动回退到 {prev_p}/{prev_m},后端正常。非 DeepSeek 的 provider 模型名填 auto(由 provider 自选默认模型),再试。"}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a):
        pass

    def _authed(self):
        if not TOKEN:
            return True
        if self.headers.get("Authorization", "") == "Bearer " + TOKEN:
            return True
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        return q.get("token", [None])[0] == TOKEN
    def _deny(self):
        self.send_response(401)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error":"unauthorized"}')

    def _proxy(self, method):
        if not self._authed():
            return self._deny()
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=method)
        ct = self.headers.get("Content-Type")
        if ct:
            req.add_header("Content-Type", ct)
        try:
            resp = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)[:200]}).encode())
            return
        self.send_response(getattr(resp, "status", 200))
        self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                chunk = resp.read(1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/api/balance"):
            if not self._authed():
                return self._deny()
            try:
                out = balance()
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/api/update/check":
            if not self._authed():
                return self._deny()
            try:
                out = check_update()
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/api/update/gui/check":
            if not self._authed():
                return self._deny()
            try:
                out = gui_update_check()
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/api/pins":
            if not self._authed():
                return self._deny()
            try:
                out = read_pins()
            except Exception:
                out = []
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p in ("/api/mcp", "/api/skills", "/api/model") or p == "/api/skills/read":
            if not self._authed():
                return self._deny()
            try:
                if p == "/api/mcp":
                    out = list_mcp()
                elif p == "/api/skills":
                    out = list_skills()
                elif p == "/api/model":
                    out = {"current": current_model(), "keyed": provider_key_status()}
                else:
                    q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    out = read_skill(q.get("path", [""])[0])
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/manifest.webmanifest":
            try:
                m = json.load(open(os.path.join(WEB, "manifest.webmanifest")))
            except Exception:
                m = {"name": "CodeWhale", "short_name": "CodeWhale", "start_url": "/", "display": "standalone"}
            if TOKEN:
                m["start_url"] = "/?token=" + TOKEN   # 注入 token,iOS 主屏启动也带得上
            b = json.dumps(m).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/manifest+json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p.startswith("/v1/") or p == "/health":
            return self._proxy("GET")
        return super().do_GET()
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/update/apply":
            if not self._authed():
                return self._deny()
            try:
                out = apply_update()
            except Exception as e:
                out = {"ok": False, "output": str(e)[:200]}
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/api/update/gui/apply":
            if not self._authed():
                return self._deny()
            try:
                out = gui_update_apply()
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/api/pins":
            if not self._authed():
                return self._deny()
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b"[]"
                data = json.loads(raw or b"[]")
                ids = data.get("ids", []) if isinstance(data, dict) else data
                out = write_pins(ids if isinstance(ids, list) else [])
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p in ("/api/upload", "/api/mcp", "/api/skills", "/api/model"):
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            try:
                if p == "/api/upload":
                    if length > 50 * 1024 * 1024:
                        raise ValueError("文件过大(>50MB)")
                    raw = self.rfile.read(length) if length else b""
                    fn = urllib.parse.unquote(self.headers.get("X-Filename", "file"))
                    out = save_upload(raw, fn)
                else:
                    data = json.loads(self.rfile.read(length) or b"{}")
                    if p == "/api/mcp":
                        out = self._mcp_action(data)
                    elif p == "/api/model":
                        out = set_model(data.get("provider", ""), data.get("model", ""), data.get("api_key", ""))
                    else:
                        out = self._skill_create(data)
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out, ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p.startswith("/v1/"):
            return self._proxy("POST")
        self.send_error(404)
    def _mcp_action(self, data):
        action = data.get("action")
        if action == "restart":
            _run(["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.codewhale.appserver"], timeout=30)
            return {"ok": True, "restarted": True}
        cfg = read_mcp()
        cfg.setdefault("servers", {})
        name = (data.get("name") or "").strip()
        if not name:
            return {"error": "name required"}
        if action == "toggle":
            sv = cfg["servers"].get(name)
            if not sv:
                return {"error": "no such server"}
            on = bool(data.get("enabled"))
            sv["disabled"] = not on
            sv["enabled"] = on
        elif action == "add":
            if name in cfg["servers"]:
                return {"error": "已存在同名 server"}
            cfg["servers"][name] = {"command": data.get("command", ""), "args": data.get("args", []),
                                    "env": data.get("env", {}), "url": data.get("url"),
                                    "disabled": False, "enabled": True, "required": False,
                                    "enabled_tools": [], "disabled_tools": []}
        elif action == "remove":
            cfg["servers"].pop(name, None)
        else:
            return {"error": "unknown action"}
        write_mcp(cfg)
        return {"ok": True, "servers": list_mcp(), "note": "改动需重启 app-server 才生效"}
    def _skill_create(self, data):
        name = re.sub(r"[^A-Za-z0-9._-]", "-", (data.get("name") or "").strip())
        if not name:
            return {"error": "name required"}
        d = os.path.expanduser(f"~/.codewhale/skills/{name}")
        if os.path.exists(d):
            return {"error": "已存在同名 skill"}
        os.makedirs(d, exist_ok=True)
        desc = (data.get("description") or "").replace("\n", " ")[:200]
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(f"---\nname: {name}\ndescription: {desc or 'TODO 描述这个 skill 何时使用'}\n---\n\n# {name}\n\nTODO: 写清楚这个 skill 的步骤/用途。\n")
        return {"ok": True, "path": d}
    def do_PATCH(self):
        if urllib.parse.urlparse(self.path).path.startswith("/v1/"):
            return self._proxy("PATCH")
        self.send_error(404)
    def do_DELETE(self):
        if urllib.parse.urlparse(self.path).path.startswith("/v1/"):
            return self._proxy("DELETE")
        self.send_error(404)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    print(f"CodeWhale GUI server on {BIND}:{PORT}  (token {'ENABLED' if TOKEN else 'off'})")
    Server((BIND, PORT), Handler).serve_forever()
