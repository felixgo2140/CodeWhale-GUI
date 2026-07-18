const API = location.origin;            // 同源:经 server.py 代理到本机 codewhale(免 CORS,适配手机)
const TOKEN = (new URLSearchParams(location.search).get("token")) || localStorage.getItem("cw_token") || "";
if(TOKEN){
  localStorage.setItem("cw_token",TOKEN);
  if(new URLSearchParams(location.search).get("token")){
    const q=new URLSearchParams(location.search); q.delete("token");
    const rest=q.toString();
    history.replaceState({},"",location.pathname+(rest?"?"+rest:"")+location.hash);
  }
}
// 新会话 workspace 不再由前端指定:createThread 传空 body,app-server 用自身工作目录($HOME)→ 任何机器都正确,无需注入/写死路径
const url = p => API + p;   // 鉴权优先走 HttpOnly cookie;TOKEN 只作为旧入口/localStorage 的 Authorization 兜底,不再拼进 URL
const auth = TOKEN ? {Authorization:"Bearer "+TOKEN} : {};

function errorValueText(value){
  if(value===null || value===undefined) return "";
  if(typeof value==="string") return value;
  if(typeof value==="number" || typeof value==="boolean") return String(value);
  if(typeof value==="object"){
    for(const key of ["message","detail","error","output","code"]){
      const nested=errorValueText(value[key]);
      if(nested) return nested;
    }
    try{ return JSON.stringify(value); }catch(e){}
  }
  return String(value);
}
function errorBodyText(body){
  let s=errorValueText(body).trim();
  try{
    const j=JSON.parse(s);
    s=errorValueText(j.error??j.message??j.detail??j.output) || s;
  }catch(e){}
  return s.replace(/\s+/g," ").trim();
}
function explainError(input,path="",status=0){
  const raw=errorBodyText(input);
  const hay=(path+" "+raw).toLowerCase();
  let msg=raw||"未知错误";
  if(/has no auth configured|no auth configured|api_key_env|api key env/.test(hay)){
    msg="该模型还没有配置 API key。请打开左下模型设置,选择对应 provider 后填写 key；换电脑后也需要在那台电脑本机重新配置。";
  }else if(/invalid api key|incorrect api key|api key is invalid|unauthorized api key|bad api key/.test(hay)){
    msg="API key 无效。请检查模型设置里的 provider 是否选对、key 是否完整,以及是否复制了多余空格。";
  }else if(/free_quota_exhausted|endpoint is inactive|quota|insufficient balance|402/.test(hay)){
    msg="额度或计费状态不可用。请确认对应平台已充值/开通 endpoint,并且当前 key 有权限调用这个模型。";
  }else if(status===401 || /\b401\b|unauthorized|forbidden token|invalid token/.test(hay)){
    msg="未授权。当前页面 token 可能和后端不匹配,请从 CodeWhale App 内重新打开或刷新更新后的入口。";
  }else if(status===404 || /\b404\b|not found/.test(hay)){
    msg="接口不存在或当前版本不完整。请确认 GUI 和 CodeWhale 后端都已更新到同一批版本。";
  }else if(/failed to fetch|networkerror|network error|load failed|eventsource/.test(hay)){
    msg="网络连接失败。请确认本机 CodeWhale 后端仍在运行,或重启后端后再试。";
  }
  return (status?("HTTP "+status+": "):"")+msg+(raw&&msg!==raw?(" 原始信息: "+raw.slice(0,240)):"");
}
function makeApiError(path,status,body){
  const e=new Error(explainError(body,path,status));
  e.status=status; e.path=path; e.body=body;
  return e;
}
async function api(path, opts={}){
  let r;
  try{ r = await fetch(url(path), {...opts, headers:{...(opts.body?{"Content-Type":"application/json"}:{}),...auth,...(opts.headers||{})}}); }
  catch(e){ throw makeApiError(path,0,e); }
  if(!r.ok) throw makeApiError(path,r.status,(await r.text()).slice(0,1000));
  const ct = r.headers.get("content-type")||""; return ct.includes("json") ? r.json() : r.text();
}

export { API, TOKEN, url, auth, errorBodyText, explainError, makeApiError, api };
