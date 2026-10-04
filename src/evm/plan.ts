import { encodeFunctionData, erc20Abi, formatUnits, type Address, type PublicClient } from 'viem'
import { assignGasBudget, opStackBuffer, topUpForShortfall, type BudgetSlot } from './budget.js'
import { quoteFee } from './fees.js'
import {
  assessPrice,
  isScamReputation,
  looksLikeSpamToken,
  scaleGas,
  usdOf,
  worthTransferring,
} from './filters.js'
import type { AppConfig, Decision, FeeQuote, GasTopUp, Holding, PriceQuote, SecurityVerdict } from './types.js'
import { groupKey, mapPool, shortError, withTimeout } from './util.js'

export async function buildDecisions(options: {
  holdings: Holding[]
  prices: Map<string, PriceQuote>
  security: Map<string, SecurityVerdict>
  config: AppConfig
  clients: Map<string, PublicClient>
  gasProvider?: Address
}): Promise<{ decisions: Decision[]; topUps: GasTopUp[] }> {
  const nowSec = Math.floor(Date.now() / 1000)
  const feePromises = new Map<string, Promise<FeeQuote>>()
  const drafts = await mapPool(options.holdings, options.config.concurrency, async (holding) => {
    try {
      return await evaluateHolding(holding, options, nowSec, feePromises)
    } catch (error) {
      return skip(holding, `轉帳模擬失敗：${shortError(error)}`)
    }
  })

  const groups = new Map<string, Decision[]>()
  for (const decision of drafts) {
    const key = groupKey(decision.holding.chainId, decision.holding.wallet)
    const group = groups.get(key) ?? []
    group.push(decision)
    groups.set(key, group)
  }

  const topUps: GasTopUp[] = []
  for (const group of groups.values()) {
    const topUp = planTopUp(group, options, nowSec)
    if (topUp) topUps.push(topUp)
    const slots = new Map<Decision, BudgetSlot>()
    const budgetSlots = group.map((decision) => {
      const balance =
        decision.holding.kind === 'native' ? decision.holding.amount + (topUp?.amount ?? 0n) : 0n
      const slot: BudgetSlot = {
        kind: decision.holding.kind,
        action: decision.action,
        reason: decision.reason,
        netValueUsd: decision.netValueUsd ?? 0,
        costWei: decision.costWei,
        balanceWei: balance,
        sendWei: decision.sendAmount ?? 0n,
      }
      slots.set(decision, slot)
      return slot
    })
    assignGasBudget(budgetSlots)
    for (const decision of group) {
      const slot = slots.get(decision)!
      decision.action = slot.action
      decision.reason = slot.reason
      decision.sendAmount = slot.sendWei
      if (decision.forceSweep) {
        decision.action = 'send'
        decision.reason = '清空剩下的原生幣'
        const sendAmount = decision.sendAmount ?? 0n
        decision.amountFormatted = formatAmount(sendAmount, decision.holding.decimals)
        const priced = assessPrice(options.prices.get(decision.holding.nativePriceId), {
          minConfidence: options.config.minPriceConfidence,
          maxAgeSec: options.config.maxPriceAgeSec,
          nowSec,
        })
        if (priced.price != null && sendAmount > 0n) {
          const netValueUsd = usdOf(sendAmount, decision.holding.decimals, priced.price)
          decision.netValueUsd = Number.isFinite(netValueUsd) ? netValueUsd : null
          decision.valueUsd = decision.netValueUsd
        }
        continue
      }
      if (decision.holding.kind === 'native' && decision.action === 'send') {
        applyNativeValue(decision, options, nowSec)
      }
    }
  }

  return {
    decisions: drafts.filter((decision) => decision.holding.amount > 0n || decision.forceSweep === true),
    topUps,
  }
}

function planTopUp(
  group: Decision[],
  options: {
    prices: Map<string, PriceQuote>
    config: AppConfig
    gasProvider?: Address
  },
  nowSec: number,
): GasTopUp | null {
  if (!options.gasProvider) return null
  const native = group.find((decision) => decision.holding.kind === 'native')
  if (!native) return null
  const wallet = native.holding.wallet
  if (wallet.toLowerCase() === options.gasProvider.toLowerCase()) return null
  if (wallet.toLowerCase() === options.config.receiver.toLowerCase()) return null

  const tokens = group.filter(
    (decision) => decision.holding.kind === 'erc20' && decision.action === 'send' && decision.costWei > 0n && decision.fee,
  )
  if (tokens.length === 0) return null

  const priced = assessPrice(options.prices.get(native.holding.nativePriceId), {
    minConfidence: options.config.minPriceConfidence,
    maxAgeSec: options.config.maxPriceAgeSec,
    nowSec,
  })
  if (priced.price == null) return null

  const buffer = opStackBuffer(native.holding.chainId)
  const fee = tokens[0].fee!
  const sweepGas =
    native.costWei > 0n ? native.costWei : scaleGas(21_000n, options.config.gasCostMultiplier) * fee.feePerGas
  const need = tokens.reduce((sum, decision) => sum + decision.costWei + buffer, 0n) + sweepGas + buffer
  const amount = topUpForShortfall(native.holding.amount, need)
  if (amount === 0n) return null

  const topUpGas = sweepGas + buffer
  const burnedUsd = usdOf(amount + topUpGas, native.holding.nativeDecimals, priced.price)
  const totalValue = tokens.reduce((sum, decision) => sum + (decision.netValueUsd ?? 0), 0)
  if (!(totalValue > burnedUsd)) return null

  native.action = 'send'
  native.forceSweep = true
  native.reason = '清空剩下的原生幣'
  if (native.costWei <= 0n) native.costWei = sweepGas

  return {
    chainKey: native.holding.chainKey,
    chainId: native.holding.chainId,
    chainName: native.holding.chainName,
    wallet,
    amount,
    nativeSymbol: native.holding.symbol,
    nativeDecimals: native.holding.decimals,
    symbols: tokens.map((decision) => decision.holding.symbol),
  }
}

async function evaluateHolding(
  holding: Holding,
  options: {
    prices: Map<string, PriceQuote>
    security: Map<string, SecurityVerdict>
    config: AppConfig
    clients: Map<string, PublicClient>
  },
  nowSec: number,
  feePromises: Map<string, Promise<FeeQuote>>,
): Promise<Decision> {
  const { config } = options
  if (holding.wallet.toLowerCase() === config.receiver.toLowerCase()) {
    return skip(holding, '這個地址就是接收錢包')
  }
  if (holding.amount === 0n) return skip(holding, '餘額為 0')

  if (holding.kind === 'erc20' && !holding.allowlisted) {
    if (looksLikeSpamToken(holding.name, holding.symbol)) return skip(holding, '名稱像空投或釣魚連結')
    if (isScamReputation(holding.reputation)) return skip(holding, '瀏覽器把這個代幣標成詐騙')
  }

  const asset = assessPrice(options.prices.get(holding.priceId), {
    minConfidence: config.minPriceConfidence,
    maxAgeSec: config.maxPriceAgeSec,
    nowSec,
    assumedUsd: holding.assumedUsd,
  })
  if (asset.price == null) return skip(holding, asset.reason ?? '沒有可信價格')

  const native = assessPrice(options.prices.get(holding.nativePriceId), {
    minConfidence: config.minPriceConfidence,
    maxAgeSec: config.maxPriceAgeSec,
    nowSec,
  })
  if (native.price == null) return skip(holding, '沒有原生幣價格，無法比較 gas')

  let sellTax = 0
  if (holding.kind === 'erc20' && (!holding.allowlisted || config.screenAllowlist)) {
    const verdict = holding.token ? options.security.get(`${holding.chainId}:${holding.token.toLowerCase()}`) : undefined
    if (!verdict?.known || verdict.rejectReason) {
      return skip(holding, verdict?.rejectReason ?? '沒有安全檢查資料')
    }
    sellTax = verdict.sellTax
  }

  const client = options.clients.get(holding.chainKey)
  if (!client) return skip(holding, '找不到這條鏈的 RPC')

  const fee = await chainFee(feePromises, holding.chainKey, client)
  const estimated = await estimateTransfer(client, holding, config.receiver)
  const gasLimit = scaleGas(estimated, config.gasCostMultiplier)
  if (gasLimit > config.maxGasLimit) {
    return skip(holding, `預估 gas ${gasLimit} 超過上限 ${config.maxGasLimit}`)
  }

  const costWei = gasLimit * fee.feePerGas
  const gasCostUsd = usdOf(costWei, holding.nativeDecimals, native.price)
  const decision = baseDecision(holding, asset.price, sellTax, gasCostUsd, gasLimit, costWei, fee)

  if (holding.kind === 'native') {
    decision.action = 'send'
    decision.reason = '可轉'
    decision.sendAmount = holding.amount
    return decision
  }

  const netValueUsd = usdOf(holding.amount, holding.decimals, asset.price, sellTax)
  decision.netValueUsd = Number.isFinite(netValueUsd) ? netValueUsd : null
  decision.valueUsd = decision.netValueUsd
  const reason = worthTransferring(netValueUsd, gasCostUsd, config.minTransferUsd, config.minValueToGasRatio)
  if (reason) return { ...decision, action: 'skip', reason }
  decision.action = 'send'
  decision.reason = '可轉'
  decision.sendAmount = holding.amount
  return decision
}

function applyNativeValue(
  decision: Decision,
  options: { prices: Map<string, PriceQuote>; config: AppConfig },
  nowSec: number,
): void {
  const sendAmount = decision.sendAmount ?? 0n
  const priced = assessPrice(options.prices.get(decision.holding.nativePriceId), {
    minConfidence: options.config.minPriceConfidence,
    maxAgeSec: options.config.maxPriceAgeSec,
    nowSec,
  })
  if (priced.price == null || sendAmount === 0n) {
    decision.action = 'skip'
    decision.reason = '扣掉 gas 後沒有可轉的原生幣'
    decision.sendAmount = 0n
    return
  }
  const netValueUsd = usdOf(sendAmount, decision.holding.decimals, priced.price)
  decision.netValueUsd = Number.isFinite(netValueUsd) ? netValueUsd : null
  decision.valueUsd = decision.netValueUsd
  decision.amountFormatted = formatAmount(sendAmount, decision.holding.decimals)
  const reason = worthTransferring(
    netValueUsd,
    decision.gasCostUsd ?? Number.NaN,
    options.config.minTransferUsd,
    options.config.minValueToGasRatio,
  )
  if (reason) {
    decision.action = 'skip'
    decision.reason = reason
    decision.sendAmount = 0n
  }
}

function chainFee(
  feePromises: Map<string, Promise<FeeQuote>>,
  chainKey: string,
  client: PublicClient,
): Promise<FeeQuote> {
  const existing = feePromises.get(chainKey)
  if (existing) return existing
  const pending = withTimeout(quoteFee(client), 30_000, `${chainKey} 的 gas 價格`)
  feePromises.set(chainKey, pending)
  return pending
}

async function estimateTransfer(client: PublicClient, holding: Holding, receiver: Address): Promise<bigint> {
  if (holding.kind === 'native') {
    try {
      return await withTimeout(
        client.estimateGas({
          account: holding.wallet,
          to: receiver,
          value: holding.amount > 1n ? holding.amount / 2n : 1n,
        }),
        20_000,
        '原生幣 gas',
      )
    } catch {
      return 21_000n
    }
  }
  return withTimeout(
    client.estimateGas({
      account: holding.wallet,
      to: holding.token!,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [receiver, holding.amount],
      }),
    }),
    20_000,
    `${holding.symbol} gas`,
  )
}

function baseDecision(
  holding: Holding,
  price: number,
  sellTax: number,
  gasCostUsd: number,
  gasLimit: bigint,
  costWei: bigint,
  fee: FeeQuote,
): Decision {
  const gross = usdOf(holding.amount, holding.decimals, price, 0)
  return {
    holding,
    action: 'skip',
    reason: '',
    amountFormatted: formatAmount(holding.amount, holding.decimals),
    valueUsd: Number.isFinite(gross) ? gross : null,
    netValueUsd: null,
    gasCostUsd: Number.isFinite(gasCostUsd) ? gasCostUsd : null,
    gasLimit,
    costWei,
    fee,
    sellTax,
  }
}

function skip(holding: Holding, reason: string): Decision {
  return {
    holding,
    action: 'skip',
    reason,
    amountFormatted: formatAmount(holding.amount, holding.decimals),
    valueUsd: null,
    netValueUsd: null,
    gasCostUsd: null,
    costWei: 0n,
    sellTax: 0,
  }
}

export function formatAmount(amount: bigint, decimals: number): string {
  const raw = formatUnits(amount, decimals)
  if (!raw.includes('.')) return raw
  const trimmed = raw.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' ? '0' : trimmed
}
