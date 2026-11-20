# wasm-lib · .NET WebAssembly 模板

本模板以月度账本为例，演示 JavaScript 调用 .NET 10 WebAssembly 导出的 C# 函数。应用的当月清单、下月预览和预算预览直接使用 TypeScript 的 `summarize`，也用它对照模板返回的整数分金额、平台分组和明细顺序。[前端类型与汇总实现](../frontend/src/domain/ledger.ts)

## 构建与验证

构建模板需要 .NET 10 SDK、`wasm-tools` 工作负载和 Node.js 22.18 或更高版本。安装 SDK 后运行一次 `dotnet workload install wasm-tools`。首次发布会还原所需的 NuGet 包。在仓库根目录运行以下命令。

```powershell
Set-Location .\frontend
npm ci
npm run test:wasm
```

`npm run test:wasm` 先构建模板，再加载实际 WASM 模块与 TypeScript 对照。单独构建可运行 `npm run build:wasm`。静态产物位于 `wasm-lib/bin/template/wwwroot/`，其中 `monthly.js` 是 JavaScript 入口，`_framework/` 包含 .NET 运行时和程序集。

如果工作目录里还有旧版构建生成的 `frontend/public/wasm/`，请将该目录移出 `frontend/public/`，避免 Vite 把旧运行时复制到应用包。

## 调用示例

在与发布产物 `monthly.js` 同目录的 ES 模块中导入入口，等待运行时初始化一次后，就可以同步计算任意月份。以下示例使用空账本，预计结余为默认工资 600,000 分。

```js
import initialize, { summarize } from './monthly.js'

await initialize()
const ledger = {
  platforms: [], entries: [], salaryOverrides: {},
  settings: { defaultSalaryCents: 600000, warningFloorCents: 0 },
}
const december = summarize(ledger, '2026-12')
console.log(december.balance) // 600000
```

C# 按月和平台计算金额，返回每组的平台与明细下标。JavaScript 用这些下标取回输入快照中的原对象，因此页面可以继续使用账单标题、分期期数等展示字段。[C# 计算实现](MonthlyCalculator.cs) · [JavaScript 适配器](wwwroot/monthly.js) · [.NET 工程](SaveMyWallet.Wasm.csproj)
