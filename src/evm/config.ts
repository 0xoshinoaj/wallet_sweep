import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { defineChain, getAddress, isAddress, type Address, type Chain } from 'viem'
import { evmConfigFile, evmKeysFile } from '../paths.js'
import { PRESETS } from './chains.js'
import type { AppConfig, ChainInput, DiscoveryMode, ResolvedChain, TokenRef } from './types.js'

type RawConfig = {
  receiver?: string
  keysFile?: string
  discovery?: DiscoveryMode
  etherscanApiKey?: string
  minTransferUsd?: number
  minValueToGasRatio?: number
  gasCostMultiplier?: number
  maxSellTax?: number
  minPriceConfidence?: number
  maxPriceAgeSec?: number
  maxGasLimit?: number
  confirmations?: number
  concurrency?: number
  denyTokens?: string[]
  screenAllowlist?: boolean
  gasProviderFile?: string
  chains?: ChainInput[]
}

export function loadConfig(configPath: string): AppConfig {
  const absolute = resolve(configPath)
  let raw: RawConfig
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf8')) as RawConfig
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`讀不到設定檔 ${absolute}：${detail}\n請先執行 cp config/evm.example.json ${evmConfigFile}`)
  }

  const receiver = raw.receiver?.trim() ?? ''
  if (!isAddress(receiver)) {
    throw new Error('請在設定檔填入有效的接收地址（receiver）')
  }

  const discovery = raw.discovery ?? 'allowlist'
  if (!['allowlist', 'blockscout', 'etherscan'].includes(discovery)) {
    throw new Error('discovery 只能是 allowlist、blockscout 或 etherscan')
  }

  const etherscanApiKey = raw.etherscanApiKey?.trim() || process.env.ETHERSCAN_API_KEY?.trim() || undefined
  if (discovery === 'etherscan' && !etherscanApiKey) {
    throw new Error('discovery 設為 etherscan 時，需要 etherscanApiKey 或環境變數 ETHERSCAN_API_KEY')
  }

  const inputs = raw.chains?.length
    ? raw.chains
    : Object.keys(PRESETS).map((preset) => ({ preset, enabled: true }))

  const denyTokens = (raw.denyTokens ?? []).map((item) => {
    if (!isAddress(item)) throw new Error(`denyTokens 裡有無效地址 ${item}`)
    return getAddress(item)
  })

  const chains = inputs.map((input, index) => resolveChain(input, index, denyTokens))
  const enabled = chains.filter((chain) => chain.enabled)
  if (enabled.length === 0) throw new Error('至少要啟用一條鏈')

  return {
    receiver: getAddress(receiver),
    keysFile: projectPath(raw.keysFile ?? evmKeysFile),
    discovery,
    etherscanApiKey,
    minTransferUsd: nonNegative(raw.minTransferUsd, 0, 'minTransferUsd'),
    minValueToGasRatio: positive(raw.minValueToGasRatio, 1, 'minValueToGasRatio'),
    gasCostMultiplier: positive(raw.gasCostMultiplier, 1.2, 'gasCostMultiplier'),
    maxSellTax: raw.maxSellTax ?? 0.1,
    minPriceConfidence: raw.minPriceConfidence ?? 0.5,
    maxPriceAgeSec: raw.maxPriceAgeSec ?? 86_400,
    maxGasLimit: BigInt(raw.maxGasLimit ?? 500_000),
    confirmations: raw.confirmations ?? 1,
    concurrency: raw.concurrency ?? 4,
    denyTokens,
    screenAllowlist: raw.screenAllowlist ?? false,
    gasProviderFile: raw.gasProviderFile?.trim() ? projectPath(raw.gasProviderFile.trim()) : undefined,
    chains,
  }
}

function projectPath(value: string): string {
  return isAbsolute(value) ? value : resolve(value)
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${name} 必須是大於 0 的數字`)
  return resolved
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${name} 不能是負數`)
  return resolved
}

function resolveChain(input: ChainInput, index: number, denyTokens: Address[]): ResolvedChain {
  const preset = input.preset ? PRESETS[input.preset] : undefined
  if (input.preset && !preset) {
    throw new Error(`未知的鏈預設 ${input.preset}。可用：${Object.keys(PRESETS).join(', ')}`)
  }

  const chainId = input.chainId ?? preset?.chain.id
  const name = input.name ?? preset?.chain.name
  const rpcUrls = input.rpcUrls ?? (input.rpcUrl ? [input.rpcUrl] : preset?.rpcUrls)
  const nativeCoingeckoId = input.nativeCoingeckoId ?? preset?.nativeCoingeckoId
  const llamaChain = input.llamaChain ?? preset?.llamaChain
  if (!chainId || !name || !rpcUrls?.length || !nativeCoingeckoId || !llamaChain) {
    throw new Error(`第 ${index + 1} 條鏈缺少 chainId、name、rpcUrl、nativeCoingeckoId 或 llamaChain`)
  }

  const nativeSymbol = input.nativeSymbol ?? preset?.nativeSymbol ?? preset?.chain.nativeCurrency.symbol
  const nativeDecimals = input.nativeDecimals ?? preset?.chain.nativeCurrency.decimals ?? 18
  if (!nativeSymbol) throw new Error(`${name} 缺少 nativeSymbol`)

  const viemChain = buildViemChain({
    presetChain: preset?.chain,
    chainId,
    name,
    rpcUrls,
    nativeSymbol,
    nativeDecimals,
    multicall3: input.multicall3 ?? preset?.chain.contracts?.multicall3?.address,
  })

  const baseTokens = input.tokens ?? preset?.tokens ?? []
  const tokens = dedupeTokens([...baseTokens, ...(input.extraTokens ?? [])]).filter(
    (item) => !denyTokens.some((denied) => denied.toLowerCase() === item.address.toLowerCase()),
  )

  return {
    key: preset?.key ?? name.toLowerCase().replace(/\s+/g, '-'),
    enabled: input.enabled !== false,
    chainId,
    name,
    rpcUrls,
    nativeSymbol,
    nativeDecimals,
    nativeCoingeckoId,
    llamaChain,
    blockscoutUrl: input.blockscoutUrl ?? preset?.blockscoutUrl,
    tokens,
    viemChain,
  }
}

function buildViemChain(options: {
  presetChain?: Chain
  chainId: number
  name: string
  rpcUrls: string[]
  nativeSymbol: string
  nativeDecimals: number
  multicall3?: Address
}): Chain {
  const base =
    options.presetChain ??
    defineChain({
      id: options.chainId,
      name: options.name,
      nativeCurrency: {
        name: options.nativeSymbol,
        symbol: options.nativeSymbol,
        decimals: options.nativeDecimals,
      },
      rpcUrls: { default: { http: options.rpcUrls } },
    })

  return defineChain({
    ...base,
    id: options.chainId,
    name: options.name,
    nativeCurrency: {
      ...base.nativeCurrency,
      symbol: options.nativeSymbol,
      decimals: options.nativeDecimals,
    },
    rpcUrls: { default: { http: options.rpcUrls } },
    contracts: options.multicall3
      ? {
          ...base.contracts,
          multicall3: {
            address: getAddress(options.multicall3),
          },
        }
      : base.contracts,
  })
}

function dedupeTokens(tokens: TokenRef[]): TokenRef[] {
  const seen = new Set<string>()
  const result: TokenRef[] = []
  for (const token of tokens) {
    if (!isAddress(token.address)) throw new Error(`無效的代幣地址 ${token.address}`)
    const address = getAddress(token.address)
    const key = address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ ...token, address })
  }
  return result
}
