/* ---------- app preview ---------- */
function previewAbs(u){ if(!u)return ""; return u.startsWith("/") ? location.origin+u : u; }
function previewIsOpen(){ const p=$("#previewPane"); return !!p && !p.hidden; }
function previewTrustedUrl(raw){
  try{
    if(!String(raw||"").trim()) return false;
    const u=new URL(previewAbs(raw),location.href);
    const host=u.hostname.replace(/^\[|\]$/g,"");
    return u.protocol==="file:" || u.origin===location.origin || ["localhost","127.0.0.1","0.0.0.0","::1"].includes(host);
  }catch(e){ return false; }
}
function previewSameOrigin(raw){
  try{ return new URL(previewAbs(raw||""),location.href).origin===location.origin; }catch(e){ return false; }
}
function previewDownloadUrl(raw=preview.url){
  try{
    const u=new URL(previewAbs(raw||""),location.href);
    const p=u.pathname;
    if(u.origin===location.origin && (p==="/api/deerflow/file" || /^\/api\/harness\/[a-z0-9_-]+\/file$/i.test(p))){
      ["html","as_html","inline","cw_reload"].forEach(k=>u.searchParams.delete(k));
      return u.toString();
    }
    if(u.origin===location.origin && p==="/api/file/download") return u.toString();
    if(/\.(?:pdf|md|txt|csv|docx?|xlsx?|pptx?|zip)$/i.test(p)) return u.toString();
  }catch(e){}
  return "";
}
function previewDownloadName(raw=preview.url){
  try{
    const u=new URL(previewAbs(raw||""),location.href);
    const qn=u.searchParams.get("name") || u.searchParams.get("file") || "";
    const base=qn || decodeURIComponent((u.pathname.split("/").pop()||"download").replace(/\+/g," "));
    return (base||"download").replace(/[\\/:*?"<>|]/g,"_");
  }catch(e){ return "download"; }
}
function previewUpdateDownload(raw=preview.url){
  previewQueueFileActions(raw);
  const b=$("#pvDownload"); if(!b) return;
  const href=previewDownloadUrl(raw);
  b.disabled=!href;
  b.classList.toggle("disabled", !href);
  b.title=href ? "下载当前预览文件" : "当前预览不是可下载文件";
}
function previewDownload(){
  const href=previewDownloadUrl();
  if(!href){ cwToast("当前预览没有可下载文件"); return; }
  const a=document.createElement("a");
  a.href=href;
  a.download=previewDownloadName(preview.url);
  a.rel="noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function previewSetFileActionState(enabled, hint=""){
  const summary=$("#pvOpenSummary"), menu=$("#pvOpenMenu");
  if(summary){
    summary.classList.toggle("disabled", !enabled);
    summary.setAttribute("aria-disabled", enabled?"false":"true");
    summary.title = enabled ? "用本机应用打开当前文件" : (hint || "当前预览不是本地文件");
  }
  if(menu && !enabled) menu.removeAttribute("open");
  ["#pvOpenDefault","#pvDownloadSource","#pvExportPdf","#pvReveal"].forEach(sel=>{
    const b=$(sel); if(!b) return;
    b.disabled=!enabled;
    b.classList.toggle("disabled", !enabled);
    if(hint) b.title=enabled ? (b.dataset.title || b.title || "") : hint;
  });
}
function previewLocalHref(path, inline=false){
  return location.origin + "/api/file/download?path=" + encodeURIComponent(path) + (inline ? "&inline=1" : "");
}
async function previewFileInfo(raw=preview.url, force=false){
  const u=previewAbs(raw||"");
  if(!u) return null;
  const cache=preview.fileInfoCache;
  if(!force && cache && cache.url===u && Date.now()-(cache.t||0)<10000) return cache.data;
  const data=await api("/api/preview/file-info?url="+encodeURIComponent(u));
  preview.fileInfoCache={url:u,t:Date.now(),data};
  return data;
}
function previewRenderFileApps(info){
  const box=$("#pvOpenApps");
  if(!box) return;
  box.innerHTML="";
  const apps=Array.isArray(info&&info.apps) ? info.apps : [];
  if(!apps.length){
    const d=document.createElement("div");
    d.className="pv-menu-empty";
    d.textContent="没有找到额外 App";
    box.appendChild(d);
    return;
  }
  apps.forEach(app=>{
    const btn=document.createElement("button");
    btn.type="button";
    btn.className="pv-menu-item"+(app.default?" is-default":"");
    btn.title=app.path||"";
    btn.innerHTML=(typeof icon==="function"?icon("monitor"):"")+"<span></span>";
    const label=btn.querySelector("span");
    if(label) label.textContent=(app.name||"打开")+(app.default?"（默认）":"");
    btn.onclick=async e=>{
      e.preventDefault();
      try{
        await previewOpenFile({action:"app",bundle_id:app.bundle_id||"",app_path:app.path||""});
        previewCloseOpenMenu();
      }catch(err){ cwToast(err.message||"打开失败"); }
    };
    box.appendChild(btn);
  });
}
function previewQueueFileActions(raw=preview.url){
  clearTimeout(preview.fileInfoTimer);
  preview.fileInfoTimer=setTimeout(()=>previewUpdateFileActions(raw), 140);
}
async function previewUpdateFileActions(raw=preview.url, force=false){
  const u=previewAbs(raw||"");
  const seq=(preview.fileInfoSeq||0)+1;
  preview.fileInfoSeq=seq;
  if(!u){
    previewSetFileActionState(false, "当前没有预览文件");
    previewRenderFileApps(null);
    return;
  }
  const loading=$("#pvOpenApps");
  if(loading && force) loading.innerHTML='<div class="pv-menu-empty">读取打开方式...</div>';
  try{
    const info=await previewFileInfo(u, force);
    if(preview.fileInfoSeq!==seq || previewAbs(preview.url||"")!==u) return;
    if(!info || !info.ok || !info.path) throw new Error((info&&info.error)||"当前预览不是本地文件");
    previewSetFileActionState(true);
    previewRenderFileApps(info);
  }catch(e){
    if(preview.fileInfoSeq!==seq) return;
    previewSetFileActionState(false, "当前预览不是可操作的本地文件");
    previewRenderFileApps(null);
  }
}
function previewCloseOpenMenu(){
  const menu=$("#pvOpenMenu");
  if(menu) menu.removeAttribute("open");
}
async function previewOpenFile(payload={}){
  const info=await previewFileInfo(preview.url, true);
  if(!info || !info.ok || !info.path) throw new Error("当前预览不是本地文件");
  return api("/api/file/open",{method:"POST",body:JSON.stringify(Object.assign({path:info.path},payload))});
}
async function previewOpenDefault(){
  try{
    await previewOpenFile({action:"open"});
    cwToast("已交给系统默认 App 打开");
    previewCloseOpenMenu();
  }catch(e){ cwToast(e.message||"打开失败"); }
}
async function previewReveal(){
  try{
    await previewOpenFile({action:"reveal"});
    previewCloseOpenMenu();
  }catch(e){ cwToast(e.message||"在 Finder 中显示失败"); }
}
async function previewDownloadSource(){
  try{
    const info=await previewFileInfo(preview.url, true);
    if(!info || !info.ok || !info.path) throw new Error("当前预览不是本地文件");
    const a=document.createElement("a");
    a.href=previewAbs(info.download_url || previewLocalHref(info.path));
    a.download=info.name || previewDownloadName(preview.url);
    a.rel="noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    previewCloseOpenMenu();
  }catch(e){
    previewDownload();
  }
}
async function previewExportPdf(){
  const b=$("#pvExportPdf");
  const old=b?b.innerHTML:"";
  if(b){ b.disabled=true; b.classList.add("busy"); b.textContent="导出中"; }
  try{
    const out=await api("/api/preview/export-pdf",{method:"POST",body:JSON.stringify({url:preview.url})});
    if(!out || !out.ok) throw new Error((out&&out.error)||"导出失败");
    const a=document.createElement("a");
    a.href=previewAbs(out.download_url || previewLocalHref(out.path));
    a.download=out.name || "CodeWhale.pdf";
    a.rel="noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    cwToast(out.existing ? "已下载 PDF" : "已导出 PDF 到下载目录");
  }catch(e){
    cwToast(e.message||"导出 PDF 失败");
  }finally{
    if(b){ b.disabled=false; b.classList.remove("busy"); b.innerHTML=old; previewUpdateFileActions(preview.url,true); }
  }
}
function previewSandboxValue(raw){
  const target = raw||preview.url;
  // Same-origin preview (e.g. /preview/static/<pid>/) holds UNTRUSTED model/dist HTML.
  // Granting allow-same-origin there lets it read parent localStorage (cw_token) and
  // call authenticated APIs = token leak + RCE. Only cross-origin dev URLs may keep
  // allow-same-origin (they get their own origin, harmless to us).
  const safe = preview.sandboxMode==="safe"
    || previewSameOrigin(target)
    || (preview.sandboxMode==="auto" && !previewTrustedUrl(target));
  return safe ? "allow-scripts allow-forms allow-popups allow-downloads" : "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads";
}
function previewApplySandbox(raw){
  const f=$("#previewFrame"); if(!f) return;
  const val=previewSandboxValue(raw);
  if(f.getAttribute("sandbox")!==val) f.setAttribute("sandbox",val);
  const sel=$("#pvSandboxMode"); if(sel) sel.value=preview.sandboxMode;
}
function previewShow(){
  const p=$("#previewPane"), r=$("#previewResize"), b=$("#previewbtn");
  if(!p) return;
  p.hidden=false; if(r)r.hidden=false; document.body.classList.add("preview-open"); if(b)b.classList.add("on");
  previewUpdateDownload();
}
function previewHide(){
  const p=$("#previewPane"), r=$("#previewResize"), b=$("#previewbtn");
  if(p)p.hidden=true; if(r)r.hidden=true; document.body.classList.remove("preview-open"); if(b)b.classList.remove("on");
}
function previewToggle(){ previewIsOpen()?previewHide():previewShow(); }
function previewSetError(msg){
  const e=$("#pvError"); if(!e) return;
  const txt=String(msg||"").trim(); e.hidden=!txt; e.textContent=txt.slice(-6000);
}
function previewLoad(raw, source="manual"){
  const u=previewAbs((raw||"").trim()); if(!u) return;
  if(source==="manual" && !previewTrustedUrl(u) && !preview.confirmedExternal.has(u)){
    cwConfirm("预览将打开外部地址:\n"+u+"\n\n建议只打开你信任的本地开发地址。继续?").then(ok=>{ if(ok){ preview.confirmedExternal.add(u); previewLoad(u,"confirmed"); } });
    return;
  }
  const f=$("#previewFrame"), inp=$("#pvUrl");
  preview.url=u; try{localStorage.setItem("cw_preview_url",u);}catch(e){}
  if(inp) inp.value=u;
  previewUpdateDownload();
  if(source!=="silent" && (preview.autoOpen || previewIsOpen())) previewShow();
  previewSetError("");
  previewApplySandbox(u);
  if(f){
    if(f.src===u && preview.autoRefresh) f.src = u + (u.includes("?")?"&":"?") + "cw_reload=" + Date.now();
    else f.src=u;
  }
}
function previewReload(){
  const f=$("#previewFrame");
  if(f && f.src){ try{ f.contentWindow.location.reload(); }catch(e){ f.src=f.src; } }
  else if(preview.url) previewLoad(preview.url);
}
function previewSetSize(size){
  preview.size=["desktop","tablet","phone"].includes(size)?size:"desktop";
  try{localStorage.setItem("cw_pv_size",preview.size);}catch(e){}
  const p=$("#previewPane"); if(p){ p.classList.remove("pv-desktop","pv-tablet","pv-phone"); p.classList.add("pv-"+preview.size); }
  document.querySelectorAll("[data-pv-size]").forEach(b=>b.classList.toggle("on",b.dataset.pvSize===preview.size));
}
function previewBindFrameDiagnostics(){
  const f=$("#previewFrame");
  if(!f) return;
  f.onload=()=>{
    previewSetError("");
    try{
      const w=f.contentWindow;
      if(!w || w.__cwPreviewDiag) return;
      w.__cwPreviewDiag=true;
      w.addEventListener("error",e=>previewSetError("JS: "+(e.message||"脚本错误")+(e.filename?("\n"+e.filename+":"+e.lineno):"")));
      w.addEventListener("unhandledrejection",e=>previewSetError("Promise: "+((e.reason&&e.reason.message)||e.reason||"未处理异常")));
      if(w.fetch){
        const orig=w.fetch.bind(w);
        w.fetch=(...args)=>orig(...args).then(r=>{ if(!r.ok) previewSetError("请求失败: "+r.status+" "+r.url); return r; }).catch(err=>{ previewSetError("请求失败: "+(err&&err.message||err)); throw err; });
      }
    }catch(e){}
  };
}
function previewMetaCwd(meta){ return meta && (meta.cwd||meta.workdir||meta.working_dir||meta.current_dir||meta.pwd); }
function previewFeedTerminal(text, failed=false, meta=null, live=false){
  text=String(text||""); if(!text.trim()) return;
  const hasUrl=/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i.test(text);
  if(live && !hasUrl) return;
  const key=(failed?"f:":"o:")+hasUrl+":"+text.slice(-1200);
  if(key===preview.lastKey) return;
  preview.lastKey=key; clearTimeout(preview.scanT);
  preview.scanT=setTimeout(async()=>{
    try{
      const d=await api("/api/preview/detect",{method:"POST",body:JSON.stringify({text,failed,cwd:previewMetaCwd(meta)})});
      if(d.kind==="url"||d.kind==="static"){
        const u=previewAbs(d.url);
        if(previewIsOpen() || preview.autoOpen || (preview.autoRefresh && preview.url===u)) previewLoad(u,d.kind);
        else { preview.url=u; try{localStorage.setItem("cw_preview_url",u);}catch(e){} const inp=$("#pvUrl"); if(inp)inp.value=u; previewUpdateDownload(u); }
      }else if(d.kind==="error" || failed){
        if(preview.autoOpen || previewIsOpen()) previewShow();
        previewSetError(d.error||text);
      }
    }catch(e){ if(failed) previewSetError(String(e&&e.message||e)); }
  }, live?350:80);
}


function applyPreviewWidth(w){
  const max=Math.max(360, Math.min(860, Math.floor(window.innerWidth*0.72)));
  const v=Math.max(320, Math.min(max, Math.round(+w||Math.floor(window.innerWidth*0.42))));
  document.documentElement.style.setProperty("--preview-w",v+"px");
  try{localStorage.setItem("cw_preview_w",String(v));}catch(e){}
}
function initPreviewResize(){
  applyPreviewWidth(localStorage.getItem("cw_preview_w")||Math.floor(window.innerWidth*0.42));
  const pr=$("#previewResize");
  if(pr){
    pr.addEventListener("pointerdown",e=>{
      if(window.innerWidth<=900) return;
      e.preventDefault(); document.body.classList.add("previewresizing");
      const move=ev=>applyPreviewWidth(window.innerWidth-ev.clientX);
      const up=()=>{ document.body.classList.remove("previewresizing"); window.removeEventListener("pointermove",move); };
      window.addEventListener("pointermove",move);
      window.addEventListener("pointerup",up,{once:true});
      move(e);
    });
    window.addEventListener("resize",()=>applyPreviewWidth(localStorage.getItem("cw_preview_w")||Math.floor(window.innerWidth*0.42)));
  }
}

export { previewAbs, previewIsOpen, previewTrustedUrl, previewSameOrigin, previewDownloadUrl, previewDownloadName, previewUpdateDownload, previewDownload, previewUpdateFileActions, previewOpenDefault, previewReveal, previewDownloadSource, previewExportPdf, previewSandboxValue, previewApplySandbox, previewShow, previewHide, previewToggle, previewSetError, previewLoad, previewReload, previewSetSize, previewBindFrameDiagnostics, previewMetaCwd, previewFeedTerminal, applyPreviewWidth, initPreviewResize };
