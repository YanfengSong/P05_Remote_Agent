# Optional Component Host 本地配置与边界

此 Host 在独立 Node 进程运行已安装的可信组件，复用 `CompositionRuntime` 与 `AssetStore`。不要在 Core 进程内直接调用 `startComponentHost`；Core 应连接它的 loopback RPC。组件死循环会阻塞 Optional Host，自身不会占用 Core 的事件循环。

这是 **可信本地插件模式**，不是 OS 沙箱。插件仍具有当前 OS 用户的 Node、文件、网络和进程权限，也能绕过 SDK 直接产生副作用。manifest、capability 的 effect 是安装方审核后的声明，不是对 JavaScript 行为的证明。相同 OS 用户、管理员和可信插件可读取或篡改本机状态。只接纳经过审查的模块。独立进程仅提供崩溃、事件循环和生命周期边界。

## 启动与目录

先由本机管理员创建只允许当前用户、SYSTEM、Administrators 访问的目录。Linux/macOS 使用当前用户所有、目录 `0700` / 文件 `0600`。Host 只检查 ACL/owner，不修改权限、不创建系统账户。

配置文件所在目录、`stateDir`、`installationRoot` 必须已经存在并通过真实 ACL 检查；状态与安装目录必须和 Workspace 分离。路径使用绝对路径。安装树不允许符号链接/reparse point。文件先 `realpath`，再确认位于安装根且不在 Workspace，最后校验 SHA256。配置最大 256 KiB，单模块最大 1 MiB，资产最大 8 MiB。

```powershell
$env:P05_V3_COMPONENT_CONFIG = 'C:\PrivateP05\components\host.json'
node dist/v3-component-host.js
```

成功后 stderr 输出 `p05.v3.component.ready`，私有状态目录写入 `component-host.json`，包含 endpoint、固定 owner、bindingDigest 和 token 文件路径。client token 交给同 Slot 的可信 Core；operator token 只供本地管理。两种 token 都不能交给 Edge/Agent。

```json
{
  "version": 1,
  "slotId": "development",
  "principalId": "local-operator",
  "workspaceRoot": "D:\\Project",
  "stateDir": "C:\\PrivateP05\\components\\state",
  "installationRoot": "C:\\PrivateP05\\components\\installed",
  "port": 0,
  "installations": [{
    "installationId": "greeting-v1",
    "file": "C:\\PrivateP05\\components\\installed\\greeting-v1.mjs",
    "manifest": {
      "componentId": "greeting",
      "revision": "1",
      "entrypointDigest": "REPLACE_WITH_64_LOWERCASE_SHA256_HEX",
      "configVersion": "1",
      "scope": "workspace",
      "hostCompatibility": ["win32", "linux", "darwin"],
      "provides": [{ "key": { "name": "greeting.read", "version": "1" }, "kind": "single" }],
      "requires": [],
      "effectOwnership": [],
      "activationPolicy": "desired"
    }
  }],
  "components": [{ "componentId": "greeting", "installationId": "greeting-v1", "config": { "prefix": "Hello " } }],
  "capabilities": [{
    "capabilityId": "greeting-read", "componentId": "greeting",
    "key": { "name": "greeting.read", "version": "1" },
    "effect": "E0", "description": "Read a configured greeting"
  }],
  "assets": []
}
```

`entrypointDigest` 使用模块文件原始字节的 SHA256，例如 `(Get-FileHash -LiteralPath '...greeting-v1.mjs' -Algorithm SHA256).Hash.ToLowerInvariant()`。不把摘要写进模块自身，避免自引用摘要。最大 64 个 installation、32 个 component、64 个 capability 和 64 个资产版本；当前独立 Host 仅装配 workspace scope。

## 已安装模块协议

模块必须导出 `createComponent({z})`，返回 `configSchema` 和 `activate(context,config)`。manifest 来自受保护配置，不接受模块覆盖。使用 Host 提供的 Zod 实例。加载的是通过摘要验证的原始字节，通过 data URL 导入；因此模块须为单文件 bundle，不能使用相对导入。Node 内建导入可用。包解析、动态依赖和模块顶层行为均属于可信安装代码责任，不宣称依赖链被入口摘要完整签名。审核时要求模块顶层与 factory 无副作用：manualHold 阻止 activate，但为校验配置仍会导入模块并调用 factory。

```javascript
export function createComponent({ z }) {
  return {
    configSchema: z.object({ prefix: z.string() }).strict(),
    activate(context, config) {
      context.provide({ name: 'greeting.read', version: '1' }, {
        inputSchema: z.object({ name: z.string().max(100) }).strict(),
        invoke(input, owner) {
          return { greeting: config.prefix + input.name, slotId: owner.slotId };
        }
      });
    }
  };
}
```

声明的 single service 必须实现 `{inputSchema, invoke(input,context)}`。input 按 schema 校验并冻结；context 固定为 `{slotId,principalId,workspaceRoot,capabilityId,effect,runId?}`。`runId` 仅是来自可信 Core 的审计关联字段，不证明 Run 存在、不授予额外权限。

E1 定时器、监听器应通过 ComponentContext 注册，retire 后按 pin drain 逆序清理。E2/E3/E4 必须通过外部受控管理器；此 Host 未连接 Core gateway，`context.external()` 一律返回 `EXTERNAL_EFFECT_MANAGER_UNAVAILABLE`。E1 也不是“只读”的同义词；Core 当前只应允许显式本地 allowlist 中的 E0 capability。

## RPC 与 Core bridge

调用现有 `createRpcClient({url,token})`。所有方法 body 严格校验，不接受额外的 owner、角色、effect、模块路径或安装内容。业务失败为 `{error:{code}}`，Core 必须先检查该字段；传输错误由 RpcClient 抛出。

| 方法 | 角色 | 输入与含义 |
| --- | --- | --- |
| `component_status` | client/operator | `{}`；返回固定 owner、bindingDigest、capabilities、组件状态 |
| `component_call` | client/operator | `{capabilityId,input,runId?,expectedBindingId?}`；只解析配置允许的 single service |
| `component_replace` | operator | `{componentId,installationId,config,expectedRevision}`；只选启动时已登记的安装版本 |
| `component_desired` | operator | `{componentId,enabled,manualHold,expectedRevision}`；持久配置状态后 reconcile |
| `component_drain` | operator | `{bindingId,timeoutMs?}`，最多 5000 ms；查询旧 binding 实际 drain |
| `asset_activate` | operator | `{assetId,revision,expectedDigest}`；只激活本地配置中审核过的准确摘要 |

`component_status.capabilities` 含 `{capabilityId,componentId,key,effect,description,bindingId}`。未激活的 bindingId 为 null。Core bridge 应核对固定 Slot/principal/Workspace 和 bindingDigest，应用本机显式 allowlist，只将声明 E0 的能力注册为 read；提交时记录 bindingId，执行时传 `expectedBindingId`。Host pin 后、invoke 前比较，发生热替换或进程重启则返回 `BINDING_CHANGED`，不会调用新 provider。Core 据此重新发现和验证，不能自动对新 binding 重试已授权旧请求。

bindingDigest 绑定 owner 和 capability 声明；bindingId 绑定运行期具体 provider。前者不是代码证明，后者每次激活和重启改变。成功调用返回 `{capabilityId,effect,bindingId,bindingDigest,result}`。Host 不把任意 plugin result 当成可信权限或授权指令。

配置没有内建 capability；E0 列表来自 `component_status.capabilities.filter(c => c.effect === 'E0')`。上面示例唯一 E0 为 `greeting-read`。加入新模块须先在本地安装文件、更新受保护配置并重启 Host；RPC 不提供上传、安装、路径选择或任意代码执行接口。

## 热替换与恢复

replacement 先校验 installation 摘要、manifest、config 和依赖图，再激活候选；成功后原子保存新 definition 身份、配置和 desired revision，发布新 binding。旧请求持有旧 provider 的 pin，新请求取得新 provider。旧 provider 等 pin 归零后执行 disposer。激活失败保留旧 provider；不声称 E2+ 外部变化会被 rollback。

持久 SQLite 保存被选中的准确 revision/digest/configVersion/config/manualHold。重启时从本地 catalog 找到匹配安装项；缺失则启动失败，不悄悄退回初始版本。保持旧版本的安装项直至不再需要恢复。Host 持有独立 SQLite EXCLUSIVE OS 锁，同目录第二进程被拒绝，不获取或影响 Core 锁。

为限制运行期 fiber 历史大小，每个 Host 进程最多接受 256 次 replace/desired 操作尝试；之后返回 `COMPONENT_HOST_RESTART_REQUIRED`，已运行服务继续工作。重启重新加载持久当前状态。RPC 并发上限 32，断开连接或客户端 timeout 不取消已接受调用，也不会提前释放 pin。

关闭先停止 RPC 接入、等待在途 handler，再 drain fiber。恶意/卡死插件或永不完成的 handler 可能使 Host 无法优雅退出；Core/本地 supervisor 应设置连接与退出预算，必要时终止 **Optional Host 进程**，保持 Core 可用。终止进程不证明其自行创建的外部进程/硬件操作已撤销，且不会自动重放 E2+。

## 本地资产

可在 `assets` 添加 `{assetId,revision,file,digest,evidenceRef,operatorReviewed:true,effects}`。file 必须在私有 installationRoot 内；digest 由本地审核者计算。Host 将精确字节登记为 draft，并以受保护配置中的审核声明作为证据转为 VERIFIED；这代表本地 operator 审核声明与内容一致，不是自动语义正确性验证。`asset_activate` 再显式激活，旧 ACTIVE revision 被弃用；内容与状态可恢复，不执行资产代码。

## 验证

`node dist/test/v3-component-host.js` 使用全新临时私有 ACL 目录与真实子进程，验证身份防伪、client/operator 分权、摘要/Workspace 拒绝、E2 网关拒绝、OS owner 锁、在途 pin 热替换、stale binding 拒绝、失败候选保留旧版本、配置/manualHold 重启恢复，以及插件死循环时独立 Core probe 仍成功。测试仅对临时目录设置权限，不操作用户服务、MATLAB 或硬件。
