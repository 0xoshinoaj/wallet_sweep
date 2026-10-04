import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { isAddress } from 'viem'
import { evmConfigFile } from '../paths.js'
import { loadGasProvider } from './keys.js'
import { paint } from './util.js'

const CONFIG_PATH = path.resolve(evmConfigFile)

type ChainRow = { preset?: string; name?: string; enabled?: boolean }
type RawConfig = {
  receiver?: string
  discovery?: string
  etherscanApiKey?: string
  gasProviderFile?: string
  chains?: ChainRow[]
}

const DISCOVERY_MODES = [
  {
    value: 'allowlist',
    summary: '只查各鏈內建白名單和原生幣。清單以外的代幣，就算餘額很有價值，也不會被看到。',
  },
  {
    value: 'blockscout',
    summary:
      '用該鏈的 Blockscout 列出錢包裡的 ERC-20，再過濾。Ethereum、Base、Arbitrum、Optimism、Polygon、Robinhood 有。BSC、Avalanche 和 Gravity 沒有，這幾條鏈仍只查白名單。',
  },
  {
    value: 'etherscan',
    summary:
      '用 Etherscan API v2，七條鏈都能查白名單以外的代幣。需要已填寫的金鑰。免費方案每秒 5 次，程式會把呼叫間隔開。',
  },
] as const

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

function loadRaw(): RawConfig {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as RawConfig
}

function saveRaw(raw: RawConfig): void {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`)
}

function chainLabel(chain: ChainRow): string {
  return chain.name || chain.preset || '未命名'
}

function gasLabel(raw: RawConfig): string {
  const file = raw.gasProviderFile?.trim()
  if (!file) return '未設定'
  try {
    return loadGasProvider(path.resolve(file)).address
  } catch {
    return '已填路徑，但讀不起來'
  }
}

function chainState(on: boolean): string {
  return paint(on ? '開' : '關', on ? 'yellow' : 'red')
}

function showStatus(raw: RawConfig): void {
  const chains = raw.chains ?? []
  const chainText = chains.length
    ? chains
        .map((chain) => {
          const on = chain.enabled !== false
          return `${paint(chainLabel(chain), on ? 'yellow' : 'red')} ${chainState(on)}`
        })
        .join('  ')
    : '（沒有）'
  console.log('\n──────── 目前設定 ────────')
  console.log(`接收地址        ${raw.receiver || '（未填）'}`)
  console.log(`gas 錢包        ${gasLabel(raw)}`)
  console.log(`代幣發現        ${raw.discovery || 'allowlist'}`)
  console.log(`Etherscan 金鑰  ${raw.etherscanApiKey?.trim() ? '已填寫' : '未填寫'}`)
  console.log(`鏈              ${chainText}`)
}

function runEvm(execute: boolean): Promise<number> {
  const args = ['--import', 'tsx', 'src/evm/index.ts', '--config', evmConfigFile]
  if (execute) args.push('--execute')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

async function editReceiver(raw: RawConfig): Promise<void> {
  const entered = (await ask(`接收地址\n目前：${raw.receiver || '（未填）'}\n新地址（直接 Enter 取消）：`)).trim()
  if (!entered) return
  if (!isAddress(entered)) {
    console.log('這不是合法的 EVM 地址。')
    return
  }
  raw.receiver = entered
  saveRaw(raw)
  console.log(`已寫入 ${evmConfigFile}。`)
}

async function editDiscovery(raw: RawConfig): Promise<void> {
  console.log('\n代幣發現決定白名單以外的 ERC-20 會不會被看到。')
  DISCOVERY_MODES.forEach((mode, index) => {
    const mark = (raw.discovery || 'allowlist') === mode.value ? '  ← 目前' : ''
    console.log(`  ${index + 1}. ${mode.value}${mark}`)
    console.log(`     ${mode.summary}`)
  })
  console.log('  0. 返回')
  const entered = (await ask('> ')).trim()
  if (entered === '0' || !entered) return
  const mode = DISCOVERY_MODES[Number(entered) - 1]
  if (!mode) {
    console.log('請輸入 1、2 或 3。')
    return
  }
  raw.discovery = mode.value
  saveRaw(raw)
  console.log(`已改成 ${mode.value}，寫入 ${evmConfigFile}。`)
}

async function editEtherscanKey(raw: RawConfig): Promise<void> {
  console.log(`目前：${raw.etherscanApiKey?.trim() ? '已填寫' : '未填寫'}`)
  console.log('貼上新金鑰會以 * 顯示。輸入 clear 清除，直接 Enter 取消。')
  const entered = (await promptSecret('金鑰：')).trim()
  if (!entered) return
  raw.etherscanApiKey = entered === 'clear' ? '' : entered
  saveRaw(raw)
  console.log(`已寫入 ${evmConfigFile}。`)
}

async function editChains(raw: RawConfig): Promise<void> {
  const chains = raw.chains ?? []
  if (!chains.length) {
    console.log('設定檔裡沒有 chains。')
    return
  }
  console.log('\n輸入編號可開關該鏈。0 返回。')
  chains.forEach((chain, index) => {
    const on = chain.enabled !== false
    console.log(`  ${index + 1}. ${paint(chainLabel(chain), on ? 'yellow' : 'red')}    ${chainState(on)}`)
  })
  const choice = (await ask('> ')).trim()
  const index = Number(choice)
  if (choice === '0' || !choice) return
  const chain = chains[index - 1]
  if (!chain) {
    console.log('沒有這個選項。')
    return
  }
  chain.enabled = chain.enabled === false
  saveRaw(raw)
  console.log(`${chainLabel(chain)} 已改成${chainState(chain.enabled === true)}，寫入 ${evmConfigFile}。`)
}

async function editSettings(): Promise<void> {
  const raw = loadRaw()
  console.log('\n要改哪一項？')
  console.log('  1. 接收地址')
  console.log(`  2. 代幣發現    目前 ${raw.discovery || 'allowlist'}`)
  console.log(`  3. Etherscan 金鑰    目前 ${raw.etherscanApiKey?.trim() ? '已填寫' : '未填寫'}`)
  console.log('  4. 啟用的鏈')
  console.log('  0. 返回')
  const choice = (await ask('> ')).trim()
  if (choice === '0' || !choice) return
  if (choice === '1') return editReceiver(raw)
  if (choice === '2') return editDiscovery(raw)
  if (choice === '3') return editEtherscanKey(raw)
  if (choice === '4') return editChains(raw)
  console.log('沒有這個選項。')
}

console.log('EVM 錢包彙整')

while (true) {
  showStatus(loadRaw())
  console.log('\n  1. 模擬（不上鏈）')
  console.log('  2. 正式執行')
  console.log('  3. 設定')
  console.log('  0. 返回')
  const choice = (await ask('> ')).trim()
  if (choice === '0' || choice === 'q') break
  if (choice === '1') {
    const code = await runEvm(false)
    console.log(code === 0 ? '\n模擬結束。' : `\n模擬結束，退出碼 ${code}。`)
    continue
  }
  if (choice === '2') {
    console.log('\n這會在設定檔啟用的 EVM 鏈上簽名並送出交易。')
    const code = await runEvm(true)
    console.log(code === 0 ? '\n執行結束。' : `\n執行結束，退出碼 ${code}。`)
    continue
  }
  if (choice === '3') {
    await editSettings()
    continue
  }
  console.log('請輸入 1、2、3 或 0。')
}
