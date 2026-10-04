/**
 * 驗證 config.mjs 的開關真的決定了每個帳戶的處理方式。
 */
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { planAccount } from '../src/solana/plan.js';

const owner = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;

function account(overrides) {
  return {
    pubkey: Keypair.generate().publicKey,
    programId: TOKEN_PROGRAM_ID,
    mint: Keypair.generate().publicKey,
    owner,
    lamports: 2_039_280,
    amount: 0n,
    isNative: false,
    isFrozen: false,
    closeAuthority: null,
    withheld: 0n,
    status: 'empty',
    decimals: null,
    ...overrides,
  };
}

const DEFAULTS = {
  requireEmptyBeforeClose: true,
  transferTokensBeforeClose: false,
  burnDustBelow: null,
};

// USDT 帳戶：裡面還有 12.5 顆
const withTokens = account({ status: 'has-tokens', amount: 12_500_000n, decimals: 6 });
// 真正的灰塵：0.000001 顆
const dust = account({ status: 'has-tokens', amount: 1n, decimals: 6 });

const cases = [
  ['空帳戶一律直接關', account(), DEFAULTS, 'close'],
  ['wSOL 關閉時會自動解包', account({ status: 'wsol', isNative: true, amount: 5n }), DEFAULTS, 'close'],

  ['預設：有代幣就不關', withTokens, DEFAULTS, 'skip'],
  [
    'requireEmptyBeforeClose=false 但沒開搬幣，照樣不關',
    withTokens,
    { ...DEFAULTS, requireEmptyBeforeClose: false },
    'skip',
  ],
  [
    '開啟 transferTokensBeforeClose：先轉走再關',
    withTokens,
    { ...DEFAULTS, transferTokensBeforeClose: true },
    'transfer',
  ],
  [
    'requireEmpty 與 transfer 同時開：轉走後就是空的，仍然要轉',
    withTokens,
    { ...DEFAULTS, requireEmptyBeforeClose: true, transferTokensBeforeClose: true },
    'transfer',
  ],
  [
    '讀不到 decimals 時寧可跳過，不冒險轉帳',
    account({ status: 'has-tokens', amount: 12_500_000n, decimals: null }),
    { ...DEFAULTS, transferTokensBeforeClose: true },
    'skip',
  ],

  ['灰塵低於門檻才銷毀', dust, { ...DEFAULTS, burnDustBelow: 0.000001 }, 'burn'],
  ['12.5 顆遠高於灰塵門檻，不銷毀', withTokens, { ...DEFAULTS, burnDustBelow: 0.000001 }, 'skip'],
  [
    '轉帳優先於銷毀，代幣不會被燒掉',
    dust,
    { ...DEFAULTS, transferTokensBeforeClose: true, burnDustBelow: 0.000001 },
    'transfer',
  ],

  [
    '開了轉移就連 NFT 一起轉走再關',
    account({ status: 'has-tokens', amount: 1n, decimals: 0, supply: 1n }),
    { ...DEFAULTS, transferTokensBeforeClose: true },
    'transfer',
  ],
  [
    '不可轉讓的 SBT 轉不走，也不會被銷毀',
    account({ status: 'has-tokens', amount: 1n, decimals: 0, supply: 1n, nonTransferable: true }),
    { ...DEFAULTS, transferTokensBeforeClose: true },
    'skip',
  ],
  [
    '灰塵門檻不會誤燒 NFT',
    account({ status: 'has-tokens', amount: 1n, decimals: 0, supply: 1n }),
    { ...DEFAULTS, burnDustBelow: 1 },
    'skip',
  ],

  ['被凍結的帳戶不能動', account({ status: 'blocked-frozen', isFrozen: true }), DEFAULTS, 'skip'],
  [
    'closeAuthority 不是本人就不能關',
    account({ status: 'blocked-authority', closeAuthority: other }),
    DEFAULTS,
    'skip',
  ],
];

for (const [name, acct, settings, expected] of cases) {
  const result = planAccount(acct, settings);
  assert.equal(result.action, expected, `${name}：預期 ${expected}，實際 ${result.action}`);
  if (expected === 'skip') assert.ok(result.reason, `${name}：skip 必須附上原因`);
  console.log(`✓ ${name}${result.reason ? `（${result.reason}）` : ''}`);
}

console.log('\n決策測試全部通過');
