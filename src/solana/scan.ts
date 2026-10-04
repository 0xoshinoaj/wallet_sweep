import { parseArgs } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { solanaConfigFile, solanaKeysFile } from '../paths.js'
import { isNft } from './plan.js'
import {
  connect,
  errorText,
  loadOwners,
  programLabel,
  scanOwner,
  mark,
  short,
  sleep,
  solc,
  uiAmount,
} from './lib.js'
import { readSolanaConfigFile } from './settings.js'

const { values: opts } = parseArgs({
  options: {
    keys: { type: 'string', default: solanaKeysFile },
    delay: { type: 'string', default: '250' },
    verbose: { type: 'boolean', default: false },
    json: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (opts.help) {
  console.log(`
用法：npm run solana:scan -- [選項]

  --keys <file>       來源檔（預設 ${solanaKeysFile}）。掃描可放公鑰，回收要放私鑰
  --verbose           列出每一個帳戶明細
  --json <file>       把掃描結果寫成 JSON
  --delay <ms>        每個錢包之間的間隔，避免 RPC 限流（預設 250）
`)
  process.exit(0)
}

function configRpcUrl(): string | undefined {
  const configPath = path.resolve(solanaConfigFile)
  if (!fs.existsSync(configPath)) return undefined
  return readSolanaConfigFile(configPath).rpcUrl?.trim() || undefined
}

const source = opts.keys
let owners: ReturnType<typeof loadOwners>
try {
  owners = loadOwners(source)
} catch (error) {
  console.error(`讀取 ${source} 失敗：\n  ${errorText(error)}`)
  process.exit(1)
}

if (!owners.length) {
  console.error(`${source} 裡沒有任何錢包，請先把地址或私鑰填進去。`)
  process.exit(1)
}

const connection = connect(configRpcUrl())
console.log(`RPC  ${connection.rpcEndpoint}`)
console.log(`來源 ${source}`)
console.log(`錢包 ${owners.length} 個（含私鑰 ${owners.filter((owner) => owner.hasSecret).length} 個）\n`)

type JsonWallet = {
  owner: string
  lamports: number
  reclaimableLamports: number
  lockedInTokenAccountsLamports: number
  accounts: Array<{
    pubkey: string
    mint: string
    program: string
    lamports: number
    amount: string
    decimals: number | null
    isNative: boolean
    status: string
    withheld: string
  }>
}

const results: JsonWallet[] = []
const totals = {
  reclaimable: 0,
  lockedInTokens: 0,
  native: 0,
  empty: 0,
  hasTokens: 0,
  blocked: 0,
  solOnlyWallets: 0,
  solOnlyLamports: 0,
}

for (const [index, { publicKey: owner }] of owners.entries()) {
  let report
  try {
    report = await scanOwner(connection, owner)
  } catch (error) {
    console.error(`[${index + 1}/${owners.length}] ${owner.toBase58()}  掃描失敗：${errorText(error)}`)
    continue
  }

  totals.reclaimable += report.reclaimableFromEmpty
  totals.lockedInTokens += report.reclaimableFromTokens
  totals.native += report.lamports
  totals.empty += report.empty.length
  totals.hasTokens += report.hasTokens.length
  totals.blocked += report.blocked.length
  const solOnly = report.accounts.length === 0 && report.lamports > 0
  if (solOnly) {
    totals.solOnlyWallets += 1
    totals.solOnlyLamports += report.lamports
  }

  console.log(
    `[${index + 1}/${owners.length}] ${owner.toBase58()}` +
      `  餘額 ${solc(report.lamports)} SOL` +
      `  可直接關 ${mark(report.empty.length)} 個 → +${solc(report.reclaimableFromEmpty)} SOL` +
      (report.hasTokens.length
        ? `  有代幣 ${mark(report.hasTokens.length)} 個（鎖 ${solc(report.reclaimableFromTokens)} SOL）`
        : '') +
      (report.blocked.length ? `  關不掉 ${mark(report.blocked.length)}` : '') +
      (solOnly ? '  無代幣帳戶，餘額仍會掃走' : ''),
  )

  if (opts.verbose) {
    for (const account of report.accounts) {
      const shown = account.isNative
        ? `wSOL ${solc(account.amount)}`
        : account.amount === 0n
          ? '0'
          : uiAmount(account) != null
            ? String(uiAmount(account))
            : `${account.amount} (raw)`
      console.log(
        `      ${short(account.pubkey, 6, 6)}  mint ${short(account.mint, 6, 6)}  ${programLabel(account.programId).padEnd(10)}` +
          `  rent ${solc(account.lamports)}  餘額 ${account.amount > 0n ? mark(account.amount, shown) : shown}  ${account.status}` +
          (isNft(account) ? '  NFT' : '') +
          (account.nonTransferable ? '  SBT' : '') +
          (account.withheld > 0n ? `  withheld ${account.withheld}` : ''),
      )
    }
  }

  results.push({
    owner: owner.toBase58(),
    lamports: report.lamports,
    reclaimableLamports: report.reclaimableFromEmpty,
    lockedInTokenAccountsLamports: report.reclaimableFromTokens,
    accounts: report.accounts.map((account) => ({
      pubkey: account.pubkey.toBase58(),
      mint: account.mint.toBase58(),
      program: programLabel(account.programId),
      lamports: account.lamports,
      amount: account.amount.toString(),
      decimals: account.decimals,
      isNative: account.isNative,
      status: account.status,
      withheld: account.withheld.toString(),
    })),
  })

  if (index < owners.length - 1) await sleep(Number(opts.delay))
}

console.log('\n────────── 總計 ──────────')
console.log(`已清空可直接關  ${mark(totals.empty)} 個 → ${solc(totals.reclaimable)} SOL`)
console.log(`錢包現有餘額    ${solc(totals.native)} SOL`)
console.log(`現在就能收回    ${solc(totals.reclaimable + totals.native)} SOL`)
if (totals.solOnlyWallets) {
  console.log(
    `只剩 SOL 的錢包  ${mark(totals.solOnlyWallets)} 個，共 ${solc(totals.solOnlyLamports)} SOL（沒有帳戶可關，執行時會把餘額掃去接收地址）`,
  )
}
if (totals.hasTokens) {
  console.log(
    `\n還有代幣的帳戶  ${mark(totals.hasTokens)} 個，另外鎖著 ${solc(totals.lockedInTokens)} SOL。` +
      '有餘額的會先轉去接收地址再關帳戶。',
  )
}
if (totals.blocked) {
  console.log(`\n無法處理        ${totals.blocked} 個（被凍結或 closeAuthority 不是本人）`)
}

if (opts.json) {
  fs.writeFileSync(opts.json, JSON.stringify({ totals, wallets: results }, null, 2))
  console.log(`\n明細已寫入 ${opts.json}`)
}
