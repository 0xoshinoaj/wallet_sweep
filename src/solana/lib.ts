import fs from 'node:fs'
import bs58 from 'bs58'
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackAccount,
  unpackMint,
  getTransferFeeAmount,
  getNonTransferable,
} from '@solana/spl-token'
import { solanaKeysFile } from '../paths.js'
import type { AccountStatus, ScanReport, TokenAccount } from './types.js'

export const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]

/** 系統帳戶（無 data）的免租最低餘額。餘額只能是 0 或 >= 這個數字。 */
export const SYSTEM_ACCOUNT_RENT = 890880
/** 標準 165 bytes 代幣帳戶的免租餘額，也就是建立 / 關閉一個 ATA 的租金。 */
export const ATA_RENT = 2_039_280
export const MAX_TX_BYTES = 1232
export const DUMMY_BLOCKHASH = '11111111111111111111111111111111'

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function connect(url = 'https://api.mainnet-beta.solana.com'): Connection {
  return new Connection(url, { commitment: 'confirmed' })
}

export function sol(lamports: number | bigint): string {
  return (Number(lamports) / 1e9).toFixed(9)
}

/** 大於 0 的數字標成黃色。0 維持原色。管道輸出或 NO_COLOR 時不上色。 */
export function mark(value: number | bigint, text = String(value)): string {
  const positive = typeof value === 'bigint' ? value > 0n : Number(value) > 0
  if (!positive || !process.stdout.isTTY || process.env.NO_COLOR) return text
  return `\x1b[33m${text}\x1b[0m`
}

export function solc(lamports: number | bigint): string {
  return mark(lamports, sol(lamports))
}

export function programLabel(programId: PublicKey): string {
  return programId.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'token'
}

export function short(key: { toString(): string } | null | undefined, head = 4, tail = 4): string {
  const text = key?.toString() ?? ''
  return `${text.slice(0, head)}..${text.slice(-tail)}`
}

export function parseSecretKey(raw: string): Keypair {
  const value = raw.trim()
  if (value.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value) as number[]))
  if (/^[0-9a-fA-F]{128}$/.test(value)) {
    return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(value, 'hex')))
  }
  if (value.startsWith('seed:')) {
    const seed = bs58.decode(value.slice(5))
    if (seed.length !== 32) throw new Error(`seed: 必須是 32 bytes，實際 ${seed.length}`)
    return Keypair.fromSeed(seed)
  }
  const bytes = bs58.decode(value)
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes)
  if (bytes.length === 32) {
    throw new Error(
      '解出 32 bytes，這看起來是「錢包地址（公鑰）」而不是私鑰。\n' +
        '    私鑰是 64 bytes，base58 約 87~88 字元，或是 [12,34,...] 共 64 個數字。\n' +
        '    只想唯讀查能回收多少 → 把公鑰放進來源檔，再執行 npm run solana:scan\n' +
        `    要真的回收 → 從錢包匯出「私鑰」貼進 ${solanaKeysFile}\n` +
        '    確定這是 32 bytes 種子 → 在前面加 seed:',
    )
  }
  throw new Error(`無法識別的格式（解出 ${bytes.length} bytes）`)
}

export function isPublicKeyString(value: string): boolean {
  try {
    return bs58.decode(value.trim()).length === 32
  } catch {
    return false
  }
}

export function readEntries(path: string): Array<{ line: number; value: string }> {
  return fs
    .readFileSync(path, 'utf8')
    .split('\n')
    .map((line, index) => ({ line: index + 1, value: line.split('#')[0].trim().split(/\s+/)[0] ?? '' }))
    .filter((entry) => entry.value)
}

export function loadKeypairs(path: string): Keypair[] {
  const text = fs.readFileSync(path, 'utf8').trim()
  let keys: Keypair[]

  if (text.startsWith('[')) {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${path} 是空的 JSON 陣列`)
    keys = parsed.every((entry) => typeof entry === 'number')
      ? [Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))]
      : parsed.map((entry) => parseSecretKey(typeof entry === 'string' ? entry : JSON.stringify(entry)))
  } else {
    keys = readEntries(path).map(({ line, value }) => {
      try {
        return parseSecretKey(value)
      } catch (error) {
        throw new Error(`${path} 第 ${line} 行：${errorText(error)}`)
      }
    })
  }

  const seen = new Set<string>()
  return keys.filter((keypair) => {
    const id = keypair.publicKey.toBase58()
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export function loadOwners(path: string): Array<{ publicKey: PublicKey; hasSecret: boolean }> {
  const owners = readEntries(path).map(({ line, value }) => {
    if (isPublicKeyString(value)) {
      try {
        return { publicKey: new PublicKey(value), hasSecret: false }
      } catch {
        throw new Error(`${path} 第 ${line} 行不是合法的 Solana 地址`)
      }
    }
    try {
      return { publicKey: parseSecretKey(value).publicKey, hasSecret: true }
    } catch (error) {
      throw new Error(`${path} 第 ${line} 行：${errorText(error)}`)
    }
  })

  const seen = new Set<string>()
  return owners.filter((owner) => {
    const id = owner.publicKey.toBase58()
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  { tries = 5, delay = 800 }: { tries?: number; delay?: number } = {},
): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const retriable = /429|503|timeout|fetch failed|ECONN|rate/i.test(errorText(error))
      if (!retriable || attempt === tries - 1) throw error
      await sleep(delay * 2 ** attempt)
    }
  }
  throw lastError
}

export async function scanOwner(connection: Connection, owner: PublicKey): Promise<ScanReport> {
  const lamports = await withRetry(() => connection.getBalance(owner))
  const accounts: TokenAccount[] = []

  for (const programId of TOKEN_PROGRAMS) {
    const response = await withRetry(() => connection.getTokenAccountsByOwner(owner, { programId }))
    for (const { pubkey, account } of response.value) {
      const parsed = unpackAccount(pubkey, account, programId)
      const withheld = programId.equals(TOKEN_2022_PROGRAM_ID)
        ? getTransferFeeAmount(parsed)?.withheldAmount ?? 0n
        : 0n

      const closeAuthority = parsed.closeAuthority
      const authorityOk = !closeAuthority || closeAuthority.equals(owner)

      let status: AccountStatus
      if (!authorityOk) status = 'blocked-authority'
      else if (parsed.isFrozen) status = 'blocked-frozen'
      else if (parsed.isNative) status = 'wsol'
      else if (parsed.amount === 0n) status = 'empty'
      else status = 'has-tokens'

      accounts.push({
        pubkey,
        programId,
        mint: parsed.mint,
        owner,
        lamports: account.lamports,
        amount: parsed.amount,
        isNative: parsed.isNative,
        isFrozen: parsed.isFrozen,
        closeAuthority,
        withheld,
        status,
        decimals: null,
        supply: null,
        nonTransferable: false,
      })
    }
  }

  await attachDecimals(connection, accounts.filter((account) => account.status === 'has-tokens'))

  const empty = accounts.filter((account) => account.status === 'empty' || account.status === 'wsol')
  const hasTokens = accounts.filter((account) => account.status === 'has-tokens')
  const blocked = accounts.filter((account) => account.status.startsWith('blocked'))

  return {
    owner,
    lamports,
    accounts,
    empty,
    hasTokens,
    blocked,
    reclaimableFromEmpty: empty.reduce((sum, account) => sum + account.lamports, 0),
    reclaimableFromTokens: hasTokens.reduce((sum, account) => sum + account.lamports, 0),
  }
}

async function attachDecimals(connection: Connection, accounts: TokenAccount[]): Promise<void> {
  if (!accounts.length) return
  const mints = [...new Map(accounts.map((account) => [account.mint.toBase58(), account])).values()]
  const infoByMint = new Map<string, { decimals: number; supply: bigint; nonTransferable: boolean }>()

  for (let index = 0; index < mints.length; index += 100) {
    const chunk = mints.slice(index, index + 100)
    const infos = await withRetry(() => connection.getMultipleAccountsInfo(chunk.map((account) => account.mint)))
    chunk.forEach((account, infoIndex) => {
      const info = infos[infoIndex]
      if (!info) return
      try {
        const mint = unpackMint(account.mint, info, info.owner)
        infoByMint.set(account.mint.toBase58(), {
          decimals: mint.decimals,
          supply: mint.supply,
          nonTransferable: getNonTransferable(mint) != null,
        })
      } catch {
        /* 非標準 mint，留 null */
      }
    })
  }

  for (const account of accounts) {
    const info = infoByMint.get(account.mint.toBase58())
    account.decimals = info?.decimals ?? null
    account.supply = info?.supply ?? null
    account.nonTransferable = info?.nonTransferable ?? false
  }
}

export function uiAmount(account: Pick<TokenAccount, 'decimals' | 'amount'>): number | null {
  if (account.decimals == null) return null
  return Number(account.amount) / 10 ** account.decimals
}

export function budgetInstructions({
  priorityFee = 0,
  computeUnits = 0,
}: {
  priorityFee?: number
  computeUnits?: number
} = {}): TransactionInstruction[] {
  const instructions: TransactionInstruction[] = []
  if (computeUnits > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(computeUnits, 1_400_000) }))
  }
  if (priorityFee > 0) {
    instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }))
  }
  return instructions
}

function buildTx({
  payerKey,
  instructions,
  blockhash,
}: {
  payerKey: PublicKey
  instructions: TransactionInstruction[]
  blockhash: string
}): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

export function serializedSize(payerKey: PublicKey, instructions: TransactionInstruction[], signerCount: number): number {
  const tx = buildTx({ payerKey, instructions, blockhash: DUMMY_BLOCKHASH })
  return tx.serialize().length + Math.max(0, signerCount - tx.signatures.length) * 64
}

export function packGroups<T>(
  groups: Array<{ ixs: TransactionInstruction[]; meta: T }>,
  {
    payerKey,
    header = [],
    signerCount = 2,
    maxPerTx = 25,
  }: {
    payerKey: PublicKey
    header?: TransactionInstruction[]
    signerCount?: number
    maxPerTx?: number
  },
): Array<{ ixs: TransactionInstruction[]; metas: T[] }> {
  const batches: Array<{ ixs: TransactionInstruction[]; metas: T[] }> = []
  let current: { ixs: TransactionInstruction[]; metas: T[] } = { ixs: [], metas: [] }

  const flush = () => {
    if (current.metas.length) batches.push(current)
    current = { ixs: [], metas: [] }
  }

  for (const group of groups) {
    const candidate = [...current.ixs, ...group.ixs]
    const fits =
      current.metas.length < maxPerTx &&
      serializedSize(payerKey, [...header, ...candidate], signerCount) <= MAX_TX_BYTES - 32

    if (!fits && current.metas.length) flush()
    current.ixs.push(...group.ixs)
    current.metas.push(group.meta)
  }
  flush()
  return batches
}

export async function sendAndConfirm(
  connection: Connection,
  {
    payer,
    signers,
    instructions,
    dryRun,
    skipSimulate,
  }: {
    payer: Keypair
    signers: Keypair[]
    instructions: TransactionInstruction[]
    dryRun: boolean
    skipSimulate: boolean
  },
): Promise<{ signature: string | null; simulated: boolean; units: number | null }> {
  const uniqueSigners = [...new Map(signers.map((signer) => [signer.publicKey.toBase58(), signer])).values()]

  if (dryRun) {
    const { blockhash } = await withRetry(() => connection.getLatestBlockhash('confirmed'))
    const tx = buildTx({ payerKey: payer.publicKey, instructions, blockhash })
    tx.sign(uniqueSigners)
    const simulation = await withRetry(() =>
      connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true }),
    )
    if (simulation.value.err) {
      throw new Error(
        `模擬失敗 ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).slice(-10).join('\n')}`,
      )
    }
    return { signature: null, simulated: true, units: simulation.value.unitsConsumed ?? null }
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { blockhash, lastValidBlockHeight } = await withRetry(() => connection.getLatestBlockhash('confirmed'))
    const tx = buildTx({ payerKey: payer.publicKey, instructions, blockhash })
    tx.sign(uniqueSigners)

    try {
      if (!skipSimulate) {
        const simulation = await connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
        })
        if (simulation.value.err) {
          throw new Error(
            `模擬失敗 ${JSON.stringify(simulation.value.err)}\n${(simulation.value.logs ?? []).slice(-10).join('\n')}`,
          )
        }
      }
      const signature = await connection.sendTransaction(tx, { maxRetries: 3 })
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
      return { signature, simulated: false, units: null }
    } catch (error) {
      lastError = error
      const fatal = /模擬失敗|custom program error|insufficient/i.test(errorText(error))
      if (fatal || attempt === 3) throw error
      await sleep(1500 * attempt)
    }
  }
  throw lastError
}
