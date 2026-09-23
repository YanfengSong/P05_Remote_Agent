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
  <section class="card span3"><div id="topALabel" class="label">Runtime A</div><div id="topAState" class="big">...</div><div id="topAStateDetail" class="small muted"></div></section>
  <section class="card span3"><div class="label">A Workspace / Git</div><div id="topAWorkspace" class="big">-</div><div id="topAGit" class="small muted"></div></section>
  <section class="card span3"><div id="topBLabel" class="label">Runtime B</div><div id="topBState" class="big">...</div><div id="topBStateDetail" class="small muted"></div></section>
  <section class="card span3"><div class="label">B Workspace / Git</div><div id="topBWorkspace" class="big">-</div><div id="topBGit" class="small muted"></div></section>

  <section class="card span6">
    <h2 id="slotATitle">Runtime A</h2>
    <div class="row"><span>状态</span><span id="slotAState">-</span></div>
    <div class="row"><span>Device ID</span><span id="slotADeviceId" class="value mono small">-</span></div>
    <div class="row"><span>当前 Workspace</span><strong id="slotAWorkspace">-</strong></div>
    <div class="row"><span>启动绑定</span><span id="slotABoundWorkspace" class="value mono small">-</span></div>
    <div class="row"><span>路径</span><span id="slotAWorkspaceRoot" class="value mono small">-</span></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button id="slotAToggle" class="primary">启动 A</button><button id="slotARestart" class="warning">重启 A</button></div>
    <h3>绑定 Workspace</h3>
    <div style="display:flex;gap:8px"><select id="slotAWorkspaceSelect"></select><button id="slotASwitchWorkspace" class="primary">切换</button></div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="slotARootInput" class="mono" placeholder="选择或输入要授权给该 Runtime 的工作目录" /><button id="slotAPickWorkspace">选择文件夹</button><button id="slotASetWorkspace" class="primary">设为工作区</button></div>
    <div style="margin-top:8px"><button id="slotARegisterWorkspace">保存当前 Workspace</button></div>
    <h3>参考目录（只读）</h3>
    <div id="slotAReferenceList"></div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="slotAReferenceInput" class="mono" placeholder="选择要授权给 Runtime A 的只读参考目录" /><button id="slotAPickReference">选择文件夹</button><button id="slotAAddReference" class="primary">添加参考目录</button></div>
    <div class="small muted" style="margin-top:6px">仅允许 reference_read / reference_list_directory；不授予写入、Git、Shell 或 MATLAB 操作权限。</div>
  </section>

  <section class="card span6">
    <h2 id="slotBTitle">Runtime B</h2>
    <div class="row"><span>状态</span><span id="slotBState">-</span></div>
    <div class="row"><span>Device ID</span><span id="slotBDeviceId" class="value mono small">-</span></div>
    <div class="row"><span>当前 Workspace</span><strong id="slotBWorkspace">-</strong></div>
    <div class="row"><span>启动绑定</span><span id="slotBBoundWorkspace" class="value mono small">-</span></div>
    <div class="row"><span>路径</span><span id="slotBWorkspaceRoot" class="value mono small">-</span></div>
    <div style="display:flex;gap:8px;margin-top:8px"><button id="slotBToggle" class="primary">启动 B</button><button id="slotBRestart" class="warning">重启 B</button></div>
    <h3>绑定 Workspace</h3>
    <div style="display:flex;gap:8px"><select id="slotBWorkspaceSelect"></select><button id="slotBSwitchWorkspace" class="primary">切换</button></div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="slotBRootInput" class="mono" placeholder="选择或输入要授权给该 Runtime 的工作目录" /><button id="slotBPickWorkspace">选择文件夹</button><button id="slotBSetWorkspace" class="primary">设为工作区</button></div>
    <div style="margin-top:8px"><button id="slotBRegisterWorkspace">保存当前 Workspace</button></div>
    <h3>参考目录（只读）</h3>
    <div id="slotBReferenceList"></div>
    <div style="display:flex;gap:8px;margin-top:8px"><input id="slotBReferenceInput" class="mono" placeholder="选择要授权给 Runtime B 的只读参考目录" /><button id="slotBPickReference">选择文件夹</button><button id="slotBAddReference" class="primary">添加参考目录</button></div>
    <div class="small muted" style="margin-top:6px">仅允许 reference_read / reference_list_directory；不授予写入、Git、Shell 或 MATLAB 操作权限。</div>
  </section>

  <section class="card span6">
    <h2>Runtime A · MCP 当前状态</h2>
    <div id="mcpAStatusSummary" class="summary"></div>
    <div class="row"><span>Control Bridge</span><span id="mcpABridgeState">-</span></div>
    <div class="row"><span>启动时间</span><span id="mcpAStartedAt" class="value small">-</span></div>
    <div class="row"><span>Profile 来源</span><span id="mcpAProfileSource" class="value">-</span></div>
    <div class="row"><span>Device ID</span><span id="mcpADeviceId" class="value mono small">-</span></div>
    <div class="row"><span>错误</span><span id="mcpAStatusError" class="value small">-</span></div>
  </section>

  <section class="card span6">
    <h2>Runtime B · MCP 当前状态</h2>
    <div id="mcpBStatusSummary" class="summary"></div>
    <div class="row"><span>Control Bridge</span><span id="mcpBBridgeState">-</span></div>
    <div class="row"><span>启动时间</span><span id="mcpBStartedAt" class="value small">-</span></div>
    <div class="row"><span>Profile 来源</span><span id="mcpBProfileSource" class="value">-</span></div>
    <div class="row"><span>Device ID</span><span id="mcpBDeviceId" class="value mono small">-</span></div>
    <div class="row"><span>错误</span><span id="mcpBStatusError" class="value small">-</span></div>
  </section>

  <section class="card span12">
    <h2>工具审批队列</h2>
    <div class="small muted" style="margin-bottom:8px">当工具调用被统一权限策略判定为 CONFIRM 时出现。批准只对同一 Runtime + Workspace + Tool + Operation + 输入生效一次，15 分钟过期。</div>
    <div id="approvalRows"></div>
  </section>

  <section class="card span12">
    <h2>Runtime / Host</h2>
    <div id="runtimeRows"></div>
    <h3>设备</h3><div id="deviceRows"></div>
    <h3>P05 相关进程</h3><div id="processRows" class="scroll"></div>
  </section>

  <section class="card span12">
    <h2>实时行为 Live Activity</h2>
    <div class="small muted" style="margin-bottom:8px">只保留内存中的脱敏详情；命令/路径可见，但敏感参数与正文不会持久化。</div>
    <div class="scroll"><table class="table">
      <thead><tr><th>时间</th><th>来源</th><th>风险</th><th>能力</th><th>正在做什么</th><th>状态</th><th>范围</th><th>耗时</th></tr></thead>
      <tbody id="liveRows"></tbody>
    </table></div>
  </section>

  <section class="card span6">
    <h2>Runtime A Git 工作区</h2>
    <div id="gitASummary" class="summary"></div>
    <div id="gitACommit" class="small muted"></div>
    <h3>文件变化</h3>
    <div class="scroll"><table class="table"><thead><tr><th>状态</th><th>文件</th></tr></thead><tbody id="gitAFiles"></tbody></table></div>
    <h3>Diff Stat</h3><pre id="gitADiffStat">-</pre>
  </section>

  <section class="card span6">
    <h2>Runtime B Git 工作区</h2>
    <div id="gitBSummary" class="summary"></div>
    <div id="gitBCommit" class="small muted"></div>
    <h3>文件变化</h3>
    <div class="scroll"><table class="table"><thead><tr><th>状态</th><th>文件</th></tr></thead><tbody id="gitBFiles"></tbody></table></div>
    <h3>Diff Stat</h3><pre id="gitBDiffStat">-</pre>
  </section>

  <section class="card span12">
    <h2>Plugins</h2>
    <div id="pluginRows"></div>
  </section>

  <section class="card span6">
    <h2>Runtime A · Downstream MCP</h2>
    <div id="downstreamARows"></div>
  </section>

  <section class="card span6">
    <h2>Runtime B · Downstream MCP</h2>
    <div id="downstreamBRows"></div>
  </section>

  <section class="card span8">
    <h2>持久 Audit</h2>
    <div class="scroll"><table class="table"><thead><tr><th>时间</th><th>来源</th><th>能力</th><th>状态</th><th>Workspace</th><th>耗时</th></tr></thead><tbody id="auditRows"></tbody></table></div>
  </section>

  <section class="card span4">
    <h2>Recovery / 错误</h2>
    <div id="recoveryRows" class="scroll"></div>
  </section>

  <section class="card span6">
    <h2>Runtime A · MCP Tool Surface</h2>
    <div id="toolAGroups"></div>
    <h3>未暴露 / Suppressed</h3><div id="suppressedATools"></div>
  </section>

  <section class="card span6">
    <h2>Runtime B · MCP Tool Surface</h2>
    <div id="toolBGroups"></div>
    <h3>未暴露 / Suppressed</h3><div id="suppressedBTools"></div>
  </section>

  <section class="card span6">
    <h2>Runtime A · Tunnel 最近日志</h2><pre id="logsA">-</pre>
  </section>

  <section class="card span6">
    <h2>Runtime B · Tunnel 最近日志</h2><pre id="logsB">-</pre>
  </section>
</div></main>
<div id="toast" class="toast"></div>

<script>
const TOKEN=__CSRF_TOKEN__;
let latest=null,busy=false,slotSelectionDirty={A:false,B:false};
const $=id=>document.getElementById(id);
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function asDate(v){if(!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d}
function time(v){const d=asDate(v);return d?d.toLocaleTimeString():"-"}
function dateTime(v){const d=asDate(v);return d?d.toLocaleString():"-"}
function dot(ok,warn){return '<span class="dot '+(ok?'good':warn?'warn':'bad')+'"></span>'}
function riskPill(r){return '<span class="pill '+esc(r)+'">'+esc(String(r||"").toUpperCase())+'</span>'}
function sourceLabel(e){
  const slot=e?.runtimeSlot==="A"||e?.runtimeSlot==="B"?e.runtimeSlot:"";
  let actor="";
  if(e?.source==="http-reviewer")actor=e.clientName||e.principal||"HTTP Reviewer";
  else if(e?.source==="operator")actor="Operator";
  else if(e?.source==="internal")actor="Internal";
  else actor=e?.clientName||"MCP";
  return {slot,actor,detail:[e?.source,e?.transport,e?.clientVersion].filter(Boolean).join(" · ")};
}
function sourceBadge(e){
  const x=sourceLabel(e);
  return '<span title="'+esc(x.detail)+'">'+(x.slot?'<span class="pill">'+esc(x.slot)+'</span> ':'')+'<span class="small">'+esc(x.actor)+'</span></span>';
}
function toast(msg,bad){const e=$("toast");e.textContent=msg;e.style.display="block";e.className="toast "+(bad?"badText":"");setTimeout(()=>e.style.display="none",3500)}
async function api(path,opts={}){const r=await fetch(path,{...opts,headers:{"x-p05-operator-token":TOKEN,"content-type":"application/json",...(opts.headers||{})},cache:"no-store"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||("HTTP "+r.status));return d}
function slotIsRunning(slot){
  const data=latest?.slots?.[slot]||{};
  return !!data?.connected||!!data?.health?.ready||!!data?.health?.live;
}
function buttons(){
  $("closeOperator").disabled=busy;
  for(const slot of ["A","B"]){
    const data=latest?.slots?.[slot]||{},online=!!data?.bridge?.online,currentId=data?.workspace?.current?.id||"",running=slotIsRunning(slot);
    const toggle=$("slot"+slot+"Toggle");
    toggle.disabled=busy;
    toggle.textContent=running?"关闭 "+slot:"启动 "+slot;
    toggle.className=running?"danger":"primary";
    $("slot"+slot+"Restart").disabled=busy||!running;
    $("slot"+slot+"SwitchWorkspace").disabled=busy||!online;
    $("slot"+slot+"PickWorkspace").disabled=busy;
    $("slot"+slot+"SetWorkspace").disabled=busy||!online;
    $("slot"+slot+"RegisterWorkspace").disabled=busy||!online||currentId!=="operator-session";
    $("slot"+slot+"PickReference").disabled=busy;
    $("slot"+slot+"AddReference").disabled=busy||!online;
  }
  if(document.querySelectorAll){
    document.querySelectorAll("[data-plugin-action]").forEach(btn=>{btn.disabled=busy||btn.dataset.locked==="true"});
    document.querySelectorAll("[data-reference-action]").forEach(btn=>{btn.disabled=busy});
    document.querySelectorAll("[data-approval-action]").forEach(btn=>{btn.disabled=busy});
  }
}
async function action(name){if(busy)return;busy=true;buttons();try{await api("/api/action/"+name,{method:"POST",body:"{}"});await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}}
function pluginForSlot(slot,id){return (latest?.slots?.[slot]?.plugins||[]).find(p=>p.id===id)}
function pluginSlotHtml(slot,id){
  const runtime=latest?.slots?.[slot]||{},p=pluginForSlot(slot,id);
  if(!runtime?.bridge?.online)return '<div class="small muted">'+slot+' · Runtime offline</div>';
  if(!p)return '<div class="small muted">'+slot+' · not installed</div>';
  const state=p.state||"unknown",running=state==="running",actionName=running?"stop":"start",locked=!p.enabled;
  const label=locked?"Disabled":running?"停止 "+slot:"启动 "+slot;
  const cls=running?"danger":"primary";
  return '<div style="display:flex;align-items:center;justify-content:flex-end;gap:7px;margin:3px 0"><span class="small">'+slot+' · '+dot(running,state==="ready")+esc(state)+(p.activeForWorkspace?' <span class="pill">active</span>':'')+'</span><button class="'+cls+'" data-plugin-action="true" data-locked="'+(locked?"true":"false")+'" '+(locked?'disabled':'')+' onclick="pluginControl(\\''+slot+'\\',\\''+esc(id)+'\\',\\''+actionName+'\\')">'+esc(label)+'</button></div>';
}
async function pluginControl(slot,id,actionName){
  if(busy)return;
  busy=true;buttons();
  try{
    await api("/api/slot/"+slot+"/plugin/"+encodeURIComponent(id)+"/action/"+actionName,{method:"POST",body:"{}"});
    toast("Plugin "+id+" · Runtime "+slot+" "+(actionName==="stop"?"已停止":"已启动"));
    await refresh();
  }catch(e){toast(e.message,true)}
  finally{busy=false;buttons()}
}
async function referenceRemove(slot,id){
  if(busy)return;
  if(!confirm("确认移除 Runtime "+slot+" 的只读参考目录授权？磁盘目录不会被删除。"))return;
  busy=true;buttons();
  try{
    await api("/api/slot/"+slot+"/reference/"+encodeURIComponent(id)+"/remove",{method:"POST",body:"{}"});
    toast("Runtime "+slot+" 已移除参考目录 "+id);
    await refresh();
  }catch(e){toast(e.message,true)}
  finally{busy=false;buttons()}
}
function toolApprovalFromButton(button){
  return toolApproval(button.dataset.slot,button.dataset.id,button.dataset.decision);
}
async function toolApproval(slot,id,actionName){
  if(busy)return;
  const item=(latest?.approvals||[]).find(x=>x.slot===slot&&x.approvalId===id);
  if(!item)return toast("审批请求已不存在或已过期",true);
  const verb=actionName==="approve"?"批准":"拒绝";
  const message=verb+"这一次工具调用？\\n\\n用途："+(item.purpose||"-")+"\\n触发审批："+(item.reason||"-")+"\\n\\nRuntime: "+slot+"\\nWorkspace: "+(item.workspaceId||"-")+"\\nTool: "+(item.capability||"-")+"\\nOperation: "+(item.operation||"-")+"\\n\\n调用内容：\\n"+(item.inputSummary||"(无额外输入)");
  if(!confirm(message))return;
  busy=true;buttons();
  try{
    await api("/api/approval/"+slot+"/"+encodeURIComponent(id)+"/"+actionName,{method:"POST",body:"{}"});
    toast("工具请求已"+verb+"。"+(actionName==="approve"?"请让远程端重试完全相同的工具调用。":""));
    await refresh();
  }catch(e){toast(e.message,true)}
  finally{busy=false;buttons()}
}
function renderAction(op){const a=op?.action,e=$("actionBanner");if(!a){e.style.display="none";return}e.style.display="block";const map={connect:"连接",disconnect:"断开",restart:"重启"};let cls="warnText",txt=(map[a.action]||a.action)+"：";if(a.state==="waiting"){txt+="进行中…";cls="warnText"}else if(a.state==="succeeded"){txt+=a.message||"完成";cls="goodText"}else{txt+=a.error||"失败";cls="badText"}e.className=cls;e.textContent=txt+"  "+dateTime(a.requestedAt)}
function metric(label,value,cls){return '<div class="metric"><span class="label">'+esc(label)+'</span><strong class="'+(cls||"")+'">'+esc(value)+'</strong></div>'}
function renderSlot(slot,data){
  data=data||{};
  const online=!!data?.bridge?.online,health=data?.health||{},current=data?.workspace?.current||{},workspaces=data?.workspace?.all||[],device=data?.device||{};
  $("slot"+slot+"Title").textContent="Runtime "+slot+" · "+(data.connector||"@Runtime-"+slot);
  const stateText=data.connected?"ONLINE":health.ready?"READY · 等待插件唤醒":health.live?"LIVE":"OFFLINE";
  $("slot"+slot+"State").innerHTML=dot(!!data.connected,!!health.live)+esc(stateText);
  $("slot"+slot+"DeviceId").textContent=device.deviceId||"-";
  $("slot"+slot+"Workspace").textContent=current.label||current.id||"-";
  $("slot"+slot+"BoundWorkspace").textContent=data.boundWorkspaceId||"-";
  $("slot"+slot+"WorkspaceRoot").textContent=current.root||"-";
  const references=data.references||[];
  $("slot"+slot+"ReferenceList").innerHTML=references.length?references.map(r=>'<div class="row"><span><strong>'+esc(r.label||r.id)+'</strong><div class="small muted mono">'+esc(r.root||"")+'</div></span><button class="danger" data-reference-action="true" onclick="referenceRemove(\\''+slot+'\\',\\''+esc(r.id)+'\\')">移除</button></div>').join(""):'<div class="empty">暂无参考目录</div>';
  const select=$("slot"+slot+"WorkspaceSelect"),pending=slotSelectionDirty[slot]?select.value:"";
  select.innerHTML=workspaces.map(x=>'<option value="'+esc(x.id)+'" '+(x.current?'selected':'')+'>'+esc((x.label||x.id)+"  ["+(x.kind||"-")+"]")+'</option>').join("");
  if(slotSelectionDirty[slot]&&workspaces.some(x=>x.id===pending)){select.value=pending}else if(slotSelectionDirty[slot]){slotSelectionDirty[slot]=false}
}
function render(d){
latest=d;const c=d.connection||{},slotA=d.slots?.A||{},slotB=d.slots?.B||{},device=slotA.device||slotB.device||{};
function topRuntime(slot,label){
  const running=!!slot?.connected,ready=!!slot?.health?.ready,live=!!slot?.health?.live;
  $(label+"Label").textContent="Runtime "+(label==="topA"?"A":"B")+" · "+(slot?.connector||"-");
  const state=running?"ONLINE":ready?"READY":live?"LIVE":"OFFLINE";
  $(label+"State").innerHTML=dot(running,ready||live)+esc(state);
  $(label+"StateDetail").textContent=(slot?.connector||"-")+" · "+(slot?.bridge?.online?"bridge online":"bridge offline");
  const ws=slot?.workspace?.current||{},g=slot?.git||{};
  $(label+"Workspace").textContent=ws.label||ws.id||"-";
  $(label+"Git").textContent=g.available
    ? ((g.branch||"detached")+" · "+(g.dirty?"有未提交修改":"clean"))
    : "Git unavailable";
}
topRuntime(slotA,"topA");
topRuntime(slotB,"topB");
renderSlot("A",slotA);renderSlot("B",slotB);

function renderMcpPanel(prefix,slot){
  const bridge=slot?.bridge||{},health=slot?.health||{},m=slot?.mcp||{},ex=m.exposure||{},device=slot?.device||{};
  $(prefix+"StatusSummary").innerHTML=
    metric("BRIDGE",bridge.online?"ONLINE":"OFFLINE",bridge.online?"goodText":"badText")+
    metric("READY",health.ready?"READY":health.live?"LIVE":"OFFLINE",health.ready?"goodText":health.live?"warnText":"badText")+
    metric("PROFILE",m.profile||"-","")+
    metric("EXPOSED",ex.exposed?.length??0,"")+
    metric("SUPPRESSED",ex.suppressed?.length??0,(ex.suppressed?.length??0)?"warnText":"");
  $(prefix+"BridgeState").innerHTML=dot(!!bridge.online,false)+esc(bridge.online?"ONLINE":"OFFLINE");
  $(prefix+"StartedAt").textContent=dateTime(device.startedAt);
  $(prefix+"ProfileSource").textContent=m.profileSource||"-";
  $(prefix+"DeviceId").textContent=device.deviceId||"-";
  const err=bridge.error||health.error||"";
  $(prefix+"StatusError").textContent=err||"-";
  $(prefix+"StatusError").className="value small "+(err?"badText":"muted");
}
renderMcpPanel("mcpA",slotA);
renderMcpPanel("mcpB",slotB);

$("runtimeRows").innerHTML='<div class="row"><span>启动模式</span><strong>MANUAL · REPO LOCAL</strong></div><div class="row"><span>Runtime A</span><span>'+dot(!!slotA.connected,!!slotA.health?.ready)+esc(slotA.connected?"ONLINE":slotA.health?.ready?"READY":"OFFLINE")+'</span></div><div class="row"><span>Runtime B</span><span>'+dot(!!slotB.connected,!!slotB.health?.ready)+esc(slotB.connected?"ONLINE":slotB.health?.ready?"READY":"OFFLINE")+'</span></div><div class="row"><span>A Profile</span><span class="mono small">'+esc(slotA.tunnelAlias||"p05-a")+'</span></div><div class="row"><span>B Profile</span><span class="mono small">'+esc(slotB.tunnelAlias||"p05-b")+'</span></div>';
$("deviceRows").innerHTML='<div class="row"><span>主机</span><span>'+esc(device.hostname||"-")+'</span></div><div class="row"><span>P05 版本</span><span>'+esc(device.agentVersion||"-")+'</span></div><div class="row"><span>系统</span><span>'+esc((device.platform||"-")+" "+(device.release||"")+" "+(device.arch||""))+'</span></div>';
const ps=c.processes||[];$("processRows").innerHTML=ps.length?ps.map(p=>'<div class="row"><span><strong>'+esc(p.Role||p.ProcessName)+'</strong><div class="small muted">'+esc(p.ProcessName)+' · PID '+esc(p.Id)+'</div></span><span class="small">'+esc(dateTime(p.StartTime))+'</span></div>').join(""):'<div class="empty">未检测到 P05 相关进程</div>';

const approvals=d.approvals||[];
$("approvalRows").innerHTML=approvals.length?approvals.map(a=>{
  const pending=a.status==="pending";
  const stateClass=a.status==="approved"?"goodText":a.status==="denied"?"badText":"warnText";
  const actions=pending
    ? '<span><button class="primary" data-approval-action="true" data-slot="'+esc(a.slot)+'" data-id="'+esc(a.approvalId)+'" data-decision="approve" onclick="toolApprovalFromButton(this)">批准一次</button> <button class="danger" data-approval-action="true" data-slot="'+esc(a.slot)+'" data-id="'+esc(a.approvalId)+'" data-decision="deny" onclick="toolApprovalFromButton(this)">拒绝</button></span>'
    : '<span class="'+stateClass+'">'+esc(String(a.status||"").toUpperCase())+'</span>';
  return '<div class="workspaceCard"><div class="row"><span><strong>Runtime '+esc(a.slot)+' · '+esc(a.workspaceId||"-")+'</strong><div class="small mono"><strong>Tool：</strong>'+esc(a.capability||"-")+' · '+esc(a.operation||"-")+'</div><div class="small"><strong>用途：</strong>'+esc(a.purpose||"无法可靠解释，请谨慎判断。")+'</div><div class="small muted"><strong>触发审批：</strong>'+esc(a.reason||"-")+'</div></span>'+actions+'</div><div class="small muted" style="margin-top:7px">调用内容</div><pre>'+esc(a.inputSummary||"(无额外输入)")+'</pre><div class="small muted">请求 '+esc(dateTime(a.requestedAt))+' · 过期 '+esc(dateTime(a.expiresAt))+'</div></div>';
}).join(""):'<div class="goodText small">当前没有待审批工具请求</div>';

const live=d.liveActivity||[];$("liveRows").innerHTML=live.map(e=>'<tr><td class="nowrap">'+esc(time(e.startedAt))+'</td><td class="nowrap">'+sourceBadge(e)+'</td><td>'+riskPill(e.risk)+'</td><td><strong>'+esc(e.capability)+'</strong></td><td class="detail">'+esc(e.detail||e.summary||"-")+'</td><td class="'+(e.state==="failed"?"badText":e.state==="succeeded"?"goodText":"warnText")+'">'+esc(e.state)+(e.phase&&e.state==="running"?' · '+esc(e.phase):'')+'</td><td>'+esc(e.scope||"-")+'</td><td>'+esc(e.durationMs!=null?e.durationMs+" ms":"-")+'</td></tr>').join("")||'<tr><td colspan="8" class="muted">暂无实时行为</td></tr>';

function renderGitPanel(prefix,g){
  if(g?.available){
    const ct=g.counts||{};
    $(prefix+"Summary").innerHTML=
      metric("BRANCH",g.branch||"-","")+
      metric("AHEAD",g.ahead||0,g.ahead?"warnText":"")+
      metric("BEHIND",g.behind||0,g.behind?"warnText":"")+
      metric("STAGED",ct.staged||0,ct.staged?"warnText":"")+
      metric("MODIFIED",ct.modified||0,ct.modified?"warnText":"")+
      metric("UNTRACKED",ct.untracked||0,ct.untracked?"warnText":"")+
      metric("CONFLICT",ct.conflicted||0,ct.conflicted?"badText":"");
    const lc=g.lastCommit;
    $(prefix+"Commit").textContent=lc?("最近 commit "+lc.hash+" · "+lc.author+" · "+lc.subject):"";
    $(prefix+"Files").innerHTML=(g.files||[]).map(f=>'<tr><td class="mono">'+esc(f.status)+'</td><td class="mono">'+esc(f.path)+'</td></tr>').join("")||'<tr><td colspan="2" class="goodText">工作区 clean</td></tr>';
    const ds=g.diffStat||{};
    $(prefix+"DiffStat").textContent=["UNSTAGED",ds.unstaged||"(none)","","STAGED",ds.staged||"(none)"].join("\\n");
  }else{
    $(prefix+"Summary").innerHTML='<div class="empty">Git unavailable</div>';
    $(prefix+"Commit").textContent="";
    $(prefix+"Files").innerHTML='<tr><td colspan="2" class="muted">-</td></tr>';
    $(prefix+"DiffStat").textContent="-";
  }
}
renderGitPanel("gitA",slotA.git||{});
renderGitPanel("gitB",slotB.git||{});

const slotPluginLists={A:d.slots?.A?.plugins||[],B:d.slots?.B?.plugins||[]},pluginMap=new Map();
for(const slot of ["A","B"]){for(const p of slotPluginLists[slot]){if(!pluginMap.has(p.id))pluginMap.set(p.id,p)}}
const pl=[...pluginMap.values()];
$("pluginRows").innerHTML='<h3>Plugins</h3>'+(pl.length?pl.map(p=>'<div class="row"><span><strong>'+esc(p.label||p.id)+'</strong><div class="small muted">'+esc(p.id)+' · '+esc(p.version||"")+'</div></span><span class="value">'+pluginSlotHtml("A",p.id)+pluginSlotHtml("B",p.id)+'</span></div>').join(""):'<div class="empty">无插件状态</div>');
function downstreamUiState(x){
  if(x?.enabled===false)return {label:"DISABLED",good:false,warn:false,hint:"已禁用"};
  if(!x?.available||!x?.configured)return {label:"UNAVAILABLE",good:false,warn:false,hint:x?.lastError||"未配置或当前不可用"};
  if(x?.connected)return {label:"CONNECTED",good:true,warn:false,hint:"当前已有活跃连接"};
  return {label:"READY",good:false,warn:true,hint:"Lazy connect · 首次调用时自动连接"};
}
function renderDownstream(prefix,slot){
  const ds=slot?.downstream||[];
  $(prefix+"Rows").innerHTML='<div class="small muted" style="margin-bottom:6px">READY 表示配置可用但尚未建立活跃连接；首次调用会自动连接。</div>'+
    (ds.length?ds.map(x=>{const st=downstreamUiState(x);return '<div class="row"><span><strong>'+esc(x.label||x.id)+'</strong><div class="small muted">'+esc(x.workspaceBinding||"")+(x.boundWorkspaceId?' · '+esc(x.boundWorkspaceId):'')+'</div><div class="small muted">'+esc(st.hint)+'</div></span><span>'+dot(st.good,st.warn)+esc(st.label)+'</span></div>'}).join(""):'<div class="empty">无 Downstream MCP</div>');
}
renderDownstream("downstreamA",slotA);
renderDownstream("downstreamB",slotB);

const audit=d.activity||[];$("auditRows").innerHTML=audit.map(e=>'<tr><td class="nowrap">'+esc(time(e.startedAt))+'</td><td class="nowrap">'+sourceBadge(e)+'</td><td>'+esc(e.capability)+'</td><td class="'+(e.state==="failed"?"badText":e.state==="succeeded"?"goodText":"warnText")+'">'+esc(e.state)+'</td><td>'+esc(e.workspaceId)+'</td><td>'+esc(e.durationMs!=null?e.durationMs+" ms":"-")+'</td></tr>').join("")||'<tr><td colspan="6" class="muted">暂无 Audit</td></tr>';
const rec=d.recovery||[];$("recoveryRows").innerHTML=rec.length?rec.map(e=>'<div class="row"><span><strong>'+esc(e.capability)+'</strong><div class="small muted">'+sourceBadge(e)+' · '+esc(time(e.startedAt))+' · '+esc(e.errorCategory||"failed")+'</div></span><span class="pill">'+esc(e.recoveryHint)+'</span></div>').join(""):'<div class="goodText small">当前没有待处理 Recovery</div>';

function renderToolSurface(slotKey,slot){
  const m=slot?.mcp||{},ex=m.exposure||{},caps=m.capabilities||[],exposed=new Set(ex.exposed||[]),groups={read:[],write:[],execute:[]};
  caps.forEach(x=>{if(exposed.has(x.name)){(groups[x.risk]||groups.read).push(x)}});
  $("tool"+slotKey+"Groups").innerHTML=["read","write","execute"].map(r=>'<h3>'+r.toUpperCase()+' ('+groups[r].length+')</h3>'+groups[r].map(x=>'<span class="pill '+r+'" title="'+esc(x.summary)+'">'+esc(x.name)+'</span>').join("")).join("");
  $("suppressed"+slotKey+"Tools").innerHTML=(ex.suppressed||[]).map(x=>'<div class="row"><span class="mono">'+esc(x.tool)+'</span><span class="small muted">'+esc(x.reason)+'</span></div>').join("")||'<span class="goodText small">当前没有 suppressed tools</span>';
}
renderToolSurface("A",slotA);
renderToolSurface("B",slotB);
$("logsA").textContent=(slotA.logTail||[]).join("\\n")||"暂无日志";
$("logsB").textContent=(slotB.logTail||[]).join("\\n")||"暂无日志";
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
  $("slot"+slot+"PickReference").onclick=async()=>{if(busy)return;busy=true;buttons();try{const result=await api("/api/slot/"+slot+"/reference/pick",{method:"POST",body:"{}"});if(result.selected&&result.path){$("slot"+slot+"ReferenceInput").value=result.path;toast("Runtime "+slot+" 已选择只读参考目录")}else{toast("已取消选择")}}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
  $("slot"+slot+"AddReference").onclick=async()=>{if(busy)return;const root=$("slot"+slot+"ReferenceInput").value.trim();if(!root){toast("请选择参考目录",true);return}busy=true;buttons();try{const result=await api("/api/slot/"+slot+"/reference/root",{method:"POST",body:JSON.stringify({root:root})});$("slot"+slot+"ReferenceInput").value="";toast("Runtime "+slot+" 已添加只读参考目录："+(result.reference?.label||result.reference?.id||""));await refresh()}catch(e){toast(e.message,true)}finally{busy=false;buttons()}};
}
bindSlot("A");bindSlot("B");
refresh();setInterval(refresh,2000);
</script>
</body></html>`;

export function operatorPage(csrfToken: string): string {
  return PAGE.replace("__CSRF_TOKEN__", JSON.stringify(csrfToken));
}
