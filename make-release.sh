#!/usr/bin/env bash
# CodeWhale GUI 发版:打包 web/+server.py+VERSION → 算 SHA-256 → 生成清单 → 用私钥 Ed25519 签名。
# 用法: make-release.sh <版本号 如 2.1.0> ["发布说明"]
set -e
VERSION="${1:?用法: make-release.sh <版本号 如 2.1.0> [发布说明]}"
NOTES="${2:-}"
SRC="$HOME/codewhale-gui"
KEY="$HOME/codewhale-release/signing-key.pem"
OUT="$HOME/codewhale-release/dist/$VERSION"
[ -f "$KEY" ] || { echo "✗ 私钥不在 $KEY,无法签名"; exit 1; }
mkdir -p "$OUT"
echo "$VERSION" > "$SRC/VERSION"
BUNDLE="gui-$VERSION.tar.gz"
( cd "$SRC" && COPYFILE_DISABLE=1 tar --exclude='.DS_Store' --exclude='*.bak*' -czf "$OUT/$BUNDLE" web server.py VERSION )
# claude-code 补丁二进制(供 server.py lazy-fetch 自动下载):拷到发布目录 + 把 SHA-256/arch 写进签名清单。
BINDIR="$HOME/.codewhale-gui/bin"
for b in codewhale-claude codewhale-tui; do
  if [ -f "$BINDIR/$b" ]; then cp "$BINDIR/$b" "$OUT/$b"; else echo "  ⚠ 缺补丁二进制 $b —— lazy-fetch 将不可用"; fi
done
python3 - "$VERSION" "$NOTES" "$OUT/$BUNDLE" "$BUNDLE" "$KEY" "$OUT" <<'PY'
import sys,hashlib,json,base64,os,subprocess
from cryptography.hazmat.primitives import serialization as ser
ver,notes,bpath,bname,key,out=sys.argv[1:7]
def sha(p):
    import hashlib; h=hashlib.sha256();
    with open(p,'rb') as f:
        for c in iter(lambda:f.read(1<<20),b''): h.update(c)
    return h.hexdigest()
blob=open(bpath,'rb').read()
man={"version":ver,"notes":notes,"bundle":bname,"sha256":hashlib.sha256(blob).hexdigest(),"size":len(blob)}
bins=[]
for name in ("codewhale-claude","codewhale-tui"):
    p=os.path.join(out,name)
    if os.path.exists(p):
        try: arch=subprocess.run(["lipo","-archs",p],capture_output=True,text=True).stdout.strip() or "arm64"
        except Exception: arch="arm64"
        bins.append({"name":name,"sha256":sha(p),"size":os.path.getsize(p),"arch":arch})
if bins: man["binaries"]=bins                                          # 二进制清单进签名清单 → SHA-256 可信
man_bytes=json.dumps(man,ensure_ascii=False,sort_keys=True).encode()   # 签的就是写进 manifest.json 的字节
open(os.path.join(out,"manifest.json"),'wb').write(man_bytes)
priv=ser.load_pem_private_key(open(key,'rb').read(),password=None)
open(os.path.join(out,"manifest.json.sig"),'w').write(base64.b64encode(priv.sign(man_bytes)).decode())
print(f"  version={ver} size={len(blob)} sha256={man['sha256'][:16]}…  binaries={[b['name']+'('+b['arch']+')' for b in bins]}")
PY
echo "✓ 发布产物($OUT):"; ls -1 "$OUT"
echo "→ 上传到 GitHub Release(同一个 release):"
echo "    $BUNDLE / manifest.json / manifest.json.sig"
echo "    codewhale-claude / codewhale-tui  (lazy-fetch 自动下载用;资产名必须正好这俩)"
