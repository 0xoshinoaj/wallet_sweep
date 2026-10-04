import { uiAmount, short } from './lib.js'
import type { AccountPlan, TokenAccount } from './types.js'

/**
 * 標準 NFT：發行量剛好 1、decimals 為 0。
 * 餘額是 1，不是租金那種「最低下限」。帳戶另外還鎖著約 0.002 SOL 租金。
 */
export function isNft(account: Pick<TokenAccount, 'decimals' | 'supply'>): boolean {
  return account.decimals === 0 && account.supply === 1n
}

/**
 * 決定一個代幣帳戶要怎麼處理。
 *
 * 有餘額且開了 transferTokensBeforeClose：全額轉去接收地址，再關閉。
 * 不看 mint 白名單。轉不走的（凍結、不可轉讓）維持跳過，不會銷毀。
 */
export function planAccount(
  account: TokenAccount,
  settings: { transferTokensBeforeClose: boolean; burnDustBelow: number | null },
): AccountPlan {
  if (account.status === 'empty' || account.status === 'wsol') {
    return { action: 'close' }
  }

  if (account.status === 'blocked-frozen') {
    return { action: 'skip', reason: '帳戶被發行方凍結，關不掉也轉不走' }
  }
  if (account.status === 'blocked-authority') {
    return {
      action: 'skip',
      reason: `closeAuthority 是 ${short(account.closeAuthority)}，不是本人`,
    }
  }

  const ui = uiAmount(account)
  const amount = ui ?? `${account.amount} raw`

  if (account.nonTransferable) {
    return { action: 'skip', reason: `還有 ${amount}，這是不可轉讓的 SBT，轉不走也沒有銷毀` }
  }

  if (settings.transferTokensBeforeClose) {
    if (account.decimals == null) {
      return { action: 'skip', reason: '讀不到 mint 的 decimals，不敢轉帳' }
    }
    return { action: 'transfer' }
  }

  if (
    settings.burnDustBelow != null &&
    !isNft(account) &&
    ui != null &&
    ui <= settings.burnDustBelow
  ) {
    return { action: 'burn' }
  }

  return {
    action: 'skip',
    reason: `還有 ${amount}，transferTokensBeforeClose 沒開，所以不轉也不關`,
  }
}
