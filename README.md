# SaveMyWallet

SaveMyWallet 是面向 Windows 和 Android 的离线月度还款账本。把京东白条、花呗分期、B 站周边预计补款和临时还款记到对应月份，就能看到每个平台要还多少、哪些已经还过，以及下个月发薪后预计能剩多少。

## 当前客户端版本 · 0.4.8

- **月度清单**按还款月份和平台合并多笔账单，可展开明细、勾选已还或撤销。输错的明细可作废，分期可以选本期或整笔。作废保留记录，恢复后按原还款状态重新计入。平台可以自行添加，预计补款可在金额和月份确定后确认。
- **结余预警**用当月工资减去整月应还，支持默认工资和单月覆盖。已还款和待确认补款都计入整月应还。勾选还款只减少仍待还金额。预计结余低于自设警告线时会显示预警。
- **本地账本**保存在各设备的 SQLite 数据库中。系统设置支持简体中文和英文、JSON 备份迁移及输入 `重置` 后清空本机账本。需要 Windows 和安卓自动交换修改时，可连接同一个 PostgreSQL 账本服务，在客户端处理补款金额或月份冲突。[后端启动与设备绑定](backend/README.md)

## 仓库目录

| 目录 | 职责 | 当前状态 |
| --- | --- | --- |
| [frontend/](frontend/README.md) | 共用的 Vue + TypeScript 界面、Tauri 2 原生应用、SQLite、测试和打包脚本 | 可运行，可构建 Windows 和 Android 安装包 |
| [backend/](backend/README.md) | ASP.NET Core 10、EF Core 和 PostgreSQL 账本服务 | 提供账本读写、离线上传去重及增量同步 |
| [wasm-lib/](wasm-lib/README.md) | 可独立构建的 .NET 10 WebAssembly 模板 | 以月度汇总为例，演示从 JavaScript 调用 C# 并验证结果 |
| [docs/](docs/) | 跨模块开发指南、里程碑和实施计划 | 客户端专题文档保存在 `frontend/docs/` |

## 启动和构建

要启动跨设备同步使用的账本服务，先按[后端说明](backend/README.md)准备 PostgreSQL，再双击 [backend/start.cmd](backend/start.cmd)。默认地址为 `http://127.0.0.1:5180`，可用 [backend/set-port.cmd](backend/set-port.cmd) 修改端口，使用 [backend/stop.cmd](backend/stop.cmd) 关闭服务。

在仓库根目录打开 PowerShell。桌面开发需要 Node.js 22.18 或更高版本、Rust stable、MSVC C++ Build Tools 和 WebView2。以下命令启动带本机 SQLite 的 Windows 客户端。

```powershell
Set-Location .\frontend
npm ci
npm run tauri -- dev
```

在 Windows 上可直接双击 [frontend/build.cmd](frontend/build.cmd) 构建 Windows x64 安装包和 Android arm64 调试 APK，产物位于 `frontend/release/`。只构建 Windows 包时，在仓库根目录运行 `.\frontend\build.cmd windows`。Android 工具链配置和其他构建选项见[客户端构建说明](frontend/README.md#一键构建)。

## 开发文档

| 想了解什么 | 从这里开始 |
| --- | --- |
| Windows 和安卓怎么连接同一本账，分期重试与补款冲突如何处理 | [后端启动](backend/README.md) · [同步接口与冲突处理](backend/docs/sync.md) |
| 一次勾选如何写入 SQLite，改动会影响什么，如何验证 | [项目开发指南](docs/development.md) |
| 各版本交付了什么，下一个里程碑如何验收 | [开发里程碑](docs/milestones.md) |
| 接下来可以做哪些任务，先解决哪些依赖 | [开发计划](docs/development-plan.md) |
| 具体页面、原生命令和扩展接口在哪里 | [客户端开发手册](frontend/docs/development.md) · [扩展契约](frontend/docs/extensions.md) |
| AI 开发助手接手客户端任务时应遵守哪些业务规则 | [AI 开发交接](frontend/AGENTS.md) |
