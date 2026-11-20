# 账本同步协议

Windows 和安卓始终从各自的 SQLite 读取账本。业务写入与待上传操作在同一本地事务中提交。网络故障时，页面可以继续保存账单。原生同步层将操作发送给 ASP.NET Core，PostgreSQL 保存共享账本、版本、变更顺序和提交回执。两端各自用同一套 TypeScript 规则重新计算月度应还、仍待还和预计结余。[本地账本仓库](../../frontend/src/data/repository.ts) · [后端启动与绑定设备](../README.md)

## 兼容现有账本接口

以下路径相对于部署时的服务地址，所有请求携带账本的 Bearer 令牌。JSON 字段用 camelCase，金额以整数分传递，月份为 `YYYY-MM`。

| 方法和路径 | 请求体 | 成功响应 |
| --- | --- | --- |
| `GET /ledger` | 无 | `200`，含 `platforms, entries, settings, salaryOverrides` 的完整账本 |
| `POST /platforms` | `{ "name": "京东白条" }` | `200 { "id": "…" }` |
| `POST /bills` | `{ "platformId": "p1", "title": "耳机", "month": "2026-12", "amountCents": 3200, "kind": "installment", "installmentCount": 12 }` | `204`。示例生成 12 期，每期 32 元 |
| `POST /bills/{id}/confirm` | `{ "title": "尾款", "month": "2027-01", "amountCents": 35000 }` | `204`。同一条预计补款原位确认，相同内容可重试，已确认且内容不同返回 `409` |
| `PUT /bills/{id}/voided` | `{ "voided": true }` 作废或 `{ "voided": false }` 恢复 | `204`。只变更指定明细，重复设置同一状态不会推进游标 |
| `PUT /bills/{id}/installment/voided` | `{ "voided": true }` 作废整笔分期，或 `{ "voided": false }` 恢复整笔分期。路径中的 ID 可取其中任意一期 | `200 { "changedIds": ["e1", "e3"] }`，按期次返回本次实际改变的明细 ID，所有变更在同一事务提交 |
| `PATCH /payments` | `{ "ids": ["e1", "e2"], "paid": true }` | `200 { "changedIds": ["e1"] }`，仅含此次实际改变的明细 |
| `PUT /budget` | `{ "month": "2027-01", "defaultSalaryCents": 600000, "warningFloorCents": 80000, "overrideSalaryCents": 0 }` | `204`。单月覆盖为 `0` 表示该月无工资，`null` 表示清除覆盖 |

写接口均可携带 `Idempotency-Key` 请求头。调用方为一次用户提交生成一个随机操作 ID，直到收到结果都重用这个 ID 和相同请求。缺少该请求头时，每次请求都是一次新的提交。业务接口与同步接口写入同一个账本，在线业务接口的改动也会进入增量流。当前 Vue 页面走 SQLite，原生同步使用下述协议，离线分期会带上已在设备中生成的各期 ID。[Axios 路径与类型](../../frontend/src/integrations/api/ledgerApi.ts)

使用现有 Axios 适配器直接在线提交分期时，可调用 `repository.createBill(input, operationId)`。调用方在第一次发送前保存这个 ID，遇到超时或响应丢失时传回同一个 ID。相同内容的两次独立消费各用一个 ID。客户端的离线同步由 SQLite 自动持久化操作 ID。

## 同步记录和版本

一条记录由 `(kind, id)` 标识。记录 ID 沿用历史字符串，最多 1,024 个 UTF-8 字节。记录的 `version` 是最近一次实际写入它的操作 ID。账本级 `cursor` 是服务端按提交顺序分配的游标。所有游标、记录和回执都属于令牌对应的账本。设备绑定后发送 `X-Ledger-Id`，便于服务端检查新输入的令牌与本机绑定是否一致。

| kind | id | value |
| --- | --- | --- |
| `platform` | 平台稳定 ID | `{id,name}` |
| `entry` | 单条明细的稳定 ID，每期一个 | `{id,platformId,title,month,amountCents,kind,status,installmentIndex,installmentCount}` |
| `setting` | `defaultSalaryCents` 或 `warningFloorCents` | 整数分 |
| `override` | 归属月，如 `2027-01` | 整数分，删除记录时为 `null` |

作废的 `entry` 在完整记录中增加 `"voided": true`，有效和恢复后的记录省略该字段。作废保留原状态、金额和分期期数，客户端在月度汇总中跳过该笔金额。批量还款跳过已作废明细，确认补款须先恢复。其他设备同期修改同一明细时，服务按完整记录的版本处理冲突。同步含作废明细的账本前，应将服务和各设备升级到支持该字段的版本。

新版生成的同一笔分期共用一个不可变的 `installmentId`（32 位小写十六进制），每期各有自己的明细 ID。同步可分批上传，同组期次须唯一，平台、标题、每期金额、总期数和首月须一致。旧分期保留原始字段。只有按上述信息能在无标识的旧分期中找到恰好一组完整期次时，才可整笔操作。整笔恢复会让每一期按原还款状态重新计入账本。同步新版分期前，应更新服务端和各设备客户端。

### 首次绑定

`GET /sync/bootstrap` 在一致的数据库读视图中返回 `{ledgerId,cursor,records}`。空云端的 `records` 为 `[]`。设备预览这个快照，再明确选择绑定。已有数据的云端会成为这台设备的新基线。若两台设备本来各有一份独立账本，先分别导出，选定首发设备。第二台绑定时会按快照替换本机内容，同时在本机保留最近一次被替换的账本备份。历史平台可能同名而 ID 不同，账单明细仍以各自 ID 标识。

确认绑定前，客户端会再次核对云端游标和本地 SQLite 的修改状态。预览期间另一个 Windows 实例改了账本时，需要重新预览。解锁的令牌只用于当时确认的服务地址和账本 ID。

空云端由首台设备以一个带有 `"seed": true` 的操作发布当前账本，原有平台及各期 ID 一并保留。两台设备同时看到空账本时，先到的首发成功，另一端收到 `409 seed_exists`。后一台仍保留自己的本地数据，可先导出，解除绑定后重新预览云端再决定。成功首发丢失回执则按原操作 ID 重试，取回首发回执。

### 上传一次原子操作

`POST /sync/push` 每次提交一个操作。新操作 ID 建议使用随机 UUID，服务接受 1–128 个英文字母、数字、下划线、点或短横线。每项变更携带修改前的完整记录值和版本，以及本次准备写入的完整值。下面示例为一个原来没有工资覆盖的月份新增 5,000 元工资。

```json
{
  "operationId": "7f36eab5-a91e-4ccc-9f20-d99f3bca9f3a",
  "changes": [
    {
      "kind": "override", "id": "2027-01", "baseVersion": null,
      "before": null, "after": 500000
    }
  ]
}
```

服务器锁定该账本，在一个事务中比较所有涉及记录的基线、执行业务校验、保存新值及提交回执。一次分期的多条明细同时成功或同时失败。成功返回 `200`。以下游标值仅作示例。

```json
{
  "operationId": "7f36eab5-a91e-4ccc-9f20-d99f3bca9f3a",
  "cursor": 8,
  "records": [
    {"kind":"override","id":"2027-01","value":500000,"version":"7f36eab5-a91e-4ccc-9f20-d99f3bca9f3a"}
  ],
  "changedIds": ["2027-01"]
}
```

若响应丢失，客户端重发持久化的同一个请求，服务端返回已保存的原回执。若当前值已与目标相同，这一条可以按已收敛处理，回传真实版本且不计入 `changedIds`。原子操作中只要有一项发生不能收敛的冲突，整批返回 `409`，回包含此批涉及的全部服务端现值。找不到的记录表示为 `value:null, version:null`，已删除的月工资覆盖则可带有删除操作的版本。

### 拉取其他设备的变更

`GET /sync/pull?cursor=7` 返回 `{ledgerId,cursor,records,hasMore}`。一页最多覆盖 64 次已提交变更，同一页内多次更改同一记录时返回最后值。某个操作触及的多条明细在同一页交付。`hasMore:true` 时用本页返回的游标继续请求。

设备在同一个 SQLite 事务内应用整页并推进拉取游标，保留仍待提交的本地编辑。重复接收一页或处理期间崩溃后重新拉取，已入账的分期仍使用原 ID。上传回执里的 `cursor` 描述服务器处理该请求时的位置。本地拉取游标仅在相应变更页已落盘后推进，否则可能跳过另一端刚提交的改动。

## 同一笔补款有两种金额或月份

以一笔 B 站预计补款为例，初始为 12 月、300 元，明细 ID 为 `e1`。Windows 与安卓都已拉到相同基线。

1. 两端断网。Windows 确认为 12 月、320 元，安卓确认为次年 1 月、350 元。它们分别保存一条修改 `e1` 的操作，金额、月份、标题和还款状态随整条明细提交。
2. Windows 先联网。服务器接受该操作并给 `e1` 赋予新版本。安卓随后用原版本上传时收到 `409`，响应形如 `{"code":"conflict","cursor":8,"records":[…]}`。安卓在 SQLite 中保留本地提议和服务器返回的候选，不生成第二笔账单。
3. 用户在「系统设置 → 账本数据 → 跨设备同步」核对两种金额及月份。「采用本机修改」使用冲突返回的服务器版本作为新基线，生成新操作 ID 后重新上传。「采用云端结果」丢弃这次冲突操作的本地提议，采用服务器的整条记录。如果服务器在决策期间又被修改，再次写入仍需通过版本校验。
4. 两端同步后，月度汇总按最后选择重新计算。如果最终选择 1 月、350 元，12 月不再计入这笔补款，1 月只计入 350 元一次。

客户端按记录的依赖关系上传。若某笔补款需要人工裁决，该笔明细后续的还款操作会等待选择，其他独立账单仍可上传和拉取。新建平台的操作先于引用该平台的账单。每次发出请求前，SQLite 会保存该次请求的完整内容。回执丢失或应用重启后，优先重传相同操作。

SQLite 结构 v4 增加作废标记，v5 增加可选的分期标识。升级保留原明细 ID、作废状态及已持久化的请求原文。已绑定的设备保留绑定、游标、待传操作和未解决的冲突。v1 账本首次同步仍须绑定。[本机迁移用例](../../frontend/src-tauri/src/ledger/sync/tests.rs)

分组勾选记录点击时的具体明细，另一台设备随后补录到该平台的账单仍待还。两端把同一笔都标为已还时，后到的一端可以收到空 `changedIds`。同步后的快捷撤销只保留仍属于本机这次操作的明细。

已绑定设备如要整本导入或重置，先处理仍想上传的改动，再解除绑定。解绑保留当前可见的本机账本，清除绑定、待上传操作和冲突，云端已有账本仍可供其他设备使用。

## 常见响应

| 响应 | 客户端处理 |
| --- | --- |
| `400` 请求不合法 | 检查字段、月份、整数分、平台引用和操作形式。整数分允许到 99,999,999,900，账单金额至少为 1，分期数为 1–120。 |
| `401` 令牌无效 | 重新输入该服务对应账本的令牌。保留本机待上传记录。 |
| `409 conflict` | 展示本机和云端完整候选，按选择执行人工裁决。 |
| `409 replay_mismatch` | 同一个操作 ID 已对应其他请求。核对本地操作记录和重试代码。 |
| `409 ledger_mismatch` | 令牌映射到的账本与已绑定的账本 ID 不符。核对服务地址并输入对应令牌。 |
| `409 duplicate_platform` / `already_confirmed` | 前者表示平台名冲突，后者表示在线确认接口收到了对已确认补款的另一组金额、月份或标题。 |
| `409 entry_voided` | 明细已作废，若仍需确认补款，先恢复这笔明细。 |
| `409 installment_group_unavailable` | 所选项目不是分期，或无法唯一确定其完整期次。可对单条明细执行作废或恢复。 |
| `409 seed_exists` | 另一台设备已经初始化该云端账本。重新预览后选择绑定来源。 |
| `409 invalid_cursor` | 游标超出服务端当前范围。先导出本地数据、核对服务地址与数据库恢复情况，再决定重新绑定。 |
| 请求超时、服务不可达 | 保留待传操作，在网络恢复后重用原操作 ID。 |

## 维护入口

| 改动 | 查看实现 |
| --- | --- |
| 部署配置、认证、建表与数据库版本 | [服务入口](../SaveMyWallet.Api/Program.cs) · [账本认证](../SaveMyWallet.Api/Middleware/LedgerAccess.cs) · [数据库初始化](../SaveMyWallet.Api/Infrastructure/Persistence/Schema.cs) |
| HTTP 接口与请求契约 | [业务路由](../SaveMyWallet.Api/Endpoints/LedgerEndpoints.cs) · [业务请求 DTO](../SaveMyWallet.Api/Dto/LedgerRequests.cs) · [同步路由](../SaveMyWallet.Api/Endpoints/SyncEndpoints.cs) · [同步 DTO](../SaveMyWallet.Api/Dto/SyncContract.cs) |
| 账务规则、同步读写与事务 | [账务命令](../SaveMyWallet.Api/Core/LedgerCommands.cs) · [账务校验](../SaveMyWallet.Api/Core/LedgerRules.cs) · [存储接口](../SaveMyWallet.Api/Interfaces/ISyncStore.cs) · [PostgreSQL 实现](../SaveMyWallet.Api/Infrastructure/Persistence/SyncStore.cs) |
| 本机待同步队列、绑定、冲突和网络重试 | [SQLite 同步表](../../frontend/src-tauri/src/schema_v2.sql) · [v3 迁移](../../frontend/src-tauri/src/schema_v3.sql) · [v4 明细作废标记](../../frontend/src-tauri/src/schema_v4.sql) · [v5 分期标识](../../frontend/src-tauri/src/schema_v5.sql) · [本机同步状态](../../frontend/src-tauri/src/ledger/sync.rs) · [原生网络请求](../../frontend/src-tauri/src/sync_client.rs) |
| 复核手动裁决及同步结果 | [设置页](../../frontend/src/features/settings/ConnectionsSettingsPage.vue) · [冲突选项](../../frontend/src/features/settings/SyncConflictCard.vue) · [HTTP 集成测试](../tests/sync.integration.mjs) |
