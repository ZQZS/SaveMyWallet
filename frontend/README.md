# SaveMyWallet

Windows 和安卓共用 Vue、TypeScript 和 Tauri 2。每台设备独立保存一份 SQLite 账本，可离线录入、核对还款和查看下月结余。

从仓库首页可查看三个模块的职责、项目里程碑和跨模块开发计划。[SaveMyWallet 项目首页](../README.md)

## 开发文档入口

| 我想了解 | 阅读入口 |
| --- | --- |
| 两台设备如何绑定同一本账、处理离线修改冲突 | [启动后端与绑定设备](../backend/README.md) · [同步开发说明](../backend/docs/sync.md) |
| 项目业务、各目录的职责、从 Vue 页面到 SQLite 的读写流程 | [开发者手册](docs/development.md) |
| 当前交付范围、后续功能的目的、依赖与验收标准 | [开发路线与里程碑](docs/roadmap.md) |
| 更换桌宠、导入酒馆角色卡或制作内置角色 | [桌宠与酒馆角色卡](docs/pets.md) |
| 配置 DeepSeek、核对尾款通知、用一句话查账或试算新分期 | [AI 助手使用与验证](docs/ai-features.md) |
| 接入 Axios 后端、WASM 或独立数据采集脚本 | [扩展开发说明](docs/extensions.md) |
| 由 AI 助手接手代码任务 | [AI 开发交接](AGENTS.md) |

## 使用

1. 在「工资与警告线」设置默认月工资与最低预计结余。可以单独填写所选月份的工资，留空后恢复默认，填写 0 表示该月没有工资。
2. 打开「记一笔」，选择平台和还款月份。可以在表单内新增平台并直接选用，也可以在「还款平台」集中添加。点击平台名称可按月查看明细。勾选账单或点「全选本月」，可跨月将选中的待还款项标记为已还，也可核对金额后作废所选明细。单独勾选分期的某一期只处理该期。点击账单名称可定位到月度账本。分期填写每期应还金额、首期月份和期数。
3. 录入「预计补款」时填写总价和已支付定金，定金默认 0 元。总价 100 元、定金 20 元时，当月只计入 80 元应补。月底仍未确认的尾款会在跨月后顺延至新月份，明细保留原预计月。确认时可调整总价、定金和实际月份，全额预付的款项确认后会显示「无需补款」。
   勾选平台会结清该月已确认的待还账单，「撤销」只恢复刚才变更的明细。
   输错时点该条明细的「作废」。分期可选择仅作废本期，或作废整笔分期。整笔操作涵盖所有月份，包括已还的期次。每期仍保留原金额和还款状态，也可以按期或整笔恢复。旧分期如果缺期，或有多笔完全相同的记录而无法区分，仍可逐期操作。
4. 打开「系统设置」可切换简体中文或 English。通过「导入与导出」可把完整账本导出为 UTF-8 JSON 文件，再到另一台设备选择该文件。核对平台数、明细数和工资覆盖数后，点击「确认覆盖并导入」会替换目标设备的账本。
5. 「重置账本」需要再次准确输入 `重置`。成功后清空账单、还款状态、自定义平台和工资覆盖，恢复三个初始平台、默认工资 0 和警告线 0。设备语言独立保留。
6. 需要截图录入或月度解释时，在「系统设置 → 扩展配置 → AI 助手」保存自己的 DeepSeek API Key 并检测连接。在「记一笔」预览截图，选择发送后逐条核对并保存。在月度账本可以解释选中月份，也可以手工填入一笔假设分期，离线查看对各月结余的影响。[助手配置与使用](docs/ai-features.md)
7. 收到已预订商品的尾款通知时，用「尾款通知对账」选择原预计补款，核对月份和差额后确认。要查「下个月还有哪些订单付了定金、需要补款」，可用「一句话查账」提取条件，再查看本机明细与合计。[对账与查账示例](docs/ai-features.md#尾款通知对账)
8. 在「系统设置 → 扩展配置 → 桌宠」开启桌宠，选择钱包猫、账房鸮或侦探狐，也可以导入酒馆 JSON 或 PNG 角色卡。回到月度账本可打招呼、更换伙伴。配置本机 DeepSeek Key 后，可在伙伴旁新建聊天或切换对话，发送时可选择不附账本、附月度摘要，或附摘要及勾选的当月明细。[桌宠聊天与角色卡](docs/pets.md)
9. 在「系统设置 → 外观」切换暖纸、海雾或夜色主题，可单独更换主题色和账本背景。照片背景支持本机 JPEG、PNG 和 WebP。
10. 从菜单打开「聊天」，可直接聊日常话题。选「当月明细」并勾选账单后，可问「我选的还有多少没还？哪一笔最大？」，也可说「把第 2 笔标记为已还」。核对预览后点击「确认执行」即可更新账本。桌宠支持相同操作。[聊天使用示例](docs/ai-features.md#在聊天里改账)

启用跨设备同步的账本，请先更新服务端和各设备客户端，再录入带定金的预计补款或新分期。旧补款沿用原金额，已支付定金按 0 元显示。

整月应还等于已还、已确认待还和待确认预估三项之和。预计结余等于当月适用工资减去整月应还。下月预览采用下月自己的工资与账单。

### 创建自己的主题

1. 在「外观」点「创建主题」，以当前搭配开始，或选择另一套基础主题。
2. 选择主题色和背景，对照账本示例查看摘要卡、文字和底色的效果。
3. 输入主题名称并点「保存并应用」。以后可以在「我的主题」里切换或删除。主题和背景照片保存在当前设备上。

## 本地开发

使用 Node.js 22.19 或更高版本和 Rust stable。Windows 需要 MSVC C++ Build Tools 与 WebView2，安卓还需要兼容的 JDK、Android SDK 和 NDK。

`SaveMyWallet/frontend/` 是应用的项目根目录，其中 `src/` 存放 Vue 界面和业务逻辑，`src-tauri/` 存放原生工程。以下所有开发、构建和测试命令都在此目录执行。

```powershell
Set-Location H:\App_dev\SaveMyWallet\frontend
npm ci
npm run tauri -- dev
```

`npm run dev` 单独启动前端开发服务器。SQLite 命令由 Tauri 客户端提供。

## 一键构建

发布新版本前，双击 [update-version.cmd](update-version.cmd)，或在此目录运行 `node scripts/update-version.mjs`。脚本会显示当前客户端版本。输入新版本号（例如 `0.4.4`）并回车，即可同步更新 Tauri、npm、Cargo 和项目文档中的版本。直接回车可取消。

在 Windows 文件资源管理器中双击 [build.cmd](build.cmd)，或在项目目录运行以下命令。默认生成 Windows x64 NSIS 安装包和 Android arm64 调试 APK。脚本按锁文件安装前端依赖、运行前端测试，并在所有选定平台构建成功后将安装包放入 `release/`。文件名取自 Tauri 的产品名和版本号，同版本再次构建会替换对应文件。

```powershell
.\build.cmd           # 构建两个安装包
.\build.cmd windows   # 仅 Windows 安装包
.\build.cmd android   # 仅 Android 调试 APK
.\build.cmd web       # 仅生成前端静态资源，输出到 dist/
```

双击运行后可在 `.tools/build.log` 查看本次构建记录。

首次构建 Windows 包需安装 Rust 的 `x86_64-pc-windows-msvc` 目标及 MSVC C++ Build Tools。构建 Android 包需 JDK 17 或更高版本、Android SDK 37、Build Tools 和 NDK，并先运行 `rustup target add aarch64-linux-android`。配置 `JAVA_HOME`、`ANDROID_HOME`，使用独立安装的 NDK 时再设置 `NDK_HOME`。Windows 若限制创建符号链接，脚本会将本次编译的原生库交给项目自带的 Gradle wrapper 完成打包。

使用自定义工具目录时，可在本机的 `.tools/build-env.json` 填写上述环境变量，也可指定 `CARGO_HOME`、`RUSTUP_HOME`、`GRADLE_USER_HOME`、`ANDROID_USER_HOME` 和 `npm_config_cache`。值支持项目相对路径和 `%TEMP%` 等环境变量，已设置的同名环境变量优先。Android 调试包沿用所选 Android 用户目录中的调试签名。需要单独保存验证产物时可运行 `.\build.cmd all -OutputDirectory .tools/build-check`。

## 按功能维护界面

| 要修改的功能 | 页面入口 | 同目录中的职责 |
| --- | --- | --- |
| 月度账本 | [LedgerPage.vue](src/features/ledger/LedgerPage.vue) | 月份切换、勾选和撤销。摘要、平台清单、还款明细和下月预览在 `components/` 下 |
| 记一笔、确认补款 | [BillPage.vue](src/features/bills/BillPage.vue) | 根据路由选择新建或确认原单，`components/BillForm.vue` 负责填写和校验 |
| 还款平台 | [PlatformsPage.vue](src/features/platforms/PlatformsPage.vue) | 平台列表、新增逻辑和供账单表单复用的 `PlatformPicker.vue` |
| 工资与警告线 | [BudgetPage.vue](src/features/budget/BudgetPage.vue) | 默认工资、单月覆盖、警告线和结余预览 |
| 系统设置 | [SettingsHomePage.vue](src/features/settings/SettingsHomePage.vue) | 语言、导入导出、重置及扩展配置子页；子路由在同目录的 `settingsRoutes.ts` |

新增菜单时，在 `src/features/<功能>/` 创建页面，向 [menu.ts](src/app/menu.ts) 添加菜单名称与图标，再在 [router.ts](src/app/router.ts) 注册路由并设置归属菜单。Windows 顶部导航和安卓底部导航共用这份菜单。像「确认补款」这样的子页面只需注册路由，并通过 `meta.menu` 指定所属菜单。

[App.vue](src/App.vue) 挂载页面外壳和路由出口。[ledgerSession.ts](src/app/ledgerSession.ts) 管理当前月份、账本快照和写入后的重新读取，各功能页面负责自己的操作。写入成功后若刷新失败，「重新读取」会保留表单并继续原操作。

启用跨设备同步后，页面继续访问本机 SQLite，原生同步层通过 HTTP 与后端交换修改。当前月、下月和预算预览共用 TypeScript 的 `summarize`。独立采集脚本从 `scripts/collectors/` 开始，示例输出带来源标识的待审核草稿。[依赖装配](src/main.ts) · [扩展开发说明](docs/extensions.md)

## 数据与验证

账本文件为 Tauri 应用数据目录中的 `ledger.sqlite3`。Windows 默认位于 `%APPDATA%\app.savemywallet.ledger\ledger.sqlite3`，安卓保存在应用私有目录。首次启动创建初始平台和空账本。新增平台与账单使用独立 ID 关联，金额以整数分保存。可导出 JSON 手动迁移，也可在「系统设置 → 跨设备同步」绑定同一本账。整本覆盖导入和重置需要先解绑。[同步与冲突处理](../backend/docs/sync.md)

`src/data/repository.ts` 定义数据访问接口，`src/data/sqlite.ts` 调用 Tauri 命令，`src-tauri/src/ledger.rs` 执行 SQLite 事务。`npm test` 覆盖前端的 TypeScript 月度汇总。开发可选的 WASM 模板时，可另行运行 `npm run test:wasm` 对照计算结果。[模板构建说明](../wasm-lib/README.md)

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```
