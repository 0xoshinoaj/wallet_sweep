/**
 * 離線驗證：關帳戶指令的分批不能超過 1232 bytes，且簽名者數量要正確。
 */
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { MAX_TX_BYTES, budgetInstructions, packGroups, DUMMY_BLOCKHASH } from '../src/solana/lib.js';

const owner = Keypair.generate();
const gasProvider = Keypair.generate();
const receiver = Keypair.generate().publicKey;

for (const total of [1, 5, 25, 64, 200]) {
  for (const signerCount of [1, 2]) {
    const feePayer = signerCount === 1 ? owner : gasProvider;
    const groups = Array.from({ length: total }, (_, i) => {
      const account = Keypair.generate().publicKey;
      const programId = i % 3 === 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      return {
        ixs: [createCloseAccountInstruction(account, receiver, owner.publicKey, [], programId)],
        meta: { pubkey: account, lamports: 2_039_280 },
      };
    });

    const header = budgetInstructions({ priorityFee: 50_000, computeUnits: 200_000 });
    const batches = packGroups(groups, {
      payerKey: feePayer.publicKey,
      header,
      signerCount,
      maxPerTx: 25,
    });

    const packed = batches.reduce((sum, b) => sum + b.metas.length, 0);
    assert.equal(packed, total, '帳戶數不能漏');

    let maxBytes = 0;
    for (const batch of batches) {
      assert.ok(batch.metas.length <= 25, 'maxPerTx 必須生效');
      const message = new TransactionMessage({
        payerKey: feePayer.publicKey,
        recentBlockhash: DUMMY_BLOCKHASH,
        instructions: [...header, ...batch.ixs],
      }).compileToV0Message();
      const tx = new VersionedTransaction(message);
      tx.sign(signerCount === 1 ? [owner] : [gasProvider, owner]);
      const size = tx.serialize().length;
      maxBytes = Math.max(maxBytes, size);
      assert.ok(size <= MAX_TX_BYTES, `交易過大 ${size} bytes`);
      assert.equal(
        message.header.numRequiredSignatures,
        signerCount,
        '簽名者數量應為 ' + signerCount,
      );
    }
    console.log(
      `${String(total).padStart(3)} 個帳戶 / ${signerCount} 簽名 → ${batches.length} 筆交易，` +
        `最大 ${maxBytes} bytes`,
    );
  }
}

// 轉帳群組：建目標 ATA + transferChecked + close，三個指令必須留在同一筆交易裡
{
  const destination = Keypair.generate().publicKey;
  const groups = Array.from({ length: 40 }, (_, i) => {
    const mint = Keypair.generate().publicKey;
    const programId = i % 3 === 0 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const source = getAssociatedTokenAddressSync(mint, owner.publicKey, false, programId);
    const destAta = getAssociatedTokenAddressSync(mint, destination, false, programId);
    return {
      ixs: [
        createAssociatedTokenAccountIdempotentInstruction(
          gasProvider.publicKey, destAta, destination, mint, programId,
        ),
        createTransferCheckedInstruction(
          source, mint, destAta, owner.publicKey, 12_500_000n, 6, [], programId,
        ),
        createCloseAccountInstruction(source, receiver, owner.publicKey, [], programId),
      ],
      meta: { pubkey: source },
    };
  });

  const header = budgetInstructions({ priorityFee: 0, computeUnits: 200_000 });
  const batches = packGroups(groups, {
    payerKey: gasProvider.publicKey,
    header,
    signerCount: 2,
    maxPerTx: 25,
  });

  assert.equal(batches.reduce((s, b) => s + b.metas.length, 0), 40);

  let maxBytes = 0;
  for (const batch of batches) {
    // 每個帳戶的三個指令不能被拆散
    assert.equal(batch.ixs.length, batch.metas.length * 3, '轉帳指令群被拆開了');
    const message = new TransactionMessage({
      payerKey: gasProvider.publicKey,
      recentBlockhash: DUMMY_BLOCKHASH,
      instructions: [...header, ...batch.ixs],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([gasProvider, owner]);
    maxBytes = Math.max(maxBytes, tx.serialize().length);
    assert.ok(tx.serialize().length <= MAX_TX_BYTES);
  }
  console.log(
    `\n轉帳+關閉 40 個帳戶 → ${batches.length} 筆交易，最大 ${maxBytes} bytes、` +
      `每筆 ${Math.max(...batches.map((b) => b.metas.length))} 個帳戶`,
  );
}

// ComputeBudget program id 不應被誤算進 token program
assert.ok(
  budgetInstructions({ priorityFee: 1, computeUnits: 1 }).every((ix) =>
    ix.programId.equals(new PublicKey('ComputeBudget111111111111111111111111111111')),
  ),
);

console.log('\n打包測試全部通過');
