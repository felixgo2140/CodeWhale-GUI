[简体中文](README.md) | **English**

# CodeWhale GUI 🐳

A **native macOS desktop interface** for [CodeWhale](https://github.com/Hmbown/CodeWhale) (DeepSeek-TUI, the DeepSeek V4 terminal coding agent) — multi-session, streaming output, tool approvals, file upload, one-click model switching, and **signature-verified secure online updates**.

No Chrome dependency. Universal binary for both Intel and Apple Silicon (~82 KB).

---

## ✨ Features

- **Native macOS app** (Swift + WKWebView): real native window, standard traffic-light controls, remembers window size, Dock click re-focuses the window, zero browser dependency
- **Multi-session** sidebar + streaming output + tool-call approval cards + terminal blocks
- **One-click model switching**: DeepSeek / GLM (Zhipu·Z.ai) / Kimi (Moonshot) / OpenAI / ChatGPT (OAuth) / Claude / OpenRouter / DeepInfra … (sidebar "🧠 Model")
- **Balance display** bound to the current provider (live balance for DeepSeek; a source hint for others)
- **File upload**: drag-and-drop / 📎 button / paste → saved to the workspace, read by the agent
- **Skills panel**: browse / search / view SKILL.md / create a skill
- **Connectors (MCP) panel**: list MCP servers with live status, toggle / add / remove
- **Message actions**: copy / edit-and-resend; tool-call and file-change blocks collapsed by default; scroll up to read history without being yanked back during streaming, "↓ back to bottom" to re-follow
- **Mobile access** (PWA): token-authenticated, backend bound to `127.0.0.1` only, data stays local
- **🔐 Signature-verified secure online updates**: Ed25519 signature + SHA-256 integrity + no-downgrade + path containment + atomic swap + rollback on failure

---

## 📦 Install (macOS 12+)

**Prerequisites**: Node.js, python3 (usually preinstalled on macOS). **No Chrome or any browser needed.**

1. Download `codewhale-installer.tar.gz` from [Releases](../../releases) and unpack it;
2. Double-click `install.command` (first run: if Gatekeeper blocks it, right-click → "Open" → "Open" again, just once);
3. Pick a **model provider** (DeepSeek / GLM / Kimi / OpenAI / other) → **paste the matching API key**;
4. It installs and launches automatically; later open from Launchpad / Spotlight by searching "CodeWhale".

To switch models afterwards: use "🧠 Model" at the bottom-left of the app anytime.

---

## 🔐 Security model

- The backend (codewhale app-server / the frontend server.py) **binds to `127.0.0.1` only**; LAN / mobile access requires a **token**, and without one it fails closed to loopback binding — the agent is never exposed unprotected.
- API keys are stored locally in `~/.codewhale/config.toml` (mode 600) and never leave the machine.
- **Online updates are fully verified end-to-end**: every update bundle must be signed with the maintainer's private key; the client verifies it with an **embedded public key** → checks SHA-256 → enforces version monotonicity (no downgrade) → on extraction, validates each path (only `web/`, `server.py`, `VERSION` allowed; symlinks / path traversal rejected) → backs up, then swaps atomically with rollback on failure. **Even if the update server is compromised, no tampered or malicious update can be pushed without the maintainer's private key.**

---

## 🚀 Publishing an update (maintainer)

```bash
~/codewhale-release/make-release.sh <version e.g. 2.0.1> "what changed"
# Produces 3 files: gui-<version>.tar.gz / manifest.json / manifest.json.sig
# → upload them to a new GitHub Release in this repo (same release)
```

Users auto-check on launch / hourly and apply with one click ("↑ UI vX.Y") after signature verification. See `RELEASE-GUIDE.txt`.

> ⚠️ The signing private key is the root of update trust: keep an offline backup (USB / password manager), and never commit it to git / cloud sync / the installer.

---

## 🏗 Architecture

| Component | Notes |
|---|---|
| Frontend | `web/index.html`, a single-file SPA (no build step) |
| Server | `server.py`: static serving + token-gated reverse proxy of `/v1/*` to codewhale, plus balance / MCP / Skills / model-switch / update endpoints |
| Native shell | `native/main.swift`: a WKWebView pointed at `127.0.0.1:3000` |
| Backend | `codewhale app-server` (:7878); frontend at :3000, both launchd-managed for auto-start |

Build the native app: `native/build.sh`. Build the shareable installer: `package-installer.sh`.

---

## License

MIT. Built on [CodeWhale](https://github.com/Hmbown/CodeWhale) / DeepSeek-TUI.
