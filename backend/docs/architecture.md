# 后端结构与开发指南

服务把账单、平台、还款和预算命令写入共享账本。Windows 和安卓的离线编辑也通过同一个后端提交。两条写入路径共用账务校验和 PostgreSQL 事务，因此 REST 改了一笔还款，设备下次拉取增量就能收到这条变更。

## 项目与依赖

所有项目属于一个 .NET 10 解决方案。表中省略项目名的 `SaveMyWallet.` 前缀，第三列为各 `.csproj` 声明的直接项目引用。[解决方案](../SaveMyWallet.slnx) · [共享构建配置](../Directory.Build.props)

| 项目 | 职责 | 直接引用 |
| --- | --- | --- |
| `Api` | 服务入口、依赖注入、账本身份校验、HTTP 绑定、状态码和错误响应 | `Core`、`Dto`、`Infrastructure`、`Interfaces`、`Services` |
| `Services` | 实现 `ILedgerService` 和 `ISyncService`，组织读取与写入用例，生成 REST 请求指纹 | `Constant`、`Core`、`Dto`、`Interfaces` |
| `Core` | 生成账务变更，验证整批写入、金额、状态转换、分期一致性及同步请求 | `Constant`、`Dto` |
| `Interfaces` | 声明两个业务服务接口及 `ISyncStore` 存储接口 | `Dto` |
| `Infrastructure` | 实现 `ISyncStore`，持有 EF Core 上下文、记录映射、PostgreSQL 建表与事务代码 | `Constant`、`Core`、`Dto`、`Interfaces` |
| `Dto` | 定义数据库实体、请求和结果类、业务枚举，以及 JSON 协议的序列化规则 | 无 |
| `Constant` | 提供金额上限、预算设置键和同步拉取分页大小 | 无 |

## 数据结构

普通 DTO 使用 C# `class`，按用途选择以下三类，再按业务放进子目录。直接以类型名定位定义即可，业务子目录中的类共用其类别命名空间。

| 目录与类型后缀 | 继承关系 | 示例 |
| --- | --- | --- |
| `EntityDto/`、`*EntityDto` | `EntityBase` 实现 `IEntity` | `Ledger/StoredRecordEntityDto` 映射当前记录，`Sync/SyncRecordEntityDto` 表达带版本的记录。 |
| `QueryDto/`、`*QueryDto` | `QueryBase` 实现 `IQuery` | `Payments/PaymentQueryDto` 接收还款请求，`Sync/SyncChangeQueryDto` 携带一次记录变更。 |
| `QueryResultDto/`、`*QueryResultDto` | `QueryResultBase` 实现 `IQueryResult` | `Bills/ChangedIdsQueryResultDto` 返回实际变动的明细 ID，`Sync/PushQueryResultDto` 返回提交回执。 |

同步协议以外层 `kind` 选择 `value`、`before` 和 `after` 的结构。`SyncChangeQueryDto` 和 `SyncRecordEntityDto` 以 `LedgerValueQueryResultDto` 表示记录值，业务层使用下表中具体类的属性。响应按类型生成 `SyncRecordQueryResultDto<T>`，其中平台和账单序列化为对象，预算的 `T` 为 `long?`，金额直接以整数分传输。[记录值基类](../SaveMyWallet.Dto/QueryResultDto/Ledger/LedgerValueQueryResultDto.cs) · [请求转换](../SaveMyWallet.Dto/QueryDto/Sync/SyncChangeQueryDtoConverter.cs) · [结果转换](../SaveMyWallet.Core/SyncRecordResults.cs)

| 外层记录种类 | 非空记录值的 C# 类型 | 典型属性 |
| --- | --- | --- |
| `SyncRecordKind.Platform` | `PlatformQueryResultDto` | `Id`、`Name` |
| `SyncRecordKind.Entry` | `BillEntryQueryResultDto` | `PlatformId`、`AmountCents`、`Kind`、`Status` |
| `SyncRecordKind.Setting`、`Override` | `AmountQueryResultDto` | `Cents`。月工资覆盖可以删除，值为 `null` 时仍可保留删除版本。 |

账单内部的 `BillKind` 决定它是单笔、分期或预计补款，`BillStatus` 记录预计、待还或已还状态。每条分期记录都必须带有 `InstallmentId`，同一次消费的各期共用这个值，各期还有独立的 `Id` 和 `InstallmentIndex`。[账单结构](../SaveMyWallet.Dto/QueryResultDto/Bills/BillEntryQueryResultDto.cs)

HTTP 字段和枚举值按 camelCase 拼写，金额用整数分，月份按 `YYYY-MM` 传递。DTO 项目定义 JSON 读写规则，API 将形状错误的请求映射为 HTTP 400。当前账单在 PostgreSQL 中使用具名列，例如 `BillMonth` 存该月第一天，`AmountCents` 存整数分。变更批次和回执保留 JSONB 快照。[序列化配置](../SaveMyWallet.Dto/Serialization/LedgerJson.cs) · [错误处理](../SaveMyWallet.Api/Middleware/LedgerErrorMiddleware.cs) · [数据库定义](database.md)

## 一次还款如何提交

1. 客户端向 `PATCH /payments` 提交明细 ID 和目标还款状态。`LedgerAccess` 根据令牌确定账本。路由读取 `Idempotency-Key`，调用方省略时为本次调用分配新的操作 ID。[认证](../SaveMyWallet.Api/Middleware/LedgerAccess.cs) · [账本路由](../SaveMyWallet.Api/Endpoints/LedgerEndpoints.cs)
2. `LedgerService.PayAsync` 将操作 ID、请求指纹及执行账务命令的委托传给 `ISyncStore`。存储实现先锁定该账本并检查操作回执。同一操作重试时返回已提交的结果。[账本服务](../SaveMyWallet.Services/LedgerService.cs) · [存储接口](../SaveMyWallet.Interfaces/ISyncStore.cs)
3. `LedgerCommands.Pay` 从当前记录构造变更，每条包含操作前的版本和值，以及操作后的值。被作废的账单、零尾款和已经处于目标状态的账单会跳过。更新已有账单时须保留独立的 `before` 快照供冲突判断。[账务命令](../SaveMyWallet.Core/LedgerCommands.cs)
4. `SyncStore` 核对基线和业务规则，在同一事务中写入实际改变的记录、游标、变更批次和操作回执。只有实际变更才推进游标，`changedIds` 列出这次改变的明细。同步上传走 `SyncService.PushAsync`，由设备提供变更集，进入同一个事务流程。[业务规则](../SaveMyWallet.Core/LedgerRules.cs) · [同步服务](../SaveMyWallet.Services/SyncService.cs) · [存储实现](../SaveMyWallet.Infrastructure/Persistence/SyncStore.cs)

`GET /ledger` 按平台、账单和预算组织快照。`GET /sync/bootstrap` 返回包含记录版本和账本游标的快照。`GET /sync/pull` 按游标读取已提交的批次。同步冲突响应会返回服务端当前版本和值，供设备裁决下一次写入。[协议与交互示例](sync.md)

## 生命周期与事务边界

API 为每个 HTTP 请求提供依赖注入作用域，`ILedgerService`、`ISyncService`、`ISyncStore` 和 `LedgerDb` 按作用域解析。启动阶段初始化数据库时使用独立的异步作用域。数据库事务在存储层以 `await using` 持有，失败或取消时退出事务，请求结束后由容器释放上下文。将来增加后台任务时，每次任务创建自己的作用域，并把取消令牌传给存储操作。[服务注册](../SaveMyWallet.Api/Program.cs) · [数据库注册与初始化](../SaveMyWallet.Infrastructure/LedgerPersistence.cs)

## 扩展一项账务字段

以账单定金 `depositCents` 为例，一项既要存储又能同步的字段会涉及如下位置。

1. 在对应请求类及账单值上声明字段和可空规则。协议中的缺失与显式 `null` 有区别时，补充转换与输入用例。在账单值的 `HasSameValue` 纳入该字段，让同步可以识别它的变更。[账单值](../SaveMyWallet.Dto/QueryResultDto/Bills/BillEntryQueryResultDto.cs)
2. 在 `LedgerCommands` 设置值，在 `LedgerRules` 校验金额与状态的组合约束。离线上传和 REST 录入都须经过这些约束。[校验规则](../SaveMyWallet.Core/LedgerRules.cs)
3. 在当前记录行、行与记录值的双向映射、建表 DDL 中补齐列及约束。同步更新数据库定义和对外协议文档。[当前记录行](../SaveMyWallet.Dto/EntityDto/Ledger/StoredRecordEntityDto.cs) · [双向映射](../SaveMyWallet.Infrastructure/Persistence/StoredRecords.cs) · [建表代码](../SaveMyWallet.Infrastructure/Persistence/Schema.cs)
4. 通过真实 API 验证录入、快照回读、跨设备增量拉取、重复提交及过期基线。测试中核对金额和版本，并确认失败的批次未推进游标。[黑盒测试](../tests/sync.integration.mjs)

## 构建与验证

从仓库根目录恢复锁定依赖并构建发布配置。

```powershell
dotnet restore ./backend/SaveMyWallet.slnx --locked-mode
dotnet build ./backend/SaveMyWallet.slnx -c Release --no-restore
```

按 README 启动 API，连接专用测试 PostgreSQL，为两个空账本设置不同令牌，再运行 `node --test backend/tests/sync.integration.mjs`。涉及离线客户端时，可继续运行 README 中的双 SQLite 副本联调。两个测试入口都会提交真实写入。[启动与测试环境变量](../README.md)
