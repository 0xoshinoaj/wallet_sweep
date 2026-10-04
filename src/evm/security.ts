import { assessToken } from './filters.js'
import type { SecurityVerdict } from './types.js'
import { chunk, fetchJson } from './util.js'

type GoPlusResponse = {
  code?: number
  message?: string
  result?: Record<string, Record<string, string>>
}

export function securityKey(chainId: number, token: string): string {
  return `${chainId}:${token.toLowerCase()}`
}

export async function fetchSecurity(
  chainId: number,
  tokens: string[],
  maxSellTax: number,
): Promise<Map<string, SecurityVerdict>> {
  const verdicts = new Map<string, SecurityVerdict>()
  const unique = [...new Set(tokens.map((token) => token.toLowerCase()))]
  for (const group of chunk(unique, 20)) {
    const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${group.join(',')}`
    const body = await fetchJson<GoPlusResponse>(url, 30_000)
    if (body.code !== 1 || !body.result) {
      throw new Error(`GoPlus 回應異常：${body.message ?? body.code ?? 'unknown'}`)
    }
    const returned = new Map(Object.entries(body.result).map(([address, info]) => [address.toLowerCase(), info]))
    for (const address of group) {
      verdicts.set(securityKey(chainId, address), assessToken(returned.get(address), maxSellTax))
    }
  }
  return verdicts
}
