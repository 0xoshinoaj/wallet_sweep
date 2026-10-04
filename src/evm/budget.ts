export type BudgetSlot = {
  kind: 'native' | 'erc20'
  action: 'send' | 'skip'
  reason: string
  netValueUsd: number
  /** 這筆交易最多可能燒掉的原生幣（已含 gas 緩衝）。 */
  costWei: bigint
  /** 原生幣餘額。只有 native 槽位需要填。 */
  balanceWei: bigint
  sendWei: bigint
}

/**
 * 同一個錢包、同一條鏈共用一份原生幣付 gas。
 * 先送價值高的代幣；預留完 gas 後，剩下的原生幣再決定要不要一併轉走。
 */
export function topUpForShortfall(have: bigint, need: bigint): bigint {
  return need > have ? need - have : 0n
}

/** Base 與 Optimism 的 L1 data fee 要另外留。 */
export function opStackBuffer(chainId: number): bigint {
  return chainId === 10 || chainId === 8453 ? 2_000_000_000_000n : 0n
}

export function assignGasBudget(slots: BudgetSlot[]): void {
  const native = slots.find((slot) => slot.kind === 'native')
  let budget = native?.balanceWei ?? 0n

  const transfers = slots
    .filter((slot) => slot.kind === 'erc20' && slot.action === 'send')
    .sort((a, b) => b.netValueUsd - a.netValueUsd)

  for (const transfer of transfers) {
    if (transfer.costWei <= 0n || budget < transfer.costWei) {
      transfer.action = 'skip'
      transfer.reason = '原生幣不夠付 gas'
      transfer.sendWei = 0n
      continue
    }
    budget -= transfer.costWei
  }

  if (!native || native.action !== 'send') return
  if (native.costWei <= 0n || budget <= native.costWei) {
    native.action = 'skip'
    native.reason = '扣掉 gas 後沒有可轉的原生幣'
    native.sendWei = 0n
    return
  }
  native.sendWei = budget - native.costWei
}
