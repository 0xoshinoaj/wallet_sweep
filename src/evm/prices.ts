import type { PriceQuote } from './types.js'
import { chunk, fetchJson } from './util.js'

type LlamaResponse = {
  coins?: Record<string, { price?: number; confidence?: number; timestamp?: number }>
}

export function priceId(prefix: string, address?: string): string {
  if (!address) return `coingecko:${prefix}`
  return `${prefix}:${address.toLowerCase()}`
}

export async function fetchPrices(ids: string[]): Promise<Map<string, PriceQuote>> {
  const unique = [...new Set(ids.map(normalizePriceId))]
  const quotes = new Map<string, PriceQuote>()
  for (const group of chunk(unique, 40)) {
    const url = `https://coins.llama.fi/prices/current/${group.join(',')}`
    const body = await fetchJson<LlamaResponse>(url)
    for (const [id, coin] of Object.entries(body.coins ?? {})) {
      if (coin.price == null || coin.timestamp == null) continue
      quotes.set(normalizePriceId(id), {
        price: coin.price,
        confidence: coin.confidence ?? 0,
        timestamp: coin.timestamp,
      })
    }
  }
  return quotes
}

export function normalizePriceId(id: string): string {
  const separator = id.indexOf(':')
  if (separator === -1) return id.toLowerCase()
  const prefix = id.slice(0, separator).toLowerCase()
  const rest = id.slice(separator + 1)
  if (rest.startsWith('0x') || rest.startsWith('0X')) return `${prefix}:${rest.toLowerCase()}`
  return `${prefix}:${rest.toLowerCase()}`
}
