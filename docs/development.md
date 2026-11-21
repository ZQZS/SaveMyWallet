# SaveMyWallet 开发指南

Windows 和安卓共用一个客户端。每台设备维护自己的 SQLite 账本并计算月度汇总。启动入口向页面提供账本仓库和月度计算函数。启用跨设备同步后，原生层将本机已保存的变更上传至账本服务，再拉取增量更新。[客户端入口](../frontend/src/main.ts) · [同步协议](../backend/docs/sync.md)

## 目录和修改入口

| 目录 | 当前职责 | 接手任务时从哪里开始 |
| --- | --- | --- |
| `frontend/` | 可构建的完整客户端，包括 Vue 页面、Tauri 原生层、SQLite、测试和打包脚本 | 改菜单先查路由与对应功能页，改原生数据操作先查仓库接口。[客户端开发手册](../frontend/docs/development.md) |
| `backend/` | ASP.NET Core 账本服务、PostgreSQL、接口测试 | 从绑定流程、操作回执、记录版本和游标入手检查两台设备的数据。[后端开发说明](../backend/README.md) |
| `wasm-lib/` | 可独立构建的 .NET 10 WebAssembly 模板 | 以月度汇总演示 JavaScript 调用 C#。改动模板后，可用前端 TypeScript 汇总核对结果。[模板](../wasm-lib/README.md) · [TypeScript 汇总](../frontend/src/domain/ledger.ts) |
| `docs/` | 跨目录的开发指南、里程碑与实施计划 | 产品交付情况从[项目首页](../README.md)进入，单个客户端功能的使用和维护说明保存在 `frontend/docs/`。 |

## 从一笔写入追到月度清单

1. 用户在表单填写还款月、平台和金额。以分期为例，页面把每期金额转换成整数分，连同首期月份和期数交给 `session.commit`。[账单页面](../frontend/src/features/bills/BillPage.vue)
2. 会话调用 `LedgerRepository.createBill`。默认的 SQLite 适配器通过 Tauri 命令 `create_bill` 进入 Rust，后者校验平台与金额，并把各期明细写入同一个事务。[仓库接口](../frontend/src/data/repository.ts) · [SQLite 适配器](../frontend/src/data/sqlite.ts) · [原生账务操作](../frontend/src-tauri/src/ledger.rs)
3. 写入成功后，会话重新读取 `LedgerData` 快照，再执行页面的完成回调。若读取失败，会话保留草稿，用户可点「重新读取」。这条路径只刷新快照，避免再次生成同一笔分期。[账本会话](../frontend/src/app/ledgerSession.ts) · [重试测试](../frontend/tests/ledger-session.test.mjs)
4. 页面将同一快照和目标月份传给 `calculateMonth`。当月清单、下月预览和预算预览共用这项计算。增改界面或数据源时，可用同一组输入逐项核对汇总结果。[领域模型与计算](../frontend/src/domain/ledger.ts) · [账务测试](../frontend/tests/ledger.test.mjs)

### 跨模块共用的账务规则

- 金额以整数分传递，归属月使用 `YYYY-MM`。按月份和平台 ID 分组，显示名来自平台表。分期按每期金额入账，跨年时继续逐月生成明细。
- 整月应还等于已还、已确认待还和待确认预估之和。预计结余等于有效工资减整月应还。单月工资覆盖优先于默认工资，覆盖值可以是 0。预计结余严格低于警告线时发出预警。
- 勾选平台只结清该月该平台已确认的待还明细，撤销只使用此次实际变更的 ID。确认预计补款按原 ID 更新金额、月份和状态，移月后旧月份也应反映变化。
- 预计补款以总价减去已支付定金计算当月应补金额。总价大于零，定金默认零且最多等于总价。确认已全额预付的款项时，应补为零，原明细直接结清。

例如，12 月工资为 3,000 元，某平台有待还分期 200 元和待确认补款 100 元。勾选后，仍待还降至 0，预计结余仍为 2,700 元。若把补款确认为次年 1 月应还的 120 元，12 月预计结余变为 2,800 元，1 月待还增加 120 元。这组数据可同时验证清单、跨年移月与新计算实现。

## 维护同步与 WASM 模板

在线账本接口与 `LedgerRepository` 对齐，平台使用稳定 ID，批量勾选返回实际变更的 `changedIds`。双端客户端在本机事务中保存业务数据和待上传操作。联调时分别验证分期丢回执后重发、两端确认同一补款时选择不同金额、拉取页面与游标的原子更新，以及解绑后的 JSON 导入和重置。[接口与冲突处理](../backend/docs/sync.md) · [原生备份实现](../frontend/src-tauri/src/ledger/backup.rs)

会话直接调用 TypeScript 的 `summarize(ledger, month)`。另行开发 WASM 模板时，在 `frontend/` 运行 `npm run test:wasm`，可将发布模块的分组、明细和各项金额与前端逐项对照。[模板构建说明](../wasm-lib/README.md)

## 开发与验证

以下 PowerShell 示例从**仓库根目录**开始。依赖版本、系统工具链和一键打包方式见[客户端构建说明](../frontend/README.md)。

```powershell
Set-Location .\frontend
npm ci
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

在同一 `frontend/` 目录运行 `npm run tauri -- dev` 可验证 SQLite 读写。改账务流程时，用测试账本完成录入、勾选、撤销和重开。改数据库结构时，用旧版本创建的测试账本验证迁移后重开。改页面时分别检查桌面布局、安卓窄屏和返回操作。提交验证结果时注明实际覆盖的环境，例如 Windows 客户端、APK 静态检查或安卓真机。
