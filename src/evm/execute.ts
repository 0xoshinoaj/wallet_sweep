import {
  createWalletClient,
  erc20Abi,
  fallback,
  http,
  type Address,
  type Chain,
  type Account,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem'
import type { LiveChain } from './client.js'
import { opStackBuffer } from './budget.js'
import { quoteFee } from './fees.js'
import { assessPrice, scaleGas, usdOf, worthTransferring } from './filters.js'
import type { Wallet } from './keys.js'
import { formatAmount } from './plan.js'
import type { AppConfig, Decision, FeeQuote, GasTopUp, PriceQuote } from './types.js'
import { groupKey, mapPool, shortError } from './util.js'

export type TxResult = {
  ok: boolean
  chainName: string
  from: Address
  symbol: string
  amount: string
  hash?: Hash
  error?: string
  kind?: 'fund'
}

export async function executeDecisions(options: {
  decisions: Decision[]
  wallets: Wallet[]
  chains: Map<string, LiveChain>
  clients: Map<string, PublicClient>
  prices: Map<string, PriceQuote>
  config: AppConfig
}): Promise<TxResult[]> {
  const planned = options.decisions.filter((decision) => decision.action === 'send')
  const groups = new Map<string, Decision[]>()
  for (const decision of planned) {
    const key = groupKey(decision.holding.chainId, decision.holding.wallet)
    const group = groups.get(key) ?? []
    group.push(decision)
    groups.set(key, group)
  }

  const batches = [...groups.values()]
  const nested = await mapPool(batches, options.config.concurrency, (group) =>
    executeGroup(group, options),
  )
  return nested.flat()
}

export async function sendGasTopUps(options: {
  topUps: GasTopUp[]
  gasProvider: Wallet
  chains: Map<string, LiveChain>
  clients: Map<string, PublicClient>
  config: AppConfig
}): Promise<{ results: TxResult[]; fundedKeys: Set<string> }> {
  const byChain = new Map<string, GasTopUp[]>()
  for (const topUp of options.topUps) {
    const list = byChain.get(topUp.chainKey) ?? []
    list.push(topUp)
    byChain.set(topUp.chainKey, list)
  }

  const fundedKeys = new Set<string>()
  const nested = await mapPool([...byChain.values()], options.config.concurrency, async (batch) => {
    const results: TxResult[] = []
    const live = options.chains.get(batch[0].chainKey)
    const client = options.clients.get(batch[0].chainKey)
    if (!live || !client) {
      for (const topUp of batch) results.push(fundFailure(topUp, options.gasProvider.address, '找不到這條鏈的 RPC'))
      return results
    }
    const transports = live.chain.rpcUrls.map((url) => http(url, { timeout: 20_000, retryCount: 0 }))
    const walletClient = createWalletClient({
      account: options.gasProvider.account,
      chain: live.chain.viemChain,
      transport: transports.length === 1 ? transports[0] : fallback(transports),
    })
    for (const topUp of batch) {
      const result = await sendOneTopUp(topUp, walletClient, options.gasProvider, client, live.chain.viemChain, options.config)
      results.push(result)
      if (result.ok) fundedKeys.add(groupKey(topUp.chainId, topUp.wallet))
    }
    return results
  })
  return { results: nested.flat(), fundedKeys }
}

async function executeGroup(
  group: Decision[],
  options: {
    wallets: Wallet[]
    chains: Map<string, LiveChain>
    clients: Map<string, PublicClient>
    prices: Map<string, PriceQuote>
    config: AppConfig
  },
): Promise<TxResult[]> {
  const first = group[0]
  const live = options.chains.get(first.holding.chainKey)
  const client = options.clients.get(first.holding.chainKey)
  const wallet = options.wallets.find((item) => item.address.toLowerCase() === first.holding.wallet.toLowerCase())
  if (!live || !client || !wallet) {
    return group.map((decision) => failure(decision, '找不到錢包或鏈設定'))
  }

  const transports = live.chain.rpcUrls.map((url) => http(url, { timeout: 20_000, retryCount: 0 }))
  const walletClient = createWalletClient({
    account: wallet.account,
    chain: live.chain.viemChain,
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  })
  const results: TxResult[] = []
  const tokens = group
    .filter((decision) => decision.holding.kind === 'erc20' && decision.action === 'send')
    .sort((a, b) => (b.netValueUsd ?? 0) - (a.netValueUsd ?? 0))

  for (const decision of tokens) {
    results.push(await sendToken(decision, walletClient, wallet.account, client, live.chain.viemChain, options.config))
  }

  const native = group.find((decision) => decision.holding.kind === 'native' && decision.action === 'send')
  if (native) {
    if (results.some((result) => !result.ok)) {
      results.push(failure(native, '同一錢包的代幣沒轉成，先留下原生幣當 gas'))
    } else {
      const sent = await sendNative(native, walletClient, wallet.account, client, live.chain.viemChain, options)
      if (sent) results.push(sent)
    }
  }
  return results
}

async function sendToken(
  decision: Decision,
  walletClient: WalletClient,
  account: Account,
  client: PublicClient,
  chain: Chain,
  config: AppConfig,
): Promise<TxResult> {
  const token = decision.holding.token
  if (!token || decision.gasLimit == null || !decision.fee) return failure(decision, '缺少代幣或 gas 資料')
  try {
    const current = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [decision.holding.wallet],
    })
    const planned = decision.sendAmount ?? decision.holding.amount
    const amount = current < planned ? current : planned
    if (amount === 0n) return failure(decision, '送出前餘額已是 0')

    const hash = await walletClient.writeContract({
      account,
      chain,
      address: token,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [config.receiver, amount],
      gas: decision.gasLimit,
      ...eip1559OrLegacy(decision.fee),
    })
    await client.waitForTransactionReceipt({ hash, confirmations: config.confirmations })
    return {
      ok: true,
      chainName: decision.holding.chainName,
      from: decision.holding.wallet,
      symbol: decision.holding.symbol,
      amount: formatAmount(amount, decision.holding.decimals),
      hash,
    }
  } catch (error) {
    return failure(decision, shortError(error))
  }
}

async function sendNative(
  decision: Decision,
  walletClient: WalletClient,
  account: Account,
  client: PublicClient,
  chain: Chain,
  options: {
    prices: Map<string, PriceQuote>
    config: AppConfig
  },
): Promise<TxResult | null> {
  try {
    const balance = await client.getBalance({ address: decision.holding.wallet })
    const fee = await quoteFee(client)
    const estimated = await client.estimateGas({
      account: decision.holding.wallet,
      to: options.config.receiver,
      value: 1n,
    })
    const gasLimit = scaleGas(estimated, options.config.gasCostMultiplier)
    const l2Cost = gasLimit * fee.feePerGas
    // Base、Optimism 的 L1 data fee 不包含在 gas * gasPrice 裡，少留這段會讓餘額差一點點而失敗。
    const l1Buffer = opStackBuffer(chain.id)
    const costWei = l2Cost + l1Buffer
    const maxSendable = balance > costWei ? balance - costWei : 0n
    const planned = decision.sendAmount ?? 0n
    const value = decision.forceSweep ? maxSendable : planned < maxSendable ? planned : maxSendable
    if (value === 0n) {
      if (decision.forceSweep) return null
      return failure(decision, '送出前已不夠支付 gas')
    }

    if (!decision.forceSweep) {
      const nowSec = Math.floor(Date.now() / 1000)
      const priced = assessPrice(options.prices.get(decision.holding.nativePriceId), {
        minConfidence: options.config.minPriceConfidence,
        maxAgeSec: options.config.maxPriceAgeSec,
        nowSec,
      })
      if (priced.price == null) return failure(decision, '送出前失去原生幣價格')
      const netValueUsd = usdOf(value, decision.holding.decimals, priced.price)
      const gasCostUsd = usdOf(costWei, decision.holding.nativeDecimals, priced.price)
      const reason = worthTransferring(
        netValueUsd,
        gasCostUsd,
        options.config.minTransferUsd,
        options.config.minValueToGasRatio,
      )
      if (reason) return failure(decision, `送出前重新檢查：${reason}`)
    }

    const hash = await walletClient.sendTransaction({
      account,
      chain,
      to: options.config.receiver,
      value,
      gas: gasLimit,
      ...eip1559OrLegacy(fee),
    })
    await client.waitForTransactionReceipt({ hash, confirmations: options.config.confirmations })
    return {
      ok: true,
      chainName: decision.holding.chainName,
      from: decision.holding.wallet,
      symbol: decision.holding.symbol,
      amount: formatAmount(value, decision.holding.decimals),
      hash,
    }
  } catch (error) {
    return failure(decision, shortError(error))
  }
}

function eip1559OrLegacy(fee: FeeQuote): { maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint } | { gasPrice: bigint } {
  if (fee.maxFeePerGas != null) {
    return {
      maxFeePerGas: fee.maxFeePerGas,
      ...(fee.maxPriorityFeePerGas != null ? { maxPriorityFeePerGas: fee.maxPriorityFeePerGas } : {}),
    }
  }
  if (fee.gasPrice == null) throw new Error('缺少 gas 價格')
  return { gasPrice: fee.gasPrice }
}

async function sendOneTopUp(
  topUp: GasTopUp,
  walletClient: WalletClient,
  gasProvider: Wallet,
  client: PublicClient,
  chain: Chain,
  config: AppConfig,
): Promise<TxResult> {
  try {
    const balance = await client.getBalance({ address: gasProvider.address })
    const fee = await quoteFee(client)
    let estimated = 21_000n
    try {
      estimated = await client.estimateGas({
        account: gasProvider.address,
        to: topUp.wallet,
        value: topUp.amount,
      })
    } catch {
      estimated = 21_000n
    }
    const gasLimit = scaleGas(estimated, config.gasCostMultiplier)
    const costWei = gasLimit * fee.feePerGas + opStackBuffer(topUp.chainId)
    if (balance < topUp.amount + costWei) return fundFailure(topUp, gasProvider.address, 'gas 錢包餘額不夠')

    const hash = await walletClient.sendTransaction({
      account: gasProvider.account,
      chain,
      to: topUp.wallet,
      value: topUp.amount,
      gas: gasLimit,
      ...eip1559OrLegacy(fee),
    })
    await client.waitForTransactionReceipt({ hash, confirmations: config.confirmations })
    return {
      ok: true,
      kind: 'fund',
      chainName: topUp.chainName,
      from: gasProvider.address,
      symbol: topUp.nativeSymbol,
      amount: formatAmount(topUp.amount, topUp.nativeDecimals),
      hash,
    }
  } catch (error) {
    return fundFailure(topUp, gasProvider.address, shortError(error))
  }
}

function fundFailure(topUp: GasTopUp, from: Address, error: string): TxResult {
  return {
    ok: false,
    kind: 'fund',
    chainName: topUp.chainName,
    from,
    symbol: topUp.nativeSymbol,
    amount: formatAmount(topUp.amount, topUp.nativeDecimals),
    error,
  }
}

function failure(decision: Decision, error: string): TxResult {
  return {
    ok: false,
    chainName: decision.holding.chainName,
    from: decision.holding.wallet,
    symbol: decision.holding.symbol,
    amount: decision.amountFormatted,
    error,
  }
}
