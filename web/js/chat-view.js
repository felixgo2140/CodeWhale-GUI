const SNAPSHOT_VISIBLE_ITEMS = 80;
const SNAPSHOT_PAGE_ITEMS = 80;
const SNAPSHOT_LAZY_AGENT_CHARS = 14000;
const SNAPSHOT_LAZY_DETAIL_CHARS = 9000;
const SNAPSHOT_RENDER_CHUNK = 12;
const STREAM_MD_DEFER_CHARS = 6000;

let activeAssistantMessage=null;
let selectionMenu=null;
let selectionActionsInstalled=false;

function select(sel){
  if(!sel) return null;
  if(typeof $==="function") return $(sel);
  return document.querySelector(sel);
}

function detectOptions(text){
  if(!text) return null;
  const lines=String(text).replace(/\r/g,"").split("\n");
  const nonEmpty=lines.map(l=>l.trim()).filter(Boolean);
  if(nonEmpty.length<2) return null;
  const cueRe=/(哪一?步|哪个|哪些|选哪|要不要|你希望我|你想要?我|请?告诉我你的选择|你的选择|如何选择|怎么选|选一个|需要我[^。\n]{0,20}(执行|做|帮|试|跑|开始)|你想[^。\n]{0,20}(做|选|执行|先)|想先(做|选|跑)|要我[^。\n]{0,10}(做|执行|跑|试)哪|which\b|choose|pick one|which (one|step)|shall i|execute which|let me know)/i;
  const tail=nonEmpty.slice(-5).join("\n");
  const last=nonEmpty[nonEmpty.length-1];
  if(!(cueRe.test(tail) || /[?？]\s*$/.test(last))) return null;
  const labeled=/^\s*(?:[•·▪◦*+\-]\s+)?(?:([0-9]{1,2}|[A-Za-z])\s*[.、)]\s+)(.+?)\s*$/;
  const bullet =/^\s*[•·▪◦*+\-]\s+(.+?)\s*$/;
  let run=[], best=[];
  for(const l of lines){
    let m=l.match(labeled);
    if(m){ run.push({n:m[1], label:m[2]}); continue; }
    m=l.match(bullet);
    if(m){ run.push({n:"", label:m[1]}); continue; }
    if(l.trim()==="") continue;
    if(run.length) best=run; run=[];
  }
  if(run.length) best=run;
  if(best.length<2) return null;
  best.forEach((it,i)=>{ if(!it.n) it.n=String(i+1); it.label=it.label.replace(/`([^`]+)`/g,"$1").replace(/\*\*([^*]+)\*\*/g,"$1").replace(/^[\*_ ]+|[\*_ ]+$/g,"").trim(); });
  return best;
}

function optionTextFromSelection(sel, otherInp){
  const parts=[...sel].map(it=>it.label); const ot=otherInp.value.trim(); if(ot) parts.push(ot);
  if(!parts.length) return "";
  return parts.length>1 ? ("请帮我执行:\n"+parts.map(p=>"- "+p).join("\n")) : ("请帮我:"+parts[0]);
}

function fillOptionInput(inputSel, txt){
  const inp=select(inputSel); if(!inp || !txt) return false;
  inp.value = inp.value.trim() ? (inp.value.replace(/\s+$/,"")+"\n"+txt) : txt;
  inp.dispatchEvent(new Event("input")); inp.focus();
  try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){}
  return true;
}

function optionTargets(container, fallbackSel){
  const col=container?.closest?.(".cmpcol");
  if(col&&col.dataset.p){
    const prov=col.dataset.p, nm=PROV_SHORT[prov]||prov;
    const primary="#cmpin-"+CSS.escape(prov);
    return {
      primarySel: select(primary) ? primary : (fallbackSel||"#cmpInput"),
      primaryLabel: "填入本栏",
      hint: "默认填到 "+nm+" 的追问框;需要所有模型继续时点「填入全体」",
      secondarySel: select("#cmpInput") ? "#cmpInput" : "",
      secondaryLabel: "填入全体"
    };
  }
  return {primarySel:fallbackSel||"", primaryLabel:"填入输入框", hint:"可多选,选好点填入(再编辑/发送)"};
}

function buildOptPicker(items, inputSel, container){
  const sel=new Set();
  const wrap=document.createElement("div"); wrap.className="optpicker";
  const chips=document.createElement("div"); chips.className="optchips";
  const targets=optionTargets(container, inputSel);
  const mkRow=(cls, mark, labelHtml)=>{
    const r=document.createElement("div"); r.className="optrow"+(cls?" "+cls:"");
    r.innerHTML=`<span class="optmark"><span class="optnum">${esc(mark)}</span></span><span class="optlabel">${labelHtml}</span>`;
    return r;
  };
  const otherInp=document.createElement("input"); otherInp.type="text"; otherInp.className="optother"; otherInp.placeholder="自定义补充…"; otherInp.style.display="none";
  const fill=document.createElement("button"); fill.className="optfill"; fill.textContent=targets.primaryLabel||"填入输入框"; fill.disabled=true;
  const fillBtns=[fill];
  const updateFill=()=>{ const dis=!(sel.size>0 || otherInp.value.trim()); fillBtns.forEach(b=>b.disabled=dis); };
  items.forEach((it,idx)=>{
    const r=mkRow("", String(it.n||idx+1), esc(it.label)); r.title=it.label;
    r.onclick=()=>{ if(sel.has(it)){sel.delete(it);r.classList.remove("on");} else {sel.add(it);r.classList.add("on");} updateFill(); };
    chips.appendChild(r);
  });
  const other=mkRow("other","＋","其他…");
  other.onclick=()=>{ const show=otherInp.style.display==="none"; otherInp.style.display=show?"":"none"; other.classList.toggle("open",show); if(show) otherInp.focus(); updateFill(); };
  otherInp.addEventListener("input",updateFill);
  chips.appendChild(other); wrap.appendChild(chips); wrap.appendChild(otherInp);
  const foot=document.createElement("div"); foot.className="optfoot";
  fill.onclick=()=>{ fillOptionInput(targets.primarySel, optionTextFromSelection(sel, otherInp)); };
  foot.appendChild(fill);
  if(targets.secondarySel && targets.secondarySel!==targets.primarySel){
    const fillAll=document.createElement("button"); fillAll.className="optfill secondary"; fillAll.textContent=targets.secondaryLabel||"填入全体"; fillAll.disabled=true;
    fillAll.onclick=()=>{ fillOptionInput(targets.secondarySel, optionTextFromSelection(sel, otherInp)); };
    fillBtns.push(fillAll); foot.appendChild(fillAll);
  }
  const hint=document.createElement("span"); hint.className="opthint"; hint.textContent=targets.hint||"可多选,选好点填入(再编辑/发送)";
  foot.appendChild(hint); wrap.appendChild(foot);
  return wrap;
}

function augmentOptions(container, text, inputSel){
  try{
    if(!container) return;
    [...container.querySelectorAll(":scope > .optpicker")].forEach(n=>n.remove());
    const items=detectOptions(text); if(!items) return;
    container.appendChild(buildOptPicker(items, inputSel||"", container));
  }catch(e){}
}

function preferLongerText(streamed, finalText){
  const s=streamed||"", f=finalText||"";
  if(!s) return f;
  if(!f) return s;
  return s.length>f.length ? s : f;
}

function userActIcon(name){
  const paths={
    reedit:'<path d="m9 10-4 4 4 4"></path><path d="M20 4v7a3 3 0 0 1-3 3H5"></path>',
    fork:'<circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><circle cx="12" cy="18" r="3"></circle><path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9"></path><path d="M12 12v3"></path>'
  };
  if(name==="copy" && typeof icon==="function") return icon("copy");
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[name]||""}</svg>`;
}

function validDate(v){
  const d=v instanceof Date ? v : (v ? new Date(v) : new Date());
  return Number.isFinite(d.getTime()) ? d : new Date();
}

function relTimeZh(v){
  const d=validDate(v), sec=Math.max(0,(Date.now()-d.getTime())/1000);
  if(sec<60) return "刚刚";
  if(sec<3600) return Math.floor(sec/60)+"分钟前";
  if(sec<86400) return Math.floor(sec/3600)+"小时前";
  return Math.floor(sec/86400)+"天前";
}

function execCopyText(text){
  return new Promise((res,rej)=>{
    try{
      const ta=document.createElement("textarea");
      ta.value=String(text||"");
      ta.style.cssText="position:fixed;opacity:0;top:0;left:0";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok=document.execCommand("copy");
      ta.remove();
      ok ? res() : rej(new Error("execCommand copy failed"));
    }catch(e){ rej(e); }
  });
}

function copyText(text){
  if(navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(String(text||"")).catch(()=>execCopyText(text));
  return execCopyText(text);
}

function assistantMessageText(msg){
  try{ return String(typeof msg?._cwRawMessage==="function" ? msg._cwRawMessage() : (msg?.querySelector(".content")?.innerText||"")); }
  catch(e){ return String(msg?.querySelector(".content")?.innerText||""); }
}

function pulseCopyButton(btn){
  if(!btn) return;
  btn.classList.add("ok");
  const old=btn.innerHTML;
  btn.innerHTML=typeof icon==="function"?icon("check"):"✓";
  setTimeout(()=>{ if(btn.isConnected){ btn.innerHTML=old; btn.classList.remove("ok"); } },900);
}

function appendSelectionContext(msg,text){
  const target=msg?._cwInputSel||"#input";
  const inp=select(target)||select("#input");
  if(!inp) throw new Error("找不到对应输入框");
  const quote=String(text||"").trim().split("\n").map(line=>"> "+line).join("\n");
  const block=`引用回复片段：\n${quote}`;
  inp.value=inp.value.trim()?`${inp.value.replace(/\s+$/,"")}\n\n${block}`:block;
  inp.dispatchEvent(new Event("input"));
  inp.focus();
  try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){}
}

function closeSelectionMenu(){
  if(selectionMenu){ selectionMenu.remove(); selectionMenu=null; }
}

function showSelectionMenu(event,msg,selected){
  closeSelectionMenu();
  const menu=document.createElement("div");
  menu.className="message-selection-menu";
  const action=(name,label,shortcut="")=>{
    const button=document.createElement("button");
    button.type="button";
    button.dataset.messageAction=name;
    const text=document.createElement("span"); text.textContent=label; button.appendChild(text);
    if(shortcut){ const key=document.createElement("kbd"); key.textContent=shortcut; button.appendChild(key); }
    return button;
  };
  menu.append(action("copy-selection","复制"));
  menu.append(action("copy-message","复制整条回复","⌘⇧C"));
  const sep=document.createElement("div"); sep.className="message-selection-sep"; menu.append(sep);
  menu.append(action("attach-context","将所选内容附加为上下文"));
  menu.addEventListener("click",async e=>{
    const button=e.target.closest("[data-message-action]"); if(!button) return;
    e.preventDefault(); e.stopPropagation();
    try{
      if(button.dataset.messageAction==="copy-selection") await copyText(selected);
      else if(button.dataset.messageAction==="copy-message") await copyText(assistantMessageText(msg));
      else if(button.dataset.messageAction==="attach-context"){ appendSelectionContext(msg,selected); cwToast("已附加到输入框"); closeSelectionMenu(); return; }
      cwToast("已复制");
    }catch(err){ cwToast(err?.message||"操作失败"); }
    closeSelectionMenu();
  });
  document.body.appendChild(menu);
  const rect=menu.getBoundingClientRect();
  const left=Math.max(8,Math.min(event.clientX,window.innerWidth-rect.width-8));
  const top=Math.max(8,Math.min(event.clientY,window.innerHeight-rect.height-8));
  menu.style.left=left+"px"; menu.style.top=top+"px";
  selectionMenu=menu;
}

function installSelectionActions(){
  if(selectionActionsInstalled) return;
  selectionActionsInstalled=true;
  document.addEventListener("contextmenu",event=>{
    const content=event.target.closest?.(".msg.assistant .content");
    const msg=content?.closest?.(".msg.assistant");
    const selection=window.getSelection?.();
    if(!content||!msg||!selection||selection.isCollapsed||!selection.rangeCount) return;
    const range=selection.getRangeAt(0);
    if(!content.contains(range.commonAncestorContainer)) return;
    const selected=selection.toString().trim(); if(!selected) return;
    event.preventDefault();
    activeAssistantMessage=msg;
    showSelectionMenu(event,msg,selected);
  });
  document.addEventListener("pointerdown",event=>{ if(selectionMenu&&!selectionMenu.contains(event.target)) closeSelectionMenu(); },true);
  document.addEventListener("keydown",async event=>{
    if(event.key==="Escape") closeSelectionMenu();
    if(!(event.metaKey||event.ctrlKey)||!event.shiftKey||event.altKey||event.key.toLowerCase()!=="c") return;
    if(event.target.closest?.("input,textarea,[contenteditable=true]")) return;
    const msg=activeAssistantMessage?.isConnected ? activeAssistantMessage : [...document.querySelectorAll(".msg.assistant")].reverse().find(el=>el.offsetParent!==null);
    if(!msg) return;
    event.preventDefault();
    try{ await copyText(assistantMessageText(msg)); pulseCopyButton(msg.querySelector(".mact.copy")); cwToast("已复制整条回复"); }
    catch(err){ cwToast(err?.message||"复制失败"); }
  });
  addEventListener("scroll",closeSelectionMenu,true);
  addEventListener("resize",closeSelectionMenu);
}

function createChatView(opts={}){
  const bag=opts.bag||{};
  const getWrap=typeof opts.getWrap==="function" ? opts.getWrap : (()=>null);
  const getScrollHost=typeof opts.getScrollHost==="function" ? opts.getScrollHost : (()=>null);
  const inputSel=opts.inputSel||"";
  const hooks=opts.hooks||{};
  let stick=true, mdObserver=null;
  let deferredMd=new WeakMap();
  installSelectionActions();

  function initBag(){
    if(!bag.items || typeof bag.items.get!=="function") bag.items=new Map();
    if(!bag.seen || typeof bag.seen.has!=="function") bag.seen=new Set();
    if(!bag.eventSeen || typeof bag.eventSeen.has!=="function") bag.eventSeen=new Set();
    if(!bag.finishedTurnIds || typeof bag.finishedTurnIds.has!=="function") bag.finishedTurnIds=new Set();
    if(!Array.isArray(bag.pendingEvents)) bag.pendingEvents=[];
    if(!Array.isArray(bag._turnMsgs)) bag._turnMsgs=[];
  }

  function reset(){
    initBag();
    bag.items.clear();
    bag.seen.clear();
    bag.eventSeen=new Set();
    bag.finishedTurnIds=new Set();
    bag.pendingEvents=[];
    bag.renderingSnapshot=false;
    bag.replayingSnapshotEvents=false;
    bag.snapshotRenderToken=null;
    bag.activeSnapshot=null;
    bag.snapshotFull=false;
    bag.lastEventAt=0;
    bag.turnId=null;
    bag._optimUser=null;
    bag._turnMsgs=[];
    bag._procGroup=null;
    stick=true;
    deferredMd=new WeakMap();
    try{ if(mdObserver) mdObserver.disconnect(); }catch(e){}
    mdObserver=null;
  }

  function stableEventKey(ev, m, p){
    if(ev==="item.delta") return "";
    const tid=m.turn_id||p.turn_id||(p.turn&&p.turn.id)||"";
    const iid=m.item_id||(p.item&&p.item.id)||p.item_id||"";
    const aid=p.approval_id||p.id||m.approval_id||"";
    const status=p.status||p.decision||"";
    if(tid || iid || aid) return [m.thread_id||bag.activeId||"", ev, tid, iid, aid, status].join("|");
    return "";
  }

  function seenStableEvent(ev, m, p){
    initBag();
    const key=stableEventKey(ev, m, p||{});
    if(!key) return false;
    if(bag.eventSeen.has(key)) return true;
    bag.eventSeen.add(key);
    if(bag.eventSeen.size>6000){
      let drop=1000;
      for(const old of bag.eventSeen){ bag.eventSeen.delete(old); if(--drop<=0) break; }
    }
    return false;
  }

  function eventTurnId(m, p={}){
    return m.turn_id || p.turn_id || (p.turn&&p.turn.id) || bag.turnId || "";
  }

  function markTurnFinished(id){
    initBag();
    if(!id) return;
    bag.finishedTurnIds.add(id);
    if(bag.finishedTurnIds.size>200){
      let drop=50;
      for(const old of bag.finishedTurnIds){ bag.finishedTurnIds.delete(old); if(--drop<=0) break; }
    }
  }

  function isFinishedTurn(id){
    initBag();
    return !!(id && bag.finishedTurnIds && bag.finishedTurnIds.has(id));
  }

  function isStoppingTurn(id){
    return !!(bag.stopTurnId && (!id || id===bag.stopTurnId));
  }

  function allowStatus(m, p={}){
    if(typeof hooks.allowRunStatusEvent!=="function") return true;
    return hooks.allowRunStatusEvent(m,p)!==false;
  }

  function emitStatus(type, m, p={}, extra={}){
    if(typeof hooks.onStatusEvent==="function") hooks.onStatusEvent(Object.assign({type,m},extra), p);
  }

  function emitAllowedStatus(type, m, p={}, extra={}){
    if(allowStatus(m,p)) emitStatus(type,m,p,extra);
  }

  function scrollDown(force){
    const host=getScrollHost();
    if(force) stick=true;
    if(stick && host) host.scrollTop=host.scrollHeight;
  }

  function updateStickFromScroll(lastTop){
    const host=getScrollHost();
    if(!host) return {stick, top:lastTop||0};
    if(host.scrollTop < (lastTop||0)-2) stick=false;
    else if(host.scrollHeight-host.scrollTop-host.clientHeight < 12) stick=true;
    return {stick, top:host.scrollTop};
  }

  function isStuck(){ return stick; }
  function setStick(v){ stick=!!v; }

  function renderLazyMarkdown(content, final, container){
    const raw=String(final||"");
    content.innerHTML=`<div class="lazytext">${esc(raw.slice(0,12000))}${raw.length>12000?"\n\n…":""}</div><div class="lazy-md">长回复已用纯文本预览以降低打开时 CPU。<button type="button">完整 Markdown</button></div>`;
    appendPdfDownloadCards(content, raw);
    const btn=content.querySelector(".lazy-md button");
    if(btn) btn.onclick=()=>{
      content.innerHTML=md(raw);
      augmentOptions(container||content.parentElement, raw, inputSel);
      appendPdfDownloadCards(content, raw);
    };
  }

  function renderLazyPlain(content, final, label="长输出"){
    const raw=String(final||"");
    content.innerHTML=`<div class="lazytext">${esc(raw.slice(0,4000))}${raw.length>4000?"\n\n…":""}</div><div class="lazy-md">${esc(label)}已折叠。<button type="button">显示完整内容</button></div>`;
    appendPdfDownloadCards(content, raw);
    const btn=content.querySelector(".lazy-md button");
    if(btn) btn.onclick=()=>{ content.textContent=raw; appendPdfDownloadCards(content, raw); };
  }

  function schedulePlainStreamUpdate(it){
    if(!it||!it.content) return;
    if(it._raf) return;
    it._raf=requestAnimationFrame(()=>{
      it._raf=0;
      if(it.content) it.content.textContent=it.raw||"";
      scrollDown();
    });
  }

  function cancelPlainStreamUpdate(it){
    if(it&&it._raf){
      cancelAnimationFrame(it._raf);
      it._raf=0;
    }
  }

  function idleTask(fn, timeout=700){
    if("requestIdleCallback" in window) return requestIdleCallback(fn,{timeout});
    return setTimeout(fn,16);
  }

  function ensureMdObserver(){
    if(mdObserver) return mdObserver;
    if(!("IntersectionObserver" in window)) return null;
    mdObserver=new IntersectionObserver(entries=>{
      for(const ent of entries){
        if(ent.isIntersecting || ent.intersectionRatio>0) forceDeferredMarkdown(ent.target);
      }
    },{root:getScrollHost()||null,rootMargin:"900px 0px",threshold:0.01});
    return mdObserver;
  }

  function markdownNow(content, raw, container, pickerSel=inputSel, withOptions=true){
    deferredMd.delete(content);
    try{ mdObserver&&mdObserver.unobserve(content); }catch(e){}
    content.innerHTML=md(raw);
    content.classList.remove("md-deferred");
    if(withOptions) augmentOptions(container||content.parentElement, raw, pickerSel);
    appendPdfDownloadCards(content, raw);
  }

  function forceDeferredMarkdown(content){
    const rec=deferredMd.get(content);
    if(!rec) return;
    deferredMd.delete(content);
    try{ mdObserver&&mdObserver.unobserve(content); }catch(e){}
    idleTask(()=>{ if(document.contains(content)) markdownNow(content, rec.raw, rec.container, rec.inputSel, rec.withOptions); });
  }

  function renderDeferredMarkdown(content, raw, container, pickerSel=inputSel, withOptions=true){
    raw=String(raw||"");
    content.classList.add("md-deferred");
    content.textContent=raw;
    if(!raw.trim()) return;
    deferredMd.set(content,{raw,container,inputSel:pickerSel,withOptions});
    const obs=ensureMdObserver();
    if(obs) obs.observe(content);
    else idleTask(()=>forceDeferredMarkdown(content));
  }

  function renderMaybeMarkdown(content, raw, container, defer=false, pickerSel=inputSel, withOptions=true){
    if(defer) renderDeferredMarkdown(content, raw, container, pickerSel, withOptions);
    else markdownNow(content, raw, container, pickerSel, withOptions);
  }

  function snapshotTurnForItem(item, id){
    const turns=(bag.activeSnapshot&&bag.activeSnapshot.turns)||[];
    const tid=item?.turn_id||item?.turnId||"";
    if(tid){
      const turn=turns.find(t=>String(t&&t.id||"")===String(tid));
      if(turn) return turn;
    }
    if(!id) return null;
    return turns.find(t=>(t&&Array.isArray(t.item_ids)&&t.item_ids.map(String).includes(String(id))))||null;
  }

  function userMessageTime(item, id, fallback){
    const own=item&&(item.created_at||item.started_at||item.updated_at||item.ended_at||item.time||item.ts);
    const turn=snapshotTurnForItem(item,id);
    const tv=turn&&(turn.created_at||turn.started_at||turn.updated_at||turn.ended_at);
    return validDate(own||tv||fallback||Date.now());
  }

  function userMessageThreadId(item, el){
    return String((item&&item.thread_id) || (el&&el.dataset&&el.dataset.threadId) || (bag.activeSnapshot&&bag.activeSnapshot.thread&&bag.activeSnapshot.thread.id) || bag.activeId || "");
  }

  function userMessageText(id, el){
    const it=id ? bag.items.get(id) : null;
    return (it&&it.raw) || el?.querySelector?.(".content")?.textContent || "";
  }

  function setUserActionTime(el, when){
    const t=el?.querySelector?.(".msgtime");
    if(!t) return;
    const d=validDate(when);
    t.textContent=relTimeZh(d);
    t.title=d.toLocaleString();
  }

  function fillComposer(text){
    const inp=select(inputSel||"#input")||select("#input");
    if(!inp) return;
    inp.value=String(text||"");
    inp.dispatchEvent(new Event("input"));
    inp.focus();
    try{ inp.setSelectionRange(inp.value.length,inp.value.length); }catch(e){}
  }

  function ensureUserActions(el, id, item, when){
    const body=el?.querySelector?.(".body"); if(!body) return;
    let acts=el.querySelector(":scope > .acts")||body.querySelector(".acts");
    if(!acts){ acts=document.createElement("div"); acts.className="acts"; el.appendChild(acts); }
    else if(acts.parentElement!==el){ el.appendChild(acts); }
    if(!acts.dataset.userActions){
      acts.dataset.userActions="1";
      acts.innerHTML=`<button class="mact copy" data-uact="copy" title="复制" aria-label="复制">${userActIcon("copy")}</button><button class="mact reedit" data-uact="reedit" title="填回输入框重新编辑" aria-label="重新编辑">${userActIcon("reedit")}</button><button class="mact fork" data-uact="fork" title="分叉到新会话" aria-label="分叉">${userActIcon("fork")}</button><span class="msgtime"></span>`;
      let forking=false;
      acts.addEventListener("click",async e=>{
        const b=e.target.closest("[data-uact]"); if(!b) return;
        e.preventDefault(); e.stopPropagation();
        const action=b.dataset.uact, raw=userMessageText(id,el);
        if(action==="copy"){
          try{ await copyText(raw); cwToast("已复制"); }catch(err){ cwToast(err.message||"复制失败"); }
        }else if(action==="reedit"){
          fillComposer(raw);
        }else if(action==="fork"){
          if(forking) return;
          const threadId=userMessageThreadId(item,el);
          if(!threadId){ cwToast("找不到当前会话"); return; }
          forking=true; b.disabled=true;
          try{
            const t=await api(`/v1/threads/${threadId}/fork`,{method:"POST",body:"{}"});
            const newId=(t&&t.id)||(t&&t.thread&&t.thread.id);
            if(!newId) throw new Error("分叉成功但没有返回新会话 id");
            if(typeof _addOptimisticThread==="function") _addOptimisticThread(newId,(t&&t.title)||"分叉会话");
            if(typeof loadThreads==="function") await loadThreads();
            if(typeof openThread==="function") await openThread(newId);
            if(typeof loadThreads==="function") loadThreads();
            cwToast("已分叉到新会话");
          }catch(err){ cwToast(err.message||"分叉失败"); }
          finally{ forking=false; b.disabled=false; }
        }
      });
    }
    el.dataset.threadId=userMessageThreadId(item,el);
    setUserActionTime(el, when);
  }

  function ensureAssistantActions(el,id){
    if(!el) return;
    el._cwInputSel=inputSel||"#input";
    el._cwRawMessage=()=>{
      const item=bag.items&&bag.items.get(id);
      return (item&&item.raw)||el.querySelector(".content")?.innerText||"";
    };
    const button=el.querySelector(".mact.copy");
    if(button){ button.title="复制整条回复 (⌘⇧C)"; button.setAttribute("aria-label","复制整条回复"); }
    if(el.dataset.assistantActions) return;
    el.dataset.assistantActions="1";
    el.addEventListener("pointerenter",()=>{ activeAssistantMessage=el; });
    el.addEventListener("focusin",()=>{ activeAssistantMessage=el; });
    el.querySelector(".acts")?.addEventListener("click",async event=>{
      const copy=event.target.closest(".mact.copy"); if(!copy) return;
      event.preventDefault(); event.stopPropagation();
      try{ await copyText(assistantMessageText(el)); pulseCopyButton(copy); cwToast("已复制整条回复"); }
      catch(err){ cwToast(err?.message||"复制失败"); }
    });
  }

  async function renderThreadSnapshot(rec, preserveQueue=false, opts={}){
    initBag();
    const wrap=getWrap(), queued=preserveQueue?(bag.queue||[]).map(q=>q.el).filter(Boolean):[];
    if(!wrap) return;
    const msgPane=getScrollHost();
    const oldHeight=opts.preserveScroll&&msgPane ? msgPane.scrollHeight : 0;
    const oldTop=opts.preserveScroll&&msgPane ? msgPane.scrollTop : 0;
    const snapshotId=(rec&&rec.thread&&rec.thread.id)||bag.activeId;
    const token=Symbol("snapshot");
    bag.snapshotRenderToken=token;
    bag.activeSnapshot=rec; bag.renderingSnapshot=true; bag.snapshotFull=false;
    if(typeof hooks.onSnapshotStart==="function") hooks.onSnapshotStart(rec, opts);
    bag.items.clear(); bag._optimUser=null; bag._turnMsgs=[]; bag._procGroup=null; wrap.innerHTML="";
    bag.latestSeq=Math.max(bag.latestSeq||0, rec.latest_seq||0);
    for(const t of (rec.turns||[])){ if(t&&t.id&&isTurnDone(t.status)) bag.finishedTurnIds.add(t.id); }
    const items=(rec.items||[]).filter(it=>!(it.kind==="status" && !isImportantStatus(it)));
    const total=Number.isFinite(rec.total_items) ? rec.total_items : items.length;
    const windowed=!!rec.windowed;
    const absoluteStart=windowed ? Math.max(0, +(rec.window_start||0)) : (Number.isFinite(opts.start) ? Math.max(0, Math.min(items.length, opts.start)) : Math.max(0,items.length-SNAPSHOT_VISIBLE_ITEMS));
    const localStart=windowed ? 0 : absoluteStart;
    bag.snapshotPageStart=absoluteStart;
    if(absoluteStart>0){
      const note=document.createElement("div");
      note.className="sysnote histnote";
      const older=Math.min(SNAPSHOT_PAGE_ITEMS,absoluteStart);
      note.innerHTML=`已显示 ${total-absoluteStart} / ${total} 条历史步骤。<button type="button">加载更早 ${older} 条</button>`;
      note.querySelector("button").onclick=async()=>{
        const nextStart=Math.max(0,absoluteStart-SNAPSHOT_PAGE_ITEMS);
        const nextLimit=windowed ? Math.min(total-nextStart, (items.length||SNAPSHOT_VISIBLE_ITEMS)+older) : undefined;
        const fetcher=opts.fetchThreadWindow || hooks.fetchThreadWindow;
        const cachePut=opts.threadCachePut || hooks.threadCachePut;
        const renderAgain=opts.renderSnapshot || ((next,preserve,nextOpts)=>renderThreadSnapshot(next,preserve,Object.assign({},opts,nextOpts)));
        try{
          const next=windowed && typeof fetcher==="function" ? await fetcher((rec.thread&&rec.thread.id)||bag.activeId,{start:nextStart,limit:nextLimit}) : rec;
          if(windowed && typeof cachePut==="function") cachePut((next.thread&&next.thread.id)||bag.activeId,next);
          await renderAgain(next,preserveQueue,{start:nextStart,preserveScroll:true});
        }catch(e){ cwToast("加载更早失败: "+(e.message||e)); }
      };
      wrap.appendChild(note);
    }
    try{
      const visible=items.slice(localStart);
      for(let i=0;i<visible.length;i++){
        if(bag.snapshotRenderToken!==token) return;
        const it=visible[i];
        if(it.kind==="status" && !isImportantStatus(it)) continue;
        startItem(it.id, it);
        completeItem(it.id, it, /fail|error|interrupt|cancel/i.test(it.status||""));
        if(i && i%SNAPSHOT_RENDER_CHUNK===0){
          await new Promise(r=>{ const t=setTimeout(r,50); requestAnimationFrame(()=>{ clearTimeout(t); r(); }); });
        }
      }
      if(bag.snapshotRenderToken!==token) return;
      if(typeof hooks.onSnapshotRendered==="function") hooks.onSnapshotRendered(rec, opts);
      queued.forEach(el=>wrap.appendChild(el));
      if(opts.preserveScroll && msgPane) msgPane.scrollTop=msgPane.scrollHeight-oldHeight+oldTop;
      else scrollDown(true);
    }finally{
      if(bag.snapshotRenderToken===token){
        bag.renderingSnapshot=false; bag.snapshotFull=false;
        replayPendingSnapshotEvents(snapshotId);
      }
    }
  }

  function queueSnapshotEvent(ev, m){
    initBag();
    bag.pendingEvents.push({ev,m});
  }

  function replayPendingSnapshotEvents(activeId){
    initBag();
    if(!activeId || !bag.pendingEvents.length) return;
    bag.replayingSnapshotEvents=true;
    try{
      while(bag.pendingEvents.length && bag.activeId===activeId){
        const next=bag.pendingEvents.shift();
        try{ handleEvent(next.ev,next.m); }
        catch(e){ console.warn("pending snapshot event replay failed", next&&next.ev, e); }
      }
      if(bag.activeId!==activeId) bag.pendingEvents=[];
    }finally{
      bag.replayingSnapshotEvents=false;
    }
  }

  function isReplayedOldItem(m,p){
    const tid=eventTurnId(m,p)||m.turn_id;
    return !!(tid && isFinishedTurn(tid) && m.item_id && !bag.items.has(m.item_id));
  }

  function finishTurn(doneTurnId, status, label, kind, meta={}){
    if(isFinishedTurn(doneTurnId)){
      const staleLabel=meta.staleLabel||label, staleKind=meta.staleKind||kind;
      if(typeof hooks.onTurnFinished==="function") hooks.onTurnFinished(doneTurnId,status,Object.assign({stale:true,label:staleLabel,kind:staleKind},meta));
      return;
    }
    markTurnFinished(doneTurnId);
    bag.stopTurnId=null; bag.stopRequestedAt=0;
    if(typeof hooks.onTurnFinished==="function") hooks.onTurnFinished(doneTurnId,status,Object.assign({label,kind},meta));
  }

  function ingest(ev, m){
    initBag();
    if(m.thread_id && m.thread_id!==bag.activeId) return;
    if(bag.renderingSnapshot || bag.replayingSnapshotEvents){ queueSnapshotEvent(ev,m); return; }
    handleEvent(ev,m);
  }

  function handleEvent(ev, m){
    initBag();
    if(m.seq!=null){ if(bag.seen.has(m.seq)) return; bag.seen.add(m.seq); }
    const p=m.payload||{};
    if(m.seq==null && seenStableEvent(ev, m, p)) return;
    bag.lastEventAt=Date.now();
    if(m.seq!=null) bag.latestSeq=Math.max(bag.latestSeq||0,m.seq);
    switch(ev){
      case "turn.started":
        if(isFinishedTurn(m.turn_id)) break;
        bag.turnId=m.turn_id;
        if(!isStoppingTurn(m.turn_id)) emitAllowedStatus("turn.started",m,p,{label:"思考中",detail:"本轮已开始,等待模型输出",step:"模型开始处理"});
        break;
      case "turn.interrupt_requested":
        bag.stopTurnId=m.turn_id||bag.turnId; bag.stopRequestedAt=Date.now();
        emitStatus("turn.interrupt_requested",m,p,{label:"正在停止",detail:"已请求中断当前轮",step:"已请求停止"});
        break;
      case "turn.completed":
        finishTurn(eventTurnId(m,p),"completed","已完成","done",{refresh:true,checkHints:true});
        break;
      case "turn.failed":
        finishTurn(eventTurnId(m,p),"failed","本轮失败","err",{refresh:true,checkHints:true});
        break;
      case "turn.interrupted":
        finishTurn(eventTurnId(m,p),"interrupted","已停止","done",{refresh:true,checkHints:true});
        break;
      case "turn.lifecycle":
        if(p.status&&isTurnRunning(p.status)){
          const tid=eventTurnId(m,p);
          if(!isFinishedTurn(tid) && !isStoppingTurn(tid)) emitAllowedStatus("turn.lifecycle.running",m,p,{label:"处理中",detail:p.status});
        }else if(p.status&&isTurnDone(p.status)){
          const doneTurnId=eventTurnId(m,p);
          const st=normTurnStatus(p.status);
          finishTurn(doneTurnId,st,st==="completed"?"已完成":"已结束",st==="failed"?"err":"done",{refresh:false,checkHints:true,staleLabel:"已完成",staleKind:"done"});
        }
        break;
      case "item.started":
        { if(isReplayedOldItem(m,p)) break;
          const existed=!!(m.item_id && bag.items.has(m.item_id)); startItem(m.item_id, p.item);
          if(!existed) emitAllowedStatus("item.started",m,p,{item:p.item}); }
        break;
      case "item.delta":
        if(isReplayedOldItem(m,p)) break;
        deltaItem(m.item_id, p.delta, p.kind);
        if(p.kind==="agent_reasoning") emitAllowedStatus("item.delta.reasoning",m,p,{label:"思考中",detail:"正在推理和规划"});
        else if(p.kind==="agent_message") emitAllowedStatus("item.delta.message",m,p,{label:"输出中",detail:"正在生成回复"});
        else if(p.kind==="command_execution") emitAllowedStatus("item.delta.command",m,p,{label:"执行命令",detail:"正在接收终端输出"});
        break;
      case "item.completed":
        { if(isReplayedOldItem(m,p)) break;
          const wasDone=!!(m.item_id && bag.items.get(m.item_id)?.completed);
          completeItem(m.item_id, p.item);
          if(!wasDone && p.item&&p.item.kind&&p.item.kind!=="agent_message"&&p.item.kind!=="agent_reasoning") emitAllowedStatus("item.completed",m,p,{item:p.item}); }
        break;
      case "item.failed": case "item.interrupted":
        completeItem(m.item_id, p.item, true);
        emitAllowedStatus("item.failed",m,p,{item:p.item||{}});
        emitStatus("item.failure.hint",m,p,{item:p.item});
        break;
      case "approval.required":
        emitStatus("approval.required",m,p,{allowed:allowStatus(m,p)});
        break;
      case "approval.decided": case "approval.timeout":
        emitStatus(ev,m,p,{allowed:allowStatus(m,p),ev});
        break;
      case "sandbox.denied":
        emitStatus("sandbox.denied",m,p,{allowed:allowStatus(m,p)});
        break;
    }
    scrollDown();
  }

  function decorateUserUploads(contentEl, raw){
    const text=String(raw||"");
    const m=text.match(/^我上传了以下文件[^\n]*:\n((?:- [^\n]+\n?)+)\n?/);
    if(!m) return false;
    const paths=m[1].trim().split("\n").map(l=>{
      const l2=l.replace(/^-\s*/,"").trim();
      const orig=l2.match(/原 ?(?:PDF|图):\s*([^)]+)\)/);   // 识图/PDF 转录附件:行首是 txt 路径,原始文件在「原图:/原 PDF:」里(注意「原图:」无空格、「原 PDF:」有空格)
      const p=orig ? orig[1].trim() : l2.replace(/\s*\(.*$/,"");
      return (p.startsWith("/")||p.startsWith("~")) ? p : "";
    }).filter(Boolean);
    if(!paths.length) return false;
    const rest=text.slice(m[0].length).trim();
    contentEl.innerHTML = rest ? md(rest) : "";
    const strip=document.createElement("div"); strip.className="upstrip";
    for(const p of paths){
      const name=p.split("/").pop();
      if(/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)){
        const a=document.createElement("a"); a.href=fileDownloadHref(p,true); a.target="_blank"; a.className="upimg"; a.title=name;
        const img=document.createElement("img"); img.src=fileDownloadHref(p,true); img.alt=name; img.loading="lazy";
        img.onerror=()=>{ a.replaceWith(Object.assign(document.createElement("span"),{className:"upfile",textContent:"🖼 "+name,title:p})); };
        a.appendChild(img); strip.appendChild(a);
      }else{
        const a=document.createElement("a"); a.href=fileDownloadHref(p,false); a.className="upfile"; a.textContent="📎 "+name; a.title=p; strip.appendChild(a);
      }
    }
    contentEl.appendChild(strip);
    return true;
  }

  function collapseInterimMsgs(){
    for(const mid of (bag._turnMsgs||[])){
      const it=bag.items.get(mid);
      if(!it || it.kind!=="agent_message" || !it.el || !it.el.isConnected || it.el.classList.contains("reason")) continue;
      const box=document.createElement("div"); box.className="reason interim";
      box.innerHTML=`<div class="head"><span class="caret">▸</span>${icon("brain")} 思考过程</div><div class="rbody"></div>`;
      box.querySelector(".head").onclick=()=>box.classList.toggle("open");
      box.querySelector(".rbody").appendChild(it.content);
      box.dataset.id=mid;
      if(bag._procGroup&&bag._procGroup.body){ it.el.remove(); bag._procGroup.body.appendChild(box); }
      else it.el.replaceWith(box);
      it.el=box;
    }
    bag._turnMsgs=[];
  }

  function procGroupLabel(item){
    const k=item?.kind||"";
    if(k==="agent_reasoning") return "思考过程";
    if(k==="tool_call") return "工具调用";
    if(k==="file_change") return "文件改动";
    if(k==="command_execution") return "命令执行";
    return "运行过程";
  }

  function procGroupEnsure(){
    let pg=bag._procGroup;
    if(pg&&pg.el&&document.body.contains(pg.el)) return pg;
    const el=document.createElement("div");
    el.className="procgroup";
    el.innerHTML=`<div class="pg-h"><span class="caret">▸</span><span class="ic">${icon("chip")}</span><span class="ttl">运行过程</span><span class="pg-sum"></span><span class="pg-count"></span></div><div class="pg-b"></div>`;
    const head=el.querySelector(".pg-h");
    head.onclick=()=>{ el.classList.toggle("open"); el.dataset.userToggled="1"; };
    keyboardButton(head,()=>{ el.classList.toggle("open"); el.dataset.userToggled="1"; },"展开或折叠运行过程");
    if(!bag.renderingSnapshot) el.classList.add("open");
    const wrap=getWrap();
    if(wrap) wrap.appendChild(el);
    pg={el,body:el.querySelector(".pg-b"),title:el.querySelector(".ttl"),sum:el.querySelector(".pg-sum"),count:el.querySelector(".pg-count"),steps:0};
    bag._procGroup=pg;
    return pg;
  }

  function procGroupAppend(el,item,count=true){
    const pg=procGroupEnsure();
    pg.body.appendChild(el);
    if(count){
      pg.steps++;
      const summary=String(item?.summary||"").replace(/\s+/g," ").trim().slice(0,80);
      pg.count.textContent=`${pg.steps} 步`;
      pg.sum.textContent=summary ? `${procGroupLabel(item)} · ${summary}` : procGroupLabel(item);
    }
  }

  function procGroupFinish(){
    const pg=bag._procGroup;
    if(!pg||!pg.el) return;
    pg.title.textContent=`运行过程 · ${pg.steps||0} 步`;
    pg.sum.textContent="";
    if(!pg.el.dataset.userToggled) pg.el.classList.remove("open");
  }

  function startItem(id, item){
    initBag();
    if(!id||bag.items.has(id)) return;
    const kind=item?.kind||"agent_message";
    const grouped=["tool_call","command_execution","file_change","agent_reasoning"].includes(kind);
    if(kind==="user_message"){ procGroupFinish(); bag._turnMsgs=[]; bag._procGroup=null; }
    else if(grouped){ procGroupEnsure(); collapseInterimMsgs(); }
    const wrap=getWrap(); let el, content, meta=null, userText="", userWhen=null;
    if(kind==="user_message"){
      if(bag._optimUser){ el=bag._optimUser; bag._optimUser=null; content=el.querySelector(".content"); }
      else { el=row("user","你"); content=el.querySelector(".content"); }
      const utxt=item.detail||item.summary||content.textContent||"";
      userText=utxt;
      userWhen=userMessageTime(item,id);
      if(!decorateUserUploads(content,utxt)){ bag.renderingSnapshot ? (content.textContent=utxt) : (content.innerHTML=md(utxt)); }
    }else if(kind==="agent_reasoning"){
      el=document.createElement("div"); el.className="reason";
      el.innerHTML=`<div class="head"><span class="caret">▸</span>${icon("brain")} 思考过程</div><div class="rbody"></div>`;
      el.querySelector(".head").onclick=()=>el.classList.toggle("open");
      content=el.querySelector(".rbody"); content.textContent=item.detail||"";
    }else if(kind==="command_execution"){
      el=document.createElement("div"); el.className="term";
      let cmd=""; try{ meta=JSON.parse(item.detail||"{}"); cmd=meta.command||meta.cmd||""; }catch{ cmd=item.detail||""; }
      el.innerHTML=`<div class="term-cmd"><span class="dollar">$</span>${esc(cmd)}</div><div class="term-out">运行中…</div>`;
      content=el.querySelector(".term-out");
    }else if(kind==="tool_call"||kind==="file_change"){
      el=document.createElement("div"); el.className="tool collapsible";
      const label=kind==="file_change" ? `${icon("edit")} 文件改动` : `${icon("tool")} 工具调用`;
      const detail=String(item.detail||"");
      const initial=(bag.renderingSnapshot && !bag.snapshotFull && detail.length>SNAPSHOT_LAZY_DETAIL_CHARS) ? "详情待展开" : detail;
      el.innerHTML=`<div class="th hd"><span class="caret">▸</span><span class="st"></span><span class="ic">${label}</span><span class="sum">${esc(item.summary||"")}</span></div><div class="tb bd">${esc(initial)}</div>`;
      el.querySelector(".th").onclick=()=>el.classList.toggle("open");
      content=el.querySelector(".tb");
    }else if(kind==="error"){
      el=document.createElement("div"); el.className="sysnote"; el.style.color="var(--err)"; el.textContent="⚠ "+(item.detail||item.summary||"错误"); content=el;
      emitStatus("item.error",{payload:{item}}, {item}, {item, el});
    }else if(kind==="context_compaction"||kind==="status"){
      el=document.createElement("div"); el.className="sysnote"; el.textContent="· "+(item.summary||item.detail||kind); content=el;
      if(kind==="status" && isImportantStatus(item)){ el.style.color="var(--err)"; el.textContent="⚠ "+statusText(item); }
    }else{
      el=row("assistant","CodeWhale"); content=el.querySelector(".content"); content.innerHTML='<span class="typing"></span>';
    }
    if(grouped) procGroupAppend(el,item);
    else if(wrap) wrap.appendChild(el);
    if(el) el.dataset.id=id;
    if(kind==="user_message"){
      const text=userText||item?.detail||item?.summary||content?.textContent||"";
      ensureUserActions(el,id,item,userWhen);
      if(typeof hooks.onUserMessage==="function") hooks.onUserMessage(item, el, {id,text,content});
    }
    bag.items.set(id,{el,content,kind,raw:(kind==="user_message"?userText:(item?.detail||"")),meta:(kind==="user_message"?{time:userWhen&&userWhen.toISOString(),threadId:userMessageThreadId(item,el)}:meta)});
    if(kind==="agent_message") ensureAssistantActions(el,id);
    if(kind==="agent_message") (bag._turnMsgs=bag._turnMsgs||[]).push(id);
  }

  function deltaItem(id, delta, kind){
    initBag();
    if(delta==null) return;
    let it=bag.items.get(id);
    if(it&&it.completed) return;
    if(!it){ startItem(id,{kind:kind||"agent_message",detail:"",summary:""}); it=bag.items.get(id); }
    it.raw=(it.raw||"")+delta;
    if(it.kind==="agent_reasoning"){ schedulePlainStreamUpdate(it); }
    else if(it.kind==="agent_message"||!["tool_call","command_execution","file_change","user_message","status","context_compaction","error"].includes(it.kind)){ schedulePlainStreamUpdate(it); }
    else { it.content.textContent=it.raw; }
    if(it.kind==="command_execution" && typeof hooks.onTerminalOutput==="function") hooks.onTerminalOutput(it.raw,false,it.meta,true);
  }

  function completeItem(id, item, failed){
    initBag();
    const it=bag.items.get(id); if(!it) { if(item) startItem(id,item); return; }
    cancelPlainStreamUpdate(it);
    const snap = item?.detail!=null && item.detail!=="" ? item.detail : "";
    const shouldPreserveStream = it.kind==="agent_message" || it.kind==="agent_reasoning" || !["tool_call","command_execution","file_change","user_message","status","context_compaction","error"].includes(it.kind);
    const final = shouldPreserveStream ? preferLongerText(it.raw, snap) : (snap || it.raw);
    it.raw = final || it.raw || "";
    it.completed = true;
    if(it.kind==="command_execution"){
      if(bag.renderingSnapshot && !bag.snapshotFull && String(final||"").length>SNAPSHOT_LAZY_DETAIL_CHARS) renderLazyPlain(it.content, final, "长终端输出");
      else { it.content.textContent = (final && final.trim()) ? final : (failed ? "" : "(无输出)"); appendPdfDownloadCards(it.content, final); }
      if(failed) it.el.classList.add("failed");
      if(!bag.renderingSnapshot && typeof hooks.onTerminalOutput==="function") hooks.onTerminalOutput(final,!!failed,it.meta,false);
      return;
    }
    if(it.kind==="agent_reasoning") it.content.textContent=final;
    else if(it.kind==="user_message"){
      if(!decorateUserUploads(it.content, final)) renderMaybeMarkdown(it.content, final, it.content.parentElement, bag.renderingSnapshot, inputSel, false);
      const when=userMessageTime(item,id,it.meta&&it.meta.time);
      it.meta=Object.assign({},it.meta,{time:when.toISOString(),threadId:userMessageThreadId(item,it.el)});
      ensureUserActions(it.el,id,item||{},when);
    }
    else if(["tool_call","file_change"].includes(it.kind) && bag.renderingSnapshot && !bag.snapshotFull && String(final||"").length>SNAPSHOT_LAZY_DETAIL_CHARS) renderLazyPlain(it.content, final, it.kind==="file_change"?"长文件变更":"长工具输出");
    else if(["tool_call","file_change","status","context_compaction"].includes(it.kind)){
      it.content.textContent=(it.kind==="status" && isImportantStatus(item)) ? ("⚠ "+final) : final;
      appendPdfDownloadCards(it.content, final);
    }
    else if(bag.renderingSnapshot && !bag.snapshotFull && it.kind==="agent_message" && String(final||"").length>SNAPSHOT_LAZY_AGENT_CHARS) renderLazyMarkdown(it.content, final, it.content.parentElement);
    else renderMaybeMarkdown(it.content, final, it.content.parentElement, bag.renderingSnapshot || String(final||"").length>STREAM_MD_DEFER_CHARS, inputSel);
    if(it.kind==="file_change" && typeof hooks.onFileChangeFinal==="function") hooks.onFileChangeFinal(item, it, final);
    if(it.kind==="agent_message" && typeof hooks.onAssistantFinal==="function") hooks.onAssistantFinal(item||{}, it.el, {id,text:final,failed:!!failed,record:it});
    if(failed) it.el.style.opacity=.6;
  }

  initBag();
  return {
    renderSnapshot:renderThreadSnapshot,
    ingest,
    handleEvent,
    startItem,
    deltaItem,
    completeItem,
    preferLongerText,
    decorateUserUploads,
    collapseInterimMsgs,
    procGroupFinish,
    procGroupEnsure,
    procGroupAppend,
    reset,
    scrollDown,
    updateStickFromScroll,
    isStuck,
    setStick,
    stableEventKey,
    seenStableEvent,
    eventTurnId,
    markTurnFinished,
    isFinishedTurn,
    isReplayedOldItem,
    renderLazyMarkdown,
    renderLazyPlain,
    schedulePlainStreamUpdate,
    cancelPlainStreamUpdate,
    idleTask,
    ensureMdObserver,
    markdownNow,
    forceDeferredMarkdown,
    renderDeferredMarkdown,
    renderMaybeMarkdown,
    queueSnapshotEvent,
    replayPendingSnapshotEvents,
    detectOptions,
    optionTextFromSelection,
    fillOptionInput,
    optionTargets,
    buildOptPicker,
    augmentOptions
  };
}

const chatViewTools={preferLongerText,detectOptions,optionTextFromSelection,fillOptionInput,optionTargets,buildOptPicker,augmentOptions};

export { createChatView, chatViewTools, preferLongerText, detectOptions, optionTextFromSelection, fillOptionInput, optionTargets, buildOptPicker, augmentOptions };
