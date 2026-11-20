import { dotnet } from './_framework/dotnet.js'

let calculate

export default async function initialize() {
  const runtime = await dotnet.create()
  const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)
  calculate = exports.SaveMyWallet.Wasm.MonthlyCalculator.Summarize
}

export function summarize(ledger, month) {
  const summary = JSON.parse(calculate(JSON.stringify(ledger), month))
  // Reuse the original platform and entry objects, including all display fields.
  summary.groups = summary.groups.map(({ platformIndex, entryIndices, ...amounts }) => ({
    ...amounts,
    platform: ledger.platforms[platformIndex],
    entries: entryIndices.map(index => ledger.entries[index]),
  }))
  return summary
}
