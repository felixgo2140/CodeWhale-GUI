let balanceSeq=0;
async function loadBalance(providerOverride){
  const el=$("#balance");
  if(!el) return;
  const fmtMoney=(x)=>{
    const sym=x.currency==="CNY"?"¥":(x.currency==="USD"?"$":(x.currency||""));
    return x.amount!=null ? `${sym}${(+x.amount).toFixed(2)}` : "—";
  };
  const oneLine=(x)=>{
    if(!x) return "余额 —";
    const name=(typeof PROV_SHORT!=="undefined"&&(PROV_SHORT[x.provider]||x.label))||x.label||x.provider||"余额";
    if(x.kind==="money") return `${name} ${fmtMoney(x)}`;
    if(x.kind==="quota"){
      const pct=x.percent!=null?Math.round(x.percent):null;
      return pct!=null ? `${name} ${x.window||""} ${pct}%`.replace(/\s+/g," ").trim() : `${name} —`;
    }
    if(x.kind==="error"||x.error) return `${name} ⚠`;
    if(x.litellm&&x.litellm.spend!=null) return `${name} spend $${(+x.litellm.spend).toFixed(2)}`;
    return `${name} —`;
  };
  const tipLine=(x)=>{
    if(!x) return "";
    const name=(typeof PROV_SHORT!=="undefined"&&(PROV_SHORT[x.provider]||x.label))||x.label||x.provider||"provider";
    if(x.kind==="money") return `${name}: 官方余额 ${fmtMoney(x)}`;
    if(x.kind==="quota") return `${name}: ${x.window||""} 用量 ${x.percent!=null?Math.round(x.percent)+"%":"?"}${x.limit?` (${x.used||0}/${x.limit})`:""}`;
    if(x.kind==="error"||x.error) return `${name}: 读取失败 ${x.error||""}`;
    if(x.litellm&&x.litellm.spend!=null) return `${name}: 无官方余额接口; LiteLLM spend $${(+x.litellm.spend).toFixed(2)}${x.litellm.max_budget?` / budget $${(+x.litellm.max_budget).toFixed(2)}`:""}`;
    return `${name}: ${x.hint||x.reason||"暂无已接入余额接口"}`;
  };
  const prov=providerOverride||window._activeChatProv||window._newchatProv||"";
  const seq=++balanceSeq;
  const expectedProvider=()=>window._activeChatProv||window._newchatProv||"";
  if(prov){
    const name=(typeof PROV_SHORT!=="undefined"&&(PROV_SHORT[prov]||prov))||prov;
    el.textContent=`${name} …`;
  }
  try{
    const d=await api("/api/balance"+(prov?`?provider=${encodeURIComponent(prov)}`:""));
    if(seq!==balanceSeq || (prov||"")!==(expectedProvider()||"")) return;
    const cur=d.current||d;
    el.textContent=oneLine(cur);
    const lines=[];
    if(d.items&&Array.isArray(d.items)) d.items.forEach(x=>{ const line=tipLine(x); if(line) lines.push(line); });
    else lines.push(tipLine(cur));
    if(d.litellm){
      const l=d.litellm;
      lines.push(l.running
        ? `LiteLLM: proxy 已运行${l.spend!=null?`, 近似 spend $${(+l.spend).toFixed(2)}`:""}`
        : `LiteLLM: ${l.installed?"已安装但 proxy 未运行/未配置":"未安装或未在 PATH"}${l.error?` (${l.error})`:""}`);
    }
    el.title=lines.filter(Boolean).join("\n");
  }catch(e){
    if(seq!==balanceSeq || (prov||"")!==(expectedProvider()||"")) return;
    el.textContent="余额 ⚠"; el.title="前端拿余额失败:"+(e&&e.message||e);
  }
}
let updInfo=null;
async function loadVersion(){
  try{ const d=await api("/v1/runtime/info"); if(d.codewhale_version) $("#version").textContent="v"+d.codewhale_version; }catch{}
}
async function checkUpdate(){
  try{
    const d=await api("/api/update/check");
    updInfo=d;
    if(d.current) $("#version").textContent=(""+d.current).replace(/^v?/,"v");
    const btn=$("#updbtn");
    if(d.available && d.latest && !btn.classList.contains("busy")){ btn.style.display="inline-block"; btn.textContent=`↑ ${d.latest}`; btn.title=`有新版 ${d.latest},点击更新`; }
    else if(!d.available){ btn.style.display="none"; }
  }catch(e){ console.warn(e); }
}
async function doUpdate(){
  const btn=$("#updbtn");
  if(btn.classList.contains("busy")) return;
  if(!(await cwConfirm(`更新 CodeWhale 到 ${updInfo&&updInfo.latest||"最新版"}?\n会下载新版并重启后端(约 1 分钟;当前会话数据不受影响)`))) return;
  btn.classList.add("busy"); btn.textContent="更新中…";
  try{
    const r=await api("/api/update/apply",{method:"POST",body:"{}"});
    if(r.ok){ btn.textContent="✓ 重启中…"; scheduleReloadIfConnected(btn, 4500); }
    else { btn.classList.remove("busy"); btn.textContent="✗ 重试"; alert("更新失败:\n"+(r.output||"")); }
  }catch(e){ btn.classList.remove("busy"); btn.textContent="✗ 重试"; alert("更新出错: "+e.message); }
}
let guiUpd=null;
async function checkGuiUpdate(){
  try{
    const d=await api("/api/update/gui/check");
    guiUpd=d; const btn=$("#guiupdbtn");
    if(d.available && d.latest && !btn.classList.contains("busy")){
      btn.style.display="inline-block"; btn.textContent="↑ 界面 "+d.latest;
      btn.title="界面有新版 "+d.latest+(d.notes?("\n"+d.notes):"")+"\n点击下载、验签后更新(会话不受影响)";
    } else if(!btn.classList.contains("busy")) btn.style.display="none";
  }catch(e){ console.warn(e); }
}
async function doGuiUpdate(){
  const btn=$("#guiupdbtn");
  if(btn.classList.contains("busy")) return;
  const v=(guiUpd&&guiUpd.latest)||"新版";
  if(!(await cwConfirm(`更新界面到 ${v}?\n会从你配置的来源下载、校验数字签名 + SHA-256 后替换并重启(几秒;会话数据不受影响)。`))) return;
  btn.classList.add("busy"); btn.textContent="更新中…";
  try{
    const r=await api("/api/update/gui/apply",{method:"POST",body:"{}"});
    if(r.ok){ btn.textContent="✓ 重启中…"; scheduleReloadIfConnected(btn, 4500); }
    else { btn.classList.remove("busy"); btn.textContent="↑ 界面 "+v; alert("更新失败:\n"+(r.error||"")); }
  }catch(e){ btn.classList.remove("busy"); btn.textContent="↑ 界面 "+v; alert("更新出错: "+e.message); }
}

/* ---------- 深度研究入口:引擎选择器 + 轻量引导 ---------- */
// 多套研究引擎并列,不是兜底关系。研究方法/skill 作为方法提示对所有引擎生效;
// "我的方法论"会直接在 CodeWhale 当前对话里跑,外部 harness 则把方法描述写进 prompt 让 LLM 自行融合。
// 视角结构默认全开,作为候选素材池交给 LLM 按主题取舍;引擎只决定组装好的 prompt 发去哪。
let _dfEngine="deerflow";
const DF_ENGINES=[
 {k:"deerflow",ico:"flask",name:"DeerFlow",ed:"重型深研:多轮搜索+全文抓取+可挂研究 skill",
  title:"DeerFlow 深度研究",btn:"开始深度研究",api:"/api/deerflow",skills:true,
  hint:"<b>DeerFlow</b>:最像完整研究团队,会多轮搜索、抓全文、在 sandbox 写最终报告。适合股票/公司/行业的重型研究,尤其适合叠加你的投资或行业 skill。推荐问法:研究对象 + 时间范围 + 必答问题 + 输出结构。"},
 {k:"gptr",ico:"file",name:"GPT Researcher",ed:"快而规整:规划→并行搜索→引用报告",
  title:"GPT Researcher 深度研究",btn:"开始研究",api:"/api/harness/gptr",skills:true,
  hint:"<b>GPT Researcher</b>:先规划问题,再并行搜索多来源,最后生成引用较规整的报告。适合快速摸清一个主题、做竞品/公司/事件 briefing。需要 Kimi/Moonshot embedding key 和 Tavily。"},
 {k:"odr",ico:"layout",name:"Open Deep Research",ed:"宽题深挖:监督者+子研究员分解研究",
  title:"Open Deep Research",btn:"开始深研",api:"/api/harness/odr",skills:true,
  hint:"<b>Open Deep Research</b>:LangGraph 监督者把宽问题拆给多个子研究员,再压缩综合。适合政策、产业链、复杂主题的系统研究。首次启动 langgraph dev 可能多等约 1 分钟。"},
 {k:"storm",ico:"message",name:"STORM",ed:"综述长文:多视角提问→大纲→百科式文章",
  title:"STORM 长文综述",btn:"生成长文",api:"/api/harness/storm",skills:true,
  hint:"<b>STORM</b>:模拟多个专家视角提问,生成大纲,再写成维基百科式长文。适合行业背景、技术路线、历史脉络和教育型综述。不适合短线行情判断,通常较慢。"},
 {k:"agentloop",ico:"repeat",name:"Agent Loop",ed:"自我修正:计划→初稿→批判→补搜→定稿",
  title:"Agent Loop 深度研究",btn:"跑 Agent Loop",api:"/api/harness/agentloop",skills:true,
  hint:"<b>Agent Loop</b>:轻量工作流,先规划和搜索,写初稿后自我审稿,按缺口补搜再定稿。适合要求可证伪、要反方观点、需要二次检查的研究,也适合比较不同模型的稳定性。"},
 {k:"pydai",ico:"puzzle",name:"Pydantic AI",ed:"结构稳定:搜索取材→schema 校验→字段化报告",
  title:"Pydantic AI 结构化研究",btn:"生成结构化报告",api:"/api/harness/pydai",skills:true,
  hint:"<b>Pydantic AI</b>:先联网取材,再用 Pydantic schema 固定输出字段。适合品牌/公司/竞品/技术调研,需要关键发现、风险、观察清单等稳定结构时很好用。不擅长实时硬数据抓取。"},
 {k:"browser",ico:"globe",name:"browser-use",ed:"网页操作:打开网页→点击/滚动→提取动态内容",
  title:"browser-use 网页操作",btn:"运行浏览器任务",api:"/api/harness/browser",skills:true,
  hint:"<b>browser-use</b>:让 agent 像人一样打开网页、点击、滚动、读取 JS 动态内容。适合 Google Trends、Seeking Alpha 页面、App 排名、评论区、登录后手动可见页面等 API 难抓的数据。默认不登录、不提交表单、不输入敏感信息。"},
 {k:"crew",ico:"users",name:"CrewAI",ed:"多角色委员会:事实→正方→反方→总编",
  title:"CrewAI 多角色研究",btn:"启动 Crew",api:"/api/harness/crew",skills:true,
  hint:"<b>CrewAI</b>:固定四个角色:事实研究员、正方/多头、反方/空头、总编。适合投资委员会、品牌/竞品辩论、战略方案评审。搜索由桥接脚本先完成,再交给多角色审议。"},
 {k:"obsidian",ico:"folder",name:"Obsidian / LlamaIndex",ed:"私人知识库:Vault + CodeWhale/Codex 记录→引用回答",
  title:"私人知识库 / 工作记录",btn:"查询知识库",api:"/api/harness/obsidian",skills:false,
  hint:"<b>Obsidian / LlamaIndex</b>:索引你在 Harness 配置中指定的 Obsidian vault 里的 .md/.txt,并把本机 CodeWhale/Codex 对话记录转成脱敏 markdown 后纳入检索。回答时只把命中的少量片段发给 LLM,并引用来源路径。"},
 {k:"skill",ico:"compass",name:"我的方法论",ed:"最贴身:所选研究 skill 在当前对话模型里跑",
  title:"方法论研究",btn:"用方法论研究",skills:true,
  hint:"<b>我的方法论</b>:不用外部 harness,直接让当前 CodeWhale 模型按你选的 research skill 执行。适合已有固定投资框架、想边做边追问、需要保留在当前对话上下文里的任务。"}];
const DF_REFINE=[
 {k:"bull_bear",lb:"多空对决",line:"多空各 3 条最强论据,每条带数据;最后给净结论与置信度(0-10)。"},
 {k:"numbers",lb:"数字+来源",line:"每个论点带具体数字,标注数据时间点与来源。"},
 {k:"catalyst",lb:"催化剂时间表",line:"列未来 6-12 个月关键催化剂与风险的时间表(尽量给具体日期/节点)。"},
 {k:"compete",lb:"竞争格局",line:"和主要对手逐项对比,给市占率与相对优劣。"},
 {k:"contrarian",lb:"反共识",line:"明确指出市场共识、当前价格已计入什么,以及市场最可能错在哪里。"},
 {k:"risk",lb:"风险清单",line:"单列风险清单,标注每条的触发条件与可观察的证伪信号。"}];
// 研究 skill 多选:来自服务端 research_skills.json(用 Claude Code 增删,面板自动出现)。
// 所有引擎都会收到这些方法提示;能直接加载 skill 的引擎加载,不能加载的按描述执行。
let RESEARCH_SKILLS=[], _dfSkills=new Set();
async function loadResearchSkills(){ try{ const r=await api("/api/research-skills"); if(Array.isArray(r)){ RESEARCH_SKILLS=r; if(!_dfSkills.size && r[0]) _dfSkills.add(r[0].skill); renderDfSkills(); applyDfEngine(); } }catch(e){} }
function renderDfSkills(){
  const box=$("#dfSkillPick"); if(!box) return; box.innerHTML="";
  RESEARCH_SKILLS.forEach(s=>{
    const b=document.createElement("button"); b.className="dfref"+(_dfSkills.has(s.skill)?" on":""); b.title=s.desc||s.skill;
    b.innerHTML=`${icon("compass")} ${esc(s.label||s.skill)}`;
    b.onclick=()=>{ _dfSkills.has(s.skill)?_dfSkills.delete(s.skill):_dfSkills.add(s.skill); b.classList.toggle("on",_dfSkills.has(s.skill)); };
    box.appendChild(b);
  });
}
function openDeerFlow(){
  renderDfEngines(); renderDfTemplates(); renderDfSkills(); applyDfEngine();
  $("#plugindrop").classList.remove("show"); $("#dfmodal").classList.add("show"); setTimeout(()=>$("#dfprompt").focus(),100);
}
function renderDfEngines(){
  const box=$("#dfEngines"); if(!box||box.childElementCount) return;
  DF_ENGINES.forEach(e=>{
    const d=document.createElement("div"); d.className="dfeng"+(e.k===_dfEngine?" on":""); d.dataset.k=e.k;
    d.innerHTML=`<div class="en">${icon(e.ico||"flask")} ${esc(e.name)}</div><div class="ed">${esc(e.ed)}</div>`;
    d.onclick=()=>{ _dfEngine=e.k; box.querySelectorAll(".dfeng").forEach(x=>x.classList.toggle("on",x.dataset.k===e.k)); applyDfEngine(); };
    box.appendChild(d);
  });
}
function applyDfEngine(){   // 引擎切换 → 同步标题/说明/按钮文案;研究方法区对所有引擎显示
  const e=DF_ENGINES.find(x=>x.k===_dfEngine)||DF_ENGINES[0];
  const T=$("#dfTitle"); if(T) T.innerHTML=icon(e.ico||"flask")+"<span>"+esc(e.title)+"</span>";
  const H=$("#dfHint"); if(H) H.innerHTML=e.hint;
  const B=$("#dfSubmitBtn"); if(B) B.textContent=e.btn;
  const W=$("#dfSkillWrap"); if(W) W.hidden=!RESEARCH_SKILLS.length;
}
// 研究视角/结构默认全开:它们是候选素材池,提交时合并给 LLM,由模型按主题自动匹配取舍。
// 不再往输入框填模板——输入框只写"研究对象/问题",点掉某个 chip 表示明确排除该视角。
const DF_TEMPLATES=[
 {k:"stock",ico:"hash",t:"个股深研",tpl:`1) 生意本质与收入结构(最新季度具体数字);
2) 行业地位与竞争格局(市占率,和主要对手逐项对比);
3) 增长驱动与瓶颈(未来 2-3 年,尽量量化);
4) 财务质量(毛利率/自由现金流/负债 三年趋势);
5) 估值与市场预期(当前倍数 vs 历史区间 vs 同行,当前价格已计入什么预期);
6) 未来 6-12 个月关键催化剂与风险时间表。`},
 {k:"sector",ico:"factory",t:"行业格局",tpl:`1) 上中下游环节拆解,各环节价值量占比;
2) 每个环节的瓶颈与定价权(谁最稀缺、谁在挤压谁);
3) 竞争格局:各环节 Top3 玩家 + 市占率数字;
4) 当前周期位置(供需缺口/库存/资本开支趋势,用数据判断);
5) 未来 2-3 年最大变量与颠覆风险;
6) 受益顺序:哪些环节和公司最先受益,给出传导逻辑。`},
 {k:"bullbear",ico:"scale",t:"多空对决",tpl:`- 多方 3 条最强论据,每条带最新数据/证据;
- 空方 3 条最强论据,每条带最新数据/证据;
- 当前市场共识是什么,价格大概已计入多少;
- 胜负手:未来 6 个月哪个可观察信号能证伪其中一方;
- 两边论据强度对等不偏袒,最后给净结论与置信度(0-10)。`},
 {k:"event",ico:"calendar",t:"事件影响",tpl:`1) 事件事实梳理(时间线 + 关键数字);
2) 直接受益/受损标的清单与传导逻辑;
3) 市场已有的定价反应 vs 合理影响幅度(过度还是不足);
4) 二阶效应:被忽视的间接影响;
5) 后续跟踪节点与验证信号(具体日期/数据口径)。`},
 {k:"cycle",ico:"repeat",t:"周期位置",tpl:`1) 判断当前处在周期的哪个阶段(复苏/扩张/过热/下行),给证据;
2) 供需缺口、库存、价格、开工率/利用率、资本开支五类指标逐项看;
3) 对比历史周期:本轮和上轮/典型周期有什么相同与不同;
4) 给出拐点信号清单:哪些数据连续变化会改变结论;
5) 分上行/基准/下行情景,估计未来 4-8 个季度的路径。`},
 {k:"valuation",ico:"coins",t:"估值定价",tpl:`1) 当前估值:市值/EV/PE/PB/PS/EV-EBITDA/FCF yield,按适用指标选择;
2) 历史区间与同行对比,解释为什么应溢价或折价;
3) 反推市场预期:当前价格隐含的收入、利润率、增长或周期假设;
4) 三情景估值:乐观/基准/悲观,列关键假设和敏感性;
5) 安全边际与风险收益比:上涨空间、下跌空间、触发条件。`},
 {k:"finance",ico:"receipt",t:"财务拆解",tpl:`1) 收入拆解:量/价/mix/地区/客户/产品线变化;
2) 毛利率与费用率:拆出结构性改善和周期性波动;
3) 现金流质量:经营现金流、自由现金流、营运资本、资本开支;
4) 资产负债表:债务期限、现金、存货、应收、减值风险;
5) 单位经济模型:关键业务的单价、成本、利润弹性。`},
 {k:"supply",ico:"plug",t:"供应链卡位",tpl:`1) 产业链地图:上游材料/设备/核心零部件/制造/渠道/终端;
2) 每个环节的瓶颈、替代难度、议价权和国产/海外依赖;
3) 关键供应商与客户:集中度、锁定关系、切换成本;
4) 谁捕获最大价值量,谁承担最大库存/价格风险;
5) 供应链扰动情景:断供、涨价、扩产、认证失败分别影响谁。`},
 {k:"tech",ico:"flask",t:"技术路线",tpl:`1) 技术路线图:当前代际、下一代节点、关键参数和时间表;
2) 与领先者/替代路线对比:性能、成本、良率、生态、可扩展性;
3) 技术壁垒来源:专利、know-how、设备、数据、客户认证、人才;
4) 研发进展证据:论文/专利/量产节点/客户测试/资本开支;
5) 技术失败或被替代的风险与可观察信号。`},
 {k:"governance",ico:"shield",t:"治理结构",tpl:`1) 股权结构、控制权、少数股东权益、VIE/协议安排(如有);
2) 管理层履历、激励机制、历史资本配置质量;
3) 关联交易、补贴、资产注入/剥离、融资和稀释风险;
4) 利润真正归属:合并报表利润 vs 归母/可分配现金流;
5) 治理折价或溢价应该如何体现在估值里。`},
 {k:"policy",ico:"compass",t:"政策监管",tpl:`1) 政策/监管框架:主管部门、规则、许可、补贴、限制;
2) 最新政策变化的时间线和关键条款;
3) 对收入、成本、竞争格局、资本开支的传导路径;
4) 地缘政治/出口管制/反垄断/安全审查等尾部风险;
5) 政策验证信号:公告、听证、清单、补贴拨付、执法案例。`},
 {k:"global",ico:"globe",t:"海外对标",tpl:`1) 选择 3-5 个海外/国内可比公司或案例,说明可比性和差异;
2) 对比规模、增速、利润率、ROIC、研发强度、资本开支、估值;
3) 复盘海外龙头成长路径和关键拐点,判断本标的能否复制;
4) 找出市场可能误用的类比,说明哪些地方不能简单对标;
5) 给出合理估值锚和长期天花板。`},
 {k:"customer",ico:"briefcase",t:"客户需求",tpl:`1) 核心客户是谁,需求由什么预算/场景/痛点驱动;
2) 客户采购决策链:认证周期、价格敏感度、切换成本、续约机制;
3) 需求强度证据:订单、积压、使用量、渗透率、客户 capex/opex;
4) 客户集中度与流失风险,大客户议价能力;
5) 未来需求变化:新场景、新预算、新替代品的影响。`}];
let _dfTpls=new Set(DF_TEMPLATES.map(x=>x.k));   // 默认全开,LLM 自动取舍
function renderDfTemplates(){
  const box=$("#dftpls"); if(!box||box.childElementCount) return;   // 只渲染一次
  DF_TEMPLATES.forEach(x=>{
    const b=document.createElement("button"); b.className="dftpl"+(_dfTpls.has(x.k)?" on":""); b.innerHTML=`${icon(x.ico||"file")} ${esc(x.t)}`;
    b.onclick=()=>{ _dfTpls.has(x.k)?_dfTpls.delete(x.k):_dfTpls.add(x.k); b.classList.toggle("on",_dfTpls.has(x.k)); };
    box.appendChild(b);
  });
}
function closeDeerFlow(){ $("#dfmodal").classList.remove("show"); }
// (原「⚡ 快速 DeerFlow」菜单项已删——和「深度研究」是同一后端,只是往输入框填 /df 前缀;/df 手打仍然可用)
/* ---------- 插件位:+ 菜单 ----------
   插件包来自 ~/.codewhale-gui/plugins/<id> 的 plugin.json/.codex-plugin/plugin.json;
   老的 ~/.codewhale-gui/plugins.json 仍作为文本模板保留。点击任一项 = 填进当前聊天框,用户补完任务再发。 */
let PLUGINS=[], PLUGIN_PACKS=[], HARNESSES=[], _pluginsLoaded=false, _pluginsLoading=null;
const DEFAULT_CHINESE_OUTPUT_LINE="除非我明确要求英文或其他语言，最终面向我的输出默认使用简体中文；代码、命令、路径、API 名、英文专有名词和必要原文引用可保留原文。";
async function loadPlugins(){
  if(_pluginsLoading) return _pluginsLoading;
  _pluginsLoading=(async()=>{
    try{
      const res=await Promise.allSettled([api("/api/plugins"), api("/api/codex-plugins"), api("/api/harnesses")]);
      const custom=res[0].status==="fulfilled" ? res[0].value : [];
      const packs=res[1].status==="fulfilled" ? res[1].value : [];
      const harnesses=res[2].status==="fulfilled" ? res[2].value : [];
      PLUGINS=Array.isArray(custom)?custom:[];
      PLUGIN_PACKS=Array.isArray(packs)?packs.filter(p=>p&&p.enabled&&!p.error):[];
      HARNESSES=Array.isArray(harnesses)?harnesses.filter(h=>h&&h.available):[];
      _pluginsLoaded=true;
      renderPlugins();
      if($("#cmpPlugindrop")?.classList.contains("show")) renderCmpPlugins({skipLoad:true});
    }catch(e){ _pluginsLoaded=false; }
    finally{ _pluginsLoading=null; }
  })();
  return _pluginsLoading;
}
function pluginSection(box, label){
  const d=document.createElement("div"); d.className="plugsec"; d.textContent=label; box.appendChild(d);
}
function engineForHarness(h){
  const id=String(h&&h.id||"");
  return DF_ENGINES.find(e=>e.k===id)||null;
}
function harnessSlash(h){
  const id=String(h&&h.id||"deerflow");
  return id==="deerflow" ? "/df " : `/${id} `;
}
function fillHarnessComposer(h){
  const inp=$("#input"); if(!inp) return;
  const prefix=harnessSlash(h);
  const existing=inp.value.trim();
  fillComposer(existing&& !existing.startsWith("/") ? prefix+existing : (existing||prefix));
}
function pluginSkillPathHint(p, skill=""){
  const root=String(p.path||"").replace(/\/$/, "");
  if(!root) return "";
  const bare=String(skill||"").split(":").pop();
  const skills=Array.isArray(p.skills)?p.skills.filter(Boolean):[];
  if(bare){
    for(const base of skills){
      const b=String(base||"").replace(/\/$/, "");
      if(b.endsWith(`/${bare}`)) return `${b}/SKILL.md`;
      return `${b}/${bare}/SKILL.md`;
    }
    return `${root}/skills/${bare}/SKILL.md`;
  }
  if(skills.length===1) return `${String(skills[0]).replace(/\/$/, "")}/SKILL.md`;
  return "";
}
function pluginLocatorLines(p, skill=""){
  const id=String(p.id||p.name||"plugin");
  const bare=String(skill||"").split(":").pop();
  const skillPath=pluginSkillPathHint(p, bare);
  const lines=[
    "插件定位信息（供 LLM 精确加载，不要忽略）：",
    `- plugin id: ${id}`,
    p.path?`- plugin root: ${p.path}`:"",
    p.manifest?`- manifest: ${p.manifest}`:"",
    bare?`- skill name: ${bare}`:"",
    skillPath?`- skill path: ${skillPath}`:"",
    p.skillInstructions?`- plugin skillInstructions: ${p.skillInstructions}`:""
  ].filter(Boolean);
  return lines.join("\n");
}
function pluginPackPrompt(p, existing=""){
  const id=String(p.id||p.name||"plugin");
  const display=String(p.displayName||p.name||id);
  const names=Array.isArray(p.skill_names)?p.skill_names:[];
  const start=(p.sessionStart&&p.sessionStart.skill)
    || names.find(n=>/^using[-_]superpowers$/i.test(n))
    || names.find(n=>/^using[-_]/i.test(n))
    || names.find(n=>/brainstorm/i.test(n))
    || "";
  const startName=start?(start.includes(":")?start:`${id}:${start}`):"";
  const startBare=start?(start.includes(":")?start.split(":").pop():start):"";
  const examples=names.filter(n=>n!==start).slice(0,8).map(n=>`${id}:${n}`).join("、");
  const lines=[
    `请使用 ${display} 插件${startName?`，优先调用/加载 \`${startBare}\` skill（菜单路径 \`${startName}\`）`:""}。`,
    examples?`需要时自动选择这些 skill：${examples}。`:"请根据任务自动选择这个插件提供的合适 skill。",
    pluginLocatorLines(p, startBare),
    DEFAULT_CHINESE_OUTPUT_LINE,
    "我的任务：",
    existing.trim()
  ].filter(Boolean);
  return lines.join("\n");
}
function pluginSkillPrompt(p, skill, existing=""){
  const id=String(p.id||p.name||"plugin");
  const display=String(p.displayName||p.name||id);
  const full=skill.includes(":")?skill:`${id}:${skill}`;
  const bare=skill.includes(":")?skill.split(":").pop():skill;
  return [
    `请使用 ${display} 插件里的 \`${full}\` skill；在 CodeWhale 对话里请优先调用/加载 \`${bare}\`。`,
    pluginLocatorLines(p, bare),
    DEFAULT_CHINESE_OUTPUT_LINE,
    "我的任务：",
    existing.trim()
  ].filter(Boolean).join("\n");
}
function pluginSkillItems(p){
  if(Array.isArray(p.skill_items) && p.skill_items.length) return p.skill_items.filter(x=>x&&x.name);
  return (p.skill_names||[]).map(name=>({name,description:""}));
}
function fillComposer(text){
  const inp=$("#input"); if(!inp) return;
  inp.value=text||""; inp.dispatchEvent(new Event("input")); inp.focus();
  try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){}
}
function fillCmpComposer(text){
  const inp=$("#cmpInput"); if(!inp) return;
  inp.value=text||""; inp.dispatchEvent(new Event("input")); inp.focus();
  try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){}
}
let _plugFlyout=null, _plugFlyoutTimer=0;
function hidePluginSkillFlyout(){
  clearTimeout(_plugFlyoutTimer);
  if(_plugFlyout){ _plugFlyout.remove(); _plugFlyout=null; }
}
function schedulePluginSkillFlyoutHide(){
  clearTimeout(_plugFlyoutTimer);
  _plugFlyoutTimer=setTimeout(hidePluginSkillFlyout,160);
}
function closePluginMenus(){
  $("#plugindrop")?.classList.remove("show");
  $("#cmpPlugindrop")?.classList.remove("show");
  hidePluginSkillFlyout();
}
function finishPluginPick(text){
  closePluginMenus();
  fillComposer(text);
}
function closeCmpPluginMenus(){
  $("#cmpPlugindrop")?.classList.remove("show");
  hidePluginSkillFlyout();
}
function finishCmpPluginPick(text){
  closeCmpPluginMenus();
  fillCmpComposer(text);
}
function showPluginSkillFlyout(anchor, p, opts={}){
  const items=pluginSkillItems(p);
  if(!items.length) return;
  const getBase=opts.getBase||(()=>$("#input")?.value||"");
  const onPick=opts.onPick||finishPluginPick;
  clearTimeout(_plugFlyoutTimer);
  hidePluginSkillFlyout();
  const id=String(p.id||p.name||"plugin");
  const display=String(p.displayName||p.name||id);
  const fly=document.createElement("div"); fly.className="plugsub";
  const add=(name,desc,fn,main=false)=>{
    const d=document.createElement("div"); d.className="plugsubi"+(main?" main":"");
    d.innerHTML=`<div class="sn">${esc(name)}</div>${desc?`<div class="sd">${esc(desc)}</div>`:""}`;
    d.onclick=e=>{ e.stopPropagation(); fn(); };
    fly.appendChild(d);
  };
  add(`使用 ${display}`, "让插件自动选择合适 skill", ()=>onPick(pluginPackPrompt(p, getBase())), true);
  items.forEach(item=>{
    add(item.name, item.description||"", ()=>onPick(pluginSkillPrompt(p, item.name, getBase())));
  });
  fly.onmouseenter=()=>clearTimeout(_plugFlyoutTimer);
  fly.onmouseleave=schedulePluginSkillFlyoutHide;
  document.body.appendChild(fly);
  _plugFlyout=fly;
  const r=anchor.getBoundingClientRect();
  const fw=Math.min(420, Math.max(300, fly.offsetWidth||340));
  let left=r.right+8;
  if(left+fw>window.innerWidth-8) left=Math.max(8, r.left-fw-8);
  let top=r.top;
  const fh=fly.offsetHeight||360;
  if(top+fh>window.innerHeight-8) top=Math.max(8, window.innerHeight-fh-8);
  fly.style.left=left+"px";
  fly.style.top=top+"px";
}
function renderPluginItemsInto(box, opts={}){
  if(!box) return;
  const getBase=opts.getBase||(()=>"");
  const onPick=opts.onPick||finishPluginPick;
  const hb=opts.withHarness ? opts.harnessBox : null;
  if(hb && HARNESSES.length){
    pluginSection(hb, "Harness");
    HARNESSES.forEach(h=>{
      const d=document.createElement("div"); d.className="plugini harness";
      const eng=engineForHarness(h), short=harnessSlash(h).trim();
      d.title=(h.description||eng?.ed||"")+" · 点击后填入 "+short+" 前缀";
      d.innerHTML=`<span class="emo">${icon(eng?.ico||"settings")}</span><span class="lb">${esc(h.name||eng?.name||h.id||"Harness")}</span><span class="short">${esc(short)}</span>`;
      d.onclick=()=>{ closePluginMenus(); fillHarnessComposer(h); };
      hb.appendChild(d);
    });
  }
  if(PLUGIN_PACKS.length) pluginSection(box, "Plugins");
  PLUGIN_PACKS.forEach(p=>{
    const d=document.createElement("div"); d.className="plugini pack";
    const items=pluginSkillItems(p);
    const cnt=p.skill_count?`${p.skill_count} skills`:"插件";
    d.title=p.description||p.homepage||"";
    d.classList.toggle("has-sub", !!items.length);
    d.innerHTML=`<span class="emo">${icon("puzzle")}</span><span class="lb">${esc(p.displayName||p.name||p.id||"插件")}</span><span class="short">${esc(cnt)}</span>${items.length?'<span class="chev">›</span>':""}`;
    d.onmouseenter=()=>showPluginSkillFlyout(d,p,{getBase,onPick});
    d.onmouseleave=schedulePluginSkillFlyoutHide;
    d.onclick=e=>{
      if(items.length){ e.stopPropagation(); showPluginSkillFlyout(d,p,{getBase,onPick}); return; }
      onPick(pluginPackPrompt(p, getBase()));
    };
    box.appendChild(d);
  });
  if(PLUGINS.length) pluginSection(box, "Templates");
  PLUGINS.forEach(pl=>{
    const d=document.createElement("div"); d.className="plugini custom";
    d.innerHTML=`<span class="emo">${icon("puzzle")}</span><span class="lb">${esc(pl.label||"插件")}</span><span class="short">${esc(pl.short||"")}</span>`;
    d.onclick=()=>{   // 点插件 = 把配置的内容填进输入框,用户补完问题再发
      onPick(pl.insert||"");
    };
    box.appendChild(d);
  });
}
function renderPlugins(){
  const box=$("#plugincustom"); if(!box) return; box.innerHTML="";
  const hb=$("#pluginharness"); if(hb) hb.innerHTML="";
  renderPluginItemsInto(box, {
    getBase:()=>$("#input")?.value||"",
    onPick:finishPluginPick,
    withHarness:true,
    harnessBox:hb
  });
}
async function renderCmpPlugins(opts={}){
  const box=$("#cmpPlugindrop"); if(!box) return;
  if(!opts.skipLoad && !_pluginsLoaded && !PLUGIN_PACKS.length && !PLUGINS.length) await loadPlugins();
  if(!box.isConnected) return;
  box.innerHTML="";
  renderPluginItemsInto(box, {
    getBase:()=>$("#cmpInput")?.value||"",
    onPick:finishCmpPluginPick,
    withHarness:false
  });
}
// 外部研究引擎跟随当前对话 provider。OpenAI-compatible/key 型 provider 直接映射;
// ChatGPT/Claude 这类 OAuth provider 暂不传,由 harness 自身默认配置决定,但 UI 仍标出来源。
const DF_HARNESS_MODEL_PROV={deepseek:"deepseek",zai:"zai",moonshot:"kimi",custom:"hunyuan",longcat:"longcat",volcengine:"volcengine",qwen:"qwen"};
const DF_DEERFLOW_MODEL_PROV={deepseek:"deepseek",zai:"glm",moonshot:"kimi",custom:"hunyuan"};
function researchModelKeyForEngine(engine, provider){
  return (engine==="deerflow" ? DF_DEERFLOW_MODEL_PROV : DF_HARNESS_MODEL_PROV)[provider]||"";
}
function researchFallbackForEngine(engine){
  return engine==="deerflow"
    ? {provider:"moonshot",model:"kimi",raw_model:"k3",label:"Kimi · K3 (DeerFlow 默认)"}
    : {provider:"deepseek",model:"deepseek",raw_model:"deepseek-v4-pro",label:"DeepSeek · deepseek-v4-pro (fallback)"};
}
function researchModelForCurrent(){
  const t=state.threads.find(x=>x.id===state.activeId);
  const provider=(t&&t.provider&&!t.compare)?t.provider:(window._activeChatProv||window._newchatProv||"");
  const raw=(t&&t.model)||((window._modelPrefs||{})[provider])||((provider===window._mainModelProv)?window._mainModelName:"")||"";
  const label=provider ? (PROV_SHORT[provider]||provider)+(raw&&raw!=="auto" ? " · "+raw : "") : "";
  return {provider, raw_model:raw, label};
}
function researchModelMetaText(rec){
  const label=(rec&&rec.model_label)||"";
  if(label) return "LLM: "+label;
  const p=(rec&&rec.provider)||"", m=(rec&&rec.model)||"";
  if(p||m) return "LLM: "+[PROV_SHORT[p]||p,m].filter(Boolean).join(" · ");
  return "LLM: 未记录";
}
function researchStatsWithModel(stats, rec){
  const m=researchModelMetaText(rec);
  const s=String(stats||"").trim();
  if(!m) return s;
  if(!s) return m;
  return s.includes(m) ? s : (m+" · "+s);
}
function _dfAssembled(){   // 研究对象 + 勾选的研究视角(可多选合并) + 默认详细要求 → 最终 prompt(两套引擎共用)
  const topic=($("#dfprompt").value||"").trim();
  if(!topic) return "";
  let p="深度研究:"+topic;
  const tpls=DF_TEMPLATES.filter(x=>_dfTpls.has(x.k));
  if(tpls.length) p+="\n\n以下是候选研究视角/结构,请根据主题自动匹配取舍:相关视角尽量展开,明显不相关可略过;如果多个视角相互补充,请融合成一份连贯报告,不要机械逐项堆砌。\n"+tpls.map(x=>"【"+x.t+"】\n"+x.tpl).join("\n");
  const lines=DF_REFINE.map(r=>"- "+r.line);
  if(lines.length) p+="\n\n补充要求:\n"+lines.join("\n");
  p+="\n\n(全文用中文撰写)";   // felix 治理要求:所有研究引擎中文输出,不可关
  return p;
}
function _dfSkillLine(){   // 选中的研究方法 skill → 方法提示(外部 harness 按描述执行;CodeWhale 对话可直接 load_skill)
  const picked=[..._dfSkills];
  if(!picked.length) return "";
  const lines=picked.map(k=>{
    const m=RESEARCH_SKILLS.find(x=>x.skill===k);
    if(!m) return `- ${k}`;
    return `- ${m.label||m.skill}(${m.skill}): ${m.desc||"按该研究方法组织问题拆解、证据搜集和结论输出"}`;
  }).join("\n");
  return `请优先参考以下研究方法/skill,把它们作为方法论框架来组织研究。若当前环境支持 load_skill 或已安装同名 skill,请加载并遵循;若不能直接加载,请按名称和描述自行匹配、融合执行。\n${lines}`;
}
async function submitResearch(){   // 引擎分流:skill → CodeWhale 当前对话;其余 → 各自 harness API(同一套 research/poll 契约)
  const prompt=_dfAssembled();
  if(!prompt){ cwToast("先输入研究对象/问题"); return; }
  if(_dfEngine==="skill") return submitSkillResearch(prompt);
  const eng=DF_ENGINES.find(x=>x.k===_dfEngine)||DF_ENGINES[0];
  const sk=eng.skills?_dfSkillLine():"";   // 外部 harness 也吃方法提示,由 LLM 自行匹配/融合
  return submitDeerFlow(sk?sk+"\n\n"+prompt:prompt, eng);
}
// 我的方法论路径:新建一个 CodeWhale 对话,首条消息指示模型运用所选研究 skill(用当前对话模型)。
async function submitSkillResearch(prompt){
  if(!_dfSkills.size){ cwToast("先选至少一个研究方法"); return; }
  closeDeerFlow();
  const msg=`${_dfSkillLine()}\n\n要求:中文输出、结论先行、每个论点带具体数字并标注数据时间点、必须包含反方观点(counter-view);若所选 skill 定义了阶段流程或归档(如板块优先 Stage1→2→3、Obsidian 归档)请照做。\n\n${prompt}`;
  try{
    const t=await createThread();
    _addOptimisticThread(t.id, prompt.replace(/\s+/g," ").trim().slice(0,40));
    await openThread(t.id);        // 完整建好 SSE 再发,避免漏首批事件
    await send(msg);
    loadThreads();
  }catch(e){ cwToast("启动方法论研究失败: "+(e.message||e)); }
}
function dfModelForCurrent(){ const rm=researchModelForCurrent(); return researchModelKeyForEngine("deerflow", rm.provider); }
function researchApiForRecord(rec){
  if(rec&&rec.api) return rec.api;
  const e=(rec&&rec.engine)||"deerflow";
  return e==="deerflow" ? "/api/deerflow" : "/api/harness/"+encodeURIComponent(e);
}
function researchRecordTitle(rec){
  const nm=(rec&&rec.engine_name)||"研究";
  return nm;
}
const RESEARCH_PROGRESS_MAX_CHARS=24000;
function researchProgressText(value){
  const text=String(value||"");
  return text.length>RESEARCH_PROGRESS_MAX_CHARS ? "…前面的进度已折叠…\n"+text.slice(-RESEARCH_PROGRESS_MAX_CHARS) : text;
}
function renderResearchMarkdown(body, text){
  const raw=String(text||"").trim();
  body.innerHTML=`<div class="df-md">${md(raw||"(报告正文为空,请用下方链接打开完整报告文件)")}</div>`;
}
function appendResearchFileLinks(body, rec){
  if(!rec||!rec.file) return;
  const route=researchApiForRecord(rec), nm=encodeURIComponent(rec.file);
  const durl=`${route}/file?name=${nm}`;
  const hurl=`${route}/file?name=${nm}&html=1`;
  const fb=document.createElement("div"); fb.className="df-file-card";
  fb.innerHTML=`<div class="df-file-ico">${icon("file")}</div>
    <div class="df-file-main"><div class="df-file-name">${esc(rec.file)}</div><div class="df-file-meta">文档 · MD</div>${rec.path?`<div class="df-path" title="点击复制路径">${esc(rec.path)}</div>`:""}</div>
    <details class="df-file-actions"><summary>打开方式</summary><div class="df-file-menu">
      <button class="df-prev" type="button">打开预览</button>
      <a href="${durl}&inline=1" target="_blank" rel="noopener">看原文</a>
    </div></details>`;
  body.appendChild(fb);
  fb.querySelector(".df-prev").onclick=()=>{ previewLoad(hurl); previewShow(); fb.querySelector("details")?.removeAttribute("open"); };
  const pc=fb.querySelector(".df-path"); if(pc) pc.onclick=()=>{ clipCopy(rec.path); sysnote("已复制报告路径"); };
}
function renderResearchRecord(rec){
  if(!rec||!rec.id||document.querySelector(`[data-research-id="${CSS.escape(rec.id)}"]`)) return;
  if(rec.prompt){
    const u=row("user","你"); u.classList.add("research-restored");
    u.querySelector(".content").innerHTML=md(`${researchRecordTitle(rec)} 深度研究: ${rec.prompt}`);
    $("#mwrap").appendChild(u);
  }
  const done=rec.status==="success"||rec.status==="completed";
  const failed=/fail|error|cancel/i.test(rec.status||"");
  const dfel=document.createElement("div"); dfel.className="df-result"; dfel.dataset.researchId=rec.id;
  dfel.innerHTML=`<div class="df-hdr ${done||failed?"":"running"}"><div class="spinner"></div></div><div class="df-body"></div><div class="df-stats"></div>`;
  const hdr=dfel.querySelector(".df-hdr"), body=dfel.querySelector(".df-body"), stats=dfel.querySelector(".df-stats");
  hdr.appendChild(document.createTextNode((done?"✅ ":(failed?"❌ ":""))+researchRecordTitle(rec)+(done?" 深度研究完成":(failed?" 研究失败":" 深度研究中…"))));
  if(done){
    renderResearchMarkdown(body, rec.output);
    appendResearchFileLinks(body, rec);
  }else if(failed){
    body.textContent=rec.output||"研究失败";
  }else{
    body.innerHTML='<div class="df-progtt">当前推理进展(最新中间产出):</div><pre class="df-prog"></pre>';
    body.querySelector(".df-prog").textContent=researchProgressText(rec.output)||"研究仍在进行或等待下一次轮询";
  }
  stats.textContent=researchStatsWithModel(rec.stats||((rec.external_thread_id||rec.ext_thread_id)?("Thread: "+String(rec.external_thread_id||rec.ext_thread_id).slice(0,12)+"…"):""), rec);
  $("#mwrap").appendChild(dfel);
}
async function restoreResearchRecords(threadId){
  if(!threadId) return;
  try{
    const rows=await api("/api/research-records?thread_id="+encodeURIComponent(threadId));
    if(state.activeId!==threadId || !Array.isArray(rows) || !rows.length) return;
    rows.forEach(renderResearchRecord);
    scrollDown(true);
  }catch(e){ console.warn("research record restore failed", e); }
}
async function saveResearchRecord(rec){
  try{
    const d=await api("/api/research-records",{method:"POST",body:JSON.stringify(rec)});
    return d&&d.record&&d.record.id;
  }catch(e){ console.warn("research record save failed", e); return rec&&rec.id; }
}
async function submitDeerFlow(promptArg,eng){   // eng=DF_ENGINES 条目;默认 DeerFlow。所有 harness 共用同一套 research/poll/file 契约
  eng=eng||DF_ENGINES[0];
  const API=eng.api||"/api/deerflow";
  const prompt=(promptArg||$("#dfprompt").value||"").trim();
  if(!prompt) return;
  const runPrompt=prompt.includes(DEFAULT_CHINESE_OUTPUT_LINE) ? prompt : `${prompt}\n\n${DEFAULT_CHINESE_OUTPUT_LINE}`;
  closeDeerFlow();
  if(!state.activeId){
    const t=await createThread();
    const title=roughThreadTitle(prompt, eng.title||"深度研究");
    _addOptimisticThread(t.id, title);
    await openThread(t.id);
    api(`/v1/threads/${t.id}`,{method:"PATCH",body:JSON.stringify({title})}).catch(()=>{});
    if(window.scheduleSmartTitle) window.scheduleSmartTitle(t.id,title);
    loadThreads();
  }
  const cwThreadId=state.activeId;
  let rm=researchModelForCurrent();   // 外部研究引擎统一跟随当前对话模型;桥接不支持的 provider 会回退到自身默认配置
  const m=researchModelKeyForEngine(eng.k, rm.provider);
  rm=m ? {...rm, model:m} : researchFallbackForEngine(eng.k);
  let recId="";
  const recBase={cw_thread_id:cwThreadId, engine:eng.k, engine_name:eng.name, engine_icon:eng.ico||"", api:API, prompt, status:"running",
                 provider:rm.provider, model:rm.model||m, provider_model:rm.raw_model, model_label:rm.label};
  // 在聊天区添加用户消息
  const label=rm.label?`${eng.name} [${rm.label}] 深度研究: `:`${eng.name} 深度研究: `;
  const oel=row("user","你"); oel.querySelector(".content").innerHTML=md(label+prompt); $("#mwrap").appendChild(oel); scrollDown(true);
  // 添加结果容器
  const dfel=document.createElement("div"); dfel.className="df-result"; dfel.id="df-"+Date.now();
  dfel.innerHTML=`<div class="df-hdr running"><div class="spinner"></div> ${esc(eng.name)} 深度研究中…${rm.label?` · LLM: ${esc(rm.label)}`:""}</div><div class="df-body">正在提交研究任务…</div><div class="df-stats"></div>`;
  $("#mwrap").appendChild(dfel); scrollDown(true);
  const hdr=dfel.querySelector(".df-hdr"); const body=dfel.querySelector(".df-body"); const stats=dfel.querySelector(".df-stats");
  try{
    // 提交研究任务(注意:不要用 body 当变量名,会盖掉上面的 .df-body DOM 元素)
    const reqBody={prompt:runPrompt,cw_thread_id:cwThreadId,provider:rm.provider,provider_model:rm.raw_model,model_label:rm.label};
    if(m) reqBody.model=m;   // 跟随当前对话模型;无对应(OAuth 类)不传→服务端/引擎默认
    const r=await fetch(API+"/research",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify(reqBody)});
    if(!r.ok){ throw new Error("提交请求失败 HTTP "+r.status+"(后端可能未起或未更新,试试退出重开 CodeWhale)"); }
    const d=await r.json();
    if(!d.ok){
      body.textContent="提交失败: "+(d.error||"未知错误"); hdr.classList.remove("running"); hdr.textContent="❌ "+eng.name+" 提交失败";
      recId=await saveResearchRecord({...recBase,id:recId,status:"failed",output:body.textContent,stats:"提交失败"});
      return;
    }
    body.textContent="任务已提交 (Thread: "+d.thread_id.slice(0,8)+"…)\n等待结果中…";
    stats.textContent="Thread: "+d.thread_id.slice(0,12)+"…";
    recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,stats:stats.textContent,output:"等待结果中…"});
    // 轮询进度快照(progress=1 即回不阻塞):状态 + tokens + LLM 调用数 + 最新中间消息 → 过程可见
    const maxPolls=150, interval=8000;   // 20 分钟上限(odr 多agent深挖可能 >8 分钟)
    let failStreak=0, out="";
    for(let i=0;i<maxPolls;i++){
      await new Promise(res=>setTimeout(res,interval));
      const pr=await fetch(API+"/poll?thread_id="+encodeURIComponent(d.thread_id)+"&progress=1",{method:"POST",headers:{...auth}});   // poll 端点在 do_POST,必须用 POST(GET 会 404)
      if(!pr.ok){ throw new Error("轮询请求失败 HTTP "+pr.status); }
      const pd=await pr.json();
      if(pd.status==="error"){ body.textContent="研究失败: "+(pd.error||"未知错误"); hdr.classList.remove("running"); hdr.textContent="❌ "+eng.name+" 研究失败"+(rm.label?` · LLM: ${rm.label}`:""); recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:"failed",output:body.textContent,stats:researchStatsWithModel("研究失败",recBase)}); return; }
      if(pd.ok===false||pd.error){ if(++failStreak>=3){ body.textContent="轮询失败: "+(pd.error||"未知错误"); hdr.classList.remove("running"); hdr.textContent="❌ "+eng.name+" 错误"+(rm.label?` · LLM: ${rm.label}`:""); recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:"failed",output:body.textContent,stats:researchStatsWithModel("轮询失败",recBase)}); return; } continue; }   // 偶发失败容忍 2 次
      failStreak=0;
      const st=pd.status||"unknown"; out=st;
      if(st!=="success"){   // 运行中:状态行 + 最新中间消息尾部(planner/researcher 阶段产出,边跑边更新)
        const secs=Math.round((i+1)*interval/1000);
        const stat=researchStatsWithModel(`⏱ ${secs}s · 状态 ${st} · LLM 调用 ${pd.llm_calls||0} 次 · tokens ${pd.in_tokens||0} in / ${pd.out_tokens||0} out · 中间消息 ${pd.msg_count||0} 条`, recBase);
        stats.textContent=stat;
        if(pd.tail){
          let pg=body.querySelector(".df-prog");
          if(!pg){ body.innerHTML='<div class="df-progtt">当前推理进展(最新中间产出):</div><pre class="df-prog"></pre>'; pg=body.querySelector(".df-prog"); }
          const progress=researchProgressText(pd.tail);
          if(pg.textContent!==progress){ pg.textContent=progress; pg.scrollTop=pg.scrollHeight; }
        } else body.textContent="研究中… ("+secs+"s) 计划生成阶段,暂无中间产出";
        recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:st,stats:stat,output:researchProgressText(pd.tail)||body.textContent});
        if(["error","failed","cancelled"].includes(st)){ hdr.classList.remove("running"); hdr.textContent="❌ "+eng.name+" 研究"+(st==="cancelled"?"被取消":"失败")+(rm.label?` · LLM: ${rm.label}`:""); recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:st,stats:stat,output:researchProgressText(pd.tail)||body.textContent}); return; }
        continue;
      }
      if(st==="success"){
        hdr.classList.remove("running"); hdr.textContent="✅ "+eng.name+" 深度研究完成"+(rm.label?` · LLM: ${rm.label}`:"");
        // 获取完整结果
        let rd={}, final="";
        for(let k=0;k<7;k++){   // 报告文件可能比状态翻转慢半拍:最长再等约 10 秒,且绝不拿状态字符串当正文兜底
          const rr=await fetch(API+"/poll?thread_id="+encodeURIComponent(d.thread_id)+"&full=1",{method:"POST",headers:{...auth}});   // 同上:POST + 带鉴权(原来漏了)
          rd=await rr.json();
          final=(rd.output||"").trim();
          if(final || rd.file || rd.path) break;
          await new Promise(r=>setTimeout(r,1500));
        }
        if(!final && !(rd.file||rd.path)){
          hdr.classList.remove("running");
          hdr.textContent="❌ "+eng.name+" 完成但未交付产出"+(rm.label?` · LLM: ${rm.label}`:"");
          body.textContent="Harness 已报告完成,但没有返回正文或可下载文件。任务 ID: "+d.thread_id+"。请检查任务日志后重试。";
          stats.textContent=researchStatsWithModel("交付失败",recBase);
          recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:"delivery_missing",stats:stats.textContent,output:body.textContent});
          return;
        }
        if(!final && (rd.file||rd.path)) final="报告文件已生成,可在下方直接打开或下载。";
        // 清理输出:去掉状态行(状态: / [running] tokens / 缩进状态行)只留报告正文
        const clean=final.replace(/^状态:.*$/gm,"").replace(/^\[.*?\]\s*tokens:.*$/gm,"").replace(/^\s*\[.*$/gm,"").trim();
        renderResearchMarkdown(body, clean||final);
        appendResearchFileLinks(body, {...recBase,file:rd.file||"",path:rd.path||""});
        // 尝试获取统计信息
        const statMatch=final.match(/([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out.*?(\d+)\s*LLM\s*calls?/i);
        if(statMatch) stats.textContent=researchStatsWithModel("Tokens: "+statMatch[1]+" in / "+statMatch[2]+" out | "+statMatch[3]+" LLM calls", recBase);
        else stats.textContent=researchStatsWithModel("完成", recBase);
        recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:"success",stats:stats.textContent,output:clean||final,file:rd.file||"",path:rd.path||""});
        return;
      }
    }
    hdr.classList.remove("running"); hdr.textContent=eng.name+" 超时"+(rm.label?` · LLM: ${rm.label}`:"");
    body.textContent="研究超过 20 分钟仍在进行,任务未丢;稍后可在报告目录找产出(thread: "+d.thread_id+")";
    recId=await saveResearchRecord({...recBase,id:recId,external_thread_id:d.thread_id,status:"timeout",stats:researchStatsWithModel("超时",recBase),output:body.textContent});
  }catch(e){ const msg=e.message||String(e); const isPollFailure=msg.startsWith("轮询请求失败")||msg.startsWith("轮询失败:"); hdr.classList.remove("running"); hdr.textContent="❌ "+eng.name+" 异常"+(rm.label?` · LLM: ${rm.label}`:""); body.textContent=isPollFailure?"轮询失败: "+msg.replace(/^轮询失败:\s*/,""):msg; await saveResearchRecord({...recBase,id:recId,status:"failed",output:body.textContent,stats:researchStatsWithModel(isPollFailure?"轮询失败":"异常",recBase)}); }
}
async function submitDeerFlowFromInput(prompt, engineKey="deerflow"){
  const eng=DF_ENGINES.find(x=>x.k===engineKey)||DF_ENGINES[0];
  $("#dfprompt").value=prompt;
  if(engineKey==="skill") return submitSkillResearch(prompt);
  await submitDeerFlow(prompt, eng);
}


function initPanelDocumentHandlers(){
  // toggle plugin dropdown
  document.addEventListener("click",function(e){
    const btn=$("#pluginbtn"), drop=$("#plugindrop");
    const cmpBtn=$("#cmpPluginBtn"), cmpDrop=$("#cmpPlugindrop");
    const inFlyout=_plugFlyout&&_plugFlyout.contains(e.target);
    if(btn&&drop&&btn.contains(e.target)){
      const willShow=!drop.classList.contains("show");
      hidePluginSkillFlyout();
      if(cmpDrop) cmpDrop.classList.remove("show");
      drop.classList.toggle("show", willShow); e.stopPropagation(); return;
    }
    if(cmpBtn&&cmpDrop&&cmpBtn.contains(e.target)){
      const willShow=!cmpDrop.classList.contains("show");
      hidePluginSkillFlyout();
      if(drop) drop.classList.remove("show");
      cmpDrop.classList.toggle("show", willShow); e.stopPropagation();
      if(willShow) renderCmpPlugins();
      return;
    }
    if((drop&&drop.contains(e.target)) || (cmpDrop&&cmpDrop.contains(e.target)) || inFlyout) return;
    closePluginMenus();
  });
  // Close dfmodal on backdrop click
  document.addEventListener("click",function(e){
    const modal=$("#dfmodal");
    if(modal&&modal.classList.contains("show")&&e.target===modal) closeDeerFlow();
  });
}

/* ---------- 模态:Skills / Connectors ---------- */
function openModal(title, iconName=""){
  $("#modal").classList.remove("settings-modal");
  const mt=$("#modalTitle");
  if(iconName) mt.innerHTML=icon(iconName)+"<span>"+esc(title)+"</span>";
  else mt.textContent=title;
  $("#modal").classList.add("show"); $("#modalBody").scrollTop=0;
}
function closeModal(){ $("#modal").classList.remove("show","settings-modal"); }
function scheduleReloadIfConnected(anchor, delay){
  setTimeout(()=>{ if(!anchor || anchor.isConnected) location.reload(); }, delay);
}
function settingsDate(v){
  const d=new Date(v||0);
  if(!Number.isFinite(d.getTime())||d.getTime()<=0) return "时间未知";
  try{ return d.toLocaleString("zh-CN",{year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}); }
  catch(e){ return d.toLocaleString(); }
}
function settingsProjectGroup(rows){
  const m=new Map();
  for(const r of rows){
    const key=r.project||"未指定项目";
    if(!m.has(key)) m.set(key,[]);
    m.get(key).push(r);
  }
  return [...m.entries()].sort((a,b)=>{
    const at=Math.max(...a[1].map(x=>new Date(x.updated_at||0).getTime()||0));
    const bt=Math.max(...b[1].map(x=>new Date(x.updated_at||0).getTime()||0));
    return bt-at;
  });
}
async function openSettings(){
  openModal("设置");
  $("#modal").classList.add("settings-modal");
  const body=$("#modalBody");
  body.innerHTML=`<div class="settings-shell">
    <aside class="settings-nav">
      <button id="settingsArchTab" class="on">${icon("file")} 已归档对话</button>
      <button id="settingsUpdateTab">${icon("refresh")} 更新</button>
      <div class="panel-note">归档、GUI/后端/Harness/插件更新都在这里集中管理。</div>
    </aside>
    <section class="settings-main" id="settingsMain"></section>
  </div>`;
  const setTab=tab=>{
    $("#settingsArchTab").classList.toggle("on",tab==="archive");
    $("#settingsUpdateTab").classList.toggle("on",tab==="update");
  };
  const deleteArchived=async ids=>api("/api/settings/archived-sessions/delete",{method:"POST",body:JSON.stringify({ids})});
  let archiveSeq=0;
  const renderArchive=async()=>{
    const seq=++archiveSeq;
    const alive=()=>seq===archiveSeq && !!$("#archList");
    setTab("archive");
    const main=$("#settingsMain");
    main.innerHTML=`<div class="settings-head"><div><h4>已归档对话</h4><p>恢复后回到左侧对话列表；删除会永久移除当前筛选范围内的归档记录。</p></div><div class="settings-actions"><button class="btn danger" id="archDeleteAll">全部删除</button><button class="btn" id="archRefresh">刷新</button></div></div>
      <div class="settings-filters">
        <input id="archSearch" class="msearch flush" placeholder="搜索已归档聊天">
        <select id="archModel"><option value="">全部聊天</option></select>
        <select id="archProject"><option value="">所有项目</option></select>
      </div>
      <div id="archList" class="arch-list">加载中…</div>`;
    let payload={items:[],projects:[],models:[]}, currentRows=[];
    const fillSelect=(sel,items,allLabel)=>{
      const el=$(sel); if(!el) return;
      const cur=el.value||"";
      el.innerHTML=`<option value="">${allLabel}</option>`+items.map(x=>`<option value="${escAttr(x)}">${esc(sel==="#archModel"?(PROV_SHORT[x]||x):x)}</option>`).join("");
      if([...el.options].some(o=>o.value===cur)) el.value=cur;
    };
    const draw=()=>{
      if(!alive()) return;
      const search=$("#archSearch"), modelSel=$("#archModel"), projectSel=$("#archProject");
      if(!search||!modelSel||!projectSel) return;
      const q=(search.value||"").trim().toLowerCase();
      const model=modelSel.value||"", project=projectSel.value||"";
      let rows=(payload.items||[]).filter(r=>{
        if(model && model!==(r.provider||r.model||"")) return false;
        if(project && project!==(r.project||"")) return false;
        if(!q) return true;
        return [r.title,r.preview,r.model,r.provider,r.workspace,r.project,r.compare_topic].some(x=>String(x||"").toLowerCase().includes(q));
      });
      currentRows=rows;
      const list=$("#archList");
      const delAll=$("#archDeleteAll");
      if(!list) return;
      if(delAll) delAll.disabled=!rows.length;
      if(!rows.length){ list.innerHTML='<div class="panel-empty">没有匹配的归档对话</div>'; return; }
      list.innerHTML="";
      for(const [projectName,items] of settingsProjectGroup(rows)){
        const group=document.createElement("div"); group.className="arch-group";
        group.innerHTML=`<div class="arch-group-h"><span>${icon("file")} ${esc(projectName)}</span><span>${items.length} 个聊天</span></div>`;
        for(const r of items){
          const row=document.createElement("div"); row.className="arch-row";
          const modelName=PROV_SHORT[r.provider]||PROV_SHORT[r.model]||r.provider||r.model||"";
          row.innerHTML=`<div class="arch-info"><div class="arch-title">${esc(r.title||"New Thread")}</div>
            <div class="arch-meta">${esc(settingsDate(r.updated_at))}${modelName?` · ${esc(modelName)}`:""}${r.compare?` · 对比`:""}</div>
            ${r.preview&&r.preview!==r.title?`<div class="arch-prev">${esc(r.preview)}</div>`:""}</div>
            <div class="arch-actions"><button class="btn primary arch-restore">恢复</button><button class="btn danger arch-delete">删除</button></div>`;
          row.querySelector(".arch-restore").onclick=async e=>{
            e.stopPropagation();
            const btn=e.currentTarget; btn.disabled=true; btn.textContent="恢复中…";
            try{
              await api(`/v1/threads/${r.id}`,{method:"PATCH",body:JSON.stringify({archived:false})});
              if(!alive()) return;
              payload.items=payload.items.filter(x=>x.id!==r.id);
              state._sig=null;
              await loadThreads();
              if(!alive()) return;
              draw();
              cwToast("已恢复「"+(r.title||"New Thread")+"」");
            }catch(err){
              if(!alive()) return;
              btn.disabled=false; btn.textContent="恢复";
              alert("恢复失败: "+err.message);
            }
          };
          row.querySelector(".arch-delete").onclick=async e=>{
            e.stopPropagation();
            if(!(await cwConfirm(`永久删除归档对话「${r.title||"New Thread"}」?\n此操作不会进入回收站。`))) return;
            if(!alive()) return;
            const btn=e.currentTarget; btn.disabled=true; btn.textContent="删除中…";
            try{
              const res=await deleteArchived([r.id]);
              if(!alive()) return;
              const deleted=new Set(res.deleted||[]);
              if(!deleted.has(r.id)) throw new Error((res.failed||[])[0]?.error||res.error||"删除失败");
              payload.items=payload.items.filter(x=>x.id!==r.id);
              state._sig=null;
              await loadThreads();
              if(!alive()) return;
              draw();
              cwToast("已删除归档对话");
            }catch(err){
              if(!alive()) return;
              btn.disabled=false; btn.textContent="删除";
              alert("删除失败: "+err.message);
            }
          };
          row.onclick=()=>row.querySelector(".arch-restore").click();
          group.appendChild(row);
        }
        list.appendChild(group);
      }
    };
    const load=async()=>{
      const list=$("#archList"); if(!list) return;
      list.textContent="加载中…";
      try{
        payload=await api("/api/settings/archived-sessions");
        if(!alive()) return;
        fillSelect("#archModel",payload.models||[],"全部聊天");
        fillSelect("#archProject",payload.projects||[],"所有项目");
        draw();
      }catch(e){
        if(alive()) $("#archList").textContent="加载失败: "+e.message;
      }
    };
    $("#archSearch").oninput=draw;
    $("#archModel").onchange=draw;
    $("#archProject").onchange=draw;
    $("#archRefresh").onclick=load;
    $("#archDeleteAll").onclick=async()=>{
      const rows=currentRows.slice();
      if(!rows.length) return;
      if(!(await cwConfirm(`永久删除当前筛选出的 ${rows.length} 个已归档对话?\n此操作不会进入回收站。`))) return;
      if(!alive()) return;
      const btn=$("#archDeleteAll"); if(!btn) return;
      btn.disabled=true; btn.textContent="删除中…";
      try{
        const ids=rows.map(r=>r.id);
        const res=await deleteArchived(ids);
        if(!alive()) return;
        const deleted=new Set(res.deleted||[]);
        payload.items=payload.items.filter(x=>!deleted.has(x.id));
        state._sig=null;
        await loadThreads();
        if(!alive()) return;
        draw();
        cwToast(`已删除 ${deleted.size}/${rows.length} 个归档对话`);
      }catch(e){
        if(!alive()) return;
        cwToast("删除失败: "+e.message);
      }finally{
        if(btn.isConnected){ btn.textContent="全部删除"; btn.disabled=false; }
      }
    };
    await load();
  };
  $("#settingsArchTab").onclick=renderArchive;
  $("#settingsUpdateTab").onclick=()=>{ archiveSeq++; setTab("update"); renderUpdateCenter($("#settingsMain")); };
  await renderArchive();
}
async function openSkills(){
  openModal("Skills / 插件","puzzle");
  const body=$("#modalBody");
  body.innerHTML=`<div class="panel-section-title">插件包</div>
    <div id="pluginpacks">加载中…</div>
    <div class="prow mt8 plugin-pick-row"><button class="btn primary" id="plugininstall">导入插件目录</button><button class="btn" id="plugininstallfile">选单个文件</button><input type="file" id="plugindirinput" webkitdirectory hidden><input type="file" id="pluginfileinput" accept=".md,.json" hidden><span id="pluginpickhint" class="panel-note">选插件根目录(含 <code>plugin.json</code> 或 <code>SKILL.md</code>),或单个 <code>SKILL.md</code></span></div>
    <div class="panel-note">插件里的 skills 会出现在下方列表; sessionStart 先作为元数据展示,不自动污染用户消息。</div>
    <div class="panel-section-title mt16">Skills</div>
    <div class="prow"><input class="msearch flush" id="skq" placeholder="搜索 skill…"><button class="btn primary" id="newskill">新建 Skill</button></div>
    <div id="skillcreate" class="skill-create-card" hidden>
      <div class="skill-create-head">新建 Skill</div>
      <div class="prow">
        <input id="skillname" placeholder="名称,例如 bottom-top-hunter">
        <input id="skilldesc" placeholder="一句话描述: 什么时候应该使用它">
      </div>
      <div class="skill-create-actions"><button class="btn" id="skillcancel">取消</button><button class="btn primary" id="skillcreatebtn">创建</button></div>
      <div class="panel-note mt8">会创建到 <code>~/.codewhale/skills/&lt;name&gt;/SKILL.md</code>,创建后可在列表里点开继续编辑。</div>
    </div>
    <div id="sklist">加载中…</div>`;
  let all=[], plugins=[];
  const drawPlugins=()=>{
    const list=$("#pluginpacks"); if(!list) return; list.innerHTML="";
    if(!Array.isArray(plugins)||!plugins.length){ list.innerHTML='<div class="panel-empty">还没有安装插件包</div>'; return; }
    for(const p of plugins){
      const row=document.createElement("div"); row.className="lrow pluginpack"+(p.enabled?"":" off");
      const st=p.error?"err":(p.enabled?"ok":"unknown");
      const sess=p.sessionStart&&p.sessionStart.skill?` · sessionStart:${p.sessionStart.skill}`:"";
      row.innerHTML=`<span class="nm">${esc(p.displayName||p.name||p.id)}<span class="sub">${esc([p.version&&("v"+p.version), (p.skill_count||0)+" skills"].filter(Boolean).join(" · ")+sess)}</span></span>
        <span class="st ${st}">${p.error?"错误":(p.enabled?"启用":"停用")}</span>
        <button class="btn" data-act="toggle">${p.enabled?"停用":"启用"}</button>`;
      row.querySelector("[data-act=toggle]").onclick=async(e)=>{
        e.stopPropagation();
        const r=await api("/api/codex-plugins",{method:"POST",body:JSON.stringify({action:"toggle",id:p.id,enabled:!p.enabled})});
        if(r.error){ cwToast(r.error); return; }
        plugins=r.plugins||await api("/api/codex-plugins"); all=await api("/api/skills"); drawPlugins(); draw($("#skq").value);
      };
      row.querySelector(".nm").onclick=()=>{
        const nx=row.nextElementSibling;
        if(nx&&nx.classList.contains("pluginbody")){ nx.remove(); return; }
        const pre=document.createElement("div"); pre.className="pluginbody skbody";
        pre.textContent=[
          p.description||"",
          p.error?("Error: "+p.error):"",
          "Path: "+(p.path||""),
          "Manifest: "+(p.manifest||""),
          p.homepage?("Homepage: "+p.homepage):"",
          p.sessionStart&&p.sessionStart.skill?("SessionStart: "+p.sessionStart.skill):"",
          p.skillInstructions?("\nSkill instructions:\n"+p.skillInstructions):""
        ].filter(Boolean).join("\n");
        row.after(pre);
      };
      list.appendChild(row);
    }
  };
  const draw=(filter="")=>{
    const list=$("#sklist"); list.innerHTML=""; const f=filter.toLowerCase();
    const items=all.filter(s=>s.name.toLowerCase().includes(f));
    if(!items.length){ list.innerHTML='<div class="panel-empty">无</div>'; return; }
    for(const s of items){
      const row=document.createElement("div"); row.className="lrow";
      row.innerHTML=`<span class="nm">${esc(s.name)}<span class="sub">${esc(s.source)}${s.has_templates?" · templates":""}</span></span>`;
      row.querySelector(".nm").onclick=async()=>{
        const nx=row.nextElementSibling;
        if(nx&&nx.classList.contains("skbody")){ nx.remove(); return; }
        try{ const d=await api(`/api/skills/read?path=${encodeURIComponent(s.path)}`); const pre=document.createElement("div"); pre.className="skbody"; pre.textContent=d.content||d.error||"(空)"; row.after(pre); }catch(e){ sysnote("读取失败: "+e.message); }
      };
      list.appendChild(row);
    }
  };
  try{
    const res=await Promise.allSettled([api("/api/codex-plugins"), api("/api/skills")]);
    plugins=res[0].status==="fulfilled"&&Array.isArray(res[0].value)?res[0].value:[];
    all=res[1].status==="fulfilled"&&Array.isArray(res[1].value)?res[1].value:[];
    drawPlugins(); draw();
  }catch(e){ $("#sklist").textContent="加载失败: "+e.message; }
  $("#skq").oninput=e=>draw(e.target.value);
  // 导入插件 = 复用「添加附件」的浏览器文件选择,整树直传后端安装,不依赖系统对话框
  const hintHtml='选插件根目录(含 <code>plugin.json</code> 或 <code>SKILL.md</code>),或单个 <code>SKILL.md</code>';
  const PLUGIN_SKIP=/(^|\/)(\.git|node_modules|__pycache__|\.DS_Store)(\/|$)/;
  const readAsB64=f=>new Promise((res,rej)=>{ const r=new FileReader();
    r.onload=()=>res(String(r.result).split(",",2)[1]||""); r.onerror=()=>rej(new Error("读取失败: "+f.name)); r.readAsDataURL(f); });
  const installPicked=async files=>{
    const btn=$("#plugininstall"), hint=$("#pluginpickhint");
    const list=[...files].filter(f=>!PLUGIN_SKIP.test(f.webkitRelativePath||f.name));
    if(!list.length){ cwToast("没有可导入的文件"); return; }
    if(list.reduce((s,f)=>s+f.size,0)>50*1024*1024){ cwToast("总大小超过 50MB,请去掉无关文件"); return; }
    const old=btn.textContent;
    btn.disabled=true; btn.textContent="导入中…";
    if(hint) hint.textContent=`上传 ${list.length} 个文件…`;
    try{
      const payload={action:"install_upload", name:((list[0].webkitRelativePath||"").split("/")[0])||"", files:[]};
      for(const f of list) payload.files.push({path:f.webkitRelativePath||f.name, b64:await readAsB64(f)});
      const r=await api("/api/codex-plugins",{method:"POST",body:JSON.stringify(payload)});
      if(r.error){ cwToast(r.error); return; }
      plugins=r.plugins||await api("/api/codex-plugins"); all=await api("/api/skills"); drawPlugins(); draw($("#skq").value);
      cwToast("插件已导入");
    }catch(e){ cwToast("导入失败: "+e.message); }
    finally{
      if(btn.isConnected){ btn.textContent=old; btn.disabled=false; }
      if(hint) hint.innerHTML=hintHtml;
    }
  };
  $("#plugininstall").onclick=()=>$("#plugindirinput").click();
  $("#plugininstallfile").onclick=()=>$("#pluginfileinput").click();
  $("#plugindirinput").onchange=e=>{ if(e.target.files.length) installPicked(e.target.files); e.target.value=""; };
  $("#pluginfileinput").onchange=e=>{ if(e.target.files.length) installPicked(e.target.files); e.target.value=""; };
  const createBox=$("#skillcreate"), nameInput=$("#skillname"), descInput=$("#skilldesc");
  const hideCreate=()=>{ if(createBox) createBox.hidden=true; if(nameInput) nameInput.value=""; if(descInput) descInput.value=""; };
  const showCreate=()=>{ if(!createBox) return; createBox.hidden=false; setTimeout(()=>nameInput&&nameInput.focus(),20); };
  $("#newskill").onclick=()=>{ if(createBox&&!createBox.hidden) hideCreate(); else showCreate(); };
  $("#skillcancel").onclick=hideCreate;
  $("#skillcreatebtn").onclick=async()=>{
    const btn=$("#skillcreatebtn");
    const name=(nameInput&&nameInput.value||"").trim();
    const description=(descInput&&descInput.value||"").trim();
    if(!/^[A-Za-z0-9._-]{2,80}$/.test(name) || name.startsWith(".")){ cwToast("名称只能用英文、数字、点、下划线、短横线,至少 2 个字符"); return; }
    const old=btn.textContent;
    btn.disabled=true; btn.textContent="创建中…";
    try{
      const d=await api("/api/skills",{method:"POST",body:JSON.stringify({action:"create",name,description})});
      if(d.error){ cwToast(d.error); return; }
      all=await api("/api/skills");
      $("#skq").value=name;
      hideCreate();
      draw(name);
      cwToast("Skill 已创建");
    }catch(e){ cwToast("新建失败: "+e.message); }
    finally{ if(btn.isConnected){ btn.textContent=old; btn.disabled=false; } }
  };
}
async function openConnectors(){
  openModal("连接器 (MCP)","plug");
  const body=$("#modalBody");
  body.innerHTML=`<div id="mcplist">加载中…</div>
    <div class="prow mt8"><input id="mname" placeholder="名称"><input id="mcmd" placeholder="命令 如 /opt/homebrew/bin/npx"><input id="margs" placeholder="参数,逗号分隔"></div>
    <div class="prow"><button class="btn primary" id="maddbtn">＋ 添加 server</button><button class="btn" id="mrestart">↻ 重启后端生效</button></div>
    <div class="panel-note">增删/开关后需「重启后端」才生效。Gmail/GDrive 等可加对应的本地 MCP server(自己跑 OAuth),不是 Claude 那种一键托管。</div>`;
  const drawList=async()=>{
    const list=$("#mcplist");
    try{
      const servers=await api("/api/mcp"); list.innerHTML="";
      if(!servers.length) list.innerHTML='<div class="panel-empty">还没有 MCP server</div>';
      for(const s of servers){
        const row=document.createElement("div"); row.className="lrow";
        const stc=s.status==="ok"?"ok":(s.status==="unknown"?"unknown":"err");
        row.innerHTML=`<span class="nm" title="${esc((s.command||s.url||"")+" "+(s.args||[]).join(" "))}">${esc(s.name)}<span class="sub">${esc((s.command||s.url||"").split("/").pop())}</span></span>
          <span class="st ${stc}">${esc(s.enabled?s.status:"已停用")}</span>
          <button class="btn" data-act="toggle">${s.enabled?"停用":"启用"}</button>
          <button class="btn danger" data-act="remove">删</button>`;
        row.querySelector("[data-act=toggle]").onclick=async()=>{ await api("/api/mcp",{method:"POST",body:JSON.stringify({action:"toggle",name:s.name,enabled:!s.enabled})}); drawList(); };
        row.querySelector("[data-act=remove]").onclick=async()=>{ if(!(await cwConfirm("删除 MCP server「"+s.name+"」?"))) return; await api("/api/mcp",{method:"POST",body:JSON.stringify({action:"remove",name:s.name})}); drawList(); };
        list.appendChild(row);
      }
    }catch(e){ list.textContent="加载失败: "+e.message; }
  };
  drawList();
  $("#maddbtn").onclick=async()=>{
    const name=$("#mname").value.trim(), command=$("#mcmd").value.trim();
    const args=$("#margs").value.split(",").map(x=>x.trim()).filter(Boolean);
    if(!name||!command){ alert("名称和命令必填"); return; }
    const d=await api("/api/mcp",{method:"POST",body:JSON.stringify({action:"add",name,command,args})});
    if(d.error){ alert(d.error); return; }
    $("#mname").value=$("#mcmd").value=$("#margs").value=""; drawList();
  };
  $("#mrestart").onclick=async()=>{ const b=$("#mrestart"); b.textContent="重启中…"; try{ await api("/api/mcp",{method:"POST",body:JSON.stringify({action:"restart"})}); }catch(e){} setTimeout(()=>{ b.textContent="↻ 重启后端生效"; drawList(); },2800); };
}

/* ---------- 切换模型 / Provider ---------- */
const PROVIDERS=[   // 非 DeepSeek 的 provider 模型填 auto:app-server 把 default_text_model 当 DeepSeek 字段校验,填具体名(如 glm-4.6)会启动失败;auto=由该 provider 自选默认模型
  {id:"deepseek",name:"DeepSeek V4",model:"deepseek-v4-pro"},
  {id:"volcengine",name:"火山 Ark",model:"doubao-seed-2-1-pro-260628"},
  {id:"longcat",name:"美团 LongCat",model:"LongCat-2.0",sidecar:true},
  {id:"qwen",name:"千问 / Qwen",model:"qwen3.7-max-2026-06-08",sidecar:true},
  {id:"zai",name:"GLM (智谱 / Z.ai)",model:"auto"},
  {id:"moonshot",name:"Kimi (月之暗面)",model:"auto"},
  {id:"openai-codex",name:"ChatGPT(OAuth 登录)",model:"auto",oauth:true},
  {id:"custom",name:"腾讯混元",model:"hy3-preview",cmpKeyOnly:true,freeModel:true},   // OpenAI 兼容槽(TokenHub)。官方语言模型做成下拉;freeModel 保留手填新 ID 的逃生口
  {id:"claude-code",name:"Claude (订阅)",model:"auto",oauth:true,newchatOnly:true},   // 委派官方 claude -p 走订阅(免 API key,真正能用的那条);单窗口可选但只能当"新对话 provider"(走独立后端 :7900),不能当 launchd 主后端(官方二进制不识别)。已合并掉原 anthropic(API Key)条:它对订阅令牌走 x-api-key 必 401,且会误显"已配置"
];   // 已删 OpenRouter / DeepInfra(felix 不用、未配置只显 ⚠)
const PROV_SHORT={deepseek:"DeepSeek",volcengine:"火山",longcat:"LongCat",qwen:"千问",zai:"GLM",moonshot:"Kimi","openai-codex":"ChatGPT",custom:"混元","claude-code":"Claude"};
function refreshActiveProviderChrome(provider){
  const active=state.threads.find(x=>x.id===state.activeId);
  const prov=provider||((active&&active.provider&&!active.compare)?active.provider:(window._newchatProv||window._mainModelProv||""));
  if(!prov) return;
  window._activeChatProv=prov;
  const disp=(prov===window._mainModelProv && window._mainModelName && window._mainModelName!=="auto")
    ? window._mainModelName
    : (PROV_SHORT[prov]||prov);
  const nm=$("#modelname"); if(nm) nm.textContent=disp;
  const chip=$("#modelchip");
  if(chip) chip.title=`当前显示:${prov}; 新对话默认:${window._newchatProv||window._mainModelProv||""}${window._newchatProv&&window._mainModelProv&&window._newchatProv!==window._mainModelProv?`(主后端 ${window._mainModelProv})`:""} — 点击切换`;
  loadBalance(prov);
}
async function switchActiveThreadProvider(provider, model){
  if(!state.activeId) return null;
  const body={tid:state.activeId,provider}; if(model) body.model=model;
  const d=await api("/api/thread-provider",{method:"POST",body:JSON.stringify(body)});
  if(d.error) throw new Error(d.error);
  const snap=await api(`/v1/threads/${state.activeId}`);   // 以持久化结果为准,避免只换顶部标签、实际 provider 仍是旧模型
  const persisted=snap?.thread||snap||{};
  const t=state.threads.find(x=>x.id===state.activeId);
  if(t){ t.provider=d.provider||provider; t.model=persisted.model||d.model||model||t.model; t.compare=false; }
  state._sig=null; renderThreads();
  refreshActiveProviderChrome(provider);
  const badge=$("#tmeta .badge"); if(badge) badge.textContent=PROV_SHORT[provider]||provider;   // 顶栏模型徽章立即跟上,不等重新打开对话
  return d;
}
async function loadModelLabel(){ try{ const d=await api("/api/model"); const c=d.current||{};
  let nc=""; try{ nc=(await api("/api/newchat-provider")).provider||""; }catch(e){}   // "新对话 provider":单窗口新建对话实际走它(可能 != 主配置,如主后端 deepseek 但新对话 claude-code)
  let prefs={}; try{ prefs=(await api("/api/model-pref")).prefs||{}; }catch(e){}
  const newProv=nc||c.provider||"?";
  window._newchatProv=newProv;   // 缓存新对话 provider → 乐观新建时直接用,不在发送关键路径再请求
  window._modelPrefs=prefs; window._mainModelProv=c.provider||""; window._mainModelName=c.model||"";
  const active=state.threads.find(x=>x.id===state.activeId);
  const prov=(active&&active.provider&&!active.compare)?active.provider:newProv;
  window._activeChatProv=prov;
  const disp=(prov===c.provider && c.model && c.model!=="auto") ? c.model : (PROV_SHORT[prov]||prov);   // chip 代表"下一个新对话用什么";newchat 覆盖主配置时显 newchat 友好名
  const nm=$("#modelname"); if(nm) nm.textContent=disp;
  const chip=$("#modelchip"); if(chip) chip.title=`当前显示:${prov}; 新对话默认:${newProv}${nc&&nc!==c.provider?`(主后端 ${c.provider})`:""} — 点击切换`;
  loadBalance(prov);
}catch(e){} }
async function openModelSwitch(preselect){
  openModal("切换模型","brain");
  const body=$("#modalBody");
  body.innerHTML=`<div class="model-current">当前:<b id="curmodel">…</b></div>
    <div class="prow"><select id="mprov" class="msearch flush"></select></div>
    <div class="prow" id="mvariantrow" style="display:none"><select id="mvariant" class="msearch flush" title="模型变体"></select></div>
    <div class="prow" id="meffortrow" style="display:none"><select id="meffort" class="msearch flush" title="Claude 推理 effort"><option value="">推理 effort:默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
    <div class="prow"><input id="mmodel" placeholder="模型名(可改)"></div>
    <div class="prow" id="mbaserow" style="display:none"><input id="mbase" placeholder="Token Plan / OpenAI 兼容 base URL"></div>
    <div class="prow" id="mkeyrow"><input id="mkey" type="password" placeholder="API key"></div>
    <div class="prow"><button class="btn primary" id="mswitch">切换并应用到当前对话</button></div>
    <div id="mhint" class="panel-note">切换后<b>当前打开的对话下一条</b>会直接使用此模型;没有打开对话时,只会设置新对话默认模型。其它未打开的旧对话保持原模型。切换可能重启对应后端几秒,会话数据不丢。key 存本机,不外传。</div>`;
  let keyed={}, curNc="", prefs={}, providerBases={}, providerCredentials={};
  try{ const d=await api("/api/model"); keyed=d.keyed||{};
    providerBases=d.provider_bases||{};
    providerCredentials=d.provider_credentials||{};
    try{ curNc=(await api("/api/newchat-provider")).provider||""; }catch(e){}
    try{ const mp=await api("/api/model-pref"); prefs=mp.prefs||{}; window._effortPrefs=mp.effort||{}; }catch(e){}   // 各 provider 当前所选模型变体 + claude effort
    $("#curmodel").textContent = (curNc && curNc!==d.current.provider)
      ? `${PROV_SHORT[curNc]||curNc}(新对话)· 主后端 ${d.current.provider}`   // newchat 覆盖主配置时,明确两者
      : `${d.current.provider} / ${d.current.model||"(默认)"}`;
  }catch(e){ $("#curmodel").textContent="读取失败"; }
  const sel=$("#mprov");
  const providerReadyLabel=p=>{
    if(p.id!=="qwen") return keyed[p.id]?"  ✓已配置":"";
    const qc=providerCredentials.qwen||{}, workspace=(qc.workspace||{}).configured, token=(qc.token_plan||{}).configured;
    if(workspace&&token) return "  ✓普通 API + Token Plan";
    if(token) return "  ✓Token Plan";
    if(workspace) return "  ✓普通 API";
    return "";
  };
  sel.innerHTML=PROVIDERS.map(p=>`<option value="${p.id}">${p.name}${providerReadyLabel(p)}</option>`).join("");   // 含 claude-code(newchatOnly):单窗口可选,选它只设"新对话 provider"(见 mswitch),不动 launchd 主后端
  if(preselect && PROVIDERS.some(p=>p.id===preselect)) sel.value=preselect;
  else if(curNc && PROVIDERS.some(p=>p.id===curNc)) sel.value=curNc;   // 预选当前"新对话 provider",打开即见实际状态
  const sync=()=>{ const p=PROVIDERS.find(x=>x.id===sel.value)||{};
    const vars=MODEL_VARIANTS[sel.value]||[];                       // 有预设变体 → 用下拉;freeModel 额外保留手填框
    if(vars.length){
      $("#mvariantrow").style.display="flex";
      const cm=prefs[sel.value]||p.model||(vars[0]&&vars[0].id);
      const opts=(cm && !vars.some(v=>v.id===cm)) ? vars.concat([{id:cm,name:"自定义: "+cm}]) : vars;
      $("#mvariant").innerHTML=opts.map(v=>`<option value="${esc(v.id)}" ${v.id===cm?"selected":""}>${esc(v.name)}</option>`).join("");
      if(p.freeModel){
        $("#mmodel").parentElement.style.display="flex"; $("#mmodel").value=cm||""; $("#mmodel").placeholder="模型 ID(可改;下拉会同步)";
      } else { $("#mmodel").parentElement.style.display="none"; }
    } else { $("#mvariantrow").style.display="none"; $("#mvariant").onchange=null; $("#mmodel").parentElement.style.display="flex"; $("#mmodel").value=prefs[sel.value]||p.model||""; $("#mmodel").placeholder=p.freeModel?"模型 ID,如 hy3-preview":"模型名(可改)"; }
    if(EFFORT_PROVIDERS.includes(sel.value)){ $("#meffortrow").style.display="flex"; $("#meffort").value=(window._effortPrefs&&window._effortPrefs[sel.value])||""; }   // Claude / GPT 有推理 effort
    else $("#meffortrow").style.display="none";
    const baseRow=$("#mbaserow"), baseInput=$("#mbase"), keyInput=$("#mkey"), sw=$("#mswitch");
    $("#mkeyrow").style.display=p.oauth?"none":"flex";
    keyInput.placeholder=p.oauth?"OAuth 登录,无需 key":(keyed[p.id]?"已配置,留空=不改":(p.cmpKeyOnly?"必填:TokenHub 模型调用 api_key(sk- 开头)":"必填:该 provider 的 API key"));
    keyInput.oninput=null;
    if(sw){
      sw.disabled=false;
      sw.textContent=p.cmpKeyOnly?"保存并应用到当前对话":(p.newchatOnly||p.sidecar?"应用到当前对话":"切换并应用到当前对话");
    }
    const qwenTokenPlanBase="https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
    const qwenCred=providerCredentials.qwen||{}, qwenWorkspace=qwenCred.workspace||{}, qwenTokenPlan=qwenCred.token_plan||{};
    const updateQwenHint=()=>{
      const chosen=vars.length?$("#mvariant").value:$("#mmodel").value.trim();
      const tokenPlan=chosen.startsWith("qwen3.8-");
      const profile=tokenPlan?"token_plan":"workspace";
      if(keyInput.dataset.qwenProfile && keyInput.dataset.qwenProfile!==profile) keyInput.value="";
      keyInput.dataset.qwenProfile=profile;
      if(tokenPlan){
        if(!baseInput.value||baseInput.value===providerBases.qwen||baseInput.dataset.autoBase==="legacy"){
          baseInput.value=qwenTokenPlan.base_url||qwenTokenPlanBase;
          baseInput.dataset.autoBase="token-plan";
        }
      } else if(baseInput.dataset.autoBase==="token-plan"){
        baseInput.value=qwenWorkspace.base_url||providerBases.qwen||"";
        baseInput.dataset.autoBase="legacy";
      }
      const ready=tokenPlan?!!qwenTokenPlan.configured:!!qwenWorkspace.configured;
      keyInput.placeholder=tokenPlan
        ? (ready?"Token Plan 已配置,留空=不改":"必填:Token Plan 专用 API key(普通千问 key 不会复用)")
        : (ready?"普通千问 API 已配置,留空=不改":"必填:百炼/工作区 API key");
      if(sw){
        sw.disabled=!ready&&!keyInput.value.trim();
        sw.textContent=sw.disabled?"先填写专用 API key":"应用到当前对话";
      }
      keyInput.oninput=()=>updateQwenHint();
      $("#mhint").innerHTML=tokenPlan
        ? `<b>Qwen3.8 Max Preview 仅 Token Plan 可用。</b>${ready?"已检测到保存过的 Token Plan 凭据,可直接应用。":"当前只有普通千问凭据；请填写 Token Plan API Keys 页面提供的专用 base URL 与专用 key。"}普通百炼/工作区 key 不会被拿来试请求；校验成功后才切换。`
        : "切换后<b>当前打开的对话下一条</b>会直接使用此模型；千问配置会先做最小请求校验，失败不会覆盖当前可用配置。";
    };
    if(sel.value==="qwen"){
      baseRow.style.display="flex";
      if(baseInput.dataset.provider!=="qwen"){
        baseInput.value=providerBases.qwen||"";
        baseInput.dataset.provider="qwen";
        baseInput.dataset.autoBase="legacy";
      }
      updateQwenHint();
    } else {
      baseRow.style.display="none";
      baseInput.dataset.provider="";
      $("#mhint").innerHTML="切换后<b>当前打开的对话下一条</b>会直接使用此模型；没有打开对话时，只会设置新对话默认模型。其它未打开的旧对话保持原模型。";
    }
    $("#mvariant").onchange=()=>{
      if(p.freeModel) $("#mmodel").value=$("#mvariant").value;
      if(sel.value==="qwen") updateQwenHint();
    };
  };   // custom/claude-code/sidecar 不切主后端,但可 pin 当前 thread
  sel.onchange=()=>{ $("#mkey").value=""; $("#mkey").dataset.qwenProfile=""; sync(); }; sync();
  if(window.loadProviderModels) window.loadProviderModels().then(()=>sync()).catch(()=>{});
  $("#mswitch").onclick=async()=>{
    const provider=sel.value, api_key=$("#mkey").value;
    const p=PROVIDERS.find(x=>x.id===provider)||{};
    const vars=MODEL_VARIANTS[provider]||[];
    const variant = vars.length ? (p.freeModel ? ($("#mmodel").value.trim() || $("#mvariant").value) : $("#mvariant").value) : $("#mmodel").value.trim();   // 所选模型变体/手填模型 ID
    const qwenState=providerCredentials.qwen||{};
    const modelCredentialReady=provider==="qwen"
      ? !!((variant.startsWith("qwen3.8-")?(qwenState.token_plan||{}):(qwenState.workspace||{})).configured)
      : !!keyed[provider];
    if(!p.oauth && !modelCredentialReady && !api_key){
      alert(provider==="qwen"&&variant.startsWith("qwen3.8-")
        ? "Qwen3.8 需要 Token Plan 专用 API key,普通千问 key 不会复用"
        : "该 provider 还没配置可用于此模型的 key —— 请先填 API key");
      return;
    }
    const b=$("#mswitch"); b.textContent=p.cmpKeyOnly?"校验中…":(p.newchatOnly||p.sidecar?"切换中…":"切换中,重启后端…"); b.disabled=true;
    try{
      if(p.cmpKeyOnly||p.sidecar){
        // 腾讯混元/LongCat:不切主后端。/api/model 只保存对应 provider key+模型;
        // 单窗口新对话再通过 /api/newchat-provider 路由到独立 provider 后端,主 :7878 保持当前默认不动。
        const payload={provider,model:variant||p.model||"hy3-preview",api_key};
        if(provider==="qwen") payload.base_url=$("#mbase").value.trim();
        const d=await api("/api/model",{method:"POST",body:JSON.stringify(payload)});
        if(d.error){ alert("保存失败: "+d.error); b.textContent=p.cmpKeyOnly?"保存并应用到当前对话":"应用到当前对话"; b.disabled=false; return; }
        if(d.warning){ b.title=d.warning; cwToast("⚠ "+d.warning); }
        if(variant){ try{ await api("/api/model-pref",{method:"POST",body:JSON.stringify({provider,model:variant})}); }catch(e){} }
        await api("/api/newchat-provider",{method:"POST",body:JSON.stringify({provider})});
        if(state.activeId) await switchActiveThreadProvider(provider, variant||p.model||"hy3-preview");
        const label=PROV_SHORT[provider]||provider;
        b.textContent=state.activeId?("✓ 当前对话下一条用"+label):("✓ 已设为"+label+"默认");
        setTimeout(()=>{ closeModal(); loadModelLabel(); loadThreads(); }, 700);
        return;
      }
      if(p.newchatOnly){
        // claude-code(订阅,委派 claude -p)不能当 launchd 主后端(官方二进制不识别)→ 只设"新对话 provider":
        // 新对话走它的独立后端 :7900,主后端 :7878 保持原默认(deepseek)不动、不重启。
        await api("/api/newchat-provider",{method:"POST",body:JSON.stringify({provider})});
      } else {
        // set_model 用安全 model:deepseek/volcengine/longcat 可填具体 id;其它非 deepseek 用 auto,变体走 pref
        const sm = (provider==="deepseek" || provider==="volcengine" || provider==="longcat") ? (variant||p.model||"auto") : (p.model||"auto");
        const d=await api("/api/model",{method:"POST",body:JSON.stringify({provider,model:sm,api_key})});
        if(d.error){ alert("切换失败: "+d.error); b.textContent="切换并重启后端"; b.disabled=false; return; }
        try{ await api("/api/newchat-provider",{method:"POST",body:JSON.stringify({provider})}); }catch(e){}   // 新对话锁定此 provider(每对话锁模型)
      }
      const body={provider}; if(variant) body.model=variant; if(EFFORT_PROVIDERS.includes(provider)) body.effort=$("#meffort").value;   // 模型变体 + Claude/GPT effort 存 pref(单窗口+对比共用)
      if(body.model||"effort" in body){ try{ await api("/api/model-pref",{method:"POST",body:JSON.stringify(body)}); }catch(e){} }
      if(state.activeId) await switchActiveThreadProvider(provider, variant||p.model||"");
      b.textContent="✓ "+(state.activeId?"当前对话下一条用 ":"已设为默认 ")+(PROV_SHORT[provider]||provider)+(variant?(" · "+variant):"");
      setTimeout(()=>{ const a=state.activeId, r=state.running; closeModal(); if(!r){ closeStream(); if(a) openThread(a); } loadThreads(); loadModelLabel(); loadBalance(); }, 700);   // 空闲时重连当前会话到新 provider;正在跑则不断流,下一条自然走新模型
    }catch(e){ alert("切换失败: "+e.message); b.textContent="切换并重启后端"; b.disabled=false; }
  };
}

/* ---------- 更新中心:一级概览 + 二级详情 ---------- */
const UPDATE_VIEWS={
  overview:{title:"更新",desc:"一级看 GUI、后端、大模型、Harness、Skill；大模型/Harness/Skill 点进去看完整二级明细。"},
  models:{title:"大模型",desc:"逐个检查 provider、key/OAuth 状态、当前模型和可选模型变体。"},
  harness:{title:"研究 Harness",desc:"逐个检查研究引擎桥接脚本、输出目录和 Harness 包更新。"},
  skills:{title:"Skill / 插件",desc:"查看插件安装、修复、更新和 skill 数量。"}
};
function updateBadge(cls,text,title=""){ return `<span class="st ${cls}"${title?` title="${escAttr(title)}"`:""}>${esc(text)}</span>`; }
function updateMeta(id,text){ const el=$("#"+id); if(el) el.textContent=text||""; }
function updateStatus(id,html){ const el=$("#"+id); if(el) el.innerHTML=html||""; }
function updateAction(id,btnText,fn){
  const el=$("#"+id); if(!el) return;
  const b=document.createElement("button"); b.className="btn primary"; b.textContent=btnText; b.onclick=()=>fn(b);
  el.innerHTML=""; el.appendChild(b);
}
function renderUpdateCard(id,iconName,title,desc,clickable){
  const tag=clickable?"button":"div";
  const arrow=clickable?`<span class="update-card-arrow">›</span>`:"";
  return `<${tag} class="update-card${clickable?" can-open":""}" ${clickable?`data-view="${escAttr(id)}"`:""}>
    <div class="update-card-main"><div class="update-card-title">${icon(iconName)}${esc(title)}</div><div class="update-card-desc">${esc(desc)}</div><div class="update-card-meta" id="u_${id}_meta">检查中…</div></div>
    <div class="update-card-side"><span id="u_${id}_status">${updateBadge("unknown","检查中")}</span><span id="u_${id}_act"></span>${arrow}</div>
  </${tag}>`;
}
async function renderUpdateCenter(target,view="overview"){
  view=UPDATE_VIEWS[view]?view:"overview";
  const info=UPDATE_VIEWS[view];
  target.innerHTML=`<div class="settings-head"><div><h4>${esc(info.title)}</h4><p>${esc(info.desc)}</p></div><div class="settings-actions">${view!=="overview"?`<button class="btn" id="u_back">返回</button>`:""}<button class="btn" id="u_refresh">重新检查</button></div></div>
    <div class="update-center" id="u_center"></div>`;
  const refresh=$("#u_refresh"); if(refresh) refresh.onclick=()=>renderUpdateCenter(target,view);
  const back=$("#u_back"); if(back) back.onclick=()=>renderUpdateCenter(target,"overview");
  if(view==="models") return renderModelUpdateDetail(target);
  if(view==="harness") return renderHarnessUpdateDetail(target);
  if(view==="skills") return renderSkillUpdateDetail(target);
  renderUpdateOverview(target);
}
function renderUpdateOverview(target){
  const box=$("#u_center");
  box.innerHTML=`<div class="update-grid">
    ${renderUpdateCard("gui","monitor","GUI","界面版本、签名更新包。",false)}
    ${renderUpdateCard("backend","server","CodeWhale 后端","本机 codewhale CLI / agent 后端。",false)}
    ${renderUpdateCard("models","brain","大模型","Provider key、默认模型和 effort 配置。",true)}
    ${renderUpdateCard("harness","flask","Harness","DeerFlow、GPT Researcher、ODR 等研究引擎。",true)}
    ${renderUpdateCard("skills","puzzle","Skill","GitHub 插件、本地插件和子 skill。",true)}
  </div>
  <div class="panel-note mt12">GUI 与 Harness 更新走签名验证；CodeWhale 后端走 <code>codewhale update</code>；插件优先 fast-forward,非 git 插件按来源安装/修复。</div>`;
  box.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>renderUpdateCenter(target,b.dataset.view));
  loadUpdateOverviewStatus();
}
async function loadUpdateOverviewStatus(){
  (async()=>{
    try{
      const d=await api("/api/update/gui/check");
      updateMeta("u_gui_meta",`当前 ${d.current||"?"}${d.latest?` · 最新 ${d.latest}`:""}`);
      if(d.enabled===false) updateStatus("u_gui_status",updateBadge("unknown","未配置"));
      else if(d.error) updateStatus("u_gui_status",updateBadge("err",/404|not found|403|401/i.test(d.error)?"源不可用":"检查失败",d.error));
      else if(d.available){ updateStatus("u_gui_status",""); updateAction("u_gui_act","更新到 "+d.latest,b=>applyUpd(b,"/api/update/gui/apply")); }
      else updateStatus("u_gui_status",updateBadge("ok","已是最新"));
    }catch(e){ updateStatus("u_gui_status",updateBadge("err","检查失败",e.message)); updateMeta("u_gui_meta",""); }
  })();
  (async()=>{
    try{
      const d=await api("/api/update/check");
      updateMeta("u_backend_meta",`当前 ${d.current||"?"}${d.latest?` · 最新 ${d.latest}`:""}`);
      if(d.error) updateStatus("u_backend_status",updateBadge("err","检查失败",d.error));
      else if(d.available&&d.latest){ updateStatus("u_backend_status",""); updateAction("u_backend_act","更新到 "+d.latest,b=>applyUpd(b,"/api/update/apply")); }
      else updateStatus("u_backend_status",updateBadge("ok","已是最新"));
    }catch(e){ updateStatus("u_backend_status",updateBadge("err","检查失败",e.message)); updateMeta("u_backend_meta",""); }
  })();
  (async()=>{
    try{
      const [m,p]=await Promise.all([api("/api/model"),api("/api/model-pref")]);
      const keyed=m.keyed||{}, prefs=(p&&p.prefs)||{};
      const providerRows=modelProviderRows(keyed,prefs,(p&&p.effort)||{});
      const configured=providerRows.filter(x=>x.ready).length;
      const variants=providerRows.reduce((n,x)=>n+x.variants.length,0);
      const cur=m.current||{};
      updateMeta("u_models_meta",`${configured}/${providerRows.length} provider 可用 · ${variants} 个模型变体 · 当前 ${PROV_SHORT[cur.provider]||cur.provider||"?"}${cur.model?` / ${cur.model}`:""}`);
      updateStatus("u_models_status",updateBadge(configured?"ok":"unknown",configured?`${configured} 可用`:"未配置"));
    }catch(e){ updateStatus("u_models_status",updateBadge("err","检查失败",e.message)); updateMeta("u_models_meta",""); }
  })();
  (async()=>{
    try{
      const [u,hs]=await Promise.all([api("/api/update/harness/check"),api("/api/harnesses")]);
      const total=Array.isArray(hs)?hs.length:0, ok=Array.isArray(hs)?hs.filter(x=>x.available).length:0;
      const names=(Array.isArray(hs)?hs:[]).slice(0,4).map(x=>x.name||x.id).join("、");
      updateMeta("u_harness_meta",`${ok}/${total} 引擎可用${names?` · ${names}${total>4?"…":""}`:""}${u.current?` · 包 ${u.current}`:""}`);
      if(u.error) updateStatus("u_harness_status",updateBadge("err","检查失败",u.error));
      else if(u.available){ updateStatus("u_harness_status",""); updateAction("u_harness_act","更新",applyHarnessUpd); }
      else updateStatus("u_harness_status",updateBadge("ok","已是最新"));
    }catch(e){ updateStatus("u_harness_status",updateBadge("err","检查失败",e.message)); updateMeta("u_harness_meta",""); }
  })();
  (async()=>{
    try{
      const rows=await api("/api/update/plugins/check");
      const items=Array.isArray(rows)?rows:[], installed=items.filter(x=>x.installed!==false).length;
      const available=items.filter(x=>x.available||x.installable||x.repairable||x.installed===false).length;
      const skills=items.reduce((n,x)=>n+(Number(x.skill_count)||0),0);
      updateMeta("u_skills_meta",`${installed}/${items.length} 插件已安装 · ${skills} skills`);
      updateStatus("u_skills_status",updateBadge(available?"unknown":"ok",available?`${available} 可处理`:"已是最新"));
    }catch(e){ updateStatus("u_skills_status",updateBadge("err","检查失败",e.message)); updateMeta("u_skills_meta",""); }
  })();
}
function modelProviderRows(keyed={},prefs={},effort={}){
  const catalog=window._providerModelCatalog||{};
  const dynamicVariants=id=>{
    const models=Array.isArray(catalog[id]&&catalog[id].models)?catalog[id].models:[];
    return models.map(m=>({id:m.id,name:m.name||m.id})).filter(m=>m.id);
  };
  const variantsFor=id=>{
    const dyn=dynamicVariants(id);
    return dyn.length ? dyn : ((typeof MODEL_VARIANTS!=="undefined"&&MODEL_VARIANTS[id])||[]);
  };
  const catalogMeta=id=>{
    const info=catalog[id]||{};
    if(info.ok) return `接口返回 ${Number(info.count)||0} 个${info.source?` · ${String(info.source).replace("https://","").replace("http://","")}`:""}`;
    if(info.error) return `接口检查失败: ${info.error}`;
    if(info.reason==="oauth_or_cli") return "订阅/CLI 通道无 /models";
    if(info.reason==="no_key") return "未配置 key,无法检查 /models";
    return "";
  };
  const selectedFor=p=>prefs[p.id]||p.model||(variantsFor(p.id)[0]&&variantsFor(p.id)[0].id)||"";
  const readyFor=p=>{
    if(keyed[p.id]) return true;
    if(p.id==="claude-code" && (keyed["claude-code"]||keyed.anthropic)) return true;
    return !!(p.oauth && keyed[p.id]);
  };
  const rows=PROVIDERS.map(p=>{
    const variants=variantsFor(p.id);
    const selected=selectedFor(p);
    const selectedName=(variants.find(v=>v.id===selected)||{}).name||selected||"auto";
    return {
      id:p.id,
      name:p.name,
      short:PROV_SHORT[p.id]||p.id,
      selected,
      selectedName,
      variants,
      effort:effort[p.id]||"",
      ready:readyFor(p),
      auth:p.oauth?(p.id==="claude-code"?"订阅 / OAuth":"OAuth"):"API key",
      note:p.sidecar?"独立后端":(p.newchatOnly?"新对话独立后端":(p.cmpKeyOnly?"OpenAI 兼容槽":"主/对比可用")),
      modelSource:catalogMeta(p.id),
    };
  });
  const known=new Set(rows.map(x=>x.id));
  Object.keys(keyed||{}).filter(k=>keyed[k] && k && !known.has(k) && k!=="*" && k!=="Run").forEach(k=>{
    rows.push({id:k,name:PROV_SHORT[k]||k,short:PROV_SHORT[k]||k,selected:prefs[k]||"",selectedName:prefs[k]||"由后端默认",variants:[],effort:effort[k]||"",ready:true,auth:"已配置",note:"CodeWhale 配置中存在"});
  });
  return rows;
}
async function renderModelUpdateDetail(){
  const box=$("#u_center");
  box.innerHTML='<div class="update-detail-grid"><div class="panel-empty">加载中…</div></div>';
  try{
    if(window.loadProviderModels) await window.loadProviderModels();
    const [m,p]=await Promise.all([api("/api/model"),api("/api/model-pref")]);
    const keyed=m.keyed||{}, prefs=(p&&p.prefs)||{}, effort=(p&&p.effort)||{}, cur=m.current||{};
    const rows=modelProviderRows(keyed,prefs,effort);
    box.innerHTML=`<div class="update-summary-strip">
      <span>当前主后端: <b>${esc(PROV_SHORT[cur.provider]||cur.provider||"未知")}</b>${cur.model?` · ${esc(cur.model)}`:""}</span>
      <span>${rows.filter(x=>x.ready).length}/${rows.length} provider 可用</span>
      <span>${rows.reduce((n,x)=>n+x.variants.length,0)} 个模型变体</span>
    </div>
    <div class="update-detail-grid model-detail-grid">
      ${rows.map(r=>`<div class="update-detail-card">
        <div class="update-detail-title"><span>${esc(r.short)}</span>${updateBadge(r.ready?"ok":"unknown",r.ready?"可用":"未配置")}</div>
        <div class="update-detail-sub">${esc(r.name)} · ${esc(r.auth)} · ${esc(r.note)}</div>
        <div class="update-detail-line"><b>当前模型</b><span>${esc(r.selectedName||r.selected||"auto")}${r.selected&&r.selectedName!==r.selected?` <code>${esc(r.selected)}</code>`:""}</span></div>
        ${r.modelSource?`<div class="update-detail-line"><b>模型目录</b><span>${esc(r.modelSource)}</span></div>`:""}
        ${r.effort?`<div class="update-detail-line"><b>推理 effort</b><span>${esc(r.effort)}</span></div>`:""}
        <div class="update-chip-row">${r.variants.length?r.variants.map(v=>`<span class="update-mini-chip${v.id===r.selected?" on":""}" title="${escAttr(v.id)}">${esc(v.name||v.id)}</span>`).join(""):`<span class="update-mini-chip muted">后端默认</span>`}</div>
      </div>`).join("")}
    </div>`;
  }catch(e){ box.innerHTML='<div class="panel-empty">大模型状态读取失败: '+esc(e.message||"")+'</div>'; }
}
async function renderHarnessUpdateDetail(){
  const box=$("#u_center");
  box.innerHTML=`<div class="update-sublist">
    <div class="lrow"><span class="nm">研究 Harness 包<span class="sub" id="u_harness_pkg_meta">检查中…</span></span><span class="update-action" id="u_harness_pkg_act">${updateBadge("unknown","检查中")}</span></div>
    <div id="u_harness_items"><div class="panel-empty">加载中…</div></div>
  </div>`;
  (async()=>{
    const a=$("#u_harness_pkg_act"), c=$("#u_harness_pkg_meta");
    try{
      const d=await api("/api/update/harness/check");
      c.textContent=`当前 ${d.current||"未安装"}${d.latest?` · 最新 ${d.latest}`:""}${d.repo?` · ${d.repo}`:""}`;
      if(d.error){ a.innerHTML=updateBadge("err","检查失败",d.error); return; }
      if(d.available){ const b=document.createElement("button"); b.className="btn primary"; b.textContent="更新 Harness"; b.onclick=()=>applyHarnessUpd(b); a.innerHTML=""; a.appendChild(b); }
      else a.innerHTML=updateBadge("ok","已是最新");
    }catch(e){ a.innerHTML=updateBadge("err","检查失败",e.message); }
  })();
  try{
    const hs=await api("/api/harnesses");
    const list=$("#u_harness_items");
    const items=Array.isArray(hs)?hs:[];
    if(!items.length){ list.innerHTML='<div class="panel-empty">还没有 Harness</div>'; return; }
    list.innerHTML=`<div class="update-detail-grid harness-detail-grid">${items.map(h=>`<div class="update-detail-card">
      <div class="update-detail-title"><span>${icon((engineForHarness(h)||{}).ico||"flask")} ${esc(h.name||h.id)}</span>${updateBadge(h.available?"ok":"err",h.available?"可用":"不可用")}</div>
      <div class="update-detail-sub">${esc(h.description||"")}</div>
      <div class="update-detail-line"><b>ID</b><code>${esc(h.id||"")}</code></div>
      <div class="update-detail-line"><b>桥接</b><span title="${escAttr(h.client||"")}">${esc(h.client||"")}</span></div>
      <div class="update-detail-line"><b>输出</b><span title="${escAttr(h.outdir||"")}">${esc(h.outdir||"")}</span></div>
    </div>`).join("")}</div>`;
  }catch(e){ $("#u_harness_items").innerHTML='<div class="panel-empty">Harness 列表读取失败: '+esc(e.message||"")+'</div>'; }
}
function renderSkillUpdateDetail(){
  const box=$("#u_center");
  box.innerHTML='<div id="u_plugins"></div>';
  renderPluginUpdateRows();
}
async function openUpdate(){
  openModal("更新","refresh");
  renderUpdateCenter($("#modalBody"));
}
async function applyUpd(btn,endpoint){
  if(endpoint.indexOf("/gui/")>=0){   // 界面更新:异步 + 下载/校验/应用 进度条
    if(!(await cwConfirm("开始更新界面?会下载、校验数字签名 + SHA-256 后替换并重启(会话数据不丢)。"))) return;
    return guiUpdateWithProgress(btn.parentNode);
  }
  // 后端(codewhale update):子进程,无细粒度进度,沿用同步
  if(!(await cwConfirm("开始更新?会下载、校验后替换并重启(几秒,会话数据不丢)。"))) return;
  btn.disabled=true; btn.textContent="更新中…";
  try{ const r=await api(endpoint,{method:"POST",body:"{}"});
    if(r.ok){ btn.textContent="✓ 重启中…"; scheduleReloadIfConnected(btn,4800); }
    else { btn.disabled=false; btn.textContent="✗ 重试"; alert("更新失败:\n"+(r.error||r.output||"未知错误")); }
  }catch(e){ btn.disabled=false; btn.textContent="✗ 重试"; alert("更新出错: "+e.message); }
}
// 界面更新进度:启动异步作业 → 每 400ms 轮询进度 → 画下载/校验/应用进度条 → 完成自动刷新
async function guiUpdateWithProgress(box){
  box.innerHTML='<div class="updprog"><div class="updbar"><div class="updfill"></div></div><div class="updtxt">开始…</div></div>';
  const fill=box.querySelector(".updfill"), txt=box.querySelector(".updtxt");
  let start; try{ start=await api("/api/update/gui/apply",{method:"POST",body:"{}"}); }
  catch(e){ txt.innerHTML='<span class="st err">启动失败:'+esc(e.message)+'</span>'; return; }
  if(!box.isConnected) return;
  if(start && start.error){ txt.innerHTML='<span class="st err">'+esc(start.error)+'</span>'; return; }
  const LAB={checking:"检查中",downloading:"下载中",verifying:"校验签名/完整性",applying:"应用中",restarting:"重启中"};
  const mb=n=>((n||0)/1048576).toFixed(1);
  const poll=setInterval(async()=>{
    if(!box.isConnected){ clearInterval(poll); return; }
    let p; try{ p=await api("/api/update/gui/progress"); }catch(e){ return; }
    if(!box.isConnected){ clearInterval(poll); return; }
    if(p.phase==="downloading"){ fill.style.width=(p.pct||0)+"%"; txt.textContent=`下载中 ${p.pct||0}%  (${mb(p.downloaded)}/${mb(p.total)} MB)`; }
    else if(!p.done){ fill.style.width="100%"; txt.textContent=(LAB[p.phase]||p.phase||"处理中")+"…"; }
    if(p.done){
      clearInterval(poll);
      if(p.error){ fill.classList.add("err"); txt.innerHTML='<span class="st err">更新失败:'+esc(p.error)+'</span>'; }
      else { fill.style.width="100%"; txt.textContent="✓ 更新完成 "+(p.version||"")+",重启中…"; scheduleReloadIfConnected(box,4500); }
    }
  },400);
}
async function applyHarnessUpd(btn){
  if(!(await cwConfirm("更新研究 Harness? 会从 GitHub Release 下载签名资产,校验后替换;若已配置 harness.env 会同步重装/刷新桥接脚本。"))) return;
  btn.disabled=true; btn.textContent="更新中…";
  try{
    const r=await api("/api/update/harness/apply",{method:"POST",body:"{}"});
    if(r.ok){ btn.textContent="✓ 已更新"; cwToast(r.output||"Harness 已更新"); loadPlugins(); }
    else { btn.disabled=false; btn.textContent="✗ 重试"; alert("Harness 更新失败:\n"+(r.error||r.output||"未知错误")); }
  }catch(e){ btn.disabled=false; btn.textContent="✗ 重试"; alert("Harness 更新出错: "+e.message); }
}
async function renderPluginUpdateRows(){
  const box=$("#u_plugins"); if(!box) return;
  box.innerHTML='<div class="panel-section-title mt16">GitHub 插件</div><div class="panel-empty">检查中…</div>';
  try{
    const rows=await api("/api/update/plugins/check");
    if(!Array.isArray(rows)||!rows.length){ box.innerHTML='<div class="panel-section-title mt16">GitHub 插件</div><div class="panel-empty">还没有安装 GitHub 插件</div>'; return; }
    box.innerHTML='<div class="panel-section-title mt16">GitHub 插件</div>';
    rows.forEach(p=>{
      const row=document.createElement("div"); row.className="lrow plugin-update-row";
      const name=p.displayName||p.name||p.id||"插件";
      const source=p.repo||p.source_url||p.remote||p.homepage||p.path||"";
      const status=p.installed===false?"未安装":(p.git?"Git 插件":"本地插件");
      const sub=[status, p.current&&("当前 "+p.current), p.latest&&p.latest!==p.current&&("最新 "+p.latest), p.branch, p.dirty&&"本地修改"].filter(Boolean).join(" · ");
      const details=[
        p.path&&("路径: "+p.path),
        source&&source!==p.path&&("来源: "+source),
        p.remote&&("remote: "+p.remote),
        p.upstream&&("upstream: "+p.upstream),
        p.ahead?("领先 "+p.ahead+" commit"):"",
        p.behind?("落后 "+p.behind+" commit"):"",
        p.error&&("状态: "+p.error),
      ].filter(Boolean);
      row.innerHTML=`<div class="plugin-update-main"><div class="plugin-update-title">${icon("puzzle")} ${esc(name)}<span class="sub">${esc(sub)}</span></div>
        ${details.length?`<div class="plugin-update-detail">${details.map(esc).join("<br>")}</div>`:""}</div><span class="update-action"></span>`;
      const act=row.querySelector(".update-action");
      const canApply=p.available||p.installable||p.repairable||p.installed===false;
      if(p.dirty){ act.innerHTML='<span class="st err">有本地修改</span>'; }
      else if(canApply){
        const b=document.createElement("button"); b.className="btn primary";
        b.textContent=p.installed===false?"安装":(p.repairable?"修复安装":(p.available?"更新":"安装"));
        b.onclick=()=>applyPluginUpd(b,p.id);
        act.appendChild(b);
      }else if(p.error){ act.innerHTML='<span class="st unknown">需配置来源</span>'; act.title=p.error; }
      else if(!p.git){ act.innerHTML='<span class="st unknown">本地</span>'; }
      else act.innerHTML='<span class="st ok">已是最新</span>';
      box.appendChild(row);
    });
  }catch(e){ box.innerHTML='<div class="panel-section-title mt16">GitHub 插件</div><div class="panel-empty">插件更新检查失败: '+esc(e.message||"")+'</div>'; }
}
async function applyPluginUpd(btn,id){
  if(!(await cwConfirm("安装/更新插件 "+id+"?\nGitHub 插件会 clone 或 fast-forward；本地插件会按来源重新挂载，目录有本地修改会拒绝覆盖。"))) return;
  btn.disabled=true; btn.textContent="处理中…";
  try{
    const r=await api("/api/update/plugins/apply",{method:"POST",body:JSON.stringify({id})});
    if(r.ok){ btn.textContent="✓ 已更新"; await loadPlugins(); renderPluginUpdateRows(); }
    else { btn.disabled=false; btn.textContent="✗ 重试"; alert("插件更新失败:\n"+(r.error||"未知错误")); }
  }catch(e){ btn.disabled=false; btn.textContent="✗ 重试"; alert("插件更新出错: "+e.message); }
}

/* ---------- wire up ---------- */
// 重启前端 + 后端:/api/reload?backend=1 让后端 app-server(:7878)先 kickstart,再让 server.py 自退,
// 两者都由 launchd KeepAlive 秒拉起;轮询等前端回来后自动刷新页面(后端重连要多等几秒,SSE 断了刷新后自然重连)。
async function restartGui(){
  const b=$("#guirestart"); if(b){ b.disabled=true; b.textContent="重启中…"; }
  cwToast("正在重启前端 + 后端,回来后自动刷新页面…");
  try{ await api("/api/reload?backend=1"); }catch(e){}   // 服务退出瞬间请求可能中断,属预期
  const t0=Date.now();
  setTimeout(function poll(){
    api("/api/netenv").then(()=>location.reload())
      .catch(()=>{ if(Date.now()-t0<60000) setTimeout(poll,1000);
        else { if(b){ b.disabled=false; b.textContent="⟳ 重启"; } cwToast("⚠ 60 秒内服务没回来,请手动刷新或查 webserver.log"); } });
  },1500);
}

function sidebarMobile(){ return window.innerWidth<=640; }
function closeDrawer(){ $("#sidebar")?.classList.remove("open"); $("#backdrop")?.classList.remove("show"); syncSidebarToggle(); }
function syncSidebarToggle(){
  const b=$("#sidebarToggle"); if(!b) return;
  const mobile=sidebarMobile(), open=$("#sidebar")?.classList.contains("open"), collapsed=document.documentElement.classList.contains("sidebar-collapsed");
  b.classList.toggle("on", mobile ? !!open : !!collapsed);
  b.title=mobile ? (open?"关闭侧栏":"打开侧栏") : (collapsed?"展开侧栏":"收起侧栏");
  b.setAttribute("aria-label",b.title);
}
function setSidebarCollapsed(v){
  document.documentElement.classList.toggle("sidebar-collapsed",!!v);
  try{ localStorage.removeItem("cw_sidebar_collapsed"); }catch(e){}
  syncSidebarToggle();
}
function toggleSidebar(){
  if(sidebarMobile()){
    $("#sidebar").classList.toggle("open");
    $("#backdrop").classList.toggle("show",$("#sidebar").classList.contains("open"));
    syncSidebarToggle();
  }else{
    setSidebarCollapsed(!document.documentElement.classList.contains("sidebar-collapsed"));
  }
}
function applySidebarWidth(w){
  const max=Math.max(260, Math.min(520, Math.floor(window.innerWidth*0.58)));
  const v=Math.max(210, Math.min(max, Math.round(+w||268)));
  document.documentElement.style.setProperty("--sidebar-w",v+"px");
  try{ localStorage.setItem("cw_sidebar_w",String(v)); }catch(e){}
}


function initSidebarControls(){
  $("#sidebarToggle").onclick=toggleSidebar;
  $("#backdrop").onclick=closeDrawer;
  applySidebarWidth(localStorage.getItem("cw_sidebar_w")||268);
  const sr=$("#sideresize");
  if(sr){
    sr.addEventListener("pointerdown",e=>{
      if(window.innerWidth<=640) return;
      e.preventDefault(); document.body.classList.add("sideresizing");
      const move=ev=>applySidebarWidth(ev.clientX);
      const up=()=>{ document.body.classList.remove("sideresizing"); window.removeEventListener("pointermove",move); };
      window.addEventListener("pointermove",move);
      window.addEventListener("pointerup",up,{once:true});
      move(e);
    });
    window.addEventListener("resize",()=>{ applySidebarWidth(localStorage.getItem("cw_sidebar_w")||268); syncSidebarToggle(); });
  }
  syncSidebarToggle();
}

let _zoom=Math.max(0.5,Math.min(3,+(localStorage.getItem("cw_zoom")||1)||1));
function applyZoom(z){ _zoom=Math.max(0.5,Math.min(3,Math.round(z*10)/10)); document.documentElement.style.zoom=_zoom; try{localStorage.setItem("cw_zoom",_zoom);}catch(e){} }
if(_zoom!==1) document.documentElement.style.zoom=_zoom;   // 启动/刷新/更新后保持上次缩放
// 字号:只缩放对话文字(不动整体布局),⌘+/⌘- 是整页缩放、这个是纯文字。持久化。
let _fs=Math.max(11,Math.min(26,parseInt(localStorage.getItem("cw_fs"))||14));
function applyFs(){ document.documentElement.style.setProperty("--chat-fs",_fs+"px"); const b=document.getElementById("fsval"); if(b)b.textContent=_fs; }
function setFs(v){ _fs=Math.max(11,Math.min(26,v)); try{localStorage.setItem("cw_fs",_fs);}catch(e){} applyFs(); }
function bumpFs(d){ setFs(_fs+d); }   // 内联 onclick 调全局函数(读 _fs 从本作用域,可靠)
// 对比窗口独立字号(--cmp-fs):对比是窄列/常独立窗口,跟主窗口分开调更合适;默认 13
let _cmpFs=Math.max(11,Math.min(26,parseInt(localStorage.getItem("cw_cmpfs"))||13));
function applyCmpFs(){ document.documentElement.style.setProperty("--cmp-fs",_cmpFs+"px"); }
function setCmpFs(v){ _cmpFs=Math.max(11,Math.min(26,v)); try{localStorage.setItem("cw_cmpfs",_cmpFs);}catch(e){} applyCmpFs(); }
function bumpCmpFs(d){ setCmpFs(_cmpFs+d); }


function initZoomControls(){
  if(_zoom!==1) document.documentElement.style.zoom=_zoom;   // 启动/刷新/更新后保持上次缩放
  applyCmpFs();
  applyFs();
  window.addEventListener("keydown",e=>{
    if(!(e.metaKey||e.ctrlKey)||e.altKey) return;             // 仅 ⌘/Ctrl(不含 Alt)组合,避免干扰正常输入
    if(e.key==="+"||e.key==="="){ e.preventDefault(); applyZoom(_zoom+0.1); }       // ⌘+ / ⌘= 放大
    else if(e.key==="-"||e.key==="_"){ e.preventDefault(); applyZoom(_zoom-0.1); }  // ⌘- 缩小
    else if(e.key==="0"){ e.preventDefault(); applyZoom(1); }                       // ⌘0 实际大小
  },{capture:true});
}
async function checkSetup(){   // 当前 provider 还没配 key(且非 OAuth)→ 自动弹「模型」引导首次配置
  try{ const d=await api("/api/model"); const p=d.current&&d.current.provider; const keyed=d.keyed||{};
    if(p && !keyed[p]){ setTimeout(()=>{ if(!$("#modal").classList.contains("show")) openModelSwitch(); }, 600); }
  }catch(e){}
}

export { loadBalance, loadVersion, checkUpdate, doUpdate, checkGuiUpdate, doGuiUpdate, openDeerFlow, closeDeerFlow, submitResearch, submitSkillResearch, submitDeerFlowFromInput, loadResearchSkills, renderDfSkills, renderDfEngines, applyDfEngine, renderDfTemplates, loadPlugins, renderPluginItemsInto, renderPlugins, renderCmpPlugins, fillCmpComposer, closeCmpPluginMenus, finishCmpPluginPick, researchModelKeyForEngine, researchFallbackForEngine, researchModelForCurrent, researchModelMetaText, researchStatsWithModel, dfModelForCurrent, researchApiForRecord, researchRecordTitle, appendResearchFileLinks, renderResearchRecord, restoreResearchRecords, saveResearchRecord, submitDeerFlow, initPanelDocumentHandlers, openModal, closeModal, openSettings, openSkills, openConnectors, PROVIDERS, PROV_SHORT, refreshActiveProviderChrome, switchActiveThreadProvider, loadModelLabel, openModelSwitch, openUpdate, applyUpd, guiUpdateWithProgress, restartGui, sidebarMobile, closeDrawer, syncSidebarToggle, setSidebarCollapsed, toggleSidebar, applySidebarWidth, initSidebarControls, applyZoom, applyFs, setFs, bumpFs, applyCmpFs, setCmpFs, bumpCmpFs, initZoomControls, checkSetup };
