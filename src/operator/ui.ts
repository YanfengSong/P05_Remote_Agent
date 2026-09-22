const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>P05 Operator Console</title>
<style>
:root{color-scheme:dark;--bg:#09101d;--panel:#111a2b;--panel2:#17233a;--line:#273650;--text:#edf2fb;--muted:#94a3bc;--good:#55d879;--warn:#f3bd4b;--bad:#ff7272;--accent:#76a7ff;--read:#67b7ff;--write:#f4c15d;--execute:#ff8b72}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Segoe UI,Microsoft YaHei,system-ui,sans-serif}
button,select,input{font:inherit}header{position:sticky;top:0;z-index:10;background:#0d1524;border-bottom:1px solid var(--line);padding:14px 20px}
.headerline{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:20px;font-weight:700}.sub,.muted{color:var(--muted)}.small{font-size:11px}.actions{display:flex;gap:8px;flex-wrap:wrap}
button{border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:8px 14px;border-radius:8px;cursor:pointer}
button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:#506fd2;border-color:#6f8df0}.danger{background:#5c2830;border-color:#913d49}.warning{background:#5b481d;border-color:#8e6d27}
#actionBanner{display:none;margin-top:10px;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12px;background:#111c31}
main{padding:16px;max-width:1700px;margin:auto}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:14px;min-width:0}.span3{grid-column:span 3}.span4{grid-column:span 4}.span5{grid-column:span 5}.span6{grid-column:span 6}.span7{grid-column:span 7}.span8{grid-column:span 8}.span12{grid-column:span 12}
h2{font-size:15px;margin:0 0 10px;color:#d1ddf2}h3{font-size:12px;margin:14px 0 8px;color:#b9c7df}.big{font-size:25px;font-weight:700}.label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid rgba(39,54,80,.6)}.row:last-child{border-bottom:0}.value{text-align:right;overflow-wrap:anywhere}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:6px}.good{background:var(--good)}.bad{background:var(--bad)}.warn{background:var(--warn)}.goodText{color:var(--good)}.badText{color:var(--bad)}.warnText{color:var(--warn)}
select,input{width:100%;background:#0b1424;color:var(--text);border:1px solid var(--line);padding:8px;border-radius:8px}
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
      <button id="operatorState" class="primary" disabled>Console 已开启</button>
      <button id="closeOperator" class="danger">关闭 Console</button>

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
    <h2>Runtime A · @Boonray-A</h2>
    <div class="row"><span>状态</span><span id="slotAState">-</span></div>
    <div class="row"><span>Device ID</span><span id="slotADeviceId" class="value mono small">-</span></div>
    <div class="row"><span>当前 Workspace</span><strong id="slotAWorkspace">-</strong></div>
    <div class="row"><span>启动绑定</span><span id="slotABoundWorkspace" class="value mono small">-</span></div>
    <div class="row"><span>路径</span><span id="slotAWorkspaceRoot" class="value mono small">-</span></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button id="slotAToggle" class="primary">启动 A</button><button id="slotARestart" class="warning">重启 A</button></div>
    <h3>绑定 Workspace</h3>
    <div style="display:flex;gap:8px"><select id="slotAWorkspaceSelect"></select><button id="slotASwitchWorkspace" class="primary">切换</button></div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="slotARootInput" class="mono" placeholder="选择或输入已授权范围内的目录" /><button id="slotAPickWorkspace">选择文件夹</button><button id="slotASetWorkspace" class="primary">设为工作区</button></div>
    <div style="margin-top:8px"><button id="slotARegisterWorkspace">保存当前 Workspace</button></div>
  </section>

  <section class="card span6">
    <h2>Runtime B · @Boonray-B</h2>
    <div class="row"><span>状态</span><span id="slotBState">-</span></div>
    <div class="row"><span>Device ID</span><span id="slotBDeviceId" class="value mono small">-</span></div>
    <div class="row"><span>当前 Workspace</span><strong id="slotBWorkspace">-</strong></div>
    <div class="row"><span>启动绑定</span><span id="slotBBoundWorkspace" class="value mono small">-</span></div>
    <div class="row"><span>路径</span><span id="slotBWorkspaceRoot" class="value mono small">-</span></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button id="slotBToggle" class="primary">启动 B</button><button id="slotBRestart" class="warning">重启 B</button></div>
    <h3>绑定 Workspace</h3>
    <div style="display:flex;gap:8px"><select id="slotBWorkspaceSelect"></select><button id="slotBSwitchWorkspace" class="primary">切换</button></div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="slotBRootInput" class="mono" placeholder="选择或输入已授权范围内的目录" /><button id="slotBPickWorkspace">选择文件夹</button><button id="slotBSetWorkspace" class="primary">设为工作区</button></div>
    <div style="margin-top:8px"><button id="slotBRegisterWorkspace">保存当前 Workspace</button></div>
  </section>

  <section class="card span12">
    <h2>MCP 当前状态</h2>
    <div id="mcpStatusSummary" class="summary"></div>
    <div class="row"><span>Control Bridge</span><span id="mcpBridgeState">-</span></div>
    <div class="row"><span>MCP 进程</span><span id="mcpProcessState" class="value">-</span></div>
    <div class="row"><span>启动时间</span><span id="mcpStartedAt" class="value small">-</span></div>
    <div class="row"><span>Profile 来源</span><span id="mcpProfileSource" class="value">-</span></div>
    <div class="row"><span>Device ID</span><span id="mcpDeviceId" class="value mono small">-</span></div>
    <div class="row"><span>状态刷新</span><span id="mcpRefreshedAt" class="value small">-</span></div>
    <div class="row"><span>错误</span><span id="mcpStatusError" class="value small">-</span></div>
  </section>

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
    <h3>设置 MCP 工作目录</h3>
    <div style="display:flex;gap:8px"><input id="workspaceRootInput" class="mono" placeholder="输入已授权范围内的绝对目录路径" /><button id="pickWorkspaceRoot">选择文件夹</button><button id="setWorkspaceRoot" class="primary">设为工作区</button></div>
    <div class="small muted" style="margin-top:6px">仅本次 Runtime 会话生效；不会扩大 REMOTE_AGENT_ALLOWED_ROOTS。</div>
    <div style="margin-top:10px"><button id="registerWorkspace">保存当前 Workspace</button></div>
    <div class="small muted" style="margin-top:6px">把当前 Operator 临时工作区注册为持久 Workspace；Runtime 重启后仍会保留。</div>
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
let latest=null,busy=false,workspaceSelectionDirty=false,slotSelectionDirty={A:false,B:false};
const $=id=>document.getElementById(id);
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function time(v){if(!v)return"-";try{return new Date(v).toLocaleTimeString()}catch{return String(v)}}
function dateTime(v){if(!v)return"-";try{return new Date(v).toLocaleString()}catch{return String(v)}}
function dot(ok,warn){return '<span class="dot '+(ok?'good':warn?'warn':'bad')+'"></span>'}
function riskPill(r){return '<span class="pill '+esc(r)+'">'+esc(String(r||"").toUpperCase())+'</span>'}
function toast(msg,bad){const e=$("toast");e.textContent=msg;e.style.display="block";e.className="toast "+(bad?"badText":"");setTimeout(()=>e.style.display="none",3500)}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"x-p05-operator-token":TOKEN,"content-type":"application/json",...(opts.headers||{})},cache:"no-store"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d}
function slotIsRunning(slot){
  const data=latest?.slots?.[slot]||{};
  if(data?.configured===false)return false;
  return !!data?.connected||!!data?.health?.ready||!!data?.health?.live;
}
function buttons(){
  const pending=latest?.operator?.action?.state==="waiting",bridgeOnline=!!latest?.connection?.bridge?.online,currentWorkspaceId=latest?.connection?.bridge?.data?.workspace?.current?.id||"";
  $("closeOperator").disabled=busy;
  $("switchWorkspace").disabled=busy||pending||!bridgeOnline;
  $("pickWorkspaceRoot").disabled=busy||pending;
  $("setWorkspaceRoot").disabled=busy||pending||!bridgeOnline;
  $("registerWorkspace").disabled=busy||pending||!bridgeOnline||currentWorkspaceId!=="operator-session";
  for(const slot of ["A","B"]){
    const data=latest?.slots?.[slot]||{},configured=data?.configured!==false,online=!!data?.bridge?.online,currentId=data?.workspace?.current?.id||"",running=slotIsRunning(slot);
    const toggle=$("slot"+slot+"Toggle");
    toggle.disabled=busy||!configured;
    toggle.textContent=!configured?"未配置 "+slot:running?"关闭 "+slot:"启动 "+slot;
    toggle.className=running?"danger":"primary";
    $("slot"+slot+"Restart").disabled=busy||!configured||!running;
    $("slot"+slot+"SwitchWorkspace").disabled=busy||!configured||!online;
    $("slot"+slot+"PickWorkspace").disabled=busy||!configured;
    $("slot"+slot+"SetWorkspace").disabled=busy||!configured||!online;
    $("slot"+slot+"RegisterWorkspace").disabled=busy||!configured||!online||currentId!=="operator-session";
  }
}
async function action(name){if(busy)return;busy=true;buttons();try{await api("/api/action/"+name,{method:"POST",body:"{}"});await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}}
function renderAction(op){const a=op?.action,e=$("actionBanner");if(!a){e.style.display="none";return}e.style.display="block";const map={connect:"连接",disconnect:"断开",restart:"重启"};let cls="warnText",txt=(map[a.action]||a.action)+"：";if(a.state==="waiting"){txt+="进行中…";cls="warnText"}else if(a.state==="succeeded"){txt+=a.message||"完成";cls="goodText"}else{txt+=a.error||"失败";cls="badText"}e.className=cls;e.textContent=txt+"  "+dateTime(a.requestedAt)}
function metric(label,value,cls){return '<div class="metric"><span class="label">'+esc(label)+'</span><strong class="'+(cls||"")+'">'+esc(value)+'</strong></div>'}
function renderSlot(slot,data){
  data=data||{};
  const configured=data?.configured!==false,online=!!data?.bridge?.online,health=data?.health||{},current=data?.workspace?.current||{},workspaces=data?.workspace?.all||[],device=data?.device||{};
  const stateText=!configured?"NOT CONFIGURED":data.connected?"ONLINE":health.ready?"READY · 等待插件唤醒":health.live?"LIVE":"OFFLINE";
  $("slot"+slot+"State").innerHTML=dot(!!data.connected,!configured||!!health.live)+esc(stateText);
  $("slot"+slot+"DeviceId").textContent=device.deviceId||"-";
  $("slot"+slot+"Workspace").textContent=current.label||current.id||"-";
  $("slot"+slot+"BoundWorkspace").textContent=data.boundWorkspaceId||"-";
  $("slot"+slot+"WorkspaceRoot").textContent=current.root||"-";
  const select=$("slot"+slot+"WorkspaceSelect"),pending=slotSelectionDirty[slot]?select.value:"";
  select.innerHTML=workspaces.map(x=>'<option value="'+esc(x.id)+'" '+(x.current?'selected':'')+'>'+esc((x.label||x.id)+"  ["+(x.kind||"-")+"]")+'</option>').join("");
  if(slotSelectionDirty[slot]&&workspaces.some(x=>x.id===pending)){select.value=pending}else if(slotSelectionDirty[slot]){slotSelectionDirty[slot]=false}
}
function render(d){
latest=d;const c=d.connection||{},bridge=c.bridge||{},b=(bridge.online&&bridge.data)||null,h=c.health||{},m=b?.mcp||{},ex=m.exposure||{},cur=b?.workspace?.current||{},workspaces=b?.workspace?.all||[],git=d.git||{},device=b?.device||{};
$("connectionBig").innerHTML=dot(!!c.connected,false)+(c.connected?"已连接":"未连接");$("connectionDetail").textContent=c.connected?"Tunnel + MCP 都在线":(h.ready?"Tunnel 已就绪，MCP 控制桥离线":"Runtime/Tunnel 未就绪");
$("mcpBig").innerHTML=dot(!!bridge.online,false)+(bridge.online?"ONLINE":"OFFLINE");$("mcpDetail").textContent=bridge.online?((m.profile||"-")+" · "+(ex.exposed?.length??0)+" tools"):(bridge.error||"local bridge unavailable");
$("workspaceBig").textContent=cur.label||cur.id||"-";$("workspaceTopDetail").textContent=cur.root||"MCP 离线";
$("gitBig").textContent=git.available?(git.branch||"detached"):"-";$("gitTopDetail").textContent=git.available?(git.dirty?"有未提交修改":"clean"):"Git unavailable";
renderSlot("A",d.slots?.A);renderSlot("B",d.slots?.B);

const mcpProcess=(c.processes||[]).find(p=>p.Role==="MCP Server");
$("mcpStatusSummary").innerHTML=metric("BRIDGE",bridge.online?"ONLINE":"OFFLINE",bridge.online?"goodText":"badText")+metric("READY",h.ready?"READY":h.live?"LIVE":"OFFLINE",h.ready?"goodText":h.live?"warnText":"badText")+metric("PROFILE",m.profile||"-","")+metric("EXPOSED",ex.exposed?.length??0,"")+metric("SUPPRESSED",ex.suppressed?.length??0,(ex.suppressed?.length??0)?"warnText":"");
$("mcpBridgeState").innerHTML=dot(!!bridge.online,false)+esc(bridge.online?"ONLINE":"OFFLINE");
$("mcpProcessState").innerHTML=mcpProcess?(dot(true,false)+esc("RUNNING · PID "+mcpProcess.Id)):(dot(false,false)+"OFFLINE");
$("mcpStartedAt").textContent=dateTime(device.startedAt||b?.startedAt);
$("mcpProfileSource").textContent=m.profileSource||"-";
$("mcpDeviceId").textContent=device.deviceId||"-";
$("mcpRefreshedAt").textContent=dateTime(d.timestamp);
$("mcpStatusError").textContent=bridge.error||h.error||"-";
$("mcpStatusError").className="value small "+((bridge.error||h.error)?"badText":"muted");

$("workspaceName").textContent=cur.label||cur.id||"-";$("workspaceRoot").textContent=cur.root||"-";$("workspaceKind").textContent=cur.kind||"-";
$("workspacePlugins").innerHTML=(cur.plugins||[]).length?(cur.plugins||[]).map(x=>'<span class="pill">'+esc(x)+'</span>').join(""):'<span class="muted">默认允许已启用插件</span>';
const auth=cur.authorization||{};$("workspaceAuth").textContent=auth.structuredCrossWorkspace?("cross="+auth.structuredCrossWorkspace+" · external="+auth.externalPersistentWrite+" · shell="+auth.shellBoundary):"-";
const workspaceSelect=$("workspaceSelect"),pendingWorkspaceId=workspaceSelectionDirty?workspaceSelect.value:"";workspaceSelect.innerHTML=workspaces.map(x=>'<option value="'+esc(x.id)+'" '+(x.current?'selected':'')+'>'+esc((x.label||x.id)+"  ["+x.kind+"]")+'</option>').join("");if(workspaceSelectionDirty&&workspaces.some(x=>x.id===pendingWorkspaceId)){workspaceSelect.value=pendingWorkspaceId}else if(workspaceSelectionDirty){workspaceSelectionDirty=false}
$("workspaceList").innerHTML=workspaces.map(x=>'<div class="workspaceCard '+(x.current?'current':'')+'"><strong>'+esc(x.label||x.id)+'</strong> '+(x.current?'<span class="pill">CURRENT</span>':'')+'<div class="small muted mono">'+esc(x.root||"")+'</div><div class="small muted">'+esc(x.kind)+' · '+((x.plugins||[]).length?esc(x.plugins.join(", ")):"default plugins")+'</div></div>').join("")||'<div class="empty">MCP 离线</div>';
const slotA=d.slots?.A||{},slotB=d.slots?.B||{};
const slotSummary=s=>s.configured===false?"NOT CONFIGURED":s.connected?"ONLINE":s.health?.ready?"READY":"OFFLINE";
$("runtimeRows").innerHTML='<div class="row"><span>启动模式</span><strong>MANUAL · REPO LOCAL</strong></div><div class="row"><span>Runtime A</span><span>'+dot(!!slotA.connected,slotA.configured===false||!!slotA.health?.ready)+esc(slotSummary(slotA))+'</span></div><div class="row"><span>Runtime B</span><span>'+dot(!!slotB.connected,slotB.configured===false||!!slotB.health?.ready)+esc(slotSummary(slotB))+'</span></div><div class="row"><span>A Profile</span><span class="mono small">'+esc(slotA.tunnelAlias||"p05-a")+'</span></div><div class="row"><span>B Profile</span><span class="mono small">'+esc(slotB.tunnelAlias||"p05-b")+'</span></div>';
$("deviceRows").innerHTML='<div class="row"><span>主机</span><span>'+esc(device.hostname||"-")+'</span></div><div class="row"><span>P05 版本</span><span>'+esc(device.agentVersion||"-")+'</span></div><div class="row"><span>系统</span><span>'+esc((device.platform||"-")+" "+(device.release||"")+" "+(device.arch||""))+'</span></div><div class="row"><span>MCP started</span><span class="small">'+esc(dateTime(device.startedAt))+'</span></div>';
const ps=c.processes||[];$("processRows").innerHTML=ps.length?ps.map(p=>'<div class="row"><span><strong>'+esc(p.Role||p.ProcessName)+'</strong><div class="small muted">'+esc(p.ProcessName)+' · PID '+esc(p.Id)+'</div></span><span class="small">'+esc(dateTime(p.StartTime))+'</span></div>').join(""):'<div class="empty">未检测到 P05 相关进程</div>';

const live=b?.liveActivity||[];$("liveRows").innerHTML=live.map(e=>'<tr><td class="nowrap">'+esc(time(e.startedAt))+'</td><td>'+riskPill(e.risk)+'</td><td><strong>'+esc(e.capability)+'</strong></td><td class="detail">'+esc(e.detail||e.summary||"-")+'</td><td class="'+(e.state==="failed"?"badText":e.state==="succeeded"?"goodText":"warnText")+'">'+esc(e.state)+(e.phase&&e.state==="running"?' · '+esc(e.phase):'')+'</td><td>'+esc(e.scope||"-")+'</td><td>'+esc(e.durationMs!=null?e.durationMs+" ms":"-")+'</td></tr>').join("")||'<tr><td colspan="7" class="muted">暂无实时行为</td></tr>';

if(git.available){
  const ct=git.counts||{};$("gitSummary").innerHTML=metric("BRANCH",git.branch||"-","")+metric("AHEAD",git.ahead||0,git.ahead?"warnText":"")+metric("BEHIND",git.behind||0,git.behind?"warnText":"")+metric("STAGED",ct.staged||0,ct.staged?"warnText":"")+metric("MODIFIED",ct.modified||0,ct.modified?"warnText":"")+metric("UNTRACKED",ct.untracked||0,ct.untracked?"warnText":"")+metric("CONFLICT",ct.conflicted||0,ct.conflicted?"badText":"");
  const lc=git.lastCommit;$("gitCommit").textContent=lc?("最近 commit "+lc.hash+" · "+lc.author+" · "+lc.subject):"";
  $("gitFiles").innerHTML=(git.files||[]).map(f=>'<tr><td class="mono">'+esc(f.status)+'</td><td class="mono">'+esc(f.path)+'</td></tr>').join("")||'<tr><td colspan="2" class="goodText">工作区 clean</td></tr>';
  const ds=git.diffStat||{};$("gitDiffStat").textContent=["UNSTAGED",ds.unstaged||"(none)","","STAGED",ds.staged||"(none)"].join("\\n");
}else{$("gitSummary").innerHTML='<div class="empty">Git unavailable</div>';$("gitCommit").textContent="";$("gitFiles").innerHTML='<tr><td colspan="2" class="muted">-</td></tr>';$("gitDiffStat").textContent="-";}

const pl=b?.plugins||[];$("pluginRows").innerHTML='<h3>Plugins</h3>'+(pl.length?pl.map(p=>'<div class="row"><span><strong>'+esc(p.label||p.id)+'</strong><div class="small muted">'+esc(p.id)+' · '+esc(p.version||"")+'</div></span><span>'+dot(p.state==="running",p.state==="ready")+esc(p.state)+(p.activeForWorkspace?' <span class="pill">active</span>':'')+'</span></div>').join(""):'<div class="empty">无插件状态</div>');
const ds=b?.downstream||[];$("downstreamRows").innerHTML='<h3>Downstream MCP</h3>'+(ds.length?ds.map(x=>'<div class="row"><span><strong>'+esc(x.label||x.id)+'</strong><div class="small muted">'+esc(x.workspaceBinding||"")+(x.boundWorkspaceId?' · '+esc(x.boundWorkspaceId):'')+'</div></span><span>'+dot(!!x.connected,!!x.configured)+esc(x.connected?"connected":x.configured?"configured":"off")+'</span></div>').join(""):'<div class="empty">无 Downstream MCP</div>');

const audit=b?.activity||[];$("auditRows").innerHTML=audit.map(e=>'<tr><td class="nowrap">'+esc(time(e.startedAt))+'</td><td>'+esc(e.capability)+'</td><td class="'+(e.state==="failed"?"badText":e.state==="succeeded"?"goodText":"warnText")+'">'+esc(e.state)+'</td><td>'+esc(e.workspaceId)+'</td><td>'+esc(e.durationMs!=null?e.durationMs+" ms":"-")+'</td></tr>').join("")||'<tr><td colspan="5" class="muted">暂无 Audit</td></tr>';
const rec=b?.recovery||[];$("recoveryRows").innerHTML=rec.length?rec.map(e=>'<div class="row"><span><strong>'+esc(e.capability)+'</strong><div class="small muted">'+esc(time(e.startedAt))+' · '+esc(e.errorCategory||"failed")+'</div></span><span class="pill">'+esc(e.recoveryHint)+'</span></div>').join(""):'<div class="goodText small">当前没有待处理 Recovery</div>';

const caps=m.capabilities||[],exposed=new Set(ex.exposed||[]),groups={read:[],write:[],execute:[]};caps.forEach(x=>{if(exposed.has(x.name)){(groups[x.risk]||groups.read).push(x)}});
$("toolGroups").innerHTML=["read","write","execute"].map(r=>'<h3>'+r.toUpperCase()+' ('+groups[r].length+')</h3>'+groups[r].map(x=>'<span class="pill '+r+'" title="'+esc(x.summary)+'">'+esc(x.name)+'</span>').join("")).join("");
$("suppressedTools").innerHTML=(ex.suppressed||[]).map(x=>'<div class="row"><span class="mono">'+esc(x.tool)+'</span><span class="small muted">'+esc(x.reason)+'</span></div>').join("")||'<span class="goodText small">当前没有 suppressed tools</span>';
$("logs").textContent=(d.logTail||[]).join("\\n")||"暂无日志";
renderAction(d.operator);buttons();
}
async function refresh(){try{render(await api("/api/status"))}catch(e){toast("状态刷新失败: "+e.message,true)}}
$("closeOperator").onclick=async()=>{
  if(busy||!confirm("确认关闭 Operator Console？Runtime A/B 不会被自动关闭。"))return;
  busy=true;buttons();
  try{
    await api("/api/operator/shutdown",{method:"POST",body:"{}"});
    document.body.innerHTML='<main style="max-width:760px;padding:48px"><section class="card"><h2>Operator Console 已关闭</h2><div class="muted">Runtime A/B 保持各自当前状态。需要再次打开时，手动运行 open-operator.cmd。</div></section></main>';
  }catch(e){busy=false;toast(e.message,true);buttons()}
};
$("refresh").onclick=refresh;
$("workspaceSelect").onchange=()=>{workspaceSelectionDirty=true};
$("switchWorkspace").onclick=async()=>{if(busy)return;busy=true;buttons();try{const id=$("workspaceSelect").value;await api("/api/workspace/select",{method:"POST",body:JSON.stringify({id:id})});workspaceSelectionDirty=false;toast("Workspace 已切换为 "+id);await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
$("pickWorkspaceRoot").onclick=async()=>{if(busy)return;busy=true;buttons();try{const result=await api("/api/workspace/pick",{method:"POST",body:"{}"});if(result.selected&&result.path){$("workspaceRootInput").value=result.path;toast("已选择目录，点击“设为工作区”后生效")}else{toast("已取消选择")}}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
$("setWorkspaceRoot").onclick=async()=>{if(busy)return;const root=$("workspaceRootInput").value.trim();if(!root){toast("请输入绝对目录路径",true);return}busy=true;buttons();try{await api("/api/workspace/root",{method:"POST",body:JSON.stringify({root:root})});workspaceSelectionDirty=false;toast("MCP 工作目录已切换");$("workspaceRootInput").value="";await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
$("registerWorkspace").onclick=async()=>{if(busy)return;busy=true;buttons();try{const result=await api("/api/workspace/register",{method:"POST",body:"{}"});workspaceSelectionDirty=false;toast("Workspace 已保存："+(result.workspace?.label||result.workspace?.id||""));await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
function bindSlot(slot){
  const runSlotAction=async(actionName)=>{if(busy)return;busy=true;buttons();try{await api("/api/slot/"+slot+"/action/"+actionName,{method:"POST",body:"{}"});toast("Runtime "+slot+" "+({connect:"已连接",disconnect:"已断开",restart:"已重启"}[actionName]||actionName));await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
  $("slot"+slot+"Toggle").onclick=async()=>{
    const actionName=slotIsRunning(slot)?"disconnect":"connect";
    if(actionName==="disconnect"&&!confirm("确认关闭 Runtime "+slot+"？"))return;
    await runSlotAction(actionName);
  };
  $("slot"+slot+"Restart").onclick=()=>runSlotAction("restart");
  $("slot"+slot+"WorkspaceSelect").onchange=()=>{slotSelectionDirty[slot]=true};
  $("slot"+slot+"SwitchWorkspace").onclick=async()=>{if(busy)return;busy=true;buttons();try{const id=$("slot"+slot+"WorkspaceSelect").value;await api("/api/slot/"+slot+"/workspace/select",{method:"POST",body:JSON.stringify({id:id})});slotSelectionDirty[slot]=false;toast("Runtime "+slot+" Workspace 已切换为 "+id);await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
  $("slot"+slot+"PickWorkspace").onclick=async()=>{if(busy)return;busy=true;buttons();try{const result=await api("/api/slot/"+slot+"/workspace/pick",{method:"POST",body:"{}"});if(result.selected&&result.path){$("slot"+slot+"RootInput").value=result.path;toast("Runtime "+slot+" 已选择目录")}else{toast("已取消选择")}}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
  $("slot"+slot+"SetWorkspace").onclick=async()=>{if(busy)return;const root=$("slot"+slot+"RootInput").value.trim();if(!root){toast("请输入绝对目录路径",true);return}busy=true;buttons();try{await api("/api/slot/"+slot+"/workspace/root",{method:"POST",body:JSON.stringify({root:root})});slotSelectionDirty[slot]=false;$("slot"+slot+"RootInput").value="";toast("Runtime "+slot+" 工作区已切换");await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
  $("slot"+slot+"RegisterWorkspace").onclick=async()=>{if(busy)return;busy=true;buttons();try{const result=await api("/api/slot/"+slot+"/workspace/register",{method:"POST",body:"{}"});slotSelectionDirty[slot]=false;toast("Runtime "+slot+" Workspace 已保存："+(result.workspace?.label||result.workspace?.id||""));await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
}
bindSlot("A");bindSlot("B");
refresh();setInterval(refresh,2000);
</script>
</body></html>`;

export function operatorPage(csrfToken: string): string {
  return PAGE.replace("__CSRF_TOKEN__", JSON.stringify(csrfToken));
}
