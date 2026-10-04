import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { PublicKey } from '@solana/web3.js'
import { solanaConfigFile, solanaGasProviderFile, solanaKeysFile } from '../paths.js'
import { SYSTEM_ACCOUNT_RENT, errorText, parseSecretKey, sol } from './lib.js'
import { readGasProvider, writeGasProvider } from './secrets.js'
import { readSolanaConfigFile } from './settings.js'
import type { SolanaFileConfig } from './types.js'

const CONFIG_PATH = path.resolve(solanaConfigFile)

type FieldKind = 'pubkey' | 'bool' | 'keep' | 'number'
type ConfigField = { key: keyof SolanaFileConfig; label: string; kind: FieldKind }

const CONFIG_FIELDS: ConfigField[] = [
  { key: 'receiver', label: '接收地址（租金、SOL 與代幣）', kind: 'pubkey' },
  { key: 'transferTokensBeforeClose', label: '有餘額就先轉走再關帳戶', kind: 'bool' },
  { key: 'sweepNativeSol', label: '把舊錢包剩下的 SOL 也掃走', kind: 'bool' },
  { key: 'keepSol', label: '掃走時留在舊錢包的 SOL（0 或 >= 0.00089088）', kind: 'keep' },
  { key: 'receiverMustExist', label: '接收地址必須已經在鏈上存在', kind: 'bool' },
  { key: 'minReclaimSol', label: '可回收低於這個 SOL 就跳過該錢包', kind: 'number' },
  { key: 'priorityFeeMicroLamports', label: '優先費（microLamports / CU，平常 0）', kind: 'number' },
  { key: 'delayMs', label: '每筆交易間隔（毫秒）', kind: 'number' },
]

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(prompt).finally(() => rl.close())
}

function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(label)
  return new Promise((resolve) => {
    process.stdout.write(label)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let value = ''
    const onData = (key: Buffer | string) => {
      const text = String(key)
      if (text === '\u0003') process.exit(1)
      if (text === '\r' || text === '\n') {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        process.stdin.off('data', onData)
        process.stdout.write('\n')
        resolve(value)
        return
      }
      if (text === '\u007f' || text === '\b') {
        if (value.length) {
          value = value.slice(0, -1)
          process.stdout.write('\b \b')
        }
        return
      }
      if (text < ' ') return
      value += text
      process.stdout.write('*')
    }
    process.stdin.on('data', onData)
  })
}

function loadConfig(): SolanaFileConfig {
  return readSolanaConfigFile(CONFIG_PATH)
}

function walletCount(): number {
  if (!fs.existsSync(solanaKeysFile)) return 0
  return fs
    .readFileSync(solanaKeysFile, 'utf8')
    .split('\n')
    .map((line) => line.split('#')[0]?.trim() ?? '')
    .filter(Boolean).length
}

function gasProviderLabel(): string {
  const raw = readGasProvider()
  if (!raw) return '未設定，各舊錢包自己付'
  try {
    return parseSecretKey(raw).publicKey.toBase58()
  } catch {
    return '已填寫，但格式讀不起來'
  }
}

function rpcLabel(url: string | undefined): string {
  const value = url?.trim()
  if (!value) return '未設定，會用公共節點'
  try {
    return new URL(value).host
  } catch {
    return '已填寫，但不是合法網址'
  }
}

function showStatus(config: SolanaFileConfig): void {
  console.log('\n──────── 目前設定 ────────')
  console.log(`來源私鑰        ${solanaKeysFile}（${walletCount()} 行）`)
  console.log(`接收地址        ${config.receiver || '（未填）'}`)
  console.log(`gas 錢包        ${gasProviderLabel()}`)
  console.log(`RPC             ${rpcLabel(config.rpcUrl)}`)
  console.log(`有餘額先轉再關  ${config.transferTokensBeforeClose ? '是' : '否'}`)
  console.log(`掃走剩餘 SOL    ${config.sweepNativeSol ? `是（留 ${config.keepSol}）` : '否'}`)
}

function setConfigField(key: keyof SolanaFileConfig, value: string | number | boolean): void {
  const file: Record<string, string | number | boolean | undefined> = { ...loadConfig() }
  file[key] = value
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(file, null, 2)}\n`)
}

async function editConfigField(config: SolanaFileConfig, field: ConfigField): Promise<void> {
  const current = config[field.key]
  const entered = (await ask(`${field.label}\n目前：${current === '' ? '（空白）' : current}\n新值（直接 Enter 取消）：`)).trim()
  if (!entered) return

  if (field.kind === 'bool') {
    const on = /^(y|yes|true|1|是)$/i.test(entered)
    const off = /^(n|no|false|0|否)$/i.test(entered)
    if (!on && !off) {
      console.log('請輸入 y 或 n。')
      return
    }
    setConfigField(field.key, on)
    return
  }

  if (field.kind === 'number' || field.kind === 'keep') {
    const value = Number(entered)
    if (!Number.isFinite(value) || value < 0) {
      console.log('請輸入 0 以上的數字。')
      return
    }
    if (field.kind === 'keep') {
      const lamports = Math.round(value * 1e9)
      if (lamports !== 0 && lamports < SYSTEM_ACCOUNT_RENT) {
        console.log(`只能是 0，或 >= ${sol(SYSTEM_ACCOUNT_RENT)}。`)
        return
      }
    }
    setConfigField(field.key, value)
    return
  }

  try {
    new PublicKey(entered)
  } catch {
    console.log('這不是合法的 Solana 地址。')
    return
  }
  setConfigField(field.key, entered)
}

async function editRpc(config: SolanaFileConfig): Promise<void> {
  console.log(`目前節點：${rpcLabel(config.rpcUrl)}`)
  const entered = (await ask('新的 RPC 網址（直接 Enter 取消，clear 改回公共節點）：')).trim()
  if (!entered) return
  if (/^clear$/i.test(entered)) {
    setConfigField('rpcUrl', '')
    console.log(`已寫入 ${solanaConfigFile}。之後使用公共節點。`)
    return
  }
  try {
    new URL(entered)
  } catch {
    console.log('這不是合法的網址。')
    return
  }
  setConfigField('rpcUrl', entered)
  console.log(`已寫入 ${solanaConfigFile}。`)
}

async function editGasProvider(): Promise<void> {
  console.log(`目前 gas 錢包：${gasProviderLabel()}`)
  console.log('貼上新私鑰會以 * 顯示。輸入 clear 改回各錢包自付，直接 Enter 取消。')
  const entered = (await promptSecret('私鑰：')).trim()
  if (!entered) return
  if (entered === 'clear') {
    writeGasProvider('')
    console.log('已清除，之後由各舊錢包自己付手續費。')
    return
  }
  try {
    const pubkey = parseSecretKey(entered).publicKey.toBase58()
    writeGasProvider(entered)
    console.log(`已寫入 ${solanaGasProviderFile}。地址 ${pubkey}`)
  } catch (error) {
    console.log(`沒寫入：${errorText(error)}`)
  }
}

async function editSettings(): Promise<void> {
  const config = await loadConfig()
  console.log('\n要改哪一項？')
  CONFIG_FIELDS.forEach((field, index) => {
    const value = config[field.key]
    console.log(`  ${index + 1}. ${field.label}    目前 ${value === '' ? '（空白）' : value}`)
  })
  console.log(`  ${CONFIG_FIELDS.length + 1}. RPC 網址    目前 ${rpcLabel(config.rpcUrl)}`)
  console.log(`  ${CONFIG_FIELDS.length + 2}. gas 錢包私鑰    目前 ${gasProviderLabel()}`)
  console.log('  0. 返回')
  const choice = (await ask('> ')).trim()
  const index = Number(choice)
  if (choice === '0' || !choice) return
  if (index >= 1 && index <= CONFIG_FIELDS.length) {
    const field = CONFIG_FIELDS[index - 1]
    if (!field) return
    await editConfigField(config, field)
    console.log(`已寫入 ${solanaConfigFile}。`)
    return
  }
  if (index === CONFIG_FIELDS.length + 1) return editRpc(config)
  if (index === CONFIG_FIELDS.length + 2) return editGasProvider()
  console.log('沒有這個選項。')
}

function runReclaim(execute: boolean): Promise<number> {
  const args = ['--import', 'tsx', 'src/solana/reclaim.ts']
  if (execute) args.push('--execute')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

console.log('Solana 租金回收')

while (true) {
  const config = await loadConfig()
  showStatus(config)
  console.log('\n  1. 模擬（不上鏈）')
  console.log('  2. 正式執行')
  console.log('  3. 設定')
  console.log('  0. 返回')
  const choice = (await ask('> ')).trim()

  if (choice === '0' || choice === 'q') break
  if (choice === '1') {
    const code = await runReclaim(false)
    console.log(code === 0 ? '\n模擬結束。' : `\n模擬結束，退出碼 ${code}。`)
    continue
  }
  if (choice === '2') {
    console.log('\n這會把交易送上鏈。接著還要輸入接收地址的最後 4 個字元。')
    const code = await runReclaim(true)
    console.log(code === 0 ? '\n執行結束。' : `\n執行結束，退出碼 ${code}。`)
    continue
  }
  if (choice === '3') {
    await editSettings()
    continue
  }
  console.log('請輸入 1、2、3 或 0。')
}
