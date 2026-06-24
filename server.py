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
import base64, hashlib, tarfile, tempfile, io, threading, ssl, socket, ipaddress

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, "web")
CFG = os.path.expanduser("~/.codewhale/config.toml")
TOKEN_FILE = os.path.expanduser("~/.codewhale-gui/token")
PINS_FILE = os.path.expanduser("~/.codewhale-gui/pins.json")
UPSTREAM = "http://127.0.0.1:7878"
_LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 本机 app-server 请求绝不走代理(代理会劫持 127.0.0.1 导致超时)
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
_CMP_PIN_MODEL = {"zai": "GLM-5.2"}
def _cmp_safe(prov):
    return re.sub(r'[^a-zA-Z0-9_-]', '_', prov)
def _cmp_write_config(prov):
    os.makedirs(CMP_DIR, exist_ok=True)
    s = open(CFG, encoding="utf-8").read()                       # 从主配置派生,带上所有 provider 的 key
    if re.search(r'(?m)^provider\s*=', s):
        s = re.sub(r'(?m)^provider\s*=.*$', f'provider = "{prov}"', s, count=1)
    else:
        s = f'provider = "{prov}"\n' + s
    if re.search(r'(?m)^default_text_model\s*=', s):
        s = re.sub(r'(?m)^default_text_model\s*=.*$', f'default_text_model = "{_cmp_model(prov)}"', s, count=1)
    else:
        s = f'default_text_model = "{_cmp_model(prov)}"\n' + s
    pin = _CMP_PIN_MODEL.get(prov)                               # 固定 [providers.<prov>].model → 该栏稳定用对的模型,不再被 auto 路由带跑
    if pin:
        hdr = f"[providers.{prov}]"
        if re.search(r'(?m)^' + re.escape(hdr) + r'\s*$', s):
            # 替换该段紧跟 header 的 model 行;没有就插入(header 后通常是 api_key,不会误吞)
            s = re.sub(r'(?m)^' + re.escape(hdr) + r'[ \t]*\n([ \t]*model[ \t]*=.*\n)?',
                       hdr + "\n" + f'model = "{pin}"\n', s, count=1)
        else:
            s = s.rstrip() + f"\n\n{hdr}\nmodel = \"{pin}\"\n"
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
                logf = open(os.path.expanduser(f"~/codewhale-gui/cmp-{_cmp_safe(prov)}.log"), "a")
                subprocess.Popen([CODEWHALE, "app-server", "--config", cfg, "--http", "--host", "127.0.0.1",
                                  "--port", str(port), "--insecure-no-auth"],
                                 env=env, cwd=os.path.expanduser("~"), stdout=logf, stderr=subprocess.STDOUT)
        for _ in range(50):                                      # 就绪等待在锁外:启动 A 不再阻塞切到 B(消除连环卡顿),最多 ~20s
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
NEWCHAT_FILE = os.path.expanduser("~/.codewhale-gui/newchat.json")
def _newchat_provider():
    try:
        p = (json.load(open(NEWCHAT_FILE)).get("provider") or "").strip()
        if p: return p
    except Exception:
        pass
    return _cfg_get("provider") or "deepseek"
def _set_newchat_provider(prov):
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
def aggregate_threads():     # 共享存储::7878 已含全部会话,只查它;按锁定表给每条标 provider
    try:
        arr = json.load(_LOCAL.open(f"http://127.0.0.1:7878/v1/threads/summary?limit=50", timeout=8))
    except Exception:
        return []
    if not isinstance(arr, list):
        return []
    dflt = _cfg_get("provider") or "deepseek"
    for t in arr:
        t["provider"] = _tprov.get(t.get("id")) or dflt
    return arr

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
    def _proxy_to(self, method, port, upstream_path):   # 代理到指定 provider 的独立 app-server(SSE 流式)
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(f"http://127.0.0.1:{port}{upstream_path}", data=body, method=method)
        ct = self.headers.get("Content-Type")
        if ct:
            req.add_header("Content-Type", ct)
        try:
            resp = _LOCAL.open(req, timeout=600)
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
        except (BrokenPipeError, ConnectionResetError, OSError):
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
        self._proxy_to(method, port, upstream)
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
            resp = _LOCAL.open(req, timeout=600)
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
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass

    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
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
        if p.startswith("/cmp/") and self._cmp_route("GET"):
            return
        if p.startswith("/v1/") or p == "/health":
            return self._proxy("GET")
        return super().do_GET()
    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        if p == "/api/newchat-provider":   # 设置"新对话默认模型"(不重启 :7878)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            data = json.loads(self.rfile.read(length) or b"{}") if length else {}
            prov = (data.get("provider") or "").strip()
            if not re.match(r'^[a-zA-Z0-9_-]+$', prov):
                return self._json({"error": "非法 provider"}, 400)
            _set_newchat_provider(prov)
            return self._json({"ok": True, "provider": prov})
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
            return self._json({"ok": True})
        if p == "/v1/threads":   # 新对话:建在"新对话默认 provider"的独立后端,并记 tid->port(每对话锁模型)
            if not self._authed():
                return self._deny()
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else b"{}"
            prov = _newchat_provider()
            try:
                port = ensure_provider_server(prov)
                req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/threads", data=body, method="POST", headers={"Content-Type": "application/json"})
                d = json.loads(_LOCAL.open(req, 30).read())
                if d.get("id"):
                    _pin_thread(d["id"], prov)
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
    print(f"CodeWhale GUI server on {BIND}:{PORT}  (token {'ENABLED' if TOKEN else 'off'})")
    Server((BIND, PORT), Handler).serve_forever()
