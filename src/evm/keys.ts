import { readFileSync } from 'node:fs'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { Address } from 'viem'

export type Wallet = {
  account: PrivateKeyAccount
  address: Address
}

export function loadGasProvider(keysFile: string): Wallet {
  const wallets = loadWallets(
    keysFile,
    '請複製 wallets_keys/evm_gas_provider.example 成 wallets_keys/evm_gas_provider，只放一組私鑰',
  )
  if (wallets.length !== 1) {
    throw new Error(`gas 錢包檔只能放一組私鑰，目前有 ${wallets.length} 組`)
  }
  return wallets[0]
}

export function loadWallets(keysFile: string, missingHint?: string): Wallet[] {
  let text: string
  try {
    text = readFileSync(keysFile, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const hint = missingHint ?? '請複製 wallets_keys/evm_keys.example 成 wallets_keys/evm_keys，一行一組私鑰'
    throw new Error(`讀不到私鑰檔 ${keysFile}：${detail}\n${hint}`)
  }

  const wallets: Wallet[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    if (!raw || raw.startsWith('#')) continue
    let key = raw
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1).trim()
    }
    if (!key.startsWith('0x') && !key.startsWith('0X')) key = `0x${key}`
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error(`私鑰檔第 ${index + 1} 行不是有效私鑰（已略過內容）`)
    }
    let account: PrivateKeyAccount
    try {
      account = privateKeyToAccount(key as `0x${string}`)
    } catch {
      throw new Error(`私鑰檔第 ${index + 1} 行無法還原地址`)
    }
    const address = account.address
    if (seen.has(address.toLowerCase())) continue
    seen.add(address.toLowerCase())
    wallets.push({ account, address })
  }

  if (wallets.length === 0) throw new Error(`私鑰檔 ${keysFile} 裡面沒有任何私鑰`)
  return wallets
}
