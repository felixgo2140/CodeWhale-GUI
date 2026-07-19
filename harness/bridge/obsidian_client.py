#!/usr/bin/env python3
"""LlamaIndex Obsidian vault bridge for CodeWhale GUI."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common_llm import chat, now_stamp, redact, write_json

VENV_PY = os.path.expanduser("~/agent-harnesses/llamaindex-venv/bin/python")
OUT = os.path.expanduser("~/harness-output/obsidian")
JOBS = os.path.join(OUT, "jobs")
INDEX_DIR = os.path.join(OUT, "index")
RECORD_CACHE_DIR = os.path.join(OUT, "records_cache")
DEFAULT_VAULT = os.path.expanduser("~/ObsidianVaults/mm")
CODEWHALE_RUNTIME = os.path.expanduser("~/.codewhale/tasks/runtime")
CODEX_HOME = os.path.expanduser("~/.codex")
ALLOWED_EXTS = {".md", ".txt"}
DENY_PARTS = {
    ".obsidian", ".git", "node_modules", "__pycache__", "secrets", "secret",
    "credentials", "credential", "private", ".ssh", ".gnupg",
}
DENY_FILE_RE = re.compile(r"(^\.env|token|secret|credential|private[_-]?key|api[_-]?key)", re.I)


def _truthy_env(name, default=True):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", "none"}


def _env_int(name, default):
    try:
        return max(0, int(os.environ.get(name, str(default))))
    except Exception:
        return default


def _job_path(jid):
    return os.path.join(JOBS, f"{jid}.json")


def _load_job(jid):
    with open(_job_path(jid), errors="replace") as f:
        return json.load(f)


def _save_job(job):
    write_json(_job_path(job["id"]), job)


def _vault_root():
    root = os.environ.get("OBSIDIAN_VAULT") or DEFAULT_VAULT
    return os.path.realpath(os.path.expanduser(root))


def _safe_file(path, root):
    rp = os.path.realpath(path)
    if not (rp == root or rp.startswith(root + os.sep)):
        return False
    ext = os.path.splitext(rp)[1].lower()
    if ext not in ALLOWED_EXTS:
        return False
    rel_parts = os.path.relpath(rp, root).split(os.sep)
    lower_parts = [p.lower() for p in rel_parts]
    if any(p in DENY_PARTS or p.startswith(".") for p in lower_parts):
        return False
    if DENY_FILE_RE.search(os.path.basename(rp)):
        return False
    try:
        if os.path.getsize(rp) > int(os.environ.get("OBSIDIAN_MAX_FILE_BYTES", "1500000")):
            return False
    except Exception:
        return False
    return True


def _files(root):
    out = []
    for base, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d.lower() not in DENY_PARTS and not d.startswith(".")]
        for name in names:
            path = os.path.join(base, name)
            if _safe_file(path, root):
                out.append(path)
    return sorted(out)


def _safe_text(text, limit=None):
    s = redact(str(text or ""))
    s = re.sub(r"data:image/[^;\s]+;base64,[A-Za-z0-9+/=\n\r]{120,}", "[base64 image omitted]", s)
    s = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", r"\1[REDACTED]", s)
    s = re.sub(r"(?i)((?:api[_-]?key|authorization|password|passwd|token|secret|credential)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;}]{6,}", r"\1[REDACTED]", s)
    s = re.sub(r"\b(ghp|github_pat|xoxb|xoxp|sk|tvly)-[A-Za-z0-9_\-.]{12,}\b", r"\1-[REDACTED]", s)
    s = re.sub(r"\n{4,}", "\n\n\n", s)
    if limit and len(s) > limit:
        return s[:limit].rstrip() + "\n...[truncated]"
    return s


def _content_text(content):
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                typ = item.get("type") or ""
                if typ in {"input_image", "image"}:
                    parts.append("[image omitted]")
                elif "text" in item:
                    parts.append(str(item.get("text") or ""))
                elif "content" in item:
                    parts.append(_content_text(item.get("content")))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    if isinstance(content, dict):
        if "text" in content:
            return str(content.get("text") or "")
        if "content" in content:
            return _content_text(content.get("content"))
    return str(content)


def _skip_record_text(text):
    s = (text or "").strip()
    if not s:
        return True
    noise_prefixes = (
        "<environment_context>", "<permissions instructions>", "<collaboration_mode>",
        "<skills_instructions>", "<plugins_instructions>", "<app-context>",
    )
    return any(s.startswith(p) for p in noise_prefixes)


def _write_if_changed(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        try:
            if open(path, encoding="utf-8", errors="replace").read() == text:
                return
        except Exception:
            pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def _cleanup_cache_dir(root, keep):
    keep = {os.path.realpath(p) for p in keep}
    if not os.path.isdir(root):
        return
    for base, _, names in os.walk(root):
        for name in names:
            path = os.path.realpath(os.path.join(base, name))
            if path.endswith(".md") and path not in keep:
                try:
                    os.remove(path)
                except Exception:
                    pass
    for base, dirs, _ in os.walk(root, topdown=False):
        for d in dirs:
            path = os.path.join(base, d)
            try:
                os.rmdir(path)
            except OSError:
                pass


def _read_json(path):
    try:
        return json.load(open(path, encoding="utf-8", errors="replace"))
    except Exception:
        return {}


def _slug(value, fallback="record"):
    s = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or fallback)).strip("-")
    return s[:120] or fallback


def _codewhale_records():
    if not _truthy_env("OBSIDIAN_INCLUDE_CODEWHALE", True):
        return [], {}
    runtime = os.path.realpath(os.path.expanduser(os.environ.get("OBSIDIAN_CODEWHALE_RUNTIME", CODEWHALE_RUNTIME)))
    threads_dir = os.path.join(runtime, "threads")
    turns_dir = os.path.join(runtime, "turns")
    items_dir = os.path.join(runtime, "items")
    if not os.path.isdir(threads_dir):
        return [], {}

    thread_paths = []
    for name in os.listdir(threads_dir):
        if name.endswith(".json"):
            path = os.path.join(threads_dir, name)
            try:
                thread_paths.append((os.path.getmtime(path), path))
            except Exception:
                pass
    thread_paths = [p for _, p in sorted(thread_paths, reverse=True)]
    max_threads = _env_int("OBSIDIAN_CODEWHALE_MAX_THREADS", 300)
    if max_threads:
        thread_paths = thread_paths[:max_threads]

    docs, meta = [], {}
    max_doc = _env_int("OBSIDIAN_RECORD_MAX_DOC_CHARS", 90000)
    max_item = _env_int("OBSIDIAN_CODEWHALE_MAX_ITEM_CHARS", 3500)
    for thread_path in thread_paths:
        th = _read_json(thread_path)
        tid = th.get("id") or os.path.splitext(os.path.basename(thread_path))[0]
        title = th.get("title") or tid
        lines = [
            f"# CodeWhale Thread: {title}",
            "",
            f"- source: codewhale",
            f"- thread_id: {tid}",
            f"- created_at: {th.get('created_at') or ''}",
            f"- updated_at: {th.get('updated_at') or ''}",
            f"- workspace: {_safe_text(th.get('workspace') or '', 600)}",
            f"- model: {_safe_text(th.get('model') or '', 120)}",
            "",
        ]
        turn_paths = []
        for name in os.listdir(turns_dir) if os.path.isdir(turns_dir) else []:
            if not name.endswith(".json"):
                continue
            path = os.path.join(turns_dir, name)
            tr = _read_json(path)
            if tr.get("thread_id") == tid:
                turn_paths.append((tr.get("created_at") or "", path, tr))
        for _, turn_path, tr in sorted(turn_paths):
            lines.extend([
                f"## Turn {tr.get('id') or os.path.splitext(os.path.basename(turn_path))[0]}",
                f"- created_at: {tr.get('created_at') or ''}",
                f"- status: {tr.get('status') or ''}",
                "",
            ])
            user_text = _safe_text(tr.get("input_summary") or "", 5000)
            if user_text and not _skip_record_text(user_text):
                lines.extend(["### User", user_text, ""])
            for iid in tr.get("item_ids") or []:
                item = _read_json(os.path.join(items_dir, f"{iid}.json"))
                kind = item.get("kind") or ""
                if kind in {"status"} and not _truthy_env("OBSIDIAN_CODEWHALE_INCLUDE_STATUS", False):
                    continue
                body = item.get("detail") or item.get("summary") or ""
                body = _safe_text(body, max_item)
                if not body or _skip_record_text(body):
                    continue
                lines.extend([
                    f"### {kind or 'item'} {item.get('id') or iid}",
                    f"- started_at: {item.get('started_at') or ''}",
                    body,
                    "",
                ])
            if sum(len(x) for x in lines) > max_doc:
                lines.append("...[thread truncated]")
                break
        text = "\n".join(lines).strip() + "\n"
        path = os.path.join(RECORD_CACHE_DIR, "codewhale", f"{_slug(tid)}.md")
        _write_if_changed(path, text)
        docs.append(path)
        rp = os.path.realpath(path)
        meta[rp] = {"path": rp, "rel_path": f"codewhale/{tid}.md", "collection": "codewhale", "thread_id": tid, "title": str(title)}
    return docs, meta


def _codex_jsonl_paths():
    roots = [
        os.path.join(CODEX_HOME, "sessions"),
        os.path.join(CODEX_HOME, "archived_sessions"),
    ]
    paths = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for base, _, names in os.walk(root):
            for name in names:
                if name.endswith(".jsonl"):
                    path = os.path.join(base, name)
                    try:
                        paths.append((os.path.getmtime(path), path))
                    except Exception:
                        pass
    paths = [p for _, p in sorted(paths, reverse=True)]
    max_files = _env_int("OBSIDIAN_CODEX_MAX_SESSIONS", 500)
    return paths[:max_files] if max_files else paths


def _codex_session_doc(path):
    title = ""
    session_id = ""
    cwd = ""
    originator = ""
    model_provider = ""
    lines = []
    msg_count = 0
    max_doc = _env_int("OBSIDIAN_RECORD_MAX_DOC_CHARS", 90000)
    max_msg = _env_int("OBSIDIAN_CODEX_MAX_MESSAGE_CHARS", 3500)
    max_msgs = _env_int("OBSIDIAN_CODEX_MAX_MESSAGES_PER_SESSION", 120)
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except Exception:
        return "", {}
    with f:
        for raw in f:
            try:
                row = json.loads(raw)
            except Exception:
                continue
            payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
            typ = row.get("type") or payload.get("type") or ""
            ts = row.get("timestamp") or payload.get("timestamp") or ""
            if typ == "session_meta":
                session_id = payload.get("session_id") or payload.get("id") or session_id
                cwd = payload.get("cwd") or cwd
                originator = payload.get("originator") or originator
                model_provider = payload.get("model_provider") or model_provider
                continue
            if typ == "event_msg" and payload.get("type") == "thread_name_updated":
                title = payload.get("thread_name") or title
                continue
            if row.get("type") != "response_item" or payload.get("type") != "message":
                continue
            role = payload.get("role") or ""
            if role not in {"user", "assistant"}:
                continue
            text = _safe_text(_content_text(payload.get("content")), max_msg)
            if _skip_record_text(text):
                continue
            lines.extend([f"## {role} @ {ts}", text, ""])
            msg_count += 1
            if (max_msgs and msg_count >= max_msgs) or sum(len(x) for x in lines) > max_doc:
                lines.append("...[session truncated]")
                break
    if not lines:
        return "", {}
    stem = os.path.splitext(os.path.basename(path))[0]
    header = [
        f"# Codex Session: {title or stem}",
        "",
        "- source: codex",
        f"- session_id: {session_id}",
        f"- title: {_safe_text(title, 300)}",
        f"- cwd: {_safe_text(cwd, 400)}",
        f"- originator: {_safe_text(originator, 120)}",
        f"- model_provider: {_safe_text(model_provider, 120)}",
        f"- source_file: {path}",
        "",
    ]
    meta = {"session_id": session_id, "title": title or stem}
    return "\n".join(header + lines).strip() + "\n", meta


def _codex_records():
    if not _truthy_env("OBSIDIAN_INCLUDE_CODEX", True):
        return [], {}
    docs, meta = [], {}
    for path in _codex_jsonl_paths():
        text, info = _codex_session_doc(path)
        if not text:
            continue
        stem = _slug(os.path.splitext(os.path.basename(path))[0])
        out = os.path.join(RECORD_CACHE_DIR, "codex", f"{stem}.md")
        _write_if_changed(out, text)
        docs.append(out)
        rp = os.path.realpath(out)
        rel = f"codex/{stem}.md"
        meta[rp] = {
            "path": rp,
            "rel_path": rel,
            "collection": "codex",
            "session_id": info.get("session_id") or "",
            "title": info.get("title") or stem,
        }
    return docs, meta


def _record_docs():
    os.makedirs(RECORD_CACHE_DIR, exist_ok=True)
    docs, meta = [], {}
    for maker in (_codewhale_records, _codex_records):
        part_docs, part_meta = maker()
        docs.extend(part_docs)
        meta.update(part_meta)
    _cleanup_cache_dir(RECORD_CACHE_DIR, docs)
    return docs, meta


def _manifest(files, scope):
    rows = []
    for path in files:
        st = os.stat(path)
        rows.append([os.path.realpath(path), int(st.st_mtime), int(st.st_size)])
    raw = json.dumps(rows, ensure_ascii=False, sort_keys=True)
    return {"scope": scope, "count": len(files), "hash": hashlib.sha256(raw.encode()).hexdigest(), "files": rows}


def _load_manifest():
    try:
        return json.load(open(os.path.join(INDEX_DIR, "manifest.json"), encoding="utf-8"))
    except Exception:
        return {}


def _save_manifest(man):
    os.makedirs(INDEX_DIR, exist_ok=True)
    write_json(os.path.join(INDEX_DIR, "manifest.json"), man)


def _file_metadata(root, metadata_by_path):
    def meta(path):
        rp = os.path.realpath(path)
        if rp in metadata_by_path:
            return dict(metadata_by_path[rp])
        return {"path": rp, "rel_path": os.path.relpath(rp, root)}
    return meta


def _build_or_load_index(job, scope, root, files, man, metadata_by_path):
    from llama_index.core import Settings, SimpleDirectoryReader, StorageContext, VectorStoreIndex, load_index_from_storage

    model_name = os.environ.get("OBSIDIAN_EMBED_MODEL", "mock").strip()
    if model_name and model_name.lower() not in {"mock", "local", "none"}:
        from llama_index.embeddings.huggingface import HuggingFaceEmbedding
        Settings.embed_model = HuggingFaceEmbedding(
            model_name=model_name,
            cache_folder=os.path.expanduser("~/.cache/huggingface"),
        )
    else:
        from llama_index.core.embeddings import MockEmbedding
        Settings.embed_model = MockEmbedding(embed_dim=384)
    Settings.llm = None
    old = _load_manifest()
    if old.get("hash") == man.get("hash") and os.path.exists(os.path.join(INDEX_DIR, "default__vector_store.json")):
        job["stage"] = "1/3 加载已有私人知识库索引"
        _save_job(job)
        return load_index_from_storage(StorageContext.from_defaults(persist_dir=INDEX_DIR))
    job["stage"] = f"1/3 重建私人知识库索引({len(files)} files)"
    _save_job(job)
    docs = SimpleDirectoryReader(
        input_files=files,
        filename_as_id=True,
        file_metadata=_file_metadata(root, metadata_by_path),
        errors="ignore",
    ).load_data()
    index = VectorStoreIndex.from_documents(docs, show_progress=False)
    os.makedirs(INDEX_DIR, exist_ok=True)
    index.storage_context.persist(persist_dir=INDEX_DIR)
    _save_manifest(man)
    return index


def _terms(query):
    vals = re.findall(r"[\u4e00-\u9fff]{2,}|[A-Za-z0-9_.$-]{2,}", query)
    out, seen = [], set()
    for v in vals:
        k = v.lower()
        if k not in seen:
            seen.add(k)
            out.append(v)
    return out[:16]


def _lexical_hits(query, root, files, metadata_by_path, limit=8):
    terms = _terms(query)
    if not terms:
        return []
    hits = []
    for path in files:
        try:
            txt = open(path, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        score = 0
        lower = txt.lower()
        for t in terms:
            score += lower.count(t.lower())
        if score <= 0:
            continue
        pos = min([p for p in [lower.find(t.lower()) for t in terms] if p >= 0] or [0])
        start = max(0, pos - 300)
        snippet = txt[start:start + 1300].strip()
        rp = os.path.realpath(path)
        md = dict(metadata_by_path.get(rp) or {})
        hits.append({
            "score": score,
            "path": rp,
            "rel_path": md.get("rel_path") or os.path.relpath(rp, root),
            "collection": md.get("collection") or "obsidian",
            "text": snippet,
            "source": "keyword",
        })
    return sorted(hits, key=lambda x: x["score"], reverse=True)[:limit]


def _vector_hits(index, query, limit=8):
    hits = []
    retriever = index.as_retriever(similarity_top_k=limit)
    for node in retriever.retrieve(query):
        n = node.node
        meta = dict(getattr(n, "metadata", {}) or {})
        text = n.get_content(metadata_mode="none") if hasattr(n, "get_content") else str(n.text)
        hits.append({
            "score": float(getattr(node, "score", 0) or 0),
            "path": meta.get("path") or "",
            "rel_path": meta.get("rel_path") or meta.get("file_name") or "",
            "collection": meta.get("collection") or "obsidian",
            "text": text[:1600],
            "source": "vector",
        })
    return hits


def _dedupe(hits):
    out, seen = [], set()
    for h in hits:
        key = (h.get("path") or h.get("rel_path") or "") + "|" + (h.get("text") or "")[:120]
        if key in seen:
            continue
        seen.add(key)
        out.append(h)
    return out


def _context_md(hits):
    lines = []
    for i, h in enumerate(hits, 1):
        lines.append(
            f"[O{i}] {h.get('rel_path') or h.get('path')}\n"
            f"来源: {h.get('collection') or 'obsidian'}\n"
            f"方式: {h.get('source')} score={h.get('score')}\n"
            f"摘录:\n{(h.get('text') or '').strip()[:1600]}"
        )
    return "\n\n".join(lines)


def _answer(job, scope, stats, files, hits):
    if not hits:
        return "# 私人知识库回答\n\n没有在当前索引范围中检索到相关片段。\n"
    content, meta = chat([
        {"role": "system", "content": (
            "你是私人知识库助手。给定片段可能来自 Obsidian vault、CodeWhale 对话记录或 Codex session 记录。只能基于给定片段回答。"
            "不要编造未出现的笔记内容。所有结论引用 [O数字]。用简体中文。"
        )},
        {"role": "user", "content": (
            f"问题:\n{job['query']}\n\n"
            f"索引范围:\n{scope}\n"
            f"来源统计:{json.dumps(stats, ensure_ascii=False)}\n"
            f"文件数:{len(files)}\n\n"
            f"检索片段:\n{_context_md(hits)}\n\n"
            "请输出:直接回答、相关记录归类、可复用判断、还需要补充的资料、引用列表。"
        )},
    ], job.get("model", ""), temperature=0.15, max_tokens=7000)
    job["llm_calls"] = int(job.get("llm_calls") or 0) + 1
    job["in_tokens"] = int(job.get("in_tokens") or 0) + int(meta.get("in_tokens") or 0)
    job["out_tokens"] = int(job.get("out_tokens") or 0) + int(meta.get("out_tokens") or 0)
    job["model_label"] = meta.get("label", "")
    job["provider_model"] = meta.get("model", "")
    _save_job(job)
    header = [
        "# 私人知识库回答",
        "",
        f"- **问题**: {job['query'][:240]}",
        f"- **索引范围**: `{scope}`",
        f"- **索引文件数**: {len(files)}",
        f"- **来源统计**: {json.dumps(stats, ensure_ascii=False)}",
        f"- **LLM**: {job.get('model_label') or ''} · {job.get('provider_model') or job.get('model') or ''}",
        "- **安全策略**: 只读 Obsidian `.md/.txt` + 派生的 CodeWhale/Codex markdown 记录;排除隐藏目录、密钥/secret/token/private 文件;仅命中片段发送给 LLM。",
        "",
        "---",
        "",
    ]
    refs = ["", "## 命中片段"]
    for i, h in enumerate(hits, 1):
        refs.append(f"- [O{i}] `{h.get('rel_path') or h.get('path')}` ({h.get('collection') or 'obsidian'}, {h.get('source')}, score={h.get('score')})")
    return "\n".join(header) + content.strip() + "\n" + "\n".join(refs) + "\n"


def cmd_submit(prompt, model=""):
    os.makedirs(JOBS, exist_ok=True)
    jid = uuid.uuid4().hex[:12]
    job = {"id": jid, "status": "running", "query": prompt, "model": model, "started": time.time(), "stage": "queued"}
    _save_job(job)
    py = VENV_PY if os.path.exists(VENV_PY) else sys.executable
    subprocess.Popen(
        [py, os.path.abspath(__file__), "run", jid],
        start_new_session=True,
        stdout=open(os.path.join(JOBS, f"{jid}.log"), "w"),
        stderr=subprocess.STDOUT,
    )
    print(json.dumps({"ok": True, "thread_id": jid}, ensure_ascii=False))


def cmd_run(jid):
    job = _load_job(jid)
    try:
        root = _vault_root()
        files = []
        metadata_by_path = {}
        stats = {"obsidian": 0, "codewhale": 0, "codex": 0}
        if os.path.isdir(root):
            vault_files = _files(root)
            files.extend(vault_files)
            stats["obsidian"] = len(vault_files)
            for path in vault_files:
                rp = os.path.realpath(path)
                metadata_by_path[rp] = {
                    "path": rp,
                    "rel_path": os.path.relpath(rp, root),
                    "collection": "obsidian",
                }
        elif _truthy_env("OBSIDIAN_REQUIRE_VAULT", False):
            raise RuntimeError(f"Obsidian vault 不存在: {root}")

        record_files, record_meta = _record_docs()
        files.extend(record_files)
        metadata_by_path.update(record_meta)
        for p in record_files:
            col = (record_meta.get(os.path.realpath(p)) or {}).get("collection")
            if col in stats:
                stats[col] += 1

        if not files:
            raise RuntimeError("当前索引范围内没有可索引的 Obsidian/CodeWhale/Codex 文档")
        scope = f"Obsidian:{root}; CodeWhale:{CODEWHALE_RUNTIME}; Codex:{CODEX_HOME}"
        man = _manifest(files, scope)
        index = _build_or_load_index(job, scope, root, files, man, metadata_by_path)
        job["stage"] = "2/3 检索私人知识库片段"
        _save_job(job)
        hits = _dedupe(_lexical_hits(job["query"], root, files, metadata_by_path) + _vector_hits(index, job["query"]))
        job["msg_count"] = len(hits)
        job["stage"] = "3/3 生成引用回答"
        _save_job(job)
        md = _answer(job, scope, stats, files, hits[:12])
        fn = f"obsidian_{now_stamp()}_{jid}.md"
        path = os.path.join(OUT, fn)
        os.makedirs(OUT, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(md)
        job.update(status="success", file=fn, path=path, stage="done", updated=time.time())
    except Exception as e:
        job.update(status="error", error=redact(str(e))[:1500], stage="error", updated=time.time())
    _save_job(job)


def cmd_progress(jid):
    try:
        job = _load_job(jid)
    except Exception:
        print(json.dumps({"status": "pending"}, ensure_ascii=False))
        return
    tail, nlines = "", 0
    try:
        log = open(os.path.join(JOBS, f"{jid}.log"), errors="replace").read()
        tail = redact(log[-3000:])
        nlines = len([l for l in log.splitlines() if l.strip()])
    except Exception:
        pass
    out = {
        "status": job.get("status", "unknown"),
        "tail": tail or job.get("stage", ""),
        "msg_count": job.get("msg_count") or nlines,
        "llm_calls": job.get("llm_calls", 0),
        "in_tokens": job.get("in_tokens", 0),
        "out_tokens": job.get("out_tokens", 0),
    }
    if job.get("error"):
        out["error"] = redact(job["error"])
    print(json.dumps(out, ensure_ascii=False))


def cmd_sources(_arg=None):
    root = _vault_root()
    vault_files = _files(root) if os.path.isdir(root) else []
    record_files, record_meta = _record_docs()
    stats = {"obsidian": len(vault_files), "codewhale": 0, "codex": 0}
    for p in record_files:
        col = (record_meta.get(os.path.realpath(p)) or {}).get("collection")
        if col in stats:
            stats[col] += 1
    print(json.dumps({
        "ok": True,
        "scope": {
            "obsidian": root,
            "codewhale": CODEWHALE_RUNTIME,
            "codex": CODEX_HOME,
        },
        "enabled": {
            "codewhale": _truthy_env("OBSIDIAN_INCLUDE_CODEWHALE", True),
            "codex": _truthy_env("OBSIDIAN_INCLUDE_CODEX", True),
        },
        "stats": stats,
        "record_cache": RECORD_CACHE_DIR,
        "total_files": len(vault_files) + len(record_files),
    }, ensure_ascii=False))


def cmd_result(jid):
    try:
        job = _load_job(jid)
    except Exception:
        print(json.dumps({"ok": False, "error": "job 不存在"}, ensure_ascii=False))
        return
    if job.get("path") and os.path.exists(job["path"]):
        print(json.dumps({
            "ok": True,
            "output": open(job["path"], errors="replace").read(),
            "file": job.get("file"),
            "path": job.get("path"),
        }, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "error": redact(job.get("error") or "无结果")}, ensure_ascii=False))


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: obsidian_client.py submit <prompt> [--model hunyuan|deepseek|zai|kimi|longcat|volcengine] | run|progress|result <job_id> | sources _")
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
        {"run": cmd_run, "progress": cmd_progress, "result": cmd_result, "sources": cmd_sources}[cmd](arg)


if __name__ == "__main__":
    main()
