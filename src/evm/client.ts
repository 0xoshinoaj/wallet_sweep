import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import type { ResolvedChain } from './types.js'
import { shortError } from './util.js'

export type LiveChain = {
  chain: ResolvedChain
  client: PublicClient
  rpcUrl: string
}

export async function connectChain(chain: ResolvedChain): Promise<LiveChain> {
  const failures: string[] = []
  let rpcUrl: string | undefined
  for (const url of chain.rpcUrls) {
    try {
      const probe = createPublicClient({
        chain: chain.viemChain,
        transport: http(url, { timeout: 12_000, retryCount: 0 }),
      })
      const chainId = await probe.getChainId()
      if (chainId !== chain.chainId) {
        throw new Error(`RPC 回傳 chain id ${chainId}，設定是 ${chain.chainId}`)
      }
      rpcUrl = url
      break
    } catch (error) {
      failures.push(`${url}（${shortError(error)}）`)
    }
  }
  if (!rpcUrl) throw new Error(failures.join('；'))

  const transports = chain.rpcUrls.map((url) => http(url, { timeout: 12_000, retryCount: 0 }))
  const client = createPublicClient({
    chain: chain.viemChain,
    transport: transports.length === 1 ? transports[0] : fallback(transports),
  })
  return { chain, client, rpcUrl }
}
