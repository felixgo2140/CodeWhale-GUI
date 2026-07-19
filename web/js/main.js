try{
  localStorage.removeItem("cw_sidebar_collapsed");
}catch(e){}

const modulePaths = [
  "./api.js",
  "./state.js",
  "./preview.js",
  "./tools.js",
  "./voice.js",
  "./chat-view.js",
  "./threads.js",
  "./stream.js",
  "./panels.js",
  "./compare.js"
];
const moduleRev = Date.now().toString(36);

Promise.all(modulePaths.map(path => import(`${path}?v=${moduleRev}`))).then(mods => {
  const exposed = Object.assign({}, ...mods);
  Object.assign(window, exposed);
  window.alert = m => cwToast(m);
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, {once:true});
  else boot();
}).catch(err => {
  console.error("CodeWhale GUI module bootstrap failed", err);
  try{ alert("界面模块加载失败: "+(err&&err.message||err)); }catch(e){}
});

function boot(){
  hydrateIcons();
  initPanelDocumentHandlers();
  initCompareNetenv();

  $("#newbtn").onclick=newThread;
  $("#guirestart").onclick=restartGui;
  $("#skillsbtn").onclick=openSkills;
  $("#mcpbtn").onclick=openConnectors;
  $("#settingsbtn").onclick=openSettings;
  $("#modelchip").onclick=openModelSwitch;
  $("#modalClose").onclick=closeModal;
  $("#modal").onclick=e=>{ if(e.target.id==="modal") closeModal(); };
  $("#attachbtn").onclick=()=>$("#fileinput").click();
  $("#fileinput").onchange=e=>{ if(e.target.files.length) uploadFiles([...e.target.files]); e.target.value=""; };
  { const cw=$("#cwrap");
    ["dragover","dragenter"].forEach(ev=>cw.addEventListener(ev,e=>{e.preventDefault();cw.classList.add("drag");}));
    ["dragleave","drop"].forEach(ev=>cw.addEventListener(ev,e=>{e.preventDefault();cw.classList.remove("drag");}));
    cw.addEventListener("drop",e=>{ if(e.dataTransfer&&e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]); });
  }
  $("#sendbtn").onclick=enterSend;   // 运行时=排队,空闲时=发送(停止用顶栏「停止」)
  $("#interruptbtn").onclick=interrupt;
  $("#autowrap").onclick=toggleAuto;
  $("#shellwrap").onclick=toggleShell;
  $("#previewbtn").onclick=previewToggle;
  $("#pvClose").onclick=previewHide;
  $("#pvRefresh").onclick=previewReload;
  $("#pvGo").onclick=()=>previewLoad($("#pvUrl").value||preview.url);
  $("#pvUrl").addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); previewLoad(e.target.value); } });
  $("#pvUrl").addEventListener("input",e=>previewUpdateDownload(e.target.value));
  const pvDownloadBtn=$("#pvDownload"); if(pvDownloadBtn) pvDownloadBtn.onclick=previewDownload;
  const pvExternalBtn=$("#pvExternal"); if(pvExternalBtn) pvExternalBtn.onclick=()=>{ if(preview.url) window.open(preview.url,"_blank"); };
  const pvCopyBtn=$("#pvCopy"); if(pvCopyBtn) pvCopyBtn.onclick=()=>{ if(preview.url) clipCopy(preview.url).then(()=>cwToast("已复制预览地址")).catch(()=>{}); };
  const pvOpenMenu=$("#pvOpenMenu");
  const previewAction=(name,...args)=>{
    const fn=window[name];
    if(typeof fn==="function") return fn(...args);
    cwToast("预览功能尚未加载，请刷新界面");
  };
  if(pvOpenMenu){
    pvOpenMenu.addEventListener("toggle",()=>{ if(pvOpenMenu.open) previewAction("previewUpdateFileActions",preview.url,true); });
    pvOpenMenu.addEventListener("click",e=>{
      const s=$("#pvOpenSummary");
      if(e.target===s && s?.getAttribute("aria-disabled")==="true"){
        e.preventDefault();
        pvOpenMenu.removeAttribute("open");
        cwToast("当前预览不是可操作的本地文件");
      }
    });
    document.addEventListener("click",e=>{ if(pvOpenMenu.open && !pvOpenMenu.contains(e.target)) pvOpenMenu.removeAttribute("open"); });
  }
  const pvOpenDefaultBtn=$("#pvOpenDefault"); if(pvOpenDefaultBtn) pvOpenDefaultBtn.onclick=()=>previewAction("previewOpenDefault");
  const pvDownloadSourceBtn=$("#pvDownloadSource"); if(pvDownloadSourceBtn) pvDownloadSourceBtn.onclick=()=>previewAction("previewDownloadSource");
  const pvExportPdfBtn=$("#pvExportPdf"); if(pvExportPdfBtn) pvExportPdfBtn.onclick=()=>previewAction("previewExportPdf");
  const pvRevealBtn=$("#pvReveal"); if(pvRevealBtn) pvRevealBtn.onclick=()=>previewAction("previewReveal");
  $("#pvBack").onclick=()=>{ try{$("#previewFrame").contentWindow.history.back();}catch(e){} };
  $("#pvForward").onclick=()=>{ try{$("#previewFrame").contentWindow.history.forward();}catch(e){} };
  $("#pvAutoOpen").checked=preview.autoOpen;
  $("#pvAutoRefresh").checked=preview.autoRefresh;
  $("#pvSandboxMode").value=preview.sandboxMode;
  $("#pvAutoOpen").onchange=e=>{ preview.autoOpen=!!e.target.checked; try{localStorage.setItem("cw_pv_auto_open",preview.autoOpen?"1":"0");}catch(x){} };
  $("#pvAutoRefresh").onchange=e=>{ preview.autoRefresh=!!e.target.checked; try{localStorage.setItem("cw_pv_auto_refresh",preview.autoRefresh?"1":"0");}catch(x){} };
  $("#pvSandboxMode").onchange=e=>{
    preview.sandboxMode=["compat","safe","auto"].includes(e.target.value)?e.target.value:"compat";
    try{localStorage.setItem("cw_pv_sandbox",preview.sandboxMode);}catch(x){}
    previewApplySandbox(preview.url);
    if(preview.url && previewIsOpen()){
      const f=$("#previewFrame"), u=preview.url;
      if(f) f.src=u+(u.includes("?")?"&":"?")+"cw_sandbox="+Date.now();
    }
  };
  document.querySelectorAll("[data-pv-size]").forEach(b=>b.onclick=()=>previewSetSize(b.dataset.pvSize));
  previewSetSize(preview.size); previewApplySandbox(preview.url); previewBindFrameDiagnostics();
  if(preview.url){ const inp=$("#pvUrl"); if(inp) inp.value=preview.url; previewUpdateDownload(preview.url); }
  $("#updbtn").onclick=doUpdate;
  $("#guiupdbtn").onclick=openUpdate;   // 顶栏「↑ 界面」直接打开更新中心(带下载/应用进度条),不再走旧的同步弹窗

  initSidebarControls();
  initPreviewResize();
  initMessageScroll();
  initZoomControls();
  initTimelineControls();
  initVoiceInput();

  const inp=$("#input");
  inp.addEventListener("input",()=>{ inp.style.height="auto"; inp.style.height=Math.min(inp.scrollHeight,200)+"px"; $("#sendbtn").disabled=!state.running && !inp.value.trim() && !state.attachments.length; });
  inp.addEventListener("paste",e=>{ const fs=[...((e.clipboardData&&e.clipboardData.files)||[])]; if(fs.length){ e.preventDefault(); uploadFiles(fs); } });   // 贴文件/图片 → 上传
  let composing=false;
  inp.addEventListener("compositionstart",()=>composing=true);
  inp.addEventListener("compositionend",()=>composing=false);
  inp.addEventListener("keydown",e=>{
    if(e.key==="Enter"&&!e.shiftKey){
      if(composing||e.isComposing||e.keyCode===229) return;   // 中文/日文等输入法组字中的回车 = 仅确认候选词,不发送
      e.preventDefault(); enterSend();
    }
  });

  renderAuto(); renderShell();
  const IS_CMP_WIN = new URLSearchParams(location.search).get("compare")==="1";
  if(IS_CMP_WIN){
    loadCmpSessions();   // 独立对比窗口:主 UI 被对比层盖住,只需会话数据(?session 还原);跳过 loadThreads(慢~4.5s)/balance/pins/cmp/model/checkSetup,显著加快
  }else{
    const initialThreads=loadThreads(); loadBalance(); loadPins(); loadCronJobs(); loadCmp(); loadCmpSessions(); loadModelLabel(); checkSetup(); loadPlugins(); loadResearchSkills();   // pins/Cron:服务端拉跨窗口标签;loadCmp:对比 thread 分组;loadCmpSessions:对比会话归集;loadModelLabel:侧栏显当前模型
    const deepThread=new URLSearchParams(location.search).get("thread");
    if(/^thr_[A-Za-z0-9_-]+$/.test(deepThread||"")) Promise.resolve(initialThreads).then(()=>openThread(deepThread)).catch(e=>cwToast(e?.message||"任务链接打开失败"));
  }
  if(IS_CMP_WIN){
    setInterval(loadCmpSessions, 15000);   // 独立对比窗口只需要轻量同步 session,不跑完整侧栏/余额/版本轮询
  }else{
    // 原生 App 后台刷新(在线更新带来的新壳):下载替换需几秒,延迟轮询几次,更新了就提示退出重开
    setTimeout(async()=>{ for(let i=0;i<5;i++){ try{ const s=await api("/api/app-refresh-status"); if(s&&s.updated){ cwToast("✅ CodeWhale 原生 App 已更新 — 退出(⌘Q)再打开即生效"); break; } }catch(e){} await new Promise(r=>setTimeout(r,4000)); } }, 5000);
    setInterval(()=>{ loadThreads(); loadCmpSessions(); }, 4000);   // 轮询刷新侧栏状态点 + 对比会话收编(独立对比窗口写入后主窗口自动合组)
    setInterval(syncActiveTurn, 4000);   // 单聊兜底:不依赖侧栏 stale cache,直接查当前 thread 收尾,避免 SSE 漏完成事件后输入框卡住
    setInterval(loadBalance, 60000);  // 每分钟刷新当前 provider 余额/额度/用量
    loadVersion(); checkUpdate(); setInterval(checkUpdate, 3600000);   // CodeWhale 后端版本号 + 启动/每小时查新版
    checkGuiUpdate(); setInterval(checkGuiUpdate, 3600000);            // GUI 界面:启动 + 每小时查新版(签名验证)
  }

  initCompareDom();
}

function initCompareDom(){
  const IS_CMP_WIN = new URLSearchParams(location.search).get("compare")==="1";   // 本页是不是一个独立对比窗口
  const cb=$("#cmpbtn"); if(cb) cb.onclick=()=>openCompareWindow();   // 「⚖️ 对比」→ 每点开一个全新独立窗口(原生壳新 NSWindow),可同时跑多个;不再页内覆盖
  const cc=$("#cmpClose"); if(cc) cc.onclick=()=> IS_CMP_WIN ? window.close() : closeCompare();   // 专用对比窗口:退出=关窗;万一在主窗口(理论上不会)则只收覆盖层
  if(IS_CMP_WIN) (async ()=>{   // ?compare=1 即时进对比(覆盖层 CSS 已首帧前盖上,这里只填内容,不再等 200ms);带 ?session 则还原那场对比
    const sid=new URLSearchParams(location.search).get("session");
    if(sid){ const s=await cmpFindSession(sid); if(s){ restoreCompareSession(s); return; } cmpShowSessionError(sid,"找不到这个对比会话"); return; }
    openCompare();
  })();
  const cn=$("#cmpNewBtn"); if(cn) cn.onclick=cmpNewChat;
  const cr=$("#cmpResetBtn"); if(cr) cr.onclick=cmpResetBackends;
  const cs=$("#cmpSendBtn"); if(cs) cs.onclick=cmpSend;
  const cstop=$("#cmpStopAllBtn"); if(cstop) cstop.onclick=cmpStopAll;
  const ca=$("#cmpAutoTgl"); if(ca) ca.onclick=cmpToggleAuto;
  const csh=$("#cmpShellTgl"); if(csh) csh.onclick=cmpToggleShell;
  renderCmpToggles();
  const ci=$("#cmpInput"); if(ci){
    ci.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ if(e.isComposing||e.keyCode===229)return; e.preventDefault(); cmpSend(); }});
    ci.addEventListener("paste",e=>{ const fs=[...((e.clipboardData&&e.clipboardData.files)||[])]; if(fs.length){ e.preventDefault(); cmpUploadFiles(fs); } });   // 粘贴文件/图片 → 上传(纯文本粘贴照常)
  }
  const cab=$("#cmpAttachBtn"); if(cab) cab.onclick=()=>$("#cmpFileInput").click();
  const cfi=$("#cmpFileInput"); if(cfi) cfi.onchange=e=>{ if(e.target.files.length) cmpUploadFiles([...e.target.files]); e.target.value=""; };
  const cvw=$("#cmpView"); if(cvw){   // 拖拽文件到对比视图任意处 → 上传
    cvw.addEventListener("dragover",e=>{ if(e.dataTransfer&&[...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    cvw.addEventListener("drop",e=>{ if(e.dataTransfer&&e.dataTransfer.files.length){ e.preventDefault(); cmpUploadFiles([...e.dataTransfer.files]); } });
  }
}
