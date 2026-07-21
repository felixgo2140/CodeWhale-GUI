// ── 对比:每栏「只追问」输入框各自的附件 ──
async function cmpColUpload(prov, files){
  CMP.colAttach=CMP.colAttach||{}; (CMP.colAttach[prov]=CMP.colAttach[prov]||[]);
  const scope="cmp_"+prov;   // 服务端 _safe_upload_scope 只认 thr_*/cmp_*(下划线),否则落 inbox
  await optimisticUpload(files,{scope,list:CMP.colAttach[prov],render:()=>cmpColRenderAttach(prov),skipNotify:sysnote});
}
function cmpColRenderAttach(prov){
  const bar=$("#cmpcatt-"+CSS.escape(prov)); if(!bar) return;
  const list=(CMP.colAttach&&CMP.colAttach[prov])||[];
  bar.innerHTML=""; bar.hidden=!list.length;
  list.forEach((a,i)=>bar.appendChild(attachmentChip(a,()=>{ revokeAttachmentPreview(a); list.splice(i,1); cmpColRenderAttach(prov); })));
}
async function cmpColWithAttach(prov, text){   // 取走该栏附件包；等落盘 + 本机 OCR，远程视觉补充留在后台
  const list=(CMP.colAttach&&CMP.colAttach[prov])||[];
  if(!list.length) return text;
  const bundle=takeAttachmentBundle(list,()=>cmpColRenderAttach(prov));
  try{ return await attachmentPrompt(text,bundle); }
  catch(e){ restoreAttachmentBundle(list,bundle,()=>cmpColRenderAttach(prov)); throw e; }
}

function cmpRestoreDraft(inp, raw){
  const draft=String(raw||"").trim(), current=String(inp&&inp.value||"");
  if(inp && draft && current.trim()!==draft) inp.value=current.trim()?`${draft}\n${current}`:draft;
  if(inp){ inp.style.height="auto"; inp.focus(); }
}

/* ---------- 多模型并排对比 ---------- */
const CMP={ sel:new Set(), threads:{}, seq:{}, keyed:{}, maxed:null, autoApprove:true, allowShell:false, fakeip:false, turn:{}, running:{}, busy:false, sendQ:[], provQ:{}, dispatching:{}, cancelled:{}, attachments:[], prepareChain:null, sessionId:null, topic:"", titleSeed:"", history:{}, historyLoading:{}, historyFull:{}, brief:{}, briefLoading:{}, restoring:false, views:{}, bags:{}, runState:{}, latestPrompt:{} };  // sessionId:当前对比会话(null=未开始,首次发送时建);provQ=按模型拆开的待发送队列
const CMP_TITLE_DELAY_MS=1000;
const CMP_CONTEXT_RISK={ "openai-codex":{maxInput:220000, turns:14} };
const CMP_HANDOFF_AGENT_CHARS=9000;
const CMP_HANDOFF_USER_CHARS=2200;
const cmpTitleTimers=new Map();
// 建对比线程时直接把 model 钉到 thread 级,绕过 default_text_model="auto" 的自动路由(它会按 prompt 内容乱选、常落 deepseek,导致 GLM/GPT 栏答错)。
const CMP_FORCE_MODEL={ deepseek:"deepseek-v4-pro", volcengine:"doubao-seed-2-1-pro-260628", longcat:"LongCat-2.0", qwen:"qwen3.7-max-2026-06-08", zai:"GLM-5.2", "openai-codex":"gpt-5.6-sol", "claude-code":"fable", moonshot:"k3", custom:"hy3-preview" };   // 各 provider 默认模型(徽章/下拉的默认选中);实际由 server.py model_prefs 决定
// 每 provider 可选模型变体(下拉)。claude-code 用别名(fable/opus/sonnet/haiku),server 端 env 传给 claude -p + 身份串跟着走。
const MODEL_VARIANTS={
  "claude-code":[{id:"fable",name:"Fable 5"},{id:"opus",name:"Opus 4.8"},{id:"sonnet",name:"Sonnet 4.6"},{id:"haiku",name:"Haiku 4.5"}],
  deepseek:[{id:"deepseek-v4-pro",name:"V4 Pro"},{id:"deepseek-v4-flash",name:"V4 Flash"}],
  volcengine:[{id:"doubao-seed-2-1-pro-260628",name:"Seed 2.1 Pro"},{id:"doubao-seed-2-1-turbo-260628",name:"Seed 2.1 Turbo"},{id:"doubao-seed-evolving",name:"Seed Evolving(需手动开通)"},{id:"doubao-seed-1-6-251015",name:"Seed 1.6"}],
  longcat:[{id:"LongCat-2.0",name:"LongCat-2.0"}],
  qwen:[{id:"qwen3.8-max-preview",name:"Qwen 3.8 Max Preview · Token Plan"},{id:"qwen3.7-max-2026-06-08",name:"Qwen 3.7 Max Stable"},{id:"qwen3.7-max",name:"Qwen 3.7 Max"},{id:"qwen3.7-plus",name:"Qwen 3.7 Plus"}],
  custom:[{id:"hy3-preview",name:"Hy3 Preview"},{id:"hy-mt2-pro",name:"Hy-MT2 Pro"},{id:"hy-mt2-plus",name:"Hy-MT2 Plus"},{id:"hy-mt2-lite",name:"Hy-MT2 Lite"},{id:"hunyuan-role-latest",name:"Hunyuan Role Latest"},{id:"hy-role",name:"Hunyuan Role"},{id:"hunyuan-2.0-thinking-20251109",name:"HY 2.0 Think (旧)"},{id:"hunyuan-2.0-instruct-20251111",name:"HY 2.0 Instruct (旧)"}],
  zai:[{id:"GLM-5.2",name:"GLM-5.2"},{id:"GLM-4.6",name:"GLM-4.6"}],
  "openai-codex":[{id:"gpt-5.6-sol",name:"GPT-5.6 Sol"},{id:"gpt-5.6-terra",name:"GPT-5.6 Terra"},{id:"gpt-5.6-luna",name:"GPT-5.6 Luna"},{id:"gpt-5.5",name:"GPT-5.5"}],
  moonshot:[{id:"k3",name:"K3"},{id:"kimi-for-coding-highspeed",name:"K2.7 Code Highspeed"},{id:"kimi-for-coding",name:"K2.7 Code"}],   // Kimi Code /models 会动态刷新；K3 是默认模型
};
let providerModelCatalogPromise=null;
function applyProviderModelCatalog(payload){
  const items=(payload&&payload.items)||{};
  window._providerModelCatalog=items;
  Object.entries(items).forEach(([prov,info])=>{
    const models=Array.isArray(info&&info.models)?info.models:[];
    if(!models.length) return;
    const curated=MODEL_VARIANTS[prov]||[];
    const merged=[...curated,...models.map(m=>({id:m.id,name:m.name||m.id}))];
    const seen=new Set();
    MODEL_VARIANTS[prov]=merged.filter(m=>m.id&&!seen.has(m.id)&&(seen.add(m.id),true));
  });
  return items;
}
async function loadProviderModels(force=false){
  if(providerModelCatalogPromise && !force) return providerModelCatalogPromise;
  providerModelCatalogPromise=api("/api/provider-models"+(force?"?force=1":"")).then(applyProviderModelCatalog).catch(e=>{
    console.warn("provider models load failed", e);
    return window._providerModelCatalog||{};
  });
  return providerModelCatalogPromise;
}
// 支持推理 effort 的 provider:claude-code(claude -p --effort)、openai-codex(GPT,Responses reasoning.effort)。其它家 runtime 不传 effort。
const EFFORT_PROVIDERS=["claude-code","openai-codex"];
const EFFORT_OPTS=[{v:"",n:"effort:默认"},{v:"low",n:"低"},{v:"medium",n:"中"},{v:"high",n:"高"}];   // 默认(claude-code):claude -p --effort 只认 low/medium/high
// GPT(openai-codex,Responses API)支持更高档:xhigh/max 实测真做更多推理(high=305 reasoning token,xhigh=830),runtime filter 已放行
const EFFORT_OPTS_BY_PROV={ "openai-codex":[{v:"",n:"effort:默认"},{v:"low",n:"低"},{v:"medium",n:"中"},{v:"high",n:"高"},{v:"xhigh",n:"超高"},{v:"max",n:"最高"}] };
function effortOptsFor(prov){ return EFFORT_OPTS_BY_PROV[prov] || EFFORT_OPTS; }
// 本机是否 fake-ip 代理环境(普通机器=false→不发 curl/MCP 引导,fetch_url 照常用;被劫持机器=true→引导走 curl/MCP)


function initCompareNetenv(){
  api("/api/netenv").then(d=>{ CMP.fakeip=!!(d&&d.fakeip); }).catch(()=>{});
}
async function initCompareLitellm(){
  const el=$("#cmpLite");
  if(!el) return;
  try{
    const d=await api("/api/litellm-routing");
    const on=!!(d&&d.compare_enabled&&d.proxy&&d.proxy.running);
    el.hidden=!on;
    if(on){
      const n=d.proxy.models!=null?` · ${d.proxy.models} models`:"";
      el.title="对比流量经 LiteLLM 网关"+n;
    }
  }catch(e){ el.hidden=true; }
}
function cmpViewHost(prov){ return $("#cmpb-"+CSS.escape(prov)); }
function cmpInputSel(prov){ return "#cmpin-"+CSS.escape(prov); }
function cmpNewBag(prov){
  const bag={activeId:CMP.threads[prov]||null};
  CMP.bags[prov]=bag;
  return bag;
}
function cmpBag(prov){ return CMP.bags[prov] || cmpNewBag(prov); }
function cmpSetViewThread(prov, tid){
  const bag=cmpBag(prov);
  if(tid) bag.activeId=tid;
  const view=cmpEnsureView(prov);
  return view;
}
function cmpEnsureView(prov){
  const host=cmpViewHost(prov);
  if(!host) return null;
  if(CMP.views[prov]) return CMP.views[prov];
  if(typeof window.createChatView!=="function") throw new Error("chat-view.js 未加载");
  const bag=cmpBag(prov);
  const view=window.createChatView({
    bag,
    getWrap:()=>cmpViewHost(prov),
    getScrollHost:()=>cmpViewHost(prov),
    inputSel:cmpInputSel(prov),
    hooks:{
      allowRunStatusEvent:(m,p)=>cmpAllowRunStatusEvent(prov,m,p),
      onStatusEvent:(evt,p)=>cmpOnViewStatusEvent(prov,evt,p),
      onTurnFinished:(turnId,status,meta)=>cmpOnViewTurnFinished(prov,turnId,status,meta),
      onAssistantFinal:(item,el,meta)=>cmpOnViewAssistantFinal(prov,item,el,meta),
      onUserMessage:(item,el,meta)=>cmpOnViewUserMessage(prov,item,el,meta)
    }
  });
  CMP.views[prov]=view;
  // 文件卡由 ChatView.completeItem -> appendPdfDownloadCards -> appendFileDownloadCards 触发。
  return view;
}
function cmpResetView(prov, opts={}){
  const view=CMP.views[prov];
  if(view) view.reset();
  else cmpNewBag(prov);
  cmpBag(prov).activeId=CMP.threads[prov]||null;
  if(opts.clear!==false){ const b=cmpViewHost(prov); if(b) b.innerHTML=""; }
}
function cmpDropView(prov, opts={}){
  const view=CMP.views[prov];
  if(view) view.reset();
  delete CMP.views[prov]; delete CMP.bags[prov]; delete CMP.runState[prov];
  if(opts.clear){ const b=cmpViewHost(prov); if(b) b.innerHTML=""; }
}
function cmpResetAllViews(){
  Object.keys(CMP.views||{}).forEach(prov=>cmpDropView(prov,{clear:true}));
  document.querySelectorAll("#cmpCols .cmpcol").forEach(c=>{ if(!CMP.views[c.dataset.p]) cmpResetView(c.dataset.p,{clear:true}); });
}
function cmpCleanUserText(text){ return String(text||"").replace(/^【本机网络环境[\s\S]*?】\s*/,""); }
function cmpHtmlText(html){
  const d=document.createElement("div");
  d.innerHTML=String(html||"");
  return d.textContent||d.innerText||"";
}
function cmpAppendSysNote(prov, html, cls=""){
  const b=cmpViewHost(prov); if(!b) return null;
  const d=document.createElement("div");
  d.className=("sysnote "+cls).trim();
  d.innerHTML=html;
  b.appendChild(d);
  b.scrollTop=b.scrollHeight;
  return d;
}
function cmpStaticItemId(prov,prefix){ return `${prefix}_${prov}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }
function cmpAddViewUser(prov,text,opts={}){
  const view=cmpEnsureView(prov); if(!view) return null;
  const id=opts.key||cmpStaticItemId(prov,"cmpuser");
  const item={id,kind:"user_message",detail:String(text||""),summary:String(text||""),created_at:opts.time,started_at:opts.time};
  const clean=cmpCleanUserText(item.detail).trim();
  if(clean) CMP.latestPrompt[prov]={text:clean,time:opts.time||new Date().toISOString()};
  view.startItem(id,item);
  view.completeItem(id,item,false);
  const rec=cmpBag(prov).items&&cmpBag(prov).items.get(id);
  if(opts.optimistic && rec&&rec.el) cmpBag(prov)._optimUser=rec.el;
  return rec&&rec.el;
}
function cmpAddViewAssistant(prov,text,opts={}){
  const view=cmpEnsureView(prov); if(!view) return null;
  const id=opts.id||cmpStaticItemId(prov,"cmpassistant");
  const item={id,kind:"agent_message",detail:String(text||""),summary:String(text||"")};
  view.startItem(id,{id,kind:"agent_message",detail:"",summary:""});
  view.completeItem(id,item,!!opts.failed);
  const rec=cmpBag(prov).items&&cmpBag(prov).items.get(id);
  return rec&&rec.el;
}
function cmpAddViewError(prov,text){
  const view=cmpEnsureView(prov); if(!view) return null;
  const id=cmpStaticItemId(prov,"cmperr");
  const item={id,kind:"error",detail:String(text||"错误"),summary:String(text||"错误")};
  view.startItem(id,item);
  view.completeItem(id,item,true);
  const rec=cmpBag(prov).items&&cmpBag(prov).items.get(id);
  return rec&&rec.el;
}
function cmpIsToolKind(kind){ return !!(kind && !["agent_message","agent_reasoning","user_message"].includes(kind)); }
function cmpRunSecs(rs){ return Math.round((Date.now()-(rs&&rs.t0||Date.now()))/1000); }
function cmpRunStatusText(rs){ return (rs.phase||"思考中")+(rs.steps?(" · "+rs.steps+"步"):"")+" · "+cmpRunSecs(rs)+"s"; }
function cmpRunProgressText(rs){ return cmpRunStatusText(rs)+(rs.lastStep?" · 最近:"+rs.lastStep:""); }
function cmpRunPushProgress(prov){
  const rs=CMP.runState&&CMP.runState[prov]; if(!rs||rs.done) return;
  const st=$("#cmpst-"+CSS.escape(prov));
  if(st&&!/^[✓✗⏸⏱]/.test(st.textContent)) st.textContent=cmpRunStatusText(rs);
  cmpSetProgress(prov,cmpRunProgressText(rs));
}
function cmpRunSetPhase(prov, phase){
  const rs=CMP.runState&&CMP.runState[prov]; if(!rs||rs.done) return;
  rs.phase=phase||rs.phase||"思考中";
  cmpRunPushProgress(prov);
}
function cmpRunAddStep(prov, text){
  const rs=CMP.runState&&CMP.runState[prov]; if(!rs||rs.done) return;
  rs.steps++;
  rs.lastStep=String(text||"").replace(/\s+/g," ").slice(0,120);
  cmpRunPushProgress(prov);
  const view=CMP.views&&CMP.views[prov]; if(view) view.scrollDown();
}
function cmpRunRecordAnswer(prov, text){
  const rs=CMP.runState&&CMP.runState[prov]; if(!rs||rs.done) return;
  if(String(text||"").trim()) rs.hasAnswer=true;
  if(rs.grace){ clearTimeout(rs.grace); rs.grace=null; }
  if(rs.pendingCompleteEvent){
    const ev=rs.pendingCompleteEvent, view=CMP.views&&CMP.views[prov];
    rs.pendingCompleteEvent=null;
    if(view) rs.grace=setTimeout(()=>{ if(!rs.done) view.ingest("turn.completed",ev); },800);
  }
}
function cmpAllowRunStatusEvent(prov,m,p={}){
  const view=CMP.views&&CMP.views[prov]; if(!view) return true;
  const tid=view.eventTurnId(m,p);
  return !(tid && view.isFinishedTurn(tid));
}
function cmpOnViewStatusEvent(prov, evt, p={}){
  const rs=CMP.runState&&CMP.runState[prov];
  if(!rs) return;
  const item=evt.item || p.item || {};
  const kind=item.kind || p.kind || "";
  switch(evt.type){
    case "turn.started":
      CMP.turn[prov]=evt.m.turn_id||(p.turn&&p.turn.id)||CMP.turn[prov];
      cmpSyncSendUI();
      cmpRunSetPhase(prov,"思考中");
      break;
    case "turn.interrupt_requested":
      cmpRunSetPhase(prov,"正在停止");
      break;
    case "turn.lifecycle.running":
      cmpRunSetPhase(prov,"处理中");
      break;
    case "item.started":
      if(cmpIsToolKind(kind)){
        rs.lastStep=String(item.summary||kind||"工具调用").replace(/\s+/g," ").slice(0,120);
        cmpRunSetPhase(prov,kind==="command_execution"?"执行命令":"执行工具");
      }
      break;
    case "item.delta.reasoning":
      cmpRunSetPhase(prov,"思考中");
      break;
    case "item.delta.message":
      cmpRunRecordAnswer(prov,p.delta||" ");
      cmpRunSetPhase(prov,"输出中");
      break;
    case "item.delta.command":
      cmpRunSetPhase(prov,"执行命令");
      break;
    case "item.completed":
      if(cmpIsToolKind(kind)){ rs.sawTool=true; cmpRunAddStep(prov,"工具: "+String(item.summary||kind).slice(0,140)); }
      break;
    case "item.failed":
      { const msg=String(item.detail||item.summary||"失败").replace(/\s+/g," ").slice(0,160);
        if(cmpIsToolKind(kind)||!kind){ rs.sawTool=true; cmpRunAddStep(prov,"工具失败: "+msg); cmpRunSetPhase(prov,"重试中"); } }
      break;
    case "approval.required":
      if(evt.allowed===false) break;
      { const aid=p.approval_id||p.id||evt.m.approval_id;
        const tool=String(p.tool_name||p.command||p.summary||"工具调用").slice(0,90);
        if(CMP.autoApprove && aid){
          fetch(url(`/cmp/${prov}/v1/approvals/${aid}`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({decision:"allow",remember:false})}).catch(()=>{});
          cmpRunAddStep(prov,"自动批准: "+tool);
        }else cmpRunAddStep(prov,"需批准: "+tool+"(开「自动批准」放行)");
      }
      break;
  }
}
function cmpOnViewTurnFinished(prov, turnId, status, meta={}){
  const rs=CMP.runState&&CMP.runState[prov];
  if(!rs || (turnId && rs.turnId && turnId!==rs.turnId)) return;
  const st=normTurnStatus(status);
  if((st==="failed"||st==="error") && !rs.hasAnswer) cmpAddViewError(prov,"本轮失败(展开「过程」看详情)");
  if(st==="interrupted"){ const s=$("#cmpst-"+CSS.escape(prov)); if(s) s.textContent="⏸ 已暂停"; }
  if(typeof rs.finish==="function") rs.finish(st==="failed"||st==="error");
}
function cmpOnViewAssistantFinal(prov,item,el,meta={}){
  cmpRunRecordAnswer(prov,meta.text||item.detail||item.summary||"");
  cmpScheduleSummaryRender();
}
function cmpOnViewUserMessage(prov,item,el,meta={}){
  const text=cmpCleanUserText(meta.text||item.detail||item.summary||"");
  if(text.trim()) CMP.latestPrompt[prov]={text:text.trim(),time:item.started_at||item.created_at||item.updated_at||item.ended_at||new Date().toISOString()};
  const key=(el&&el.dataset&&el.dataset.tlKey) || meta.id || item.id || cmpTimelineKey(text,item.started_at||item.created_at);
  timelineRegisterUser(el,text,{scope:"compare",key,time:item.started_at||item.created_at||item.updated_at||item.ended_at,provider:prov});
  cmpScheduleSummaryRender();
}

async function openCompare(){
  $("#cmpView").hidden=false;
  CMP.busy=false; CMP.sendQ=[]; CMP.provQ={}; CMP.dispatching={}; CMP.cancelled={}; clearAttachmentList(CMP.attachments);   // 重开对比视图清掉可能遗留的发送队列/派发锁/附件,避免误判 busy 卡住发送
  if(Object.keys(CMP.threads||{}).length===0) timelineReset("compare");
  // ① 先把界面渲染出来(用已有/默认状态,不等后端)→ 立刻可见,不再"显示先不全 / 刷新才出"
  if(CMP.sel.size===0){
    ["deepseek","openai-codex"].forEach(p=>{ if(CMP.keyed[p]) CMP.sel.add(p); });   // 已知 keyed 就按配置选
    if(CMP.sel.size===0){ CMP.sel.add("deepseek"); CMP.sel.add("openai-codex"); }   // keyed 还没到 → 先默认两栏,保证有列
  }
  renderCmpChips(); renderCmpCols(); renderCmpToggles(); cmpSyncSendUI(); cmpRenderAttach();
  loadProviderModels().then(()=>{ renderCmpChips(); renderCmpCols(); }).catch(()=>{});
  initCompareLitellm();
  setCmpLayout(_cmpLay);   // 应用上次的排列方式(横/标签/田)+ 点亮按钮
  document.querySelectorAll("#cmpLayout .laybtn").forEach(b=>b.onclick=()=>setCmpLayout(b.dataset.l));
  setTimeout(()=>{ const i=$("#cmpInput"); if(i) i.focus(); },60);
  // ② 后端准备放后台(不挡渲染):取配置/偏好(到了刷新 chips 的"已配置"标记/下拉默认)+ 没会话时重置陈旧后端 + 预热
  try{ const d=await api("/api/model"); CMP.keyed=d.keyed||{}; renderCmpChips(); }catch(e){}
  try{ const mp=await api("/api/model-pref"); CMP.modelPrefs=mp.prefs||{}; CMP.modelEffort=mp.effort||{}; renderCmpChips(); }catch(e){}   // 各列当前所选模型变体 + claude effort
  // 打开/刷新对比窗口不能全局 reset provider 后端：这些进程也承载单模型线程，
  // 自动清理会把其它窗口正在运行的 turn 硬中断。显式“重启后端”按钮仍可按需 reset。
  api("/api/compare/ensure",{method:"POST",body:JSON.stringify({providers:[...CMP.sel]})}).catch(()=>{});   // 预热选中栏后端
}
function closeCompare(){ $("#cmpView").hidden=true; }
async function cmpFindSession(sessionId){
  if(!sessionId) return null;
  let s=state.cmpSessions.find(x=>x.id===sessionId);
  if(s) return s;
  try{
    const r=await api("/api/cmp-session?id="+encodeURIComponent(sessionId));
    if(r && r.id){
      cmpSessionUpsert(r);
      return r;
    }
  }catch(e){}
  try{
    await loadCmpSessions();
    return state.cmpSessions.find(x=>x.id===sessionId) || null;
  }catch(e){ return null; }
}
function cmpShowSessionError(sessionId,msg){
  $("#cmpView").hidden=false;
  renderCmpChips(); renderCmpToggles(); cmpSyncSendUI(); cmpRenderAttach();
  const box=$("#cmpCols");
  if(box) box.innerHTML=`<div class="cmpmsg a err">✗ ${esc(msg||"对比会话恢复失败")}<br><span class="muted">session: ${esc(sessionId||"")}</span></div>`;
}
function openCompareWindow(sessionId){   // 开一个全新独立对比窗口(原生壳 createWebViewWith → 新 NSWindow,可拖/缩放/最小化、能同时开多个);带 sessionId 则在新窗口里还原那场对比
  let u=location.origin+location.pathname+"?compare=1";
  if(sessionId) u+="&session="+encodeURIComponent(sessionId);
  let w=null; try{ w=window.open(u,"_blank"); }catch(e){}
  if(w) return;   // 新原生壳:独立窗口已开
  // window.open 返回 null = 老壳(网页已更新但壳还没 ⌘Q 重开到含 createWebViewWith 的版本)或浏览器拦截 →
  // 优雅降级:在本页覆盖层打开对比(旧行为,功能不丢),不再弹错误。首次温和提示怎么拿独立窗口。
  if(!window._cmpWinHinted){ window._cmpWinHinted=true; cwToast("独立窗口需退出重开 CodeWhale 更新一次;已先在本页打开对比"); }
  if(sessionId){ cmpFindSession(sessionId).then(s=>s?restoreCompareSession(s):cmpShowSessionError(sessionId,"找不到这个对比会话")); return; }
  openCompare();
}
async function restoreCompareSession(sess){   // 点侧栏对比会话 → 打开对比窗口,恢复各栏 thread + 逐栏回填历史,回到当时对话
  closeDrawer();
  if(!sess || !Object.keys(sess.threads||{}).length){ cmpShowSessionError(sess&&sess.id,"这个对比会话没有可恢复的子线程"); return; }
  timelineReset("compare");
  timelineClose();
  CMP.sessionId=sess.id;
  CMP.topic=sess.topic||"对比"; CMP.titleSeed=sess.title_seed||sess.topic||"";
  CMP.threads={...(sess.threads||{})}; CMP.seq={}; CMP.turn={}; CMP.running={}; CMP.busy=false; CMP.sendQ=[]; CMP.provQ={}; CMP.dispatching={}; CMP.cancelled={}; CMP.history={}; CMP.historyLoading={}; CMP.historyFull={}; CMP.brief={}; CMP.briefLoading={}; CMP.latestPrompt={}; clearAttachmentList(CMP.attachments); CMP.maxed=null;
  CMP.sel=new Set(Object.keys(sess.threads||{}));
  if(CMP.sel.size===0) CMP.sel.add("deepseek");
  cmpResetAllViews();
  $("#cmpView").hidden=false;
  try{ const d=await api("/api/model"); CMP.keyed=d.keyed||{}; }catch(e){}
  try{ const mp=await api("/api/model-pref"); CMP.modelPrefs=mp.prefs||{}; CMP.modelEffort=mp.effort||{}; }catch(e){}
  CMP.restoring=true;
  renderCmpChips(); renderCmpCols(); renderCmpToggles(); cmpSyncSendUI(); cmpRenderAttach();
  initCompareLitellm();
  CMP.restoring=false;
  setCmpLayout(_cmpLay);
  document.querySelectorAll("#cmpLayout .laybtn").forEach(b=>b.onclick=()=>setCmpLayout(b.dataset.l));
  [...CMP.sel].forEach((prov,i)=>setTimeout(()=>cmpLoadBrief(prov, sess.threads[prov]), i*60));   // 首屏只读本地最新摘要;完整历史等点进某栏再加载
  setTimeout(()=>{ const i=$("#cmpInput"); if(i) i.focus(); },60);
}
function cmpBriefSnapshot(prov, rec){
  const th=rec.thread||{}, turn=rec.turn||{}, latest=rec.latest||{};
  const tid=rec.thread_id||th.id||CMP.threads[prov]||"";
  const turnId=turn.id||("cmpbrief_turn_"+prov+"_"+(tid||Date.now()));
  const items=[];
  if(latest.user&&latest.user.text){
    const txt=cmpCleanUserText(latest.user.text);
    const id=latest.user.id||("cmpbrief_user_"+prov+"_"+turnId);
    items.push({id,turn_id:turnId,kind:"user_message",detail:txt,summary:txt,status:"completed",created_at:turn.created_at||th.updated_at,started_at:turn.created_at||th.updated_at});
  }
  if(latest.agent&&latest.agent.text){
    const txt=String(latest.agent.text||"");
    const id=latest.agent.id||("cmpbrief_agent_"+prov+"_"+turnId);
    items.push({id,turn_id:turnId,kind:"agent_message",detail:txt,summary:txt,status:"completed",created_at:turn.ended_at||th.updated_at,started_at:turn.ended_at||th.updated_at});
  }
  return {
    thread:Object.assign({},th,{id:tid||th.id||""}),
    turns:[Object.assign({},turn,{id:turnId,thread_id:tid,status:turn.status||"completed",item_ids:items.map(x=>x.id)})],
    items,
    latest_seq:CMP.seq[prov]||0,
    total_items:items.length,
    window_start:0,
    window_end:items.length,
    windowed:false
  };
}
async function cmpRenderBrief(prov, rec){
  const b=cmpViewHost(prov); if(!b) return;
  const tid=rec.thread_id||(rec.thread&&rec.thread.id)||"";
  cmpSetViewThread(prov,tid);
  b.dataset.tid=tid;
  b.dataset.mode="brief";
  CMP.brief[prov]=rec;
  const snap=cmpBriefSnapshot(prov,rec);
  await cmpEnsureView(prov).renderSnapshot(snap,false);
  const th=rec.thread||{}, turn=rec.turn||{};
  const meta=[th.updated_at?relTime(th.updated_at):"", turn.status||""].filter(Boolean).join(" · ");
  const note=cmpAppendSysNote(prov,`最新摘要${meta?` · ${esc(meta)}`:""}<button class="cmpfullhist">加载完整历史</button>`,"histnote cmpbriefnote");
  if(note){
    b.insertBefore(note,b.firstChild);
    note.querySelector(".cmpfullhist").onclick=()=>cmpEnsureHistory(prov,{force:true});
  }
  if(!snap.items.length) cmpAppendSysNote(prov,rec.has_more?"(最新内容待加载)":"(暂无历史内容)");
  timelineRender();
  b.scrollTop=b.scrollHeight;
  cmpScheduleSummaryRender();
}
async function cmpLoadBrief(prov,tid){
  const b=$("#cmpb-"+CSS.escape(prov));
  if(!tid){ if(b) b.innerHTML=""; return; }
  if(b && b.dataset.tid===tid && b.dataset.mode && b.children.length) return;
  if(CMP.briefLoading[prov]===tid) return;
  CMP.briefLoading[prov]=tid;
  if(b){ b.dataset.mode="brief"; b.dataset.tid=tid; b.innerHTML=""; cmpAppendSysNote(prov,"· 载入最新摘要…"); }
  try{
    const rec=await api(`/api/cmp-thread-brief?provider=${encodeURIComponent(prov)}&thread_id=${encodeURIComponent(tid)}`);
    if(rec&&rec.error) throw new Error(rec.error);
    await cmpRenderBrief(prov,rec);
  }catch(e){
    if(b){ b.dataset.mode="brief"; b.innerHTML=""; const note=cmpAppendSysNote(prov,'· 摘要不可用 <button class="cmpfullhist">加载完整历史</button>',"histnote"); if(note) note.querySelector(".cmpfullhist").onclick=()=>cmpEnsureHistory(prov,{force:true}); }
  }finally{ if(CMP.briefLoading[prov]===tid) delete CMP.briefLoading[prov]; }
}
function cmpEnsureHistory(prov,opts={}){
  const tid=CMP.threads[prov];
  if(!tid) return;
  if(CMP.running[prov]||CMP.dispatching[prov]) return;
  const b=$("#cmpb-"+CSS.escape(prov));
  if(!opts.force && b && b.dataset.tid===tid && b.dataset.mode==="history" && b.children.length) return;
  cmpLoadHistory(prov,tid,{force:!!opts.force});
}
function cmpTimelineKey(text, time, prefix="cmp"){
  const d=timelineTimeValue(time||Date.now());
  return prefix+":"+timelineHash(text)+":"+Math.floor(d.getTime()/60000);
}
function cmpSnapshotForView(rec){
  const out=Object.assign({},rec||{});
  out.thread=Object.assign({},(rec&&rec.thread)||{});
  out.turns=((rec&&rec.turns)||[]).map(t=>Object.assign({},t));
  out.items=((rec&&rec.items)||[]).map(it=>{
    const x=Object.assign({},it);
    if(x.kind==="user_message"||x.kind==="user"){
      if(x.detail!=null) x.detail=cmpCleanUserText(x.detail);
      if(x.summary!=null) x.summary=cmpCleanUserText(x.summary);
      if(x.text!=null) x.text=cmpCleanUserText(x.text);
    }
    return x;
  });
  return out;
}
async function cmpRenderHistory(prov, rec, opts={}){
  const b=cmpViewHost(prov); if(!b) return;
  const tid=(rec&&rec.thread&&rec.thread.id)||CMP.threads[prov]||"";
  cmpSetViewThread(prov,tid);
  const snap=cmpSnapshotForView(rec);
  CMP.historyFull[prov]=!!opts.full;
  await cmpEnsureView(prov).renderSnapshot(snap,false,{start:opts.start,preserveScroll:opts.preserveScroll,renderSnapshot:(next,preserve,nextOpts)=>cmpRenderHistory(prov,next,Object.assign({},opts,nextOpts))});
  if(!((snap.items||[]).length)){
    const th=(snap&&snap.thread)||{};
    cmpAppendSysNote(prov,th.archived?"(原始子线程已归档且无可显示内容)":"(无历史内容)");
  }
  timelineRender();
  b.dataset.tid=tid;
  b.dataset.mode="history";
  b.scrollTop=b.scrollHeight;
  cmpScheduleSummaryRender();
}
async function cmpLoadHistory(prov,tid,opts={}){   // 拉某栏 thread 对话消息;渲染交给 chat-view 快照分页/懒 markdown,避免打开大 group 顶满 CPU
  const b=$("#cmpb-"+CSS.escape(prov));
  if(!tid){ if(b) b.innerHTML=""; return; }
  if(b && b.dataset.tid===tid && b.dataset.mode==="history" && b.children.length && !opts.force) return;
  if(CMP.historyLoading[prov]===tid) return;
  CMP.historyLoading[prov]=tid;
  cmpSetViewThread(prov,tid);
  if(b){ b.dataset.mode="loading"; b.innerHTML=""; cmpAppendSysNote(prov,"· 载入历史…"); }
  if(!tid){ if(b) b.innerHTML=""; return; }
  try{
    const rec=await (await fetch(url(`/cmp/${prov}/v1/threads/${tid}`))).json();
    if(rec && rec.error) throw new Error(rec.error);
    CMP.seq[prov]=rec.latest_seq||0;
    CMP.history[prov]=rec;
    await cmpRenderHistory(prov,rec,{full:!!opts.full});
  }catch(e){ if(b) b.innerHTML=""; cmpAddMsg(prov,"a err","✗ 载入历史失败:"+esc(e.message||"")); }
  finally{ if(CMP.historyLoading[prov]===tid) delete CMP.historyLoading[prov]; }
}
function cmpNormalizeLayout(l){ return l==="col" ? "tab" : (["row","tab","grid","stack","summary"].includes(l)?l:"row"); }
function cmpFirstSelectedProvider(){ return [...CMP.sel][0] || null; }

function cmpSummarySourceItems(prov){
  const bag=CMP.bags&&CMP.bags[prov];
  if(bag&&bag.items instanceof Map&&bag.items.size){
    return [...bag.items.values()].map((rec,index)=>({
      kind:String(rec&&rec.kind||""),
      text:String(rec&&((rec.raw!=null?rec.raw:"")||(rec.content&&rec.content.textContent)||"")).trim(),
      index
    }));
  }
  let items=[];
  if(CMP.history&&CMP.history[prov]&&Array.isArray(CMP.history[prov].items)) items=CMP.history[prov].items;
  else if(CMP.brief&&CMP.brief[prov]) items=cmpBriefSnapshot(prov,CMP.brief[prov]).items||[];
  return items.map((item,index)=>({
    kind:String(item&&item.kind||""),
    text:String(item&&((item.detail||item.summary||item.text)||"")).trim(),
    index
  }));
}
function cmpSummaryPair(prov){
  const records=cmpSummarySourceItems(prov);
  let userIndex=-1;
  for(let i=records.length-1;i>=0;i--){
    if(["user_message","user"].includes(records[i].kind)&&records[i].text){ userIndex=i; break; }
  }
  const question=(userIndex>=0&&records[userIndex].text) || (CMP.latestPrompt[prov]&&CMP.latestPrompt[prov].text) || "";
  let answer="";
  const start=userIndex>=0?userIndex+1:0;
  for(let i=records.length-1;i>=start;i--){
    if(records[i].kind==="agent_message"&&records[i].text){ answer=records[i].text; break; }
  }
  return {question,answer,running:!!CMP.running[prov],threadId:CMP.threads[prov]||""};
}
function cmpSummaryModelName(prov){
  const vars=MODEL_VARIANTS[prov]||[];
  const id=(CMP.modelPrefs&&CMP.modelPrefs[prov])||CMP_FORCE_MODEL[prov]||(vars[0]&&vars[0].id)||"";
  const found=vars.find(v=>v.id===id);
  return (found&&found.name)||id;
}
function cmpSummaryCopyPayload(pairs){
  const sections=pairs.filter(x=>x&&x.pair&&x.pair.answer).map(({provider,pair})=>{
    const name=PROV_SHORT[provider.id]||provider.name||provider.id;
    const model=cmpSummaryModelName(provider.id);
    return `【${name}${model?` · ${model}`:""}】\n${pair.answer.trim()}`;
  });
  return {count:sections.length,text:sections.join("\n\n")};
}
async function cmpCopySummaryText(text){
  try{
    const result=await api("/api/clipboard",{method:"POST",body:JSON.stringify({text})});
    if(result&&result.ok) return;
  }catch(e){}
  await window.clipCopy(text);
}
function cmpHydrateSummary(){
  if(_cmpLay!=="summary") return;
  PROVIDERS.filter(p=>CMP.sel.has(p.id)).forEach(p=>{
    const pair=cmpSummaryPair(p.id);
    if(!pair.question&&!pair.answer&&pair.threadId&&!CMP.briefLoading[p.id]&&!CMP.historyLoading[p.id]) cmpLoadBrief(p.id,pair.threadId);
  });
}
function cmpRenderSummary(){
  const host=$("#cmpSummary"); if(!host||_cmpLay!=="summary") return;
  const providers=PROVIDERS.filter(p=>CMP.sel.has(p.id));
  const pairs=providers.map(p=>({provider:p,pair:cmpSummaryPair(p.id)}));
  const questions=pairs.map(x=>x.pair.question).filter(Boolean);
  const normalized=questions.map(q=>q.replace(/\s+/g," ").trim());
  const sharedQuestion=questions.length===pairs.length&&new Set(normalized).size===1 ? questions[0] : "";
  const oldScroll=host.scrollTop;
  host.innerHTML="";
  const shell=document.createElement("div"); shell.className="cmpsum-shell";
  const head=document.createElement("div"); head.className="cmpsum-head";
  const headMain=document.createElement("div"); headMain.className="cmpsum-head-main";
  const title=document.createElement("h2"); title.textContent="最新问答汇总";
  const meta=document.createElement("span"); meta.textContent=`${providers.length} 个模型`;
  headMain.append(title,meta);
  const copyAll=document.createElement("button"); copyAll.type="button"; copyAll.className="cmpsum-copy-all";
  copyAll.innerHTML=`${icon("copy")}<span>复制全部回复</span>`;
  const copyPayload=cmpSummaryCopyPayload(pairs);
  copyAll.disabled=!copyPayload.count;
  copyAll.title=copyPayload.count?`复制 ${copyPayload.count} 个模型的完整回复`:"暂无可复制的回复";
  copyAll.addEventListener("click",async event=>{
    event.preventDefault(); event.stopPropagation();
    const current=cmpSummaryCopyPayload(PROVIDERS.filter(p=>CMP.sel.has(p.id)).map(p=>({provider:p,pair:cmpSummaryPair(p.id)})));
    if(!current.count){ window.cwToast("暂无可复制的模型回复"); return; }
    try{ await cmpCopySummaryText(current.text); window.cwToast(`已复制 ${current.count} 个模型的完整回复`); }
    catch(err){ window.cwToast(err&&err.message||"复制失败"); }
  });
  head.append(headMain,copyAll); shell.appendChild(head);
  if(sharedQuestion){
    const q=document.createElement("section"); q.className="cmpsum-question";
    const label=document.createElement("div"); label.className="cmpsum-label"; label.textContent="你的最新问题";
    const textEl=document.createElement("div"); textEl.className="cmpsum-text"; textEl.textContent=sharedQuestion;
    q.append(label,textEl); shell.appendChild(q);
  }
  if(!providers.length){
    const empty=document.createElement("div"); empty.className="cmpsum-empty"; empty.textContent="请先选择要比较的模型";
    shell.appendChild(empty);
  }else{
    const grid=document.createElement("div"); grid.className="cmpsum-grid";
    pairs.forEach(({provider,pair})=>{
      const card=document.createElement("article"); card.className="cmpsum-card msg assistant"+(pair.running?" running":"");
      card._cwRawMessage=()=>pair.answer;
      card._cwInputSel="#cmpInput";
      const cardHead=document.createElement("header"); cardHead.className="cmpsum-card-head";
      const name=document.createElement("strong"); name.className="cmpsum-card-name"; name.textContent=PROV_SHORT[provider.id]||provider.name;
      const model=document.createElement("span"); model.className="cmpsum-card-model"; model.textContent=cmpSummaryModelName(provider.id);
      const stateEl=document.createElement("span"); stateEl.className="cmpsum-card-state";
      stateEl.textContent=pair.running?"正在回答":(pair.answer?"最新回复":(pair.threadId?"等待回复":"尚未开始"));
      cardHead.append(name,model,stateEl); card.appendChild(cardHead);
      if(!sharedQuestion){
        const q=document.createElement("div"); q.className="cmpsum-card-question";
        const label=document.createElement("div"); label.className="cmpsum-label"; label.textContent="最新问题";
        const textEl=document.createElement("div"); textEl.className="cmpsum-text"; textEl.textContent=pair.question||"暂无问题";
        q.append(label,textEl); card.appendChild(q);
      }
      const answer=document.createElement("div"); answer.className="cmpsum-answer content";
      if(pair.answer){
        const view=cmpEnsureView(provider.id);
        if(view) view.markdownNow(answer,pair.answer,card,"#cmpInput",false);
        else answer.textContent=pair.answer;
      }else answer.textContent=pair.running?"模型正在处理这个问题…":"暂无对应回复";
      card.appendChild(answer); grid.appendChild(card);
    });
    shell.appendChild(grid);
  }
  host.appendChild(shell);
  host.scrollTop=Math.min(oldScroll,Math.max(0,host.scrollHeight-host.clientHeight));
}
let cmpSummaryFrame=0;
function cmpScheduleSummaryRender(){
  if(_cmpLay!=="summary"||cmpSummaryFrame) return;
  cmpSummaryFrame=requestAnimationFrame(()=>{ cmpSummaryFrame=0; cmpRenderSummary(); });
}
function cmpContextStats(rec){
  const turns=(rec&&rec.turns)||[];
  return {
    turns:turns.length,
    maxInput:turns.reduce((m,t)=>Math.max(m, +(t&&t.usage&&t.usage.input_tokens||0)), 0),
  };
}
function cmpContextRisk(prov,rec){
  const lim=CMP_CONTEXT_RISK[prov]; if(!lim) return null;
  const st=cmpContextStats(rec);
  return (st.maxInput>=lim.maxInput || st.turns>=lim.turns) ? st : null;
}
function cmpItemText(rec,kind,maxChars){
  const items=[...((rec&&rec.items)||[])].reverse();
  const it=items.find(x=>x.kind===kind && x.status!=="failed" && String(x.detail||x.summary||"").trim());
  const s=String((it&&((it.detail||it.summary)||""))||"").trim();
  if(s.length<=maxChars) return s;
  const head=Math.floor(maxChars*.28), tail=maxChars-head;
  return s.slice(0,head)+"\n\n...（中间省略,旧线程完整历史已保留）...\n\n"+s.slice(-tail);
}
function cmpBuildLightHandoff(prov,text,rec,stats){
  const th=(rec&&rec.thread)||{};
  const lastUser=cmpItemText(rec,"user_message",CMP_HANDOFF_USER_CHARS);
  const lastAgent=cmpItemText(rec,"agent_message",CMP_HANDOFF_AGENT_CHARS);
  const topic=CMP.topic || th.title || CMP.titleSeed || "多模型对比续跑";
  return [
    "这是 CodeWhale 多模型对比窗口自动创建的轻量续跑消息。",
    `原因:旧的 ${PROV_SHORT[prov]||prov} 子线程上下文已很大(最高约 ${Math.round((stats&&stats.maxInput||0)/1000)}k input tokens),继续追加容易被 Responses API 在采样前拒绝。`,
    "请把下面摘录当作背景,必要时直接读取本机文件/skill 的最新内容核对,不要只依赖摘录。最终默认用简体中文回答。",
    "",
    `【对比会话主题】${topic}`,
    lastUser ? `【旧线程最近用户问题】\n${lastUser}` : "",
    lastAgent ? `【旧线程最近模型回答摘录】\n${lastAgent}` : "",
    `【当前用户问题】\n${text}`,
  ].filter(Boolean).join("\n\n");
}
function cmpTrailingResponseFailures(rec){
  const turns=(rec&&rec.turns)||[];
  let count=0;
  for(let i=turns.length-1;i>=0;i--){
    const turn=turns[i]||{};
    if(String(turn.status||"").toLowerCase()!=="failed") break;
    const msg=String(turn.error||"");
    if(!/Responses API request failed|previous[_ ]response|conversation.*not found/i.test(msg)) break;
    count++;
  }
  return count;
}
function cmpBuildFailureHandoff(prov,text,rec,failures){
  const th=(rec&&rec.thread)||{};
  const lastUser=cmpItemText(rec,"user_message",CMP_HANDOFF_USER_CHARS);
  const lastAgent=cmpItemText(rec,"agent_message",CMP_HANDOFF_AGENT_CHARS);
  const topic=CMP.topic || th.title || CMP.titleSeed || "多模型对比续跑";
  return [
    "这是 CodeWhale 多模型对比窗口自动创建的故障恢复消息。",
    `原因:旧的 ${PROV_SHORT[prov]||prov} 子线程连续 ${failures} 次在 Responses API 采样前失败。旧线程和完整历史仍保留,当前对比会话已切到新的健康子线程。`,
    "请把下面摘录当作背景,必要时直接读取本机文件/skill 的最新内容核对,不要只依赖摘录。最终默认用简体中文回答。",
    "",
    `【对比会话主题】${topic}`,
    lastUser ? `【旧线程最近用户问题】\n${lastUser}` : "",
    lastAgent ? `【旧线程最近成功回答摘录】\n${lastAgent}` : "",
    `【当前用户问题】\n${text}`,
  ].filter(Boolean).join("\n\n");
}
async function cmpCreateProviderThread(prov){
  const t=await (await fetch(url(`/cmp/${prov}/v1/threads`),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();
  if(!t||!t.id) throw new Error((t&&t.error)||"新建轻量线程失败");
  CMP.threads[prov]=t.id; CMP.seq[prov]=0;
  delete CMP.history[prov]; delete CMP.historyFull[prov]; delete CMP.brief[prov];
  markCmp(t.id);
  cmpSessionRecordThread(prov,t.id);
  await api("/api/pin-thread",{method:"POST",body:JSON.stringify({tid:t.id,provider:prov,session_id:CMP.sessionId,topic:CMP.topic,title_seed:CMP.titleSeed})}).catch(()=>{});
  return t.id;
}
async function cmpMaybeRolloverProviderThread(prov,tid,text,rec,addStep){
  const stats=cmpContextRisk(prov,rec);
  const failures=cmpTrailingResponseFailures(rec);
  if(!stats&&!failures) return {tid,text,rolled:false};
  const oldTid=tid;
  const nextText=stats ? cmpBuildLightHandoff(prov,text,rec,stats) : cmpBuildFailureHandoff(prov,text,rec,failures);
  const nextTid=await cmpCreateProviderThread(prov);
  const reason=stats
    ? `上下文过大:旧线程最高约 ${Math.round(stats.maxInput/1000)}k input tokens`
    : `线程故障:连续 ${failures} 次 Responses API 请求失败`;
  addStep(`${reason},已自动切到轻量续跑线程 ${nextTid}`);
  cmpAddMsg(prov,"a sysnote",`· ${esc(PROV_SHORT[prov]||prov)} ${stats?"旧线程上下文过大":"旧线程状态异常"},已自动开轻量续跑。旧线程 ${esc(oldTid)} 保留,当前会话继续接到 ${esc(nextTid)}。`);
  return {tid:nextTid,text:nextText,rolled:true};
}
function cmpApplyMaxVisibility(){
  const box=$("#cmpCols"); if(!box) return;
  box.querySelectorAll(".cmpcol").forEach(c=>{
    const me=!!CMP.maxed && c.dataset.p===CMP.maxed;
    c.classList.toggle("max",me);
    c.classList.toggle("hide",!!CMP.maxed && !me);
  });
}
let _cmpLay = cmpNormalizeLayout(localStorage.getItem("cw_cmplay") || "row");   // 对比栏排列:row 横列 / tab 标签页 / grid 田字格 / stack 纵向 / summary 汇总(兼容旧 col=标签页)
function setCmpLayout(l){   // 横/标签/田/纵/汇总。汇总只呈现各模型最新一轮问答,不销毁原列。
  _cmpLay = cmpNormalizeLayout(l); try{localStorage.setItem("cw_cmplay",_cmpLay);}catch(e){}
  const box=$("#cmpCols"), summary=$("#cmpSummary");
  if(box){
    box.classList.remove("lay-col","lay-grid","lay-tab","lay-stack","lay-summary");
    if(_cmpLay==="tab") box.classList.add("lay-tab");
    else if(_cmpLay==="grid") box.classList.add("lay-grid");
    else if(_cmpLay==="stack") box.classList.add("lay-stack");
    else if(_cmpLay==="summary") box.classList.add("lay-summary");
  }
  if(summary) summary.hidden=_cmpLay!=="summary";
  document.querySelectorAll("#cmpLayout .laybtn").forEach(b=>b.classList.toggle("on", b.dataset.l===_cmpLay));
  if(_cmpLay==="summary"){
    if(CMP.maxed){ CMP.maxed=null; cmpApplyMaxVisibility(); }
    renderCmpTabs(); cmpRenderSummary(); cmpHydrateSummary();
    return;
  }
  if(_cmpLay==="tab"){
    if(!CMP.maxed || !CMP.sel.has(CMP.maxed)) CMP.maxed=cmpFirstSelectedProvider();
    cmpApplyMaxVisibility();
    renderCmpTabs();
    return;
  }
  if(CMP.maxed){ CMP.maxed=null; cmpApplyMaxVisibility(); }
  renderCmpTabs();   // 横/田退出放大或标签页 → 隐藏标签条、并排全部
}
async function cmpSetModel(prov, model){   // 选了某栏的模型变体:存 pref(单窗口也共用)+ 该栏开新 thread(模型 thread-locked)
  CMP.modelPrefs=CMP.modelPrefs||{}; CMP.modelPrefs[prov]=model;
  try{ await api("/api/model-pref",{method:"POST",body:JSON.stringify({provider:prov,model})}); }catch(e){}
  delete CMP.threads[prov]; delete CMP.history[prov]; delete CMP.historyLoading[prov]; delete CMP.historyFull[prov]; delete CMP.brief[prov]; delete CMP.briefLoading[prov]; delete CMP.latestPrompt[prov]; CMP.seq[prov]=0;
  cmpDropView(prov,{clear:true});
  cmpScheduleSummaryRender();
  cwToast((PROV_SHORT[prov]||prov)+" 模型 → "+model+"(下一条起生效)");
}
async function cmpSetEffort(prov, effort){   // 推理 effort:存 pref(走 env,后端重启)→ 下一条起生效。effort 不是 thread-locked(只是每轮/env 参数),所以**不清 thread、不清内容**(旧对话留着,继续追问即用新 effort)
  CMP.modelEffort=CMP.modelEffort||{}; CMP.modelEffort[prov]=effort;
  try{ await api("/api/model-pref",{method:"POST",body:JSON.stringify({provider:prov,effort})}); }catch(e){}
  cwToast((PROV_SHORT[prov]||prov)+" 推理 → "+(effort||"默认")+"(下一条起生效,历史保留)");
}
function renderCmpToggles(){ const a=$("#cmpAutoTgl"), s=$("#cmpShellTgl"); if(a) a.classList.toggle("on",CMP.autoApprove); if(s) s.classList.toggle("on",CMP.allowShell); }
async function cmpApplyFlags(){   // 把当前开关同步到所有已建对比会话
  await Promise.all(Object.entries(CMP.threads).map(([prov,tid])=>fetch(url(`/cmp/${prov}/v1/threads/${tid}`),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({auto_approve:CMP.autoApprove, allow_shell:CMP.allowShell})}).catch(()=>{})));
}
function cmpToggleAuto(){ CMP.autoApprove=!CMP.autoApprove; renderCmpToggles(); cmpApplyFlags(); }
function cmpToggleShell(){ CMP.allowShell=!CMP.allowShell; if(CMP.allowShell) CMP.autoApprove=true; renderCmpToggles(); cmpApplyFlags(); }   // 对比无逐栏审批 UI:开 Shell 自动连带开自动批准
function renderCmpChips(){
  const box=$("#cmpChips");
  // 顶部 chips 恒为"加入/移出对比"(= 加/去一个参与模型)。放大后的"切换看哪个模型"交给内容上方的标签条。
  box.classList.remove("tabmode");
  box.innerHTML=PROVIDERS.map(p=>{
    const on=CMP.sel.has(p.id), nokey=!p.oauth && !CMP.keyed[p.id];
    const tip=nokey?'未配置 key':(on?'点击移出对比':'点击加入对比');
    return `<span class="cmpchip ${on?'on':''} ${nokey?'nokey':''}" data-p="${p.id}" title="${tip}">${PROV_SHORT[p.id]||p.name}${nokey?' ⚠':''}</span>`;
  }).join("");
  box.querySelectorAll(".cmpchip").forEach(el=>el.onclick=()=>{
    const id=el.dataset.p;
    const p=PROVIDERS.find(x=>x.id===id)||{};
    const nokey=!p.oauth && !CMP.keyed[id];
    if(nokey && !CMP.sel.has(id)){
      if(p.cmpKeyOnly) openModelSwitch(id);
      else alert((PROV_SHORT[id]||id)+" 还没配置 key");
      return;
    }
    if(CMP.sel.has(id)){ if(CMP.sel.size>1) CMP.sel.delete(id); } else CMP.sel.add(id);
    renderCmpChips(); renderCmpCols();
  });
}
function cmpSwitchTab(id){   // 标签页/放大态下把可见栏切到 id,其余隐藏
  CMP.maxed=id;
  cmpApplyMaxVisibility();
  cmpEnsureHistory(id);
  renderCmpChips(); renderCmpTabs();
  const b=$("#cmpb-"+CSS.escape(id)); if(b) b.scrollTop=b.scrollHeight;   // 切过去滚到最新
}
function renderCmpTabs(){   // 放大态或标签页布局时,内容上方显示一排浏览器式标签=全部参与模型,点标签切换看哪个
  const bar=$("#cmpTabs"); if(!bar) return;
  if(_cmpLay==="tab" && (!CMP.maxed || !CMP.sel.has(CMP.maxed))){ CMP.maxed=cmpFirstSelectedProvider(); cmpApplyMaxVisibility(); }
  if(!CMP.maxed){ bar.hidden=true; bar.innerHTML=""; return; }   // 未放大/非标签页(并排看全部)→ 不显示标签条
  bar.hidden=false; bar.innerHTML="";
  PROVIDERS.filter(p=>CMP.sel.has(p.id)).forEach(p=>{
    const t=document.createElement("div");
    const name=PROV_SHORT[p.id]||p.name;
    const active=CMP.maxed===p.id;
    t.className="cmptab"+(CMP.maxed===p.id?" active":"")+(CMP.running[p.id]?" running":"");
    t.title=active ? (_cmpLay==="tab" ? "当前:"+name+"(点这里加载完整历史)" : "当前:"+name+"(点这里退回并排)") : "切到 "+name;
    t.innerHTML=`<span class="cmptab-dot"></span>${esc(name)}`;
    t.onclick=()=>{ if(active){ if(_cmpLay==="tab") cmpEnsureHistory(p.id); else toggleMax(p.id); } else cmpSwitchTab(p.id); };   // 标签页里点当前标签=加载完整历史;放大态点当前标签=退回并排
    bar.appendChild(t);
  });
}
function renderCmpCols(){   // diff:保留已有栏内容,只增删变化的
  const box=$("#cmpCols");
  [...box.querySelectorAll(".cmpcol")].forEach(c=>{ c.hidden=!CMP.sel.has(c.dataset.p); });   // chip 关掉只隐藏,不销毁:再打开仍保留本 session 历史/流式状态
  PROVIDERS.filter(p=>CMP.sel.has(p.id)).forEach(p=>{
    const existing=box.querySelector('.cmpcol[data-p="'+p.id+'"]');
    if(existing){
      existing.hidden=false;
      cmpEnsureView(p.id);
      const body=$("#cmpb-"+CSS.escape(p.id));
      if(!CMP.restoring && CMP.threads[p.id] && body && !body.children.length && !CMP.running[p.id] && !CMP.dispatching[p.id]) cmpLoadBrief(p.id,CMP.threads[p.id]);   // 旧版本曾 remove 掉的列:先回填轻量摘要,点进再拉全量
      return;
    }
    const d=document.createElement("div"); d.className="cmpcol"; d.dataset.p=p.id;
    const nm=PROV_SHORT[p.id]||p.name;
    const vars=MODEL_VARIANTS[p.id]||[];
    const cur=(CMP.modelPrefs&&CMP.modelPrefs[p.id])||CMP_FORCE_MODEL[p.id]||(vars[0]&&vars[0].id)||"auto";
    // 模型选择:有预设变体用下拉;freeModel 且当前模型不在预设里时退回输入框
    const curKnown=vars.some(v=>v.id===cur);
    let modelEl = vars.length && (!p.freeModel || curKnown)
      ? `<select class="cmpmodel cmpmodelsel" data-p="${p.id}" title="选这栏的模型变体(下条起生效)">${vars.map(v=>`<option value="${esc(v.id)}" ${v.id===cur?"selected":""}>${esc(v.name)}</option>`).join("")}</select>`
      : p.freeModel
      ? `<input class="cmpmodel cmpmodelinput" data-p="${p.id}" value="${esc(cur)}" title="手填这栏模型 ID,回车或失焦后下条起生效">`
      : `<span class="cmpmodel" title="此栏实际调用的模型">${esc(cur)}</span>`;
    if(EFFORT_PROVIDERS.includes(p.id)){   // Claude / GPT:推理 effort 下拉(下条起生效)
      const ce=(CMP.modelEffort&&CMP.modelEffort[p.id])||"";
      modelEl += `<select class="cmpmodel cmpeffortsel" data-p="${p.id}" title="推理 effort(下条起生效,历史保留)">${effortOptsFor(p.id).map(o=>`<option value="${o.v}" ${o.v===ce?"selected":""}>${o.n}</option>`).join("")}</select>`;
    }
    d.innerHTML=`<div class="cmpcol-h" data-p="${p.id}"><span class="cnm">${nm}</span>`+
      modelEl+
      `<span class="st" id="cmpst-${p.id}"></span>`+
      `<button class="cmpstop" id="cmpstop-${p.id}" title="暂停这个模型当前的回答" hidden>■ 停止</button>`+
      `<button class="cmpmax" id="cmpmax-${p.id}" title="放大这一栏 —— 放大后顶部模型名变书签页,点名字即可切看别的模型;再点一下退回并排">⤢</button></div>`+
      `<div class="cmprunbar" id="cmprun-${p.id}" hidden><span class="pulse"></span><span class="txt">启动中</span><button class="cmpstopbar" title="停止这一栏当前回答">停止</button></div>`+
      `<div class="cmpcol-b" id="cmpb-${p.id}"></div>`+
      `<div class="cmpcatt" id="cmpcatt-${p.id}" hidden></div>`+
      `<div class="cmpcol-f"><button class="cmpcolattach" id="cmpcattbtn-${p.id}" title="给 ${nm} 加附件（只随这一栏的追问发出）">📎</button><button class="cmpcolvoice voicebtn" id="cmpvoice-${p.id}" type="button" title="语音追问 ${nm}（点击开始,再次点击结束）">${icon("mic")}</button><input type="file" class="cmpcolfile" id="cmpcfile-${p.id}" multiple hidden><textarea class="cmpcolin" id="cmpin-${p.id}" rows="1" wrap="soft" placeholder="只追问 ${nm}…（Enter 发送）"></textarea><button class="cmpcolsend" id="cmpcsend-${p.id}" title="只发给 ${nm}（单独继续这个对话）">→</button></div>`;
	    box.appendChild(d);
	    cmpEnsureView(p.id);
    const sel=d.querySelector(".cmpmodelsel"); if(sel){ sel.addEventListener("click",e=>e.stopPropagation()); sel.addEventListener("change",e=>{ e.stopPropagation(); cmpSetModel(p.id, e.target.value); }); }
    const mi=d.querySelector(".cmpmodelinput"); if(mi){ const apply=()=>{ const v=mi.value.trim(); if(v) cmpSetModel(p.id,v); else mi.value=(CMP.modelPrefs&&CMP.modelPrefs[p.id])||CMP_FORCE_MODEL[p.id]||""; }; mi.addEventListener("click",e=>e.stopPropagation()); mi.addEventListener("blur",apply); mi.addEventListener("keydown",e=>{ if(e.key==="Enter"){ e.preventDefault(); mi.blur(); } }); }
    const esl=d.querySelector(".cmpeffortsel"); if(esl){ esl.addEventListener("click",e=>e.stopPropagation()); esl.addEventListener("change",e=>{ e.stopPropagation(); cmpSetEffort(p.id, e.target.value); }); }
    d.querySelector(".cmpcol-h").onclick=(e)=>{ if(e.target.closest(".cmpstop")||e.target.closest(".cmpmax")||e.target.closest(".cmpmodelsel")||e.target.closest(".cmpmodelinput")||e.target.closest(".cmpeffortsel")) return; toggleMax(p.id); };   // 点头部=最大化;点「停止」/「放大」/模型控件 不触发
    d.querySelector(".cmpcol-b").onclick=(e)=>{ if(e.target.closest("button")) return; if(e.currentTarget.dataset.mode==="brief") cmpEnsureHistory(p.id); };   // 摘要态:点进该栏才拉完整历史
    d.querySelector(".cmpmax").onclick=(e)=>{ e.stopPropagation(); toggleMax(p.id); };   // 显式「放大」按钮:放大后顶部模型名变书签页 tab
    d.querySelector(".cmpstop").onclick=(e)=>{ e.stopPropagation(); cmpStop(p.id); };
    d.querySelector(".cmpstopbar").onclick=(e)=>{ e.stopPropagation(); cmpStop(p.id); };
    const ci=d.querySelector(".cmpcolin"), cs=d.querySelector(".cmpcolsend");
    cs.onclick=()=>cmpRunOne(p.id);
    ci.addEventListener("keydown",e=>{ if(e.key==="Enter"&&!e.shiftKey){ if(e.isComposing||e.keyCode===229)return; e.preventDefault(); cmpRunOne(p.id);} });
    ci.addEventListener("input",()=>{ ci.style.height="auto"; ci.style.height=Math.min(ci.scrollHeight,90)+"px"; });
    const catBtn=d.querySelector(".cmpcolattach"), catFile=d.querySelector(".cmpcolfile");   // 每栏独立附件:📎 → 选文件;贴文件也进该栏
    if(catBtn&&catFile){ catBtn.onclick=()=>catFile.click(); catFile.onchange=e=>{ if(e.target.files.length) cmpColUpload(p.id,[...e.target.files]); e.target.value=""; }; }
    ci.addEventListener("paste",e=>{ const fs=[...((e.clipboardData&&e.clipboardData.files)||[])]; if(fs.length){ e.preventDefault(); cmpColUpload(p.id,fs); } });
    cmpColRenderAttach(p.id);   // 该栏被重建(如移除后再加回)时,恢复已存在的附件
    if(!CMP.restoring && CMP.threads[p.id] && !CMP.running[p.id] && !CMP.dispatching[p.id]) cmpLoadBrief(p.id,CMP.threads[p.id]);   // session 里已有 thread 的 provider 重新加入 → 先轻量摘要
  });
  if(_cmpLay==="tab"){
    if(!CMP.maxed || !CMP.sel.has(CMP.maxed)) CMP.maxed=cmpFirstSelectedProvider();
    cmpApplyMaxVisibility();
    renderCmpTabs();
  }else if(CMP.maxed){   // 放大态下增删模型 → 保证放大的那栏仍有效(被删则切到第一个)+ 刷新标签条
    if(!CMP.sel.has(CMP.maxed)){ const a=cmpFirstSelectedProvider(); if(a){ cmpSwitchTab(a); } else { CMP.maxed=null; cmpApplyMaxVisibility(); } }
    else { cmpApplyMaxVisibility(); cmpEnsureHistory(CMP.maxed); }   // 新加的栏也隐藏(只留放大那栏)
    renderCmpTabs();
  }
  if(_cmpLay==="summary"){ cmpRenderSummary(); cmpHydrateSummary(); }
}
function cmpSetProgress(prov, text){   // 长任务可见进度:阶段 / 步数 / 秒表 / 最近工具或等待状态
  const bar=$("#cmprun-"+CSS.escape(prov));
  if(!bar) return;
  bar.hidden=false;
  const t=bar.querySelector(".txt"); if(t) t.textContent=text||"运行中";
}
function cmpClearProgress(prov){
  const bar=$("#cmprun-"+CSS.escape(prov));
  if(bar){ bar.hidden=true; const t=bar.querySelector(".txt"); if(t) t.textContent=""; }
}
// 单栏运行态:跑时显示「停止」+ 禁该栏追问框,完成后复原
function cmpSetRunning(prov,on){
  CMP.running[prov]=on;
  const stop=$("#cmpstop-"+CSS.escape(prov)); if(stop) stop.hidden=!on;
  const cs=$("#cmpcsend-"+CSS.escape(prov)); if(cs) cs.disabled=on;
  if(on) cmpSetProgress(prov,"启动中"); else cmpClearProgress(prov);
  cmpSyncSendUI();   // 刷新发送按钮状态(列停了就从「引导」变回「发送」)
  if(CMP.maxed || _cmpLay==="tab") renderCmpTabs();   // 放大/标签页:标签上的运行小圆点跟随
  cmpScheduleSummaryRender();
}
async function cmpStop(prov){   // 暂停单个对话:中断该栏当前 turn(中断后 SSE 会发 completed/interrupted → finish 收尾)
  const tid=CMP.threads[prov]; let turn=CMP.turn[prov];
  const st=$("#cmpst-"+CSS.escape(prov));
  CMP.cancelled[prov]=true;
  if(!turn && tid){ try{ const rec=await (await fetch(url(`/cmp/${prov}/v1/threads/${tid}`))).json(); const turns=rec.turns||[]; turn=(rec.thread||{}).latest_turn_id||(turns[turns.length-1]||{}).id; }catch(e){} }
  if(!tid||!turn){ if(st) st.textContent="⏸"; cmpSetProgress(prov,"正在停止"); return; }
  cmpSetProgress(prov,"正在停止");
  try{ await fetch(url(`/cmp/${prov}/v1/threads/${tid}/turns/${turn}/interrupt`),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}); }catch(e){}
  if(st) st.textContent="⏸ 已暂停";
}
async function cmpStopAll(){   // 全局取消:中断正在跑的列,同时清掉所有未发送队列
  const active=[...CMP.sel].filter(p=>CMP.running[p]||CMP.dispatching[p]);
  const queued=cmpQueuedGroups().length;
  Object.keys(CMP.provQ||{}).forEach(p=>{ CMP.provQ[p]=[]; });
  cmpSyncSendUI();
  if(!active.length){ if(queued) cwToast("已清空排队"); return; }
  await Promise.allSettled(active.map(p=>cmpStop(p)));
}
async function cmpRunOne(prov){   // 只追问这一个模型(单独继续该栏对话)
  const inp=$("#cmpin-"+CSS.escape(prov)); if(!inp) return;
  const raw=(inp.value||"").trim();
  const hasAtt=!!(CMP.colAttach&&CMP.colAttach[prov]&&CMP.colAttach[prov].length);
  if((!raw && !hasAtt) || CMP.running[prov] || CMP.dispatching[prov]) return;   // 无字且无附件,或该栏在跑/派发中→拦住
  CMP.dispatching[prov]=true;   // 同步占位锁:在 await 之前就置上,关闭"重复 Enter"窗口
  const prepared=cmpColWithAttach(prov, raw);   // 立即清空该栏附件条，上传落盘后自动继续
  inp.value=""; inp.style.height="auto";
  try{
    let text;
    try{ text=await prepared; }
    catch(e){
      cmpRestoreDraft(inp,raw); sysnote("附件准备失败，已恢复该栏输入: "+String(e&&e.message||e)); return;
    }
    if(!text) return;
    const item=cmpMakeItem(text, raw || "附件追问");
    cmpEnsureSession(item,[prov]);             // 单栏追问也属于一个对比会话,否则侧栏会散成多个 thread
    if(CMP.threads[prov]) cmpSessionRecordThread(prov,CMP.threads[prov]);
    cmpAddMsg(prov,"u",`<span class="cmpu-text">${esc(item.disp)}</span>`,{key:item.id,text:item.disp,time:item.time,provider:prov,optimistic:prov!=="qwen"});
    let ensured={}; try{ ensured=await api("/api/compare/ensure",{method:"POST",body:JSON.stringify({providers:[prov]})}); }catch(e){}
    await cmpRun(prov,text,ensured[prov]);
  } finally { CMP.dispatching[prov]=false; cmpMaybeFlush(); }   // 该栏结束→若有排队的全栏发送在等,顺手 flush
}
function cmpClearAllCols(){   // 清空对比视图所有列(线程/消息/状态/队列/附件)+ 会话边界。开新一轮/重启后端/删掉正打开的会话 共用
  CMP.sessionId=null;
  timelineReset("compare");
  CMP.topic=""; CMP.titleSeed="";
  CMP.threads={}; CMP.seq={}; CMP.turn={}; CMP.running={}; CMP.busy=false; CMP.sendQ=[]; CMP.provQ={}; CMP.dispatching={}; CMP.cancelled={}; CMP.history={}; CMP.historyLoading={}; CMP.historyFull={}; CMP.brief={}; CMP.briefLoading={}; CMP.runState={}; CMP.latestPrompt={}; clearAttachmentList(CMP.attachments); Object.keys(CMP.colAttach||{}).forEach(pv=>{clearAttachmentList(CMP.colAttach[pv]); cmpColRenderAttach(pv);}); cmpSyncSendUI(); cmpRenderAttach(); cmpScheduleSummaryRender();
  [...document.querySelectorAll("#cmpCols .cmpcol")].forEach(c=>{ const p=c.dataset.p; cmpResetView(p,{clear:true}); const s=$("#cmpst-"+CSS.escape(p)); if(s) s.textContent=""; const stop=$("#cmpstop-"+CSS.escape(p)); if(stop) stop.hidden=true; cmpClearProgress(p); const cs=$("#cmpcsend-"+CSS.escape(p)); if(cs) cs.disabled=false; c.hidden=!CMP.sel.has(p); });
}
async function cmpResetBackends(){   // 重启所有对比后端(残留后端连不上各自端点→回退 DeepSeek 时用):杀掉旧后端 + 清历史,下次发送用最新配置/key 冷启
  if(!(await cwConfirm("重启所有对比后端?会清空各栏当前历史,并用最新配置 / key 重新连接各模型(几秒)。\n用于:某个模型栏回答的不是它本人(回退成了 DeepSeek)。"))) return;
  const btn=$("#cmpResetBtn"); if(btn){ btn.disabled=true; btn.textContent="↻ 重启中…"; }
  try{ await api("/api/compare/reset",{method:"POST",body:"{}"}); }catch(e){}
  cmpClearAllCols();
  if(btn){ btn.disabled=false; btn.textContent="↻ 重启后端"; }
  const i=$("#cmpInput"); if(i) i.focus();
}
async function cmpNewChat(){   // 新对话:清空所有栏历史 + 重建会话(学单一窗口的「新建对话」)
  if(Object.keys(CMP.threads).length && !(await cwConfirm("在这个窗口开新一轮对比?\n当前这轮已自动存进侧栏「多模型对比」会话,随时点回、不会丢。"))) return;
  cmpClearAllCols();   // 开新对比会话 → 下次发送建新主题(旧会话已存,侧栏可点回)
  const i=$("#cmpInput"); if(i) i.focus();
}
function toggleMax(p){
  if(_cmpLay==="tab"){ cmpSwitchTab(p); return; }
  const cols=$("#cmpCols").querySelectorAll(".cmpcol");
  if(CMP.maxed===p){ CMP.maxed=null; cols.forEach(c=>c.classList.remove("max","hide")); }
  else { CMP.maxed=p; cols.forEach(c=>{ const me=c.dataset.p===p; c.classList.toggle("max",me); c.classList.toggle("hide",!me); }); cmpEnsureHistory(p); }
  renderCmpTabs();   // 放大 → 显示标签条(全部模型);退出 → 隐藏标签条、恢复并排
}
function cmpAddMsg(p,cls,html,opts={}){
  if(!cmpViewHost(p)) return null;
  const parts=String(cls||"").split(/\s+/).filter(Boolean);
  const text=opts.text!=null ? opts.text : cmpHtmlText(html);
  if(parts.includes("u")){
    const el=cmpAddViewUser(p,text,opts);
    if(el&&parts.includes("steer")) el.classList.add("steer");
    return el;
  }
  if(parts.includes("err")) return cmpAddViewError(p,text.replace(/^✗\s*/,""));
  if(parts.includes("a")&&!parts.includes("sysnote")) return cmpAddViewAssistant(p,text);
  return cmpAppendSysNote(p,html,parts.includes("sysnote")?"histnote":"");
}
function cmpProvBusy(p){ return !!(CMP.running[p]||CMP.dispatching[p]); }
function cmpAnyBusy(){ return Object.values(CMP.running).some(Boolean) || Object.values(CMP.dispatching).some(Boolean); }
function cmpQueueFor(prov,item){ (CMP.provQ||(CMP.provQ={}))[prov]=(CMP.provQ[prov]||[]); CMP.provQ[prov].push(item); }
function cmpQueuedGroups(){   // 把 provider 维度队列聚回「用户发的每一条」,用于顶部队列条展示/取消
  const by=new Map();
  Object.entries(CMP.provQ||{}).forEach(([prov,q])=>(q||[]).forEach(item=>{
    if(!by.has(item.id)) by.set(item.id,{item,provs:[]});
    by.get(item.id).provs.push(prov);
  }));
  return [...by.values()];
}
function cmpCancelQueued(id){ Object.keys(CMP.provQ||{}).forEach(p=>{ CMP.provQ[p]=(CMP.provQ[p]||[]).filter(it=>it.id!==id); }); cmpSyncSendUI(); }
function cmpValidProviders(provs){
  return provs.filter(p=>{
    const meta=PROVIDERS.find(x=>x.id===p)||{};
    if(!meta.oauth && !CMP.keyed[p]){
      cmpAddMsg(p,"a err",`✗ ${(PROV_SHORT[p]||p)} 还没配置 key。点击左下「模型」→「${meta.name||p}」填写 API key。`);
      const s=$("#cmpst-"+CSS.escape(p)); if(s) s.textContent="未配置";
      return false;
    }
    return true;
  });
}
function cmpCurrentSession(){
  return CMP.sessionId ? state.cmpSessions.find(x=>x.id===CMP.sessionId) : null;
}
function cmpSetSessionTopic(topic, opts={}){
  const s=cmpCurrentSession(); if(!s||!topic) return;
  s.topic=topic; s.topic_ts=Date.now();
  if(opts.auto) s.topic_auto=true;
  CMP.topic=topic;
  saveCmpSessions(); state._sig=null; renderThreads();
}
function cmpPatchThreadTitle(prov, tid, topic){
  if(!prov||!tid||!topic) return;
  fetch(url(`/cmp/${prov}/v1/threads/${tid}`),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:topic})}).catch(()=>{});
  const th=state.threads.find(x=>x.id===tid); if(th){ th.title=topic; state._sig=null; }
}
function cmpSyncSessionThreadTitles(topic){
  const s=cmpCurrentSession(); if(!s||!topic) return;
  Object.entries(s.threads||{}).forEach(([prov,tid])=>cmpPatchThreadTitle(prov,tid,topic));
  renderThreads();
}
function cmpScheduleSmartTitle(item){
  const s=cmpCurrentSession(); if(!s||s.topic_auto||cmpTitleTimers.has(s.id)) return;
  const seed=(item&&((item.disp||item.sent)||"")) || CMP.titleSeed || s.topic || "";
  const expected=s.topic||"";
  const timer=setTimeout(async()=>{
    cmpTitleTimers.delete(s.id);
    const cur=state.cmpSessions.find(x=>x.id===s.id);
    if(!cur || (expected && cur.topic!==expected)) return;   // 手动重命名/别的窗口改名 → 不覆盖
    try{
      const r=await api("/api/cmp-title/auto",{method:"POST",body:JSON.stringify({session_id:s.id,prompt:seed,expected_topic:expected})});
      if(!r||!r.ok||!r.title) return;
      const latest=state.cmpSessions.find(x=>x.id===s.id);
      if(!latest || (expected && latest.topic!==expected)) return;
      cmpSetSessionTopic(r.title,{auto:true});
      cmpSyncSessionThreadTitles(r.title);
      loadThreads();
    }catch(e){ console.warn("compare smart title failed", e); }
  }, CMP_TITLE_DELAY_MS);
  cmpTitleTimers.set(s.id,timer);
}
function cmpEnsureSession(item,provs){
  if(CMP.sessionId) return;
  CMP.sessionId="cmps_"+Math.random().toString(36).slice(2,9)+state.cmpSessions.length;
  const topic=roughThreadTitle(item.disp||item.sent||"", "多模型对比");
  CMP.topic=topic; CMP.titleSeed=(item.disp||item.sent||topic);
  state.cmpSessions.unshift({id:CMP.sessionId, topic, title_seed:CMP.titleSeed, ts:Date.now(), providers:provs.slice(), threads:{}});
  try{ localStorage.setItem("cw_cmp_sessions",JSON.stringify(state.cmpSessions.slice(0,500))); }catch(e){}
  state._sig=null; renderThreads();
  cmpScheduleSmartTitle(item);
}
let _cmpItemSeq=0;
function cmpMakeItem(sent,disp){ return {id:"cmpq_"+Date.now()+"_"+(++_cmpItemSeq), sent, disp, time:new Date().toISOString()}; }
// 同步发送区 UI:任一栏在跑时按钮显「发送中…/排队 N」,但按钮不禁用(点/Enter 都能继续排队到忙的列)
function cmpSyncSendUI(){
  const btn=$("#cmpSendBtn"), ta=$("#cmpInput"), groups=cmpQueuedGroups(), q=groups.length, active=cmpAnyBusy();
  const steer=[...CMP.sel].some(p=>CMP.running[p]&&CMP.turn[p]);   // 有正在跑(且有活动 turn)的列→发送即引导
  if(btn){
    btn.textContent=steer?(q?("⤵ 引导·排队"+q):"⤵ 引导"):(active?(q?("发送中·排队"+q):"发送中…"):(q?("排队"+q):"发送"));
    btn.title=steer?"正在跑的列:这句话实时插进当前回合(引导);空闲列:正常发送。带附件时改为排队":"";
  }
  if(ta) ta.placeholder=steer?"输入直接引导正在跑的模型,实时改变输出方向…（Enter 引导 · Shift+Enter 换行）":(active?"完成的模型会先发;忙的模型自动排队…":"输入一个问题,同时发给所有选中的模型…（Enter 发送 · Shift+Enter 换行）");
  const qb=$("#cmpQueue");   // 队列条:把排队中的问题原文显示出来,每条可单独 ✕ 撤销
  if(qb){
    if(!q){ qb.hidden=true; qb.innerHTML=""; }
    else{
      qb.hidden=false;
      qb.innerHTML=`<span class="cmpqlbl">${icon("clock")} 分列排队（空闲模型会先发）：</span>`+
        groups.map(g=>{ const d=g.item.disp||""; const names=g.provs.map(p=>PROV_SHORT[p]||p).join("/"); return `<span class="cmpqchip" title="${esc(d)} · 等待 ${esc(names)}"><span>${esc(d)} · ${esc(names)}</span><b data-id="${esc(g.item.id)}" title="取消这条未发送部分">✕</b></span>`; }).join("");
      qb.querySelectorAll(".cmpqchip b").forEach(x=>x.onclick=()=>cmpCancelQueued(x.dataset.id));
    }
  }
  const stopAll=$("#cmpStopAllBtn");
  if(stopAll){ stopAll.hidden=!(active||q); stopAll.textContent=active?"停止全部":"清排队"; }
}
// 发送 = 智能分流:正在跑的列 → steer 注入当前 turn 实时改输出(全模型支持,实测 deepseek/gpt 都被引导停);
// 空闲列 → 正常发新一轮;还在启动没 turn 的列 → 排队。带附件时 steer 走不了(steer 只带文本),整条回退排队语义。
async function cmpSend(){
  const ta=$("#cmpInput"); const raw=(ta.value||"").trim();
  if(!raw && !CMP.attachments.length) return;   // 有字或有附件就能发
  ta.value=""; ta.style.height="auto";
  const atts=takeAttachmentBundle(CMP.attachments,cmpRenderAttach);   // 立即释放输入区，附件只在本次发送包里等待落盘
  const run=async()=>{
    let sent;
    try{ sent=await attachmentPrompt(raw,atts); }
    catch(e){
      restoreAttachmentBundle(CMP.attachments,atts,cmpRenderAttach); cmpRestoreDraft(ta,raw);
      cwToast("附件准备失败，已恢复输入"); return;
    }
    if(!sent) return;
    const steerable=(atts.length||!raw)?[]:[...CMP.sel].filter(p=>CMP.running[p] && CMP.threads[p] && CMP.turn[p]);   // 正在跑且有活动 turn 的列
    if(steerable.length){
      const steerKey="cmpsteer_"+Date.now()+"_"+timelineHash(raw);
      const steerTime=new Date().toISOString();
      steerable.forEach(p=>cmpAddMsg(p,"u steer",`<span class="cmpu-text">⤵ 引导:${esc(raw)}</span>`,{key:steerKey,text:"引导:"+raw,time:steerTime,provider:p,meta:"引导"}));   // 显示引导气泡
      Promise.allSettled(steerable.map(p=>
        fetch(url(`/cmp/${p}/v1/threads/${CMP.threads[p]}/turns/${CMP.turn[p]}/steer`),
          {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:raw})})
          .then(r=>{ if(!r.ok) return r.text().then(t=>{throw new Error(t.slice(0,80))}); })
          .catch(e=>cmpAddMsg(p,"a err","✗ 引导失败:"+esc(String(e&&e.message||e))))
      ));
    }
    // sent=发给模型(附件路径 + 任务内识别指令);disp=气泡显示(原文 + 附件名)
    const disp=raw+(atts.length?("  📎 "+atts.map(a=>a.name).join(", ")):"");
    const item=cmpMakeItem(sent,disp);
    const provs=cmpValidProviders([...CMP.sel]).filter(p=>!steerable.includes(p));   // 已被引导的列不再收同内容新消息
    if(!provs.length){ cmpSyncSendUI(); return; }
    cmpEnsureSession(item,provs);
    const ready=[], queued=[];
    provs.forEach(p=>cmpProvBusy(p)?queued.push(p):ready.push(p));
    queued.forEach(p=>cmpQueueFor(p,item));
    if(ready.length) cmpDispatch(item,ready);
    cmpSyncSendUI();
  };
  // 多次快速发送也按输入顺序准备，避免“后一条无附件”越过前一条的本机 OCR。
  const previous=CMP.prepareChain||Promise.resolve();
  const current=previous.catch(()=>{}).then(run); CMP.prepareChain=current;
  try{ return await current; }
  finally{ if(CMP.prepareChain===current) CMP.prepareChain=null; }
}
async function cmpDispatch(item,provs){   // 把同一条用户问题发给指定的一组空闲 provider;忙的 provider 会由各自队列稍后补发
  provs=cmpValidProviders((provs||[]).filter(p=>CMP.sel.has(p)&&!cmpProvBusy(p)));
  if(!provs.length){ cmpSyncSendUI(); return; }
  cmpEnsureSession(item,provs);
  provs.forEach(p=>{ if(CMP.threads[p]) cmpSessionRecordThread(p,CMP.threads[p]); });
  provs.forEach(p=>{ CMP.dispatching[p]=true; cmpAddMsg(p,"u",`<span class="cmpu-text">${esc(item.disp)}</span>`,{key:item.id,text:item.disp,time:item.time,provider:p,optimistic:p!=="qwen"}); const s=$("#cmpst-"+CSS.escape(p)); if(s) s.textContent="启动…"; });   // 立即显示用户气泡 + 启动中,不等后端
  cmpSyncSendUI();
  try{
    let ensured={}; try{ ensured=await api("/api/compare/ensure",{method:"POST",body:JSON.stringify({providers:provs})}); }catch(e){}
    await Promise.allSettled(provs.map(p=>cmpRun(p,item.sent,ensured[p]).catch(e=>cmpAddMsg(p,"a err","✗ "+esc(String(e&&e.message||e)))).finally(()=>{ CMP.dispatching[p]=false; cmpRunNextFor(p); })));
  } finally { cmpSyncSendUI(); }
}
// ── 对比附件(主输入框:文件发给所有栏)── 上传到 /api/upload 拿文件系统路径,各 provider 后端都能 read_file 读
async function cmpUploadFiles(files){
  await optimisticUpload(files,{scope:CMP.sessionId?("cmp_"+CMP.sessionId):"cmp",list:CMP.attachments,render:cmpRenderAttach,skipNotify:cwToast});
}
function cmpRenderAttach(){   // 附件栏(输入框上方):chip + ✕ 移除
  const bar=$("#cmpAttachBar"); if(!bar) return;
  bar.innerHTML=""; bar.hidden=!CMP.attachments.length;
  CMP.attachments.forEach((a,i)=>{
    bar.appendChild(attachmentChip(a,()=>{ revokeAttachmentPreview(a); CMP.attachments.splice(i,1); cmpRenderAttach(); }));
  });
}
function cmpRunNextFor(prov){
  if(!CMP.sel.has(prov)){ if(CMP.provQ&&CMP.provQ[prov]) CMP.provQ[prov]=[]; cmpSyncSendUI(); return; }
  if(cmpProvBusy(prov)){ cmpSyncSendUI(); return; }
  const q=(CMP.provQ&&CMP.provQ[prov])||[];
  const next=q.shift();
  if(next) cmpDispatch(next,[prov]);
  else cmpSyncSendUI();
}
function cmpMaybeFlush(){ [...CMP.sel].forEach(cmpRunNextFor); cmpSyncSendUI(); }
async function cmpRun(prov,text,ens){
  const st=$("#cmpst-"+CSS.escape(prov));   // 用户气泡已在 cmpSend 里即时加过
  if(ens && ens.ok===false){ cmpAddMsg(prov,"a err","✗ 后端启动失败:"+esc(ens.error||"")); if(st)st.textContent="✗"; return; }
  if(CMP.cancelled[prov]){ if(st)st.textContent="⏸ 已取消"; cmpClearProgress(prov); CMP.cancelled[prov]=false; return; }
  const view=cmpEnsureView(prov);
  if(!view){ if(st)st.textContent="✗ 此栏未就绪"; cmpSetRunning(prov,false); return; }   // 该 provider 没渲染出列(#cmpb 缺)→ 优雅跳过,绝不抛错连累 Promise.all
  const rs={phase:"思考中",steps:0,lastStep:"",t0:Date.now(),done:false,sawTool:false,hasAnswer:false,grace:null,idle:null,tick:null,poll:null,es:null,turnId:null,finish:null};
  CMP.runState[prov]=rs;
  let finishResolve=null;
  const finish=(failed=false)=>{
    if(rs.done) return;
    rs.done=true;
    clearTimeout(rs.grace); clearTimeout(rs.idle); clearInterval(rs.tick); clearInterval(rs.poll);
    try{ if(rs.es) rs.es.close(); }catch(e){}
    if(rs.turnId) view.markTurnFinished(rs.turnId);
    cmpSetRunning(prov,false);
    CMP.turn[prov]=null;
    CMP.cancelled[prov]=false;
    if(st){
      if(failed) st.textContent="✗";
      else if(!/^[✓✗⏸⏱]/.test(st.textContent)) st.textContent="✓ "+cmpRunSecs(rs)+"s";
    }
    delete CMP.runState[prov];
    if(finishResolve) finishResolve();
  };
  rs.finish=finish;
  const bump=()=>{
    clearTimeout(rs.idle);
    rs.idle=setTimeout(()=>{ if(rs.done) return; cmpRunSetPhase(prov,"等待模型"); syncFromThread(); bump(); },180000);
  };
  const syncFromThread=async()=>{
    if(rs.done) return false;
    const tid=CMP.threads[prov]; if(!tid) return false;
    try{
      const rec=await (await fetch(url(`/cmp/${prov}/v1/threads/${tid}`))).json();
      if(typeof rec.latest_seq==="number") CMP.seq[prov]=Math.max(CMP.seq[prov]||0, rec.latest_seq);
      const turns=rec.turns||[];
      const turn=rs.turnId ? turns.find(t=>t.id===rs.turnId) : turns[turns.length-1];
      const status=(turn&&turn.status)||(rec.thread||{}).latest_turn_status||"";
      const item=[...(rec.items||[])].reverse().find(it=>it.kind==="agent_message" && (!rs.turnId || it.turn_id===rs.turnId) && it.detail);
      if(item&&item.detail){
        view.startItem(item.id,item);
        view.completeItem(item.id,item,false);
        cmpRunRecordAnswer(prov,item.detail);
      }
      if(isTurnDone(status)){
        const ns=normTurnStatus(status);
        if(ns==="interrupted"&&st) st.textContent="⏸ 已暂停";
        if((ns==="failed"||ns==="error")&&!rs.hasAnswer) cmpAddViewError(prov,"本轮失败(展开「过程」看详情)");
        finish(ns==="failed"||ns==="error");
        return true;
      }
      if(isTurnRunning(status)){ cmpRunSetPhase(prov,rs.hasAnswer?"同步中":"等待模型"); bump(); }
    }catch(e){}
    return false;
  };
  if(st) st.textContent="思考…";
  try{
    cmpSetRunning(prov,true);
    cmpRunSetPhase(prov,"思考中");
    rs.tick=setInterval(()=>cmpRunPushProgress(prov),1000);   // 心跳:每秒刷新工作状态
    if(prov==="qwen"){
      let r;
      try{
        r=await api("/api/qwen-chat",{method:"POST",body:JSON.stringify({provider:prov,prompt:text})});
      }catch(e){
        if(/Load failed|网络连接失败|Failed to fetch/i.test(String(e&&e.message||e))){
          cmpRunAddStep(prov,"连接重试");
          await new Promise(res=>setTimeout(res,900));
          r=await api("/api/qwen-chat",{method:"POST",body:JSON.stringify({provider:prov,prompt:text})});
        } else {
          throw e;
        }
      }
      if(r.error||r.ok===false) throw new Error(r.error||"千问返回失败");
      cmpAddViewAssistant(prov,r.text||"");
      cmpRunRecordAnswer(prov,r.text||"");
      if(st) st.textContent="✓ "+cmpRunSecs(rs)+"s";
      finish(false);
      return;
    }
    if(!CMP.threads[prov]){
      const t=await (await fetch(url(`/cmp/${prov}/v1/threads`),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();   // 不前端钉 model,由服务端按 model_prefs 注入(claude-code→sonnet 路由键,其它→所选变体)
      CMP.threads[prov]=t.id; CMP.seq[prov]=0;
      api("/api/pin-thread",{method:"POST",body:JSON.stringify({tid:t.id,provider:prov,session_id:CMP.sessionId,topic:CMP.topic,title_seed:CMP.titleSeed})}).catch(()=>{});   // 锁定到本 provider + 服务端收编进同一对比会话
      markCmp(t.id);   // 登记为对比 thread → 主窗口侧栏归入「多模型对比」组,不灌进普通对话列表
      cmpSessionRecordThread(prov,t.id);   // 记进当前对比会话 → 侧栏会话行能点回来恢复这一栏
    }
    let tid=CMP.threads[prov];
    cmpSetViewThread(prov,tid);
    // 每轮按当前开关设会话标志(自动批准 / 允许 shell)→ 让模型能联网取数、跳出沙箱
    await fetch(url(`/cmp/${prov}/v1/threads/${tid}`),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({auto_approve:CMP.autoApprove, allow_shell:CMP.allowShell})}).catch(()=>{});
    if(CMP.cancelled[prov]){ if(st)st.textContent="⏸ 已取消"; finish(false); return; }
    // ★ since_seq 取「发 turn 前的当前 latest_seq」,只听本轮新事件、绝不重放历史——
    //   否则追问时会把上一轮的 turn.completed/旧增量重放进来,导致 ✓0s 误收尾、流式不同步、答案吞掉。
    let since=CMP.seq[prov]||0, recForRun=null;
    try{
      const ti=await (await fetch(url(`/cmp/${prov}/v1/threads/${tid}`))).json();
      recForRun=ti;
      if(typeof ti.latest_seq==="number") since=ti.latest_seq;
    }catch(e){}
    // 不再往用户 prompt 里前置任何网络指引——它会被模型复述、或在恢复历史时显示出来(felix 嫌它显示)。
    // fake-ip 下「fetch_url 被拦 → 用 curl / web_search」的引导已写在 compare-research skill 的系统提示里(server.py ~876 行),
    // 对模型不可见地生效;非 shell 工具 / MCP / web_search 始终可用,Shell 开关只额外控制 exec_shell(上面 PATCH 的 allow_shell)。
    let sendText=text;
    const rolled=await cmpMaybeRolloverProviderThread(prov,tid,sendText,recForRun,t=>cmpRunAddStep(prov,t));
    if(rolled.rolled){
      tid=rolled.tid; sendText=rolled.text; since=0;
      cmpSetViewThread(prov,tid);
      await fetch(url(`/cmp/${prov}/v1/threads/${tid}`),{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({auto_approve:CMP.autoApprove, allow_shell:CMP.allowShell})}).catch(()=>{});
      try{
        const fresh=await (await fetch(url(`/cmp/${prov}/v1/threads/${tid}`))).json();
        if(typeof fresh.latest_seq==="number") since=fresh.latest_seq;
      }catch(e){}
    }
    let myTurn=null;
    try{ const tr=await (await fetch(url(`/cmp/${prov}/v1/threads/${tid}/turns`),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:sendText})})).json();
      myTurn=(tr&&((tr.turn&&tr.turn.id)||tr.id))||null;   // 本轮 turn id:SSE 只认本轮事件,重放的旧轮一律忽略
      if(myTurn){ CMP.turn[prov]=myTurn; rs.turnId=myTurn; }
    }catch(e){}
    if(CMP.cancelled[prov] && myTurn){ await fetch(url(`/cmp/${prov}/v1/threads/${tid}/turns/${myTurn}/interrupt`),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).catch(()=>{}); }
    await new Promise(resolve=>{
      const es=new EventSource(url(`/cmp/${prov}/v1/threads/${tid}/events?since_seq=${since}`));
      rs.es=es; finishResolve=resolve;
      // 空闲超时只做软提示,不再直接判失败收尾。部分模型/工具长时间无 SSE chunk,但后端仍在跑;靠 thread 直查兜底收尾。
      rs.poll=setInterval(syncFromThread,4000);   // 兜底:SSE 停顿/漏 turn.completed 时直查当前 thread,不依赖 summary limit/cache
      cmpRunSetPhase(prov,"思考中");
      const onEv=(k,e)=>{   // SSE 是命名事件,逐个 addEventListener(onmessage 只收匿名事件,收不到)
        let ev; try{ ev=JSON.parse(e.data); }catch{ return; }
        if(myTurn && ev.turn_id && ev.turn_id!==myTurn) return;   // 不是本轮的事件(重放的旧轮)→ 忽略,杜绝 ✓0s 误收尾 / 流式不同步 / 吞答案
        bump();   // 每收到一个事件就重置空闲计时:模型在干活就别超时
        if(ev.seq!=null) CMP.seq[prov]=ev.seq;
        const pl=ev.payload||{};
        if(k==="turn.started"){ CMP.turn[prov]=ev.turn_id||(pl.turn||{}).id||CMP.turn[prov]; if(CMP.turn[prov]) rs.turnId=CMP.turn[prov]; cmpSyncSendUI(); }   // 记下 turn_id 供「停止」中断 + 引导;turn 活了刷「引导」按钮
        if(k==="item.delta" && pl.kind==="agent_message") cmpRunRecordAnswer(prov,pl.delta||" ");
        if(k==="item.completed" && pl.item&&pl.item.kind==="agent_message"&&pl.item.detail) cmpRunRecordAnswer(prov,pl.item.detail);
        if(k==="turn.completed" && rs.sawTool && !rs.hasAnswer){
          rs.sawTool=false; cmpRunSetPhase(prov,"整理中"); clearTimeout(rs.grace);
          rs.pendingCompleteEvent=ev;
          rs.grace=setTimeout(()=>{ if(!rs.done) view.ingest(k,ev); },6000);  // 跑了工具还没文字答案→短暂等可能的后续总结轮
          return;
        }
        if(k==="turn.interrupted"&&st) st.textContent="⏸ 已暂停";
        view.ingest(k,ev);
      };
      ["turn.started","turn.lifecycle","turn.interrupt_requested","item.started","item.delta","item.completed","item.failed","item.interrupted","approval.required","approval.decided","approval.timeout","sandbox.denied","turn.completed","turn.failed","turn.interrupted"].forEach(name=>es.addEventListener(name,e=>onEv(name,e)));
      es.onerror=()=>{ if(es.readyState===2){ cmpRunSetPhase(prov,"同步中"); syncFromThread(); } };
      bump();   // 起步先武装空闲计时(180s 无任何事件才判卡住);不再用死板的 240s 绝对超时切断长任务
    });
  }catch(e){
    CMP.cancelled[prov]=false;
    cmpAddViewError(prov,String(e&&e.message||e));
    if(st) st.textContent="✗";
    finish(true);
  }
}


export { cmpColUpload, cmpColRenderAttach, cmpColWithAttach, CMP, CMP_FORCE_MODEL, MODEL_VARIANTS, applyProviderModelCatalog, loadProviderModels, EFFORT_PROVIDERS, EFFORT_OPTS, EFFORT_OPTS_BY_PROV, effortOptsFor, initCompareNetenv, openCompare, closeCompare, cmpFindSession, cmpShowSessionError, openCompareWindow, restoreCompareSession, cmpLoadHistory, setCmpLayout, cmpSetModel, cmpSetEffort, renderCmpToggles, cmpApplyFlags, cmpToggleAuto, cmpToggleShell, renderCmpChips, cmpSwitchTab, renderCmpTabs, renderCmpCols, cmpSetProgress, cmpClearProgress, cmpSetRunning, cmpStop, cmpStopAll, cmpRunOne, cmpClearAllCols, cmpResetBackends, cmpNewChat, toggleMax, cmpAddMsg, cmpProvBusy, cmpAnyBusy, cmpQueueFor, cmpQueuedGroups, cmpCancelQueued, cmpValidProviders, cmpCurrentSession, cmpSetSessionTopic, cmpPatchThreadTitle, cmpSyncSessionThreadTitles, cmpScheduleSmartTitle, cmpEnsureSession, cmpMakeItem, cmpSyncSendUI, cmpSend, cmpDispatch, cmpUploadFiles, cmpRenderAttach, cmpRunNextFor, cmpMaybeFlush, cmpRun };
