# PostgreSQL 数据库定义

服务端按账本隔离数据。当前记录供业务查询和写入，变更批次供设备增量拉取，操作回执供客户端丢失响应后重试。建表 SQL 定义物理结构，EF Core 映射供应用读写同一批表。[建表 SQL](../SaveMyWallet.Infrastructure/Persistence/Schema.cs) · [EF Core 映射](../SaveMyWallet.Infrastructure/Persistence/LedgerDb.cs)

## 表与键

| 表 | 主键 | 一行表示 |
| --- | --- | --- |
| `smw_schema` | `version` | 已安装的数据库结构版本 |
| `smw_ledgers` | `LedgerId` | 一个账本及其最新提交游标 |
| `smw_records` | `LedgerId, Kind, Id` | 一个业务记录的当前值和最后变更版本 |
| `smw_changes` | `LedgerId, Cursor` | 一次提交中实际改变的记录 |
| `smw_receipts` | `LedgerId, OperationId` | 一次已成功处理的写请求及其返回结果 |

`smw_records`、`smw_changes`、`smw_receipts` 的 `LedgerId` 均引用 `smw_ledgers.LedgerId`。一台设备可以根据相同的操作 ID 重试，另一账本可以独立使用该 ID。SQL 中的大小写列名需要双引号，表名和 `version` 列为小写。

## 当前记录

`smw_records.Kind` 区分四种记录。同一张表使用具名列存储这些变体，按 `Kind` 检查哪些列必填、哪些列必须为空。读取时，存储层将行映射为平台、账单、预算金额或已清除的覆盖记录。写入时，同一映射负责月份、枚举和作废标记的转换。[当前行实体](../SaveMyWallet.Dto/EntityDto/Ledger/StoredRecordEntityDto.cs) · [当前行映射](../SaveMyWallet.Infrastructure/Persistence/StoredRecords.cs)

| 列 | PostgreSQL 类型 | 用途与空值 |
| --- | --- | --- |
| `LedgerId` | `text` | 必填，所属账本 |
| `Kind` | `text` | 必填，`platform`、`entry`、`setting` 或 `override` |
| `Id` | `text` | 必填，1 至 1,024 字节，同一账本及记录类别内唯一 |
| `Version` | `text` | 必填，最近修改此记录的操作 ID |
| `PlatformName` | `text` | 平台记录必填，1 至 40 个字符，其余类别为空 |
| `PlatformId` | `text` | 账单必填，引用同一账本中平台记录的 `Id` |
| `Title` | `text` | 账单必填，1 至 120 个字符 |
| `BillMonth` | `date` | 账单必填，存储 1900-01 至 2099-12 之间月份的第一天。API 中的 `"2027-01"` 对应 SQL 的 `DATE '2027-01-01'` |
| `BillKind` | `text` | 账单必填，`single`、`installment` 或 `estimate` |
| `BillStatus` | `text` | 账单必填，`due`、`paid` 或 `estimated` |
| `AmountCents` | `bigint` | 账单金额、预算设置值或单月工资覆盖值，单位为分。平台行为空 |
| `InstallmentId` | `text` | 分期必填的组标识，32 位小写十六进制字符。同组各期共享此值，各有独立的 `Id`。其他账单类型为空 |
| `InstallmentIndex` | `integer` | 分期当前期号，从 1 起。其他账单类型为空 |
| `InstallmentCount` | `integer` | 分期总期数，1 至 120。其他账单类型为空 |
| `DepositCents` | `bigint` | 预计补款已付的正数定金，单位为分。无定金时为空 |
| `IsVoided` | `boolean` | 账单必填，有效时为 `false`，作废时为 `true`。其他类别为空 |
| `PlatformRecordKind` | `text` | PostgreSQL 自动生成并存储。有 `PlatformId` 时为 `platform`，其余行为空，供平台外键使用 |
| `PlatformNameKey` | `text COLLATE "C"` | PostgreSQL 自动生成并存储。将平台名中 ASCII 的 A–Z 转为小写，其余字符保留。无平台名时为空 |

记录类别决定以下读写行为。

- **平台**使用 `Id` 和 `PlatformName`。账单中的 `PlatformId` 指向同一账本的 `platform` 行。业务层在整批操作的最终平台集合中检查引用，因此一次操作可以同时创建平台和该平台的账单。
- **账单**使用每期应付金额。预计补款的商品总价通过 `AmountCents + COALESCE(DepositCents, 0)` 求得。作废保留原状态、金额和期次，恢复后继续按原状态计入账本。
- **预算设置**的 `Id` 取 `defaultSalaryCents` 或 `warningFloorCents`，`AmountCents` 必填。
- **单月工资覆盖**用 `YYYY-MM` 作为 `Id`。金额为 0 表示本月工资为零。清除现有覆盖会把金额写为 SQL `NULL`，保留行和删除操作的 `Version`，使离线设备能区分“未建立覆盖”和“覆盖已被删除”。

### 完整性约束与索引

| 约束或索引 | 数据库保证 |
| --- | --- |
| `smw_records_entry_fields`、`smw_records_name`、`smw_records_amount` | 按记录类别校验上述必填列。非账单记录的账单专用列必须为 SQL `NULL`，平台记录的金额必须为空 |
| `smw_records_platform_ref` | 自引用外键 `(LedgerId, PlatformRecordKind, PlatformId)` 指向 `(LedgerId, Kind, Id)`，确保账单引用同一账本的有效平台。延迟到提交时检查，允许同批先写账单再写平台 |
| `smw_records_platform_name` | `(LedgerId, PlatformNameKey)` 延迟唯一约束。同一账本不能有两个仅 ASCII 字母大小写不同的平台名。事务内可对调两个平台的名称 |
| `smw_records_budget_id` | 校验设置键和月份覆盖键，后者限于 1900-01 至 2099-12 |
| `smw_records_bill` 及金额列检查 | 金额均以整数分保存，最高为 99,999,999,900。每笔账单的金额加定金需在 1 至该上限之间。只有预计补款可以有定金或处于 `estimated` 状态。零尾款只允许用于定金已覆盖全款且状态为 `estimated` 或 `paid` 的预计补款 |
| `smw_records_period`、`smw_records_installment_period` | 分期的组标识、总期数、当前期号均必填，期号介于 1 和总期数之间。`InstallmentId IS NOT NULL` 的行受 `(LedgerId, InstallmentId, InstallmentIndex)` 部分唯一索引约束，避免同组出现两条相同期次 |

各主键都有唯一索引。读取某个账本的一页变更可以使用 `smw_changes` 的 `(LedgerId, Cursor)` 索引，查询同一分期组可以使用上述部分唯一索引。同组的金额、标题、平台、总期数及推算出的首月是否一致，由 Core 在写事务中校验。[分期规则](../SaveMyWallet.Core/InstallmentSeries.cs)

## 版本、账本、批次与回执

| 表 | 列 | PostgreSQL 类型 | 定义 |
| --- | --- | --- | --- |
| `smw_schema` | `version` | `integer` | 主键，当前库结构版本为 2 |
| `smw_ledgers` | `LedgerId` | `text` | 主键，由令牌配置确定 |
| `smw_ledgers` | `Cursor` | `bigint` | 必填，非负整数 |
| `smw_changes` | `LedgerId` | `text` | 必填，所属账本 |
| `smw_changes` | `Cursor` | `bigint` | 必填，该批次提交后账本的游标 |
| `smw_changes` | `Records` | `jsonb` | 必填，该批实际改变的同步记录数组，每条包含 `kind`、`id`、`value` 和 `version` |
| `smw_receipts` | `LedgerId` | `text` | 必填，所属账本 |
| `smw_receipts` | `OperationId` | `text` | 必填，本次操作 ID |
| `smw_receipts` | `Request` | `jsonb` | 必填，同步写入保存请求，REST 写入保存操作与输入的指纹，用于判断是否为同一次重试 |
| `smw_receipts` | `Response` | `jsonb` | 必填，保存成功响应。HTTP 204 对应 JSON 字面量 `null` |

## 建库与版本检查

将 `ConnectionStrings__Ledger` 指向一个新的专用 PostgreSQL 数据库。API 启动时在独立的依赖注入作用域内开启事务，通过 PostgreSQL 事务级 advisory lock 串行执行结构检查和建表，再开始接收 HTTP 请求。如果目标库已使用其他结构版本，启动会失败。本次部署应配置新库，已有库的记录和回执保留在原处。[初始化入口](../SaveMyWallet.Infrastructure/LedgerPersistence.cs) · [配置与启动](../README.md)

## 游标、记录版本与回执

假设账本游标为 7，客户端用操作 ID `op-a` 一次写入两期账单。两条记录的 `Version` 都成为 `op-a`，账本游标只推进到 8，`smw_changes` 在游标 8 处写入包含这两期的一个批次。随后重发同一请求会从 `smw_receipts` 取得原结果。若一个新操作申请写入的所有值都已经生效，服务仍保存其成功回执，游标和现有记录版本保持原值。

| 字段 | 生成方式 | 客户端用途 |
| --- | --- | --- |
| `smw_ledgers.Cursor` | 初始为 0，每次有实质变更的提交加 1 | 选择从哪个提交开始拉取 |
| `smw_records.Version` | 最近一次真正改变该行的操作 ID | 离线编辑提交时填写 `baseVersion`，同时提交编辑前的完整值 |
| `smw_receipts.OperationId` | 同步请求携带，REST 写入可通过 `Idempotency-Key` 携带 | 重试同一请求时使用同一个 ID |

### 写入和读取的一致性

1. 写请求在 `READ COMMITTED` 事务中按需创建账本头，并通过 `SELECT … FOR UPDATE` 锁定该账本。对同一账本的并发写入依次获取这把锁。
2. 先查操作回执。同一操作 ID 和等价请求直接返回保存的结果，内容不同返回 `409 replay_mismatch`。首发操作要求账本游标为 0。
3. 对仍需修改的记录，同时核对提交的基线版本与修改前的值。基线不一致时返回 `409 conflict`。Core 校验整批业务规则，所有检查通过后才保存记录、批次、账本游标和回执。提交前出错时事务回滚，可使用原操作 ID 重试。
4. `/sync/bootstrap` 与 `/sync/pull` 都以 `REPEATABLE READ` 读取游标和数据。增量按游标升序，一页最多取 64 个完整批次。页内同一记录有多次更新时，只返回该页内的最后一个值。

恢复数据库时，账本头、当前记录、变更批次和操作回执需要来自同一份一致性备份。单独恢复当前记录，无法重建离线设备的拉取位置和已处理请求的回执。[存储事务](../SaveMyWallet.Infrastructure/Persistence/SyncStore.cs) · [同步协议](sync.md)

## 常用只读查询

以下示例使用账本 `personal` 和 2027 年 1 月，可替换为开发库中实际使用的值。

查询该月仍待还且有效的账单，金额单位为分。

```sql
SELECT "Id", "PlatformId", "Title", "AmountCents"
FROM smw_records
WHERE "LedgerId" = 'personal'
  AND "Kind" = 'entry'
  AND "BillMonth" = DATE '2027-01-01'
  AND "BillStatus" = 'due'
  AND "IsVoided" = false
ORDER BY "PlatformId", "Id";
```

查看该账本最近的提交，每批按实际记录数计数，包括清除工资覆盖的记录。

```sql
SELECT "Cursor", jsonb_array_length("Records") AS changed_records
FROM smw_changes
WHERE "LedgerId" = 'personal'
ORDER BY "Cursor" DESC
LIMIT 10;
```
