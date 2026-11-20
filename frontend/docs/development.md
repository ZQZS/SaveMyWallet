# SaveMyWallet 开发者手册

SaveMyWallet 面向在多个平台分期消费、预订商品或有临时还款的人。用户按还款月份查看各平台应付金额，核对已经还过的款项，并在发薪前估算扣掉下月还款能剩多少钱。这里的「预计结余」只考虑已录入的工资与还款计划。

Windows 和安卓共用 Vue、TypeScript、Tauri 2 和 Rust 代码，每台设备使用各自的 SQLite 账本。本地录入、动态平台、月度汇总、还款勾选、工资覆盖和结余预警都可离线使用。系统设置提供语言切换、手动备份恢复、账本重置和跨设备同步。桌宠和 AI 的实际功能列在后续路线中。[路线图](roadmap.md) · [AI 协作者指南](../AGENTS.md) · [同步协议](../../backend/docs/sync.md)

## 一笔账如何影响月度清单

| 规则 | 数据和界面的约定 |
| --- | --- |
| 金额与月份 | 输入使用元，领域模型和 SQLite 用整数分。月份按还款归属月保存为 `YYYY-MM`，支持 1900-01 至 2099-12。 |
| 单次与分期 | 单次还款记在指定月。分期输入每期金额、首期月份和期数，原生端在一个事务中生成连续 1–120 个月的明细，跨年照常递推。 |
| 预计补款 | `estimated` 计入预计支出。用户核对金额和月份后，原明细按 ID 更新为 `due`。若月份发生变化，支出随之移到新月份。 |
| 平台与还款 | 从数据库读取平台，按平台 ID 和月份归组。勾选把当月所选的 `due` 明细改为 `paid`。撤销使用本次实际变更的 ID。后来补录的 `due` 与已有 `paid` 同时存在时显示「部分已还」。 |
| 工资与预警 | 单月工资优先，空值使用默认工资，0 表示当月无工资。整月应还等于已还、确认待还、待确认三项之和。预计结余等于适用工资减整月应还。严格低于警告线时显示差额。下月预览用下月工资和明细。 |

可用这组金额做回归测试。某月工资 5,000 元，平台 A 既有 100 元已还，也有 200 元待还，平台 B 有 80 元待确认。整月应还 380 元，仍待还 200 元，预计结余 4,620 元。勾选 A 后，仍待还归零，预计结余仍为 4,620 元。撤销后恢复那笔 200 元，原先已还的 100 元保持已还。警告线设为 4,800 元时，两次操作前后都应提示差 180 元。

## 目录与职责

下表的路径和开发命令均以 `SaveMyWallet/frontend/` 为项目根目录。

| 路径 | 开发时在这里维护什么 |
| --- | --- |
| `package.json`、`package-lock.json` | 声明依赖、开发与测试脚本及 Tauri CLI 命令。`npm ci` 根据锁文件安装依赖。 |
| [build.cmd](../build.cmd)、`scripts/build*.ps1` | Windows 上的一键构建入口和实现。负责调用前端验证、Tauri 打包和 Android 符号链接受限时的 Gradle 打包，交付物及单平台命令见 [README](../README.md#一键构建)。 |
| `index.html`、`vite.config.ts`、`tsconfig.json` | 分别维护 Vue 应用的 HTML 入口、Vite 构建配置及 TypeScript 类型检查配置。 |
| `src/main.ts`、`src/App.vue` | 装配账本仓库、月度计算器、会话与路由，挂载应用外壳。这里可查出当前实际启用的实现。 |
| `src/app/` | `menu.ts` 定义桌面与安卓共用的菜单，`router.ts` 注册 hash 路由，`layout/` 承载导航和读写反馈，`ledgerSession.ts` 管理快照及写后刷新。 |
| `src/features/ledger/` | 月度首页、平台分组及展开明细、勾选与撤销、下月预览。 |
| `src/features/bills/` | 录入单次还款、分期或预计补款，按明细 ID 打开并确认原单。 |
| `src/features/platforms/` | 管理动态平台。账单表单与管理页共用新增逻辑和平台数据。 |
| `src/features/budget/` | 编辑默认工资、当前月工资覆盖和结余警告线，预览应用新设置后的结余。 |
| `src/features/settings/` | 设置首页按通用、账本数据和扩展配置分组。子页在 `settingsRoutes.ts` 注册。[备份页面](../src/features/settings/BackupSettingsPage.vue)协调系统选择器、预览与确认。 |
| `src/i18n/` | 本机语言偏好、参数插值、人民币和月份格式化、可展示的原生错误。在 `messages/` 中为简中与英文提供相同键与参数。 |
| `src/domain/`、`src/data/` | 前者定义业务类型、金额解析和纯汇总函数。后者定义 `LedgerRepository` 和调用 Tauri 命令的 SQLite 适配器。 |
| `src/shared/styles/` | 跨页面使用的基础和表单样式。功能组件独有的样式跟随组件。 |
| `src/integrations/api/`、`src/integrations/wasm/` | 前者提供可选的远端账本仓库，后者提供供 WASM 模板复用的异步加载器。应用的月度计算使用 `src/domain/ledger.ts`。[WASM 模板](../../wasm-lib/README.md) |
| `scripts/collectors/` | 独立数据采集脚本、来源契约与本地样例，输出带外部编号和平台名称的待审核草稿。 |
| `src-tauri/src/` | `lib.rs` 注册命令并管理连接。`ledger.rs` 验证、查询、写事务。`schema_v1.sql` 定义首版表结构。 |
| `src-tauri/gen/android/`、`src-tauri/capabilities/`、`src-tauri/icons/` | 安卓 Gradle 工程、Tauri 权限与打包图标。两端共用的账务逻辑位于 `src/` 和 Rust 模块。 |
| `src/features/pets/`、`resources/pets/` | 桌宠契约及资源包，后续供展示层加载。开发样例、资源规范和跨平台呈现见[桌宠开发说明](pets.md)。 |
| `src/integrations/ai/`、`src-tauri/src/ai/`、`resources/ai/` | 分别预留 AI 能力契约、原生凭据与服务接入、提示词和联调素材。数据流与识图审核见[AI 功能说明](ai-features.md)。 |
| `tests/`、`src-tauri/src/ledger/tests.rs` | 前端业务、会话和扩展契约回归。原生 SQLite 写入、重开和事务回归。 |
| `docs/`、`dist/`、`src-tauri/target/`、`release/` | 项目文档、Vite 构建结果、Cargo 构建结果和供安装的交付物。修改功能时编辑源目录，再生成对应产物。 |

## 从页面追到数据库

以新增分期为例。账单表单将每期金额解析成分并提交 `BillInput`。页面调用 `session.commit`，通过 `LedgerRepository.createBill` 进入 Tauri 命令 `create_bill`。Rust 再次检查平台、金额和末期月份，以事务写入各期。写成后会话调用 `load_ledger` 读回快照，完成回调切到首期月份。首页和预算预览都使用注入的 `calculateMonth` 计算。可沿以下入口定位断点。[账单页面](../src/features/bills/BillPage.vue) · [会话](../src/app/ledgerSession.ts) · [IPC 适配器](../src/data/sqlite.ts) · [Rust 账本](../src-tauri/src/ledger.rs)

写入失败时，页面显示错误，用户可更正并重试。写入成功但快照读取失败时，账单已持久化，会话保留完成回调，界面提供「重新读取」。恢复时只重读快照并执行一次回调。平台选择器也依靠这个时序，在账单草稿中选中新创建的平台。[会话回归测试](../tests/ledger-session.test.mjs)

## 接手一个变更

**改系统设置或备份。** 从 [settingsRoutes.ts](../src/features/settings/settingsRoutes.ts) 找到对应子页，同时维护中英文词条。设备语言保存在本机 WebView 的 `savemywallet.locale` 偏好中。界面格式化使用 `formatMoney` 和 `formatMonth`，货币始终为人民币，平台名和款项名称按原文显示。

JSON 备份的顶层包含 `format: "SaveMyWallet"`、`version` 和 `ledger`。包含分期组标识 `installmentId` 时导出 v3。其余账本按是否有作废明细导出 v2 或 v1。新版客户端可以还原这三种格式。账本快照内含平台、明细、预算与单月覆盖，以及原有 ID 和还款状态。文件为可读明文，大小上限 32 MiB，导出仅写入系统选择器指定的位置。预览与导入复用 Rust 校验器，校验格式版本、月份、金额、关联 ID 与分期信息；全量替换在 SQLite 事务内完成。重置同样使用事务，并在原生层再次逐字比较 `重置`。测试两种操作时使用隔离账本；验证失败回滚、取消、重开后的数据与写后读取重试。[备份实现](../src-tauri/src/ledger/backup.rs) · [文件读写](../src-tauri/src/backup_files.rs)

- **加菜单或子页面**。在所属 `features/` 目录建立页面，在 `router.ts` 关联归属菜单。只有新增顶层菜单才改 `menu.ts`。分别从桌面顶部、安卓底部和直接打开 hash 路由验证。
- **改账务口径或字段**。先用领域模型和回归样例表达新口径。若需要持久化新字段，同步仓库接口、IPC 数据类型和 Rust 校验，并新增数据库迁移。客户端通过 `PRAGMA user_version` 识别版本。[SQLite v5](../src-tauri/src/schema_v5.sql) 给新建分期的所有期次保存同一组标识，并保留每一期的明细 ID。旧分期保留原有同步记录，整笔操作时按平台、名称、每期金额、总期数和首月核对，每一期都须唯一。新增迁移时，用带有待传分期和未解决冲突的旧账本重开，核对绑定、游标、明细 ID 与重试结果。[同步与升级规则](../../backend/docs/sync.md)
- **接入识图录入**。模型输出先保留为待审核草稿，用户选择数据库中的平台并核对金额、月份和分期后，再走已有账单写入链路。桌宠与提醒可以消费本地汇总结果，结余和警告差额继续取自账本计算器。[AI 功能说明](ai-features.md) · [现有扩展接入说明](extensions.md)

## 运行与验收

首次开发从项目根目录运行 `npm ci`、`npm run tauri -- dev`。本地账本路径、工具链和双端构建命令见[项目说明](../README.md)。前端改动运行 `npm test` 和 `npm run build`。涉及 SQLite 时另跑 `cargo test --manifest-path src-tauri/Cargo.toml --lib`。验证真实持久化时使用测试账本，在原生客户端完成一次录入、勾选、关闭和重开。纯浏览器页面需要测试替身才能模拟 Tauri IPC。
