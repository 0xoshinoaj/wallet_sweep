export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < items.length) {
        const index = next
        next += 1
        results[index] = await fn(items[index], index)
      }
    }),
  )
  return results
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超過 ${Math.round(ms / 1000)} 秒`)), ms)
  })
  void promise.catch(() => undefined)
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function shortError(error: unknown): string {
  if (error instanceof Error) {
    const withShort = error as Error & { shortMessage?: string; details?: string }
    const message = [withShort.shortMessage || error.message, withShort.details].filter(Boolean).join('：')
    return message.replace(/apikey=[^&\s]+/gi, 'apikey=***').slice(0, 240)
  }
  return String(error).slice(0, 240)
}

export async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${safeUrl(url)}`)
  }
  return (await response.json()) as T
}

export function safeUrl(url: string): string {
  return url.replace(/apikey=[^&]+/gi, 'apikey=***').split('?')[0]
}

export function groupKey(chainId: number, wallet: string): string {
  return `${chainId}:${wallet.toLowerCase()}`
}

export function formatUsd(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value === 0) return '$0.00'
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

export function paint(text: string, color: 'yellow' | 'red' | 'green'): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text
  const code = { yellow: 33, red: 31, green: 32 }[color]
  return `\x1b[${code}m${text}\x1b[0m`
}

