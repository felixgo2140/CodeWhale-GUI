/* ---------- helpers ---------- */
// 原生壳老版本没实现 WKWebView 的 JS 对话框 → 系统 confirm()/alert() 静默失效(点了没反应)。
// 这里用页内自绘对话框兜底,不依赖原生;新原生壳(已加 WKUIDelegate)两条路都通。
function cwToast(msg){ let t=document.getElementById("cwtoast"); if(!t){ t=document.createElement("div"); t.id="cwtoast"; document.body.appendChild(t); }
  t.textContent=String(msg); t.classList.add("show"); clearTimeout(cwToast._t); cwToast._t=setTimeout(()=>t.classList.remove("show"),3200); }
window.alert = m => cwToast(m);   // 全局兜底:所有 alert() 改走页内 toast,原生壳里也能看到
function cwConfirm(msg){ return new Promise(res=>{
  const ov=document.createElement("div"); ov.className="cwdlg-ov";
  ov.innerHTML=`<div class="cwdlg"><div class="cwdlg-m"></div><div class="cwdlg-b"><button class="cwdlg-cancel">取消</button><button class="cwdlg-ok">确定</button></div></div>`;
  ov.querySelector(".cwdlg-m").textContent=String(msg);
  document.body.appendChild(ov);
  const done=v=>{ ov.remove(); res(v); };
  ov.querySelector(".cwdlg-ok").onclick=()=>done(true);
  ov.querySelector(".cwdlg-cancel").onclick=()=>done(false);
  ov.onclick=e=>{ if(e.target===ov) done(false); };
  setTimeout(()=>ov.querySelector(".cwdlg-ok").focus(),30);
}); }
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const escAttr = s => esc(s).replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const ICONS={
  sidebar:'<rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M9 4v16"></path>',
  plus:'<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  puzzle:'<path d="M19 13v5a2 2 0 0 1-2 2h-5v-3a2 2 0 1 0-4 0v3H5a2 2 0 0 1-2-2v-3h3a2 2 0 1 0 0-4H3V6a2 2 0 0 1 2-2h5v3a2 2 0 1 0 4 0V4h3a2 2 0 0 1 2 2v3h-3a2 2 0 1 0 0 4h3z"></path>',
  plug:'<path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v4a6 6 0 0 1-12 0V8z"></path>',
  scale:'<path d="M12 3v18"></path><path d="M7 4h10"></path><path d="M6 7l-4 7h8z"></path><path d="M18 7l-4 7h8z"></path>',
  refresh:'<path d="M21 12a9 9 0 0 1-15.2 6.5"></path><path d="M3 12A9 9 0 0 1 18.2 5.5"></path><path d="M18 2v4h-4"></path><path d="M6 22v-4h4"></path>',
  update:'<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>',
  monitor:'<rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8"></path><path d="M12 17v4"></path>',
  tablet:'<rect x="6" y="3" width="12" height="18" rx="2"></rect><path d="M11 18h2"></path>',
  phone:'<rect x="7" y="2" width="10" height="20" rx="2"></rect><path d="M11 18h2"></path>',
  paperclip:'<path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5"></path>',
  file:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h6"></path>',
  send:'<path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4z"></path>',
  stop:'<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
  copy:'<rect x="9" y="9" width="10" height="10" rx="2"></rect><rect x="5" y="5" width="10" height="10" rx="2"></rect>',
  check:'<path d="M20 6 9 17l-5-5"></path>',
  edit:'<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path>',
  trash:'<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>',
  pin:'<path d="M12 17v5"></path><path d="M5 17h14"></path><path d="M7 4h10l-2 7 3 6H6l3-6z"></path>',
  settings:'<path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5z"></path><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7.1 4l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 1 1 19.9 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path>',
  alert:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>',
  message:'<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
  brain:'<path d="M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5.2A3 3 0 0 0 6 17v1a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"></path><path d="M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5.2A3 3 0 0 1 18 17v1a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"></path><path d="M8 8h2"></path><path d="M14 8h2"></path><path d="M8 14h2"></path><path d="M14 14h2"></path>',
  chip:'<rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M9 1v4"></path><path d="M15 1v4"></path><path d="M9 19v4"></path><path d="M15 19v4"></path><path d="M1 9h4"></path><path d="M1 15h4"></path><path d="M19 9h4"></path><path d="M19 15h4"></path>',
  tool:'<path d="M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.4 2.4-3-3z"></path>',
  clock:'<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  flask:'<path d="M9 2h6"></path><path d="M10 2v6l-5 9a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-9V2"></path><path d="M8 15h8"></path>',
  server:'<rect x="3" y="4" width="18" height="6" rx="2"></rect><rect x="3" y="14" width="18" height="6" rx="2"></rect><path d="M7 7h.01"></path><path d="M7 17h.01"></path>',
  globe:'<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18"></path><path d="M12 3a14 14 0 0 0 0 18"></path>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.9"></path><path d="M16 3.1a4 4 0 0 1 0 7.8"></path>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
  compass:'<circle cx="12" cy="12" r="9"></circle><path d="m15 9-2 6-4 2 2-6z"></path>',
  repeat:'<path d="M17 2l4 4-4 4"></path><path d="M3 11V9a3 3 0 0 1 3-3h15"></path><path d="M7 22l-4-4 4-4"></path><path d="M21 13v2a3 3 0 0 1-3 3H3"></path>',
  calendar:'<rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h18"></path>',
  factory:'<path d="M3 21V8l7 5V8l7 5V3h4v18z"></path><path d="M7 17h.01"></path><path d="M11 17h.01"></path><path d="M15 17h.01"></path>',
  coins:'<circle cx="8" cy="8" r="5"></circle><path d="M13 8c0 2.8-2.2 5-5 5"></path><path d="M16 10a5 5 0 1 1-3 9"></path>',
  receipt:'<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .7V2z"></path><path d="M8 7h8"></path><path d="M8 11h8"></path><path d="M8 15h5"></path>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
  briefcase:'<rect x="3" y="7" width="18" height="13" rx="2"></rect><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M3 12h18"></path>',
  hash:'<path d="M4 9h16"></path><path d="M4 15h16"></path><path d="M10 3 8 21"></path><path d="m16 3-2 18"></path>',
  chevronLeft:'<path d="m15 18-6-6 6-6"></path>',
  chevronRight:'<path d="m9 18 6-6-6-6"></path>',
  chevronDown:'<path d="m6 9 6 6 6-6"></path>',
  external:'<path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"></path>',
  x:'<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
  arrowRight:'<path d="M5 12h14"></path><path d="m13 6 6 6-6 6"></path>',
  layout:'<rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M3 12h18"></path><path d="M12 3v18"></path>',
  maximize:'<path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path>'
};
function icon(name, extra=""){ return `<svg class="ico${extra?(" "+extra):""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]||""}</svg>`; }
function iconLabel(name,label){ return `${icon(name)}<span>${label}</span>`; }
function setButtonIcon(sel,name,label){
  const b=$(sel); if(!b) return;
  b.innerHTML=label==null ? icon(name) : iconLabel(name,label);
  const aria=label || b.getAttribute("title") || b.textContent.trim();
  if(aria) b.setAttribute("aria-label",aria);
}
function hydrateIcons(){
  setButtonIcon("#sidebarToggle","sidebar");
  setButtonIcon("#newbtn","plus","新建对话");
  setButtonIcon("#skillsbtn","puzzle","Skills");
  setButtonIcon("#mcpbtn","plug","连接器");
  setButtonIcon("#cmpbtn","scale","对比");
  setButtonIcon("#settingsbtn","settings","设置");
  setButtonIcon("#updatebtn","refresh","更新");
  setButtonIcon("#updbtn","update","更新");
  setButtonIcon("#guiupdbtn","monitor","界面");
  setButtonIcon("#previewbtn","monitor","预览");
  const modelChip=$("#modelchip"), modelName=$("#modelname");
  if(modelChip && modelName && !modelChip.querySelector(".ico")) modelChip.insertAdjacentHTML("afterbegin",icon("brain"));
  setButtonIcon("#interruptbtn","stop","停止");
  setButtonIcon("#attachbtn","paperclip");
  setButtonIcon("#sendbtn","send");
  setButtonIcon("#scrollbtn","chevronDown");
  setButtonIcon("#pvBack","chevronLeft");
  setButtonIcon("#pvForward","chevronRight");
  setButtonIcon("#pvRefresh","refresh");
  setButtonIcon("#pvGo","arrowRight","打开");
  setButtonIcon("#pvExternal","external");
  setButtonIcon("#pvCopy","copy");
  setButtonIcon("#pvExportPdf","file","导出 PDF");
  setButtonIcon("#pvReveal","file","Finder");
  setButtonIcon("#pvClose","x");
  setButtonIcon("#cmpAttachBtn","paperclip");
  setButtonIcon("#cmpSendBtn","send","发送");
  setButtonIcon("#cmpStopAllBtn","stop","停止全部");
  setButtonIcon("#cmpNewBtn","plus","新对话");
  setButtonIcon("#cmpResetBtn","refresh","重启后端");
  setButtonIcon("#cmpClose","x","退出");
  document.querySelectorAll("[data-pv-size]").forEach(b=>{
    const nm=b.dataset.pvSize==="phone"?"phone":(b.dataset.pvSize==="tablet"?"tablet":"monitor");
    const label=b.dataset.pvSize==="phone"?"手机":(b.dataset.pvSize==="tablet"?"平板":"桌面");
    b.innerHTML=iconLabel(nm,label);
  });
}
function keyboardButton(el,action,label){
  el.tabIndex=0;
  el.setAttribute("role","button");
  if(label) el.setAttribute("aria-label",label);
  el.addEventListener("keydown",e=>{
    if(e.target!==el) return;
    if(e.key==="Enter"||e.key===" "){ e.preventDefault(); action(e); }
  });
}
function relTime(s){ if(!s) return ""; const d=(Date.now()-new Date(s).getTime())/1000;
  if(d<60)return "刚刚"; if(d<3600)return Math.floor(d/60)+"分钟前"; if(d<86400)return Math.floor(d/3600)+"小时前"; return Math.floor(d/86400)+"天前"; }
function timelineTimeValue(v){
  if(v && typeof v==="object"){
    v=v.started_at||v.created_at||v.updated_at||v.ended_at||v.time||v.ts||"";
  }
  const d=v ? new Date(v) : new Date();
  return Number.isFinite(d.getTime()) ? d : new Date();
}
function timelineTimeLabel(v){
  const d=timelineTimeValue(v), now=new Date();
  const pad=n=>String(n).padStart(2,"0");
  const hm=pad(d.getHours())+":"+pad(d.getMinutes());
  if(d.toDateString()===now.toDateString()) return hm;
  return pad(d.getMonth()+1)+"-"+pad(d.getDate())+" "+hm;
}
function timelinePreview(text){
  return String(text||"").replace(/^【本机网络环境[\s\S]*?】\s*/,"").replace(/\s+/g," ").trim().slice(0,140) || "(空输入)";
}
function timelineBucket(scope){
  state.timelines=state.timelines||{single:[],compare:[]};
  if(!state.timelines[scope]) state.timelines[scope]=[];
  return state.timelines[scope];
}
function timelineReset(scope="single"){
  timelineBucket(scope).splice(0);
  timelineRender();
}
function timelineHash(text){
  let h=0, s=String(text||"");
  for(let i=0;i<s.length;i++) h=((h<<5)-h+s.charCodeAt(i))|0;
  return Math.abs(h).toString(36);
}
function timelineAppendTime(el, when){
  if(!el || el.querySelector(".msgtime")) return;
  const d=document.createElement("div");
  d.className="msgtime";
  d.textContent=timelineTimeLabel(when);
  d.title=timelineTimeValue(when).toLocaleString();
  const body=el.classList.contains("cmpmsg") ? el : el.querySelector(".body");
  if(body) body.appendChild(d);
}
function timelineRegisterUser(el, text, opts={}){
  if(!el) return null;
  const scope=opts.scope||"single";
  const when=timelineTimeValue(opts.time||opts.item||Date.now());
  const key=opts.key || (scope+":"+timelineHash(text)+":"+Math.floor(when.getTime()/60000));
  el.dataset.tlKey=key;
  el.dataset.tlScope=scope;
  el.dataset.tlTime=when.toISOString();
  timelineAppendTime(el, when);
  const bucket=timelineBucket(scope);
  let rec=bucket.find(x=>x.key===key);
  if(!rec){
    rec={key, scope, text:timelinePreview(text), time:when.toISOString(), els:[], providers:new Set(), meta:opts.meta||""};
    bucket.push(rec);
    bucket.sort((a,b)=>new Date(a.time)-new Date(b.time));
  }
  if(!rec.els.includes(el)) rec.els.push(el);
  if(opts.provider) rec.providers.add(opts.provider);
  if(opts.meta && !rec.meta) rec.meta=opts.meta;
  timelineRender();
  return rec;
}
function timelineCleanText(text){
  return String(text||"").replace(/^【本机网络环境[\s\S]*?】\s*/,"").replace(/\s+/g," ").trim();
}
function timelineTextFromNode(el){
  if(!el) return "";
  const src=el.querySelector(".cmpu-text") || el.querySelector(".content") || el;
  const clone=src.cloneNode(true);
  clone.querySelectorAll&&clone.querySelectorAll(".msgtime,.acts,.mact,.qx").forEach(n=>n.remove());
  return timelineCleanText(clone.textContent||"");
}
function timelineFindSnapshotItem(el, text){
  const items=(state.activeSnapshot&&state.activeSnapshot.items)||[];
  const id=el&&el.dataset&&el.dataset.id;
  let it=id ? items.find(x=>String(x&&x.id||"")===String(id)) : null;
  if(it) return it;
  const clean=timelineCleanText(text);
  return items.find(x=>{
    if((x&&x.kind)!=="user_message") return false;
    return timelineCleanText(x.detail||x.summary||"")===clean;
  }) || null;
}
function timelineFindCompareTime(provider, text){
  const cmp=window.CMP||{};
  const clean=timelineCleanText(text);
  const hist=(cmp.history&&cmp.history[provider]&&cmp.history[provider].items)||[];
  const it=hist.find(x=>{
    const k=x&&x.kind;
    if(k!=="user_message"&&k!=="user") return false;
    return timelineCleanText(x.text!=null?x.text:(x.detail!=null?x.detail:x.summary||""))===clean;
  });
  if(it) return it.started_at||it.created_at||it.updated_at||it.ended_at;
  const brief=cmp.brief&&cmp.brief[provider];
  if(brief && brief.latest && brief.latest.user && timelineCleanText(brief.latest.user.text)===clean){
    return (brief.turn&&brief.turn.created_at) || (brief.thread&&brief.thread.updated_at);
  }
  return "";
}
function timelineCollectVisible(scope=timelineCurrentScope()){
  if(scope==="compare"){
    document.querySelectorAll("#cmpCols .cmpmsg.u").forEach((el,i)=>{
      const text=timelineTextFromNode(el);
      if(!text) return;
      const col=el.closest(".cmpcol");
      const provider=col&&col.dataset&&col.dataset.p;
      const time=el.dataset.tlTime || timelineFindCompareTime(provider,text) || Date.now()+i;
      const key=el.dataset.tlKey || ("compare:"+timelineHash(text)+":"+Math.floor(timelineTimeValue(time).getTime()/60000));
      timelineRegisterUser(el,text,{scope:"compare",key,time,provider});
    });
    return;
  }
  document.querySelectorAll("#mwrap .msg.user").forEach((el,i)=>{
    const text=timelineTextFromNode(el);
    if(!text) return;
    const item=timelineFindSnapshotItem(el,text);
    const time=el.dataset.tlTime || item || Date.now()+i;
    const key=el.dataset.tlKey || (item&&item.id) || ("single:"+timelineHash(text)+":"+i);
    timelineRegisterUser(el,text,{scope:"single",key,time});
  });
}
function timelineCurrentScope(){
  return document.getElementById("cmpView") && !document.getElementById("cmpView").hidden ? "compare" : "single";
}
function timelineRender(){
  const list=$("#timelineList"); if(!list) return;
  const scope=state.timelineScope||timelineCurrentScope();
  const rows=timelineBucket(scope).filter(r=>r.els.some(el=>document.contains(el)));
  const title=document.querySelector("#timelinePanel .tlhead b");
  if(title) title.textContent=scope==="compare"?"多模型输入时间线":"输入时间线";
  const btn=$("#timelinebtn"), cbtn=$("#cmpTimelineBtn");
  if(btn) btn.classList.toggle("on", !$("#timelinePanel")?.hidden && scope==="single");
  if(cbtn) cbtn.classList.toggle("on", !$("#timelinePanel")?.hidden && scope==="compare");
  if(!rows.length){ list.innerHTML='<div class="tlempty">还没有用户输入</div>'; return; }
  list.innerHTML="";
  const short=window.PROV_SHORT||{};
  rows.forEach(r=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="tlitem";
    const meta=[r.meta, r.providers&&r.providers.size ? [...r.providers].map(p=>short[p]||p).join(" / ") : ""].filter(Boolean).join(" · ");
    b.innerHTML=`<span class="tltime">${esc(timelineTimeLabel(r.time))}</span><span class="tltext">${esc(r.text)}</span><span class="tlmeta">${esc(meta || "点击跳转到这次输入")}</span>`;
    b.onclick=()=>timelineJump(r.key, scope);
    list.appendChild(b);
  });
}
function timelineAnchor(scope=timelineCurrentScope()){
  if(scope==="compare") return $("#cmpTimelineBtn") || $("#timelinebtn");
  return $("#timelinebtn") || $("#cmpTimelineBtn");
}
function timelinePlace(scope=timelineCurrentScope()){
  const panel=$("#timelinePanel"), anchor=timelineAnchor(scope);
  if(!panel || !anchor) return;
  const r=anchor.getBoundingClientRect();
  const gap=8, pad=12;
  const w=Math.min(520, window.innerWidth - pad*2);
  panel.style.width=w+"px";
  let left=Math.min(window.innerWidth - w - pad, Math.max(pad, r.right - w));
  let top=r.bottom + gap;
  const h=Math.min(panel.offsetHeight || 360, window.innerHeight - pad*2);
  if(top + h > window.innerHeight - pad) top=Math.max(pad, r.top - h - gap);
  panel.style.left=left+"px";
  panel.style.top=top+"px";
  panel.style.right="auto";
}
function timelineOpen(scope=timelineCurrentScope()){
  state.timelineScope=scope;
  const panel=$("#timelinePanel");
  if(!panel) return;
  panel.hidden=false;
  try{ timelineCollectVisible(scope); }
  catch(e){ console.warn("timeline collect failed", e); }
  try{ timelineRender(); }
  catch(e){
    console.warn("timeline render failed", e);
    const list=$("#timelineList");
    if(list) list.innerHTML='<div class="tlempty">时间线暂时无法渲染,请刷新窗口重试</div>';
  }
  timelinePlace(scope);
}
function timelineClose(){
  const panel=$("#timelinePanel"); if(panel) panel.hidden=true;
  $("#timelinebtn")?.classList.remove("on");
  $("#cmpTimelineBtn")?.classList.remove("on");
}
function timelineToggle(scope=timelineCurrentScope()){
  const panel=$("#timelinePanel");
  if(!panel) return;
  if(!panel.hidden && state.timelineScope===scope) timelineClose();
  else timelineOpen(scope);
}
function timelineJump(key, scope=timelineCurrentScope()){
  const rec=timelineBucket(scope).find(x=>x.key===key);
  if(!rec) return;
  let els=rec.els.filter(el=>document.contains(el));
  if(!els.length) return;
  let target=els.find(el=>el.offsetParent!==null) || els[0];
  const col=target.closest&&target.closest(".cmpcol");
  if(scope==="compare" && col && col.classList.contains("hide") && typeof cmpSwitchTab==="function"){
    cmpSwitchTab(col.dataset.p);
    target=rec.els.find(el=>document.contains(el) && el.offsetParent!==null) || target;
  }
  target.scrollIntoView({block:"center",behavior:"smooth"});
  timelineClose();
  els.forEach(el=>{
    el.classList.add("tlflash");
    setTimeout(()=>el.classList.remove("tlflash"),1600);
  });
}
function initTimelineControls(){
  if(state.timelineControlsReady) return;
  state.timelineControlsReady=true;
  document.addEventListener("click", e=>{
    const b=e.target&&e.target.closest&&e.target.closest("#timelinebtn,#cmpTimelineBtn,#timelineClose");
    const panel=$("#timelinePanel");
    if(!b){
      if(panel && !panel.hidden && e.target && !e.target.closest("#timelinePanel")) timelineClose();
      return;
    }
    e.preventDefault();
    if(b.id==="timelinebtn") timelineToggle("single");
    else if(b.id==="cmpTimelineBtn") timelineToggle("compare");
    else timelineClose();
  });
  window.addEventListener("resize",()=>{ const p=$("#timelinePanel"); if(p && !p.hidden) timelinePlace(state.timelineScope||timelineCurrentScope()); });
}
function cleanTitleSeed(text){
  let s=String(text||"").replace(/\r/g,"\n").trim();
  s=s.replace(/^我上传了以下文件,请先用 read_file 读取再回答[:：]\s*/i,"");
  s=s.split("\n").map(l=>{
    const m=l.match(/^\s*-\s*(?:\/|~\/|[A-Za-z]:\\)\S+\s*(.*)$/);
    return m ? (m[1]||"") : l;
  }).filter(l=>l.trim()).join(" ");
  s=s.replace(/\s+/g," ").trim();
  s=s.replace(/\s*📎.*$/,"").trim();
  const drop=[
    /(?:^|[。.!！?？]\s*)请?使用\s*`?[A-Za-z][A-Za-z0-9 _-]{2,}`?\s*(?:插件|plugin|skill)[^。.!！?？]*/ig,
    /(?:^|[。.!！?？]\s*)需要时自动选择这些\s*skill\s*[:：][^。.!！?？]*/ig,
    /(?:^|[。.!！?？]\s*)(?:除非我明确要求英文或其他语言|最终回复一律用中文|默认用中文|全程用中文)[^。.!！?？]*/ig,
    /(?:^|[。.!！?？]\s*)请根据任务自动判断是否需要(?:调用|加载)[^。.!！?？]*/ig,
    /(?:^|[。.!！?？]\s*)优先调用\/加载\s*`?[^。.!！?？`]+`?\s*(?:skill|插件)?[^。.!！?？]*/ig,
    /(?:^|[。.!！?？]\s*)菜单路径\s*`?[^。.!！?？`]+`?[^。.!！?？]*/ig,
    /[A-Za-z][A-Za-z0-9 _-]{1,80}\s*(?:插件|plugin|skill)[，,、\s]*/ig,
    /(?:先|请先)?(?:读取|加载|调用)并(?:遵循|使用)\s*/ig,
    /`[A-Za-z][A-Za-z0-9_-]{2,}`\s*/ig,
    /(?:先|请先)?(?:读取|加载|调用)\s*`?[^。.!！?？`]{2,80}`?\s*(?:文件|skill|插件)?/ig,
  ];
  drop.forEach(re=>{ s=s.replace(re," "); });
  s=s.replace(/[。!！?？,，;；:：、\s]+/g," ").trim();
  return s;
}
function roughThreadTitle(text, fallback="新对话"){
  let s=cleanTitleSeed(text);
  s=s.replace(/(?:用中文回复|中文回答|说中文|全程用中文给出结果)/ig,"").trim();
  s=s.replace(/^(请|帮我|帮忙|麻烦你?|能不能|能否|可以)\s*/,"").trim();
  const pluginPhrase=s.match(/^(?:请)?(?:使用|调用)?\s*`?([A-Za-z][A-Za-z0-9 _-]{2,}?)`?\s*(?:插件|plugin|skill)(?:[。,.， ]|$)/i);
  if(pluginPhrase){
    const rest=s.slice(pluginPhrase[0].length).trim();
    if(rest) s=rest;
    else {
      const raw=pluginPhrase[1].replace(/\s+/g,"");
      const name=raw.slice(0,1).toUpperCase()+raw.slice(1);
      return (name+"研究").slice(0,18);
    }
  }
  const plugin=s.match(/^(?:使用|调用)?\s*`?([A-Za-z][A-Za-z0-9_-]{2,})`?\s*(?:插件|plugin|skill)?/i);
  if(plugin && s.length<=plugin[0].length+8){
    const name=plugin[1].slice(0,1).toUpperCase()+plugin[1].slice(1);
    return (name+"研究").slice(0,18);
  }
  s=s.replace(/^(?:请)?使用\s*`?[A-Za-z][A-Za-z0-9_-]{2,}`?\s*(?:插件|plugin|skill)?[。,.， ]*/i,"").trim();
  const domain=s.match(/\b(?:https?:\/\/)?(?:www\.)?(?!www\.)([a-z0-9-]+)(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9.-])/i);
  if(domain && /(是什么|查询|介绍|分析|网站|公司|干嘛|做什么|资料|背景)/i.test(s)){
    const name=domain[1].slice(0,1).toUpperCase()+domain[1].slice(1);
    return (name+"网站查询").slice(0,18);
  }
  const stockAction=s.match(/(抄底|买入|卖出|估值|财报|趋势|风险|机会)/);
  if(stockAction){
    let before=s.slice(0, stockAction.index).replace(/.*(?:分析|研究|看|判断)\s*/,"");
    before=before.replace(/(?:(?:是否|能否|能不能|可以|可不可以)\s*)+$/,"").trim();
    const obj=(before.match(/([A-Za-z0-9.]{2,12}|[\u4e00-\u9fa5]{2,8})$/)||[])[1];
    if(obj) return (obj+stockAction[1]+"分析").slice(0,18);
  }
  if(/codex/i.test(s) && /(效率|优化|simplif|efficient|workflow|work more)/i.test(s)) return "优化Codex效率";
  if(/codewhale/i.test(s) && /(gui|界面|ui|前端|窗口)/i.test(s)) return "CodeWhale界面优化";
  if(/多模型|compare/i.test(s) && /(cpu|性能|卡|慢|占用)/i.test(s)) return "多模型性能优化";
  if(/更新|版本|release/i.test(s)) return "版本更新检查";
  if(/^优化一下[，,、\s]*(看看)?/.test(s)) return "优化建议";
  s=s.replace(/^(看看|检查下?|研究下?|分析下?|优化一下|修一下)\s*/,"").trim();
  s=s.replace(/[。.!！?？,，;；:：]+$/,"").trim();
  if(!s) return fallback;
  return s.length>18 ? s.slice(0,18).trim() : s;
}
function normTurnStatus(s){ return String(s||"").toLowerCase().replace(/[\s-]+/g,"_"); }
function isTurnRunning(s){ const x=normTurnStatus(s); return x==="in_progress"||x==="inprogress"||x==="queued"||x==="running"; }
function isTurnDone(s){ return ["completed","failed","interrupted","canceled","cancelled","error"].includes(normTurnStatus(s)); }
function isStoppingTurn(id){ return !!(state.stopTurnId && (!id || id===state.stopTurnId)); }
function statusText(item){ return String((item&&item.detail)||(item&&item.summary)||""); }
function isImportantStatus(item){ return /fail|error|warn|denied|refused|responses api|失败|错误|异常|拒绝|告警|警告/i.test(statusText(item)); }
function activeSummary(id){ return (state.threads||[]).find(t=>t&&t.id===id)||null; }
function turnInfoFromSnapshot(rec, summary){
  const turns=(rec&&rec.turns)||[], thread=(rec&&rec.thread)||{};
  const runningTurn=[...turns].reverse().find(t=>t&&isTurnRunning(t.status));
  const lastTurn=turns[turns.length-1]||{};
  const status=(runningTurn&&runningTurn.status)||thread.latest_turn_status||(summary&&summary.latest_turn_status)||lastTurn.status||"";
  const turnId=(runningTurn&&runningTurn.id)||thread.latest_turn_id||lastTurn.id||"";
  return {status, turnId, running:isTurnRunning(status), done:isTurnDone(status)};
}

/* ---------- running status ---------- */
function runFmt(ms){
  const s=Math.max(0,Math.floor((ms||0)/1000));
  if(s<60) return s+"s";
  const m=Math.floor(s/60), r=s%60;
  return m+"m"+(r?(" "+r+"s"):"");
}
function runStatusReset(remove){
  if(state.runUI&&state.runUI.timer) clearInterval(state.runUI.timer);
  if(remove&&state.runUI&&state.runUI.el) state.runUI.el.remove();
  state.runUI=null;
}
function runStatusEnsure(label="启动中",detail="等待模型响应"){
  let ui=state.runUI;
  if(ui&&ui.el&&document.body.contains(ui.el)){
    return ui;
  }
  document.querySelectorAll("#mwrap .runstatus.done,#mwrap .runstatus.err").forEach(el=>el.remove());   // 完成卡只作临时状态;新一轮开始前清掉,避免夹在两轮消息之间造成顺序错觉
  const el=document.createElement("div");
  el.className="runstatus";
  el.innerHTML=`<div class="runstatus-h"><span class="caret">▸</span><span class="pulse"></span><span class="ttl"></span><span class="sub"></span><span class="elapsed">0s</span></div><div class="runstatus-b"></div>`;
  const head=el.querySelector(".runstatus-h");
  head.onclick=()=>el.classList.toggle("open");
  keyboardButton(head,()=>el.classList.toggle("open"),"展开或折叠运行过程");
  $("#mwrap").appendChild(el);
  ui={el,title:el.querySelector(".ttl"),sub:el.querySelector(".sub"),body:el.querySelector(".runstatus-b"),elapsed:el.querySelector(".elapsed"),started:Date.now(),lastAt:Date.now(),lastLabel:label,lastDetail:detail,lastStep:"",steps:0,timer:null};
  state.runUI=ui;
  ui.timer=setInterval(()=>runStatusTick(),1000);
  runStatusUpdate(label,detail);
  runStatusStep("本轮开始");
  return ui;
}
function runStatusTick(){
  const ui=state.runUI; if(!ui) return;
  const now=Date.now(), idle=now-(ui.lastAt||now);
  ui.elapsed.textContent=runFmt(now-ui.started);
  ui.el.classList.toggle("stalled",idle>90000);
  if(idle>90000){
    ui.title.textContent="核实中";
    ui.sub.textContent=`${runFmt(idle)} 没有新事件,正在向后端核实真实状态…`;
    if(typeof syncActiveTurn==="function") syncActiveTurn();   // 主动对账:已结束→自动关卡并补渲染;仍在跑→刷新为"同步中"并重置计时。不再让用户猜"结束了还是卡住了"
  }
  else if(idle>30000 && state.running){ ui.sub.textContent=`等待响应 ${runFmt(idle)} · ${ui.lastDetail||ui.lastLabel||""}`; }
  else if(idle>8000 && state.running && (!state.lastEventAt || state.lastEventAt<ui.started)){ ui.sub.textContent=`后端启动/上下文同步中(切换模型后的首条消息可能需 10~30 秒)· 已等待 ${runFmt(idle)}`; }   // 本轮尚无任何事件 → 大概率在冷启动 per-provider 后端,给用户明确预期
}
function runStatusUpdate(label,detail,kind){
  const ui=runStatusEnsure(label,detail);
  ui.lastAt=Date.now(); ui.lastLabel=label||ui.lastLabel; ui.lastDetail=detail||ui.lastDetail||"";
  ui.el.classList.remove("done","err","stalled");
  if(kind) ui.el.classList.add(kind);
  ui.title.textContent=label||"处理中";
  ui.sub.textContent=detail||"";
  ui.elapsed.textContent=runFmt(Date.now()-ui.started);
  return ui;
}
function runStatusStep(text,cls){
  const ui=runStatusEnsure();
  const t=String(text||"").replace(/\s+/g," ").trim();
  if(!t||t===ui.lastStep) return;
  ui.lastStep=t; ui.steps++;
  const d=document.createElement("div");
  d.className="runstep"+(cls?(" "+cls):"");
  d.innerHTML=`<span class="tm">${runFmt(Date.now()-ui.started)}</span><span></span>`;
  d.lastChild.textContent=t;
  ui.body.appendChild(d);
  while(ui.body.children.length>80) ui.body.firstChild.remove();
  ui.body.scrollTop=ui.body.scrollHeight;
}
function runLabelForItem(item){
  const kind=item&&item.kind, summary=String((item&&item.summary)||"").replace(/\s+/g," ").slice(0,120);
  if(kind==="agent_reasoning") return ["思考中", summary||"正在整理思路"];
  if(kind==="agent_message") return ["输出中", summary||"正在生成回复"];
  if(kind==="command_execution") return ["执行命令", summary||"正在运行 shell/终端命令"];
  if(kind==="tool_call") return ["调用工具", summary||"正在调用工具"];
  if(kind==="file_change") return ["修改文件", summary||"正在写入或更新文件"];
  if(kind==="error") return ["出错", summary||"运行时出现错误"];
  return ["处理中", summary||kind||"等待下一步"];
}
function runStatusFromItem(item,phase){
  const pair=runLabelForItem(item||{}), label=pair[0], detail=pair[1];
  runStatusUpdate(phase||label,detail);
  if(item&&item.kind&&item.kind!=="agent_message"&&item.kind!=="agent_reasoning") runStatusStep(`${phase||label}: ${detail}`);
}
function runStatusFinish(label,kind){
  const ui=state.runUI; if(!ui) return;
  if(ui.timer) clearInterval(ui.timer);
  ui.title.textContent=label||"已完成";
  runStatusStep(label||"已完成",kind==="err"?"err":"");
  ui.sub.textContent=ui.steps?`过程 ${ui.steps} 步`:"本轮结束";
  ui.elapsed.textContent=runFmt(Date.now()-ui.started);
  ui.el.classList.remove("stalled");
  ui.el.classList.add(kind==="err"?"err":"done");
  if(Date.now()-ui.started>8000){ cwToast(`✅ ${label||"已完成"} · 用时 ${runFmt(Date.now()-ui.started)}`); }
  state.runUI=null;
}

/* ---------- open / stream a thread ---------- */

/* ---------- approvals ---------- */
function pendingApprovalCards(){
  return [...document.querySelectorAll(".tool.needapproval[data-aid]")];
}
function approvalGoneError(e){
  const msg=String(e&&e.message||e||"");
  return /\b404\b|no pending approval|not found|expired|stale|gone/i.test(msg);
}
function markApproval(card,label){
  if(!card) return;
  const a=card.querySelector(".approval");
  if(a) a.innerHTML=`<span class="q">${label}</span>`;
  card.classList.remove("needapproval");
  delete card.dataset.deciding;
}
function approvalRequired(m,p){
  const aid=p.approval_id||p.id||m.approval_id; const tool=p.tool_name||p.tool||p.command||p.summary||"工具调用";
  if(aid){
    const old=pendingApprovalCards().find(c=>c.dataset.aid===aid);
    if(old){ scrollDown(); return; }   // SSE 重连/历史重放时不要重复追加同一个审批卡片
  }
  const card=document.createElement("div"); card.className="tool needapproval approval-card"; card.dataset.aid=aid;
  card.innerHTML=`<div class="th hd"><span class="st"></span><span class="ic">${icon("tool")} 待审批</span><span class="sum">${esc(tool)}</span></div>`+
    (p.detail?`<div class="tb bd">${esc(p.detail)}</div>`:"")+
    `<div class="approval"><span class="q">${esc(p.matched_rule?("规则: "+p.matched_rule):"是否允许执行?")}</span>`+
    `<button class="deny">拒绝</button><button class="allow">允许</button></div>`;
  $("#mwrap").appendChild(card);
  card.querySelector(".allow").onclick=()=>decide(aid,"allow",card);
  card.querySelector(".deny").onclick=()=>decide(aid,"deny",card);
  // 自动批准开启时,前端直接允许(不依赖后端 turn 启动时读取的标志)。延迟 400ms 并检查仍待审批,避免重放历史已决项时误触。
  if(state.autoApprove && aid){ setTimeout(()=>{ if(card.classList.contains("needapproval")) decide(aid,"allow",card,true); }, 400); }
  scrollDown();
}
async function decide(aid,decision,card,silent){
  if(!aid || !card || card.dataset.deciding==="1" || !card.classList.contains("needapproval")) return;
  card.dataset.deciding="1";
  card.querySelectorAll("button").forEach(b=>b.disabled=true);
  try{
    await api(`/v1/approvals/${aid}`,{method:"POST",body:JSON.stringify({decision,remember:false})});
    markApproval(card, decision==="allow"?("✓ 已允许"+(silent?" (自动)":"")):"✕ 已拒绝");
  }catch(e){
    if(approvalGoneError(e)){ markApproval(card,"· 审批已结束"); return; }
    delete card.dataset.deciding;
    card.querySelectorAll("button").forEach(b=>b.disabled=false);
    if(!silent) sysnote("审批失败: "+e.message);
  }
}
function approvalResolved(m,p,ev){
  const aid=p.approval_id||p.id; const card=[...document.querySelectorAll(".tool")].find(c=>c.dataset.aid===aid);
  if(card) markApproval(card, ev==="approval.timeout"?"⏱ 超时":(p.decision==="allow"?"✓ 已允许":"✕ 已拒绝"));
}

/* ---------- ui bits ---------- */
function row(role,who){ const d=document.createElement("div"); d.className="msg "+role;
  const edit = role==="user" ? `<button class="mact edit" title="编辑:调回输入框,改完重发">${icon("edit")}</button>` : "";
  d.innerHTML=`<div class="av">${role==="user"?"你":"🐳"}</div><div class="body"><div class="who">${who}</div><div class="content"></div><div class="acts"><button class="mact copy" title="复制">${icon("copy")}</button>${edit}</div></div>`; return d; }
function sysnote(txt){ const d=document.createElement("div"); d.className="sysnote"; d.textContent=txt; $("#mwrap").appendChild(d); }
function execCopy(t){ return new Promise((res,rej)=>{ try{ const ta=document.createElement("textarea"); ta.value=t; ta.style.cssText="position:fixed;opacity:0;top:0;left:0"; document.body.appendChild(ta); ta.focus(); ta.select(); const ok=document.execCommand("copy"); ta.remove(); ok?res():rej(new Error("execCommand copy failed")); }catch(e){ rej(e); } }); }
function clipCopy(t){ if(navigator.clipboard && window.isSecureContext){ return navigator.clipboard.writeText(t).catch(()=>execCopy(t)); } return execCopy(t); }   // 优先 clipboard API;不存在(手机/LAN 非 HTTPS)或被拒(失焦/权限)都退回 execCommand
function msgText(msg){ const it=state.items.get(msg.dataset.id); return (it&&it.raw) || msg.querySelector(".content")?.innerText || ""; }
function copyMsg(btn,msg){ clipCopy(msgText(msg)).then(()=>{ btn.classList.add("ok"); const o=btn.innerHTML; btn.innerHTML=icon("check"); setTimeout(()=>{btn.innerHTML=o;btn.classList.remove("ok");},1000); }).catch(()=>{}); }
function editMsg(msg){ const inp=$("#input"); inp.value=msgText(msg); inp.dispatchEvent(new Event("input")); inp.focus(); try{inp.setSelectionRange(inp.value.length,inp.value.length);}catch{} }   // 调回输入框,光标到末尾,改完重发
function isImageAttachment(a){ return !!((a?.type||"").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(a?.name||"")); }
function revokeAttachmentPreview(a){ if(a&&a.previewUrl){ try{ URL.revokeObjectURL(a.previewUrl); }catch(e){} a.previewUrl=""; } }
function clearAttachmentList(list){ (list||[]).forEach(revokeAttachmentPreview); if(list) list.length=0; }
function uploadAttachmentRecord(file,d){
  const a={name:d.name||file.name,path:d.path,textPath:d.text_path||d.textPath||"",textName:d.text_name||d.textName||"",textKind:d.text_kind||d.textKind||"",type:file.type||d.type||"",size:d.size||file.size||0,previewUrl:""};
  if(isImageAttachment(a)) a.previewUrl=URL.createObjectURL(file);
  return a;
}
async function optimisticUpload(files, opts={}){
  const list=opts.list, render=typeof opts.render==="function"?opts.render:()=>{}, scope=opts.scope||"inbox", skipNotify=opts.skipNotify||cwToast;
  if(!list) return;
  const queue=[];
  [...(files||[])].forEach(f=>{
    if(!f) return;
    if(f.size>50*1024*1024){ skipNotify("⚠ "+f.name+" 超过 50MB,跳过"); return; }
    const rec={name:f.name,size:f.size||0,type:f.type||"",path:"",textPath:"",textName:"",textKind:"",previewUrl:"",pending:true};
    if(isImageAttachment(rec)) rec.previewUrl=URL.createObjectURL(f);
    list.push(rec); queue.push({file:f, rec}); render();
  });
  for(const it of queue){
    const f=it.file, rec=it.rec;
    try{
      const buf=await f.arrayBuffer();
      const r=await fetch(url("/api/upload"),{method:"POST",headers:{...auth,"X-Filename":encodeURIComponent(f.name),"X-Upload-Scope":scope},body:buf});
      let d={}; try{ d=await r.json(); }catch(e){ if(!r.ok) throw new Error("HTTP "+r.status); throw e; }
      if(!r.ok) throw new Error(d.error||("HTTP "+r.status));
      if(!d.path) throw new Error(d.error||f.name);
      const done=uploadAttachmentRecord(f,d);
      if(rec.previewUrl && done.previewUrl && done.previewUrl!==rec.previewUrl){ revokeAttachmentPreview(done); done.previewUrl=rec.previewUrl; }
      if(!list.includes(rec)){ revokeAttachmentPreview(rec); revokeAttachmentPreview(done); render(); continue; }
      Object.assign(rec, done, {pending:false});
      render();
    }catch(e){
      const idx=list.indexOf(rec);
      if(idx>=0) list.splice(idx,1);
      revokeAttachmentPreview(rec);
      if(idx>=0) cwToast("⚠ 上传失败: "+f.name+"/"+(e&&e.message||e||"未知错误"));
      render();
    }
  }
}
function attachmentReadRef(a){
  if(a&&a.textPath){
    if(a.textKind==="image_vision" || isImageAttachment(a)) return `- ${a.textPath} (视觉模型已识别该图片: 含完整文字转录与界面描述; 原图: ${a.path})`;
    return `- ${a.textPath} (从 PDF 自动提取的可读文本; 原 PDF: ${a.path})`;
  }
  return `- ${a&&a.path||""}`;
}
function attachmentChip(a,onRemove){
  const c=document.createElement("div");
  const pending=a&&a.pending;
  const pendingText=pending?` <span class="pendingtxt">上传中…</span>`:"";
  const title=escAttr((a&&a.path)||((pending&&a&&a.name)||""));
  if(a.previewUrl && isImageAttachment(a)){
    c.className="chip imgchip"+(pending?" pending":"");
    c.innerHTML=`<img src="${escAttr(a.previewUrl)}" alt="${escAttr(a.name)}"><span class="nm" title="${title}">${esc(a.name)}${pendingText}</span><button class="x" title="移除附件">${icon("x")}</button>`;
  }else{
    c.className="chip"+(pending?" pending":"");
    c.innerHTML=`<span class="nm" title="${title}">${icon("paperclip")} ${esc(a.name)}${pendingText}</span><button class="x" title="移除附件">${icon("x")}</button>`;
  }
  c.querySelector(".x").onclick=onRemove;
  return c;
}
function filePathsFromText(text){
  const out=[], seen=new Set();
  const raw=String(text||"");
  const exts="pdf|md|markdown|txt|csv|tsv|json|html?|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|webp|svg|py|jsx?|tsx?|css|xml|ya?ml|toml|sh";
  const re=new RegExp("(?:^|[\\s\"'“”‘’`(（\\[])(((?:~|\\/(?:Users|Volumes|tmp|private\\/tmp|var\\/folders))\\/[^\"'“”‘’`\\n\\r)）\\]]+?\\.(?:"+exts+")))(?=$|[\\s\"'“”‘’`.,，。;；:：)）\\]])","gi");
  let m;
  while((m=re.exec(raw))){
    const p=(m[1]||"").trim();
    if(!p || seen.has(p)) continue;
    seen.add(p); out.push(p);
    if(out.length>=5) break;
  }
  return out;
}
function fileExt(path){
  const m=String(path||"").match(/\.([A-Za-z0-9]+)$/);
  return (m&&m[1]||"").toLowerCase();
}
function fileTypeMeta(path){
  const ext=fileExt(path);
  if(ext==="pdf") return "文档 · PDF";
  if(["md","markdown"].includes(ext)) return "文档 · MD";
  if(["doc","docx"].includes(ext)) return "文档 · Word";
  if(["xls","xlsx","csv","tsv"].includes(ext)) return "表格 · "+ext.toUpperCase();
  if(["ppt","pptx"].includes(ext)) return "演示 · PowerPoint";
  if(["png","jpg","jpeg","gif","webp","svg"].includes(ext)) return "图片 · "+ext.toUpperCase();
  if(["json"].includes(ext)) return "数据 · JSON";
  if(["html","htm"].includes(ext)) return "网页 · HTML";
  if(ext==="zip") return "压缩包 · ZIP";
  return ext ? "文件 · "+ext.toUpperCase() : "文件";
}
function fileBadge(path){
  const ext=fileExt(path);
  if(ext==="pdf") return "PDF";
  if(["md","markdown"].includes(ext)) return "MD";
  if(["doc","docx"].includes(ext)) return "DOC";
  if(["xls","xlsx","csv","tsv"].includes(ext)) return "XLS";
  if(["ppt","pptx"].includes(ext)) return "PPT";
  if(["png","jpg","jpeg","gif","webp","svg"].includes(ext)) return "IMG";
  if(ext==="zip") return "ZIP";
  return ext ? ext.slice(0,3).toUpperCase() : "FILE";
}
function fileCanPreview(path){
  return ["pdf","md","markdown","txt","csv","tsv","json","html","htm","png","jpg","jpeg","gif","webp","svg"].includes(fileExt(path));
}
function fileDownloadHref(path, inline=false){
  return url("/api/file/download?path="+encodeURIComponent(path)+(inline?"&inline=1":""));
}
function fileMenuClose(card){ card?.querySelector(".chat-file-actions")?.removeAttribute("open"); }
async function fileOpenAction(path, payload={}){
  const r=await api("/api/file/open",{method:"POST",body:JSON.stringify(Object.assign({path},payload))});
  if(!r || !r.ok) throw new Error((r&&r.error)||"打开失败");
  return r;
}
async function loadFileOpenApps(card, path){
  const box=card?.querySelector(".chat-file-apps");
  if(!box || box.dataset.loaded==="1" || box.dataset.loading==="1") return;
  box.dataset.loading="1";
  box.innerHTML=`<div class="chat-file-loading">读取打开方式...</div>`;
  try{
    const d=await api("/api/file/apps?path="+encodeURIComponent(path));
    const apps=Array.isArray(d.apps)?d.apps:[];
    if(!apps.length){
      box.innerHTML=`<div class="chat-file-loading">没有找到可用 App</div>`;
      box.dataset.loaded="1";
      return;
    }
    box.innerHTML=apps.map(a=>`<button type="button" class="chat-file-app${a.default?" is-default":""}" data-bundle-id="${escAttr(a.bundle_id||"")}" data-app-path="${escAttr(a.path||"")}" title="${escAttr(a.path||"")}">
      ${icon("monitor")} <span>${esc(a.name||"打开")}${a.default?"（默认）":""}</span>
    </button>`).join("");
    box.dataset.loaded="1";
    box.querySelectorAll(".chat-file-app").forEach(btn=>{
      btn.onclick=async e=>{
        e.preventDefault();
        const name=(btn.textContent||"App").trim().replace(/（默认）$/,"");
        try{
          await fileOpenAction(path,{action:"app",bundle_id:btn.dataset.bundleId||"",app_path:btn.dataset.appPath||""});
          cwToast("已用 "+name+" 打开");
          fileMenuClose(card);
        }catch(err){
          cwToast(err.message||"打开失败");
        }
      };
    });
  }catch(e){
    box.innerHTML=`<div class="chat-file-loading">读取失败: ${esc(e.message||"")}</div>`;
  }finally{
    box.dataset.loading="";
  }
}
function appendFileDownloadCards(container, text){
  if(!container) return;
  const paths=filePathsFromText(text);
  const host=/^(SPAN|A|CODE|B|I|EM|STRONG)$/i.test(container.tagName||"") ? (container.parentElement||container) : container;
  let box=null;
  const ensureBox=()=>{
    if(box) return box;
    box=host.querySelector(":scope > .chat-files");
    if(!box){
      box=document.createElement("div");
      box.className="chat-files";
      host.appendChild(box);
    }
    return box;
  };
  const addCard=p=>{
    box=ensureBox();
    if(box.querySelector(`[data-path="${CSS.escape(p)}"]`)) return;
    const name=(p.split("/").pop()||"download");
    const card=document.createElement("div");
    const ext=fileExt(p);
    card.className="chat-file-card"+(ext?(" ext-"+ext):"");
    card.dataset.path=p;
    const durl=fileDownloadHref(p), purl=fileDownloadHref(p,true), canPrev=fileCanPreview(p);
    card.innerHTML=`<a class="chat-file-hit" href="${escAttr(durl)}" download="${escAttr(name)}" title="下载 ${escAttr(name)}">
      <div class="chat-file-ico"><span>${esc(fileBadge(p))}</span></div>
      <div class="chat-file-main"><div class="chat-file-name" title="${escAttr(p)}">${esc(name)}</div><div class="chat-file-meta">${esc(fileTypeMeta(p))}</div></div>
    </a>
    <details class="chat-file-actions"><summary>打开方式</summary><div class="chat-file-menu">
      ${canPrev?`<button type="button" class="chat-file-preview" data-url="${escAttr(purl)}">${icon("monitor")} <span>CodeWhale 预览</span></button>`:""}
      <button type="button" class="chat-file-open-default">${icon("external")} <span>系统默认打开</span></button>
      <div class="chat-file-apps" data-loaded="0"></div>
      <div class="chat-file-sep"></div>
      <a href="${escAttr(durl)}" download="${escAttr(name)}">${icon("update")} <span>下载到本地</span></a>
      <button type="button" class="chat-file-reveal">${icon("file")} <span>打开所在文件夹</span></button>
      <button type="button" class="chat-file-copy">${icon("copy")} <span>复制路径</span></button>
    </div></details>`;
    box.appendChild(card);
    const inlineHtmlPreview = ["html","htm"].includes(ext) && /volume[_-]?profile/i.test(name);
    if(inlineHtmlPreview){
      const frame=document.createElement("div");
      frame.className="chat-file-inline-preview";
      frame.innerHTML=`<div class="chat-file-inline-title">图表预览 · ${esc(name)}</div><iframe src="${escAttr(purl)}" sandbox="allow-scripts allow-forms allow-popups allow-downloads"></iframe>`;
      box.appendChild(frame);
    }
    const det=card.querySelector(".chat-file-actions");
    if(det) det.addEventListener("toggle",()=>{ if(det.open) loadFileOpenApps(card,p); });
    const pv=card.querySelector(".chat-file-preview");
    if(pv) pv.onclick=e=>{ e.preventDefault(); try{ previewLoad(pv.dataset.url); previewShow(); }catch(x){ window.open(pv.dataset.url,"_blank"); } fileMenuClose(card); };
    const op=card.querySelector(".chat-file-open-default");
    if(op) op.onclick=async e=>{ e.preventDefault(); try{ await fileOpenAction(p,{action:"open"}); cwToast("已交给系统默认 App 打开"); fileMenuClose(card); }catch(err){ cwToast(err.message||"打开失败"); } };
    const rv=card.querySelector(".chat-file-reveal");
    if(rv) rv.onclick=async e=>{ e.preventDefault(); try{ await fileOpenAction(p,{action:"reveal"}); fileMenuClose(card); }catch(err){ cwToast(err.message||"打开所在文件夹失败"); } };
    const cp=card.querySelector(".chat-file-copy");
    if(cp) cp.onclick=e=>{ e.preventDefault(); clipCopy(p).then(()=>cwToast("已复制文件路径")).catch(()=>{}); fileMenuClose(card); };
  };
  paths.forEach(p=>addCard(p));
  // 工作区相对路径(如 reports/xx/报告.md):解析到 thread workspace 并向后端校验存在后再出卡
  const exts="pdf|md|markdown|txt|csv|tsv|json|html?|docx?|xlsx?|pptx?|zip|png|jpe?g|gif|webp|svg";
  const relRe=new RegExp("(?:^|[\\s\"'“”‘’`(（\\[])((?:\\.\\/)?(?:[^\\s\\/\"'“”‘’`\\n\\r)）\\]]+\\/)+[^\\s\\/\"'“”‘’`\\n\\r)）\\]]+?\\.(?:"+exts+"))(?=$|[\\s\"'“”‘’`,，。;；)）\\]])","gi");
  const ws=((typeof activeSummary==="function"&&activeSummary(state.activeId))||{}).workspace||"";
  const rels=[]; let rm; const seenRel=new Set(paths);
  while((rm=relRe.exec(String(text||"")))){
    const p=(rm[1]||"").trim();
    if(!p||p.startsWith("/")||p.startsWith("~")||seenRel.has(p)) continue;
    seenRel.add(p); rels.push(p);
    if(rels.length>=4) break;
  }
  if(rels.length && ws){
    rels.forEach(async rel=>{
      try{
        const r=await api(`/api/file/stat?path=${encodeURIComponent(rel)}&base=${encodeURIComponent(ws)}`);
        if(r&&r.exists&&r.path) addCard(r.path);
      }catch(e){}
    });
  }
}
const pdfPathsFromText=filePathsFromText;
const pdfDownloadHref=fileDownloadHref;
function appendPdfDownloadCards(container, text){ appendFileDownloadCards(container, text); }
function setRunning(r){
  const was=state.running;
  state.running=r;
  const b=$("#sendbtn");
  if(b && (was!==r || b.dataset.running!==String(!!r))){
    b.classList.remove("stop");
    b.innerHTML=icon("send");
    b.title = r ? "任务进行中:回车把消息排队,完成后自动发" : "发送";
    b.dataset.running=String(!!r);
  }
  b.disabled = !$("#input").value.trim() && !state.attachments.length;   // 有字或有附件就能点(发送 / 排队)
  const stop=$("#interruptbtn");
  if(stop && (was!==r || stop.dataset.running!==String(!!r))){
    stop.style.display=r?"inline-flex":"none";   // 停止改由顶栏「停止」按钮
    stop.dataset.running=String(!!r);
  }
}
function refreshActiveMeta(){ loadThreads(); }


export { cwToast, cwConfirm, esc, escAttr, ICONS, icon, iconLabel, setButtonIcon, hydrateIcons, keyboardButton, relTime, timelineTimeValue, timelineTimeLabel, timelinePreview, timelineReset, timelineHash, timelineRegisterUser, timelineRender, timelineOpen, timelineClose, timelineToggle, timelineJump, initTimelineControls, roughThreadTitle, normTurnStatus, isTurnRunning, isTurnDone, isStoppingTurn, statusText, isImportantStatus, activeSummary, turnInfoFromSnapshot, runFmt, runStatusReset, runStatusEnsure, runStatusTick, runStatusUpdate, runStatusStep, runLabelForItem, runStatusFromItem, runStatusFinish, pendingApprovalCards, approvalGoneError, markApproval, approvalRequired, decide, approvalResolved, row, sysnote, execCopy, clipCopy, msgText, copyMsg, editMsg, isImageAttachment, revokeAttachmentPreview, clearAttachmentList, uploadAttachmentRecord, optimisticUpload, attachmentReadRef, attachmentChip, filePathsFromText, fileDownloadHref, appendFileDownloadCards, pdfPathsFromText, pdfDownloadHref, appendPdfDownloadCards, setRunning, refreshActiveMeta };
