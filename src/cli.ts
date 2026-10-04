import { spawn } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline/promises'
import {
  evmConfigFile,
  evmGasProviderFile,
  evmKeysFile,
  solanaConfigFile,
  solanaGasProviderFile,
  solanaKeysFile,
} from './paths.js'

function run(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const EXAMPLE_FILES: Array<[string, string]> = [
  ['config/evm.example.json', evmConfigFile],
  ['config/solana.example.json', solanaConfigFile],
  ['wallets_keys/evm_keys.example', evmKeysFile],
  ['wallets_keys/evm_gas_provider.example', evmGasProviderFile],
  ['wallets_keys/solana_keys.example', solanaKeysFile],
  ['wallets_keys/solana_gas_provider.example', solanaGasProviderFile],
]

function ensureExampleFiles(): void {
  const created: string[] = []
  for (const [example, target] of EXAMPLE_FILES) {
    if (fs.existsSync(target) || !fs.existsSync(example)) continue
    fs.copyFileSync(example, target)
    fs.chmodSync(target, 0o600)
    created.push(`${example} → ${target}`)
  }
  if (!created.length) return
  console.log('以下檔案還不存在，已從範例建立：')
  for (const line of created) console.log(`  ${line}`)
  console.log('請先填入接收地址、RPC 與私鑰，再正式執行。\n')
}

function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(prompt).finally(() => rl.close())
}

function evm(args: string[]): Promise<number> {
  const forwarded = args.includes('--config') ? args : ['--config', evmConfigFile, ...args]
  return run(['--import', 'tsx', 'src/evm/index.ts', ...forwarded])
}

function printHelp(): void {
  console.log(`
sweap：同一個專案裡的 EVM 彙整與 Solana 租金回收。

  npm start                         先選 EVM 或 Solana，再選模擬、正式或設定
  npm run evm                       EVM 模擬
  npm run evm -- --execute          EVM 正式轉帳
  npm run solana                    Solana 選單
  npm run solana:scan -- --verbose  Solana 只掃描
  npm run solana:reclaim            Solana 模擬
  npm run solana:reclaim -- --execute
`)
}

async function menu(): Promise<number> {
  ensureExampleFiles()
  console.log('sweap')
  while (true) {
    console.log('\n  1. EVM')
    console.log('  2. Solana')
    console.log('  0. 離開')
    const choice = (await ask('> ')).trim()
    if (choice === '0' || choice === 'q') return 0
    if (choice === '1') {
      const code = await run(['--import', 'tsx', 'src/evm/menu.ts'])
      console.log(code === 0 ? '\n已返回。' : `\nEVM 選單結束，退出碼 ${code}。`)
      continue
    }
    if (choice === '2') {
      const code = await run(['--import', 'tsx', 'src/solana/menu.ts'])
      console.log(code === 0 ? '\n已返回。' : `\nSolana 選單結束，退出碼 ${code}。`)
      continue
    }
    console.log('請輸入 1、2 或 0。')
  }
}

const [command, ...rest] = process.argv.slice(2)

if (!command) {
  void menu().then((code) => {
    process.exit(code)
  })
} else if (command === 'help' || command === '--help' || command === '-h') {
  printHelp()
  process.exit(0)
} else if (command === 'evm') {
  process.exit(await evm(rest))
} else if (command === 'solana') {
  const sub = rest[0]
  if (sub === 'scan') process.exit(await run(['--import', 'tsx', 'src/solana/scan.ts', ...rest.slice(1)]))
  if (sub === 'reclaim') process.exit(await run(['--import', 'tsx', 'src/solana/reclaim.ts', ...rest.slice(1)]))
  process.exit(await run(['--import', 'tsx', 'src/solana/menu.ts', ...rest]))
} else {
  console.error(`不認得的指令：${command}`)
  printHelp()
  process.exit(1)
}
