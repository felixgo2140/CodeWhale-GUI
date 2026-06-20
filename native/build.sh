#!/usr/bin/env bash
# 编译 CodeWhale 原生 macOS 壳为 通用二进制(arm64 + x86_64)并打成 .app。
# 需要:Xcode Command Line Tools(swiftc)。输出:<参数1 或 ./CodeWhale.app>
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/CodeWhale.app}"
echo "→ 编译 arm64 + x86_64…"
swiftc -O "$HERE/main.swift" -o /tmp/cw_arm -target arm64-apple-macos12  -framework Cocoa -framework WebKit
swiftc -O "$HERE/main.swift" -o /tmp/cw_x86 -target x86_64-apple-macos12 -framework Cocoa -framework WebKit
lipo -create /tmp/cw_arm /tmp/cw_x86 -output /tmp/cw_uni
codesign -s - --force /tmp/cw_uni        # ad-hoc 签名(arm64 必须有签名才能运行)
rm -rf "$OUT"; mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp /tmp/cw_uni "$OUT/Contents/MacOS/CodeWhale"; chmod +x "$OUT/Contents/MacOS/CodeWhale"
[ -f "$HERE/CodeWhale.icns" ] && cp "$HERE/CodeWhale.icns" "$OUT/Contents/Resources/CodeWhale.icns"
cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>CodeWhale</string>
  <key>CFBundleDisplayName</key><string>CodeWhale</string>
  <key>CFBundleIdentifier</key><string>com.codewhale.native</string>
  <key>CFBundleVersion</key><string>2.0</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>CodeWhale</string>
  <key>CFBundleIconFile</key><string>CodeWhale</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign -s - --force --deep "$OUT"
rm -f /tmp/cw_arm /tmp/cw_x86 /tmp/cw_uni
echo "✓ 已构建: $OUT"
lipo -info "$OUT/Contents/MacOS/CodeWhale"
