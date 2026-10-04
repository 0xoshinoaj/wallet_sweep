/**
 * 用主網上「真的有代幣餘額」的帳戶，實際模擬「建目標帳戶 → 轉走全部 → 關閉退租金」。
 * 靠 sigVerify:false 不需要持有私鑰也能驗證指令編碼與帳戶順序是否正確。
 */
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import { connect, programLabel, scanOwner, sol, uiAmount } from '../src/solana/lib.js';

// 任何持有大量代幣帳戶、且有足夠 SOL 當模擬手續費來源的公開地址都可以
const SUBJECT = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const DESTINATION = Keypair.generate().publicKey;

const connection = connect();
console.log(`RPC ${connection.rpcEndpoint}`);

const report = await scanOwner(connection, SUBJECT);
const candidates = report.hasTokens.filter((a) => a.decimals != null && a.withheld === 0n);
assert.ok(candidates.length, '找不到有餘額的代幣帳戶可測');
console.log(`${SUBJECT.toBase58()} 有 ${candidates.length} 個可搬運的帳戶\n`);

let passed = 0;
for (const account of candidates.slice(0, 3)) {
  const destAta = getAssociatedTokenAddressSync(
    account.mint,
    DESTINATION,
    false,
    account.programId,
  );

  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      SUBJECT, destAta, DESTINATION, account.mint, account.programId,
    ),
    createTransferCheckedInstruction(
      account.pubkey, account.mint, destAta, SUBJECT,
      account.amount, account.decimals, [], account.programId,
    ),
    createCloseAccountInstruction(account.pubkey, DESTINATION, SUBJECT, [], account.programId),
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: SUBJECT,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  // 要求回傳模擬後的帳戶狀態，直接驗證結果而不是猜日誌內容
  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    accounts: {
      encoding: 'base64',
      addresses: [account.pubkey.toBase58(), destAta.toBase58()],
    },
  });

  const label =
    `${account.mint.toBase58().slice(0, 8)}… ${programLabel(account.programId)} ` +
    `${uiAmount(account)} 顆，租金 ${sol(account.lamports)} SOL`;

  if (sim.value.err) {
    console.log(`✗ ${label}\n  ${JSON.stringify(sim.value.err)}`);
    console.log((sim.value.logs ?? []).slice(-6).map((l) => `    ${l}`).join('\n'));
    throw new Error('轉帳+關閉模擬失敗');
  }

  const [sourceAfter, destAfter] = sim.value.accounts;

  // 關閉後的帳戶：lamports 歸零、資料清空、owner 退回系統程式，代表租金真的退出去了
  assert.ok(sourceAfter == null || sourceAfter.lamports === 0, '來源帳戶的租金沒有被取回');
  if (sourceAfter) {
    assert.equal(sourceAfter.space, 0, '來源帳戶資料沒有被清空');
    assert.equal(sourceAfter.owner, '11111111111111111111111111111111');
  }

  // 目標帳戶必須收到代幣
  assert.ok(destAfter, '目標代幣帳戶不存在');
  const received = unpackAccount(
    destAta,
    {
      data: Buffer.from(destAfter.data[0], 'base64'),
      owner: new PublicKey(destAfter.owner),
      lamports: destAfter.lamports,
      executable: false,
      rentEpoch: 0,
    },
    account.programId,
  ).amount;

  assert.ok(received > 0n, '目標帳戶餘額為 0，代幣沒搬過去');
  if (account.programId.equals(TOKEN_PROGRAM_ID)) {
    assert.equal(received, account.amount, '收到的數量和轉出的不符');
  } else {
    // Token-2022 若設有轉帳手續費，到帳會少一點，這是正常的
    assert.ok(received <= account.amount);
  }

  console.log(`✓ ${label}  到帳 ${received}  CU ${sim.value.unitsConsumed}`);
  passed += 1;
  await new Promise((r) => setTimeout(r, 600)); // 公共 RPC 會限流
}

console.log(`\n轉帳+關閉模擬全部通過（${passed} 個帳戶）`);
