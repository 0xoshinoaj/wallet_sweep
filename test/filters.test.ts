import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generatePrivateKey } from 'viem/accounts'
import { assignGasBudget, opStackBuffer, topUpForShortfall } from '../src/evm/budget.js'
import { loadConfig } from '../src/evm/config.js'
import {
  assessPrice,
  assessToken,
  looksLikeSpamToken,
  scaleGas,
  usdOf,
  worthTransferring,
} from '../src/evm/filters.js'
import { loadGasProvider, loadWallets } from '../src/evm/keys.js'
import { formatAmount } from '../src/evm/plan.js'
import { normalizePriceId } from '../src/evm/prices.js'
import { PRESETS } from '../src/evm/chains.js'

test('垃圾名稱與正常代幣名稱分開', () => {
  assert.equal(looksLikeSpamToken('USD Coin', 'USDC'), false)
  assert.equal(looksLikeSpamToken('Visit https://airdrop.io to claim', 'AIR'), true)
  assert.equal(looksLikeSpamToken('Reward', 'X'.repeat(21)), true)
})

test('GoPlus 蜜罐、空投與賣出稅', () => {
  assert.equal(assessToken(undefined, 0.1).rejectReason, '沒有安全檢查資料')
  assert.match(assessToken({ is_honeypot: '1' }, 0.1).rejectReason ?? '', /蜜罐/)
  assert.match(assessToken({ is_airdrop_scam: '1' }, 0.1).rejectReason ?? '', /空投/)
  assert.match(assessToken({ sell_tax: '1' }, 0.1).rejectReason ?? '', /100%/)
  const ok = assessToken({ sell_tax: '0.05', is_honeypot: '0' }, 0.1)
  assert.equal(ok.rejectReason, undefined)
  assert.equal(ok.sellTax, 0.05)
  assert.match(assessToken({ sell_tax: '0.2' }, 0.1).rejectReason ?? '', /賣出稅/)
})

test('沒有價格時才用穩定幣備用價', () => {
  const now = 1_000_000
  assert.deepEqual(
    assessPrice({ price: 0.99, confidence: 0.9, timestamp: now }, { minConfidence: 0.5, maxAgeSec: 100, nowSec: now, assumedUsd: 1 }),
    { price: 0.99 },
  )
  assert.deepEqual(
    assessPrice(undefined, { minConfidence: 0.5, maxAgeSec: 100, nowSec: now, assumedUsd: 1 }),
    { price: 1 },
  )
  assert.equal(assessPrice(undefined, { minConfidence: 0.5, maxAgeSec: 100, nowSec: now }).reason, '沒有可信價格')
  assert.equal(
    assessPrice({ price: 1, confidence: 0.1, timestamp: now }, { minConfidence: 0.5, maxAgeSec: 100, nowSec: now }).reason,
    '價格信心不足',
  )
})

test('價值高過 gas 就轉，最小金額可設成 0', () => {
  assert.equal(worthTransferring(0.5, 0.01, 0, 1), null)
  assert.match(worthTransferring(0.005, 0.01, 0, 1) ?? '', /沒有高過 gas/)
  assert.match(worthTransferring(0.4, 0.01, 1, 1) ?? '', /最小轉帳/)
})

test('gas 緩衝無條件進位，金額換算扣掉賣出稅', () => {
  assert.equal(scaleGas(1000n, 1.2), 1200n)
  assert.equal(usdOf(1_500_000n, 6, 1, 0), 1.5)
  assert.equal(usdOf(1_000_000n, 6, 2, 0.1), 1.8)
  assert.equal(formatAmount(1_500_000n, 6), '1.5')
  assert.equal(normalizePriceId('Ethereum:0xAbC'), 'ethereum:0xabc')
})

test('同一個錢包的 gas 預算先留給價值高的代幣', () => {
  const native = slot('native', 'send', 100, 10n, 100n, 100n)
  const expensive = slot('erc20', 'send', 50, 70n, 0n, 5n)
  const cheap = slot('erc20', 'send', 10, 40n, 0n, 2n)
  assignGasBudget([native, expensive, cheap])
  assert.equal(expensive.action, 'send')
  assert.equal(cheap.action, 'skip')
  assert.equal(native.sendWei, 20n)
})

test('私鑰檔忽略註解、去掉重複，錯誤行不回顯內容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evm-sweep-'))
  const secret = generatePrivateKey()
  const keysFile = join(dir, 'keys.txt')
  writeFileSync(keysFile, `# comment\n\n${secret}\n${secret}\n`)
  const wallets = loadWallets(keysFile)
  assert.equal(wallets.length, 1)
  assert.equal(wallets[0].account.address.startsWith('0x'), true)

  const bad = 'this-is-not-a-key'
  writeFileSync(keysFile, `${bad}\n`)
  assert.throws(
    () => loadWallets(keysFile),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : ''
      return message.includes('第 1 行') && !message.includes(bad)
    },
  )
})

test('設定檔會套用鏈預設，並拿掉拒絕清單裡的代幣', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evm-sweep-'))
  const configPath = join(dir, 'config.json')
  const usdc = PRESETS.ethereum.tokens[0].address
  writeFileSync(
    configPath,
    JSON.stringify({
      receiver: '0x0000000000000000000000000000000000000001',
      keysFile: 'keys.txt',
      chains: [{ preset: 'base', enabled: true }, { preset: 'ethereum', enabled: false }],
      denyTokens: [usdc],
    }),
  )
  const config = loadConfig(configPath)
  assert.equal(config.chains.find((chain) => chain.key === 'base')?.enabled, true)
  assert.equal(config.chains.find((chain) => chain.key === 'ethereum')?.enabled, false)
  const eth = config.chains.find((chain) => chain.key === 'ethereum')
  assert.equal(eth?.tokens.some((token) => token.address.toLowerCase() === usdc.toLowerCase()), false)
  assert.equal(config.minTransferUsd, 0)
  assert.equal(config.minValueToGasRatio, 1)
  assert.equal(config.gasProviderFile, undefined)
})

test('補 gas 只補缺口，Base 與 Optimism 另留 L1 緩衝', () => {
  assert.equal(topUpForShortfall(0n, 110n), 110n)
  assert.equal(topUpForShortfall(50n, 110n), 60n)
  assert.equal(topUpForShortfall(200n, 110n), 0n)
  assert.equal(opStackBuffer(8453), 2_000_000_000_000n)
  assert.equal(opStackBuffer(10), 2_000_000_000_000n)
  assert.equal(opStackBuffer(1), 0n)
})

test('gas 錢包檔只接受一組私鑰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evm-sweep-'))
  const gasProviderFile = join(dir, 'gas-provider.txt')
  writeFileSync(gasProviderFile, `${generatePrivateKey()}\n`)
  assert.equal(loadGasProvider(gasProviderFile).address.startsWith('0x'), true)

  writeFileSync(gasProviderFile, `${generatePrivateKey()}\n${generatePrivateKey()}\n`)
  assert.throws(() => loadGasProvider(gasProviderFile), /只能放一組私鑰/)
})

function slot(
  kind: 'native' | 'erc20',
  action: 'send' | 'skip',
  netValueUsd: number,
  costWei: bigint,
  balanceWei: bigint,
  sendWei: bigint,
) {
  return { kind, action, reason: '可轉', netValueUsd, costWei, balanceWei, sendWei }
}
