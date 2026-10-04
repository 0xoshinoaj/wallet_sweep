/**
 * Devnet 測試環境：建立 2 個「舊錢包」、幾個空的代幣帳戶、1 個有 dust 的帳戶，
 * 涵蓋 SPL Token 與 Token-2022 兩種 program，然後產生 test/solana_keys 供腳本使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccountIdempotent,
  mintTo,
} from '@solana/spl-token';

const RPC = process.env.DEVNET_RPC || 'https://api.devnet.solana.com';
const dir = path.resolve('test');
const connection = new Connection(RPC, 'confirmed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function airdrop(pubkey, sol) {
  for (let i = 0; i < 6; i++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      return true;
    } catch (err) {
      console.log(`  airdrop 重試 ${i + 1}: ${String(err.message).slice(0, 80)}`);
      await sleep(3000 * (i + 1));
    }
  }
  return false;
}

const gasProvider = Keypair.generate();
const receiver = Keypair.generate();
const oldWallets = [Keypair.generate(), Keypair.generate()];

console.log(`gasProvider    ${gasProvider.publicKey.toBase58()}`);
console.log(`receiver ${receiver.publicKey.toBase58()}`);
oldWallets.forEach((w, i) => console.log(`wallet${i + 1}   ${w.publicKey.toBase58()}`));

console.log('\n領 devnet SOL…');
let balance = await connection.getBalance(gasProvider.publicKey);
if (balance < 1 * LAMPORTS_PER_SOL) {
  if (!(await airdrop(gasProvider.publicKey, 2))) {
    console.error('devnet 水龍頭拿不到 SOL，請稍後再試或設 DEVNET_RPC。');
    process.exit(1);
  }
}
balance = await connection.getBalance(gasProvider.publicKey);
console.log(`gasProvider 餘額 ${balance / LAMPORTS_PER_SOL} SOL`);

console.log('\n建立 mint…');
const mintLegacy = await createMint(connection, gasProvider, gasProvider.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
const mint2022 = await createMint(connection, gasProvider, gasProvider.publicKey, null, 9, undefined, undefined, TOKEN_2022_PROGRAM_ID);
console.log(`  legacy ${mintLegacy.toBase58()}`);
console.log(`  2022   ${mint2022.toBase58()}`);

console.log('\n建立代幣帳戶（由 gasProvider 付 rent，舊錢包本身留 0 SOL）…');
const created = [];
for (const [i, wallet] of oldWallets.entries()) {
  const ataLegacy = await createAssociatedTokenAccountIdempotent(
    connection, gasProvider, mintLegacy, wallet.publicKey, undefined, TOKEN_PROGRAM_ID,
  );
  const ata2022 = await createAssociatedTokenAccountIdempotent(
    connection, gasProvider, mint2022, wallet.publicKey, undefined, TOKEN_2022_PROGRAM_ID,
  );
  created.push(ataLegacy, ata2022);
  console.log(`  wallet${i + 1} legacy ${ataLegacy.toBase58()}`);
  console.log(`  wallet${i + 1} 2022   ${ata2022.toBase58()}`);

  // 第一個錢包的 legacy 帳戶放 0.5 顆代幣，用來測 --burn-dust
  if (i === 0) {
    await mintTo(connection, gasProvider, mintLegacy, ataLegacy, gasProvider, 500_000n, [], undefined, TOKEN_PROGRAM_ID);
    console.log(`  wallet1 legacy 已鑄入 0.5 顆（測 burn-dust）`);
  }
}

// 第二個錢包給一點 SOL，用來測自付手續費 + sweep 歸零
await (async () => {
  const { SystemProgram, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: gasProvider.publicKey,
      toPubkey: oldWallets[1].publicKey,
      lamports: 0.02 * LAMPORTS_PER_SOL,
    }),
  );
  await sendAndConfirmTransaction(connection, tx, [gasProvider]);
  console.log(`\nwallet2 已入帳 0.02 SOL（測自付 gas + sweep 歸零）`);
})();

fs.writeFileSync(
  path.join(dir, 'solana_keys'),
  oldWallets.map((w, i) => `${bs58.encode(w.secretKey)}  # wallet${i + 1}`).join('\n') + '\n',
);
fs.writeFileSync(path.join(dir, 'solana_gas_provider'), `${bs58.encode(gasProvider.secretKey)}\n`);
fs.writeFileSync(
  path.join(dir, 'env.json'),
  JSON.stringify(
    {
      rpc: RPC,
      gasProvider: gasProvider.publicKey.toBase58(),
      receiver: receiver.publicKey.toBase58(),
      wallets: oldWallets.map((w) => w.publicKey.toBase58()),
      tokenAccounts: created.map((a) => a.toBase58()),
    },
    null,
    2,
  ),
);

console.log('\n完成。檔案：test/solana_keys test/solana_gas_provider test/env.json');
