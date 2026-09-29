# P05 Optimization Backlog

## 记录目的

本文记录 P05 一键部署过程中发现的问题，以及后续版本需要优化的方向。

本次验证目标：新电脑通过 Bootstrap 完成部署，并自动连接 ChatGPT / OpenAI Tunnel。

---

## 1. 一键部署环境依赖检查优化

### 当前问题

部署过程中依赖环境存在人工确认步骤：

- Node.js
- npm
- Git
- 网络环境
- 系统代理
- Runtime 运行条件

当前 Bootstrap 可以完成部分初始化，但缺少完整环境闭环检查。

### 优化目标

一键安装需要具备环境自检能力：

1. 自动检查所有必要依赖。
2. 缺少依赖时自动执行安装脚本。
3. 安装完成后重新验证版本和可用性。
4. 失败时输出明确修复建议。

目标流程：

```
Bootstrap
    ↓
Environment Check
    ↓
Missing Dependency Detection
    ↓
Automatic Installation
    ↓
Environment Validation
    ↓
P05 Startup
```

---

## 2. 网络代理自动配置

### 当前问题

本次部署中 Runtime 和 Tunnel 已启动，但 Tunnel 无法连接 OpenAI Control Plane。

原因：机器存在代理需求，但 `.env` 中代理配置默认注释，没有自动启用。

### 优化目标

Bootstrap 增加网络适配能力：

- 自动检测系统代理。
- 自动检测常见代理软件配置。
- 自动生成 `.env` 网络配置。
- 启动 Tunnel 时确保代理环境继承。

建议增加：

```
P05_NETWORK_MODE=auto
P05_PROXY=
```

---

## 3. 部署健康检查

### 当前问题

Operator Console 可以启动，但无法快速判断 Runtime、Tunnel、MCP 哪一层异常。

### 优化目标

增加统一 Health Report：

检查：

- 环境依赖
- Runtime A/B
- Tunnel 状态
- MCP Gateway
- ChatGPT 连接状态

输出统一状态：

```
Environment   PASS
Runtime-A     PASS
Runtime-B     PASS
Tunnel        PASS
MCP           PASS
```

---

## 4. 状态中心

### 当前问题

当前日志分散：

- runtime 状态
- tunnel 日志
- operator 日志

排查需要人工分析。

### 优化目标

增加统一状态文件，例如：

```
.p05/status.json
```

记录：

- 当前设备状态
- Runtime 状态
- Tunnel 状态
- 插件状态
- 最近错误

---

## 5. 自动诊断工具

### 当前问题

故障定位依赖人工查看日志。

### 优化目标

增加：

```
p05 doctor
```

自动检查：

- 环境
- 网络
- 权限
- 配置
- Runtime
- Tunnel
- MCP

并提供修复建议。

---

## 版本规划建议

| 优先级 | 项目 | 目标 |
| --- | --- | --- |
| P0 | Bootstrap 环境检测 | 新电脑自动准备环境 |
| P0 | 自动依赖安装 | 缺少组件自动安装 |
| P0 | 网络代理适配 | 自动连接 Control Plane |
| P1 | Health Report | 快速定位部署问题 |
| P1 | Status Center | 统一运行状态 |
| P2 | Doctor 工具 | 自动诊断和恢复 |
