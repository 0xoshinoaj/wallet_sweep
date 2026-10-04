import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

export type AccountStatus = 'empty' | 'wsol' | 'has-tokens' | 'blocked-frozen' | 'blocked-authority'
export type PlanAction = 'close' | 'transfer' | 'burn' | 'skip'

export type TokenAccount = {
  pubkey: PublicKey
  programId: PublicKey
  mint: PublicKey
  owner: PublicKey
  lamports: number
  amount: bigint
  isNative: boolean
  isFrozen: boolean
  closeAuthority: PublicKey | null
  withheld: bigint
  status: AccountStatus
  decimals: number | null
  supply: bigint | null
  nonTransferable: boolean
}

export type AccountPlan =
  | { action: 'close' | 'transfer' | 'burn' }
  | { action: 'skip'; reason: string }

export type PlannedAccount = AccountPlan & { account: TokenAccount }

export type ScanReport = {
  owner: PublicKey
  lamports: number
  accounts: TokenAccount[]
  empty: TokenAccount[]
  hasTokens: TokenAccount[]
  blocked: TokenAccount[]
  reclaimableFromEmpty: number
  reclaimableFromTokens: number
}

export type SolanaFileConfig = {
  rpcUrl?: string
  receiver?: string
  gasProvider?: string
  receiverMustExist?: boolean
  requireEmptyBeforeClose?: boolean
  transferTokensBeforeClose?: boolean
  burnDustBelow?: number | string
  sweepNativeSol?: boolean
  keepSol?: number | string
  requireConfirmation?: boolean
  minReclaimSol?: number | string
  priorityFeeMicroLamports?: number | string
  maxAccountsPerTx?: number | string
  delayMs?: number | string
}

export type SolanaSettings = {
  configPath: string
  rpcUrl: string
  keysFile: string
  gasProviderArg: string | null
  receiver: PublicKey | null
  receiverMustExist: boolean
  requireEmptyBeforeClose: boolean
  transferTokensBeforeClose: boolean
  burnDustBelow: number | null
  sweepNativeSol: boolean
  keepLamports: number
  requireConfirmation: boolean
  minReclaimLamports: number
  priorityFee: number
  maxPerTx: number
  delayMs: number
  only: Set<string> | null
  dryRun: boolean
  skipSimulate: boolean
}

export type ReadySettings = SolanaSettings & {
  receiver: PublicKey
}

export type SweepSkip = { skip: string }
export type SweepTransfer = {
  instruction: TransactionInstruction
  amount: number
  fee: number
  remainder: number
}
export type SweepPlan = SweepSkip | SweepTransfer

export function isSweepSkip(plan: SweepPlan): plan is SweepSkip {
  return 'skip' in plan
}
