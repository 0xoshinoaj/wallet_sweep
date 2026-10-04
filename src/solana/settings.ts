import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { solanaConfigFile, solanaKeysFile } from '../paths.js'
import { SYSTEM_ACCOUNT_RENT, sol, withRetry } from './lib.js'
import { readGasProvider } from './secrets.js'
import type { ReadySettings, SolanaFileConfig, SolanaSettings } from './types.js'

export const CLI_OPTIONS = {
  config: { type: 'string', default: solanaConfigFile },
  keys: { type: 'string', default: solanaKeysFile },
  'gas-provider': { type: 'string' },
  receiver: { type: 'string' },
  'transfer-tokens': { type: 'boolean' },
  'allow-nonempty': { type: 'boolean' },
  'allow-new-receiver': { type: 'boolean' },
  'burn-dust': { type: 'string' },
  sweep: { type: 'boolean' },
  'no-sweep': { type: 'boolean' },
  keep: { type: 'string' },
  'min-reclaim': { type: 'string' },
  'priority-fee': { type: 'string' },
  'max-per-tx': { type: 'string' },
  delay: { type: 'string' },
  only: { type: 'string' },
  execute: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  'skip-simulate': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} as const

export type CliValues = {
  config?: string
  keys?: string
  'gas-provider'?: string
  receiver?: string
  'transfer-tokens'?: boolean
  'allow-nonempty'?: boolean
  'allow-new-receiver'?: boolean
  'burn-dust'?: string
  sweep?: boolean
  'no-sweep'?: boolean
  keep?: string
  'min-reclaim'?: string
  'priority-fee'?: string
  'max-per-tx'?: string
  delay?: string
  only?: string
  execute?: boolean
  yes?: boolean
  'skip-simulate'?: boolean
  help?: boolean
}

const CLUSTERS: Record<string, string> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
}

function num(value: string | number | null | undefined, fallback: number): number {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`不是合法的數字：${value}`)
  return parsed
}

function pubkeyOrNull(value: string | undefined, label: string): PublicKey | null {
  if (!value) return null
  try {
    return new PublicKey(value.trim())
  } catch {
    throw new Error(`${label} 不是合法的 Solana 地址：${value}`)
  }
}

export function readSolanaConfigFile(configPath: string): SolanaFileConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as SolanaFileConfig
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`讀不到設定檔 ${configPath}：${detail}`)
  }
}

export async function loadSettings(cli: CliValues): Promise<SolanaSettings> {
  const configPath = path.resolve(cli.config ?? solanaConfigFile)
  let file: SolanaFileConfig = {}
  if (fs.existsSync(configPath)) {
    file = readSolanaConfigFile(configPath)
  } else if ((cli.config ?? solanaConfigFile) !== solanaConfigFile) {
    throw new Error(`找不到設定檔 ${cli.config}`)
  }

  const receiver = pubkeyOrNull(cli.receiver ?? file.receiver, 'receiver')

  const burnDustRaw = cli['burn-dust'] ?? file.burnDustBelow
  const sweep = cli['no-sweep'] ? false : (cli.sweep ?? file.sweepNativeSol ?? true)

  return {
    configPath: fs.existsSync(configPath) ? (cli.config ?? solanaConfigFile) : '(未使用設定檔)',
    rpcUrl: file.rpcUrl?.trim() || '',
    keysFile: cli.keys ?? solanaKeysFile,
    gasProviderArg:
      cli['gas-provider'] || (typeof file.gasProvider === 'string' ? file.gasProvider.trim() : '') || readGasProvider() || null,
    receiver,
    receiverMustExist: cli['allow-new-receiver'] ? false : (file.receiverMustExist ?? true),
    requireEmptyBeforeClose: cli['allow-nonempty'] ? false : (file.requireEmptyBeforeClose ?? true),
    transferTokensBeforeClose: cli['transfer-tokens'] ?? file.transferTokensBeforeClose ?? false,
    burnDustBelow: burnDustRaw == null || burnDustRaw === '' ? null : num(burnDustRaw, 0),
    sweepNativeSol: sweep,
    keepLamports: Math.round(num(cli.keep ?? file.keepSol, 0) * 1e9),
    requireConfirmation: cli.yes ? false : (file.requireConfirmation ?? true),
    minReclaimLamports: Math.round(num(cli['min-reclaim'] ?? file.minReclaimSol, 0) * 1e9),
    priorityFee: num(cli['priority-fee'] ?? file.priorityFeeMicroLamports, 0),
    maxPerTx: num(cli['max-per-tx'] ?? file.maxAccountsPerTx, 25),
    delayMs: num(cli.delay ?? file.delayMs, 400),
    only: cli.only ? new Set(cli.only.split(',').map((item) => item.trim())) : null,
    dryRun: !cli.execute,
    skipSimulate: cli['skip-simulate'] ?? false,
  }
}

export function readySettings(settings: SolanaSettings): ReadySettings {
  if (!settings.receiver) {
    throw new Error(`沒有指定接收地址。請填 ${solanaConfigFile} 的 receiver 或用 --receiver。`)
  }
  return settings as ReadySettings
}

export function checkSettings(settings: SolanaSettings): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  if (!settings.receiver) {
    errors.push(`沒有指定接收地址。請填 ${solanaConfigFile} 的 receiver 或用 --receiver。`)
  }

  if (settings.keepLamports !== 0 && settings.keepLamports < SYSTEM_ACCOUNT_RENT) {
    errors.push(
      `keepSol 只能是 0 或 >= ${sol(SYSTEM_ACCOUNT_RENT)}（Solana 免租下限）。` +
        '填中間的值交易一定會被鏈上以 InsufficientFundsForRent 拒絕。',
    )
  }

  if (settings.maxPerTx < 1) errors.push('maxAccountsPerTx 至少要 1。')
  if (settings.priorityFee < 0) errors.push('priorityFeeMicroLamports 不能是負數。')

  if (settings.burnDustBelow != null && settings.burnDustBelow < 0) {
    errors.push('burnDustBelow 不能是負數。')
  }

  if (!settings.requireEmptyBeforeClose && !settings.transferTokensBeforeClose && settings.burnDustBelow == null) {
    warnings.push(
      'requireEmptyBeforeClose 設成 false，但沒有開 transferTokensBeforeClose，也沒設 burnDustBelow。\n' +
        '    SPL Token 程式本身就會拒絕關閉有餘額的帳戶，所以這些帳戶還是會被跳過，等於沒差別。',
    )
  }

  if (settings.transferTokensBeforeClose && settings.requireEmptyBeforeClose) {
    warnings.push(
      '有餘額的帳戶會先全額轉去接收地址，再關閉。\n' +
        '    接收地址還沒有的幣種會新建帳戶，每個成本 0.00203928 SOL，由 gas 錢包支付。',
    )
  }

  if (settings.burnDustBelow != null) {
    warnings.push(`burnDustBelow = ${settings.burnDustBelow}：餘額不超過這個數量的代幣會被「永久銷毀」。`)
  }

  return { errors, warnings }
}

export async function checkOnChain(
  connection: import('@solana/web3.js').Connection,
  settings: ReadySettings,
  walletPubkeys: PublicKey[],
): Promise<{ cluster: string; errors: string[]; warnings: string[] }> {
  const errors: string[] = []
  const warnings: string[] = []

  const genesis = await withRetry(() => connection.getGenesisHash())
  const cluster = CLUSTERS[genesis] ?? `未知 (${genesis.slice(0, 8)}…)`

  const targets: Array<[string, PublicKey]> = [['接收地址', settings.receiver]]

  for (const [label, key] of targets) {
    const info = await withRetry(() => connection.getAccountInfo(key))

    if (info && (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
      errors.push(
        `${label} ${key.toBase58()} 是一個「代幣帳戶」，不是錢包地址。\n` +
          '    把 SOL 轉進代幣帳戶會拿不回來。請改填你的錢包地址。',
      )
      continue
    }
    if (info && !info.owner.equals(SystemProgram.programId)) {
      errors.push(
        `${label} ${key.toBase58()} 由程式 ${info.owner.toBase58()} 持有，不是普通錢包。\n` +
          '    這通常是 PDA 或合約帳戶，轉進去可能無法取回。',
      )
      continue
    }
    if (!info) {
      const message =
        `${label} ${key.toBase58()} 在鏈上不存在，沒有任何餘額或交易紀錄。\n` +
        '    Solana 地址沒有校驗碼，打錯一個字母仍然是合法地址，錢轉過去就永遠拿不回來。\n' +
        '    請逐字核對這個地址。確定是全新的錢包才繼續：\n' +
        `    把 ${solanaConfigFile} 的 receiverMustExist 設成 false，或加 --allow-new-receiver。`
      if (settings.receiverMustExist) errors.push(message)
      else warnings.push(`${label} ${key.toBase58()} 在鏈上不存在，請再次確認沒有打錯字。`)
    }
  }

  if (settings.transferTokensBeforeClose && !PublicKey.isOnCurve(settings.receiver.toBytes())) {
    errors.push(
      `接收地址 ${settings.receiver.toBase58()} 不在 ed25519 曲線上（是 PDA）。\n` +
        '    無法為它推導代幣帳戶，請改成普通錢包地址。',
    )
  }

  const walletSet = new Set(walletPubkeys.map((key) => key.toBase58()))
  for (const [label, key] of targets) {
    if (walletSet.has(key.toBase58())) {
      warnings.push(
        `${label} 同時也出現在 ${settings.keysFile} 裡。` +
          (settings.sweepNativeSol ? '它的 SOL 會先被掃走再轉回自己，白付手續費。' : ''),
      )
    }
  }

  return { cluster, errors, warnings }
}

export async function confirm(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(promptText)
    return answer.trim()
  } finally {
    rl.close()
  }
}
