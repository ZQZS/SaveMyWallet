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

## 聊天、提醒和账本恢复

桌宠弹窗和菜单聊天共用聊天窗口。Vue 中的 Pi Agent Core 调度工具，Rust 原生层用本机凭据请求 DeepSeek。查勾选项时，`inspect_selected_bills` 在本机按本轮分享的明细计算待还总额和最大一笔。还款、确认补款、作废等写操作先展示具体账单和影响范围，用户确认后才进入账本写入流程。[Pi 工具入口](../frontend/src/integrations/ai/agentChat.ts) · [动作定义](../frontend/resources/ai/ledger-action-tools.json) · [确认与执行](../frontend/src/features/ai/useLedgerActionReview.ts)

| 要改的行为 | 本机数据与验收要点 |
| --- | --- |
| 续聊、草稿和清理 | IndexedDB 按入口、角色和月份区分对话。删除单段只清该段问答与草稿，按角色清理覆盖其所有月份的菜单聊天和桌宠弹窗。重启要能续写草稿，另一窗口的迟到回复也不能恢复已删除的对话。[聊天存储](../frontend/src/features/pets/chatStorage.ts) · [聊天缓存设置](../frontend/src/features/settings/ChatCacheSettingsPage.vue) |
| 聊天控件的折叠与分享 | 两个入口都可收起「当前聊天」和「账本附件」，菜单聊天另有「对象与月份」。展开、收起仅改变布局。可勾一笔测试账单，收起附件再发送，核对工具仍只读这一笔。换对话或月份后分享范围回到「不附账本」。[共用聊天窗口](../frontend/src/features/ai/ChatWindow.vue) · [菜单聊天页](../frontend/src/features/ai/ChatPage.vue) |
| 提醒排程与投递 | 设置与聊天动作共用本机提醒任务。应用内弹窗由前台投递，系统通知交给 Windows 任务计划程序或 Android AlarmManager。关闭重复提醒应撤销后续投递，重新开启时按原规则找下次时间。用跨午夜的随机时段检查过期跳过行为。[提醒服务](../frontend/src/features/reminders/reminderService.ts) · [时间规则](../frontend/src/features/reminders/recurrence.ts) · [渠道与示例](../frontend/docs/pets.md#桌宠提醒与任务列表) |
| 撤销一次 AI 改账 | SQLite 在同一写事务中记录受影响数据的前后值。用两笔 AI 标为已还的账单和一笔随后手录的账单验证撤销。若用户又修改了同一还款状态，应提示冲突并保留现状。[变更记录](../frontend/src-tauri/src/ledger/ai_undo_capture.rs) · [撤销与冲突核对](../frontend/src-tauri/src/ledger/ai_undo.rs) |
| 还原到昨天或七天前 | 跨日后首次访问账本时检查并归档上一日状态，写入路径也会先做检查。整本还原要先预览并确认，已绑定同步的设备要先解绑。以设备本地日期验证恰好七天前的还原点仍可用，超过七天的自动还原点、AI 撤销记录和绑定前备份会清理。[归档实现](../frontend/src-tauri/src/ledger/history.rs) · [还原示例](../frontend/README.md#自动备份与账本还原) |

聊天缓存、角色和提醒任务保存在各自设备上。JSON 备份与跨设备同步处理账本数据。清理聊天缓存后，已确认的改账结果仍保存在 SQLite。[客户端开发手册](../frontend/docs/development.md) · [里程碑与验收环境](milestones.md)

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

改动聊天持久化时，可在 `frontend/` 单独运行 `node --experimental-strip-types --test tests/chat-storage.browser.mjs`。该用例以临时浏览器配置验证真实 IndexedDB 的双连接写入、删除和清理。若浏览器安装在自定义位置，可用 `SMW_TEST_BROWSER` 指定可执行文件。[浏览器回归用例](../frontend/tests/chat-storage.browser.mjs)
