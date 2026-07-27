const COMBO_ROLE_ORDER=["controller","executor"];
const COMBO_LEGACY_ROLE_ALIASES={
  dispatcher:"controller",planner:"executor",worker:"executor",operator:"executor",auditor:"controller",
  planAuditor:"controller",resultAuditor:"controller"
};
const COMBO_ROLE_META={
  // Provider/model are only initial suggestions. Each role is independently editable
  // and a session keeps its own snapshot so later changes never rewrite its history.
  controller:{title:"总调度",provider:"openai-codex",model:"gpt-5.6-sol"},
  executor:{title:"执行模型",provider:"moonshot",model:"k3",toolProvider:"deepseek",toolModel:"deepseek-v4-pro"}
};
const COMBO_DEFAULT_ROLES={
  controller:{...COMBO_ROLE_META.controller,thinking:"advanced",contextLength:"standard"},
  executor:{...COMBO_ROLE_META.executor,thinking:"extreme",contextLength:"long"}
};
const COMBO_CAPABILITIES={
  moonshot:{nativeEffort:false,sampling:"K3 由服务端管理采样；CodeWhale 用角色指令控制思考深度"},
  deepseek:{nativeEffort:false,sampling:"DeepSeek 由服务端管理采样；按当前角色的流程指令工作"},
  "openai-codex":{nativeEffort:true,sampling:"GPT 原生映射 reasoning effort；按当前角色的流程指令工作"},
  "claude-code":{nativeEffort:true,sampling:"Claude 原生映射 effort，最高使用 high"},
  qwen:{nativeEffort:false,sampling:"Qwen 由服务端管理采样参数"},
  zai:{nativeEffort:false,sampling:"GLM 由服务端管理采样参数"},
  volcengine:{nativeEffort:false,sampling:"火山模型由服务端管理采样参数"},
  longcat:{nativeEffort:false,sampling:"LongCat 由服务端管理采样参数"},
  custom:{nativeEffort:false,sampling:"该模型由服务端管理采样参数"}
};
const COMBO_THINKING_LEVELS=[
  {value:"standard",label:"标准",hint:"日常任务，速度与质量平衡"},
  {value:"advanced",label:"进阶",hint:"复杂任务，增加推理、核对与边界检查"},
  {value:"extreme",label:"极致",hint:"关键规划或审计，优先完整性与可靠性"}
];
const COMBO_CONTEXT_LENGTHS=[
  {value:"standard",label:"标准",hint:"保持回答紧凑，适合一般任务"},
  {value:"long",label:"超长",hint:"保留更多上下文并允许完整展开"}
];
const COMBO_EVENTS=[
  "turn.started","turn.completed","turn.failed","turn.interrupted","turn.lifecycle",
  "item.started","item.delta","item.completed","item.failed","item.interrupted",
  "approval.required","approval.decided","approval.timeout","sandbox.denied"
];
// Opening a combo task must be instant. Older records stay available on demand.
const COMBO_INITIAL_HISTORY_MESSAGES=12;
const COMBO_HISTORY_PAGE_MESSAGES=24;
const COMBO={
  active:false,busy:false,stopped:false,session:null,currentRole:"",currentTurn:"",
  currentThread:"",es:null,poll:null,timeout:null,cancelCurrent:null,
  roles:null,bag:null,view:null,currentProfile:null,currentUsesTools:false,maxRepairRounds:1
};

function comboCloneDefaults(){
  return Object.fromEntries(Object.entries(COMBO_DEFAULT_ROLES).map(([key,value])=>[key,{...value}]));
}
function comboRoleKey(key){ return COMBO_LEGACY_ROLE_ALIASES[key]||key||"controller"; }
function comboNormalizeRole(role,key){
  const normalizedKey=comboRoleKey(key);
  const defaults=COMBO_DEFAULT_ROLES[normalizedKey]||COMBO_DEFAULT_ROLES.controller;
  const value={...defaults,...(role||{})};
  if(!COMBO_THINKING_LEVELS.some(item=>item.value===value.thinking)){
    value.thinking=value.effort==="max"||value.effort==="xhigh"?"extreme":
      value.effort==="high"||value.preset==="advanced"||value.preset==="strict"?"advanced":defaults.thinking;
  }
  if(!COMBO_CONTEXT_LENGTHS.some(item=>item.value===value.contextLength)){
    value.contextLength=Number(value.maxTokens||0)>=12000?"long":defaults.contextLength;
  }
  delete value.preset;
  delete value.effort;
  delete value.temperature;
  delete value.maxTokens;
  // Older sessions stored a display owner. It is derived
  // from the active provider now, so a model change cannot leave stale labels.
  delete value.owner;
  if(normalizedKey==="executor"){
    value.toolProvider=String(value.toolProvider||defaults.toolProvider||"deepseek");
    value.toolModel=String(value.toolModel||defaults.toolModel||"deepseek-v4-pro");
  }
  return value;
}
function comboLoadRoles(){
  let saved={},legacy={};
  try{ saved=JSON.parse(localStorage.getItem("cw_combo_roles_v2")||"{}")||{}; }catch(e){}
  try{ legacy=JSON.parse(localStorage.getItem("cw_combo_roles")||"{}")||{}; }catch(e){}
  const roles=comboCloneDefaults();
  for(const key of Object.keys(roles)){
    const previous=key==="controller"?(legacy.controller||legacy.dispatcher||legacy.auditor):
      (legacy.worker||legacy.planner||legacy.executor||legacy.operator);
    roles[key]=comboNormalizeRole(saved[key]||previous,key);
  }
  return roles;
}
function comboSaveRoles(){
  try{ localStorage.setItem("cw_combo_roles_v2",JSON.stringify(COMBO.roles)); }catch(e){}
}
function comboId(){ return "cmbs_"+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function comboItemId(prefix="combo"){ return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`; }
function comboProviderName(provider){
  const found=(window.PROVIDERS||[]).find(p=>p.id===provider);
  return (window.PROV_SHORT&&window.PROV_SHORT[provider])||(found&&found.name)||provider;
}
function comboModelName(role){
  const variants=(window.MODEL_VARIANTS&&window.MODEL_VARIANTS[role.provider])||[];
  return (variants.find(v=>v.id===role.model)||{}).name||role.model||"默认";
}
function comboRoleName(roleOrKey){
  const role=typeof roleOrKey==="string"?comboGetRole(roleOrKey):roleOrKey;
  return comboProviderName((role&&role.provider)||"");
}
function comboRoleStage(role){
  const key=comboRoleKey(role);
  return key==="controller"?"调度与验收":"执行与交付";
}
function comboTopic(text){
  const clean=String(text||"").replace(/\s+/g," ").trim();
  return clean.slice(0,28)||(COMBO.session&&COMBO.session.topic)||"组合任务";
}
function comboNow(){ return new Date().toISOString(); }
function comboStatusLabel(role){
  if(!role) return "等待任务";
  return `${comboRoleName(role)} · ${comboRoleStage(role)}`;
}
function comboTaskNeedsTools(task){
  const text=String(task||"").trim();
  if(!text) return false;
  // Attachments are expanded into local paths before the pipeline starts.  Never
  // route those tasks to the no-tool direct-response path.
  const fileRef=/(?:<attachment_ocr>|原图\s*:|原\s*PDF\s*:|后台(?:识图|文本)结果\s*:|视觉补充路径\s*:|\b(?:read_file|image_ocr)\b|\b(?:attachment|附件)\b|(?:~|\/(?:Users|Volumes|tmp|private\/tmp|var\/folders))\/[^\s"'“”‘’<>]+\.(?:pdf|md|markdown|txt|csv|tsv|json|html?|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|webp|svg|py|jsx?|tsx?|css|xml|ya?ml|toml|sh))/i;
  const toolIntent=/(?:读取|查看|打开|解析|提取|识别|分析|检索|搜索|调研|查找|下载|上传|文件|附件|文档|路径|链接|网址|https?:\/\/)/i;
  return fileRef.test(text)||toolIntent.test(text);
}
function comboTaskMode(task){
  const text=String(task||"").trim();
  const highRisk=/(删除|清空|覆盖|替换生产|发布|部署|提交\s*(?:PR|pull request)|发送邮件|群发|付款|支付|转账|交易|买入|卖出|下单|凭据|密钥|API\s*key|密码|访问令牌|token\s*(?:保存|配置|更新|轮换|明文|泄露)|数据迁移|数据库迁移|schema\s*migration|大范围架构|架构迁移)/i;
  if(highRisk.test(text)) return "high";
  if(comboTaskNeedsTools(text)) return "general";
  const requiresExecution=/(写代码|改代码|修改代码|改文件|修改文件|创建文件|运行命令|执行命令|跑测试|修复|实现|安装|配置|接入|升级|重构)/i;
  if(text.length<=220&&!requiresExecution.test(text)) return "simple";
  return "general";
}
function comboTaskModeLabel(mode){
  return mode==="simple"?"简单直答":mode==="high"?"高风险协作":mode==="clarify"?"等待澄清":"标准协作";
}
function comboRouteText(mode){
  return mode==="simple"?"简单直答":mode==="high"?"高风险协作":mode==="clarify"?"需要澄清":"标准协作";
}
function comboDispatchTaskMode(text,fallback="general"){
  const value=String(text||"").toLowerCase();
  let selected="";
  if(/(?:调度路径|建议路径|dispatch_route|route)\s*[:：]\s*(?:high|高风险)/i.test(value)) selected="high";
  else if(/(?:调度路径|建议路径|dispatch_route|route)\s*[:：]\s*(?:clarify|澄清|补充)/i.test(value)) selected="clarify";
  else if(/(?:调度路径|建议路径|dispatch_route|route)\s*[:：]\s*(?:simple|简单直答|直接回答)/i.test(value)) selected="simple";
  else if(/(?:调度路径|建议路径|dispatch_route|route)\s*[:：]\s*(?:general|标准协作|一般协作)/i.test(value)) selected="general";
  // Deterministic high-risk detection is a safety floor. A dispatcher can raise
  // the route or ask for clarification, but never downgrade a high-risk task.
  if(fallback==="high") return selected==="clarify"?"clarify":"high";
  return selected||fallback;
}
function comboAuditDecision(text,prefix){
  const match=String(text||"").match(new RegExp(`${prefix}:\\s*(PASS|REMEDIATE|REJECT)`,"i"));
  return match?match[1].toUpperCase():"REJECT";
}
function comboPlanReviewDecision(text){
  const value=String(text||"");
  const current=value.match(/PLAN_REVIEW:\s*(PROCEED|BLOCK)/i);
  if(current) return current[1].toUpperCase();
  const legacy=comboAuditDecision(value,"PLAN_AUDIT");
  return legacy==="PASS"||legacy==="REMEDIATE"?"PROCEED":"BLOCK";
}
function comboExtractAuditRewrite(text,heading){
  const value=String(text||"");
  const marker=new RegExp(`(?:^|\\n)#{1,3}\\s*${heading}\\s*[:：]?\\s*\\n`,"i");
  const match=value.match(marker);
  if(!match) return "";
  return value.slice((match.index||0)+match[0].length)
    .replace(/\n(?:PLAN_REVIEW:\s*(?:PROCEED|BLOCK)|(?:PLAN|SIMPLE)_AUDIT:\s*(?:PASS|REMEDIATE|REJECT))[\s\S]*$/i,"").trim();
}
function comboExtractReviewedPlan(text){
  return comboExtractAuditRewrite(text,"最终可执行规划")||
    comboExtractAuditRewrite(text,"可执行修订稿");
}
function comboGetRole(role){
  return COMBO.roles[comboRoleKey(role)]||COMBO.roles.controller;
}
function comboRoleButton(role){
  return document.querySelector(`.combo-role[data-role="${comboRoleKey(role)}"]`);
}
function comboSetPhase(role,label){
  COMBO.currentRole=role||"";
  if(COMBO.session) COMBO.session.phase=role||"idle";
  document.querySelectorAll(".combo-role").forEach(button=>button.classList.remove("active"));
  const active=comboRoleButton(role);
  if(active) active.classList.add("active");
  const phase=$("#comboPhase");
  if(phase) phase.textContent=label||comboStatusLabel(role)||"等待任务";
  comboSyncComposer();
}
function comboMarkRole(role,stateName){
  const button=comboRoleButton(role);
  if(!button) return;
  button.classList.remove("active","done","blocked");
  if(stateName) button.classList.add(stateName);
}
function comboSetGate(pass,text){
  const gate=$("#comboGate");
  if(!gate) return;
  gate.classList.toggle("pass",!!pass);
  gate.textContent=text||(pass?"总调度已验收闭环":"等待调度");
}
function comboRenderCheckpoint(checkpoint){
  const wrap=$("#mwrap");
  if(!wrap||!checkpoint) return;
  wrap.querySelector(`[data-combo-checkpoint="${checkpoint.id}"]`)?.remove();
  const card=document.createElement("div");
  card.className=`combo-checkpoint ${checkpoint.state||"ready"}`;
  card.dataset.comboCheckpoint=checkpoint.id;
  card.innerHTML=`<div><b>检查点 ${Number(checkpoint.index||0)+1}/4 · ${esc(checkpoint.title||"流程更新")}</b><span>${esc(checkpoint.detail||"")}</span></div><button type="button" title="添加引导">引导</button>`;
  card.querySelector("button").onclick=()=>$("#input")?.focus();
  wrap.appendChild(card);
}
function comboRecordCheckpoint(id,title,detail,stateName="ready"){
  const artifacts=comboArtifacts();
  const previous=artifacts.checkpoints.find(item=>item.id===id);
  const checkpoint={id,title,detail,state:stateName,at:comboNow(),index:previous?previous.index:artifacts.checkpoints.length};
  if(previous) Object.assign(previous,checkpoint);
  else artifacts.checkpoints.push(checkpoint);
  artifacts.checkpoints=artifacts.checkpoints.slice(-12);
  comboSetGate(stateName==="pass",`检查点 ${Math.min(4,checkpoint.index+1)}/4 · ${title}`);
  comboRenderCheckpoint(checkpoint);
  comboPersist();
}
function comboRenderRoleChips(){
  for(const key of COMBO_ROLE_ORDER){
    const role=COMBO.roles[key], button=document.querySelector(`.combo-role[data-role="${key}"]`);
    if(!button) continue;
    button.querySelector("b").textContent=comboRoleName(role);
    const toolSuffix=key==="executor"&&role.toolProvider&&role.toolProvider!==role.provider
      ?` · 工具时 ${comboProviderName(role.toolProvider)}`:"";
    button.querySelector("small").textContent=`${comboModelName(role)}${toolSuffix}`;
    button.title=`${role.title}: ${comboProviderName(role.provider)} · ${comboModelName(role)}。点击配置`;
  }
}
function comboSessionMessages(){
  if(!COMBO.session.messages) COMBO.session.messages=[];
  return COMBO.session.messages;
}
function comboArtifacts(){
  if(!COMBO.session.artifacts) COMBO.session.artifacts={};
  const value=COMBO.session.artifacts;
  value.task=value.task||"";
  value.controllerPlan=value.controllerPlan||value.plan||"";
  value.executionResult=value.executionResult||value.workerResult||value.operatorResult||value.result||"";
  value.toolRequired=!!value.toolRequired||value.route==="EXECUTOR_WITH_TOOLS"||value.route==="WORKER_AND_OPERATOR";
  value.finalAudit=value.finalAudit||value.resultAudit||"";
  value.route=value.route||value.dispatch||"";
  value.repairRound=Number(value.repairRound||0);
  if(!Array.isArray(value.checkpoints)) value.checkpoints=[];
  return value;
}
function comboGuidance(){
  if(!Array.isArray(COMBO.session.guidance)) COMBO.session.guidance=[];
  return COMBO.session.guidance;
}
function comboGuidanceText(){
  const items=comboGuidance().slice(-12);
  return items.length ? `\n用户在运行过程中的补充引导（按时间顺序，必须纳入当前判断）：\n${items.map((item,index)=>`${index+1}. ${item.text}`).join("\n")}` : "";
}
function comboRecordMessage(kind,text,meta={}){
  const value=String(text||"").trim();
  if(!value) return;
  const message={
    id:meta.id||comboItemId(kind==="user_message"?"combouser":"comboagent"),
    kind,
    text:value,
    created_at:meta.created_at||comboNow(),
    who:meta.who||"",
    role:meta.role||"",
    failed:!!meta.failed
  };
  const existing=comboSessionMessages().find(item=>item.id===message.id);
  if(existing) Object.assign(existing,message);
  else comboSessionMessages().push(message);
  COMBO.session.messages=comboSessionMessages().slice(-120);
  comboPersist();
}
function comboPersist(){
  if(!COMBO.session) return;
  COMBO.session.roles=COMBO.roles;
  COMBO.session.combo_schema=2;
  COMBO.session.ts=Date.now();
  // A persisted "running" value alone is not trustworthy after a crash or reload.
  // Refresh the heartbeat only while this window is actually driving the workflow.
  if(COMBO.busy&&COMBO.session.status==="running") COMBO.session.heartbeat_at=COMBO.session.ts;
  const index=(state.comboSessions||[]).findIndex(s=>s.id===COMBO.session.id);
  if(index>=0) state.comboSessions[index]={...COMBO.session};
  else state.comboSessions=[{...COMBO.session},...(state.comboSessions||[])];
  saveComboSessions();
}
function comboEnsureView(){
  if(COMBO.view) return COMBO.view;
  COMBO.bag={activeId:"combo_virtual",items:new Map(),seen:new Set(),finishedTurnIds:new Set()};
  COMBO.view=createChatView({
    bag:COMBO.bag,
    getWrap:()=>$("#mwrap"),
    getScrollHost:()=>$("#messages"),
    inputSel:"#input"
  });
  return COMBO.view;
}
function comboAddMessage(kind,text,meta={}){
  const value=String(text||"").trim();
  if(!value) return null;
  const id=meta.id||comboItemId(kind==="user_message"?"combouser":"comboagent");
  const item={id,kind,detail:value,summary:value,created_at:meta.created_at||comboNow()};
  const view=comboEnsureView();
  view.startItem(id,item);
  view.completeItem(id,item,!!meta.failed);
  const rec=COMBO.bag.items&&COMBO.bag.items.get(id);
  if(rec&&rec.el&&meta.who){
    const who=rec.el.querySelector(".who");
    if(who) who.textContent=meta.who;
    rec.el.dataset.comboRole=meta.role||"";
  }
  if(meta.persist!==false){
    comboRecordMessage(kind,value,{...meta,id,created_at:item.created_at});
  }
  if(!meta.noScroll) view.scrollDown(true);
  return rec&&rec.el;
}
function comboAddPhase(role,detail){
  const wrap=$("#mwrap");
  if(!wrap) return;
  const note=document.createElement("div");
  note.className="combo-phase-note";
  note.innerHTML=`<b>【切换到 ${esc(comboRoleName(role))}】</b><span>${esc(detail||comboStatusLabel(role))}</span>`;
  wrap.appendChild(note);
  comboEnsureView().scrollDown(true);
}
function comboRenderStored(limit=COMBO_INITIAL_HISTORY_MESSAGES,options={}){
  const wrap=$("#mwrap");
  if(!wrap) return;
  wrap.innerHTML="";
  COMBO.view=null; COMBO.bag=null;
  const view=comboEnsureView();
  const messages=(COMBO.session&&Array.isArray(COMBO.session.messages))?COMBO.session.messages:[];
  if(!messages.length){
    const empty=document.createElement("div");
    empty.className="empty";
    empty.innerHTML="<div class=\"big\">组合任务</div>总调度先理解任务、制定路径并设置检查点；执行模型负责研究与交付，只有需要文件、命令或测试时才自动使用工具后备模型。";
    wrap.appendChild(empty);
    const checkpoints=comboArtifacts().checkpoints;
    if(checkpoints.length) comboRenderCheckpoint(checkpoints[checkpoints.length-1]);
    return;
  }
  const visibleCount=Math.max(1,Math.min(messages.length,Number(limit)||COMBO_INITIAL_HISTORY_MESSAGES));
  const firstVisible=Math.max(0,messages.length-visibleCount);
  if(firstVisible){
    const history=document.createElement("div");
    history.className="combo-history-note";
    const pageSize=Math.min(COMBO_HISTORY_PAGE_MESSAGES,firstVisible);
    history.innerHTML=`<span>已显示最近 ${visibleCount} 条记录，另有 ${firstVisible} 条历史。</span><button type="button">加载更早 ${pageSize} 条</button>`;
    history.querySelector("button").onclick=()=>comboRenderStored(
      Math.min(messages.length,visibleCount+COMBO_HISTORY_PAGE_MESSAGES),
      {focusOlder:true}
    );
    wrap.appendChild(history);
  }
  // Let chat-view defer markdown work until each restored card enters the viewport.
  COMBO.bag.renderingSnapshot=true;
  try{
    for(const message of messages.slice(firstVisible)){
      comboAddMessage(message.kind||"agent_message",message.text||"",{...message,persist:false,noScroll:true});
    }
  }finally{
    COMBO.bag.renderingSnapshot=false;
  }
  const host=$("#messages");
  if(options.focusOlder&&host) host.scrollTop=0;
  else view.scrollDown(true);
  const checkpoints=comboArtifacts().checkpoints;
  if(checkpoints.length) comboRenderCheckpoint(checkpoints[checkpoints.length-1]);
}
function comboFindSession(id){
  return (state.comboSessions||[]).find(s=>s.id===id)||null;
}
function comboMakeSession(topic="组合任务"){
  return {
    id:comboId(),topic,ts:Date.now(),status:"idle",phase:"idle",roles:Object.fromEntries(Object.entries(COMBO.roles||comboCloneDefaults()).map(([key,value])=>[key,{...value}])),threads:{},messages:[],
    combo_schema:2,artifacts:{task:"",controllerPlan:"",executionResult:"",finalAudit:"",route:"",toolRequired:false,repairRound:0,checkpoints:[]},guidance:[],
    plan_passed:false,audit_passed:false
  };
}
function openComboWindow(sessionId=""){
  const query=new URLSearchParams({combo:"1"});
  if(sessionId) query.set("session",sessionId);
  const target=`${location.origin}${location.pathname}?${query}`;
  // Do not pass "noopener": WebKit then intentionally returns null even when it
  // created the child window, which used to trigger our fallback and navigate
  // the main window to combo mode as well.
  let win=null;
  try{ win=window.open(target,"_blank"); }catch(e){}
  if(!win) cwToast("组合任务需要独立窗口，请允许弹出窗口或退出重开 CodeWhale");
}
async function initComboWindow(sessionId=""){
  COMBO.active=true;
  COMBO.roles=comboLoadRoles();
  COMBO.session=comboFindSession(sessionId)||comboMakeSession();
  if(COMBO.session.roles){
    for(const key of Object.keys(COMBO.roles)){
      const stored=COMBO.session.roles;
      const legacy=key==="controller"?(stored.controller||stored.dispatcher||stored.auditor):
        (COMBO.session.combo_schema>=2?stored.executor:(stored.worker||stored.planner||stored.executor||stored.operator));
      COMBO.roles[key]=comboNormalizeRole(legacy,key);
    }
  }
  $("#comboBar").hidden=false;
  $("#ttitle").textContent=COMBO.session.topic||"组合模型";
  state.allowShell=true; state.autoApprove=true;
  renderShell(); renderAuto();
  comboRenderRoleChips();
  comboSetGate(!!COMBO.session.audit_passed,COMBO.session.audit_passed?"检查点 4/4 · 已闭环":(COMBO.session.plan_passed?"检查点 2/4 · 等待执行模型":"检查点 0/4 · 等待任务"));
  comboRenderStored();
  document.querySelectorAll(".combo-role").forEach(button=>button.onclick=()=>comboOpenRoleConfig(button.dataset.role));
  const configure=$("#comboConfigure"); if(configure) configure.onclick=comboOpenRolesConfig;
  const intervene=$("#comboIntervene"); if(intervene) intervene.onclick=comboOpenIntervene;
  comboSyncComposer();
  // Provider catalog requests may hit every remote model endpoint. Do them only
  // after the usable combo window is on screen; role configuration still refreshes
  // the catalog synchronously when the user explicitly opens it.
  comboWarmProviderModels();
  $("#input").focus();
}

function comboWarmProviderModels(){
  const warm=()=>loadProviderModels().then(()=>{
    if(COMBO.active) comboRenderRoleChips();
  }).catch(()=>{});
  if("requestIdleCallback" in window) window.requestIdleCallback(warm,{timeout:1200});
  else window.setTimeout(warm,180);
}

function comboSyncComposer(){
  const input=$("#input"), send=$("#sendbtn");
  if(!input||!COMBO.active) return;
  // Guidance is useful even while the provider thread is still starting.
  // comboSteer queues it safely until an active turn exists.
  const steering=COMBO.busy;
  input.placeholder=steering
    ? `输入引导，立即纠偏 ${comboStatusLabel(COMBO.currentRole)}…（Enter 插入 · Shift+Enter 换行）`
    : `描述任务，${comboRoleName("controller")} 会先理解、规划和设置检查点，再按需分派执行模型…`;
  if(send){
    send.title=steering?"插入引导到当前模型，并带入后续阶段":"启动自适应组合流程";
    send.setAttribute("aria-label",steering?"插入引导":"发送");
  }
}

function comboCapability(role){
  return COMBO_CAPABILITIES[role.provider]||COMBO_CAPABILITIES.custom;
}
function comboNativeEffort(role){
  const level=role.thinking||"advanced";
  if(role.provider==="openai-codex") return level==="extreme"?"max":level==="advanced"?"high":"medium";
  if(role.provider==="claude-code") return level==="standard"?"medium":"high";
  return "";
}
function comboProfileNote(role){
  const cap=comboCapability(role);
  const thinking=(COMBO_THINKING_LEVELS.find(item=>item.value===role.thinking)||COMBO_THINKING_LEVELS[1]).label;
  const length=(COMBO_CONTEXT_LENGTHS.find(item=>item.value===role.contextLength)||COMBO_CONTEXT_LENGTHS[1]).label;
  const native=cap.nativeEffort?`；已映射原生 effort=${comboNativeEffort(role)}`:"";
  return `自动优化：思考强度「${thinking}」· 对话长度「${length}」${native}。${cap.sampling}`;
}
async function comboOpenRoleConfig(key){
  const role=COMBO.roles[key];
  if(!role) return;
  await loadProviderModels().catch(()=>{});
  openModal(`配置${role.title}模型`,"settings");
  const body=$("#modalBody"), providers=(window.PROVIDERS||[]).filter(p=>!p.cmpKeyOnly||p.id==="custom");
  body.innerHTML=`<div class="combo-config">
    <label>模型 Provider<select id="comboCfgProvider">${providers.map(p=>`<option value="${escAttr(p.id)}" ${p.id===role.provider?"selected":""}>${esc(p.name)}</option>`).join("")}</select></label>
    <label>模型<select id="comboCfgModel"></select></label>
    <label>思考强度<select id="comboCfgThinking">${COMBO_THINKING_LEVELS.map(item=>`<option value="${item.value}">${item.label}</option>`).join("")}</select><small id="comboThinkingHint"></small></label>
    <label>对话长度<select id="comboCfgLength">${COMBO_CONTEXT_LENGTHS.map(item=>`<option value="${item.value}">${item.label}</option>`).join("")}</select><small id="comboLengthHint"></small></label>
    ${key==="executor"?`<fieldset class="combo-tool-fallback"><legend>需要工具时自动切换</legend><label>工具模型 Provider<select id="comboCfgToolProvider">${providers.map(p=>`<option value="${escAttr(p.id)}" ${p.id===role.toolProvider?"selected":""}>${esc(p.name)}</option>`).join("")}</select></label><label>工具模型<select id="comboCfgToolModel"></select></label><small>仅当计划需要改文件、跑命令或测试时使用；平时仍由执行模型完成研究和起草。</small></fieldset>`:""}
    <p class="combo-cap-note" id="comboCapNote"></p>
    <button class="primary" id="comboCfgSave">保存角色配置</button>
  </div>`;
  const provider=$("#comboCfgProvider"), model=$("#comboCfgModel");
  const thinking=$("#comboCfgThinking"), length=$("#comboCfgLength");
  const toolProvider=$("#comboCfgToolProvider"), toolModel=$("#comboCfgToolModel");
  thinking.value=role.thinking||"advanced";
  length.value=role.contextLength||"long";
  const updateProfile=()=>{
    $("#comboThinkingHint").textContent=(COMBO_THINKING_LEVELS.find(item=>item.value===thinking.value)||COMBO_THINKING_LEVELS[1]).hint;
    $("#comboLengthHint").textContent=(COMBO_CONTEXT_LENGTHS.find(item=>item.value===length.value)||COMBO_CONTEXT_LENGTHS[1]).hint;
    $("#comboCapNote").textContent=comboProfileNote({...role,provider:provider.value,thinking:thinking.value,contextLength:length.value});
  };
  const redraw=()=>{
    const prov=provider.value;
    const variants=(window.MODEL_VARIANTS&&window.MODEL_VARIANTS[prov])||[];
    model.innerHTML=variants.map(v=>`<option value="${escAttr(v.id)}">${esc(v.name||v.id)}</option>`).join("")||`<option value="auto">由后端默认</option>`;
    model.value=prov===role.provider&&variants.some(v=>v.id===role.model)?role.model:((window.CMP_FORCE_MODEL&&window.CMP_FORCE_MODEL[prov])||(variants[0]&&variants[0].id)||"auto");
    updateProfile();
  };
  const redrawTool=()=>{
    if(!toolProvider||!toolModel) return;
    const variants=(window.MODEL_VARIANTS&&window.MODEL_VARIANTS[toolProvider.value])||[];
    toolModel.innerHTML=variants.map(v=>`<option value="${escAttr(v.id)}">${esc(v.name||v.id)}</option>`).join("")||`<option value="auto">由后端默认</option>`;
    toolModel.value=toolProvider.value===role.toolProvider&&variants.some(v=>v.id===role.toolModel)?role.toolModel:((window.CMP_FORCE_MODEL&&window.CMP_FORCE_MODEL[toolProvider.value])||(variants[0]&&variants[0].id)||"auto");
  };
  provider.onchange=redraw;
  if(toolProvider) toolProvider.onchange=redrawTool;
  thinking.onchange=updateProfile;
  length.onchange=updateProfile;
  redraw();
  redrawTool();
  $("#comboCfgSave").onclick=async()=>{
    const prov=provider.value;
    COMBO.roles[key]=comboNormalizeRole({
      ...role,provider:prov,model:model.value,
      thinking:thinking.value,contextLength:length.value,
      ...(toolProvider?{toolProvider:toolProvider.value,toolModel:toolModel.value}:{})
    },key);
    comboSaveRoles(); comboRenderRoleChips(); comboPersist();
    delete COMBO.session.threads[key];
    if(key==="executor"&&COMBO.session.tool_threads) delete COMBO.session.tool_threads.executor;
    comboPersist();
    const pref={provider:prov,model:model.value};
    if((COMBO_CAPABILITIES[prov]||COMBO_CAPABILITIES.custom).nativeEffort) pref.effort=comboNativeEffort(COMBO.roles[key]);
    try{ await api("/api/model-pref",{method:"POST",body:JSON.stringify(pref)}); }catch(e){ cwToast(e.message||"模型设置保存失败"); }
    closeModal(); cwToast(`${COMBO.roles[key].title}模型已更新`);
  };
}

function comboOpenRolesConfig(){
  openModal("组合角色配置","settings");
  const body=$("#modalBody");
  body.innerHTML=`<div class="combo-config"><p class="combo-cap-note">角色可随时替换，不写死品牌或模型。总调度负责理解、规划、检查点与最终验收；执行模型负责研究、起草和交付，只有确有文件、命令或测试需要时才使用它配置的工具后备模型。</p>${COMBO_ROLE_ORDER.map(key=>{
    const role=comboGetRole(key);
    return `<button class="combo-role-config-row" data-role="${key}"><b>${esc(role.title)}</b><span>${esc(comboProviderName(role.provider))} · ${esc(comboModelName(role))}</span><small>${esc(comboRoleStage(key))}</small></button>`;
  }).join("")}</div>`;
  body.querySelectorAll("[data-role]").forEach(button=>button.onclick=()=>comboOpenRoleConfig(button.dataset.role));
}

function comboBudgetInstruction(role){
  const thinking=(COMBO_THINKING_LEVELS.find(item=>item.value===role.thinking)||COMBO_THINKING_LEVELS[1]).label;
  const length=(COMBO_CONTEXT_LENGTHS.find(item=>item.value===role.contextLength)||COMBO_CONTEXT_LENGTHS[1]).label;
  const detail=role.contextLength==="long"
    ?"使用超长对话策略：保留完整任务上下文，关键证据、边界和验收结果必须展开，不得因篇幅省略。"
    :"使用标准对话策略：保持紧凑，但不得省略关键结论与验收结果。";
  return `思考强度:${thinking}。${detail} 输出长度由模型能力自动选择，不设置容易截断结果的人工 token 上限。`;
}
function comboControllerPlanPrompt(task,taskMode="general"){
  const executor=comboRoleName("executor");
  return `【组合任务｜${comboRoleName("controller")} 总调度】
你负责理解、策划、设置检查点和监督路径。禁止改文件、跑命令或调用工具。
用户任务：\n${task}\n${comboGuidanceText()}
请输出可直接交给执行模型的简洁方案，包含：任务理解、目标与边界、工作步骤、验收标准、风险。
选择路径：仅回答/执行模型处理/执行模型需要工具/需要澄清，并在末尾严格写：
ROUTE: DIRECT | EXECUTOR | EXECUTOR_WITH_TOOLS | CLARIFY
RISK: LOW | MEDIUM | HIGH
高风险或目标不明确时只写安全的下一步，不要假设有授权。任务包含附件、文件名、本地路径、文档内容或链接且需要读取、解析、检索或核对时，必须选择 EXECUTOR_WITH_TOOLS；不要要求用户重复粘贴已有文件内容，除非工具明确报告无法访问。
${executor} 负责研究、起草和交付；只有确实需要读取文件或附件、运行命令、改文件或测试时，才会自动切到该模型配置的工具后备模型。
${comboBudgetInstruction(comboGetRole("controller"))}`;
}
function comboControllerDirectPrompt(task){
  return `【组合任务｜${comboRoleName("controller")} 直接交付】
这是低风险且无需协作的任务。直接完成用户请求，不调用工具、不读写文件。简洁给出可交付答案；若必要信息确实缺失，只问一个最小澄清问题。\n用户任务：\n${task}\n${comboGuidanceText()}\n${comboBudgetInstruction(comboGetRole("controller"))}`;
}
function comboExecutorPrompt(task,plan,repair="",allowTools=false){
  return `【组合任务｜${comboRoleName("executor")} 执行阶段】
你只负责按已确认方案研究、分析、起草或执行具体实现；不要重做任务决策。
用户任务：\n${task}\n总调度方案：\n${plan}\n${repair?`必须处理的返工意见：\n${repair}\n`:""}${comboGuidanceText()}
${allowTools?"本阶段允许按计划调用文件、命令和测试工具；未授权或不确定的破坏性操作必须停下说明。":"本阶段不得调用工具、读写文件或运行命令。"}
输出完整可交付成果，并清楚标出改动/命令/测试（如有）、不确定性、证据缺口和风险。
${comboBudgetInstruction(comboGetRole("executor"))}`;
}
function comboControllerAuditPrompt(task,plan,candidate,taskMode="general"){
  return `【组合任务｜${comboRoleName("controller")} 最终验收】
你负责监督和最终审计，不改文件、不跑命令。检查结果是否满足用户目标、方案、风险和验收标准。
用户任务：\n${task}\n方案：\n${plan}\n待验收成果：\n${candidate}\n${comboGuidanceText()}
只把会导致错误、安全问题、关键遗漏或不可交付的事项视为阻断；格式偏好和可选优化不得阻断。
最后严格写一行：
FINAL_AUDIT: PASS | REPAIR_EXECUTOR | BLOCK
若需返工，紧接着给「## 返工指令」，内容必须具体、可执行。高风险任务无法确认授权时使用 BLOCK。
${comboBudgetInstruction(comboGetRole("controller"))}`;
}
function comboRouteFromPlan(plan,fallback="general"){
  const match=String(plan||"").match(/ROUTE\s*:\s*(DIRECT|EXECUTOR_WITH_TOOLS|EXECUTOR|WORKER_AND_OPERATOR|WORKER|CLARIFY)/i);
  if(match){
    const route=match[1].toUpperCase();
    return route==="WORKER_AND_OPERATOR"?"EXECUTOR_WITH_TOOLS":route==="WORKER"?"EXECUTOR":route;
  }
  if(fallback==="simple") return "DIRECT";
  if(fallback==="clarify") return "CLARIFY";
  return /改文件|写代码|测试|命令|部署|安装|运行/i.test(String(plan||""))?"EXECUTOR_WITH_TOOLS":"EXECUTOR";
}
function comboRiskFromPlan(plan,fallback="MEDIUM"){
  return (String(plan||"").match(/RISK\s*:\s*(LOW|MEDIUM|HIGH)/i)||[])[1]?.toUpperCase()||fallback;
}
function comboFinalAuditDecision(text){
  const result=(String(text||"").match(/FINAL_AUDIT\s*:\s*(PASS|REPAIR_EXECUTOR|REPAIR_WORKER|REPAIR_OPERATOR|BLOCK)/i)||[])[1]?.toUpperCase()||"BLOCK";
  return result==="REPAIR_WORKER"||result==="REPAIR_OPERATOR"?"REPAIR_EXECUTOR":result;
}
function comboRepairBrief(text){
  const match=String(text||"").match(/##\s*返工指令\s*\n([\s\S]*?)(?=\n##|$)/i);
  return (match?match[1]:String(text||"")).trim().slice(0,6000);
}
function comboExtractFinal(rec,turnId){
  const turns=(rec&&rec.turns)||[], items=(rec&&rec.items)||[];
  const turn=turnId?turns.find(t=>t.id===turnId):turns[turns.length-1];
  const ids=new Set((turn&&turn.item_ids)||[]);
  const scoped=ids.size?items.filter(item=>ids.has(item.id)):items;
  for(let i=scoped.length-1;i>=0;i--){
    const item=scoped[i]||{};
    if(item.kind==="agent_message"){
      const text=String(item.detail||item.summary||"").trim();
      if(text) return text;
    }
  }
  return "";
}
function comboTurnStatus(rec,turnId){
  const turns=(rec&&rec.turns)||[];
  return (turnId?turns.find(t=>t.id===turnId):turns[turns.length-1])||null;
}
function comboTurnItems(rec,turnId){
  const turns=(rec&&rec.turns)||[], items=(rec&&rec.items)||[];
  const turn=turns.find(value=>value.id===turnId);
  const ids=new Set((turn&&turn.item_ids)||[]);
  if(ids.size) return items.filter(item=>ids.has(item.id));
  const tagged=items.filter(item=>item.turn_id===turnId);
  return tagged.length?tagged:[];
}
function comboRoleToolViolations(rec,turnId,roleKey,allowTools=false){
  if(comboRoleKey(roleKey)==="executor"&&allowTools) return [];
  return comboTurnItems(rec,turnId).filter(item=>{
    const kind=String(item.kind||"").toLowerCase();
    return kind.includes("tool")||kind.includes("command")||kind.includes("file_change")||
      kind.includes("web_search")||kind.includes("browser");
  });
}
function comboExecutionProfile(allowTools=false){
  const role=comboGetRole("executor");
  return allowTools?comboNormalizeRole({...role,provider:role.toolProvider||role.provider,model:role.toolModel||role.model},"executor"):role;
}
function comboRoleForRun(roleKey,allowTools=false){
  return comboRoleKey(roleKey)==="executor"?comboExecutionProfile(allowTools):comboGetRole(roleKey);
}
async function comboEnsureThread(roleKey,options={}){
  const key=comboRoleKey(roleKey), allowTools=!!options.allowTools, role=comboRoleForRun(key,allowTools);
  const threadStore=allowTools?(COMBO.session.tool_threads||(COMBO.session.tool_threads={})):COMBO.session.threads;
  let tid=threadStore[key];
  if(tid) return tid;
  const nativeEffort=comboNativeEffort(role);
  await api("/api/model-pref",{method:"POST",body:JSON.stringify({
    provider:role.provider,model:role.model,...(nativeEffort?{effort:nativeEffort}:{})
  })});
  const created=await api(`/cmp/${role.provider}/v1/threads`,{method:"POST",body:JSON.stringify({model:role.model})});
  tid=created.id||(created.thread&&created.thread.id);
  if(!tid) throw new Error(`${comboRoleName(role)} 创建线程失败`);
  threadStore[key]=tid;
  if(!allowTools) await api("/api/pin-combo-thread",{method:"POST",body:JSON.stringify({
    tid,provider:role.provider,session_id:COMBO.session.id,role:key,
    topic:COMBO.session.topic||"组合任务",roles:COMBO.roles
  })});
  comboPersist();
  return tid;
}
function comboCloseRunHandles(){
  if(COMBO.es){ try{ COMBO.es.close(); }catch(e){} COMBO.es=null; }
  if(COMBO.poll){ clearInterval(COMBO.poll); COMBO.poll=null; }
  if(COMBO.timeout){ clearTimeout(COMBO.timeout); COMBO.timeout=null; }
}
function comboUsesDirectTextRole(roleKey,allowTools=false){
  // Tool-free stages use plain compatible endpoints for providers whose runtime injects
  // endpoints for providers whose runtime injects tool schemas (Kimi/Qwen).
  const provider=comboRoleForRun(roleKey,allowTools).provider;
  return !allowTools&&["moonshot","qwen","zai","deepseek","volcengine","longcat","custom"].includes(provider);
}
function comboTextBudget(role){
  return role&&role.contextLength==="long"?12000:6000;
}
function comboFailureText(rec,turnId){
  const turn=comboTurnStatus(rec,turnId)||{};
  const items=comboTurnItems(rec,turnId);
  const values=[
    turn.error,turn.error_message,turn.detail,turn.summary,turn.message,
    ...items.slice().reverse().map(item=>item.error||item.detail||item.summary||item.message)
  ];
  for(const value of values){
    if(typeof value==="string"&&value.trim()) return value.trim().slice(0,900);
    if(value&&typeof value==="object"){
      const text=value.message||value.detail||value.summary||value.error||value.reason;
      if(typeof text==="string"&&text.trim()) return text.trim().slice(0,900);
    }
  }
  return "";
}
async function comboRunDirectTextRole(roleKey,prompt,options={}){
  if(COMBO.stopped) throw new Error("已停止");
  const role=comboRoleForRun(roleKey,!!options.allowTools);
  COMBO.currentProfile=role; COMBO.currentUsesTools=!!options.allowTools;
  COMBO.currentThread=""; COMBO.currentTurn="";
  comboSetPhase(roleKey,comboStatusLabel(roleKey));
  comboAddPhase(roleKey,roleKey==="controller"?"理解、规划、检查点或最终验收：不调用工具":options.allowTools?"执行模型正在使用已配置的工具后备模型":"执行阶段：研究、起草与分析，不改文件、不跑命令");
  const response=await api("/api/combo-text",{
    method:"POST",
    body:JSON.stringify({
      provider:role.provider,
      prompt,
      max_tokens:comboTextBudget(role)
    })
  });
  const text=String(response.text||"").trim();
  if(!text) throw new Error(`${comboRoleName(role)} 已结束但没有最终输出`);
  comboAddMessage("agent_message",text,{who:options.label||comboStatusLabel(roleKey),role:options.persistRole||roleKey});
  comboMarkRole(roleKey,"done");
  return text;
}
async function comboRunRole(roleKey,prompt,options={}){
  if(COMBO.stopped) throw new Error("已停止");
  const allowTools=!!options.allowTools;
  if(comboUsesDirectTextRole(roleKey,allowTools)) return comboRunDirectTextRole(roleKey,prompt,options);
  const key=comboRoleKey(roleKey), role=comboRoleForRun(key,allowTools), tid=await comboEnsureThread(key,{allowTools});
  COMBO.currentProfile=role; COMBO.currentUsesTools=allowTools;
  COMBO.currentThread=tid; COMBO.bag.activeId=tid;
  comboSetPhase(key,comboStatusLabel(key));
  comboAddPhase(key,key==="controller"?"理解、规划、检查点或最终验收：不调用工具":allowTools?`按已确认方案使用 ${comboProviderName(role.provider)} 的工具能力执行`:"研究、起草与分析，不改文件、不跑命令");
  await api(`/cmp/${role.provider}/v1/threads/${tid}`,{method:"PATCH",body:JSON.stringify({auto_approve:true,allow_shell:allowTools&&state.allowShell})}).catch(()=>{});
  let since=0;
  try{ const before=await api(`/cmp/${role.provider}/v1/threads/${tid}`); since=before.latest_seq||0; }catch(e){}
  const posted=await api(`/cmp/${role.provider}/v1/threads/${tid}/turns`,{method:"POST",body:JSON.stringify({prompt})});
  const turnId=(posted.turn&&posted.turn.id)||posted.id;
  if(!turnId) throw new Error(`${comboRoleName(role)} 未返回 turn id`);
  COMBO.currentTurn=turnId;
  return await new Promise((resolve,reject)=>{
    let done=false,lastRec=null,liveAgentIds=new Set(),cancel=null;
    const finish=(error)=>{
      if(done) return;
      done=true;
      if(COMBO.cancelCurrent===cancel) COMBO.cancelCurrent=null;
      comboCloseRunHandles();
      if(error){ reject(error); return; }
      const violations=comboRoleToolViolations(lastRec,turnId,roleKey,allowTools);
      if(violations.length){
        const kinds=[...new Set(violations.map(item=>item.kind||"tool"))].join("、");
        const violation=new Error(`${comboRoleName(role)} 违反角色边界，规划/复核阶段尝试调用工具（${kinds}）`);
        violation.code="COMBO_ROLE_TOOL_VIOLATION";
        reject(violation);
        return;
      }
      const text=comboExtractFinal(lastRec,turnId);
      if(!text){ reject(new Error(`${comboRoleName(role)} 已结束但没有最终输出`)); return; }
      const turns=(lastRec&&lastRec.turns)||[], items=(lastRec&&lastRec.items)||[];
      const turn=turns.find(value=>value.id===turnId);
      const ids=new Set((turn&&turn.item_ids)||[]);
      const agentItem=[...items].reverse().find(item=>item.kind==="agent_message"&&(!ids.size||ids.has(item.id)));
      const live=agentItem&&COMBO.bag.items&&COMBO.bag.items.get(agentItem.id);
      if(live&&live.el){
        const who=live.el.querySelector(".who");
        if(who) who.textContent=options.label||comboStatusLabel(roleKey);
        comboRecordMessage("agent_message",text,{id:agentItem.id,who:options.label||comboStatusLabel(roleKey),role:options.persistRole||roleKey});
      }else{
        comboAddMessage("agent_message",text,{who:options.label||comboStatusLabel(roleKey),role:options.persistRole||roleKey});
      }
      comboMarkRole(roleKey,"done");
      resolve(text);
    };
    cancel=()=>{
      const error=new Error("已停止");
      error.code="COMBO_STOPPED";
      finish(error);
    };
    COMBO.cancelCurrent=cancel;
    const sync=async()=>{
      try{
        lastRec=await api(`/cmp/${role.provider}/v1/threads/${tid}`);
        const turn=comboTurnStatus(lastRec,turnId);
        if(turn&&isTurnDone(turn.status)){
          if(normTurnStatus(turn.status)==="completed") finish();
          else{
            const detail=comboFailureText(lastRec,turnId);
            finish(new Error(`${comboRoleName(role)} ${turn.status||"执行失败"}${detail?`：${detail}`:""}`));
          }
        }
      }catch(e){}
    };
    COMBO.poll=setInterval(sync,3000); sync();
    const es=new EventSource(url(`/cmp/${role.provider}/v1/threads/${tid}/events?since_seq=${since}`));
    COMBO.es=es;
    for(const eventName of COMBO_EVENTS){
      es.addEventListener(eventName,event=>{
        let message; try{ message=JSON.parse(event.data); }catch(e){ return; }
        if(message.turn_id&&message.turn_id!==turnId) return;
        if(["item.started","item.delta","item.completed","item.failed","item.interrupted"].includes(eventName)){
          const payload=message.payload||{};
          const kind=(payload.item&&payload.item.kind)||payload.kind;
          if(kind!=="user_message"){
            COMBO.view.ingest(eventName,message);
            const itemId=(payload.item&&payload.item.id)||payload.item_id;
            if(kind==="agent_message"&&itemId) liveAgentIds.add(itemId);
            if(eventName==="item.completed"&&kind==="agent_message"&&itemId){
              const item=payload.item||payload;
              const text=String(item.detail||item.summary||"").trim();
              if(text) comboRecordMessage("agent_message",text,{id:itemId,who:comboStatusLabel(roleKey),role:roleKey});
            }
          }
        }
        if(["turn.completed","turn.failed","turn.interrupted"].includes(eventName)) setTimeout(sync,120);
      });
    }
    es.onerror=()=>sync();
    COMBO.timeout=setTimeout(()=>{ if(!done) finish(new Error(`${comboRoleName(role)} 超过 45 分钟仍未结束`)); },45*60*1000);
  });
}
async function comboRunPipeline(task){
  COMBO.busy=true; COMBO.stopped=false;
  COMBO.session.status="running";
  const taskMode=comboTaskMode(task);
  COMBO.session.task_mode=taskMode;
  comboSetGate(false,"检查点 0/4 · 总调度正在理解任务"); comboPersist(); setRunning(true);
  let artifacts=comboArtifacts();
  if(artifacts.task&&artifacts.task!==task){
    COMBO.session.artifacts={task:"",controllerPlan:"",executionResult:"",finalAudit:"",route:"",toolRequired:false,repairRound:0,checkpoints:[]};
    artifacts=comboArtifacts();
  }
  artifacts.task=task;
  try{
    if(taskMode==="simple"&&!comboTaskNeedsTools(task)){
      comboRecordCheckpoint("direct","直接交付",`${comboRoleName("controller")} 正在完成低风险任务`,"running");
      artifacts.executionResult=await comboRunRole("controller",comboControllerDirectPrompt(task),{label:`${comboRoleName("controller")} · 直接交付`});
      artifacts.finalAudit="总调度已完成轻量自检：PASS";
      COMBO.session.plan_passed=true; COMBO.session.audit_passed=true;
      COMBO.session.status="completed"; COMBO.session.phase="completed";
      comboRecordCheckpoint("complete","已闭环","低风险任务已直接交付", "pass");
      comboSetPhase("","全部完成"); comboPersist();
      return;
    }
    if(!artifacts.controllerPlan){
      comboRecordCheckpoint("plan","总调度规划",`${comboRoleName("controller")} 正在理解任务、设置路径和检查点`,"running");
      artifacts.controllerPlan=await comboRunRole("controller",comboControllerPlanPrompt(task,taskMode),{label:`${comboRoleName("controller")} · 任务理解与规划`});
      artifacts.route=comboTaskNeedsTools(task)
        ?"EXECUTOR_WITH_TOOLS"
        :comboRouteFromPlan(artifacts.controllerPlan,taskMode);
      artifacts.risk=comboRiskFromPlan(artifacts.controllerPlan,taskMode==="high"?"HIGH":"MEDIUM");
      COMBO.session.plan_passed=true;
      comboRecordCheckpoint("plan","规划已确认",`路径：${artifacts.route} · 风险：${artifacts.risk}`,"ready");
      comboPersist();
    }
    if(artifacts.route==="CLARIFY") throw new Error(`${comboRoleName("controller")} 需要补充任务目标、期望产出或允许的操作范围后才能继续`);
    if(artifacts.risk==="HIGH"&&!COMBO.session.high_risk_confirmed){
      comboRecordCheckpoint("risk","高风险确认","已完成方案；请在“流程控制”中确认后再进入执行阶段", "blocked");
      throw new Error("高风险任务已停在确认点：请先检查方案，再通过流程控制确认继续");
    }
    let candidate=artifacts.executionResult||"";
    let repairTarget=artifacts.repairTarget||"";
    let repair=artifacts.repairBrief||"";
    const allowTools=artifacts.route==="EXECUTOR_WITH_TOOLS"||artifacts.route==="WORKER_AND_OPERATOR";
    artifacts.toolRequired=allowTools;
    if(artifacts.route!=="DIRECT"&&(!artifacts.executionResult||repairTarget==="EXECUTOR")){
      const routeDetail=allowTools
        ?`${comboRoleName("executor")} 将按计划使用 ${comboProviderName(comboExecutionProfile(true).provider)} 的工具能力`
        :`${comboRoleName("executor")} 正在研究、起草或分析`;
      comboRecordCheckpoint("execute",allowTools?"执行模型工具处理中":"执行模型处理中",routeDetail,"running");
      artifacts.executionResult=await comboRunRole("executor",comboExecutorPrompt(task,artifacts.controllerPlan,repair,allowTools),{
        label:allowTools?`${comboRoleName("executor")} · 工具执行结果`:`${comboRoleName("executor")} · 执行成果`,allowTools
      });
      repairTarget=""; artifacts.repairTarget=""; artifacts.repairBrief="";
      candidate=artifacts.executionResult;
      comboRecordCheckpoint("execute","执行模型完成","等待总调度最终验收", "ready");
      comboPersist();
    }
    if(artifacts.route==="DIRECT"){
      candidate=await comboRunRole("controller",comboControllerDirectPrompt(task),{label:`${comboRoleName("controller")} · 直接交付`});
      artifacts.executionResult=candidate;
    }
    for(let round=Number(artifacts.repairRound||0);round<=COMBO.maxRepairRounds;round++){
      comboRecordCheckpoint("audit","总调度验收",`${comboRoleName("controller")} 正在检查交付物与验收标准`,"running");
      artifacts.finalAudit=await comboRunRole("controller",comboControllerAuditPrompt(task,artifacts.controllerPlan,candidate,taskMode),{label:`${comboRoleName("controller")} · 最终验收`});
      const decision=comboFinalAuditDecision(artifacts.finalAudit);
      if(decision==="PASS"){
        COMBO.session.audit_passed=true;
        COMBO.session.status="completed"; COMBO.session.phase="completed";
        comboRecordCheckpoint("complete","已闭环",`${comboRoleName("controller")} 已验收通过`,"pass");
        comboSetPhase("","全部完成"); comboPersist();
        return;
      }
      if(decision==="BLOCK") throw new Error(`${comboRoleName("controller")} 在验收中发现目标歧义或高风险阻断项，请补充或确认后继续`);
      if(round>=COMBO.maxRepairRounds) throw new Error(`已完成 ${COMBO.maxRepairRounds} 轮返工仍未通过验收，保留结果等待人工决定`);
      artifacts.repairRound=round+1;
      artifacts.repairTarget="EXECUTOR";
      artifacts.repairBrief=comboRepairBrief(artifacts.finalAudit);
      comboRecordCheckpoint("repair",`返工 ${artifacts.repairRound}/${COMBO.maxRepairRounds}`,`总调度已将明确修复指令交给 ${comboRoleName("executor")}`,"running");
      artifacts.executionResult=await comboRunRole("executor",comboExecutorPrompt(task,artifacts.controllerPlan,artifacts.repairBrief,allowTools),{
        label:`${comboRoleName("executor")} · 返工成果`,allowTools
      });
      candidate=artifacts.executionResult;
      artifacts.repairTarget=""; artifacts.repairBrief=""; comboPersist();
    }
  }catch(error){
    COMBO.session.status=COMBO.stopped?"interrupted":"blocked";
    COMBO.session.phase=COMBO.stopped?"interrupted":(COMBO.currentRole||"blocked");
    comboSetGate(false,COMBO.stopped?"用户已停止":"流程被复核或审计阻断");
    if(!COMBO.stopped){
      const box=document.createElement("div");
      box.className="combo-blocked";
      box.textContent=error.message||String(error);
      $("#mwrap").appendChild(box);
    }
    comboPersist();
  }finally{
    COMBO.busy=false; setRunning(false); comboCloseRunHandles();
    COMBO.currentTurn=""; COMBO.currentThread=""; COMBO.currentProfile=null; COMBO.currentUsesTools=false;
    comboSyncComposer();
    $("#input").focus();
  }
}
async function comboSteer(raw){
  const text=String(raw||"").trim();
  if(!text) return;
  const note={text,at:comboNow(),phase:COMBO.currentRole||"running"};
  comboGuidance().push(note);
  COMBO.session.guidance=comboGuidance().slice(-30);
  comboAddMessage("user_message",text,{who:"⤵ 引导",role:"guidance"});
  if(!COMBO.currentThread||!COMBO.currentTurn){
    comboPersist();
    cwToast("引导已保存，将在下一阶段生效");
    return;
  }
  const role=COMBO.currentProfile||comboGetRole(COMBO.currentRole);
  try{
    await api(`/cmp/${role.provider}/v1/threads/${COMBO.currentThread}/turns/${COMBO.currentTurn}/steer`,{
      method:"POST",body:JSON.stringify({prompt:`用户实时引导：${text}`})
    });
    cwToast(`已插入 ${comboStatusLabel(COMBO.currentRole)}，后续阶段也会继承`);
  }catch(error){
    cwToast("当前模型未接受实时插入，已保存到下一阶段");
  }
  comboPersist();
}
async function comboEnterSend(){
  if(!COMBO.active) return;
  const input=$("#input"), raw=String(input.value||"").trim();
  if(!raw&&!state.attachments.length) return;
  if(COMBO.busy){
    if(state.attachments.length){ cwToast("实时引导暂不支持附件，请先停止或等待下一阶段"); return; }
    input.value=""; input.style.height="auto";
    await comboSteer(raw);
    return;
  }
  input.value=""; input.style.height="auto";
  let task=raw;
  try{ task=await withAttachments(raw); }
  catch(error){ input.value=raw; cwToast(error.message||"附件准备失败"); return; }
  if(!COMBO.session.messages.length) COMBO.session.topic=comboTopic(raw);
  $("#ttitle").textContent=COMBO.session.topic;
  const artifacts=comboArtifacts();
  const blockedUnplannedTask=COMBO.session.status==="blocked"&&artifacts.task&&!artifacts.controllerPlan&&!COMBO.session.plan_passed;
  const retryingBlockedTask=blockedUnplannedTask&&artifacts.task===task;
  if(blockedUnplannedTask){
    if(!retryingBlockedTask){
      const note={text:task,at:comboNow(),phase:"retry"};
      comboGuidance().push(note);
      COMBO.session.guidance=comboGuidance().slice(-30);
      comboAddMessage("user_message",task,{who:"⤵ 补充/纠偏",role:"guidance"});
      cwToast("已保留原任务；本条作为补充信息后重新开始规划");
    }else{
      cwToast("正在重试此前未进入规划的任务，已保留原始输入");
    }
    task=artifacts.task;
  }else{
    comboAddMessage("user_message",task,{who:"你"});
  }
  const brief=document.createElement("div");
  brief.className="combo-understanding";
  brief.innerHTML=`<b>${esc(comboRoleName("controller"))} 正在理解与调度</b><span>会先展示目标、关键边界和后续路径；需要协作时再启用执行模型，必要时才使用工具后备模型。</span><span>运行中可直接在底部输入引导，立即纠偏当前阶段。</span>`;
  $("#mwrap").appendChild(brief);
  comboRunPipeline(task);
}
async function comboStop(){
  if(!COMBO.active||!COMBO.busy) return;
  COMBO.stopped=true;
  const cancel=COMBO.cancelCurrent;
  let interrupt=null;
  if(COMBO.currentThread&&COMBO.currentTurn){
    const role=COMBO.currentProfile||comboGetRole(COMBO.currentRole);
    interrupt=api(`/cmp/${role.provider}/v1/threads/${COMBO.currentThread}/turns/${COMBO.currentTurn}/interrupt`,{method:"POST",body:"{}"}).catch(()=>{});
  }
  if(cancel) cancel();
  else COMBO.busy=false;
  comboCloseRunHandles();
  setRunning(false);
  comboSetPhase("","已停止");
  comboSyncComposer();
  if(interrupt) await interrupt;
}
async function comboToggleShell(){
  state.allowShell=!state.allowShell; renderShell();
  for(const [key,tid] of Object.entries((COMBO.session&&COMBO.session.threads)||{})){
    const normalized=comboRoleKey(key), role=COMBO.roles[normalized]||COMBO.roles.controller;
    await api(`/cmp/${role.provider}/v1/threads/${tid}`,{method:"PATCH",body:JSON.stringify({allow_shell:false})}).catch(()=>{});
  }
  for(const [key,tid] of Object.entries((COMBO.session&&COMBO.session.tool_threads)||{})){
    const role=comboExecutionProfile(true);
    await api(`/cmp/${role.provider}/v1/threads/${tid}`,{method:"PATCH",body:JSON.stringify({allow_shell:key==="executor"&&state.allowShell})}).catch(()=>{});
  }
}
async function comboToggleAuto(){
  state.autoApprove=!state.autoApprove; renderAuto();
  for(const [key,tid] of Object.entries((COMBO.session&&COMBO.session.threads)||{})){
    const role=COMBO.roles[comboRoleKey(key)]||COMBO.roles.controller;
    await api(`/cmp/${role.provider}/v1/threads/${tid}`,{method:"PATCH",body:JSON.stringify({auto_approve:state.autoApprove})}).catch(()=>{});
  }
}
function comboNewSession(){
  if(COMBO.busy){ cwToast("请先停止当前组合流程"); return; }
  COMBO.session=comboMakeSession();
  COMBO.currentRole=""; COMBO.currentThread=""; COMBO.currentTurn="";
  comboSetGate(false,"等待调度"); comboSetPhase("","等待任务");
  $("#ttitle").textContent="组合模型";
  comboRenderStored(); comboPersist(); $("#input").focus();
}

function comboOpenIntervene(){
  if(!COMBO.active) return;
  const artifacts=comboArtifacts();
  const waitingRisk=artifacts.risk==="HIGH"&&!COMBO.session.high_risk_confirmed;
  openModal("控制组合流程","sliders");
  const body=$("#modalBody");
  body.innerHTML=`<div class="combo-intervention">
    <div class="combo-intervention-status">当前阶段：<b>${esc(COMBO.currentRole?comboStatusLabel(COMBO.currentRole):COMBO.session.status||"等待任务")}</b></div>
    <div class="combo-intervention-actions">
      <button id="comboIvStop" class="danger">停止当前模型</button>
      <button id="comboIvRestart" ${artifacts.task?"":"disabled"}>继续当前流程</button>
      <button id="comboIvRisk" ${waitingRisk&&!COMBO.busy?"":"disabled"}>确认高风险操作并继续</button>
      <button id="comboIvReset" ${COMBO.busy?"disabled":""}>从当前任务重新规划</button>
    </div>
    <p class="combo-intervention-note"><b>继续当前流程：</b>保留任务理解、检查点和引导，只从未完成或被打回的环节继续。<br><b>高风险确认：</b>只在方案已标为高风险时出现，确认后才会进入执行阶段。<br><b>引导：</b>运行中可直接在底部输入并回车，补充内容会插入当前模型并带入后续阶段。</p>
  </div>`;
  $("#comboIvStop").onclick=async()=>{ closeModal(); await comboStop(); };
  $("#comboIvRestart").onclick=()=>{ if(COMBO.busy){ cwToast("请先停止当前模型"); return; } closeModal(); comboRunPipeline(artifacts.task); };
  $("#comboIvRisk").onclick=()=>{
    if(!waitingRisk) return;
    COMBO.session.high_risk_confirmed=true;
    comboPersist(); closeModal(); comboRunPipeline(artifacts.task);
  };
  $("#comboIvReset").onclick=()=>{
    if(COMBO.busy) return;
    COMBO.session.artifacts={task:artifacts.task,controllerPlan:"",executionResult:"",finalAudit:"",route:"",toolRequired:false,repairRound:0,checkpoints:[]};
    COMBO.session.plan_passed=false; COMBO.session.audit_passed=false; COMBO.session.high_risk_confirmed=false;
    comboPersist(); closeModal(); comboRunPipeline(artifacts.task);
  };
}

export {
  COMBO,COMBO_DEFAULT_ROLES,COMBO_CAPABILITIES,openComboWindow,initComboWindow,comboOpenRoleConfig,
  comboEnterSend,comboStop,comboToggleShell,comboToggleAuto,comboNewSession,comboRunPipeline,
  comboOpenIntervene,comboSteer
};
