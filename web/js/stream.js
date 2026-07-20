function updateContextRisk(rec){
  const turns=(rec&&rec.turns)||[];
  state.activeTurnCount=turns.length;
  state.activeMaxInputTokens=turns.reduce((m,t)=>Math.max(m, +(t&&t.usage&&t.usage.input_tokens||0)), 0);
}
function isRiskyContext(){ return state.activeMaxInputTokens>=250000 || state.activeTurnCount>=18; }

async function waitForTurnTerminal(threadId, turnId, timeoutMs=120000){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    const rec=await fetchThreadWindow(threadId);
    const turn=(rec.turns||[]).find(t=>t&&t.id===turnId);
    if(turn && isTurnDone(normTurnStatus(turn.status))) return {turn,rec};
    await new Promise(resolve=>setTimeout(resolve,800));
  }
  throw new Error("上下文整理超时,原消息尚未发送");
}

async function ensureContextCapacityBeforeSend(){
  const tid=state.activeId;
  if(!tid || state._contextMaintenance) return;
  let risk;
  try{
    risk=await api(`/api/thread-context-risk?thread_id=${encodeURIComponent(tid)}`);
  }catch(e){
    console.warn("context risk check failed",e);
    return;
  }
  if(!risk || risk.error || !risk.needs_compaction) return;
  state._contextMaintenance=true;
  if(!state.runUI) runStatusReset(false);
  setRunning(true);
  const pct=risk.pressure?`当前约 ${Math.round(risk.pressure*100)}%`:(risk.reason||"长线程");
  runStatusUpdate("整理上下文",`${pct},先生成恢复摘要再发送`);
  runStatusStep("检测到长线程上下文压力");
  try{
    const started=await api(`/v1/threads/${tid}/compact`,{method:"POST",body:"{}"});
    let turnId=started&&started.turn&&started.turn.id;
    if(!turnId){
      const rec=await fetchThreadWindow(tid);
      turnId=rec&&rec.thread&&rec.thread.latest_turn_id;
    }
    if(!turnId) throw new Error("后端没有返回上下文整理任务 ID");
    state._contextCompactTurnId=turnId;
    const done=await waitForTurnTerminal(tid,turnId);
    const status=normTurnStatus(done.turn.status);
    if(status!=="completed") throw new Error(`上下文整理${status==="interrupted"?"被中断":"失败"}`);
    threadCachePut(tid,done.rec);
    updateContextRisk(done.rec);
    runStatusStep("上下文恢复摘要已落盘");
    runStatusFinish("上下文已整理","done");
    cwToast("上下文已主动整理,正在发送原消息");
  }catch(e){
    runStatusFinish("上下文整理失败","err");
    throw e;
  }finally{
    state._contextCompactTurnId=null;
    state._contextMaintenance=false;
    setRunning(false);
  }
}
function maybeResponsesApiHint(item){
  const msg=String((item&&item.detail)||(item&&item.summary)||"");
  const ctxExceeded=/context_length_exceeded|exceeds the context window/i.test(msg);
  if(!(ctxExceeded || (/Responses API request failed/i.test(msg) && isRiskyContext()))) return;
  const id="respapi-hint-"+(state.activeId||"");
  if(document.getElementById(id)) return;
  const d=document.createElement("div");
  d.className="sysnote actionable";
  d.id=id;
  const max=state.activeMaxInputTokens||0;
  d.textContent=ctxExceeded ? "这条线程的历史已超过模型上下文窗口上限。推荐\"压缩上下文\"后在本线程继续(自动生成结构化摘要替换旧内容,类似 Claude Code 的 /compact);也可以开轻量新线程。" : `这条旧线程上下文已经很大(最高约 ${Math.round(max/1000)}k input tokens), Responses API 在采样前拒绝了请求。建议保留此线程查历史,开一个轻量新线程继续。`;
  const cb=document.createElement("button");
  cb.textContent="压缩上下文并继续";
  cb.onclick=async()=>{
    cb.disabled=true; cb.textContent="压缩中…";
    try{
      await api(`/v1/threads/${state.activeId}/compact`,{method:"POST",body:"{}"});
      cwToast("压缩已开始(约30~60秒),完成后直接继续对话即可");
      d.remove(); // 移除引导条,压缩进度由状态卡自然显示
    }catch(e){ cwToast("压缩失败: "+(e.message||e)); cb.disabled=false; cb.textContent="压缩上下文并继续"; }
  };
  const b=document.createElement("button");
  b.textContent="新建轻量线程";
  b.onclick=async()=>{
    try{
      const t=await createThread();
      _addOptimisticThread(t.id,"轻量继续");
      await openThread(t.id);
      loadThreads();
    }catch(e){
      cwToast("新建失败: "+(e.message||e));
    }
  };
  d.appendChild(document.createElement("br"));
  d.appendChild(cb);
  d.appendChild(document.createTextNode(" "));
  d.appendChild(b);
  $("#mwrap").appendChild(d);
  scrollDown(true);
}
function itemText(item){ return String((item&&item.detail)||(item&&item.summary)||""); }
function isAssistantLikeItem(item){
  const k=String((item&&item.kind)||"agent_message");
  return k==="agent_message" || !["user_message","agent_reasoning","tool_call","command_execution","file_change","status","context_compaction","error"].includes(k);
}
function isExecutableProgressItem(item){
  const k=String((item&&item.kind)||"");
  return ["tool_call","command_execution","file_change","approval","approval_required","sandbox_denied"].includes(k);
}
function looksLikeDanglingWorkIntent(text){
  const raw=String(text||"").trim();
  if(!raw) return false;
  const tail=raw.replace(/\s+/g," ").slice(-1800);
  const englishAction=/\b(search|research|fetch|check|read|run|look up|continue|see the rest|gather|load|call|analy[sz]e|inspect)\b/i;
  if(/\b(let me|i[' ]?ll|i will)\b.{0,120}/i.test(tail) && englishAction.test(tail)) return true;
  if(/\bi need to\s*[:：].{0,300}\b(let me|i[' ]?ll|i will)\b.{0,120}/i.test(tail) && englishAction.test(tail)) return true;
  const zhIntent=/(让我|我来|我会|我先|现在我|接下来|继续|马上|先).{0,80}(搜索|查询|读取|抓取|执行|调用|分析|核对|获取|研究|加载|检索)/;
  if(zhIntent.test(tail) && !/如果你.{0,30}(需要|想要|希望)/.test(tail.slice(-240))) return true;
  return false;
}
function latestEndedTurnItems(rec, preferredTurnId, completedOnly=false){
  const turns=(rec&&rec.turns)||[], all=(rec&&rec.items)||[];
  if(!turns.length || !all.length) return null;
  const thread=(rec&&rec.thread)||{};
  const turn=preferredTurnId ? turns.find(t=>t&&t.id===preferredTurnId) : turns[turns.length-1];
  if(!turn) return null;
  const status=turn.status || (thread.latest_turn_id===turn.id ? thread.latest_turn_status : "");
  const st=normTurnStatus(status);
  if(completedOnly ? st!=="completed" : !isTurnDone(st)) return null;
  const ids=(turn.item_ids||[]).map(String);
  const byId=new Map(all.map(it=>[String(it&&it.id), it]));
  const items=ids.length ? ids.map(id=>byId.get(id)).filter(Boolean) : all;
  return {turn, items, status:st};
}
function maybeUnexecutedWorkHint(rec, preferredTurnId){
  const got=latestEndedTurnItems(rec, preferredTurnId, true);
  if(!got || !got.items.length) return false;
  let idx=-1, agent=null;
  for(let i=got.items.length-1;i>=0;i--){
    if(isAssistantLikeItem(got.items[i])){ idx=i; agent=got.items[i]; break; }
  }
  if(!agent || !looksLikeDanglingWorkIntent(itemText(agent))) return false;
  if(got.items.slice(idx+1).some(isExecutableProgressItem)) return false;
  const id="dangling-work-"+(state.activeId||"thread")+"-"+(got.turn.id||"latest");
  if(document.getElementById(id)) return true;
  const recoveryPrompt="继续执行你刚才承诺的下一步。不要只描述计划，请直接调用可用工具完成搜索/读取/分析，并全程用中文给出最终结果；如果确实受阻，请明确说明阻塞原因和需要我提供的非敏感信息，不要索要密码、密钥或验证码。";
  const d=document.createElement("div");
  d.className="sysnote actionable";
  d.id=id;
  d.textContent="这轮已经结束了。最后一段像是在说“接下来要搜索/读取/调用工具”，但后端没有收到后续工具调用，所以不会再出现新的工作进展。";
  const b=document.createElement("button");
  b.type="button";
  b.textContent="继续执行";
  b.onclick=()=>{
    const inp=$("#input");
    if(inp){
      inp.value=recoveryPrompt;
      inp.dispatchEvent(new Event("input"));
      inp.focus();
    }
    if(state.running) queueFromInput();
    else send();
  };
  d.appendChild(document.createElement("br"));
  d.appendChild(b);
  $("#mwrap").appendChild(d);
  scrollDown(true);
  return true;
}
function meaningfulAgentText(item){
  return (item&&item.kind)==="agent_message" ? itemText(item).trim() : "";
}
function tailProgressLabel(item){
  if(!item) return "未知步骤";
  const k=item.kind||"";
  const txt=item.summary||item.detail||"";
  if(k==="tool_call") return "工具调用";
  if(k==="command_execution") return "命令执行";
  if(k==="file_change") return "文件改动";
  if(k==="agent_reasoning") return "思考过程";
  if(k==="context_compaction") return "上下文压缩";
  if(k==="error") return "错误";
  return (k||"步骤")+" "+String(txt||"").replace(/\s+/g," ").slice(0,40);
}
function maybeMissingFinalReplyHint(rec, preferredTurnId){
  const got=latestEndedTurnItems(rec, preferredTurnId, false);
  if(!got || !got.items.length) return false;
  let lastAgent=-1, lastProgress=-1, tail=null;
  for(let i=0;i<got.items.length;i++){
    const it=got.items[i]||{}, k=it.kind||"";
    if(meaningfulAgentText(it)) lastAgent=i;
    if(isExecutableProgressItem(it) || k==="agent_reasoning" || k==="context_compaction" || k==="error"){
      const txt=itemText(it).trim();
      if(k!=="agent_reasoning" || txt) { lastProgress=i; tail=it; }
    }
  }
  const hasWork=got.items.some(it=>isExecutableProgressItem(it) || (it&&it.kind)==="agent_reasoning" || (it&&it.kind)==="context_compaction");
  if(!hasWork) return false;
  if(lastAgent>=0 && lastProgress<=lastAgent && got.status==="completed") return false;
  if(lastProgress<=lastAgent && lastAgent>=0) return false;
  const id="missing-final-"+(state.activeId||"thread")+"-"+(got.turn.id||"latest");
  if(document.getElementById(id)) return true;
  const recoveryPrompt="请基于刚才已经完成的读取、搜索、工具调用和中间结果，直接给出最终产出。不要从头寒暄，不要只描述计划；如果还缺一个关键数据，再补最少必要工具调用。全程用中文；如果确实受阻，请说明原因，但不要索要密码、密钥或验证码。";
  const d=document.createElement("div");
  d.className="sysnote actionable";
  d.id=id;
  const statusText=got.status==="completed"?"已结束":(got.status==="interrupted"?"被中断":"失败/异常结束");
  d.textContent=`这轮${statusText},但最后没有产出一条有效的最终回复。尾部停在「${tailProgressLabel(tail)}」后面,常见原因是上下文压缩/工具调用后没有恢复到总结阶段。`;
  const b=document.createElement("button");
  b.type="button";
  b.textContent="继续总结产出";
  b.onclick=()=>{
    const inp=$("#input");
    if(inp){
      inp.value=recoveryPrompt;
      inp.dispatchEvent(new Event("input"));
      inp.focus();
    }
    if(state.running) queueFromInput();
    else send();
  };
  d.appendChild(document.createElement("br"));
  d.appendChild(b);
  $("#mwrap").appendChild(d);
  scrollDown(true);
  return true;
}
async function maybeUnexecutedWorkHintForActive(turnId){
  const id=state.activeId;
  if(!id || state.running || state.queue.length) return;
  try{
    const rec=await fetchThreadWindow(id);
    if(state.activeId!==id || state.running) return;
    threadCachePut(id, rec);
    settleVisibleFileCards();
    await renderTurnArtifacts(turnId);
    settleVisibleFileCards();
    // 终态只提示,绝不静默创建新 turn。继续执行必须由用户点击按钮确认。
    if(!maybeUnexecutedWorkHint(rec, turnId)) maybeMissingFinalReplyHint(rec, turnId);
  }catch(e){ console.warn("dangling work hint check failed", e); }
}

function dedupeVisibleFileCards(){
  const cards=[...document.querySelectorAll("#mwrap .chat-file-card[data-path]")];
  const kept=[];
  const sameFile=(a,b)=>{
    if(a===b) return true;
    const homeA=a.startsWith("~/")?a.slice(1):"";
    const homeB=b.startsWith("~/")?b.slice(1):"";
    return (homeA && b.endsWith(homeA)) || (homeB && a.endsWith(homeB));
  };
  cards.reverse().forEach(card=>{
    const path=String(card.dataset.path||"");
    if(!path || !kept.some(other=>sameFile(path,other))){ kept.push(path); return; }
    const box=card.parentElement;
    const preview=card.nextElementSibling;
    if(preview&&preview.classList.contains("chat-file-inline-preview")) preview.remove();
    card.remove();
    if(box&&box.classList.contains("chat-files")&&!box.querySelector(".chat-file-card")) box.remove();
  });
}

let fileCardDedupeTimer=null;
function settleVisibleFileCards(){
  dedupeVisibleFileCards();
  clearTimeout(fileCardDedupeTimer);
  fileCardDedupeTimer=setTimeout(()=>{
    fileCardDedupeTimer=null;
    dedupeVisibleFileCards();
  },600);
}

async function renderTurnArtifacts(turnId){
  const tid=state.activeId;
  if(!tid || !turnId) return [];
  const id=`turn-artifacts-${tid}-${turnId}`;
  const existing=document.getElementById(id);
  if(existing) return existing.dataset.count?JSON.parse(existing.dataset.count):[];
  const data=await api(`/api/thread-artifacts?thread_id=${encodeURIComponent(tid)}&turn_id=${encodeURIComponent(turnId)}`);
  const files=(data&&data.files)||[];
  if(!files.length || state.activeId!==tid) return [];
  const visibleCards=[...document.querySelectorAll("#mwrap .chat-file-card[data-path]")];
  const missing=files.filter(file=>!visibleCards.some(card=>{
    const cardPath=String(card.dataset.path||"");
    const cardName=cardPath.split("/").pop();
    return cardPath===file.path || (cardName && cardName===file.name);
  }));
  if(!missing.length) return files;
  const box=document.createElement("section");
  box.className="turn-artifacts";
  box.id=id;
  box.dataset.count=JSON.stringify(files);
  box.innerHTML=`<div class="turn-artifacts-title">${icon("file")} <span>本轮产出文件</span><small>${missing.length} 个</small></div>`;
  $("#mwrap").appendChild(box);
  missing.forEach(file=>appendFileDownloadCards(box,file.path));
  scrollDown(true);
  return files;
}

async function reconcileSnapshotDelivery(rec){
  const turns=(rec&&rec.turns)||[];
  const turn=[...turns].reverse().find(t=>t&&isTurnDone(normTurnStatus(t.status))&&t.input_summary!=="Manual context compaction");
  settleVisibleFileCards();
  if(turn) try{ await renderTurnArtifacts(turn.id); }catch(e){ console.warn("artifact reconciliation failed",e); }
  settleVisibleFileCards();
  if(!maybeUnexecutedWorkHint(rec,turn&&turn.id)) maybeMissingFinalReplyHint(rec,turn&&turn.id);
}
let mainView=null;
const SNAPSHOT_VISIBLE_ITEMS = 80;       // fetchThreadWindow 默认窗口大小;渲染分页常量在 chat-view.js 内部
function getMainView(){
  if(!mainView){
    if(typeof window.createChatView!=="function") throw new Error("chat-view.js 未加载");
    mainView=window.createChatView({
      bag:state,
      getWrap:()=>$("#mwrap"),
      getScrollHost:()=>$("#messages"),
      inputSel:"#input",
      hooks:{
        allowRunStatusEvent,
        onStatusEvent:onViewStatusEvent,
        onTurnFinished:onViewTurnFinished,
        onAssistantFinal:onViewAssistantFinal,
        onUserMessage:onViewUserMessage,
        onSnapshotStart:onViewSnapshotStart,
        onSnapshotRendered:onViewSnapshotRendered,
        fetchThreadWindow,
        threadCachePut,
        onTerminalOutput:onViewTerminalOutput,
        onFileChangeFinal:onViewFileChangeFinal
      }
    });
  }
  return mainView;
}
function chatTools(){
  if(!window.chatViewTools) throw new Error("chat-view tools 未加载");
  return window.chatViewTools;
}
function stableEventKey(ev, m, p){ return getMainView().stableEventKey(ev,m,p||{}); }
function seenStableEvent(ev, m, p){ return getMainView().seenStableEvent(ev,m,p||{}); }
function eventTurnId(m, p={}){ return getMainView().eventTurnId(m,p); }
function markTurnFinished(id){ return getMainView().markTurnFinished(id); }
function isFinishedTurn(id){ return getMainView().isFinishedTurn(id); }
function allowRunStatusEvent(m, p={}){
  const tid=eventTurnId(m,p);
  return !(tid && isFinishedTurn(tid));
}
function scrollDown(force){ return getMainView().scrollDown(force); }
const SMART_TITLE_DELAY_MS = 1000;        // 首条消息发出后很快智能命名;给后端 1s 写入 turn/user_message,不再等 60s
const smartTitleTimers = new Map();

function scheduleSmartTitle(tid, expectedTitle, seedText=""){
  if(!tid || !expectedTitle) return;
  if(smartTitleTimers.has(tid)) clearTimeout(smartTitleTimers.get(tid));
  const timer=setTimeout(async()=>{
    smartTitleTimers.delete(tid);
    try{
      const r=await api("/api/thread-title/auto",{method:"POST",body:JSON.stringify({thread_id:tid,expected_title:expectedTitle,seed:seedText})});
      if(!r||!r.ok||!r.title) return;
      const apply=t=>{ if(t&&t.id===tid) t.title=r.title; };
      state.threads.forEach(apply);
      (state.pendingNew||[]).forEach(apply);
      savePendingNew();
      if(state.activeId===tid) $("#ttitle").textContent=r.title;
      state._sig=null; renderThreads(); loadThreads();
    }catch(e){ console.warn("smart title failed", e); }
  }, SMART_TITLE_DELAY_MS);
  smartTitleTimers.set(tid,timer);
}

function onViewStatusEvent(evt, p={}){
  switch(evt.type){
    case "turn.started":
      setRunning(true); runStatusUpdate(evt.label,evt.detail); runStatusStep(evt.step); break;
    case "turn.interrupt_requested":
      runStatusUpdate(evt.label,evt.detail); runStatusStep(evt.step); setRunning(false); break;
    case "turn.lifecycle.running":
      setRunning(true); runStatusUpdate(evt.label,evt.detail); break;
    case "item.started":
      runStatusFromItem(evt.item,"开始处理"); break;
    case "item.delta.reasoning": case "item.delta.message": case "item.delta.command":
      runStatusUpdate(evt.label,evt.detail); break;
    case "item.completed":
      { const pair=runLabelForItem(evt.item); runStatusStep(`完成: ${pair[1]||pair[0]}`); runStatusUpdate("整理中","工具步骤已完成,等待模型继续"); }
      break;
    case "item.failed":
      { const pair=runLabelForItem(evt.item||{}); runStatusStep(`失败: ${pair[1]||pair[0]}`,"err"); runStatusUpdate("步骤失败",pair[1]||"某一步失败","err"); }
      break;
    case "item.failure.hint":
    case "item.error":
      maybeResponsesApiHint(evt.item); break;
    case "approval.required":
      approvalRequired(evt.m, p);
      if(evt.allowed){ runStatusUpdate("等待审批",p.tool_name||p.tool||p.command||p.summary||"工具调用需要确认"); runStatusStep("等待审批: "+(p.tool_name||p.tool||p.command||p.summary||"工具调用")); }
      break;
    case "approval.decided": case "approval.timeout":
      approvalResolved(evt.m,p,evt.ev||evt.type);
      if(evt.allowed){ runStatusUpdate("审批已处理",evt.type==="approval.timeout"?"审批超时":(p.decision==="allow"?"已允许工具调用":"已拒绝工具调用")); runStatusStep(evt.type==="approval.timeout"?"审批超时":(p.decision==="allow"?"审批通过":"审批拒绝")); }
      break;
    case "sandbox.denied":
      sysnote("⛔ 沙箱拒绝: "+(p.detail||p.reason||""));
      if(evt.allowed){ runStatusStep("沙箱拒绝: "+(p.detail||p.reason||""),"err"); runStatusUpdate("沙箱拒绝",p.detail||p.reason||"工具被拒绝","err"); }
      break;
  }
}
function onViewTurnFinished(turnId, status, meta={}){
  const st=normTurnStatus(status);
  const label=meta.label || (st==="completed"?"已完成":(st==="interrupted"?"已停止":(st==="failed"||st==="error"?"本轮失败":"已结束")));
  const kind=meta.kind || (st==="failed"||st==="error"?"err":"done");
  if(meta.stale){ finishStaleRunUI(turnId,label,kind); return; }
  state.stopTurnId=null; state.stopRequestedAt=0;
  runStatusFinish(label,kind); procGroupFinish(); state._procGroup=null; setRunning(false);
  if(meta.refresh) refreshActiveMeta();
  if(turnId===state._contextCompactTurnId) return;
  const finish=async()=>{
    if(meta.checkHints && !state.queue.length) await maybeUnexecutedWorkHintForActive(turnId);
    processQueue();
  };
  setTimeout(()=>finish().catch(e=>{ console.warn("turn delivery reconciliation failed",e); processQueue(); }),250);
}
function onViewAssistantFinal(item, el){}
function onViewUserMessage(item, el, meta={}){
  if(state.runUI&&state.runUI.el&&document.body.contains(state.runUI.el)){
    el.insertAdjacentElement("afterend", state.runUI.el);
  }
  timelineRegisterUser(el, meta.text||"", {scope:"single", key:meta.id, item});
}
function onViewSnapshotStart(){ runStatusReset(false); timelineReset("single"); }
function onViewSnapshotRendered(rec){ reconcileSnapshotDelivery(rec).catch(e=>console.warn("snapshot delivery reconciliation failed",e)); }
function onViewTerminalOutput(text, failed=false, meta=null, live=false){ previewFeedTerminal(text,failed,meta,live); }
function onViewFileChangeFinal(){ if(preview.url && preview.autoRefresh) setTimeout(previewReload,250); }
function closeStream(){ if(state.es){ state.es.close(); state.es=null; } }
const THREAD_CACHE_DB="codewhale-thread-cache-v1";
let _threadCacheDb=null;
function threadCacheDB(){
  if(_threadCacheDb) return _threadCacheDb;
  _threadCacheDb=new Promise((resolve,reject)=>{
    if(!("indexedDB" in window)) return reject(new Error("indexedDB unavailable"));
    const req=indexedDB.open(THREAD_CACHE_DB,1);
    req.onupgradeneeded=()=>{ const db=req.result; if(!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots",{keyPath:"id"}); };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error||new Error("indexedDB open failed"));
  }).catch(e=>{ _threadCacheDb=null; throw e; });
  return _threadCacheDb;
}
async function threadCacheGet(id){
  try{
    const db=await threadCacheDB();
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction("snapshots","readonly");
      const req=tx.objectStore("snapshots").get(id);
      req.onsuccess=()=>resolve(req.result&&req.result.rec);
      req.onerror=()=>reject(req.error);
    });
  }catch(e){ return null; }
}
async function threadCachePut(id, rec){
  try{
    if(!id||!rec) return;
    const db=await threadCacheDB();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction("snapshots","readwrite");
      tx.objectStore("snapshots").put({id,ts:Date.now(),seq:rec.latest_seq||0,rec});
      tx.oncomplete=()=>resolve();
      tx.onerror=()=>reject(tx.error);
    });
  }catch(e){}
}
async function fetchThreadWindow(id, opts={}){
  const q=new URLSearchParams({thread_id:id,limit:String(opts.limit||SNAPSHOT_VISIBLE_ITEMS)});
  if(opts.start!=null) q.set("start", String(opts.start));
  const rec=await api("/api/thread-window?"+q.toString());
  if(rec&&rec.error) throw new Error(rec.error);
  return rec;
}
async function renderThreadSnapshot(rec, preserveQueue=false, opts={}){
  return getMainView().renderSnapshot(rec,preserveQueue,Object.assign({},opts,{fetchThreadWindow,threadCachePut,renderSnapshot:renderThreadSnapshot}));
}
async function syncActiveTurn(){
  if(!state.activeId) return;
  if(state._activeSyncing && Date.now()-(state._activeSyncingAt||0)<20000) return;   // 同步锁带超时:一次 HTTP 挂死不能永远锁住对账(否则"可能卡住"没人来核实)
  const id=state.activeId, summary=activeSummary(id);
  if(!state.running && !(summary&&isTurnRunning(summary.latest_turn_status)) && !state.runUI) return;   // 状态卡还开着也要对账:running 可能已被别处(threads 轮询)置 false,卡不能没人管
  state._activeSyncing=true; state._activeSyncingAt=Date.now();
  try{
    let rec;
    try{ rec=await fetchThreadWindow(id); }
    catch(winErr){ rec=await api(`/v1/threads/${id}`); }
    if(state.activeId!==id) return;
    threadCachePut(id, rec);
    const info=turnInfoFromSnapshot(rec, summary);
    if(info.turnId) state.turnId=info.turnId;
    if(info.done){
      if(isFinishedTurn(info.turnId)){   // 该轮已被(快照播种)标记完成,但状态卡可能还开着 → 补关卡再退出
        if(state.running || state.runUI){ runStatusFinish(normTurnStatus(info.status)==="failed"?"已结束(失败)":"已完成","done"); procGroupFinish(); state._procGroup=null; setRunning(false); processQueue(); }
        return;
      }
      markTurnFinished(info.turnId);
      if(isStoppingTurn(info.turnId)){ state.stopTurnId=null; state.stopRequestedAt=0; }
      runStatusFinish(normTurnStatus(info.status)==="completed"?"已完成":(normTurnStatus(info.status)==="interrupted"?"已停止":"已结束"), normTurnStatus(info.status)==="failed"||normTurnStatus(info.status)==="error"?"err":"done");
      if((rec.latest_seq||0)>(state.latestSeq||0)) renderThreadSnapshot(rec,true);
      setRunning(false); refreshActiveMeta(); processQueue();
    }else if(info.running){
      const freshStop=isStoppingTurn(info.turnId) && Date.now()-state.stopRequestedAt<15000;
      if(!freshStop){
        const eventFresh=state.lastEventAt && Date.now()-state.lastEventAt<12000;
        const alreadyVisible=state.running && state.runUI && eventFresh;
        setRunning(true);
        if(!alreadyVisible) runStatusUpdate("同步中","后端仍在运行,等待新事件");
      }
    }
  }catch(e){ console.warn("active turn sync failed", e); }
  finally{ state._activeSyncing=false; }
}
async function openThread(id){
  if(state.activeId===id && state.es) return;
  closeStream();
  runStatusReset(false);
  timelineReset("single");
  timelineClose();
  state.activeId=id; getMainView().reset(); state.stopTurnId=null; state.stopRequestedAt=0; setRunning(false);
  state.autoApprove=false; state.allowShell=false; renderAuto(); renderShell(); loadAutoState(id);   // 读该会话真实 auto_approve/allow_shell 如实显示
  renderThreads(); closeDrawer();
  try{
    const s=activeSummary(id);
    if(s && !s.compare && s.provider && typeof refreshActiveProviderChrome==="function") refreshActiveProviderChrome(s.provider);
    else if(typeof loadModelLabel==="function") loadModelLabel();
  }catch(e){}
  $("#emptyState")?.remove();
  const wrap=$("#mwrap"); wrap.innerHTML="";
  const t=activeSummary(id);
  $("#ttitle").textContent=t?.title||"对话";
  $("#tmeta").innerHTML = t ? `<span class="badge" title="此对话锁定的模型">${esc(PROV_SHORT[t.provider]||t.provider||t.model||"")}</span><span class="badge">${esc(t.mode||"")}</span><span class="badge">${esc((t.workspace||"").split("/").pop()||"~")}</span>` : "";
  const summaryRunning=t&&isTurnRunning(t.latest_turn_status);
  if(summaryRunning){ setRunning(true); runStatusUpdate("同步中","这轮还在运行,正在加载现场"); }

  // 快照渲染历史(一次 GET 拿全部 item)→ 再从 latest_seq 起只听新事件。
  // 避免旧做法从 since_seq=0 重放上万条事件(切大会话时卡顿的根源)。
  let since=0, cached=null, renderedSeq=0, renderedCount=0;
  $("#mwrap").innerHTML='<div class="sysnote" id="histloading">· 载入历史…</div>';
  try{
    cached=await threadCacheGet(id);
    if(cached && state.activeId===id){
      since=cached.latest_seq||0; renderedSeq=since; renderedCount=(cached.items||[]).length; state.latestSeq=since;
      updateContextRisk(cached);
      const cinfo=turnInfoFromSnapshot(cached, t);
      if(cinfo.turnId) state.turnId=cinfo.turnId;
      await renderThreadSnapshot(cached,false,{cached:true});
      if(cinfo.running || summaryRunning){ setRunning(true); runStatusUpdate("同步中","已显示本地快照,正在校验最新状态"); }
    }
  }catch(e){ console.warn("thread cache read failed", e); }
  try{
    let rec;
    try{ rec=await fetchThreadWindow(id); }
    catch(winErr){ rec=await api(`/v1/threads/${id}`); }
    if(state.activeId!==id) return;   // 等待期间又切走了 → 放弃,别污染新会话
    since=rec.latest_seq||0; state.latestSeq=since;
    threadCachePut(id, rec);
    updateContextRisk(rec);
    const info=turnInfoFromSnapshot(rec, t);   // 切到一条仍在跑的对话:快照不会重放已发生的 turn.started → 据此同步 running,否则会误发触发 409
    if(info.turnId) state.turnId=info.turnId;
    if(!cached || renderedSeq!==since || renderedCount!==(rec.items||[]).length) await renderThreadSnapshot(rec);
    restoreResearchRecords(id);
    if(info.running || summaryRunning){ setRunning(true); runStatusUpdate("同步中","这轮还在运行,正在接收新状态"); runStatusStep("恢复运行中的对话"); }
  }catch(e){
    if(!cached){ $("#mwrap").innerHTML=""; since=0; }
    console.warn("快照载入失败,退回从"+since+"重放",e);
  }

  const es=new EventSource(url(`/v1/threads/${id}/events?since_seq=${since}`));
  state.es=es;
  ["thread.started","thread.forked","turn.started","turn.lifecycle","turn.completed","turn.failed","turn.interrupted","turn.steered",
   "turn.interrupt_requested","item.started","item.delta","item.completed","item.failed","item.interrupted",
   "approval.required","approval.decided","approval.timeout","sandbox.denied"]
   .forEach(ev=>es.addEventListener(ev,e=>onEvent(ev,e)));
  es.onerror=()=>{ /* auto-reconnect; seen-set dedups replay */ };
}

/* ---------- event handling ---------- */
function queueSnapshotEvent(ev, m){ return getMainView().queueSnapshotEvent(ev,m); }
function replayPendingSnapshotEvents(activeId){ return getMainView().replayPendingSnapshotEvents(activeId); }
function finishStaleRunUI(doneTurnId, label, kind){
  if(!doneTurnId || doneTurnId!==state.turnId || !state.running) return;
  runStatusFinish(label,kind); procGroupFinish(); state._procGroup=null; setRunning(false);
}
function isReplayedOldItem(m,p){ return getMainView().isReplayedOldItem(m,p||{}); }
function onEvent(ev, e){
  let m; try{ m=JSON.parse(e.data); }catch{ return; }
  if(m.thread_id && m.thread_id!==state.activeId) return;
  getMainView().ingest(ev,m);
}
function handleEvent(ev, m){ return getMainView().handleEvent(ev,m); }
function decorateUserUploads(contentEl, raw){ return getMainView().decorateUserUploads(contentEl, raw); }
function collapseInterimMsgs(){ return getMainView().collapseInterimMsgs(); }
function procGroupEnsure(){ return getMainView().procGroupEnsure(); }
function procGroupAppend(el,item,count=true){ return getMainView().procGroupAppend(el,item,count); }
function procGroupFinish(){ return getMainView().procGroupFinish(); }
function startItem(id, item){ return getMainView().startItem(id,item); }
function deltaItem(id, delta, kind){ return getMainView().deltaItem(id,delta,kind); }
function preferLongerText(streamed, finalText){ return chatTools().preferLongerText(streamed, finalText); }
function completeItem(id, item, failed){ return getMainView().completeItem(id,item,failed); }
function detectOptions(text){ return chatTools().detectOptions(text); }
function optionTextFromSelection(sel, otherInp){ return chatTools().optionTextFromSelection(sel, otherInp); }
function fillOptionInput(inputSel, txt){ return chatTools().fillOptionInput(inputSel, txt); }
function optionTargets(container, fallbackSel){ return chatTools().optionTargets(container, fallbackSel); }
function buildOptPicker(items, inputSel, container){ return chatTools().buildOptPicker(items, inputSel, container); }
function augmentOptions(container, text, inputSel){ return chatTools().augmentOptions(container, text, inputSel||"#input"); }

function restoreComposerDraft(inp, raw){
  const draft=String(raw||"").trim(), current=String(inp&&inp.value||"");
  if(inp && draft && current.trim()!==draft) inp.value=current.trim()?`${draft}\n${current}`:draft;
  if(inp){ inp.style.height="auto"; inp.style.height=Math.min(inp.scrollHeight,200)+"px"; inp.focus(); }
  const btn=$("#sendbtn"); if(btn) btn.disabled=!(inp&&inp.value.trim())&&!state.attachments.length;
}

async function send(queuedText){
  const inp=$("#input");
  let text=queuedText;
  if(text===undefined){
    const raw=inp.value.trim(); if(!raw && !state.attachments.length) return;
    state._preparingSend=true;
    const waiting=state.attachments.some(a=>a&&a.pending);
    const prepared=withAttachments(raw);   // 同步取走当前附件包，异步只等待文件落盘；输入框立即可写下一条
    inp.value=""; inp.style.height="auto"; getMainView().setStick(true);
    if(waiting){
      if(!state.running) runStatusReset(false);
      setRunning(true); runStatusUpdate("附件已入队","文件落盘并完成本机快速 OCR 后发送");
    }
    try{ text=await prepared; }
    catch(e){
      state._preparingSend=false; restoreComposerDraft(inp,raw);
      if(waiting){ runStatusFinish("附件准备失败","err"); setRunning(false); processQueue(); }
      sysnote("附件准备失败，已恢复输入: "+String(e&&e.message||e)); return;
    }
    if(!text){
      state._preparingSend=false;
      if(waiting){ runStatusFinish("附件发送失败","err"); setRunning(false); processQueue(); }
      return;
    }
  }   // 新发:折入附件路径 + 贴底
  if(!text) return;
  state._preparingSend=true;
  try{
    let implicitNewTitle="";
    if(!state.activeId){ const t=await createThread(); implicitNewTitle=roughThreadTitle(text); _addOptimisticThread(t.id, implicitNewTitle); await openThread(t.id); loadThreads(); }   // 乐观立刻把新 thread 加进侧栏(否则慢 SWR 缓存下首条消息不生成可见 thread,要发第二条才出现);loadThreads 后台刷,不阻塞
    await ensureContextCapacityBeforeSend();
    // 乐观渲染:会话就绪后立刻显示用户消息 + 进入"运行中"(思考指示),不等 SSE。否则首条要等后端起 turn(~1s+,推理模型更久),
    // 这段时间窗口空白,体感像"卡住/过好久才显示"。真 user_message 事件到达时由 startItem 认领这个气泡,不重复。
    const oel=row("user","你"); const oc=oel.querySelector(".content"); if(!decorateUserUploads(oc,text)) oc.innerHTML=md(text); $("#mwrap").appendChild(oel); state._optimUser=oel;
    if(!state.running) runStatusReset(false);   // 上一轮的状态卡若没被正确关闭(事件丢失/睡眠),别复用它的计时起点——防"502m"僵尸计数
    setRunning(true); runStatusUpdate("发送中","正在把消息交给模型"); scrollDown(true);
    const th=state.threads.find(x=>x.id===state.activeId);
    const freezeName = !!implicitNewTitle || !th || !th.title || th.title==="New Thread";   // 首条消息 → 先落粗标题,随后按对话目的智能改名
    const r=await api(`/v1/threads/${state.activeId}/turns`,{method:"POST",body:JSON.stringify({prompt:text})});
    state._preparingSend=false;
    state.turnId=r?.turn?.id||state.turnId; setRunning(true); runStatusUpdate("思考中","请求已送达,等待模型返回状态"); runStatusStep("请求已送达");
    if(freezeName){
      const title=implicitNewTitle || roughThreadTitle(text);
      const tid=state.activeId;
      api(`/v1/threads/${tid}`,{method:"PATCH",body:JSON.stringify({title})}).then(()=>{
        const t2=state.threads.find(x=>x.id===tid); if(t2) t2.title=title;
        if(state.activeId===tid) $("#ttitle").textContent=title; state._sig=null; renderThreads();
      }).catch(()=>{}).finally(()=>scheduleSmartTitle(tid,title,text));
    }
  }catch(e){
    state._preparingSend=false;
    if(state._optimUser){ state._optimUser.remove(); state._optimUser=null; }   // 发送失败/转排队 → 移除乐观气泡(由排队占位或错误提示接管)
    if(/\b409\b|active turn/i.test(e.message||"")){   // 该对话仍有一轮在跑(切回来误发/连点)→ 不报错,转为排队,turn 完成后自动发
      setRunning(true); state.queue.push({text, el:(()=>{ const el=document.createElement("div"); el.className="msg user queued"; el.innerHTML=`<div class="av">你</div><div class="body"><div class="who">${icon("clock")} 排队中(上一轮还在跑)</div><div class="content"></div><button class="qx" title="取消排队">✕</button></div>`; el.querySelector(".content").textContent=text; el.querySelector(".qx").onclick=()=>{ const i=state.queue.findIndex(q=>q.el===el); if(i>=0) state.queue.splice(i,1); el.remove(); }; $("#mwrap").appendChild(el); scrollDown(true); return el; })()});
      runStatusUpdate("排队中","上一轮仍在运行,这条会稍后发送");
      return;
    }
    inp.value=text; inp.style.height="auto"; inp.style.height=Math.min(inp.scrollHeight,200)+"px"; inp.focus();  // 失败:文字留回输入框
    $("#sendbtn").disabled=false;
    runStatusFinish("发送失败","err");
    sysnote("发送失败: "+e.message);
  }
}
function enterSend(){
  const inp=$("#input"); const raw=inp.value.trim();
  // 外部研究 harness: /df /gptr /odr /storm /agentloop /pydai /browser /crew /obsidian 前缀
  const hm=raw.match(/^\/(df|deerflow|gptr|odr|storm|agentloop|loop|pydai|pydantic|browser|browseruse|browse|crew|crewai|obsidian|vault|method|skill)\s+([\s\S]+)$/i);
  if(hm){
    const key=hm[1].toLowerCase();
    const prompt=hm[2].trim();
    if(!prompt) return;
    inp.value=""; inp.style.height="auto"; $("#sendbtn").disabled=true;
    const engine={df:"deerflow",deerflow:"deerflow",gptr:"gptr",odr:"odr",storm:"storm",agentloop:"agentloop",loop:"agentloop",pydai:"pydai",pydantic:"pydai",browser:"browser",browseruse:"browser",browse:"browser",crew:"crew",crewai:"crew",obsidian:"obsidian",vault:"obsidian",method:"skill",skill:"skill"}[key]||"deerflow";
    submitDeerFlowFromInput(prompt, engine); return;
  }
  if(state.running || state._preparingSend) queueFromInput(); else send();
}   // 运行中=排队,空闲=直接发
function queueFromInput(){
  const inp=$("#input"); const raw=inp.value.trim(); if(!raw && !state.attachments.length) return;
  const prepared=withAttachments(raw);   // 立即取走这一条的附件包，解析未完成也不会占住下一条输入
  inp.value=""; inp.style.height="auto"; $("#sendbtn").disabled=true;
  const el=document.createElement("div"); el.className="msg user queued";
  el.innerHTML=`<div class="av">你</div><div class="body"><div class="who">${icon("clock")} 排队中（截图快速识别后发送）</div><div class="content"></div><button class="qx" title="取消排队">✕</button></div>`;
  el.querySelector(".content").textContent=raw||"(附件)";
  el.querySelector(".qx").onclick=()=>{ const i=state.queue.findIndex(q=>q.el===el); if(i>=0) state.queue.splice(i,1); el.remove(); };
  $("#mwrap").appendChild(el); scrollDown(true);
  const item={text:"", el, ready:false}; state.queue.push(item);
  prepared.then(text=>{
    item.text=text||""; item.ready=true;
    if(!item.text){ const i=state.queue.indexOf(item); if(i>=0) state.queue.splice(i,1); el.remove(); }
    processQueue();
  }).catch(e=>{ const i=state.queue.indexOf(item); if(i>=0) state.queue.splice(i,1); el.remove(); restoreComposerDraft(inp,raw); sysnote("附件发送失败，已恢复输入: "+e.message); processQueue(); });
}
function processQueue(){   // 当前任务结束后,自动发下一条排队消息
  if(state.running || state._contextMaintenance || !state.queue.length) return;
  if(state.queue[0].ready===false) return;   // 保持用户发送顺序：前一条附件落盘前，后一条不能插队
  const item=state.queue.shift(); item.el.remove();   // 移除占位,真消息由 turn 事件渲染
  if(item.text) send(item.text); else processQueue();
}
async function interrupt(){
  if(!state.activeId) return;
  let turn=state.turnId;
  if(!turn){ try{ const rec=await api(`/v1/threads/${state.activeId}`); turn=(rec.thread||rec).latest_turn_id; }catch{} }  // turnId 丢了就查回来
  if(!turn) return;
  state.stopTurnId=turn; state.stopRequestedAt=Date.now(); runStatusUpdate("正在停止","准备中断当前轮并处理悬挂审批"); setRunning(false);
  const cards=pendingApprovalCards();
  if(cards.length) await Promise.allSettled(cards.map(c=>decide(c.dataset.aid,"deny",c,true)));   // 停止时先拒掉悬挂审批,否则后端会继续等工具批准
  try{ await api(`/v1/threads/${state.activeId}/turns/${turn}/interrupt`,{method:"POST",body:"{}"}); setRunning(false);
    if(state.queue.length){ state.queue.forEach(q=>q.el.remove()); state.queue=[]; }   // 停止=连排队的也取消
    sysnote("⏹ 已请求停止"); }
  catch(e){
    if(approvalGoneError(e)){ state.stopTurnId=null; state.stopRequestedAt=0; runStatusFinish("这轮已经结束","done"); sysnote("⏹ 这轮已经结束"); }
    else { runStatusUpdate("停止失败",e.message,"err"); sysnote("停止失败: "+e.message); }
  }
}

/* ---------- 附件上传 ---------- */
async function uploadOne(f, scope){   // 上传单个文件到 workspace,返回附件记录或 null(通用,单窗口/对比各栏共用)
  if(f.size>50*1024*1024){ sysnote("⚠ "+f.name+" 超过 50MB,跳过"); return null; }
  try{
    const buf=await f.arrayBuffer();
    const r=await fetch(url("/api/upload"),{method:"POST",headers:{...auth,"X-Filename":encodeURIComponent(f.name),"X-Upload-Scope":scope||"inbox","X-Upload-Extract":"deferred"},body:buf});
    const d=await r.json();
    if(d.path) return uploadAttachmentRecord(f,d);
    sysnote("⚠ 上传失败: "+(d.error||f.name));
  }catch(e){ sysnote("⚠ 上传失败: "+e.message); }
  return null;
}
async function uploadFiles(files){
  await optimisticUpload(files,{scope:state.activeId||"inbox",list:state.attachments,render:renderAttach,skipNotify:sysnote});
}

function renderAttach(){
  const bar=$("#attachbar"); bar.innerHTML="";
  state.attachments.forEach((a,i)=>{
    bar.appendChild(attachmentChip(a,()=>{ revokeAttachmentPreview(a); state.attachments.splice(i,1); renderAttach(); }));
  });
  $("#sendbtn").disabled=!state.running && !$("#input").value.trim() && !state.attachments.length;
}
async function withAttachments(text){   // 取走附件后等落盘 + 本机亚秒级 OCR；耗时视觉补充留在后台
  if(!state.attachments.length) return text;
  const bundle=takeAttachmentBundle(state.attachments,renderAttach);
  try{ return await attachmentPrompt(text,bundle); }
  catch(e){ restoreAttachmentBundle(state.attachments,bundle,renderAttach); throw e; }
}


function initMessageScroll(){
  let _lastTop=0;
  $("#messages").addEventListener("scroll",()=>{
    const r=getMainView().updateStickFromScroll(_lastTop);
    _lastTop=r.top;
    $("#scrollbtn").classList.toggle("show",!r.stick);
  });
  $("#scrollbtn").onclick=()=>scrollDown(true);
  $("#mwrap").addEventListener("click",e=>{ const b=e.target.closest(".mact"); if(!b) return; const msg=b.closest(".msg"); if(!msg) return;
    if(b.classList.contains("copy")) copyMsg(b,msg); else if(b.classList.contains("edit")) editMsg(msg); });   // 消息操作:复制 / 编辑(委托,#mwrap 持久)
}

export { updateContextRisk, isRiskyContext, maybeResponsesApiHint, ensureContextCapacityBeforeSend, renderTurnArtifacts, scrollDown, closeStream, renderThreadSnapshot, syncActiveTurn, openThread, onEvent, startItem, deltaItem, preferLongerText, completeItem, detectOptions, optionTextFromSelection, fillOptionInput, optionTargets, buildOptPicker, augmentOptions, scheduleSmartTitle, send, enterSend, queueFromInput, processQueue, interrupt, uploadOne, uploadFiles, renderAttach, withAttachments, initMessageScroll };
