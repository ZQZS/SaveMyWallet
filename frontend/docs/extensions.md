# 接入扩展

应用启动时向 `createLedgerSession` 注入 `repository` 和 `calculateMonth`。账本保存在本机 SQLite，当月清单、下月预览和预算预览共用 TypeScript 的 `summarize`。页面通过账本会话使用这两个依赖。

桌宠素材和动作契约见[桌宠开发说明](pets.md)。用户自带密钥的模型调用、图片输入和识别草稿另见[AI 功能开发说明](ai-features.md)。

## Axios 后端

`src/integrations/api/ledgerApi.ts` 提供在线调用账本接口的 Axios 实例和 `LedgerRepository` 适配器。ASP.NET Core 服务通过账本访问令牌认证。使用适配器的集成程序需配置 `Authorization: Bearer <token>`。Windows 和安卓应用通过 Tauri 读写 SQLite，跨设备同步走原生层的增量接口。[后端部署](../../backend/README.md) · [同步协议](../../backend/docs/sync.md)

```ts
const client = createApiClient(baseURL)
const repository = createApiLedgerRepository(client)
const session = createLedgerSession({ repository, calculateMonth: summarize })
```

下表是适配器约定的 JSON 接口。地址相对于传入的 `baseURL`，金额以分为单位。服务端路径或响应格式有变动时，在这个适配器内做映射即可。

| 操作 | 请求 | 成功响应 |
| --- | --- | --- |
| 读账本 | `GET /ledger` | `LedgerData` |
| 新增平台 | `POST /platforms`，提交 `{ name }` | `{ id }` |
| 新增账单 | `POST /bills`，提交 `BillInput` | 2xx |
| 批量新增账单 | `POST /bills/batch`，提交非空 `BillInput[]`。指定 `installmentIndex` 的单笔也使用此端点，从指定期次和还款月开始生成剩余期数。 | 204，整批同时入账 |
| 确认补款 | `POST /bills/{id}/confirm`，提交 `{ title, month, totalCents, depositCents, amountCents }`。金额以分为单位，`amountCents` 等于总价减定金。 | 2xx |
| 作废或恢复单条明细 | `PUT /bills/{id}/voided`，提交 `{ voided: true }` 或 `{ voided: false }` | 204 |
| 作废或恢复整笔分期 | `PUT /bills/{id}/installment/voided`，以任一期的明细 ID 提交 `{ voided: true }` 或 `{ voided: false }` | `{ changedIds }`，按期次返回实际变更的 ID |
| 勾选或取消还款 | `PATCH /payments`，提交 `{ ids, paid }` | `{ changedIds }`，仅含此次实际变更的明细 |
| 保存预算 | `PUT /budget`，提交 `BudgetInput` | 2xx |

在线创建账单或批量导入时，可在重试同一次提交时向 `createBill` 或 `createBills` 再次传入原操作 ID，适配器将其放入 `Idempotency-Key` 请求头。双端原生同步会将本地已经分配的每期明细 ID 一起上传，操作 ID 与回执共同处理断线重试。调试首绑、拉取游标或补款冲突时请使用同步接口。[增量请求与响应](../../backend/docs/sync.md)

## WASM 月度计算

可选的 .NET 模板实现了与前端一致的 `summarize(ledger, month)`。输入是 `LedgerData` 快照和 `YYYY-MM` 月份，输出的 `MonthlySummary` 含工资、预计结余、三种还款状态的金额及各平台明细，金额单位均为分。[数据类型](../src/domain/ledger.ts)

在 `frontend/` 运行 `npm run build:wasm` 可独立构建模板。使用时从发布目录导入 `monthly.js`，等待异步初始化后即可同步调用汇总函数。`npm run test:wasm` 会构建模板并用同一批账本核对两种实现。[构建与调用示例](../../wasm-lib/README.md) · [加载器](../src/integrations/wasm/monthlyCalculator.ts)

## 数据采集脚本

每个数据源在 `scripts/collectors/` 中实现自己的 `BillCollector<Input>`。输出是 `CollectedBill[]` 草稿，包含来源 `source`、外部账单编号 `externalId`、平台名 `platformName`，以及款项名称、还款月份、金额、类型和期数。`source` 与 `externalId` 可用于后续导入时识别重复记录。平台名在审核时映射到用户账本中的平台 ID。

以下命令运行本地示例，从示例导出记录生成 JSON 并打印到标准输出。示例使用与记账表单相同的金额和月份校验。采集器独立于客户端启动流程，后续可在此目录接入实际来源和调度。

```powershell
node --experimental-strip-types scripts/collectors/local-example.ts
```
