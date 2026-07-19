const $ = s => document.querySelector(s);
const state = { threads:[], activeId:null, es:null, items:new Map(), seen:new Set(), turnId:null, running:false,
  pinned:new Set(JSON.parse(localStorage.getItem("cw_pinned")||"[]")),
  cronJobs:new Set(JSON.parse(localStorage.getItem("cw_cron_jobs")||"[]")),              // 手动标记的定时任务 thread/session,服务端同步后进入侧栏最上方
  cmpThreads:new Set(JSON.parse(localStorage.getItem("cw_cmp")||"[]")),                 // 多模型对比建的 thread → 侧栏单独归一组
  cmpSessions:JSON.parse(localStorage.getItem("cw_cmp_sessions")||"[]"),                // 对比会话:[{id,topic,ts,threads:{prov:tid}}] → 侧栏每会话一行,点击回到当时对比
  grpCollapsed:new Set(JSON.parse(localStorage.getItem("cw_grpcollapsed")||"[]")),      // 折叠的分组(Cron/置顶/对比/对话)
  // 乐观新建、还没进服务端慢缓存(summary 刷新最长 2-3 分钟)的新对话:持久化到 localStorage——
  // 否则这窗口刷新页面就丢(felix 撞过两次"新对话找不到"),留 48h 兜底,真出现在列表后由 loadThreads 清掉
  pendingNew:(JSON.parse(localStorage.getItem("cw_pendingnew")||"[]")).filter(p=>p&&p.id&&(Date.now()-new Date(p.updated_at||0).getTime())<48*3600*1000),
  autoApprove:false, allowShell:false, queue:[], attachments:[], _preparingSend:false, stopTurnId:null, stopRequestedAt:0, runUI:null, finishedTurnIds:new Set(), lastEventAt:0, activeMaxInputTokens:0, activeTurnCount:0 };  // 按会话,不再全局持久
function savePendingNew(){ try{ localStorage.setItem("cw_pendingnew",JSON.stringify((state.pendingNew||[]).slice(0,20))); }catch(e){} }
const preview={url:localStorage.getItem("cw_preview_url")||"", scanT:null, lastKey:"", autoOpen:localStorage.getItem("cw_pv_auto_open")!=="0", autoRefresh:localStorage.getItem("cw_pv_auto_refresh")!=="0", size:localStorage.getItem("cw_pv_size")||"desktop", sandboxMode:localStorage.getItem("cw_pv_sandbox")||"auto", confirmedExternal:new Set()};

export { $, state, savePendingNew, preview };
