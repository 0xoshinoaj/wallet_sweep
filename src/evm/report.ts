import { writeFileSync } from 'node:fs'
import type { TxResult } from './execute.js'
import { formatAmount } from './plan.js'
import type { Decision, GasTopUp } from './types.js'
import { formatUsd, paint } from './util.js'

export function printPlan(decisions: Decision[], topUps: GasTopUp[], execute: boolean, receiver: string): void {
  const visible = decisions.filter((decision) => decision.holding.amount > 0n).sort(compareDecision)
  const sending = visible.filter((decision) => decision.action === 'send')
  const skipped = visible.filter((decision) => decision.action === 'skip')
  const total = sending.reduce((sum, decision) => sum + (decision.netValueUsd ?? 0), 0)

  if (topUps.length > 0 || visible.length > 0) console.log('')
  for (const topUp of topUps) {
    const amount = compactAmount(formatAmount(topUp.amount, topUp.nativeDecimals))
    console.log(
      `${paint('補 gas', 'yellow')}  ${topUp.chainName}  ${topUp.nativeSymbol}  ${amount}  給 ${topUp.wallet}  轉 ${topUp.symbols.join('、')}`,
    )
  }
  for (const decision of visible) console.log(formatDecisionLine(decision))

  console.log('')
  console.log(paint(`可轉 ${sending.length}/${visible.length} 筆，約 ${formatUsd(total)}`, 'green'))
  console.log(paint(`跳過 ${skipped.length} 筆`, 'red'))
  console.log(`接收地址 ${receiver}`)
  if (!execute) console.log('這次是模擬，沒有簽名，也沒有送出交易。')
}

export function printTxResults(results: TxResult[]): void {
  console.log('')
  for (const result of results) {
    const amount = compactAmount(result.amount)
    const label = result.kind === 'fund' ? (result.ok ? '已補 gas' : '補 gas 失敗') : result.ok ? '已送出' : '失敗'
    const color = result.ok ? 'green' : 'red'
    const detail = result.ok ? result.hash : result.error
    const owner = result.kind === 'fund' ? '' : `  來源 ${result.from}`
    console.log(`${paint(label, color)}  ${result.chainName}  ${result.symbol}  ${amount}${owner}  ${detail}`)
  }
  const ok = results.filter((result) => result.ok).length
  const failed = results.length - ok
  console.log(`${paint(`完成 ${ok} 筆`, 'green')}，${paint(`失敗 ${failed} 筆`, 'red')}`)
}

export function writePlan(path: string, decisions: Decision[]): void {
  const body = decisions.map((decision) => ({
    action: decision.action,
    reason: decision.reason,
    chain: decision.holding.chainName,
    chainId: decision.holding.chainId,
    from: decision.holding.wallet,
    kind: decision.holding.kind,
    symbol: decision.holding.symbol,
    token: decision.holding.token ?? null,
    amount: decision.amountFormatted,
    valueUsd: decision.netValueUsd,
    gasCostUsd: decision.gasCostUsd,
    source: decision.holding.source,
  }))
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`)
}

function formatDecisionLine(decision: Decision): string {
  const chain = decision.holding.chainName
  const symbol = decision.holding.symbol
  const amount = compactAmount(decision.amountFormatted)
  if (decision.action === 'skip') {
    return `${paint('跳過', 'red')}  ${chain}  ${symbol}  ${amount}  ${decision.reason}  來源 ${decision.holding.wallet}`
  }
  const value = formatUsd(decision.netValueUsd ?? decision.valueUsd)
  const gas = formatUsd(decision.gasCostUsd)
  return `${paint('送出', 'green')}  ${chain}  ${symbol}  ${amount}  ${value}  gas ${gas}  來源 ${decision.holding.wallet}`
}

function compactAmount(amount: string): string {
  if (!amount.includes('.')) return amount
  const [whole, fraction] = amount.split('.')
  const trimmed = fraction.slice(0, 8).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

function compareDecision(a: Decision, b: Decision): number {
  const chain = a.holding.chainName.localeCompare(b.holding.chainName)
  if (chain !== 0) return chain
  const wallet = a.holding.wallet.localeCompare(b.holding.wallet)
  if (wallet !== 0) return wallet
  if (a.holding.kind !== b.holding.kind) return a.holding.kind === 'erc20' ? -1 : 1
  return a.holding.symbol.localeCompare(b.holding.symbol)
}
