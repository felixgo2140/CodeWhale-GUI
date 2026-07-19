import {api} from "./api.js";
import {$, state} from "./state.js";

let voiceTarget=null;
let voiceRun=0;
let voiceHideTimer=null;
let voiceControlState="idle";
const VOICE_TITLE="按住 Fn 或点击麦克风语音输入,结束后自动整理到输入框";

function isVisible(el){
  return !!el && !el.hidden && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function defaultVoiceTarget(){
  const active=document.activeElement;
  if(active && active.matches?.("#input,#cmpInput,.cmpcolin") && isVisible(active)) return active;
  const compareWindow=new URLSearchParams(location.search).get("compare")==="1";
  const cmp=$("#cmpInput");
  if(compareWindow && isVisible(cmp)) return cmp;
  return $("#input") || cmp;
}

function voiceStatusFor(target=voiceTarget){
  return target && (target.id==="cmpInput" || target.classList?.contains("cmpcolin")) ? $("#cmpVoiceStatus") : $("#voiceStatus");
}

function nativeVoiceBridge(){
  return window.webkit?.messageHandlers?.voiceControl;
}

function voiceButtonFor(target=voiceTarget){
  if(target?.classList?.contains("cmpcolin")){
    const provider=String(target.id||"").replace(/^cmpin-/,"");
    return document.getElementById("cmpvoice-"+provider);
  }
  return target?.id==="cmpInput" ? $("#cmpVoiceBtn") : $("#voicebtn");
}

function syncVoiceButtons(kind="idle",target=voiceTarget){
  document.querySelectorAll(".voicebtn").forEach(button=>{
    button.classList.remove("starting","recording","processing");
    button.disabled=kind==="processing";
    button.setAttribute("aria-pressed","false");
    button.title=button.classList.contains("cmpcolvoice")
      ? "语音追问（点击开始,再次点击结束）"
      : "语音输入（点击开始,再次点击结束）";
  });
  const button=voiceButtonFor(target);
  if(!button || kind==="idle") return;
  button.classList.add(kind);
  button.setAttribute("aria-pressed",kind==="starting"||kind==="recording" ? "true" : "false");
  button.title=kind==="recording" ? "结束语音输入" : (kind==="processing" ? "正在转写并整理" : "正在启动麦克风");
}

function setVoiceControlState(kind,target=voiceTarget){
  voiceControlState=kind;
  syncVoiceButtons(kind,target);
}

function postNativeVoice(action){
  const bridge=nativeVoiceBridge();
  if(!bridge || typeof bridge.postMessage!=="function") return false;
  bridge.postMessage({action});
  return true;
}

function targetForVoiceButton(button){
  if(button?.classList.contains("cmpcolvoice")){
    const provider=String(button.id||"").replace(/^cmpvoice-/,"");
    return document.getElementById("cmpin-"+provider);
  }
  return button?.id==="cmpVoiceBtn" ? $("#cmpInput") : $("#input");
}

function onVoiceButtonClick(event){
  const button=event.target.closest?.(".voicebtn");
  if(!button) return;
  event.preventDefault();
  event.stopPropagation();
  const target=targetForVoiceButton(button)||defaultVoiceTarget();
  if(voiceControlState==="recording" || voiceControlState==="starting"){
    if(postNativeVoice("stop")){
      setVoiceControlState("processing",voiceTarget||target);
      setVoiceStatus("processing","正在转写","",voiceTarget||target);
    }
    return;
  }
  if(voiceControlState==="processing"){
    if(typeof window.cwToast==="function") window.cwToast("正在转写并整理,请稍候");
    return;
  }
  if(!postNativeVoice("start")){
    if(typeof window.cwToast==="function") window.cwToast("语音按钮需在 CodeWhale macOS App 中使用");
    return;
  }
  voiceTarget=target;
  voiceTarget?.focus();
  setVoiceControlState("starting",voiceTarget);
  setVoiceStatus("processing","正在启动麦克风","",voiceTarget);
}

function setVoiceStatus(kind,label,preview="",target=voiceTarget){
  clearTimeout(voiceHideTimer);
  const box=voiceStatusFor(target);
  if(!box) return;
  box.hidden=false;
  box.className=kind||"";
  const l=box.querySelector(".voice-label"), p=box.querySelector(".voice-preview");
  if(l) l.textContent=label||"";
  if(p) p.textContent=preview||"";
}

function hideVoiceStatus(delay=0,target=voiceTarget){
  clearTimeout(voiceHideTimer);
  const box=voiceStatusFor(target);
  voiceHideTimer=setTimeout(()=>{ if(box) box.hidden=true; },delay);
}

function voiceProvider(target){
  if(target?.classList?.contains("cmpcolin")) return String(target.id||"").replace(/^cmpin-/,"");
  const active=(state.threads||[]).find(t=>t.id===state.activeId);
  return (active&&!active.compare&&active.provider) || window._activeChatProv || window._newchatProv || "";
}

function localVoiceCleanup(text,draft=""){
  let spoken=String(text||"").trim();
  for(let i=0;i<4;i++){
    const cleaned=spoken.replace(/(^|[，。！？!?；;\n])\s*(嗯+|呃+|啊+|那个|这个|怎么说呢|我想一下)[，,、\s]*/g,"$1");
    if(cleaned===spoken) break;
    spoken=cleaned;
  }
  spoken=spoken.replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
  return [String(draft||"").trim(),spoken].filter(Boolean).join("\n");
}

function markVoiceTarget(event){
  const target=event?.target;
  if(target?.matches?.("#input,#cmpInput,.cmpcolin")) target.title=VOICE_TITLE;
}

function applyVoicePrompt(target,prompt,draft){
  if(!target || !document.contains(target)) target=defaultVoiceTarget();
  if(!target) return;
  const current=target.value||"";
  target.value=(current===draft) ? prompt : [current.trim(),prompt.trim()].filter(Boolean).join("\n\n");
  target.dispatchEvent(new Event("input",{bubbles:true}));
  target.focus();
  try{ target.setSelectionRange(target.value.length,target.value.length); }catch(e){}
}

async function refineVoiceTranscript(text,target){
  const run=++voiceRun;
  const draft=target?.value||"";
  setVoiceStatus("processing","正在整理",text,target);
  let result;
  try{
    result=await api("/api/voice/refine",{method:"POST",body:JSON.stringify({
      transcript:text,draft,provider:voiceProvider(target)
    })});
  }catch(e){
    result={ok:true,prompt:localVoiceCleanup(text,draft),refined:false,warning:"模型整理失败,已保留转写"};
  }
  if(run!==voiceRun) return;
  const prompt=String(result?.prompt||localVoiceCleanup(text,draft)).trim();
  if(!prompt){ setVoiceControlState("idle",target); setVoiceStatus("error","没有听清","请重试",target); hideVoiceStatus(2200,target); return; }
  applyVoicePrompt(target,prompt,draft);
  setVoiceControlState("idle",target);
  setVoiceStatus("done",result?.refined===false?"已转写":"已整理",prompt,target);
  if(result?.warning && typeof window.cwToast==="function") window.cwToast(result.warning);
  hideVoiceStatus(1600,target);
}

function onNativeVoice(event){
  const d=event?.detail||{};
  const stateName=String(d.state||"");
  if(stateName==="recording"){
    voiceRun++;
    voiceTarget=voiceControlState==="starting" && voiceTarget && document.contains(voiceTarget) ? voiceTarget : defaultVoiceTarget();
    voiceTarget?.classList.add("voice-listening");
    setVoiceControlState("recording",voiceTarget);
    setVoiceStatus("recording","正在听",d.text||"",voiceTarget);
    return;
  }
  if(stateName==="partial"){
    setVoiceControlState("recording",voiceTarget);
    setVoiceStatus("recording","正在听",d.text||"",voiceTarget);
    return;
  }
  if(stateName==="processing"){
    voiceTarget?.classList.remove("voice-listening");
    setVoiceControlState("processing",voiceTarget);
    setVoiceStatus("processing","正在转写",d.text||"",voiceTarget);
    return;
  }
  if(stateName==="final"){
    voiceTarget?.classList.remove("voice-listening");
    setVoiceControlState("processing",voiceTarget);
    const text=String(d.text||"").trim();
    if(text) refineVoiceTranscript(text,voiceTarget||defaultVoiceTarget());
    else { setVoiceControlState("idle",voiceTarget); setVoiceStatus("error","没有听清","请重试",voiceTarget); hideVoiceStatus(2200,voiceTarget); }
    return;
  }
  if(stateName==="ready"){
    setVoiceControlState("idle",voiceTarget);
    setVoiceStatus("done","语音输入已就绪",d.message||"",voiceTarget);
    hideVoiceStatus(2200,voiceTarget);
    return;
  }
  if(stateName==="error"){
    voiceTarget?.classList.remove("voice-listening");
    setVoiceControlState("idle",voiceTarget);
    const msg=String(d.message||"语音输入失败");
    setVoiceStatus("error","语音输入失败",msg,voiceTarget);
    if(typeof window.cwToast==="function") window.cwToast(msg);
    hideVoiceStatus(3200,voiceTarget);
  }
}

function initVoiceInput(){
  window.removeEventListener("codewhale:voice",onNativeVoice);
  window.addEventListener("codewhale:voice",onNativeVoice);
  document.removeEventListener("focusin",markVoiceTarget);
  document.removeEventListener("mouseover",markVoiceTarget);
  document.addEventListener("focusin",markVoiceTarget);
  document.addEventListener("mouseover",markVoiceTarget);
  document.removeEventListener("click",onVoiceButtonClick);
  document.addEventListener("click",onVoiceButtonClick);
  const single=$("#input"), compare=$("#cmpInput");
  if(single) single.title=VOICE_TITLE;
  if(compare) compare.title=VOICE_TITLE;
  document.querySelectorAll(".cmpcolin").forEach(el=>{ el.title=VOICE_TITLE; });
  syncVoiceButtons(voiceControlState,voiceTarget);
}

export {initVoiceInput,onNativeVoice,refineVoiceTranscript,onVoiceButtonClick};
