import { formatUnits } from 'viem'
import type { PriceQuote, SecurityVerdict } from './types.js'

const SPAM_TEXT =
  /https?:|www\.|\.(com|xyz|net|org|info|finance|top|site|io)\b|t\.me|telegram|airdrop|\bclaim\b|\bvisit\b/i

export function looksLikeSpamToken(name?: string, symbol?: string): boolean {
  const text = `${name ?? ''} ${symbol ?? ''}`.trim()
  if (!text) return false
  if (SPAM_TEXT.test(text)) return true
  if ((symbol?.length ?? 0) > 20) return true
  if ((name?.length ?? 0) > 64) return true
  return false
}

export function parseTax(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

export function assessToken(
  raw: Record<string, string> | undefined,
  maxSellTax: number,
): SecurityVerdict {
  if (!raw) return { known: false, sellTax: 0, rejectReason: '沒有安全檢查資料' }
  if (raw.is_airdrop_scam === '1') {
    return { known: true, sellTax: 0, rejectReason: '被標記為空投詐騙' }
  }
  if (raw.is_honeypot === '1') {
    return { known: true, sellTax: 1, rejectReason: '蜜罐，可能無法賣出' }
  }
  if (raw.cannot_sell_all === '1') {
    return { known: true, sellTax: 1, rejectReason: '無法全部賣出' }
  }
  const sellTax = parseTax(raw.sell_tax)
  if (sellTax >= 1) {
    return { known: true, sellTax, rejectReason: '賣出稅為 100% 或無法賣出' }
  }
  if (sellTax > maxSellTax) {
    return {
      known: true,
      sellTax,
      rejectReason: `賣出稅 ${(sellTax * 100).toFixed(1)}% 超過上限 ${(maxSellTax * 100).toFixed(1)}%`,
    }
  }
  return { known: true, sellTax }
}

export function assessPrice(
  quote: PriceQuote | undefined,
  options: {
    minConfidence: number
    maxAgeSec: number
    nowSec: number
    assumedUsd?: number
  },
): { price?: number; reason?: string } {
  if (quote && Number.isFinite(quote.price) && quote.price > 0) {
    const fresh = options.nowSec - quote.timestamp <= options.maxAgeSec
    const confident = quote.confidence >= options.minConfidence
    if (fresh && confident) return { price: quote.price }
    if (options.assumedUsd == null || options.assumedUsd <= 0) {
      if (!confident) return { reason: '價格信心不足' }
      return { reason: '價格過舊' }
    }
  }
  if (options.assumedUsd != null && options.assumedUsd > 0) {
    return { price: options.assumedUsd }
  }
  return { reason: '沒有可信價格' }
}

export function worthTransferring(
  netValueUsd: number,
  gasCostUsd: number,
  minTransferUsd: number,
  minValueToGasRatio: number,
): string | null {
  if (!Number.isFinite(netValueUsd) || !Number.isFinite(gasCostUsd) || gasCostUsd < 0) {
    return '無法計算價值或 gas'
  }
  if (minTransferUsd > 0 && netValueUsd < minTransferUsd) {
    return `價值 $${netValueUsd.toFixed(4)} 低於最小轉帳金額 $${minTransferUsd}`
  }
  const floor = gasCostUsd * minValueToGasRatio
  if (!(netValueUsd > floor)) {
    if (minValueToGasRatio === 1) {
      return `價值 $${netValueUsd.toFixed(4)} 沒有高過 gas $${gasCostUsd.toFixed(4)}`
    }
    return `價值 $${netValueUsd.toFixed(4)} 低於 gas $${gasCostUsd.toFixed(4)} 的 ${minValueToGasRatio} 倍`
  }
  return null
}

/** 把 gas 上限乘上緩衝倍率，無條件進位，避免鏈上波動導致 out of gas。 */
export function scaleGas(gas: bigint, multiplier: number): bigint {
  const bps = BigInt(Math.round(multiplier * 10_000))
  return (gas * bps + 9_999n) / 10_000n
}

export function usdOf(amount: bigint, decimals: number, price: number, sellTax = 0): number {
  const units = Number(formatUnits(amount, decimals))
  if (!Number.isFinite(units)) return Number.NaN
  return units * price * (1 - sellTax)
}

export function isScamReputation(reputation?: string | null): boolean {
  if (!reputation) return false
  return /scam|spam|phishing/i.test(reputation)
}
