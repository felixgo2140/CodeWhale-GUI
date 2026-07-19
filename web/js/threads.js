/* ---------- sidebar ---------- */
async function loadThreads(){
  if(state._loadingThreads) return;   // 防重入:忙碌的 :7878 下,4s 轮询若上一发还没回来就别再压一发(并发堆叠=切换更卡)
  state._loadingThreads=true;
  try{
    const t = await api("/api/threads/all");   // 聚合各 provider 后端的会话,带 provider 标签(每对话锁模型)
    setConn(true);
    if(state.pendingNew && state.pendingNew.length){   // 乐观新建、尚未进慢 SWR 缓存的新对话:保留在列表里,直到它真出现(否则后台刷新会把它冲掉 → 新对话闪一下就没了)
      const ids=new Set(t.map(x=>x.id));
      const kept=state.pendingNew.filter(p=>!ids.has(p.id));   // 已出现在真实列表 → 不再 pending
      if(kept.length!==state.pendingNew.length){ state.pendingNew=kept; savePendingNew(); } else state.pendingNew=kept;
      state.threads=[...state.pendingNew, ...t];
    } else state.threads=t;
    const at=state.threads.find(x=>x.id===state.activeId);   // 兜底:SSE 漏收状态事件时,靠侧栏 summary 恢复/收尾活动会话
    if(at && !state.running && isTurnRunning(at.latest_turn_status) && !isStoppingTurn(state.turnId)){
      setRunning(true); runStatusUpdate("同步中","后端仍在运行,正在恢复工作状态"); syncActiveTurn();
    }
    if(at && state.running && isTurnDone(at.latest_turn_status)){ setRunning(false); processQueue(); }
    const sig=JSON.stringify(state.threads.map(x=>[x.id,x.title,x.latest_turn_status,threadTimeSig(x),x.provider,x.compare,x.single]))+"|"+[...state.pinned].sort().join(",")+"|"+[...state.cronJobs].sort().join(",")+"|"+[...state.cmpThreads].sort().join(",")+"|"+state.cmpSessions.map(s=>s.id+":"+(s.topic||"")+":"+Object.keys(s.threads||{}).length).join(",")+"|"+[...state.grpCollapsed].sort().join(",")+"|"+state.activeId;   // 从合并后列表算(含 pending):含 provider/标签/对比集/会话/折叠态,任一变都重渲染;时间只按分钟入签名,避免运行中秒级 updated_at 导致闪
    if(sig!==state._sig){ state._sig=sig; renderThreads(); }   // 仅当列表真变化才重建 DOM,避免轮询吞掉点击
    repairBadThreadTitles();
  }catch(e){ setConn(false); console.warn(e); }
  finally{ state._loadingThreads=false; }
}
function setConn(up){ const c=$("#conn"); c.classList.toggle("up",up); $("#connt").textContent = up?"已连接 7878":"未连接"; }
function threadTimeSig(t){
  const ms=new Date(t&&t.updated_at||0).getTime();
  return Number.isFinite(ms) ? Math.floor(ms/60000) : 0;
}
function badAutoTitle(title){
  const t=String(title||"").trim();
  if(!t) return false;
  if(/^[。.!！?？,，;；:：、]/.test(t)) return true;
  if(/请使用|需要时自动选择|除非我明确要求|read_file|我上传了以下文件|优先调用\/加载|菜单路径|插件|skill/i.test(t)) return true;
  if(/\b(?:www\.)?[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})?\b.*(?:是什么|干嘛|做什么)/i.test(t)) return true;
  if(t.length>18 && /(请|帮|使用|分析|研究|检查|看看|可以|需要)/.test(t)) return true;
  return false;
}
function repairBadThreadTitles(){
  if(!state._titleRepairing) state._titleRepairing=new Set();
  if(!state._titleRepairTried) state._titleRepairTried=new Set();
  const candidates=(state.threads||[]).filter(t=>t&&t.id&&badAutoTitle(t.title)&&!state._titleRepairing.has(t.id)&&!state._titleRepairTried.has(t.id)).slice(0,2);
  candidates.forEach(t=>{
    state._titleRepairing.add(t.id);
    state._titleRepairTried.add(t.id);
    api("/api/thread-title/auto",{method:"POST",body:JSON.stringify({thread_id:t.id,expected_title:""})})
      .then(r=>{
        if(r&&r.ok&&r.title){
          const th=state.threads.find(x=>x.id===t.id); if(th) th.title=r.title;
          if(state.activeId===t.id) $("#ttitle").textContent=r.title;
          state._sig=null; renderThreads();
        }
      })
      .catch(e=>console.warn("title repair failed", e))
      .finally(()=>state._titleRepairing.delete(t.id));
  });
}
function modelSummary(provs){
  const names=provs.map(p=>PROV_SHORT[p]||p).filter(Boolean);
  const shown=names.slice(0,2).join(" · ");
  const more=names.length>2?` +${names.length-2}`:"";
  return `${provs.length} 模型${shown?` · ${shown}${more}`:""}`;
}
let threadContextMenu=null;
function closeThreadContextMenu(){
  if(threadContextMenu){ threadContextMenu.remove(); threadContextMenu=null; }
}
function ensureThreadContextMenuHandlers(){
  if(ensureThreadContextMenuHandlers.ready) return;
  ensureThreadContextMenuHandlers.ready=true;
  document.addEventListener("pointerdown",e=>{ if(threadContextMenu&&!threadContextMenu.contains(e.target)) closeThreadContextMenu(); },true);
  document.addEventListener("keydown",e=>{ if(e.key==="Escape") closeThreadContextMenu(); });
  document.addEventListener("scroll",closeThreadContextMenu,true);
  window.addEventListener("resize",closeThreadContextMenu);
  window.addEventListener("blur",closeThreadContextMenu);
}
function contextAction(label,iconName,run,opts={}){ return {label,iconName,run,...opts}; }
function showThreadContextMenu(ev,actions){
  ev.preventDefault(); ev.stopPropagation(); closeThreadContextMenu(); ensureThreadContextMenuHandlers();
  const menu=document.createElement("div"); menu.className="thread-context-menu"; menu.setAttribute("role","menu"); menu.style.visibility="hidden";
  for(const a of actions){
    if(a.separator){ const sep=document.createElement("div"); sep.className="ctx-sep"; sep.setAttribute("role","separator"); menu.appendChild(sep); continue; }
    const b=document.createElement("button"); b.type="button"; b.className="ctx-item"+(a.danger?" danger":""); b.setAttribute("role","menuitem");
    b.innerHTML=`${icon(a.iconName||"message")}<span>${esc(a.label)}</span>`;
    b.onclick=async e=>{ e.stopPropagation(); closeThreadContextMenu(); try{ await a.run(); }catch(err){ cwToast(err?.message||"操作失败"); } };
    menu.appendChild(b);
  }
  document.body.appendChild(menu); threadContextMenu=menu;
  const pad=8, rect=menu.getBoundingClientRect();
  menu.style.left=Math.max(pad,Math.min(ev.clientX,window.innerWidth-rect.width-pad))+"px";
  menu.style.top=Math.max(pad,Math.min(ev.clientY,window.innerHeight-rect.height-pad))+"px";
  menu.style.visibility="visible";
  menu.querySelector(".ctx-item")?.focus({preventScroll:true});
}
async function copyContextValue(value,okLabel){
  const text=String(value||"").trim(); if(!text){ cwToast("没有可复制的内容"); return; }
  await clipCopy(text); cwToast(okLabel||"已复制");
}
function taskDeepLink(id){
  const u=new URL(location.pathname,location.origin); u.searchParams.set("thread",id); return u.toString();
}
function comparisonDeepLink(id){
  const u=new URL(location.pathname,location.origin); u.searchParams.set("compare","1"); u.searchParams.set("session",id); return u.toString();
}
async function threadDetail(t){
  if(t?.workspace) return t;
  const rec=await api(`/v1/threads/${t.id}`);
  return Object.assign({},t,rec?.thread||rec||{});
}
async function threadWorkspace(t){
  const th=await threadDetail(t), workspace=String(th?.workspace||"").trim();
  if(!workspace) throw new Error("这个任务没有工作目录");
  return workspace;
}
async function revealThreadWorkspace(t){
  const workspace=await threadWorkspace(t);
  await api("/api/workspace/reveal",{method:"POST",body:JSON.stringify({path:workspace})});
  cwToast("已在 Finder 中打开工作目录");
}
async function addForkedThread(raw,title){
  const id=raw?.id||raw?.thread?.id;
  if(!id) throw new Error("分叉成功但没有返回新会话 id");
  if(typeof _addOptimisticThread==="function") _addOptimisticThread(id,raw?.title||raw?.thread?.title||title||"续接任务");
  await loadThreads();
  await openThread(id);
  loadThreads();
  return id;
}
async function continueInNewTask(t){
  const raw=await api(`/v1/threads/${t.id}/fork`,{method:"POST",body:"{}"});
  await addForkedThread(raw,t.title);
  cwToast("已在新任务中继续");
}
async function continueInNewWorktree(t){
  const workspace=await threadWorkspace(t);
  const raw=await api("/api/thread/fork-worktree",{method:"POST",body:JSON.stringify({thread_id:t.id,workspace,title:t.title||""})});
  await addForkedThread(raw?.thread||raw,t.title);
  cwToast(`已创建工作树: ${raw?.branch||"新分支"}`);
}
function openTaskWindow(t){
  const w=window.open(taskDeepLink(t.id),"_blank");
  if(!w) cwToast("新窗口被系统拦截,请退出并重新打开 CodeWhale 后再试");
}
function threadContextActions(t){
  const pinned=state.pinned.has(t.id), cron=state.cronJobs.has(t.id);
  return [
    contextAction(pinned?"取消置顶":"置顶","pin",()=>togglePin(t.id)),
    contextAction("重命名","edit",()=>renameThread(t.id,t.title)),
    contextAction(cron?"移出 Cron Jobs":"加入 Cron Jobs","calendar",()=>toggleCronJob(t.id)),
    contextAction("归档对话","trash",()=>deleteThread(t.id,t.title),{danger:true}),
    {separator:true},
    contextAction("在 Finder 中显示","folder",()=>revealThreadWorkspace(t)),
    contextAction("复制工作目录","copy",async()=>copyContextValue(await threadWorkspace(t),"已复制工作目录")),
    contextAction("复制会话 ID","hash",()=>copyContextValue(t.id,"已复制会话 ID")),
    contextAction("复制深度链接","external",()=>copyContextValue(taskDeepLink(t.id),"已复制深度链接")),
    {separator:true},
    contextAction("在新任务中继续","repeat",()=>continueInNewTask(t)),
    contextAction("在新工作树中继续","folder",()=>continueInNewWorktree(t)),
    contextAction("在新窗口中打开","external",()=>openTaskWindow(t))
  ];
}
function comparisonContextActions(s){
  const pinned=state.pinned.has(s.id), cron=state.cronJobs.has(s.id);
  const ids=Object.entries(s.threads||{}).map(([prov,id])=>`${PROV_SHORT[prov]||prov}: ${id}`).join("\n");
  return [
    contextAction(pinned?"取消置顶":"置顶","pin",()=>togglePin(s.id)),
    contextAction("重命名","edit",()=>renameCmpSession(s.id,s.topic)),
    contextAction(cron?"移出 Cron Jobs":"加入 Cron Jobs","calendar",()=>toggleCronJob(s.id)),
    contextAction("归档整组对比","trash",()=>deleteCmpSession(s.id,s.topic),{danger:true}),
    {separator:true},
    contextAction("复制对比 ID","hash",()=>copyContextValue(s.id,"已复制对比 ID")),
    contextAction("复制各模型会话 ID","layout",()=>copyContextValue(ids,"已复制各模型会话 ID")),
    contextAction("复制深度链接","external",()=>copyContextValue(comparisonDeepLink(s.id),"已复制深度链接")),
    contextAction("在新窗口中打开","external",()=>openCompareWindow(s.id))
  ];
}
function threadEl(t){   // 单条对话 DOM
  const pinned=state.pinned.has(t.id);
  const cron=state.cronJobs.has(t.id);
  const d=document.createElement("div"); d.className="thread"+(cron?" cronjob":"")+(t.id===state.activeId?" active":"");
  const st=t.latest_turn_status||"";
  let dotCls = isTurnRunning(st) ? "running"   // summary 返回的是 inprogress(无下划线)
               : normTurnStatus(st)==="completed" ? "ok"
               : (isTurnDone(st) ? "err" : "idle");
  let dotTitle = st||"空闲";
  if(dotCls==="running"){
    const age=(Date.now()-new Date(t.updated_at).getTime())/1000;   // inprogress 但久未更新 → 多半是卡死/孤儿 turn
    if(age>240){ dotCls="stalled"; dotTitle=`约 ${Math.round(age/60)} 分钟无更新 — 可能在等你审批、或卡住;点开查看`; }
    else dotTitle="运行中";
  }
  const stalled = dotCls==="stalled";
  d.innerHTML=`<div class="t1"><span class="dot ${dotCls}" title="${dotTitle}"></span><span class="title">${pinned?icon("pin"):""}${stalled?icon("alert"):""}${esc(t.title||"未命名")}</span>`+
    `<span class="time">${relTime(t.updated_at)}</span><span class="actions"><button class="act rename" title="重命名">${icon("edit")}</button><button class="act cron ${cron?"on":""}" title="${cron?"移出 Cron Jobs":"加入 Cron Jobs"}">${icon("calendar")}</button><button class="act pin" title="${pinned?"取消置顶":"置顶"}">${icon("pin")}</button><button class="act del" title="删除">${icon("trash")}</button></span></div>`+
    `<div class="meta"><span class="models">${esc(PROV_SHORT[t.provider]||t.provider||t.model||"")}</span>${t.preview?`<span class="prev snippet">${esc(t.preview)}</span>`:""}</div>`;
  d.onclick=()=>openThread(t.id);
  d.oncontextmenu=e=>showThreadContextMenu(e,threadContextActions(t));
  keyboardButton(d,()=>openThread(t.id),`打开对话: ${t.title||"未命名"}`);
  d.querySelector(".pin").onclick=(e)=>{e.stopPropagation();togglePin(t.id);};
  d.querySelector(".cron").onclick=(e)=>{e.stopPropagation();toggleCronJob(t.id);};
  d.querySelector(".del").onclick=(e)=>{e.stopPropagation();deleteThread(t.id,t.title);};
  d.querySelector(".rename").onclick=(e)=>{e.stopPropagation();renameThread(t.id,t.title);};
  return d;
}
function cmpSessionEl(s){   // 对比会话行:点=回到当时整场对比
  const provs=Object.keys(s.threads||{});
  const pinned=state.pinned.has(s.id);
  const cron=state.cronJobs.has(s.id);
  const d=document.createElement("div"); d.className="thread cmpsess"+(cron?" cronjob":"")+(s.id===CMP.sessionId&&!$("#cmpView")?.hidden?" active":"");
  d.innerHTML=`<div class="t1"><span class="dot ok" title="对比会话(点击回到当时对比)"></span><span class="title">${pinned?icon("pin"):""}${icon("layout")}${esc(s.topic||"对比")}</span>`+
    `<span class="time">${relTime(s.ts||0)}</span><span class="actions"><button class="act rename" title="重命名">${icon("edit")}</button><button class="act cron ${cron?"on":""}" title="${cron?"移出 Cron Jobs":"加入 Cron Jobs"}">${icon("calendar")}</button><button class="act pin" title="${pinned?"取消置顶":"置顶"}">${icon("pin")}</button><button class="act del" title="从列表删除此对比会话">${icon("trash")}</button></span></div>`+
    `<div class="meta"><span class="models">${esc(modelSummary(provs))}</span></div>`;
  d.onclick=()=>openCompareWindow(s.id);   // 点会话 → 新开一个独立窗口还原那场对比(主窗口不受影响)
  d.oncontextmenu=e=>showThreadContextMenu(e,comparisonContextActions(s));
  keyboardButton(d,()=>openCompareWindow(s.id),`打开对比会话: ${s.topic||"对比"}`);
  d.querySelector(".rename").onclick=(e)=>{e.stopPropagation();renameCmpSession(s.id,s.topic);};
  d.querySelector(".pin").onclick=(e)=>{e.stopPropagation();togglePin(s.id);};
  d.querySelector(".cron").onclick=(e)=>{e.stopPropagation();toggleCronJob(s.id);};
  d.querySelector(".del").onclick=(e)=>{e.stopPropagation();deleteCmpSession(s.id,s.topic);};
  return d;
}
function renameCmpSession(id,cur){   // topic_ts=重命名时间戳,合并平局时新者胜(否则别的窗口旧副本会把名字盖回去)
  const t=prompt("重命名对比会话:",cur||"");
  if(t===null) return;
  const name=t.trim(); if(!name) return;
  const s=state.cmpSessions.find(x=>x.id===id); if(!s) return;
  s.topic=name; s.topic_ts=Date.now();
  saveCmpSessions(); state._sig=null; renderThreads();
}
async function deleteCmpSession(id,topic){
  const s=state.cmpSessions.find(x=>x.id===id);
  const tids=s?Object.values(s.threads||{}).filter(Boolean):[];
  if(!(await cwConfirm(`删除对比会话「${topic||"对比"}」及其 ${tids.length} 个模型对话?\n(整组归档移出列表;后端可恢复)`))) return;
  await Promise.allSettled(tids.map(tid=>api(`/v1/threads/${tid}`,{method:"PATCH",body:JSON.stringify({archived:true})})));   // 归档每个模型的原始 thread
  state.threads=state.threads.filter(t=>!tids.includes(t.id));   // 从列表移除
  let pinChanged=false; tids.forEach(tid=>{ state.cmpThreads.delete(tid); if(state.pinned.delete(tid)) pinChanged=true; });   // 从对比注册表/置顶清掉
  saveCmp(); if(pinChanged) savePins();
  if(state.cronJobs.delete(id)) saveCronJobs();
  state.cmpSessions=state.cmpSessions.filter(x=>x.id!==id);   // 删会话本身
  saveCmpSessions({deleteIds:[id]}); state._sig=null; renderThreads();
  if(typeof CMP!=="undefined" && CMP.sessionId===id) cmpClearAllCols();   // 删的正是打开着的这场对比 → 各列一并清空,不留旧内容
}
function renderThreads(){
  if(document.querySelector(".cwdlg-ov")) return;   // 确认对话框打开时跳过重建,避免轮询吞掉用户点击
  const box=$("#threads"); box.innerHTML="";
  const byTime=(a,b)=>new Date(b.updated_at||0)-new Date(a.updated_at||0);
  const serverSingleTids=new Set(state.threads.filter(t=>t&&t.single===true).map(t=>t.id));   // 服务端明确普通单聊时,优先于本地旧对比缓存
  const visibleThreadIds=new Set(state.threads.filter(t=>t&&t.id&&!t.archived).map(t=>t.id));
  const sessionVisible=s=>Object.values(s.threads||{}).some(tid=>visibleThreadIds.has(tid)&&!serverSingleTids.has(tid));   // 不显示所有子线程都已归档/缺失的空 session,避免点开空白
  const sessionsAll=[...state.cmpSessions].filter(sessionVisible).sort((a,b)=>(b.ts||0)-(a.ts||0));
  const sessionTids=new Set();                            // 已被某对比会话收编的 thread → 不再单独显示(由会话行代表)
  for(const s of sessionsAll) for(const tid of Object.values(s.threads||{})){ if(!serverSingleTids.has(tid)) sessionTids.add(tid); }
  // 对比归组判定只信明确登记:服务端 t.compare 或本地 cmpThreads。
  // 不再按 provider 兜底(openai-codex/zai/moonshot 都可做普通单聊);否则普通新对话会被误塞进「多模型对比」导致像是丢了。
  const isCmp=t=>t.compare===true||(t.single!==true&&state.cmpThreads.has(t.id));
  const cronG=[], pinG=[], cmpLeftover=[], normG=[];      // Cron / 置顶 / 对比散条(无会话的历史) / 普通对话
  for(const t of state.threads){
    if(state.cronJobs.has(t.id)){ cronG.push(t); continue; } // Cron Jobs 是最高展示优先级,同时保留其 pinned 属性
    if(state.pinned.has(t.id)){ pinG.push(t); continue; }  // 置顶优先
    if(sessionTids.has(t.id)) continue;                    // 属某会话 → 跳过,会话行代表它
    if(isCmp(t)){ cmpLeftover.push(t); continue; }
    normG.push(t);
  }
  cronG.sort(byTime); pinG.sort(byTime); cmpLeftover.sort(byTime); normG.sort(byTime);
  const cronS=sessionsAll.filter(s=>state.cronJobs.has(s.id));
  const pinS=sessionsAll.filter(s=>!state.cronJobs.has(s.id)&&state.pinned.has(s.id));       // Cron 优先,其余置顶的对比会话进置顶组
  const sessions=sessionsAll.filter(s=>!state.cronJobs.has(s.id)&&!state.pinned.has(s.id));
  const cmpCount=sessions.length+cmpLeftover.length;
  const groups=[];
  if(state.threads.length||sessionsAll.length) groups.push({key:"cron", icon:"calendar", label:"Cron Jobs", count:cronG.length+cronS.length, render:b=>{ cronS.forEach(s=>b.appendChild(cmpSessionEl(s))); cronG.forEach(t=>b.appendChild(threadEl(t))); }});
  if(pinG.length||pinS.length)  groups.push({key:"pin", icon:"pin", label:"置顶", count:pinG.length+pinS.length, render:b=>{ pinS.forEach(s=>b.appendChild(cmpSessionEl(s))); pinG.forEach(t=>b.appendChild(threadEl(t))); }});
  if(cmpCount)     groups.push({key:"cmp", icon:"layout", label:"多模型对比", count:cmpCount, render:b=>{ sessions.forEach(s=>b.appendChild(cmpSessionEl(s))); cmpLeftover.forEach(t=>b.appendChild(threadEl(t))); }});
  if(normG.length) groups.push({key:"norm",icon:"message",label:"对话", count:normG.length, render:b=>normG.forEach(t=>b.appendChild(threadEl(t)))});
  if(!groups.length){ box.innerHTML='<div class="empty-thread-note">还没有对话,点上方新建</div>'; return; }
  const showHeaders=groups.length>1;                     // 只有一组时不显分组头,保持简洁
  for(const g of groups){
    if(showHeaders){
      const collapsed=state.grpCollapsed.has(g.key);
      const h=document.createElement("div"); h.className="grp grp-"+g.key+(collapsed?" collapsed":"");
      h.innerHTML=`<span class="glabel">${g.icon?icon(g.icon):""}${esc(g.label)}</span><span class="gcount">${g.count}</span><span class="gcar">▼</span>`;
      h.onclick=()=>toggleGroup(g.key);
      keyboardButton(h,()=>toggleGroup(g.key),`${collapsed?"展开":"折叠"}${g.label}`);
      box.appendChild(h);
      if(collapsed) continue;
    }
    g.render(box);
  }
}
function toggleGroup(key){
  state.grpCollapsed.has(key)?state.grpCollapsed.delete(key):state.grpCollapsed.add(key);
  localStorage.setItem("cw_grpcollapsed",JSON.stringify([...state.grpCollapsed]));
  renderThreads();
}
function savePins(){ const arr=[...state.pinned]; localStorage.setItem("cw_pinned",JSON.stringify(arr)); api("/api/pins",{method:"POST",body:JSON.stringify({ids:arr})}).catch(()=>{}); }  // 同时写本地缓存 + 服务端(跨窗口/手机共享)
async function loadPins(){ try{ const r=await api("/api/pins"); if(!Array.isArray(r)) return;
    const local=[...state.pinned];
    if(r.length===0 && local.length>0){ savePins(); return; }   // 服务端还空、本地有 → 首次升级把本地置顶迁移上去,不丢
    state.pinned=new Set(r.map(String)); localStorage.setItem("cw_pinned",JSON.stringify([...state.pinned])); state._sig=null; renderThreads();   // 否则服务端为准
  }catch(e){ /* 离线:沿用 localStorage,不报错 */ } }
function togglePin(id){ state.pinned.has(id)?state.pinned.delete(id):state.pinned.add(id); savePins(); renderThreads(); }
function saveCronJobs(){ const arr=[...state.cronJobs]; localStorage.setItem("cw_cron_jobs",JSON.stringify(arr)); api("/api/cron-jobs",{method:"POST",body:JSON.stringify({ids:arr})}).catch(()=>{}); }
async function loadCronJobs(){ try{ const r=await api("/api/cron-jobs"); if(!Array.isArray(r)) return;
    const local=[...state.cronJobs];
    if(r.length===0 && local.length>0){ saveCronJobs(); return; }
    state.cronJobs=new Set(r.map(String)); localStorage.setItem("cw_cron_jobs",JSON.stringify([...state.cronJobs])); state._sig=null; renderThreads();
  }catch(e){ /* 离线:沿用 localStorage */ } }
function toggleCronJob(id){ state.cronJobs.has(id)?state.cronJobs.delete(id):state.cronJobs.add(id); saveCronJobs(); state._sig=null; renderThreads(); }
// ── 对比 thread 注册表(侧栏分组用):本地即时 + 服务端只增并集(跨窗口/设备共享,不互相覆盖)──
function serverSingleIds(){ return new Set((state.threads||[]).filter(t=>t&&t.single===true).map(t=>t.id)); }
function saveCmp(){ const singles=serverSingleIds(); const arr=[...state.cmpThreads].filter(id=>!singles.has(id)); if(arr.length!==state.cmpThreads.size) state.cmpThreads=new Set(arr); localStorage.setItem("cw_cmp",JSON.stringify(arr)); api("/api/cmp-threads",{method:"POST",body:JSON.stringify({ids:arr})}).catch(()=>{}); }
function markCmp(id){ if(id && !state.cmpThreads.has(id)){ state.cmpThreads.add(id); saveCmp(); state._sig=null; renderThreads(); } }   // 新对比 thread 登记 → 立刻归入对比组
async function loadCmp(){ try{ const r=await api("/api/cmp-threads"); if(!Array.isArray(r)) return;
    const before=state.cmpThreads.size;
    const singles=serverSingleIds();
    const merged=new Set([...state.cmpThreads,...r.map(String)].filter(id=>!singles.has(id)));   // 本地 ∪ 服务端,但服务端明确普通单聊的 id 不再被旧本地缓存复活
    state.cmpThreads=merged; localStorage.setItem("cw_cmp",JSON.stringify([...merged]));
    if(merged.size>r.length) saveCmp();                                               // 本地有服务端没有的 → 推上去
    if(merged.size!==before){ state._sig=null; renderThreads(); }
  }catch(e){ /* 离线:沿用 localStorage */ } }
// ── 对比会话:一次对比(一个主题)= 一个会话,含各模型的 thread → 侧栏每会话一行、点击回到当时对比 ──
function saveCmpSessions(opts={}){
  const singles=serverSingleIds();
  const sessions=state.cmpSessions.map(s=>{ const threads={}; for(const [p,tid] of Object.entries(s.threads||{})){ if(!singles.has(tid)) threads[p]=tid; } return {...s,threads,providers:Object.keys(threads)}; }).filter(s=>Object.keys(s.threads||{}).length);
  state.cmpSessions=sessions.slice(0,500);
  try{ localStorage.setItem("cw_cmp_sessions",JSON.stringify(state.cmpSessions)); }catch(e){}
  const body={sessions:state.cmpSessions};
  if(opts.deleteIds&&opts.deleteIds.length) body.delete_ids=opts.deleteIds;
  api("/api/cmp-sessions",{method:"POST",body:JSON.stringify(body)}).catch(()=>{});
}
function cmpSessionUpsert(sess){   // 按 id 覆盖或新增(新会话置顶)
  const i=state.cmpSessions.findIndex(s=>s.id===sess.id);
  if(i>=0) state.cmpSessions[i]=sess; else state.cmpSessions.unshift(sess);
  saveCmpSessions(); state._sig=null; renderThreads();
}
function cmpSessionRecordThread(prov,tid){   // cmpRun 建好某栏 thread → 记进当前会话
  if(!CMP.sessionId||!tid) return;
  let s=state.cmpSessions.find(x=>x.id===CMP.sessionId);
  if(!s){
    s={id:CMP.sessionId, topic:CMP.topic||"对比", title_seed:CMP.titleSeed||CMP.topic||"", ts:Date.now(), providers:[], threads:{}};
    state.cmpSessions.unshift(s);
  }
  if(s.threads[prov]!==tid){
    s.threads[prov]=tid; s.providers=Object.keys(s.threads); saveCmpSessions(); state._sig=null; renderThreads();
    if(window.cmpPatchThreadTitle) window.cmpPatchThreadTitle(prov,tid,s.topic);
  }
}
async function loadCmpSessions(){ try{ const r=await api("/api/cmp-sessions"); if(!Array.isArray(r)) return;
    const byId=new Map(state.cmpSessions.map(s=>[s.id,s]));
    const serverIds=new Set(r.map(s=>s&&s.id).filter(Boolean));
    for(const s of r){ const cur=byId.get(s.id);   // 服务端 ∪ 本地:thread 更全者胜;平局比 topic_ts(重命名新者胜,防旧副本盖回名字)
      if(!cur){ byId.set(s.id,s); continue; }
      const ns=Object.keys(s.threads||{}).length, nc=Object.keys(cur.threads||{}).length;
      if(ns>nc || (ns===nc && (s.topic_ts||0)>=(cur.topic_ts||0))) byId.set(s.id,s); }
    const sigOf=a=>a.map(s=>s.id+":"+(s.ts||0)+":"+(s.topic||"")+":"+Object.keys(s.threads||{}).sort().map(p=>p+"="+s.threads[p]).join(",")).join("|");
    const before=sigOf(state.cmpSessions);
    const singles=serverSingleIds();
    const visibleIds=new Set((state.threads||[]).filter(t=>t&&t.id&&!t.archived).map(t=>t.id));
    const merged=[...byId.values()].map(s=>{ const threads={}; for(const [p,tid] of Object.entries(s.threads||{})){ if(!singles.has(tid)) threads[p]=tid; } return {...s,threads,providers:Object.keys(threads)}; })
      .filter(s=>Object.keys(s.threads||{}).length)
      .filter(s=>serverIds.has(s.id) || Object.values(s.threads||{}).some(tid=>visibleIds.has(tid)))   // 清掉本地残留的空壳 session,防止下次 save 又把它推回服务端
      .sort((a,b)=>(b.ts||0)-(a.ts||0));
    const changed=sigOf(merged)!==before;
    state.cmpSessions=merged; try{ localStorage.setItem("cw_cmp_sessions",JSON.stringify(merged.slice(0,500))); }catch(e){}
    if(changed){ state._sig=null; renderThreads(); }
    return state.cmpSessions;
  }catch(e){ /* 离线:沿用 localStorage */ } }
async function renameThread(id, cur){
  const t = prompt("重命名对话:", cur||"");
  if(t===null) return;                      // 取消
  const name=t.trim();
  try{
    await api(`/v1/threads/${id}`,{method:"PATCH",body:JSON.stringify({title:name,title_user:true})});
    const th=state.threads.find(x=>x.id===id); if(th) th.title=name;
    if(state.activeId===id) $("#ttitle").textContent=name||"对话";
    state._sig=null; renderThreads();        // 强制重渲染
  }catch(e){ alert("重命名失败: "+e.message); }
}
async function deleteThread(id,title){
  if(!(await cwConfirm(`删除对话「${title||"未命名"}」?\n(归档移出列表,后端可恢复)`))) return;
  try{ await api(`/v1/threads/${id}`,{method:"PATCH",body:JSON.stringify({archived:true})});
    state.threads=state.threads.filter(t=>t.id!==id);
    if(state.pinned.delete(id)) savePins();
    if(state.cronJobs.delete(id)) saveCronJobs();
    if(state.activeId===id){ closeStream(); runStatusReset(false); state.activeId=null; $("#mwrap").innerHTML='<div class="empty">已删除。左侧选择或新建对话</div>'; $("#ttitle").textContent="CodeWhale"; $("#tmeta").innerHTML=""; setRunning(false); state.autoApprove=false; state.allowShell=false; renderAuto(); renderShell(); }
    if(typeof CMP!=="undefined") Object.keys(CMP.threads||{}).forEach(p=>{   // 删的对话正是对比视图的某一列 → 清那列,不留旧内容
      if(CMP.threads[p]===id){ delete CMP.threads[p]; CMP.seq[p]=0; delete CMP.turn[p]; delete CMP.running[p];
        const b=$("#cmpb-"+CSS.escape(p)); if(b) b.innerHTML=""; const s=$("#cmpst-"+CSS.escape(p)); if(s) s.textContent="对话已删除"; cmpSyncSendUI(); }
    });
    renderThreads();
  }catch(e){ alert("删除失败: "+e.message); }
}

async function applyAuto(id,on){ try{ await api(`/v1/threads/${id}`,{method:"PATCH",body:JSON.stringify({auto_approve:on})}); }catch(e){ console.warn(e); } }  // 只自动批准确认,不额外授予 shell 等权限
async function createThread(){ return await api("/v1/threads",{method:"POST",body:"{}"}); }  // 不传 workspace → app-server 用自己的工作目录($HOME),任何机器都对(不写死路径);新会话默认不自动批准(安全)
async function loadAutoState(id){ try{ const rec=await api(`/v1/threads/${id}`); const th=rec.thread||rec; if(state.activeId===id){ state.autoApprove=!!th.auto_approve; state.allowShell=!!th.allow_shell; renderAuto(); renderShell(); } }catch(e){ console.warn(e); } }
async function applyShell(id,on){ try{ await api(`/v1/threads/${id}`,{method:"PATCH",body:JSON.stringify({allow_shell:on})}); }catch(e){ console.warn(e); } }
function renderShell(){ const w=$("#shellwrap"); if(!w) return; w.classList.toggle("on",state.allowShell); w.classList.toggle("disabled",!state.activeId);
  w.title=state.activeId?"授权 agent 运行 shell/终端命令(关着 exec_shell 不可用)":"先打开一个会话"; }
async function toggleShell(){ if(!state.activeId) return; state.allowShell=!state.allowShell; renderShell(); await applyShell(state.activeId,state.allowShell); }
function renderAuto(){ const w=$("#autowrap"); if(!w) return; w.classList.toggle("on",state.autoApprove); w.classList.toggle("disabled",!state.activeId);
  w.title=state.activeId?"仅对当前会话:开=工具调用弹确认时自动点允许;关=逐次询问":"先打开一个会话,才能为它开启自动批准"; }
async function toggleAuto(){
  if(!state.activeId) return;
  state.autoApprove=!state.autoApprove; renderAuto(); await applyAuto(state.activeId,state.autoApprove);
  if(state.autoApprove) document.querySelectorAll(".tool.needapproval").forEach(c=>{ if(c.dataset.aid) decide(c.dataset.aid,"allow",c,true); });  // 打开时立即放行当前所有待审批项
}


// 乐观把新对话立刻加进侧栏(慢 SWR 缓存要很久才有它)。pendingNew 保证后台 loadThreads 刷新时不被冲掉,直到它真出现再去重。
// 新建按钮 + 单窗口发首条消息(隐式建 thread)都走它。
function _addOptimisticThread(tid, title){
  if(!tid) return;
  const prov=window._newchatProv||"deepseek";
  const opt={id:tid, title:title||"新对话", preview:"", provider:prov, compare:false, updated_at:new Date().toISOString(), latest_turn_status:""};
  state.pendingNew=state.pendingNew||[];
  if(!state.pendingNew.find(x=>x.id===tid)){ state.pendingNew.unshift(opt); savePendingNew(); }
  if(!state.threads.find(x=>x.id===tid)) state.threads.unshift(opt);
  state._sig=null; renderThreads();
}
async function newThread(){
  try{
    const t=await createThread();
    if(t && t.id){ _addOptimisticThread(t.id, "新对话"); openThread(t.id); $("#input").focus(); }
    loadThreads();   // 后台刷真实信息,不 await;pendingNew 会被保留直到真出现
  }catch(e){ alert("新建失败: "+e.message); }
}


export { loadThreads, setConn, threadEl, cmpSessionEl, renameCmpSession, deleteCmpSession, renderThreads, toggleGroup, savePins, loadPins, togglePin, saveCronJobs, loadCronJobs, toggleCronJob, serverSingleIds, saveCmp, markCmp, loadCmp, saveCmpSessions, cmpSessionUpsert, cmpSessionRecordThread, loadCmpSessions, renameThread, deleteThread, applyAuto, createThread, loadAutoState, applyShell, renderShell, toggleShell, renderAuto, toggleAuto, _addOptimisticThread, newThread };
