import { erc20Abi, getAddress, isAddress, type Address, type PublicClient } from 'viem'
import { priceId } from './prices.js'
import type { AppConfig, Holding, HoldingSource, ResolvedChain, TokenRef } from './types.js'
import { chunk, fetchJson, shortError, sleep } from './util.js'

type ExplorerToken = {
  address: Address
  symbol: string
  name?: string
  reputation?: string | null
}

export async function discoverHoldings(
  client: PublicClient,
  chain: ResolvedChain,
  wallet: Address,
  config: AppConfig,
  warn: (message: string) => void,
): Promise<Holding[]> {
  const nativeBalance = await client.getBalance({ address: wallet })
  const holdings: Holding[] = [
    stamp(chain, {
      chainKey: chain.key,
      chainId: chain.chainId,
      chainName: chain.name,
      wallet,
      kind: 'native',
      symbol: chain.nativeSymbol,
      amount: nativeBalance,
      decimals: chain.nativeDecimals,
      source: 'native',
      allowlisted: true,
    }),
  ]

  const allowlist = await readTokenBalances(client, chain, wallet, chain.tokens, 'allowlist', true)
  const merged = new Map<string, Holding>()
  for (const holding of allowlist) merged.set(holding.token!.toLowerCase(), holding)

  if (config.discovery === 'blockscout' && !chain.blockscoutUrl) {
    warn(`${chain.name} 沒有 Blockscout，這條鏈只檢查白名單`)
  }

  try {
    const extras = await discoverExtraTokens(chain, wallet, config)
    const fresh = extras.filter((token) => !merged.has(token.address.toLowerCase()))
    const confirmed = await readTokenBalances(client, chain, wallet, fresh, config.discovery, false)
    for (const holding of confirmed) {
      const meta = fresh.find((token) => token.address.toLowerCase() === holding.token!.toLowerCase())
      if (!meta) continue
      holding.name = meta.name
      holding.reputation = meta.reputation
      holding.symbol = meta.symbol || holding.symbol
      merged.set(holding.token!.toLowerCase(), holding)
    }
  } catch (error) {
    warn(`${chain.name} 的代幣探索失敗，只檢查白名單：${shortError(error)}`)
  }

  holdings.push(...merged.values())
  return holdings
}

async function discoverExtraTokens(
  chain: ResolvedChain,
  wallet: Address,
  config: AppConfig,
): Promise<ExplorerToken[]> {
  if (config.discovery === 'allowlist') return []
  if (config.discovery === 'blockscout' && !chain.blockscoutUrl) return []
  const denied = new Set(config.denyTokens.map((token) => token.toLowerCase()))
  const found =
    config.discovery === 'blockscout'
      ? await fetchBlockscout(chain, wallet)
      : await fetchEtherscan(chain, wallet, config.etherscanApiKey ?? '')
  return found.filter((token) => !denied.has(token.address.toLowerCase()))
}

async function readTokenBalances(
  client: PublicClient,
  chain: ResolvedChain,
  wallet: Address,
  tokens: TokenRef[],
  source: HoldingSource,
  allowlisted: boolean,
): Promise<Holding[]> {
  const holdings: Holding[] = []
  for (const group of chunk(tokens, 40)) {
    const balances = chain.viemChain.contracts?.multicall3
      ? await readWithMulticall(client, wallet, group)
      : await readOneByOne(client, wallet, group)
    group.forEach((token, index) => {
      const row = balances[index]
      if (!row || row.amount === 0n) return
      holdings.push(
        stamp(chain, {
          chainKey: chain.key,
          chainId: chain.chainId,
          chainName: chain.name,
          wallet,
          kind: 'erc20',
          symbol: token.symbol,
          token: token.address,
          amount: row.amount,
          decimals: row.decimals,
          source,
          assumedUsd: token.assumedUsd,
          allowlisted,
        }),
      )
    })
  }
  return holdings
}

async function readWithMulticall(
  client: PublicClient,
  wallet: Address,
  tokens: TokenRef[],
): Promise<Array<{ amount: bigint; decimals: number } | null>> {
  const contracts = tokens.flatMap((token) => [
    {
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf' as const,
      args: [wallet] as const,
    },
    {
      address: token.address,
      abi: erc20Abi,
      functionName: 'decimals' as const,
    },
  ])
  const results = await client.multicall({ contracts, allowFailure: true })
  return tokens.map((token, index) => {
    const balanceResult = results[index * 2]
    const decimalsResult = results[index * 2 + 1]
    if (balanceResult.status !== 'success' || typeof balanceResult.result !== 'bigint') return null
    const decimals = decimalsResult.status === 'success' ? Number(decimalsResult.result) : (token.decimals ?? 18)
    return { amount: balanceResult.result, decimals }
  })
}

async function readOneByOne(
  client: PublicClient,
  wallet: Address,
  tokens: TokenRef[],
): Promise<Array<{ amount: bigint; decimals: number } | null>> {
  const rows: Array<{ amount: bigint; decimals: number } | null> = []
  for (const token of tokens) {
    try {
      const amount = await client.readContract({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet],
      })
      let decimals = token.decimals ?? 18
      try {
        decimals = await client.readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: 'decimals',
        })
      } catch {
        // 有些舊代幣沒有 decimals()，沿用設定值。
      }
      rows.push({ amount, decimals })
    } catch {
      rows.push(null)
    }
  }
  return rows
}

function stamp(chain: ResolvedChain, holding: Omit<Holding, 'priceId' | 'nativePriceId' | 'nativeDecimals'>): Holding {
  const nativePriceId = priceId(chain.nativeCoingeckoId)
  return {
    ...holding,
    nativePriceId,
    nativeDecimals: chain.nativeDecimals,
    priceId: holding.kind === 'native' ? nativePriceId : priceId(chain.llamaChain, holding.token),
  }
}

type BlockscoutItem = {
  value?: string
  token?: {
    address_hash?: string
    name?: string
    symbol?: string
    type?: string
    reputation?: string | null
  }
}

async function fetchBlockscout(chain: ResolvedChain, wallet: Address): Promise<ExplorerToken[]> {
  if (!chain.blockscoutUrl) return []
  const tokens: ExplorerToken[] = []
  let path = `/api/v2/addresses/${wallet}/token-balances`
  for (let page = 0; page < 8 && path; page += 1) {
    const url = `${chain.blockscoutUrl.replace(/\/$/, '')}${path}`
    const body = await fetchJson<
      BlockscoutItem[] | { items?: BlockscoutItem[]; next_page_params?: Record<string, string> | null }
    >(url)
    const items = Array.isArray(body) ? body : (body.items ?? [])
    for (const item of items) {
      const token = item.token
      if (!token?.address_hash || token.type !== 'ERC-20' || !isAddress(token.address_hash)) continue
      if (item.value === '0') continue
      tokens.push({
        address: getAddress(token.address_hash),
        symbol: token.symbol?.trim() || 'UNKNOWN',
        name: token.name,
        reputation: token.reputation,
      })
    }
    if (Array.isArray(body) || !body.next_page_params) break
    const params = new URLSearchParams(body.next_page_params)
    path = `/api/v2/addresses/${wallet}/tokens?${params.toString()}`
    await sleep(150)
  }
  return tokens
}

type EtherscanResponse = {
  status?: string
  message?: string
  result?:
    | Array<{
        TokenAddress?: string
        TokenName?: string
        TokenSymbol?: string
        TokenQuantity?: string
      }>
    | string
}

/** 免費方案每秒 5 次。間隔 250ms，實際最多每秒 4 次，避免併發掃描超標。 */
const ETHERSCAN_GAP_MS = 250
let etherscanTail: Promise<void> = Promise.resolve()
let etherscanNotBefore = 0

function etherscanSlot(): Promise<void> {
  const turn = etherscanTail.then(async () => {
    const wait = etherscanNotBefore - Date.now()
    if (wait > 0) await sleep(wait)
    etherscanNotBefore = Date.now() + ETHERSCAN_GAP_MS
  })
  etherscanTail = turn.then(
    () => undefined,
    () => undefined,
  )
  return turn
}

async function fetchEtherscan(chain: ResolvedChain, wallet: Address, apiKey: string): Promise<ExplorerToken[]> {
  const tokens: ExplorerToken[] = []
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL('https://api.etherscan.io/v2/api')
    url.searchParams.set('chainid', String(chain.chainId))
    url.searchParams.set('module', 'account')
    url.searchParams.set('action', 'addresstokenbalance')
    url.searchParams.set('address', wallet)
    url.searchParams.set('page', String(page))
    url.searchParams.set('offset', '100')
    url.searchParams.set('apikey', apiKey)
    await etherscanSlot()
    const body = await fetchJson<EtherscanResponse>(url.toString())
    if (!Array.isArray(body.result)) {
      const message = `${body.message ?? ''} ${typeof body.result === 'string' ? body.result : ''}`.trim()
      if (/no token|empty/i.test(message) || page > 1) break
      throw new Error(`Etherscan ${chain.name}：${message || '無法取得代幣餘額'}`)
    }
    for (const item of body.result) {
      if (!item.TokenAddress || !isAddress(item.TokenAddress) || item.TokenQuantity === '0') continue
      tokens.push({
        address: getAddress(item.TokenAddress),
        symbol: item.TokenSymbol?.trim() || 'UNKNOWN',
        name: item.TokenName,
      })
    }
    if (body.result.length < 100) break
  }
  return tokens
}
