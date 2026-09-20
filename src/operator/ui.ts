const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>P05 Operator Console</title>
<style>
:root{color-scheme:dark;--bg:#09101d;--panel:#111a2b;--panel2:#17233a;--line:#273650;--text:#edf2fb;--muted:#94a3bc;--good:#55d879;--warn:#f3bd4b;--bad:#ff7272;--accent:#76a7ff;--read:#67b7ff;--write:#f4c15d;--execute:#ff8b72}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Segoe UI,Microsoft YaHei,system-ui,sans-serif}
button,select{font:inherit}header{position:sticky;top:0;z-index:10;background:#0d1524;border-bottom:1px solid var(--line);padding:14px 20px}
.headerline{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:20px;font-weight:700}.sub,.muted{color:var(--muted)}.small{font-size:11px}.actions{display:flex;gap:8px;flex-wrap:wrap}
button{border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:8px 14px;border-radius:8px;cursor:pointer}
button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:#506fd2;border-color:#6f8df0}.danger{background:#5c2830;border-color:#913d49}.warning{background:#5b481d;border-color:#8e6d27}
#actionBanner{display:none;margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12px;background:#111c31}
main{padding:16px;max-width:1700px;margin:auto}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:14px;min-width:0}.span3{grid-column:span 3}.span4{grid-column:span 4}.span5{grid-column:span 5}.span6{grid-column:span 6}.span7{grid-column:span 7}.span8{grid-column:span 8}.span12{grid-column:span 12}
h2{font-size:15px;margin:0 0 10px;color:#d1ddf2}h3{font-size:12px;margin:14px 0 8px;color:#b9c7df}.big{font-size:25px;font-weight:700}.label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(39,54,80,.6)}.row:last-child{border-bottom:0}.value{text-align:right;overflow-wrap:anywhere}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px}.good{background:var(--good)}.bad{background:var(--bad)}.warn{background:var(--warn)}.goodText{color:var(--good)}.badText{color:var(--bad)}.warnText{color:var(--warn)}
select{width:100%;background:#0b1424;color:var(--text);border:1px solid var(--line);padding:8px;border-radius:8px}
.table{width:100%;border-collapse:collapse;font-size:12px}.table th,.table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}.table th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel);z-index:1}
.scroll{max-height:390px;overflow:auto}.nowrap{white-space:nowrap}.mono{font-family:Consolas,ui-monospace,monospace}
.pill{display:inline-block;border:1px solid var(--line);padding:2px 7px;border-radius:999px;font-size:10px;margin:2px 3px 2px 0}.pill.read{border-color:#2f6e9a;color:#84caff}.pill.write{border-color:#8f702d;color:#ffd377}.pill.execute{border-color:#975342;color:#ffa58e}.pill.host{border-color:#715da0;color:#c7b6ff}
.summary{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.metric{background:#0b1424;border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-width:90px}.metric strong{display:block;font-size:17px}
pre{background:#080f1a;border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap;overflow:auto;max-height:280px;font:11px/1.45 Consolas,monospace}
.toast{position:fixed;right:18px;bottom:18px;background:#111b2f;border:1px solid var(--line);padding:11px 14px;border-radius:8px;display:none;max-width:520px;z-index:20}
.detail{color:#c5d1e6;max-width:620px;overflow-wrap:anywhere}.workspaceCard{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-top:7px;background:#0c1525}.workspaceCard.current{border-color:#6887df}.empty{color:var(--muted);font-size:12px;padding:8px 0}
@media(max-width:1100px){.span3,.span4{grid-column:span 6}.span5,.span6,.span7,.span8{grid-column:span 12}}
@media(max-width:680px){.headerline{align-items:flex-start;flex-direction:column}.span3,.span4,.span5,.span6,.span7,.span8,.span12{grid-column:span 12}main{padding:10px}}
</style>
</head>
<body>
<header>
  <div class="headerline">
    <div>
      <div class="brand">P05 Operator Console</div>
      <div class="sub">连接控制 · Workspace · MCP · Git · 实时行为 · Recovery</div>
    </div>
    <div class="actions">
      <button id="connect" class="primary">连接</button>
      <button id="disconnect" class="danger">断开</button>
      <button id="restart" class="warning">重启</button>
      <button id="refresh">刷新</button>
    </div>
  </div>
  <div id="actionBanner"></div>
</header>

<main><div class="grid">
  <section class="card span3"><div class="label">整体连接</div><div id="connectionBig" class="big">...</div><div id="connectionDetail" class="small muted"></div></section>
  <section class="card span3"><div class="label">MCP Server</div><div id="mcpBig" class="big">...</div><div id="mcpDetail" class="small muted"></div></section>
  <section class="card span3"><div class="label">Workspace</div><div id="workspaceBig" class="big">-</div><div id="workspaceTopDetail" class="small muted"></div></section>
  <section class="card span3"><div class="label">Git</div><div id="gitBig" class="big">-</div><div id="gitTopDetail" class="small muted"></div></section>

  <section class="card span6">
    <h2>Workspace</h2>
    <div class="row"><span>当前</span><strong id="workspaceName">-</strong></div>
    <div class="row"><span>路径</span><span id="workspaceRoot" class="value mono small">-</span></div>
    <div class="row"><span>类型</span><span id="workspaceKind">-</span></div>
    <div class="row"><span>插件</span><span id="workspacePlugins" class="value">-</span></div>
    <div class="row"><span>授权</span><span id="workspaceAuth" class="value small">-</span></div>
    <h3>切换 Workspace</h3>
    <div style="display:flex;gap:8px"><select id="workspaceSelect"></select><button id="switchWorkspace" class="primary">切换</button></div>
    <div id="workspaceList"></div>
  </section>

  <section class="card span6">
    <h2>Runtime / Host</h2>
    <div id="runtimeRows"></div>
    <h3>设备</h3><div id="deviceRows"></div>
    <h3>P05 相关进程</h3><div id="processRows" class="scroll"></div>
  </section>

  <section class="card span12">
    <h2>实时行为 Live Activity</h2>
    <div class="small muted" style="margin-bottom:8px">只保留内存中的脱敏详情；命令/路径可见，但敏感参数与正文不会持久化。</div>
    <div class="scroll"><table class="table">
      <thead><tr><th>时间</th><th>风险</th><th>能力</th><th>正在做什么</th><th>状态</th><th>范围</th><th>耗时</th></tr></thead>
      <tbody id="liveRows"></tbody>
    </table></div>
  </section>

  <section class="card span7">
    <h2>Git 工作区</h2>
    <div id="gitSummary" class="summary"></div>
    <div id="gitCommit" class="small muted"></div>
    <h3>文件变化</h3>
    <div class="scroll"><table class="table"><thead><tr><th>状态</th><th>文件</th></tr></thead><tbody id="gitFiles"></tbody></table></div>
    <h3>Diff Stat</h3><pre id="gitDiffStat">-</pre>
  </section>

  <section class="card span5">
    <h2>Plugins / Downstream MCP</h2>
    <div id="pluginRows"></div>
    <div id="downstreamRows"></div>
  </section>

  <section class="card span8">
    <h2>持久 Audit</h2>
    <div class="scroll"><table class="table"><thead><tr><th>时间</th><th>能力</th><th>状态</th><th>Workspace</th><th>耗时</th></tr></thead><tbody id="auditRows"></tbody></table></div>
  </section>

  <section class="card span4">
    <h2>Recovery / 错误</h2>
    <div id="recoveryRows" class="scroll"></div>
  </section>

  <section class="card span12">
    <h2>MCP Tool Surface</h2>
    <div id="toolGroups"></div>
    <h3>未暴露 / Suppressed</h3><div id="suppressedTools"></div>
  </section>

  <section class="card span12">
    <h2>Tunnel 最近日志</h2><pre id="logs">-</pre>
  </section>
</div></main>
<div id="toast" class="toast"></div>

<script>
const TOKEN=__CSRF_TOKEN__;
let latest=null,busy=false;
const $=id=>document.getElementById(id);
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function time(v){if(!v)return"-";try{return new Date(v).toLocaleTimeString()}catch{return String(v)}}
function dateTime(v){if(!v)return"-";try{return new Date(v).toLocaleString()}catch{return String(v)}}
function dot(ok,warn){return '<span class="dot '+(ok?'good':warn?'warn':'bad')+'"></span>'}
function riskPill(r){return '<span class="pill '+esc(r)+'">'+esc(String(r||"").toUpperCase())+'</span>'}
function toast(msg,bad){const e=$("toast");e.textContent=msg;e.style.display="block";e.className="toast "+(bad?"badText":"");setTimeout(()=>e.style.display="none",3500)}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"x-p05-operator-token":TOKEN,"content-type":"application/json",...(opts.headers||{})},cache:"no-store"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d}
function buttons(){const connected=!!latest?.connection?.connected;$("connect").disabled=busy||connected;$("disconnect").disabled=busy||!connected;$("restart").disabled=busy;$("switchWorkspace").disabled=busy||!(latest?.connection?.bridge?.online)}
async function action(name){if(busy)return;busy=true;buttons();try{await api("/api/action/"+name,{method:"POST",body:"{}"});await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}}
function renderAction(op){const a=op?.action,e=$("actionBanner");if(!a){e.style.display="none";return}e.style.display="block";const map={connect:"连接",disconnect:"断开",restart:"重启"};let cls="warnText",txt=(map[a.action]||a.action)+"：";if(a.state==="waiting"){txt+="进行中…";cls="warnText"}else if(a.state==="succeeded"){txt+=a.message||"完成";cls="goodText"}else{txt+=a.error||"失败";cls="badText"}e.className=cls;e.textContent=txt+"  "+dateTime(a.requestedAt)}
function metric(label,value,cls){return '<div class="metric"><span class="label">'+esc(label)+'</span><strong class="'+(cls||"")+'">'+esc(value)+'</strong></div>'}
function render(d){
latest=d;const c=d.connection||{},bridge=c.bridge||{},b=(bridge.online&&bridge.data)||null,h=c.health||{},m=b?.mcp||{},ex=m.exposure||{},cur=b?.workspace?.current||{},workspaces=b?.workspace?.all||[],git=d.git||{},device=b?.device||{};
$("connectionBig").innerHTML=dot(!!c.connected,false)+(c.connected?"已连接":"未连接");$("connectionDetail").textContent=c.connected?"Tunnel + MCP 都在线":(h.ready?"Tunnel 已就绪，MCP 控制桥离线":"Runtime/Tunnel 未就绪");
$("mcpBig").innerHTML=dot(!!bridge.online,false)+(bridge.online?"ONLINE":"OFFLINE");$("mcpDetail").textContent=bridge.online?((m.profile||"-")+" · "+(ex.exposed?.length??0)+" tools"):(bridge.error||"local bridge unavailable");
$("workspaceBig").textContent=cur.label||cur.id||"-";$("workspaceTopDetail").textContent=cur.root||"MCP 离线";
$("gitBig").textContent=git.available?(git.branch||"detached"):"-";$("gitTopDetail").textContent=git.available?(git.dirty?"有未提交修改":"clean"):"Git unavailable";

$("workspaceName").textContent=cur.label||cur.id||"-";$("workspaceRoot").textContent=cur.root||"-";$("workspaceKind").textContent=cur.kind||"-";
$("workspacePlugins").innerHTML=(cur.plugins||[]).length?(cur.plugins||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join(""):'<span class="muted">默认允许已启用插件</span>';
const auth=cur.authorization||{};$("workspaceAuth").textContent=auth.structuredCrossWorkspace?("cross="+auth.structuredCrossWorkspace+" · external="+auth.externalPersistentWrite+" · shell="+auth.shellBoundary):"-";
$("workspaceSelect").innerHTML=workspaces.map(x=>'<option value="'+esc(x.id)+'" '+(x.current?'selected':'')+'>'+esc((x.label||x.id)+"  ["+x.kind+"]")+'</option>').join("");
$("workspaceList").innerHTML=workspaces.map(x=>'<div class="workspaceCard '+(x.current?'current':'')+'"><strong>'+esc(x.label||x.id)+'</strong> '+(x.current?'<span class="pill">CURRENT</span>':'')+'<div class="small muted mono">'+esc(x.root||"")+'</div><div class="small muted">'+esc(x.kind)+' · '+((x.plugins||[]).length?esc(x.plugins.join(", ")):"default plugins")+'</div></div>').join("")||'<div class="empty">MCP 离线</div>';

const rt=c.runtimeTask||{},rr=c.restartTask||{};
$("runtimeRows").innerHTML='<div class="row"><span>P05-Runtime</span><span>'+dot(rt.state==="running",rt.state==="ready")+esc(rt.state||"-")+'</span></div><div class="row"><span>Restart Broker</span><span>'+esc(rr.exists?rr.state:"missing")+'</span></div><div class="row"><span>Tunnel Health</span><span>'+dot(!!h.ready,!!h.live)+esc(h.ready?"READY":h.live?"LIVE":"OFFLINE")+'</span></div><div class="row"><span>Health URL</span><span class="mono small">'+esc(h.baseUrl||"-")+'</span></div><div class="row"><span>Runtime 上次启动</span><span class="small">'+esc(rt.lastRunTime||"-")+'</span></div>';
$("deviceRows").innerHTML='<div class="row"><span>主机</span><span>'+esc(device.hostname||"-")+'</span></div><div class="row"><span>P05 版本</span><span>'+esc(device.agentVersion||"-")+'</span></div><div class="row"><span>系统</span><span>'+esc((device.platform||"-")+" "+(device.release||"")+" "+(device.arch||""))+'</span></div><div class="row"><span>MCP started</span><span class="small">'+esc(dateTime(device.startedAt))+'</span></div>';
const ps=c.processes||[];$("processRows").innerHTML=ps.length?ps.map(p=>'<div class="row"><span><strong>'+esc(p.Role||p.ProcessName)+'</strong><div class="small muted">'+esc(p.ProcessName)+' · PID '+esc(p.Id)+'</div></span><span class="small">'+esc(dateTime(p.StartTime))+'</span></div>').join(""):'<div class="empty">未检测到 P05 相关进程</div>';

const live=b?.liveActivity||[];$("liveRows").innerHTML=live.map(e=>'<tr><td class="nowrap">'+esc(time(e.startedAt))+'</td><td>'+riskPill(e.risk)+'</td><td><strong>'+esc(e.capability)+'</strong></td><td class="detail">'+esc(e.detail||e.summary||"-")+'</td><td class="'+(e.state==="failed"?"badText":e.state==="succeeded"?"goodText":"warnText")+'">'+esc(e.state)+(e.phase&&e.state==="running"?' · '+esc(e.phase):'')+'</td><td>'+esc(e.scope||"-")+'</td><td>'+esc(e.durationMs!=null?e.durationMs+" ms":"-")+'</td></tr>').join("")||'<tr><td colspan="7" class="muted">暂无实时行为</td></tr>';

if(git.available){
  const ct=git.counts||{};$("gitSummary").innerHTML=metric("BRANCH",git.branch||"-","")+metric("AHEAD",git.ahead||0,git.ahead?"warnText":"")+metric("BEHIND",git.behind||0,git.behind?"warnText":"")+metric("STAGED",ct.staged||0,ct.staged?"warnText":"")+metric("MODIFIED",ct.modified||0,ct.modified?"warnText":"")+metric("UNTRACKED",ct.untracked||0,ct.untracked?"warnText":"")+metric("CONFLICT",ct.conflicted||0,ct.conflicted?"badText":"");
  const lc=git.lastCommit;$("gitCommit").textContent=lc?("最近 commit "+lc.hash+" · "+lc.author+" · "+lc.subject):"";
  $("gitFiles").innerHTML=(git.files||[]).map(f=>'<tr><td class="mono">'+esc(f.status)+'</td><td class="mono">'+esc(f.path)+'</td></tr>').join("")||'<tr><td colspan="2" class="goodText">工作区 clean</td></tr>';
  const ds=git.diffStat||{};$("gitDiffStat").textContent=["UNSTAGED",ds.unstaged||"(none)","","STAGED",ds.staged||"(none)"].join("\n");
}else{$("gitSummary").innerHTML='<div class="empty">Git unavailable</div>';$("gitCommit").textContent="";$("gitFiles").innerHTML='<tr><td colspan="2" class="muted">-</td></tr>';$("gitDiffStat").textContent="-";}

const pl=b?.plugins||[];$("pluginRows").innerHTML='<h3>Plugins</h3>'+(pl.length?pl.map(p=>'<div class="row"><span><strong>'+esc(p.label||p.id)+'</strong><div class="small muted">'+esc(p.id)+' · '+esc(p.version||"")+'</div></span><span>'+dot(p.state==="running",p.state==="ready")+esc(p.state)+(p.activeForWorkspace?' <span class="pill">active</span>':'')+'</span></div>').join(""):'<div class="empty">无插件状态</div>');
const ds=b?.downstream||[];$("downstreamRows").innerHTML='<h3>Downstream MCP</h3>'+(ds.length?ds.map(x=>'<div class="row"><span><strong>'+esc(x.label||x.id)+'</strong><div class="small muted">'+esc(x.workspaceBinding||"")+(x.boundWorkspaceId?' · '+esc(x.boundWorkspaceId):'')+'</div></span><span>'+dot(!!x.connected,!!x.configured)+esc(x.connected?"connected":x.configured?"configured":"off")+'</span></div>').join(""):'<div class="empty">无 Downstream MCP</div>');

const audit=b?.activity||[];$("auditRows").innerHTML=audit.map(e=>'<tr><td class="nowrap">'+esc(time(e.startedAt))+'</td><td>'+esc(e.capability)+'</td><td class="'+(e.state==="failed"?"badText":e.state==="succeeded"?"goodText":"warnText")+'">'+esc(e.state)+'</td><td>'+esc(e.workspaceId)+'</td><td>'+esc(e.durationMs!=null?e.durationMs+" ms":"-")+'</td></tr>').join("")||'<tr><td colspan="5" class="muted">暂无 Audit</td></tr>';
const rec=b?.recovery||[];$("recoveryRows").innerHTML=rec.length?rec.map(e=>'<div class="row"><span><strong>'+esc(e.capability)+'</strong><div class="small muted">'+esc(time(e.startedAt))+' · '+esc(e.errorCategory||"failed")+'</div></span><span class="pill">'+esc(e.recoveryHint)+'</span></div>').join(""):'<div class="goodText small">当前没有待处理 Recovery</div>';

const caps=m.capabilities||[],exposed=new Set(ex.exposed||[]),groups={read:[],write:[],execute:[]};caps.forEach(x=>{if(exposed.has(x.name)&&(groups[x.risk]||groups.read).push(x)});
$("toolGroups").innerHTML=["read","write","execute"].map(r=>'<h3>'+r.toUpperCase()+' ('+groups[r].length+')</h3>'+groups[r].map(x=>'<span class="pill '+r+'" title="'+esc(x.summary)+'">'+esc(x.name)+'</span>').join("")).join("");
$("suppressedTools").innerHTML=(ex.suppressed||[]).map(x=>'<div class="row"><span class="mono">'+esc(x.tool)+'</span><span class="small muted">'+esc(x.reason)+'</span></div>').join("")||'<span class="goodText small">当前没有 suppressed tools</span>';
$("logs").textContent=(d.logTail||[]).join("\n")||"暂无日志";
renderAction(d.operator);buttons();
}
async function refresh(){try{render(await api("/api/status"))}catch(e){toast("状态刷新失败: "+e.message,true)}}
$("connect").onclick=()=>action("connect");$("disconnect").onclick=()=>{if(confirm("确认断开 P05 Tunnel/MCP？Operator Console 会保持在线。"))action("disconnect")};$("restart").onclick=()=>{if(confirm("确认重启 P05 Runtime？GUI 会保持在线。"))action("restart")};$("refresh").onclick=refresh;
$("switchWorkspace").onclick=async()=>{if(busy)return;busy=true;buttons();try{const id=$("workspaceSelect").value;await api("/api/workspace/select",{method:"POST",body:JSON.stringify({id:id})});toast("Workspace 已切换为 "+id);await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
refresh();setInterval(refresh,2000);
</script>
</body></html>`;

export function operatorPage(csrfToken: string): string {
  return PAGE.replace("__CSRF_TOKEN__", JSON.stringify(csrfToken));
}
