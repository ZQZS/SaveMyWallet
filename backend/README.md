# SaveMyWallet 账本服务

本服务使用 **ASP.NET Core 10、EF Core 10 和 PostgreSQL**。Windows 与安卓各自从本机 SQLite 读写。两台设备绑定同一服务上的同一账本后，可在联网时交换明细、还款状态和预算。断网录入的分期沿用本机分配的每一期 ID。两端把同一笔预计补款确认为不同金额或月份时，用户可以在设置中选择采用哪个版本。[同步协议与冲突处理](docs/sync.md)

## 后端项目

用 Visual Studio 打开[后端解决方案](SaveMyWallet.slnx)，或在仓库根目录运行 `dotnet build ./backend/SaveMyWallet.slnx` 构建所有项目。

| 项目 | 职责 |
| --- | --- |
| `SaveMyWallet.Api` | 启动 HTTP 服务、注册依赖、认证请求，将路由分派给业务服务。 |
| `SaveMyWallet.Services` | 实现账本和同步用例，调用核心规则，通过存储接口读取快照或提交变更。 |
| `SaveMyWallet.Core` | 生成账务命令的变更记录，校验金额、分期、状态转换和同步操作。 |
| `SaveMyWallet.Constant` | 定义金额上限、预算设置键和同步分页大小，供业务规则、服务和存储实现共用。 |
| `SaveMyWallet.Dto` | 定义持久化实体、请求与返回结果。具体 DTO 的名称后缀和公共命名空间按 `EntityDto`、`QueryDto`、`QueryResultDto` 三种类别区分。 |
| `SaveMyWallet.Interfaces` | 定义账本服务、同步服务和同步存储的接口。 |
| `SaveMyWallet.Infrastructure` | 用 EF Core 将数据库行类型映射到 PostgreSQL 表，实现存储接口，管理建表、事务、游标和幂等回执。 |

新增 DTO 时，使用普通 C# `class` 继承对应基类，并将文件放入业务子目录。基类和标记接口位于类别根目录。有响应体的 API 使用具名结果类，无响应体的写入接口返回 HTTP 204。

| 类别目录 | 基类与接口 | 业务子目录 |
| --- | --- | --- |
| `EntityDto/` | `EntityBase` 实现 `IEntity` | `Ledger/` 存放账本头、当前记录和账务变更，`Sync/` 存放同步记录、变更批次和操作回执。 |
| `QueryDto/` | `QueryBase` 实现 `IQuery` | `Bills/` 处理账单，`Platforms/` 处理平台，`Payments/` 处理还款，`Budget/` 处理预算，`Sync/` 处理同步。 |
| `QueryResultDto/` | `QueryResultBase` 实现 `IQueryResult` | `Ledger/` 存放账本快照及设置，`Platforms/` 和 `Bills/` 存放平台、账单及变更结果，`Sync/` 存放同步结果与冲突，`Errors/` 存放通用错误响应。 |

账单和平台的业务规则直接读写 `BillEntryQueryResultDto` 和 `PlatformQueryResultDto` 的属性，预算金额使用 `long`（单位为分）。扩展记录字段时，在对应类上声明属性，在 `LedgerRules` 中校验业务约束。`LedgerValues` 负责同步数据的类型转换，包括区分缺失字段与显式 `null`。同步请求与记录保留原始 JSON 值，用于核对离线编辑的旧快照和重试请求。

## 在 Windows 上启动开发服务

需要 .NET 10 SDK、一套可以连接的 PostgreSQL 和一个专用数据库。API 首次启动会建立表结构，数据库角色需要建表权限。在有 PostgreSQL 管理权限的终端运行以下命令，可建立开发用角色和数据库。

```powershell
createuser -U postgres --pwprompt wallet_app
createdb -U postgres --owner=wallet_app wallet_sync
```

### 双击脚本

在 Windows 资源管理器中打开 `backend` 目录，或从仓库根目录运行表中的命令。

| 操作 | 双击 | PowerShell 命令 |
| --- | --- | --- |
| 构建并在后台启动 API | [start.cmd](start.cmd) | `.\backend\start.cmd` |
| 关闭这份项目启动的 API | [stop.cmd](stop.cmd) | `.\backend\stop.cmd` |
| 设置 API 监听端口 | [set-port.cmd](set-port.cmd) 后输入端口 | `.\backend\set-port.cmd 5280` |

首次启动会沿用已有的环境变量或应用配置，并提示补齐缺少的项目。

- **PostgreSQL 连接串**可填写 `Host=127.0.0.1;Port=5432;Database=wallet_sync;Username=wallet_app;Password=实际密码`。
- **账本令牌**可用密码管理器生成并保存，长度为 32–1024 个无空格的可打印 ASCII 字符。脚本提示输入的令牌用于 `personal` 账本，客户端也使用同一令牌。

手工输入的两项配置使用当前 Windows 用户的 DPAPI 加密，分别保存在 `.local/connection.dpapi` 和 `.local/personal-token.dpapi`。需要重新输入时，可关闭 API，移除对应文件再启动。

默认 API 地址为 `http://127.0.0.1:5180`。端口范围为 1–65535，选择的端口保存在本机的 `.local/port.txt`。服务运行时改端口，先双击 `stop.cmd` 再双击 `start.cmd` 即可生效。重复启动会显示当前实例的地址。PostgreSQL 由其自身的服务管理。

脚本运行失败时，可在 `.local/last-error.txt` 查看最近一次错误。API 的运行日志和错误日志分别在 `.local/server.stdout.log` 和 `.local/server.stderr.log`。

### 手动启动

也可以在**仓库根目录**打开 PowerShell 7，设置环境变量后在前台运行。示例中 `personal` 是账本 ID。

```powershell
$env:ConnectionStrings__Ledger = Read-Host 'PostgreSQL 连接串' -MaskInput
$env:LedgerTokens__personal = Read-Host 'personal 账本令牌' -MaskInput
$env:ASPNETCORE_URLS = 'http://127.0.0.1:5180'
dotnet run --project ./backend/SaveMyWallet.Api --no-launch-profile
```

### 验证服务

启动后，在 PowerShell 7 窗口用同一令牌读取账本。以下命令使用默认 API 端口。新的空账本会返回账本 ID、游标 `0` 和空记录数组。

```powershell
$ledgerToken = Read-Host 'personal 账本令牌' -MaskInput
$headers = @{ Authorization = "Bearer $ledgerToken" }
Invoke-RestMethod -Uri http://127.0.0.1:5180/sync/bootstrap -Headers $headers
```

## 把 Windows 和安卓连到同一本账

1. 在 Windows「系统设置 → 账本数据 → 跨设备同步」输入服务地址和令牌，点击「预览服务器账本」。初次使用时，选已有完整账本的设备作为第一台，选择「绑定并上传本机账本」，再完成一次同步。
2. 在第二台设备输入同一地址和同一令牌。核对预览中的云端账本与记录数。**「绑定并使用服务器账本」会替换本机账本**。如果第二台设备已经单独记过账，先通过「导入与导出」导出，再决定是否使用云端版本。也可在同步页导出最近一次绑定前保留的本机备份。
3. 断开网络，在任一设备创建一笔分期。恢复连接后点击「立即同步」，再在另一端同步并按月核对。客户端进程重启后需重新输入令牌并「解锁同步」，期间本机仍能记账。

开发电脑可使用上述回环地址。安卓真机中的 `127.0.0.1` 指向手机自身。USB 联调时在开发电脑执行 `adb reverse tcp:5180 tcp:5180`，即可在安卓调试包中输入 `http://127.0.0.1:5180` 访问电脑上的开发服务。自定义 API 端口后，将示例命令和客户端地址中的 `5180` 换成所选端口。使用反向代理时，同步更新代理的后端端口。

跨网络部署时，在服务前配置 HTTPS 反向代理并将域名指向两台设备都可达的主机，例 `https://wallet.example.com`。证书须受原生客户端使用的公共信任根信任。API 可继续只监听代理所在主机的回环端口。客户端接受完整 HTTPS 服务地址，明文 HTTP 仅限回环地址。

## 账本归属与维护

在仓库根目录运行 `dotnet publish ./backend/SaveMyWallet.Api -c Release` 可生成部署文件。将 `backend/SaveMyWallet.Api/bin/Release/net10.0/publish/` 整个目录复制到安装了 ASP.NET Core 10 运行时的主机。在同一服务进程配置上文的数据库连接串、账本令牌和监听地址，再运行 `dotnet SaveMyWallet.Api.dll`。

服务通过 `Authorization: Bearer <token>` 确定访问哪个账本。每个 `LedgerTokens__<账本ID>` 对应一套账本，ID 使用 1–80 个英文字母、数字、下划线、点或短横线。不同账本使用不同令牌。同一令牌的持有者拥有该账本的读写权限。此版由管理员分发账本令牌，客户端重开后重新认证。更换同一账本 ID 的令牌并重启服务后，两端输入新令牌即可继续使用原账本。

生产环境将数据库连接串和账本令牌放入部署环境的秘密配置。备份 PostgreSQL 时连同账本、版本、变更日志和幂等回执一起备份，这些表共同决定设备重试和增量拉取的结果。客户端 JSON 导出用于迁移业务数据，服务恢复需要 PostgreSQL 备份。[客户端使用说明](../frontend/README.md)

## 接口和验证

[协议文档](docs/sync.md)包含兼容 Axios 的账本接口、明细作废与恢复、同步请求与响应、版本与游标的区别、断线重试及人工裁决示例。

在独立的测试数据库启动服务，设置两个不同令牌，分别映射到两个空测试账本。然后在仓库根目录运行黑盒集成测试。测试会写入测试数据，复跑时为这次运行配置新的空账本。

```powershell
$env:SMW_TEST_URL = 'http://127.0.0.1:5180'
$env:SMW_TEST_TOKEN_A = Read-Host '空测试账本 A 令牌' -MaskInput
$env:SMW_TEST_TOKEN_B = Read-Host '空测试账本 B 令牌' -MaskInput
node --test backend/tests/sync.integration.mjs
```

要验证两份独立 SQLite 均通过客户端的原生网络层与服务通信，另准备一个全新的空测试账本，在仓库根目录使用下列命令。此用例会模拟服务端成功提交后丢失回执、关闭并重开本地账本、重传分期和手动裁决两组补款冲突。

```powershell
$env:SMW_TEST_TOKEN = Read-Host '第三个空测试账本令牌' -MaskInput
cargo test --manifest-path frontend/src-tauri/Cargo.toml two_native_sqlite_replicas_sync_through_the_live_postgres_api --lib -- --ignored
```
