import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { solanaGasProviderFile } from '../paths.js'

export function readGasProvider(file = solanaGasProviderFile): string | null {
  if (!existsSync(file)) return null
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .map((entry) => entry.split('#')[0].trim())
    .find(Boolean)
  return line || null
}

export function writeGasProvider(secret: string, file = solanaGasProviderFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, secret ? `${secret}\n` : '', { mode: 0o600 })
  chmodSync(file, 0o600)
}
