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
import http.server, http.client, socketserver, json, re, os, time, subprocess, shutil, urllib.request, urllib.error, urllib.parse, mimetypes
import base64, hashlib, tarfile, tempfile, io, threading, ssl, socket, ipaddress

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CFG = os.path.expanduser("~/.codewhale/config.toml")
TOKEN_FILE = os.path.expanduser("~/.codewhale-gui/token")
PINS_FILE = os.path.expanduser("~/.codewhale-gui/pins.json")
CMP_THREADS_FILE = os.path.expanduser("~/.codewhale-gui/cmp_threads.json")   # 多模型对比建的 thread id 集合 → 侧栏按组归类(对比/普通分开),跨窗口共享
CMP_SESSIONS_FILE = os.path.expanduser("~/.codewhale-gui/cmp_sessions.json")  # 对比会话 [{id,topic,ts,threads:{prov:tid}}] → 侧栏每会话一行、点回当时对比,跨窗口共享
UPSTREAM = "http://127.0.0.1:7878"
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 本机 app-server 请求绝不走代理(代理会劫持 127.0.0.1 导致超时)
BIND = os.environ.get("CW_BIND", "0.0.0.0")
PORT = int(os.environ.get("CW_PORT", "3000"))
PREVIEW_ROOTS = {}
PREVIEW_LOCK = threading.Lock()
PREVIEW_DIR_NAMES = ("dist", "build", "out", "public", "_site")

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

def _preview_id(root):
    seed = (TOKEN or "") + "\0" + os.path.realpath(root)
    return hashlib.sha256(seed.encode()).hexdigest()[:18]

def _preview_register_dir(path):
    root = os.path.realpath(os.path.expanduser(path or ""))
    if os.path.isfile(root) and os.path.basename(root).lower() == "index.html":
        root = os.path.dirname(root)
    idx = os.path.join(root, "index.html")
    if not os.path.isdir(root) or not os.path.isfile(idx):
        raise ValueError("未找到 index.html")
    pid = _preview_id(root)
    with PREVIEW_LOCK:
        PREVIEW_ROOTS[pid] = root
    return {"kind": "static", "dir": root, "url": f"/preview/static/{pid}/"}

def _preview_local_urls(text):
    out = []
    for m in re.finditer(r'https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:/[^\s<>"\']*)?', text or "", re.I):
        u = m.group(0).rstrip(").,;]")
        u = re.sub(r'://0\.0\.0\.0', '://127.0.0.1', u)
        u = re.sub(r'://\[::1\]', '://127.0.0.1', u)
        if u not in out:
            out.append(u)
    return out

def _preview_candidate_dirs(text, cwd=None, explicit=None):
    bases = []
    if cwd:
        bases.append(cwd)
    bases.extend([os.getcwd(), os.path.expanduser("~/Documents")])
    seen, cands = set(), []
    def add(p):
        if not p:
            return
        p = os.path.expanduser(str(p).strip().strip("'\"`"))
        if not os.path.isabs(p):
            for b in bases:
                if b:
                    add(os.path.join(os.path.expanduser(b), p))
            return
        p = os.path.realpath(p)
        if p.endswith(os.sep + "index.html") or os.path.basename(p).lower() == "index.html":
            p = os.path.dirname(p)
        if p not in seen:
            seen.add(p); cands.append(p)
    for p in (explicit or []):
        add(p)
    if cwd:
        for name in PREVIEW_DIR_NAMES:
            add(os.path.join(cwd, name))
    txt = text or ""
    for m in re.finditer(r'((?:/[^ \n\r\t\'"`:]+/)?(?:dist|build|out|public|_site)(?:/index\.html)?)', txt):
        add(m.group(1))
    for m in re.finditer(r'((?:\.{1,2}/)?(?:[A-Za-z0-9_.-]+/){0,4}(?:dist|build|out|public|_site)(?:/index\.html)?)', txt):
        add(m.group(1))
    return cands

def _preview_recent_static_roots(bases):
    now = time.time()
    found, scanned = [], 0
    skip = {"node_modules", ".git", ".next", ".turbo", ".cache", "Library", "Applications"}
    for base in bases:
        base = os.path.realpath(os.path.expanduser(base or ""))
        if not os.path.isdir(base):
            continue
        base_depth = base.rstrip(os.sep).count(os.sep)
        for root, dirs, files in os.walk(base):
            scanned += 1
            if scanned > 5000:
                return [p for _, p in sorted(found, reverse=True)[:12]]
            dirs[:] = [d for d in dirs if d not in skip and not d.startswith(".")]
            if root.rstrip(os.sep).count(os.sep) - base_depth > 5:
                dirs[:] = []
                continue
            if os.path.basename(root) in PREVIEW_DIR_NAMES and "index.html" in files:
                idx = os.path.join(root, "index.html")
                try:
                    mt = os.path.getmtime(idx)
                except Exception:
                    mt = 0
                if now - mt < 6 * 3600:
                    found.append((mt, root))
    return [p for _, p in sorted(found, reverse=True)[:12]]

def preview_detect(data):
    text = str(data.get("text") or "")[-40000:]
    cwd = data.get("cwd") or data.get("workdir") or None
    if cwd:
        cwd = os.path.realpath(os.path.expanduser(str(cwd)))
    urls = _preview_local_urls(text)
    if urls:
        return {"kind": "url", "url": urls[-1], "source": "terminal"}
    for p in _preview_candidate_dirs(text, cwd, data.get("dirs") or []):
        try:
            out = _preview_register_dir(p); out["source"] = "static"; return out
        except Exception:
            pass
    buildish = re.search(r'\b(build|built|compile|compiled|dist|vite|webpack|parcel|next|export|generated|success|done)\b', text, re.I)
    if buildish and not data.get("failed"):
        bases = [b for b in [cwd, os.path.expanduser("~/Documents")] if b]
        for p in _preview_recent_static_roots(bases):
            try:
                out = _preview_register_dir(p); out["source"] = "recent"; return out
            except Exception:
                pass
    if data.get("failed"):
        return {"kind": "error", "error": (text.strip()[-6000:] or "构建失败,没有可预览输出")}
    return {"kind": "none"}
# ── CA 信任(修:python.org 版 Python 默认 CA 包为空 + 本机代理做 TLS 解密用自签根 → 校验失败)──
# 合并 macOS 钥匙串(系统根 + 用户/系统钥匙串里的代理 MITM 根)与 certifi 标准根成一个 CA 包,
# 加载进 SSL 上下文。仍开启证书校验,只是把"本机已信任的根"也纳入信任锚 —— 每台机器按各自钥匙串生成。
_CA_BUNDLE = os.path.expanduser("~/.codewhale-gui/ca-bundle.pem")
def _build_ca_bundle():
    parts = []
    for kc in ("/System/Library/Keychains/SystemRootCertificates.keychain",
               "/Library/Keychains/System.keychain",
               os.path.expanduser("~/Library/Keychains/login.keychain-db")):
        try:
            out = subprocess.run(["/usr/bin/security", "find-certificate", "-a", "-p", kc],
                                 capture_output=True, text=True, timeout=8).stdout
            if out:
                parts.append(out)
        except Exception:
            pass
    try:
        import certifi
        parts.append(open(certifi.where(), encoding="utf-8").read())
    except Exception:
        pass
    blob = "\n".join(parts)
    if "BEGIN CERTIFICATE" not in blob:
        return False
    try:
        os.makedirs(os.path.dirname(_CA_BUNDLE), exist_ok=True)
        with open(_CA_BUNDLE, "w", encoding="utf-8") as f:
            f.write(blob)
        os.chmod(_CA_BUNDLE, 0o600)
    except Exception:
        pass
    return True
_ssl_ctx_cache = None
def _ssl_context():
    global _ssl_ctx_cache
    if _ssl_ctx_cache is not None:
        return _ssl_ctx_cache
    ctx = ssl.create_default_context()
    try:
        if not (os.path.exists(_CA_BUNDLE) and os.path.getsize(_CA_BUNDLE) > 1000):
            _build_ca_bundle()
        if os.path.exists(_CA_BUNDLE):
            ctx.load_verify_locations(_CA_BUNDLE)
    except Exception:
        pass
    _ssl_ctx_cache = ctx
    return ctx
def _open_url(req, timeout):
    # 直连优先(TUN 能兜住就成);失败再走探测到的本机代理。两条路都用合并后的 CA 上下文校验。
    ctx = _ssl_context()
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=ctx)
    except Exception:
        proxy = _local_proxy()
        if not proxy:
            raise
        opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=ctx),
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
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
    m = re.search(r'\[providers\.' + re.escape(prov) + r'\][^\[]*?\n[ \t]*api_key[ \t]*=[ \t]*"([^"]+)"', s, re.S)   # 只认行首未注释的 api_key,跳过 "# api_key = 占位符"
    return m.group(1) if m else None
def _tokenhub_key_probe(key, model):
    # 保存混元前做一次轻量校验:只把 "invalid api key" 当硬失败;402 说明 key 有效但套餐/额度不可用。
    key = (key or "").strip()
    if not re.match(r'^sk-[A-Za-z0-9_-]{20,}$', key):
        return {"fatal": True, "error": "混元请填 TokenHub 模型调用 api_key(sk- 开头),不是腾讯云 SecretId/SecretKey、API Key ID 或 Token Plan ID"}
    payload = json.dumps({
        "model": model or "hy3-preview",
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": False,
    }).encode()
    req = urllib.request.Request("https://tokenhub.tencentmaas.com/v1/chat/completions",
                                 data=payload, method="POST",
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with _open_url(req, 18) as r:
            r.read(4096)
        return {"ok": True}
    except urllib.error.HTTPError as e:
        try:
            body = e.read(4096).decode("utf-8", "replace")
        except Exception:
            body = ""
        low = body.lower()
        msg = re.sub(r'\s+', ' ', body).strip()[:180] or f"HTTP {e.code}"
        if e.code in (401, 403) or "invalid api key" in low or "invalid_api_key" in low or "unauthorized" in low:
            return {"fatal": True, "error": "TokenHub 返回 invalid api key:请确认粘贴的是 TokenHub 模型调用 api_key(sk- 开头),且属于当前账号/团队"}
        if e.code == 402 or "free_quota_exhausted" in low or "quota" in low:
            return {"ok": True, "warning": "TokenHub 已识别 key,但套餐/额度不可用:" + msg}
        return {"ok": True, "warning": "混元 key 已保存;在线探测返回 " + msg}
    except Exception as e:
        return {"ok": True, "warning": "未能在线校验混元 key:" + str(e)[:120]}
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
def _proxy_env():
    # launchd 起的 server.py 没继承 shell 的 HTTP_PROXY → 它拉起的 codewhale 子进程(update 下载 / 各 provider 外连)
    # 在 TUN 兜不住的机器上连不上。把探测到的本机代理注入子进程环境(同 _open_url 的思路)。
    p = _local_proxy()
    if not p:
        return {}
    return {"HTTP_PROXY": p, "HTTPS_PROXY": p, "http_proxy": p, "https_proxy": p}
def _run(cmd, timeout=120):
    try:
        env = {**_proxy_env(), **os.environ, "PATH": _PATH}  # 已有 proxy 则不覆盖;launchd PATH 太精简需补 node/codewhale 路径
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

# ── GUI 在线更新:异步 + 分块下载 + 进度(前端轮询 /api/update/gui/progress 画进度条)──
_GUI_UPD = {"phase": "idle", "downloaded": 0, "total": 0, "pct": 0, "error": None, "done": False, "version": None}
_gui_upd_lock = threading.Lock()
def _gui_set(**kw):
    with _gui_upd_lock:
        _GUI_UPD.update(kw)
def gui_update_progress():
    with _gui_upd_lock:
        return dict(_GUI_UPD)
def _gui_update_worker(cfg, m):
    try:
        new_v = m.get("version", "0"); bundle = str(m.get("bundle", "")); size = int(m.get("size") or 0)
        # 1) 分块下载(边下边报 downloaded/pct)
        _gui_set(phase="downloading", downloaded=0, total=size, pct=0)
        u = _release_url(cfg, bundle)
        if not _https_or_local(u):
            raise ValueError("仅允许 HTTPS 更新源")
        req = urllib.request.Request(u, headers={"User-Agent": "CodeWhale-GUI-Updater"})
        buf = bytearray()
        with _open_url(req, 180) as r:
            while True:
                chunk = r.read(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) > size:
                    raise ValueError("下载超出清单大小")
                _gui_set(downloaded=len(buf), pct=(int(len(buf) * 100 / size) if size else 0))
        blob = bytes(buf)
        if len(blob) != size:
            raise ValueError("下载大小与清单不符")
        # 2) SHA-256 完整性校验
        _gui_set(phase="verifying", pct=100)
        if hashlib.sha256(blob).hexdigest() != str(m.get("sha256", "")).lower():
            raise ValueError("SHA-256 不匹配 —— 拒绝应用(文件可能被篡改)")
        # 3) 解包逐成员校验(只许 web/** + server.py + VERSION,禁链接/路径穿越)+ 原子替换 + 回滚
        _gui_set(phase="applying")
        tmp = tempfile.mkdtemp(prefix="cwgui-upd-")
        try:
            with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as tf:
                for mem in tf.getmembers():
                    name = mem.name.lstrip("./")
                    if mem.issym() or mem.islnk():
                        raise ValueError(f"含链接,拒绝:{name}")
                    if name.startswith("/") or ".." in name.split("/"):
                        raise ValueError(f"路径穿越,拒绝:{name}")
                    if not (name == "server.py" or name == "VERSION" or name == "web" or name.startswith("web/")):
                        raise ValueError(f"不允许的文件,拒绝:{name}")
                tf.extractall(tmp)
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
                        shutil.move(dst, os.path.join(bak, rel))
                    shutil.move(src, dst)
                    applied.append((rel, dst))
            except Exception as e:
                for rel, dst in applied:
                    shutil.rmtree(dst, ignore_errors=True) if os.path.isdir(dst) else (os.remove(dst) if os.path.exists(dst) else None)
                    b = os.path.join(bak, rel)
                    if os.path.exists(b):
                        shutil.move(b, dst)
                raise ValueError("替换失败,已回滚:" + str(e)[:120])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        # 4) 完成 → 1.5s 后重启前端
        _gui_set(phase="restarting", done=True, version=new_v, error=None)
        threading.Timer(1.5, lambda: _run(["/bin/launchctl", "kickstart", "-k", f"gui/{os.getuid()}/com.codewhale.frontend"], timeout=30)).start()
    except Exception as e:
        _gui_set(phase="error", error=str(e)[:200], done=True)

def gui_update_apply():
    # 启动异步更新作业;立刻返回(前端转去轮询 /api/update/gui/progress 画进度条)
    with _gui_upd_lock:
        if _GUI_UPD["phase"] in ("downloading", "verifying", "applying") and not _GUI_UPD["done"]:
            return {"running": True}                                # 已在跑,别重复启动
    cfg = _update_cfg()
    if not (cfg.get("repo") or cfg.get("base_url")):
        return {"error": "更新未配置(~/.codewhale-gui/update.json 填 repo)"}
    _gui_set(phase="checking", downloaded=0, total=0, pct=0, error=None, done=False, version=None)
    try:
        m = _get_manifest(cfg)                                      # 拉 + 验签(同步,立刻把配置/签名错误返回前端)
    except Exception as e:
        _gui_set(phase="error", error="拉清单/验签失败:" + str(e)[:160], done=True)
        return {"error": _GUI_UPD["error"]}
    new_v = m.get("version", "0")
    if _vtuple(new_v) <= _vtuple(_gui_version()):
        _gui_set(phase="idle", done=False)
        return {"error": f"已是最新或更高({_gui_version()}),不降级"}
    bundle = str(m.get("bundle", ""))
    if not bundle or "/" in bundle or ".." in bundle:
        _gui_set(phase="error", error="清单 bundle 名非法", done=True)
        return {"error": "清单 bundle 名非法"}
    size = int(m.get("size") or 0)
    if size <= 0 or size > 60 * 1024 * 1024:
        _gui_set(phase="error", error="清单 size 非法或过大", done=True)
        return {"error": "清单 size 非法或过大"}
    threading.Thread(target=_gui_update_worker, args=(cfg, m), daemon=True).start()
    return {"started": True, "version": new_v, "size": size}

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

def read_cmp_threads():   # 对比 thread 注册表(服务端共享一份,所有窗口/设备一致分组)
    try:
        d = json.load(open(CMP_THREADS_FILE))
        return [str(x) for x in d] if isinstance(d, list) else []
    except Exception:
        return []
def write_cmp_threads(ids):
    ids = [str(x) for x in ids if isinstance(x, (str, int))][:2000]   # 上限大些:对比每问建 N 条
    os.makedirs(os.path.dirname(CMP_THREADS_FILE), exist_ok=True)
    tmp = CMP_THREADS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ids, f)
    os.replace(tmp, CMP_THREADS_FILE)
    return ids

def read_cmp_sessions():
    try:
        d = json.load(open(CMP_SESSIONS_FILE))
        return d if isinstance(d, list) else []
    except Exception:
        return []
def _valid_session(s):
    return (isinstance(s, dict) and isinstance(s.get("id"), str) and s.get("id")
            and isinstance(s.get("threads"), dict))
def write_cmp_sessions(sessions):
    sessions = [s for s in sessions if _valid_session(s)][:500]
    os.makedirs(os.path.dirname(CMP_SESSIONS_FILE), exist_ok=True)
    tmp = CMP_SESSIONS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sessions, f, ensure_ascii=False)
    os.replace(tmp, CMP_SESSIONS_FILE)
    return sessions
def upsert_cmp_sessions(incoming):
    """按 id 合并:同 id 取 thread 更全的那份(并发窗口不互相截断);新 id 追加。返回合并后列表。"""
    by_id = {}
    order = []
    for s in read_cmp_sessions() + [s for s in incoming if _valid_session(s)]:
        sid = s["id"]
        if sid not in by_id:
            order.append(sid); by_id[sid] = s
        else:                                  # 取 threads 更多的(更完整的一次对比)
            if len(s.get("threads") or {}) >= len(by_id[sid].get("threads") or {}):
                by_id[sid] = s
    merged = [by_id[sid] for sid in order]
    merged.sort(key=lambda s: s.get("ts") or 0, reverse=True)   # 新会话在前
    return write_cmp_sessions(merged)

def _seed_cmp_from_tprov():
    """一次性回溯迁移:本功能之前建的对比 thread 没登记 → 从 _tprov 反推。
    _tprov 里被 pin 到 provider 的 thread = 对比建的,或单窗口新对话路由到非默认 provider 的。
    后者只有 newchat provider(此机=claude-code)会产生 → 排除它 + 旧 anthropic;其余
    (gpt/glm/kimi/以及 compare 的 deepseek——单窗口默认 deepseek 不 pin,故 deepseek 入表必是对比)都是对比。
    幂等:只做并集追加,不删;新装机器/已登记的不受影响。"""
    try:
        newchat = _newchat_provider()
        existing = set(read_cmp_threads())
        singles = set(read_single_threads())
        add = [tid for tid, prov in _tprov.items()
               if tid not in singles and prov not in (newchat, "anthropic") and tid not in existing]
        if add:
            write_cmp_threads(list(read_cmp_threads()) + add)
            print(f"[cmp-group] 回溯登记 {len(add)} 条历史对比对话(排除 newchat={newchat}/anthropic)", flush=True)
    except Exception as e:
        print("[cmp-group] 回溯种子失败:", e, flush=True)

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
    if _provider_key("custom"):                    # custom 不在 codewhale auth 列表里(auth status 不报它)→ 直接看 config.toml 有没有 key
        keyed["custom"] = True
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
def _set_custom_api_key(key):
    # custom(腾讯混元 TokenHub 等 OpenAI 兼容槽)不在 `codewhale auth set` 的合法 provider 列表里,只能写配置段。
    key = (key or "").strip()
    if not key:
        raise ValueError("空 key")
    if '"' in key or "\n" in key or "\\" in key:
        raise ValueError("key 含非法字符")
    lines = open(CFG, encoding="utf-8").read().split("\n")
    start = next((i for i, l in enumerate(lines) if l.strip() == "[providers.custom]"), None)
    newln = 'api_key = "%s"' % key
    if start is None:
        lines += ["", "[providers.custom]",
                  'base_url = "https://tokenhub.tencentmaas.com/v1"', newln]
    else:
        end = len(lines)
        for j in range(start + 1, len(lines)):
            if re.match(r'^\s*\[', lines[j]):
                end = j; break
        ki = next((j for j in range(start + 1, end)
                   if re.match(r'^\s*#?\s*api_key\s*=', lines[j])), None)
        if ki is not None:
            lines[ki] = newln
        else:
            lines.insert(start + 1, newln)
    tmp = CFG + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    os.replace(tmp, CFG)

def set_model(provider, model, api_key):
    provider = (provider or "").strip()
    if not provider:
        return {"error": "provider required"}
    if provider == "custom":
        warn = None
        probe_key = api_key or _provider_key("custom")
        if probe_key:
            probe = _tokenhub_key_probe(probe_key, model or "hy3-preview")
            if probe.get("fatal"):
                return {"error": probe.get("error") or "混元 key 无效"}
            warn = probe.get("warning")
        if api_key:
            try:
                _set_custom_api_key(api_key)
            except Exception as e:
                return {"error": "写入混元 key 失败: " + str(e)[:150]}
        elif not _provider_key("custom"):
            return {"error": "腾讯混元需要填入 TokenHub 的 api_key(sk- 开头)"}
        _cmp_reset("custom")
        if model:
            try: _set_model_pref("custom", model)
            except Exception: pass
        out = {"ok": True, "provider": "custom", "model": model or "hy3-preview",
               "newchatCapable": True, "restarted": False, "note": "混元 key 已保存"}
        if warn:
            out["warning"] = warn
        return out
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

# ── 对比模式后端:每个 provider 一个独立 app-server(派生配置设对 provider+model,不同端口,懒启动)──
CMP_DIR = os.path.expanduser("~/.codewhale-gui/cmp")
CMP_PORTS = {}            # provider -> 已分配端口
_cmp_lock = threading.Lock()
_cmp_launching = {}       # provider -> True(正在启动,避免重复 Popen 同端口)
_PORT_UP = {}             # port -> 过期时间戳(缓存"活着",省去每次请求都探活的 HTTP 往返)
def _cmp_model(prov):
    return "deepseek-v4-pro" if prov == "deepseek" else "auto"   # 顶层 default_text_model 只认 "auto" 或 DeepSeek 模型 id;非 deepseek 一律 auto
# 非 deepseek 的 default_text_model="auto" 会让 CodeWhale 自动路由、在轮次间乱选模型(GLM 栏一会儿答 GLM 一会儿答 deepseek)。
# 真正定模型的是 [providers.<prov>].model。这里固定到各 provider 的具体 model(只放已验证的 id,避免乱填崩溃;按需扩展)。
_CMP_PIN_MODEL = {"zai": "GLM-5.2", "custom": "hy3-preview"}
# 真正生效的是「建线程时把 model 钉到 thread 级」——default_text_model="auto" 的自动路由会按 prompt 乱选模型、
# 无视 provider 与 [providers].model;只有 thread.model 是具体 id 才压得住。建会话/对比建线程时注入这个。
# claude-code 必须钉 thread.model="sonnet" 做**确定性路由**:default_text_model="auto" 会让 CodeWhale 逐轮自动路由、
# 时不时把 claude 栏答成 deepseek。"sonnet" 是 claude-code 已注册的合法 wire model(钉它不会 400;钉 "opus" 这种未注册名才会被 deepseek 校验拒)。
# 它只是"路由键",真正传给 `claude -p` 的模型由 _CLAUDE_CODE_MODEL 经 env 覆盖(见下)——所以钉 sonnet 路由、实际跑 opus 不矛盾。
_CMP_FORCE_MODEL = {"deepseek": "deepseek-v4-pro", "zai": "GLM-5.2", "openai-codex": "gpt-5.5", "claude-code": "sonnet", "moonshot": "kimi-for-coding", "custom": "hy3-preview"}   # kimi-for-coding = Kimi Code 平台唯一/最新编码模型;custom 槽=腾讯混元(TokenHub OpenAI 兼容)
_CLAUDE_CODE_MODEL = "opus"   # claude 订阅列实际调用的模型(显式钉 Opus 4.8;也可填 opus/sonnet/haiku 别名)。绕开注册表直传官方 CLI
# claude -p 委派的模型常因训练截止误报旧版本(实测 claude-opus-4-8 自报 "Opus 4.6" 甚至否认 4.8 存在),
# 注入一句权威身份纠正它。切模型时**同时**改这两行保持一致。
_CLAUDE_CODE_IDENTITY = ("You are Claude Opus 4.8 (model id `claude-opus-4-8`), running via the official Claude CLI. "
    "When asked which model or version you are, identify as Claude Opus 4.8. "
    "Your training data may predate this release, so you might instinctively believe the newest model is 4.6 — that belief is outdated. "
    "Do not deny that Claude Opus 4.8 exists, and do not claim to be 4.6.")
# ── 每 provider 可选模型变体:用户在 UI 选(存 model_prefs.json),thread 创建 + claude env 读它,无则回退默认钉死值。
#    单窗口 + 对比窗口共用这份 pref(同一 provider 一处选、两窗口都生效)。
_MODEL_PREFS_FILE = os.path.expanduser("~/.codewhale-gui/model_prefs.json")
_CLAUDE_NAMES = {"claude-opus-4-8": "Claude Opus 4.8", "opus": "Claude Opus 4.8",
                 "claude-sonnet-4-6": "Claude Sonnet 4.6", "sonnet": "Claude Sonnet 4.6",
                 "claude-haiku-4-5": "Claude Haiku 4.5", "haiku": "Claude Haiku 4.5"}
def _claude_identity(model):                                          # 身份串跟着所选模型走(否则切 sonnet 还自报 Opus)
    name = _CLAUDE_NAMES.get(model, "Claude (Anthropic)")
    return (f"You are {name} (model id `{model}`), running via the official Claude CLI. "
            f"When asked which model or version you are, identify as {name}. "
            "Your training data may predate this release — do not claim to be an older version than your actual one.")
def _model_prefs():
    try: return json.load(open(_MODEL_PREFS_FILE))
    except Exception: return {}
def _set_model_pref(prov, model):
    d = _model_prefs(); d[prov] = model
    os.makedirs(os.path.dirname(_MODEL_PREFS_FILE), exist_ok=True)
    json.dump(d, open(_MODEL_PREFS_FILE, "w"))
def _model_pref(prov):                                                # 用户选的实际模型;无则默认
    p = (_model_prefs().get(prov) or "").strip()
    if p: return p
    return _CLAUDE_CODE_MODEL if prov == "claude-code" else _CMP_FORCE_MODEL.get(prov)
def _thread_model(prov):                                              # 建 thread 钉的"路由模型":claude-code 永远 sonnet(合法路由键),其它=所选模型
    return "sonnet" if prov == "claude-code" else _model_pref(prov)
def _effort_pref(prov):                                               # 任意 provider 的推理 effort(low/medium/high/xhigh/max);空=不传
    e = (_model_prefs().get(prov + "__effort") or "").strip().lower()
    return e if e in ("low", "medium", "high", "xhigh", "max") else ""
def _claude_effort():                                                 # claude -p 只认 low/medium/high
    e = _effort_pref("claude-code")
    return e if e in ("low", "medium", "high") else ""
# claude-code provider = 委派官方 `claude -p`(走 Claude 订阅),只有打了补丁的二进制认得这个 provider。
# 官方包装器二进制不识别 → 必须用补丁产物。优先稳定副本,回退到 build 目录。
# 注意:`codewhale app-server` 只是调度器,真正跑 runtime API(threads/turns + claude spawn)的是 sibling `codewhale-tui`。
# 必须同时备齐两者,并用 DEEPSEEK_TUI_BIN 显式钉死 patched tui(否则调度器找不到/找错 sibling)。
def _first_exist(*paths):
    return next((p for p in paths if os.path.exists(p)), None)
_CW_PATCHED = _first_exist(
    os.path.expanduser("~/.codewhale-gui/bin/codewhale-claude"),
    os.path.expanduser("~/codewhale-src/target/release/codewhale"),
)
_CW_PATCHED_TUI = _first_exist(
    os.path.expanduser("~/.codewhale-gui/bin/codewhale-tui"),
    os.path.expanduser("~/codewhale-src/target/release/codewhale-tui"),
)
def _cw_binary(prov):
    # 补丁二进制是 v0.8.65 全功能(claude-code + OCR 中文增强);对 deepseek/zai/openai-codex 行为同 stock。
    # 所有对比后端都用它 → 各列都吃到 image_ocr 的中文/小字增强(不止 claude 列)。缺失时回退官方。
    if _CW_PATCHED:
        return _CW_PATCHED
    return CODEWHALE
# ── claude-code 补丁二进制 自动下载(lazy-fetch)──
# 在线更新只发 web/server.py(那俩二进制 63MB 太大,且更新通道只许 web/server.py/VERSION)。
# 所以缺二进制时,从签名 release 自动拉:复用 Ed25519 签名 manifest(携带二进制 SHA-256 + arch)→ 下载 → 验哈希 → ad-hoc 签名。
# 这样旧机器在线更新到带本逻辑的 server.py 后,首次用 Claude 列即自动补齐二进制,无需重跑安装器。
_BIN_DIR = os.path.expanduser("~/.codewhale-gui/bin")
_patched_fetch_lock = threading.Lock()
_patched_fetch_state = {"phase": "idle", "error": None}   # 供 /api/model 等暴露状态(可选)
def _download_verified(url, dst, sha256_expected, size_expected):
    if not _https_or_local(url):
        raise ValueError("仅允许 HTTPS 下载源")
    req = urllib.request.Request(url, headers={"User-Agent": "CodeWhale-GUI-Updater"})
    h = hashlib.sha256(); n = 0; tmp = dst + ".part"
    with _open_url(req, 180) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(262144)
            if not chunk: break
            n += len(chunk)
            if size_expected and n > size_expected + 4096:
                f.close(); os.remove(tmp); raise ValueError("二进制超出预期大小")
            h.update(chunk); f.write(chunk)
    if sha256_expected and h.hexdigest() != sha256_expected:
        os.remove(tmp); raise ValueError("二进制 SHA-256 不符,拒绝(防篡改)")
    os.replace(tmp, dst)
_BINSHA_MARKER = os.path.join(_BIN_DIR, ".binsha")               # 记已装二进制的 SHA,供"版本感知刷新"比对
def _read_binsha():
    try: return json.load(open(_BINSHA_MARKER))
    except Exception: return {}
def _local_sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""): h.update(c)
    return h.hexdigest()
def _ensure_patched_binaries(block=True, refresh=False):
    """缺/过期 claude-code 补丁二进制时从签名 release 自动下载。refresh=True 比对 manifest SHA,变了就重下
    (OCR 等二进制层升级经此传播到旧机器,无需重装)。幂等、线程安全。成功后更新 _CW_PATCHED(_TUI) 全局。"""
    global _CW_PATCHED, _CW_PATCHED_TUI
    claude = os.path.join(_BIN_DIR, "codewhale-claude")
    tui = os.path.join(_BIN_DIR, "codewhale-tui")
    have = os.path.exists(claude) and os.path.exists(tui)
    if have and not refresh:                                       # 同步快路径:有就用,不查网
        return True
    cfg = _update_cfg()
    if not (cfg.get("repo") or cfg.get("base_url")) or not _HAVE_CRYPTO:
        return have
    if not _patched_fetch_lock.acquire(blocking=block):
        return have
    try:
        _patched_fetch_state.update(phase="checking", error=None)
        man = _get_manifest(cfg)                                    # 验签过的清单(SHA-256 可信)
        arch = __import__("platform").machine()                    # arm64 / x86_64
        marker = _read_binsha()
        os.makedirs(_BIN_DIR, exist_ok=True)
        for b in (man.get("binaries") or []):
            name = b.get("name")
            if name not in ("codewhale-claude", "codewhale-tui"):
                continue
            if b.get("arch") and b["arch"] != arch:                # arm64 二进制不能在 Intel 跑
                continue
            dst = os.path.join(_BIN_DIR, name); sha = b.get("sha256")
            if os.path.exists(dst):
                local = marker.get(name) or _local_sha(dst)        # 无标记 → 实算一次(避免误重下手装的二进制)
                if local == sha:                                   # 已是最新 → 回填标记,跳过
                    marker[name] = sha; continue
            _patched_fetch_state.update(phase="downloading")
            _download_verified(_release_url(cfg, name), dst, sha, int(b.get("size") or 0))
            os.chmod(dst, 0o755)
            subprocess.run(["xattr", "-d", "com.apple.quarantine", dst], capture_output=True)
            subprocess.run(["codesign", "-s", "-", "--force", dst], capture_output=True)   # 本机 ad-hoc 签名,确保可运行
            marker[name] = sha
        try: json.dump(marker, open(_BINSHA_MARKER, "w"))
        except Exception: pass
        ok = os.path.exists(claude) and os.path.exists(tui)
        if ok:
            _CW_PATCHED, _CW_PATCHED_TUI = claude, tui
            _patched_fetch_state.update(phase="ready")
        else:
            _patched_fetch_state.update(phase="incomplete")
        return ok
    except Exception as e:
        _patched_fetch_state.update(phase="error", error=str(e)[:160])
        print(f"[claude-code] 补丁二进制下载/刷新失败: {e}", flush=True)
        return have
    finally:
        _patched_fetch_lock.release()
# ── 原生 App 版本感知刷新 ──
# 原生 CodeWhale.app(WKWebView 壳)的改动(文件选择 runOpenPanel、菜单、JS 对话框等)以前只能靠重装安装器。
# 现把 app 作为签名 release 资产(CodeWhale.app.tar.gz,~0.5MB),启动时比对 manifest 的 native_app SHA,
# 变了就下载+替换 ~/Applications/CodeWhale.app + 去隔离 + ad-hoc 签名。退出重开即用新壳,无需重装。
_APP_DEST = os.path.expanduser("~/Applications/CodeWhale.app")
_APPSHA_MARKER = os.path.expanduser("~/.codewhale-gui/.appsha")
_app_refresh_lock = threading.Lock()
_app_refresh_state = {"phase": "idle", "updated": False, "error": None}
def _refresh_native_app():
    cfg = _update_cfg()
    if not (cfg.get("repo") or cfg.get("base_url")) or not _HAVE_CRYPTO:
        return
    if not _app_refresh_lock.acquire(blocking=False):
        return
    try:
        man = _get_manifest(cfg)
        na = man.get("native_app")
        if not na or not na.get("name") or not na.get("sha256"):
            return
        sha = na["sha256"]
        try: marker = open(_APPSHA_MARKER).read().strip()
        except Exception: marker = ""
        if marker == sha and os.path.exists(_APP_DEST):                # 已是最新 → 不动
            return
        _app_refresh_state.update(phase="downloading", error=None)
        tmpf = os.path.join(tempfile.gettempdir(), "cw-app.tar.gz")
        _download_verified(_release_url(cfg, na["name"]), tmpf, sha, int(na.get("size") or 0))
        tmpd = tempfile.mkdtemp(prefix="cw-app-")
        try:
            with tarfile.open(tmpf, "r:gz") as tf:
                for mem in tf.getmembers():                            # 逐成员安全校验:禁链接/穿越,只许 CodeWhale.app/**
                    n = mem.name.lstrip("./")
                    if mem.issym() or mem.islnk(): raise ValueError("含链接,拒绝")
                    if n.startswith("/") or ".." in n.split("/"): raise ValueError("路径穿越,拒绝")
                    if not (n == "CodeWhale.app" or n.startswith("CodeWhale.app/")): raise ValueError("非法成员:" + n)
                tf.extractall(tmpd)
            newapp = os.path.join(tmpd, "CodeWhale.app")
            if not os.path.isdir(newapp): raise ValueError("包内无 CodeWhale.app")
            os.makedirs(os.path.dirname(_APP_DEST), exist_ok=True)
            bak = _APP_DEST + ".bak"; shutil.rmtree(bak, ignore_errors=True)
            if os.path.exists(_APP_DEST): shutil.move(_APP_DEST, bak)
            try:
                shutil.move(newapp, _APP_DEST)
                subprocess.run(["xattr", "-dr", "com.apple.quarantine", _APP_DEST], capture_output=True)
                subprocess.run(["codesign", "-s", "-", "--force", "--deep", _APP_DEST], capture_output=True)
                subprocess.run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", _APP_DEST], capture_output=True)
                open(_APPSHA_MARKER, "w").write(sha)
                shutil.rmtree(bak, ignore_errors=True)
                _app_refresh_state.update(phase="updated", updated=True)   # 前端可据此提示"退出重开生效"
                print("[native-app] 已更新 ~/Applications/CodeWhale.app —— 退出重开 CodeWhale 生效", flush=True)
            except Exception:
                if os.path.exists(bak) and not os.path.exists(_APP_DEST): shutil.move(bak, _APP_DEST)  # 回滚
                raise
        finally:
            shutil.rmtree(tmpd, ignore_errors=True)
            try: os.remove(tmpf)
            except Exception: pass
    except Exception as e:
        _app_refresh_state.update(phase="error", error=str(e)[:160])
        print(f"[native-app] 刷新失败: {e}", flush=True)
    finally:
        _app_refresh_lock.release()
def _cmp_safe(prov):
    return re.sub(r'[^a-zA-Z0-9_-]', '_', prov)
def _cmp_reset(prov):
    # 改 provider key/model 后,杀旧 per-provider 后端并删派生配置,下次请求用新配置重起。
    with _cmp_lock:
        port = CMP_PORTS.pop(prov, None)
    if port:
        _PORT_UP.pop(port, None)
        try:
            out = subprocess.run(["lsof", "-nP", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
                                 capture_output=True, text=True, timeout=5).stdout
            for pid in out.split():
                try: os.kill(int(pid), 9)
                except Exception: pass
        except Exception: pass
    try:
        os.remove(os.path.join(CMP_DIR, _cmp_safe(prov) + ".toml"))
    except Exception: pass
def _provider_config_error(prov):
    if prov == "custom" and not _provider_key("custom"):
        return "腾讯混元 API key 未配置:点击左下「🧠 模型」→「腾讯混元」→ 粘贴 TokenHub api_key →「保存并设为新对话模型」"
    return None
_COMPARE_SKILL_MD = """---
name: compare-research
description: 多模型对比窗口里的高效取数与研究规范。任何需要联网/取数/研究的任务(行情、财报、SEC 内幕、新闻、个股分析)都按本规范执行——拿结构化小数据、别硬爬整页、别重复抓、控制上下文 token。
metadata:
  short-description: 多模型对比高效取数规范
---

# 多模型对比 · 高效取数规范

你正运行在「多模型对比」窗口里。资源/时间/token 都宝贵,**取数要又快又省**。严格按下面来,别用蛮力。

## 你的工具(跟单窗口完全一样)
你有**完整 MCP**(`fmp` 基本面/财报/估值、`yfinance` 行情/期权、`sec_edgar` 文件/内幕、`fetch` 抓网页、`searxng` 聚合搜索、`gmail`)+ 内置 `web_search` +(开了 Shell 时)`exec_shell`,以及全部 skill(`load_skill` 按需加载)。能力和单窗口一致,放手用。先 `tool_search` 找对工具。

## 取数工具优先级(拿结构化小数据,别硬爬整页)
1. **行情 / 财务指标 / 估值** → MCP 的 `fmp` / `yfinance`;或开了 Shell 时 `exec_shell` 跑 Python `yfinance`(`t=yf.Ticker('GLW'); t.fast_info`)。**不要** `curl` 财经网页 HTML 回来硬解析。
2. **SEC 文件 / 内幕(Form 4)/ 8-K / 重述** → MCP 的 `sec_edgar`;或 EDGAR 全文搜索 API 拿结构化 JSON(`https://efts.sec.gov/LATEST/search-index?q=...&forms=4`,带 User-Agent),**只取目标 filing 相关段落**,绝不把整份 >100KB 原文塞进上下文。
3. **新闻 / 事件 / 催化剂** → MCP `searxng` 或内置 `web_search`,看标题+摘要定位即可。

## 铁律(避免又慢又烧 token)
- 绝不重复抓同一文档;绝不 `curl` 整页 HTML 当数据(全是 CSS/JS,解析必炸);只取回答所需的最少数据;某命令失败就换更精准的查询,别重复同一条。
- 本机 fake-ip 下内置 `fetch_url` 会被拦 → 用 `curl` 或 `web_search`,别卡在 fetch_url。

## 深度投研
若是「深度分析/研究某只票/给投资建议」,先 `load_skill value-investment-master`(用户的投研方法论),按其框架拆解(基本面/估值/催化剂/风险),再结合实时数据输出。

## 输出
先给**结论 + 关键数据(带数字)**,再给推理;对比窗口讲究并排可比,别长篇铺垫。
"""
def _ensure_compare_skill():
    # 让 compare-research skill 跟着 server.py 走(GUI 在线更新即带上),任何机器更新后都能 always_load 到它
    try:
        d = os.path.expanduser("~/.codewhale/skills/compare-research")
        f = os.path.join(d, "SKILL.md")
        cur = open(f, encoding="utf-8").read() if os.path.exists(f) else None   # 内容变了就覆写(否则改了 skill 也传播不出去)
        if cur != _COMPARE_SKILL_MD:
            os.makedirs(d, exist_ok=True)
            open(f, "w", encoding="utf-8").write(_COMPARE_SKILL_MD)
    except Exception:
        pass
def _strip_mcp(s):
    # 剥掉 [mcp_servers.*] 段:对比/per-provider 后端不需要 MCP(模型实际用 exec_shell + 内置 web_search + python),
    # 而起这些 npx/pip MCP 很慢——并发起 3 个后端时一起抢资源会把后端启动拖过超时(openai-codex「启动超时」根因)。
    out = []; skip = False
    for ln in s.splitlines(keepends=True):
        st = ln.lstrip()
        if st.startswith("["):
            skip = st.startswith("[mcp_servers")
        if not skip:
            out.append(ln)
    return "".join(out)
def _cmp_write_config(prov):
    os.makedirs(CMP_DIR, exist_ok=True)
    _ensure_compare_skill()                                      # 保证高效取数 skill 存在,供 always_load 加载
    s = open(CFG, encoding="utf-8").read()                       # 从主配置派生,带上所有 provider 的 key + 全部 MCP(对比要跟单窗口完全同能力:工具/MCP/skill 都在)。app-server /health 不阻塞 MCP(实测带 8 MCP 仍 1.6s 起),MCP 后台起;3 后端不再一次性并发(openCompare 预热 + 串行 /health 门控)避开早前并发起 24 个 MCP 的资源尖峰
    if prov == "claude-code":
        s = _strip_mcp(s)                                        # claude-code 把整个 turn 委派给 `claude -p`(claude 自带全套工具),完全不用 CodeWhale 的 MCP → 剥掉,免去 npx/pip 启动开销与资源争抢(当初"启动超时"的根因)
    if re.search(r'(?m)^provider\s*=', s):
        s = re.sub(r'(?m)^provider\s*=.*$', f'provider = "{prov}"', s, count=1)
    else:
        s = f'provider = "{prov}"\n' + s
    if re.search(r'(?m)^default_text_model\s*=', s):
        s = re.sub(r'(?m)^default_text_model\s*=.*$', f'default_text_model = "{_cmp_model(prov)}"', s, count=1)
    else:
        s = f'default_text_model = "{_cmp_model(prov)}"\n' + s
    pin = _model_pref(prov) if prov in _CMP_PIN_MODEL else None  # 固定 [providers.<prov>].model → 该栏稳定用用户选择的模型,不再被 auto 路由带跑
    if pin:
        hdr = f"[providers.{prov}]"
        if re.search(r'(?m)^' + re.escape(hdr) + r'\s*$', s):
            # 替换该段紧跟 header 的 model 行;没有就插入(header 后通常是 api_key,不会误吞)
            s = re.sub(r'(?m)^' + re.escape(hdr) + r'[ \t]*\n([ \t]*model[ \t]*=.*\n)?',
                       hdr + "\n" + f'model = "{pin}"\n', s, count=1)
        else:
            s = s.rstrip() + f"\n\n{hdr}\nmodel = \"{pin}\"\n"
    # 自动加载高效取数规范 skill(对比窗口所有模型都遵守,纠正 GPT 爱硬爬整页/重复抓的低效)
    if re.search(r'(?m)^\[skills\]\s*$', s):
        if re.search(r'(?m)^\s*always_load\s*=', s):
            s = re.sub(r'(?m)^(\s*)always_load\s*=.*$', r'\1always_load = ["compare-research"]', s, count=1)
        else:
            s = re.sub(r'(?m)^(\[skills\]\s*\n)', r'\1always_load = ["compare-research"]\n', s, count=1)
    else:
        s = s.rstrip() + '\n\n[skills]\nalways_load = ["compare-research"]\n'
    path = os.path.join(CMP_DIR, _cmp_safe(prov) + ".toml")
    open(path, "w").write(s)
    return path
def _port_up(port):
    exp = _PORT_UP.get(port)                                     # 命中缓存(15s 内确认过活着)→ 直接 True,免 HTTP 往返
    if exp and exp > time.time():
        return True
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2)
        _PORT_UP[port] = time.time() + 15
        return True
    except Exception:
        _PORT_UP.pop(port, None)
        return False
def ensure_provider_server(prov):
    if not re.match(r'^[a-zA-Z0-9_-]+$', prov or ""):
        raise ValueError("非法 provider")
    err = _provider_config_error(prov)
    if err:
        raise RuntimeError(err)
    if not _CW_PATCHED:                                          # 缺补丁二进制 → 先自动下载(同步,首次约几十秒)。所有对比列都靠它吃 OCR 增强
        ok = _ensure_patched_binaries(block=True)
        if not ok and prov == "claude-code":                    # claude-code 没补丁就跑不了(致命);其它列回退官方二进制(只是没 OCR 增强)
            raise RuntimeError("Claude 订阅引擎(补丁二进制)缺失且自动下载失败 —— 检查网络/在线更新配置,或重跑安装器")
    port = CMP_PORTS.get(prov)                                   # 快路径:已知端口且活着 → 立即返回(不进锁,热切换 ~0)
    if port and _port_up(port):
        return port
    launched_here = False
    try:
        with _cmp_lock:                                          # 锁只护"分配端口 + 起进程",不护后面的就绪等待
            port = CMP_PORTS.get(prov)
            if port and _port_up(port):
                return port
            if not port:                                         # 分配一个空闲端口(从 7900 起)
                used = set(CMP_PORTS.values())
                port = 7900
                while port in used or _port_up(port):
                    port += 1
                CMP_PORTS[prov] = port
            if not _cmp_launching.get(prov):                     # 没有别的线程在启动它 → 这条线程负责 Popen
                _cmp_launching[prov] = True
                launched_here = True
                cfg = _cmp_write_config(prov)
                env = {**_proxy_env(), **os.environ, "PATH": _PATH, "CODEWHALE_PROVIDER": prov}
                for _v in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"):
                    env.pop(_v, None)                                # claude-code 列会 spawn `claude -p`,带 CLAUDECODE 会被官方 CLI 拒绝嵌套;清掉(对其它 provider 无害)
                if _CW_PATCHED_TUI:
                    env["DEEPSEEK_TUI_BIN"] = _CW_PATCHED_TUI         # 所有对比后端都委派给 patched tui(含 OCR 中文增强 + claude spawn + env_remove)
                if prov == "claude-code":
                    _cm = _model_pref("claude-code")                  # 用户选的 claude 模型(默认 opus 4.8)
                    env["CODEWHALE_CLAUDE_MODEL"] = _cm               # 强制 `claude -p` 用的模型;绕开模型注册表,直传官方 CLI
                    env["CODEWHALE_CLAUDE_IDENTITY"] = _claude_identity(_cm)  # 身份串跟着所选模型走
                    _ce = _claude_effort()                           # 推理 effort(low/medium/high);空则不传,claude 用默认
                    if _ce: env["CODEWHALE_CLAUDE_EFFORT"] = _ce
                else:
                    _re = _effort_pref(prov)                          # 非 claude:推理 effort 走 runtime env(apply_reasoning_effort 按 provider 映射;GPT→Responses reasoning.effort)
                    if _re: env["CODEWHALE_REASONING_EFFORT"] = _re
                logf = open(os.path.expanduser(f"~/codewhale-gui/cmp-{_cmp_safe(prov)}.log"), "a")
                subprocess.Popen([_cw_binary(prov), "app-server", "--config", cfg, "--http", "--host", "127.0.0.1",
                                  "--port", str(port), "--insecure-no-auth"],
                                 env=env, cwd=os.path.expanduser("~"), stdout=logf, stderr=subprocess.STDOUT)
        for _ in range(112):                                     # 就绪等待在锁外:启动 A 不再阻塞切到 B(消除连环卡顿),最多 ~45s(并发起多个后端时留足余量)
            if _port_up(port):
                return port
            time.sleep(0.4)
    finally:
        if launched_here:                                        # 无论成功/超时/Popen 抛错都清启动标志,避免该 provider 永久卡住
            _cmp_launching.pop(prov, None)
    raise RuntimeError(f"{prov} app-server 启动超时")

# ── 每对话锁模型(CodeWhale 会话是跨 app-server 共享存储,所以不能靠"谁有这会话"判 provider;
#    用一张自维护、持久化的 tid->provider 锁定表,建会话时写定,路由按它走,聚合按它打标)──
_TPROV_FILE = os.path.expanduser("~/.codewhale-gui/thread_provider.json")
try:
    _tprov = json.load(open(_TPROV_FILE)); _tprov = _tprov if isinstance(_tprov, dict) else {}
except Exception:
    _tprov = {}
_tprov_lock = threading.Lock()
def _pin_thread(tid, prov):
    with _tprov_lock:
        _tprov[tid] = prov
        try: json.dump(_tprov, open(_TPROV_FILE, "w"))
        except Exception: pass
SINGLE_THREADS_FILE = os.path.expanduser("~/.codewhale-gui/single_threads.json")
def read_single_threads():   # 单窗口主动 pin 过的 thread:不应被 _tprov 兜底误归到对比分组
    try:
        d = json.load(open(SINGLE_THREADS_FILE))
        return [str(x) for x in d] if isinstance(d, list) else []
    except Exception:
        return []
def _mark_single_thread(tid):
    if not tid:
        return
    ids = list(dict.fromkeys(read_single_threads() + [tid]))[-3000:]
    os.makedirs(os.path.dirname(SINGLE_THREADS_FILE), exist_ok=True)
    tmp = SINGLE_THREADS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(ids, f)
    os.replace(tmp, SINGLE_THREADS_FILE)
NEWCHAT_FILE = os.path.expanduser("~/.codewhale-gui/newchat.json")
_NEWCHAT_REQUIRES_KEY = {"custom"}   # custom=腾讯混元 OpenAI 兼容槽,可做单窗口新对话,但必须先有 api_key
def _newchat_provider():
    default = _cfg_get("provider") or "deepseek"
    if default in _NEWCHAT_REQUIRES_KEY and not _provider_key(default):
        default = "deepseek"
    try:
        p = (json.load(open(NEWCHAT_FILE)).get("provider") or "").strip()
        if p in _NEWCHAT_REQUIRES_KEY and not _provider_key(p):
            _set_newchat_provider(default)
            return default
        if p:
            return p
    except Exception:
        pass
    return default
def _set_newchat_provider(prov):
    if prov in _NEWCHAT_REQUIRES_KEY and not _provider_key(prov):
        raise ValueError("腾讯混元 API key 未配置,请先在模型面板保存混元 key")
    os.makedirs(os.path.dirname(NEWCHAT_FILE), exist_ok=True)
    json.dump({"provider": prov}, open(NEWCHAT_FILE, "w"))
def _route_base(path):       # /v1/threads/<tid>/* 路由到该对话锁定的 provider 后端;未锁定或锁定=当前默认→:7878
    m = re.match(r'^/v1/threads/(thr_[a-zA-Z0-9_-]+)', path or "")
    if m:
        prov = _tprov.get(m.group(1))
        if prov and prov != (_cfg_get("provider") or "deepseek"):
            try: return f"http://127.0.0.1:{ensure_provider_server(prov)}"
            except Exception: pass
    return UPSTREAM
def _switch_single_thread_provider(tid, prov, model=None):
    if prov in _NEWCHAT_REQUIRES_KEY and not _provider_key(prov):
        raise RuntimeError("腾讯混元 API key 未配置,请先在模型面板保存混元 key")
    if model:
        _set_model_pref(prov, model)
    default_prov = _cfg_get("provider") or "deepseek"
    base = UPSTREAM if prov == default_prov else f"http://127.0.0.1:{ensure_provider_server(prov)}"
    fm = _thread_model(prov) if _CMP_FORCE_MODEL.get(prov) else (model or None)
    if fm:
        body = json.dumps({"model": fm}).encode()
        req = urllib.request.Request(f"{base}/v1/threads/{tid}", data=body, method="PATCH", headers={"Content-Type": "application/json"})
        _LOCAL.open(req, timeout=30).read()
    _pin_thread(tid, prov)
    _mark_single_thread(tid)
    return {"ok": True, "thread_id": tid, "provider": prov, "model": fm or model or ""}
def _model_to_provider(model):   # 从会话真实 model 反推 provider(thread.model 已被钉准,比 _tprov 锁定表可靠)→ 侧栏标签必和模型一致
    m = (model or "").lower()
    if not m or m == "auto":
        return None
    if "deepseek" in m: return "deepseek"
    if "glm" in m:      return "zai"
    if "gpt" in m:      return "openai-codex"
    if "claude" in m:   return "anthropic"
    if "kimi" in m or "moonshot" in m: return "moonshot"
    if "hunyuan" in m or "hy3" in m or m.startswith("hy-"): return "custom"
    if "gemini" in m:   return "openrouter"
    return None
# ── 线程列表 stale-while-revalidate ──
# :7878 的 summary 随线程数变慢(felix 90+ 条 → >8s,会撞 8s 超时)。旧逻辑每次缓存过期就**同步**死等它 →
# 每次开程序干等 8s。改:有缓存就**立刻返回**(哪怕过期),过期时只在**后台**刷新、绝不阻塞请求;
# 缓存**落盘** → 服务重启也有暖缓存、首屏即出;后台抓超时放宽到 30s,保证最终能刷成功。
_THREADS_CACHE_FILE = os.path.expanduser("~/.codewhale-gui/threads_cache.json")
_threads_cache = {"v": None, "t": 0.0, "refreshing": False}
try:
    _disk = json.load(open(_THREADS_CACHE_FILE))
    if isinstance(_disk, list): _threads_cache["v"] = _disk   # 暖缓存(t 留 0 → 视为过期 → 首个请求触发后台刷新)
except Exception:
    pass
_threads_refresh_lock = threading.Lock()
def _fetch_threads_now():
    """实际抓 :7878 summary(慢,可能 >8s);成功才更新内存 + 落盘。返回列表或 None。"""
    try:
        arr = json.load(_LOCAL.open(f"http://127.0.0.1:7878/v1/threads/summary?limit=50", timeout=90))   # summary 本身慢(~0.8s/条,50 条 ~43s);后台抓放宽到 90s 保证刷得成(反正不阻塞请求)
    except Exception:
        return None
    if not isinstance(arr, list):
        return None
    dflt = _cfg_get("provider") or "deepseek"
    for t in arr:
        t["provider"] = _model_to_provider(t.get("model")) or _tprov.get(t.get("id")) or dflt
    _threads_cache["v"] = arr; _threads_cache["t"] = time.time()
    try: json.dump(arr, open(_THREADS_CACHE_FILE, "w"))   # 落盘:服务重启也有暖缓存
    except Exception: pass
    return arr
def _bg_refresh_threads():
    try: _fetch_threads_now()
    finally: _threads_cache["refreshing"] = False
def _tag_compare(arr):
    """给每条 thread 打 compare 标记 —— 权威双信号,每次刷新(不缓存),前端直接信、不依赖前端本地是否同步:
    ① 在 cmp_threads 注册表(对比 cmpRun 经 /api/pin-thread 登记);
    ② 被 pin 过(_tprov)—— 对比建的都会 pin;单聊只有 newchat≠默认 provider 时才 pin,那种排除掉。
    两个信号任一命中即对比 → 杜绝"对比对话散落进单聊列表"。"""
    try: cmp_set = set(read_cmp_threads())
    except Exception: cmp_set = set()
    nc = _newchat_provider(); dflt = _cfg_get("provider") or "deepseek"
    single_set = set(read_single_threads())
    single_prov = nc if nc != dflt else None   # newchat≠默认 → 单聊会 pin 到 nc(不算对比);newchat=默认 → 单聊不 pin,_tprov 全是对比
    for t in arr:
        if isinstance(t, dict):
            tid = t.get("id")
            t["compare"] = (tid in cmp_set) or (tid in _tprov and tid not in single_set and _tprov.get(tid) != single_prov)
    return arr
def aggregate_threads():     # SWR:有缓存立刻返回,过期只后台刷新,绝不阻塞请求(开程序不再干等 8s)
    cached = _threads_cache["v"]
    if cached is not None:
        if time.time() - _threads_cache["t"] >= 120.0 and not _threads_cache["refreshing"]:   # 过期 → 后台刷新(单飞,不阻塞;120s 间隔降低对 :7878 占用,summary 本身要 ~43s,太频繁会把 :7878 压满)
            with _threads_refresh_lock:
                if not _threads_cache["refreshing"]:
                    _threads_cache["refreshing"] = True
                    threading.Thread(target=_bg_refresh_threads, daemon=True).start()
        return _tag_compare(cached)
    return _tag_compare(_fetch_threads_now() or [])   # 从没成功 + 无落盘 → 只能同步取一次(尽量快;失败返回空)

# ── fake-ip 环境自动探测 ──
# 本机若挂 fake-ip 模式代理(Clash/Surge/MacPacket…),DNS 把公网域名解析成保留地址
# (如 198.18.x.x),CodeWhale 内置 fetch_url 会被其 SSRF 守卫拦。只有这种机器才需要
# 「改走 curl/MCP」的引导;普通机器 fetch_url 正常,不该被误导。故运行时实测一次系统解析,
# 解析到非全局(保留/私有)地址 → 判定 fake-ip。结果缓存 120s(代理模式可能被中途切换)。
_NETENV = {"ts": 0.0, "fakeip": False, "ip": None}
_netenv_lock = threading.Lock()
def _detect_fakeip():
    for host in ("example.com", "www.cloudflare.com", "api.deepseek.com"):
        try:
            infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        except Exception:
            continue
        ip = infos[0][4][0] if infos else None
        if not ip:
            continue
        for info in infos:                       # 任一解析地址落在非全局段 → fake-ip 劫持
            addr = info[4][0]
            try:
                if not ipaddress.ip_address(addr).is_global:
                    return True, addr
            except Exception:
                pass
        return False, ip                          # 解析成功且都是公网 IP → 正常机器
    return False, None                            # 全失败(离线?)→ 当正常,不发引导
def netenv():
    with _netenv_lock:
        if time.time() - _NETENV["ts"] > 120:
            fi, ip = _detect_fakeip()
            _NETENV.update(ts=time.time(), fakeip=fi, ip=ip)
        return {"fakeip": _NETENV["fakeip"], "ip": _NETENV["ip"]}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a):
        pass
    def end_headers(self):
        # SPA 外壳(index.html)绝不缓存:否则 WKWebView/浏览器会缓存旧版,⌘R 或在线更新后页面看着没变
        # (本次亲历:preview 拿到了几版之前的缓存)。其余静态资源(图标/manifest)照常可缓存。
        p = urllib.parse.urlparse(self.path).path
        if p == "/" or p.endswith(".html"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        super().end_headers()

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
    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)
    def _serve_preview_static(self, path):
        m = re.match(r'^/preview/static/([a-f0-9]{18})(?:/(.*))?$', path)
        if not m:
            return self.send_error(404)
        pid, rel = m.group(1), urllib.parse.unquote(m.group(2) or "")
        with PREVIEW_LOCK:
            root = PREVIEW_ROOTS.get(pid)
        if not root:
            return self.send_error(404, "preview expired")
        root = os.path.realpath(root)
        rel = rel.lstrip("/")
        target = os.path.realpath(os.path.join(root, rel))
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not (target == root or target.startswith(root + os.sep)):
            return self.send_error(403)
        if not os.path.exists(target) and "." not in os.path.basename(rel):
            target = os.path.join(root, "index.html")   # SPA fallback
        if not os.path.isfile(target):
            return self.send_error(404)
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        try:
            st = os.stat(target)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(st.st_size))
            self.end_headers()
            with open(target, "rb") as f:
                shutil.copyfileobj(f, self.wfile)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
    def _proxy_to(self, method, port, upstream_path, body=False):   # 代理到指定 provider 的独立 app-server(SSE 流式);body 显式给则用它,否则从请求体读
        if body is False:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else None
        req = urllib.request.Request(f"http://127.0.0.1:{port}{upstream_path}", data=body, method=method)
        ct = self.headers.get("Content-Type")
        if ct:
            req.add_header("Content-Type", ct)
        try:
            resp = _LOCAL.open(req, timeout=1800)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:
            return self._json({"error": str(e)[:200]}, 502)
        self.send_response(getattr(resp, "status", 200))
        self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                chunk = resp.read1(8192)   # read1=有多少转多少,不阻塞等满(SSE 最后一个小事件也能即时送达)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError, http.client.IncompleteRead, ValueError):
            pass
    def _cmp_route(self, method):   # /cmp/<provider>/v1/... → 确保该 provider 后端在跑 → 代理过去
        p = urllib.parse.urlparse(self.path).path
        m = re.match(r'^/cmp/([a-zA-Z0-9_-]+)(/.*)$', p)
        if not m:
            return False
        if not self._authed():
            self._deny(); return True
        prov = m.group(1)
        upstream = self.path[len("/cmp/" + prov):]   # 去掉 /cmp/<prov> 前缀,保留 query
        try:
            port = ensure_provider_server(prov)
        except Exception as e:
            self._json({"error": str(e)[:200]}, 502); return True
        body = False
        if method == "POST" and urllib.parse.urlparse(upstream).path == "/v1/threads" and _CMP_FORCE_MODEL.get(prov):
            # 对比建线程:服务端把 model 钉到 thread 级,绕过 default_text_model="auto" 的自动路由
            # (旧前端发 {} 也能被纠正,用户不必重载页面)
            length = int(self.headers.get("Content-Length", 0) or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                bd = json.loads(raw or b"{}")
                if not bd.get("model"):
                    bd["model"] = _thread_model(prov)
                body = json.dumps(bd).encode()
            except Exception:
                body = raw
        self._proxy_to(method, port, upstream, body=body)
        return True

    def _proxy(self, method):
        if not self._authed():
            return self._deny()
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(_route_base(self.path) + self.path, data=body, method=method)
        ct = self.headers.get("Content-Type")
        if ct:
            req.add_header("Content-Type", ct)
        try:
            resp = _LOCAL.open(req, timeout=1800)
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
                chunk = resp.read1(8192)   # read1=有多少转多少,不阻塞等满(SSE 最后一个小事件也能即时送达)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError, http.client.IncompleteRead, ValueError):
            pass

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/preview/static/"):
            return self._serve_preview_static(p)
        if p == "/api/threads/all":   # 聚合各 provider 后端的会话(带 provider 标签)+ 建路由表
            if not self._authed():
                return self._deny()
            try:
                out = aggregate_threads()
            except Exception as e:
                out = []
            return self._json(out)
        if p == "/api/newchat-provider":
            if not self._authed():
                return self._deny()
            return self._json({"provider": _newchat_provider()})
        if p == "/api/netenv":   # 本机是否 fake-ip 环境(决定要不要给联网取数加 curl/MCP 引导)
            if not self._authed():
                return self._deny()
            try:
                return self._json(netenv())
            except Exception:
                return self._json({"fakeip": False, "ip": None})
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
        if p == "/api/update/gui/progress":   # 前端轮询:下载/校验/应用 进度
            if not self._authed():
                return self._deny()
            return self._json(gui_update_progress())
        if p == "/api/app-refresh-status":    # 原生 App 是否被后台刷新了(前端据此提示退出重开)
            if not self._authed():
                return self._deny()
            return self._json(dict(_app_refresh_state))
        if p == "/api/model-pref":            # 各 provider 当前所选模型(含默认),前端画下拉用
            if not self._authed():
                return self._deny()
            prefs = _model_prefs()
            out = {pv: (prefs.get(pv) or _model_pref(pv)) for pv in list(_CMP_FORCE_MODEL.keys()) + ["claude-code", "moonshot"]}
            return self._json({"prefs": out, "effort": {pv: _effort_pref(pv) for pv in ("claude-code", "openai-codex", "deepseek", "zai")}})
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
        if p == "/api/cmp-threads":   # 对比 thread 注册表(侧栏分组用)
            if not self._authed():
                return self._deny()
            try:
                out = read_cmp_threads()
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
        if p == "/api/cmp-sessions":   # 对比会话(侧栏每会话一行、点回当时对比)
            if not self._authed():
                return self._deny()
            try:
                out = read_cmp_sessions()
            except Exception:
                out = []
            b = json.dumps(out, ensure_ascii=False).encode()
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
        if p.startswith("/cmp/") and self._cmp_route("GET"):
            return
        if p.startswith("/v1/") or p == "/health":
            return self._proxy("GET")
        return super().do_GET()
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/preview/detect":
            if not self._authed():
                return self._deny()
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                data = json.loads(self.rfile.read(length) or b"{}") if length else {}
                return self._json(preview_detect(data))
            except Exception as e:
                return self._json({"kind": "error", "error": str(e)[:1000]}, 200)
        if p == "/api/newchat-provider":   # 设置"新对话默认模型"(不重启 :7878)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            prov = (data.get("provider") or "").strip()
            if not re.match(r'^[a-zA-Z0-9_-]+$', prov):
                return self._json({"error": "非法 provider"}, 400)
            if prov in _NEWCHAT_REQUIRES_KEY and not _provider_key(prov):
                return self._json({"error": "腾讯混元 API key 未配置,请先在模型面板保存混元 key"}, 400)
            _set_newchat_provider(prov)
            return self._json({"ok": True, "provider": prov})
        if p == "/api/thread-provider":   # 单窗口:把当前已有对话切到指定 provider/model,下一条消息立即生效(不新建 thread/窗口)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            tid = (data.get("tid") or data.get("thread_id") or "").strip()
            prov = (data.get("provider") or "").strip()
            model = (data.get("model") or "").strip()
            if not re.match(r'^thr_[a-zA-Z0-9_-]+$', tid) or not re.match(r'^[a-zA-Z0-9_-]+$', prov):
                return self._json({"error": "非法 tid/provider"}, 400)
            if model and not re.match(r'^[A-Za-z0-9._-]+$', model):
                return self._json({"error": "非法 model"}, 400)
            try:
                return self._json(_switch_single_thread_provider(tid, prov, model or None))
            except Exception as e:
                return self._json({"error": str(e)[:200]}, 502)
        if p == "/api/model-pref":   # 设置某 provider 选用的模型变体(单窗口 + 对比共用)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            prov = (data.get("provider") or "").strip(); model = (data.get("model") or "").strip()
            effort = (data.get("effort") or "").strip().lower()   # 可选:claude 推理 effort low/medium/high(空=默认)
            if not re.match(r'^[a-zA-Z0-9_-]+$', prov) or (model and not re.match(r'^[A-Za-z0-9._-]+$', model)):
                return self._json({"error": "非法 provider/model"}, 400)
            if model: _set_model_pref(prov, model)
            effort_changed = "effort" in data
            if effort_changed:                                    # 存该 provider 的推理 effort(空字符串=清掉,用默认)
                _set_model_pref(prov + "__effort", effort if effort in ("low","medium","high","xhigh","max") else "")
            # 模型/effort 都走 env(后端启动时定):claude-code 改模型要重启;任意 provider 改 effort 要重启;其它改模型是 thread 级钉、不必重启。
            restarted = False
            if (prov == "claude-code" and model) or effort_changed:
                port = CMP_PORTS.get(prov)
                if port:
                    try:
                        pid = subprocess.run(["lsof","-nP","-tiTCP:%d"%port,"-sTCP:LISTEN"],capture_output=True,text=True).stdout.strip()
                        for x in pid.split(): subprocess.run(["kill","-9",x],capture_output=True)
                        CMP_PORTS.pop(prov, None); _PORT_UP.pop(port, None); restarted = True   # 下次 ensure 用新 env 重起
                    except Exception: pass
            return self._json({"ok": True, "provider": prov, "model": model, "restarted": restarted})
        if p == "/api/pin-thread":   # 把对话锁定到某 provider(对比模式建会话后调,让主窗口侧栏正确标 provider,不再误显默认)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            tid = (data.get("tid") or data.get("thread_id") or "").strip()
            prov = (data.get("provider") or "").strip()
            if not re.match(r'^thr_[a-zA-Z0-9_-]+$', tid) or not re.match(r'^[a-zA-Z0-9_-]+$', prov):
                return self._json({"error": "非法 tid/provider"}, 400)
            _pin_thread(tid, prov)
            try: write_cmp_threads(list(dict.fromkeys(read_cmp_threads() + [tid])))   # 本端点只被对比 cmpRun 调用(单窗口走 _pin_thread() 函数直连不经此)→ 顺带登记为对比 thread,侧栏分组,老前端也生效、compare-claude 也对
            except Exception: pass
            return self._json({"ok": True})
        if p == "/v1/threads":   # 新对话:建在"新对话默认 provider"的独立后端,并记 tid->port(每对话锁模型)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b"{}"
            prov = _newchat_provider()
            default_prov = _cfg_get("provider") or "deepseek"        # 默认 provider:建会话与路由都走 UPSTREAM:7878,保持一致
            fm = _thread_model(prov) if _CMP_FORCE_MODEL.get(prov) else None   # 把(用户选的)model 钉到 thread 级,绕过 auto 自动路由;claude-code 钉 sonnet 路由键
            if fm:
                try:
                    bd = json.loads(body or b"{}")
                    if not bd.get("model"):
                        bd["model"] = fm
                        body = json.dumps(bd).encode()
                except Exception:
                    pass
            try:
                # ★ 默认 provider → 建在主后端 :7878(UPSTREAM);_route_base 对默认 provider 的 thread 也走 UPSTREAM,
                #   "建会话的后端"="后续 turns/events 路由的后端",一致。否则建在 per-provider 后端却把 turns/events 路由到
                #   :7878 → 跨后端 seq 不一致 → 单窗口实时 SSE 只收到 thread.started、收不到 turn 事件 → 消息不显示
                #   (快照 GET 因 thread 存储跨后端共享仍能加载历史,极具迷惑性)。非默认 provider 才建在 per-provider 后端 + pin。
                base = UPSTREAM if prov == default_prov else f"http://127.0.0.1:{ensure_provider_server(prov)}"
                req = urllib.request.Request(f"{base}/v1/threads", data=body, method="POST", headers={"Content-Type": "application/json"})
                d = json.loads(_LOCAL.open(req, timeout=30).read())   # 必须用关键字 timeout!位置传 30 会被当成 data=30(int)→ http.client "message_body got int"→ 新建对话 502
                if d.get("id") and prov != default_prov:
                    _pin_thread(d["id"], prov)                       # 默认 provider 不 pin(本就走 UPSTREAM,pin 反而触发跨后端不一致)
                    _mark_single_thread(d["id"])
            except Exception as e:
                return self._json({"error": str(e)[:200]}, 502)
            return self._json(d)
        if p == "/api/compare/ensure":   # 预启动所选 provider 的独立后端,返回每个的状态
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            out = {}
            for prov in (data.get("providers") or [])[:6]:
                try:
                    out[prov] = {"ok": True, "port": ensure_provider_server(prov)}
                except Exception as e:
                    out[prov] = {"ok": False, "error": str(e)[:160]}
            return self._json(out)
        if p == "/api/compare/reset":   # 杀掉所有 per-provider 后端 + 清端口表 → 下次按需用当前配置/key 重启,杜绝残留旧后端答错模型(三栏都答 DeepSeek 的根治)
            if not self._authed():
                return self._deny()
            try:
                subprocess.run(["/usr/bin/pkill", "-f", "app-server --config " + CMP_DIR], timeout=5)
            except Exception:
                pass
            with _cmp_lock:
                CMP_PORTS.clear(); _cmp_launching.clear(); _PORT_UP.clear()
            return self._json({"ok": True})
        if p.startswith("/cmp/") and self._cmp_route("POST"):
            return
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
        if p == "/api/cmp-threads":   # 前端登记对比建的 thread id(合并写入,只增不删,避免并发窗口互相覆盖丢标记)
            if not self._authed():
                return self._deny()
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b"[]"
                data = json.loads(raw or b"[]")
                ids = data.get("ids", []) if isinstance(data, dict) else data
                merged = list(dict.fromkeys(read_cmp_threads() + [str(x) for x in (ids if isinstance(ids, list) else [])]))   # 并集去重,保序
                out = write_cmp_threads(merged)
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
            return
        if p == "/api/cmp-sessions":   # 前端 upsert 对比会话(按 id 合并,thread 更全者胜,跨窗口不互相截断)
            if not self._authed():
                return self._deny()
            try:
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b"{}"
                data = json.loads(raw or b"{}")
                sessions = data.get("sessions", []) if isinstance(data, dict) else data
                out = upsert_cmp_sessions(sessions if isinstance(sessions, list) else [])
            except Exception as e:
                out = {"error": str(e)[:200]}
            b = json.dumps(out, ensure_ascii=False).encode()
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
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/cmp/") and self._cmp_route("PATCH"):
            return
        if p.startswith("/v1/"):
            return self._proxy("PATCH")
        self.send_error(404)
    def do_DELETE(self):
        p = urllib.parse.urlparse(self.path).path
        if p.startswith("/cmp/") and self._cmp_route("DELETE"):
            return
        if p.startswith("/v1/"):
            return self._proxy("DELETE")
        self.send_error(404)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

if __name__ == "__main__":
    # 清理可能残留的旧对比 app-server(老版本无代理 env 会答错模型 / 复用旧后端)→ 下次按需重启为带修复的
    try:
        subprocess.run(["/usr/bin/pkill", "-f", "app-server --config " + CMP_DIR], timeout=5)
    except Exception:
        pass
    # 后台检查补丁二进制 + 原生 App:缺则下载,SHA 变了则刷新(OCR/二进制/原生壳 升级经此自动传播);不阻塞启动
    threading.Thread(target=lambda: _ensure_patched_binaries(block=False, refresh=True), daemon=True).start()
    threading.Thread(target=_refresh_native_app, daemon=True).start()
    threading.Thread(target=_fetch_threads_now, daemon=True).start()   # 启动即后台预热线程列表缓存(落盘)→ 首个请求秒命中,不阻塞启动
    _seed_cmp_from_tprov()   # 一次性回溯:把历史对比对话登记进侧栏分组
    print(f"CodeWhale GUI server on {BIND}:{PORT}  (token {'ENABLED' if TOKEN else 'off'})")
    Server((BIND, PORT), Handler).serve_forever()
