import readline from 'node:readline/promises'
import type { PublicClient } from 'viem'
import { connectChain, type LiveChain } from './client.js'
import { loadConfig } from './config.js'
import { discoverHoldings } from './discover.js'
import { executeDecisions, sendGasTopUps, type TxResult } from './execute.js'
import { isScamReputation, looksLikeSpamToken } from './filters.js'
import { loadGasProvider, loadWallets } from './keys.js'
import { buildDecisions, formatAmount } from './plan.js'
import { fetchPrices } from './prices.js'
import { printPlan, printTxResults, writePlan } from './report.js'
import { fetchSecurity } from './security.js'
import type { Holding, SecurityVerdict } from './types.js'
import { evmConfigFile } from '../paths.js'
import { groupKey, mapPool, paint, shortError } from './util.js'

async function confirmReceiver(receiver: string): Promise<boolean> {
  const tail = receiver.slice(-4)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(`\n所有資產將匯入：${receiver}`)
    const answer = (await rl.question(`請輸入上面接收地址的最後 4 個字元（${'•'.repeat(4)}）以確認：`)).trim()
    if (answer.toLowerCase() !== tail.toLowerCase()) {
      console.log(`輸入不符（應為 ${tail}），已取消，沒有送出任何交易。`)
      return false
    }
    return true
  } finally {
    rl.close()
  }
}

function rpcHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '節點'
  }
}

function clearProgress(): void {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[K')
}

function writeProgress(checksDone: number, checksTotal: number, walletsDone: number, walletsTotal: number): void {
  const line = `掃描 ${walletsDone}/${walletsTotal} 個錢包，${checksDone}/${checksTotal} 個鏈檢查點`
  if (process.stdout.isTTY) process.stdout.write(`\r${line}`)
  else if (checksDone === checksTotal || checksDone % 10 === 0) console.log(line)
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute')
  const dryRun = process.argv.includes('--dry-run')
  if (execute && dryRun) throw new Error('不能同時加上 --execute 和 --dry-run')

  const configPath = readArg('--config') ?? evmConfigFile
  const outPath = readArg('--out')
  const config = loadConfig(configPath)
  const wallets = loadWallets(config.keysFile)
  const gasProvider = config.gasProviderFile ? loadGasProvider(config.gasProviderFile) : undefined
  const configured = config.chains.filter((chain) => chain.enabled)
  const clients = new Map<string, PublicClient>()
  const live = new Map<string, LiveChain>()
  let scanErrors = 0

  console.log(
    `${execute ? '實際轉帳' : '模擬'}，${wallets.length} 個錢包，代幣發現：${config.discovery}`,
  )
  if (gasProvider) console.log(`gas 錢包 ${gasProvider.address}`)

  const seenNotes = new Set<string>()
  for (const [index, chain] of configured.entries()) {
    console.log(`連線 ${index + 1}/${configured.length}  ${chain.name}`)
    try {
      const connected = await connectChain(chain)
      clients.set(chain.key, connected.client)
      live.set(chain.key, connected)
      console.log(`  已連上 ${rpcHost(connected.rpcUrl)}`)
    } catch (error) {
      scanErrors += 1
      console.log(`  失敗  ${shortError(error)}`)
    }
  }

  const chains = configured.filter((chain) => clients.has(chain.key))
  const jobs = wallets.flatMap((wallet) => chains.map((chain) => ({ wallet, chain })))
  let checksDone = 0
  let walletsDone = 0
  const pendingChains = new Map(wallets.map((wallet) => [wallet.address.toLowerCase(), chains.length]))
  console.log(`開始掃描 ${wallets.length} 個錢包 × ${chains.length} 條鏈`)
  const scanned = await mapPool(jobs, config.concurrency, async ({ wallet, chain }) => {
    let found: Holding[] = []
    try {
      found = await discoverHoldings(clients.get(chain.key)!, chain, wallet.address, config, (message) => {
        if (seenNotes.has(message)) return
        seenNotes.add(message)
        clearProgress()
        console.log(message)
      })
    } catch (error) {
      scanErrors += 1
      clearProgress()
      console.log(`失敗  ${chain.name}  ${wallet.address}  ${shortError(error)}`)
    }
    checksDone += 1
    const address = wallet.address.toLowerCase()
    const left = (pendingChains.get(address) ?? 1) - 1
    pendingChains.set(address, left)
    if (left <= 0) walletsDone += 1
    for (const holding of found) {
      if (holding.amount === 0n) continue
      clearProgress()
      const amount = formatAmount(holding.amount, holding.decimals)
      console.log(
        `${paint('有餘額', 'yellow')}  ${holding.chainName}  ${holding.symbol}  ${amount}  來源 ${holding.wallet}`,
      )
    }
    writeProgress(checksDone, jobs.length, walletsDone, wallets.length)
    return found
  })
  clearProgress()
  console.log(`掃描完成  ${walletsDone}/${wallets.length} 個錢包，${checksDone}/${jobs.length} 個鏈檢查點`)

  const found = scanned.flat().filter((holding) => holding.amount > 0n)
  const needsGas = new Set(
    found
      .filter((holding) => holding.kind === 'erc20')
      .map((holding) => groupKey(holding.chainId, holding.wallet)),
  )
  const holdings = scanned.flat().filter((holding) => {
    if (holding.amount > 0n) return true
    return holding.kind === 'native' && needsGas.has(groupKey(holding.chainId, holding.wallet))
  })
  const foundText = `找到 ${found.length} 筆資產`
  console.log(found.length > 0 ? paint(foundText, 'yellow') : foundText)
  const prices =
    holdings.length > 0
      ? await fetchPrices(holdings.flatMap((holding) => [holding.priceId, holding.nativePriceId]))
      : new Map()
  const security = new Map<string, SecurityVerdict>()
  const tokensByChain = new Map<number, string[]>()

  for (const holding of holdings) {
    if (holding.kind !== 'erc20' || !holding.token) continue
    if (holding.allowlisted && !config.screenAllowlist) continue
    if (!holding.allowlisted && (looksLikeSpamToken(holding.name, holding.symbol) || isScamReputation(holding.reputation))) {
      continue
    }
    const list = tokensByChain.get(holding.chainId) ?? []
    list.push(holding.token)
    tokensByChain.set(holding.chainId, list)
  }

  for (const [chainId, tokens] of tokensByChain) {
    try {
      const verdicts = await fetchSecurity(chainId, tokens, config.maxSellTax)
      for (const [key, verdict] of verdicts) security.set(key, verdict)
    } catch (error) {
      console.log(`注意    鏈 ${chainId} 的安全檢查失敗，非白名單代幣會被跳過：${shortError(error)}`)
    }
  }

  const plan = await buildDecisions({
    holdings,
    prices,
    security,
    config,
    clients,
    gasProvider: gasProvider?.address,
  })
  printPlan(plan.decisions, plan.topUps, execute, config.receiver)
  if (outPath) {
    writePlan(outPath, plan.decisions)
    console.log(`計畫已寫入 ${outPath}`)
  }

  if (!execute) {
    if (scanErrors > 0) process.exitCode = 1
    return
  }

  const willSend = plan.decisions.some((decision) => decision.action === 'send') || plan.topUps.length > 0
  if (willSend && !(await confirmReceiver(config.receiver))) return

  let decisions = plan.decisions
  const fundedResults: TxResult[] = []
  if (gasProvider && plan.topUps.length > 0) {
    const funded = await sendGasTopUps({
      topUps: plan.topUps,
      gasProvider,
      chains: live,
      clients,
      config,
    })
    fundedResults.push(...funded.results)
    const required = new Set(plan.topUps.map((topUp) => groupKey(topUp.chainId, topUp.wallet)))
    decisions = decisions.filter((decision) => {
      const key = groupKey(decision.holding.chainId, decision.holding.wallet)
      return !required.has(key) || funded.fundedKeys.has(key)
    })
  }

  const results = [
    ...fundedResults,
    ...(await executeDecisions({
      decisions,
      wallets,
      chains: live,
      clients,
      prices,
      config,
    })),
  ]
  printTxResults(results)
  if (scanErrors > 0 || results.some((result) => !result.ok)) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(shortError(error))
  process.exitCode = 1
})
