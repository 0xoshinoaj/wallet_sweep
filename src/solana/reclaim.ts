import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, type TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { solanaConfigFile, solanaGasProviderFile, solanaKeysFile } from '../paths.js';
import {
  ATA_RENT,
  MAX_TX_BYTES,
  SYSTEM_ACCOUNT_RENT,
  budgetInstructions,
  connect,
  errorText,
  loadKeypairs,
  packGroups,
  parseSecretKey,
  scanOwner,
  sendAndConfirm,
  serializedSize,
  mark,
  short,
  sleep,
  sol,
  solc,
  withRetry,
} from './lib.js';
import { planAccount } from './plan.js';
import { CLI_OPTIONS, checkOnChain, checkSettings, confirm, loadSettings, readySettings, type CliValues } from './settings.js';
import { isSweepSkip, type PlannedAccount, type ReadySettings, type SweepPlan } from './types.js';

const { values: cli } = parseArgs({ options: CLI_OPTIONS }) as { values: CliValues };

if (cli.help) {
  console.log(`
用法：npm run solana:reclaim -- [選項]

大部分設定寫在 ${solanaConfigFile}，命令列參數會覆蓋它。

  --config <file>          設定檔路徑（預設 ${solanaConfigFile}）
  --keys <file>            來源私鑰檔（預設 ${solanaKeysFile}）
  --gas-provider <key|file> 覆蓋 ${solanaGasProviderFile}；不給就讀那個檔，也空則各錢包自付
  --receiver <pubkey>      租金、SOL 與代幣的接收地址
  --transfer-tokens        先把代幣轉走再關帳戶
  --allow-nonempty         關閉「必須清空才能關」的檢查
  --allow-new-receiver     允許匯入鏈上還不存在的新地址（預設擋住，防打錯字）
  --burn-dust <uiAmount>   餘額 <= 此值的代幣直接銷毀再關（代幣永久消失）
  --sweep / --no-sweep     是否把剩餘原生 SOL 也掃去接收地址
  --keep <SOL>             sweep 時留在原錢包的數量（0 或 >= 0.00089088）
  --min-reclaim <SOL>      可回收低於此值的錢包直接跳過
  --priority-fee <micro>   優先費（microLamports / CU）
  --max-per-tx <n>         單筆交易最多處理幾個帳戶
  --only <pk,pk>           只處理指定錢包
  --execute                真的送交易（預設只模擬）
  --yes                    跳過手動確認
  --skip-simulate          送交易前不先模擬（不建議）
`);
  process.exit(0);
}

// ──────────────────────────────── 設定與離線檢查

let settings: ReadySettings;
let offline: { errors: string[]; warnings: string[] };
try {
  const loaded = await loadSettings(cli);
  offline = checkSettings(loaded);
  if (offline.errors.length) {
    console.error('設定有問題，已停止：');
    offline.errors.forEach((entry) => console.error(`  ✗ ${entry}`));
    process.exit(1);
  }
  settings = readySettings(loaded);
} catch (error) {
  console.error(`設定讀取失敗：\n  ${errorText(error)}`);
  process.exit(1);
}

let wallets: Keypair[];
try {
  wallets = loadKeypairs(settings.keysFile);
} catch (error) {
  console.error(`讀取 ${settings.keysFile} 失敗：\n  ${errorText(error)}`);
  process.exit(1);
}
if (settings.only) wallets = wallets.filter((kp) => settings.only?.has(kp.publicKey.toBase58()));
if (!wallets.length) {
  console.error(`${settings.keysFile} 裡沒有可用的錢包私鑰。`);
  process.exit(1);
}

const gasProvider = settings.gasProviderArg ? loadKeyArg(settings.gasProviderArg) : null;

function loadKeyArg(value: string): Keypair {
  try {
    if (fs.existsSync(value)) {
      const [first] = loadKeypairs(value);
      if (!first) throw new Error('檔案裡沒有私鑰');
      return first;
    }
    return parseSecretKey(value);
  } catch (error) {
    console.error(`--gas-provider 無法讀取：\n  ${errorText(error)}`);
    process.exit(1);
  }
}

// ──────────────────────────────── 連線與鏈上檢查

const connection = connect(settings.rpcUrl || undefined);
let onchain;
try {
  onchain = await checkOnChain(connection, settings, wallets.map((w) => w.publicKey));
} catch (error) {
  console.error(`鏈上檢查失敗：${errorText(error)}`);
  process.exit(1);
}

console.log(`叢集            ${onchain.cluster}`);
console.log(`RPC             ${connection.rpcEndpoint}`);
console.log(`設定檔          ${settings.configPath}`);
console.log(`錢包來源        ${settings.keysFile}（${wallets.length} 個）`);
console.log(`接收地址        ${settings.receiver.toBase58()}`);
console.log(`gas 錢包        ${gasProvider ? gasProvider.publicKey.toBase58() : '各錢包自己付'}`);
console.log('');
console.log(`有餘額先轉再關  ${settings.transferTokensBeforeClose ? '是，不限幣種' : '否'}`);
console.log(`銷毀灰塵門檻    ${settings.burnDustBelow ?? '不啟用'}`);
console.log(`掃原生 SOL      ${settings.sweepNativeSol ? `是（留 ${sol(settings.keepLamports)}）` : '否'}`);
console.log(`模式            ${settings.dryRun ? 'DRY RUN：只模擬，不會上鏈' : '*** EXECUTE：會真的送出交易 ***'}`);

const allWarnings = [...offline.warnings, ...onchain.warnings];
if (allWarnings.length) {
  console.log('\n提醒：');
  allWarnings.forEach((w) => console.log(`  ! ${w}`));
}
if (onchain.errors.length) {
  console.error('\n鏈上檢查不通過，已停止：');
  onchain.errors.forEach((e) => console.error(`  ✗ ${e}`));
  process.exit(1);
}

if (settings.transferTokensBeforeClose && !gasProvider) {
  console.log(
    `\n  ! 已開啟轉代幣但沒有指定 gas 錢包。每個舊錢包得自己出 ${sol(ATA_RENT)} SOL\n` +
      '    去建立目標錢包的代幣帳戶，餘額不足的錢包會被跳過。',
  );
}

if (gasProvider) {
  const gasProviderBalance = await withRetry(() => connection.getBalance(gasProvider.publicKey));
  console.log(`\ngas 錢包餘額    ${solc(gasProviderBalance)} SOL`);
  if (gasProviderBalance < 10_000_000) {
    console.log('  ! 餘額偏低，建議至少放 0.01 SOL。關帳戶退的租金是進接收地址，不會回到 gas 錢包。');
  }
}

if (!settings.dryRun && settings.requireConfirmation) {
  // 要求手動輸入地址尾碼，強迫使用者真的看一眼接收地址。
  // 地址打錯不會有任何錯誤訊息，錢會直接消失。
  const receiver = settings.receiver.toBase58();
  const tail = receiver.slice(-4);
  console.log(`\n所有 SOL 與代幣將匯入：${receiver}`);
  const answer = await confirm(`請輸入上面接收地址的最後 4 個字元（${'•'.repeat(4)}）以確認：`);
  if (answer !== tail) {
    console.log(`輸入不符（應為 ${tail}），已取消，沒有送出任何交易。`);
    process.exit(0);
  }
}

// ──────────────────────────────── 主流程

const stats = {
  txs: 0,
  closed: 0,
  transferred: 0,
  burned: 0,
  reclaimed: 0,
  swept: 0,
  ataCreated: 0,
  skippedAccounts: 0,
  skippedWallets: 0,
  failed: 0,
};
const ataExists = new Map<string, boolean>();
const ataPlanned = new Set<string>();
const skipReasons = new Map<string, number>();

for (const [index, wallet] of wallets.entries()) {
  const owner = wallet.publicKey;
  console.log(`\n[${index + 1}/${wallets.length}] ${owner.toBase58()}`);

  let report;
  try {
    report = await scanOwner(connection, owner);
  } catch (error) {
    console.log(`    掃描失敗：${errorText(error)}`);
    stats.failed += 1;
    continue;
  }

  const plans = report.accounts.map((account) => ({ account, ...planAccount(account, settings) }));
  const actionable = plans.filter((p) => p.action !== 'skip');
  const skipped = plans.filter((p) => p.action === 'skip');
  for (const p of skipped) {
    stats.skippedAccounts += 1;
    skipReasons.set(p.reason, (skipReasons.get(p.reason) ?? 0) + 1);
  }

  const reclaimable = actionable.reduce((sum, p) => sum + p.account.lamports, 0);
  const counts = actionable.reduce<Record<string, number>>((acc, plan) => {
    acc[plan.action] = (acc[plan.action] ?? 0) + 1;
    return acc;
  }, {});

  console.log(
    `    餘額 ${solc(report.lamports)} SOL｜代幣帳戶 ${mark(report.accounts.length)} 個` +
      `｜直接關 ${mark(counts.close ?? 0)}｜轉走後關 ${mark(counts.transfer ?? 0)}` +
      `｜銷毀後關 ${mark(counts.burn ?? 0)}｜跳過 ${mark(skipped.length)}` +
      `｜可回收租金 ${solc(reclaimable)} SOL` +
      (settings.sweepNativeSol && report.lamports > 0 ? `｜另掃餘額 ${solc(report.lamports)} SOL` : ''),
  );
  for (const p of skipped) {
    console.log(`      skip ${short(p.account.pubkey, 6, 6)}  ${p.reason}`);
  }

  if (!actionable.length && !settings.sweepNativeSol) {
    stats.skippedWallets += 1;
    continue;
  }
  if (actionable.length && reclaimable < settings.minReclaimLamports) {
    console.log(`    可回收低於 minReclaimSol，整個錢包跳過。`);
    stats.skippedWallets += 1;
    continue;
  }

  const feePayer = gasProvider ?? wallet;
  const signers = gasProvider ? [gasProvider, wallet] : [wallet];

  if (!gasProvider && report.lamports < 10_000) {
    console.log(
      actionable.length
        ? '    這個錢包沒有 SOL 付手續費，請指定 gas 錢包。跳過。'
        : '    沒有可關的帳戶，餘額也不足以再轉出。跳過。',
    );
    stats.skippedWallets += 1;
    continue;
  }

  let sweptInCloseTx = false;
  if (actionable.length) {
    sweptInCloseTx = await processAccounts({ owner, actionable, feePayer, signers });
  }

  if (settings.sweepNativeSol && !sweptInCloseTx) {
    try {
      await sweepNative({ wallet, feePayer, signers });
    } catch (err) {
      stats.failed += 1;
      console.log(`    sweep ❌ ${firstLine(err)}`);
    }
  }

  if (index < wallets.length - 1) await sleep(settings.delayMs);
}

printSummary();

// ──────────────────────────────── 組交易並送出

async function processAccounts({
  owner,
  actionable,
  feePayer,
  signers,
}: {
  owner: PublicKey;
  actionable: PlannedAccount[];
  feePayer: Keypair;
  signers: Keypair[];
}): Promise<boolean> {
  let sweptHere = false;
  const transfers = actionable.filter((plan) => plan.action === 'transfer');
  const ataByAccount = new Map<string, PublicKey>();

  if (transfers.length) {
    const needed: PublicKey[] = [];
    for (const p of transfers) {
      const ata = getAssociatedTokenAddressSync(
        p.account.mint,
        settings.receiver,
        false,
        p.account.programId,
      );
      ataByAccount.set(p.account.pubkey.toBase58(), ata);
      if (!ataExists.has(ata.toBase58())) needed.push(ata);
    }
    if (needed.length) {
      const infos = await withRetry(() => connection.getMultipleAccountsInfo(needed));
      needed.forEach((ata, i) => ataExists.set(ata.toBase58(), infos[i] != null));
    }
  }

  const groups = actionable.map((plan) => {
    const { account, action } = plan;
    const ixs: TransactionInstruction[] = [];

    if (account.withheld > 0n) {
      ixs.push(
        createHarvestWithheldTokensToMintInstruction(account.mint, [account.pubkey], account.programId),
      );
    }

    if (action === 'transfer') {
      const ata = ataByAccount.get(account.pubkey.toBase58());
      if (!ata || account.decimals == null) {
        throw new Error(`缺少目標帳戶或 decimals：${account.pubkey.toBase58()}`);
      }
      if (!ataExists.get(ata.toBase58())) {
        ataPlanned.add(ata.toBase58());
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(
            feePayer.publicKey,
            ata,
            settings.receiver,
            account.mint,
            account.programId,
          ),
        );
      }
      ixs.push(
        createTransferCheckedInstruction(
          account.pubkey,
          account.mint,
          ata,
          owner,
          account.amount,
          account.decimals,
          [],
          account.programId,
        ),
      );
    }

    if (action === 'burn') {
      ixs.push(
        createBurnInstruction(account.pubkey, account.mint, owner, account.amount, [], account.programId),
      );
    }

    ixs.push(
      createCloseAccountInstruction(account.pubkey, settings.receiver, owner, [], account.programId),
    );

    return { ixs, meta: plan };
  });

  const batches = packGroups(groups, {
    payerKey: feePayer.publicKey,
    header: budgetInstructions({ priorityFee: settings.priorityFee, computeUnits: 200_000 }),
    signerCount: signers.length,
    maxPerTx: settings.maxPerTx,
  });

  // 模擬不會真的扣手續費。自付時要把前面幾筆的費用先扣掉，最後一筆的掃餘額才算得準。
  let balanceDebt = 0;

  for (const [batchIndex, batch] of batches.entries()) {
    const isLast = batchIndex === batches.length - 1;
    const units = Math.min(1_400_000, 30_000 * batch.metas.length + 12_000);
    let instructions = [
      ...budgetInstructions({ priorityFee: settings.priorityFee, computeUnits: units }),
      ...batch.ixs,
    ];
    const rent = batch.metas.reduce((sum, p) => sum + p.account.lamports, 0);

    let sweep: Extract<SweepPlan, { amount: number }> | null = null;
    if (isLast && settings.sweepNativeSol) {
      const planned = await planSweep({
        owner,
        feePayer,
        extraInstructions: instructions,
        balanceDebt,
      });
      if (isSweepSkip(planned)) {
        console.log(`    sweep 跳過：${planned.skip}`);
        sweptHere = true;
      } else if (
        serializedSize(feePayer.publicKey, [...instructions, planned.instruction], signers.length) <=
        MAX_TX_BYTES
      ) {
        instructions = [...instructions, planned.instruction];
        sweep = planned;
      }
    }

    const label = sweep
      ? `    tx ${batchIndex + 1}/${batches.length}  關 ${mark(batch.metas.length)} 個 → 租金 +${solc(rent)} SOL，掃出 ${solc(sweep.amount)} SOL（手續費 ${sol(sweep.fee)}，留下 ${sol(sweep.remainder)}）`
      : `    tx ${batchIndex + 1}/${batches.length}  關 ${mark(batch.metas.length)} 個 → 租金 +${solc(rent)} SOL`;

    try {
      const res = await sendAndConfirm(connection, {
        payer: feePayer,
        signers,
        instructions,
        dryRun: settings.dryRun,
        skipSimulate: settings.skipSimulate,
      });
      if (sweep) {
        stats.swept += sweep.amount;
        sweptHere = true;
      } else if (settings.dryRun && feePayer.publicKey.equals(owner)) {
        balanceDebt += await messageFee(feePayer.publicKey, instructions);
      }

      stats.txs += 1;
      stats.closed += batch.metas.length;
      stats.reclaimed += rent;
      stats.transferred += batch.metas.filter((p) => p.action === 'transfer').length;
      stats.burned += batch.metas.filter((p) => p.action === 'burn').length;

      // 真的上鏈後 ATA 就存在了，後面的錢包不用再帶建立指令。
      // 模擬時不能這樣標記，否則下一個錢包的模擬會因為目標帳戶不存在而失敗。
      if (!res.simulated) {
        for (const plan of batch.metas.filter((item) => item.action === 'transfer')) {
          const ata = ataByAccount.get(plan.account.pubkey.toBase58());
          if (ata) ataExists.set(ata.toBase58(), true);
        }
      }

      console.log(`${label}  ${res.simulated ? '模擬 OK' : `✅ ${res.signature}`}`);
    } catch (err) {
      stats.failed += 1;
      console.log(`${label}  ❌ ${firstLine(err)}`);
      console.log(`        涉及帳戶：${batch.metas.map((p) => short(p.account.pubkey)).join(' ')}`);
    }

    await sleep(settings.delayMs);
  }

  return sweptHere;
}

/**
 * 算出要把原生 SOL 掃去接收地址的那筆轉帳。
 * extraInstructions 是同一筆交易裡已經要送的指令（關帳戶等）。
 * 租金是 CloseAccount 直接打給接收地址，不會先回到舊錢包，所以可轉金額仍是「現有餘額 − 這一筆的手續費」。
 * 自付時用 getFeeForMessage 問實際費用，轉帳金額本身不影響交易大小，所以先用 1 lamport 探測。
 */
async function planSweep({
  owner,
  feePayer,
  extraInstructions,
  balanceDebt = 0,
}: {
  owner: PublicKey;
  feePayer: Keypair;
  extraInstructions: TransactionInstruction[];
  balanceDebt?: number;
}): Promise<SweepPlan> {
  if (owner.equals(settings.receiver)) return { skip: '來源就是接收地址' };

  const balance = (await withRetry(() => connection.getBalance(owner))) - balanceDebt;
  const selfPay = feePayer.publicKey.equals(owner);
  const probe = [
    ...extraInstructions,
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: settings.receiver, lamports: 1 }),
  ];
  const fee = selfPay ? await messageFee(feePayer.publicKey, probe) : 0;
  const amount = balance - fee - settings.keepLamports;

  if (amount <= 0) {
    return {
      skip:
        balance <= 0
          ? '餘額為 0'
          : `餘額 ${sol(balance)} 扣掉手續費 ${sol(fee)} 與保留額 ${sol(settings.keepLamports)} 後沒有剩餘`,
    };
  }

  const remainder = balance - amount - fee;
  if (remainder !== 0 && remainder < SYSTEM_ACCOUNT_RENT) {
    return { skip: `會剩下 ${sol(remainder)}，低於免租下限且不為 0，鏈上必定失敗` };
  }

  return {
    instruction: SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: settings.receiver,
      lamports: amount,
    }),
    amount,
    fee,
    remainder,
  };
}

async function messageFee(payerKey: PublicKey, instructions: TransactionInstruction[]): Promise<number> {
  const { blockhash } = await withRetry(() => connection.getLatestBlockhash('confirmed'));
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return (await withRetry(() => connection.getFeeForMessage(message))).value ?? 5_000;
}

/** 沒有跟關帳戶併在一起時，單獨掃餘額。 */
async function sweepNative({
  wallet,
  feePayer,
  signers,
}: {
  wallet: Keypair;
  feePayer: Keypair;
  signers: Keypair[];
}): Promise<void> {
  const header = budgetInstructions({
    priorityFee: settings.priorityFee,
    computeUnits: settings.priorityFee > 0 ? 1_000 : 0,
  });
  const sweep = await planSweep({
    owner: wallet.publicKey,
    feePayer,
    extraInstructions: header,
  });
  if (isSweepSkip(sweep)) {
    console.log(`    sweep 跳過：${sweep.skip}`);
    return;
  }

  const res = await sendAndConfirm(connection, {
    payer: feePayer,
    signers,
    instructions: [...header, sweep.instruction],
    dryRun: settings.dryRun,
    skipSimulate: settings.skipSimulate,
  });

  stats.txs += 1;
  stats.swept += sweep.amount;
  console.log(
    `    sweep ${solc(sweep.amount)} SOL（手續費 ${sol(sweep.fee)}，留下 ${sol(sweep.remainder)}）` +
      `  ${res.simulated ? '模擬 OK' : `✅ ${res.signature}`}`,
  );
}

// ──────────────────────────────── 收尾

function printSummary() {
  stats.ataCreated = ataPlanned.size;
  const ataCost = stats.ataCreated * ATA_RENT;
  console.log('\n────────── 結果 ──────────');
  console.log(`交易            ${mark(stats.txs)} 筆${settings.dryRun ? '（模擬）' : ''}`);
  console.log(`關閉帳戶        ${mark(stats.closed)} 個`);
  if (stats.transferred) console.log(`轉走代幣        ${mark(stats.transferred)} 個帳戶`);
  if (stats.burned) console.log(`銷毀代幣        ${mark(stats.burned)} 個帳戶`);
  console.log(`回收租金        ${solc(stats.reclaimed)} SOL`);
  if (settings.sweepNativeSol) console.log(`掃出餘額        ${solc(stats.swept)} SOL`);
  if (stats.ataCreated) {
    console.log(`建立目標帳戶    ${mark(stats.ataCreated)} 個，成本 -${sol(ataCost)} SOL（由 gas 錢包支出）`);
  }
  console.log(`入帳接收地址  ${solc(stats.reclaimed + stats.swept)} SOL`);
  if (stats.ataCreated) console.log(`扣掉建帳成本淨  ${solc(stats.reclaimed + stats.swept - ataCost)} SOL`);

  if (skipReasons.size) {
    console.log(`\n跳過的代幣帳戶  ${stats.skippedAccounts} 個：`);
    for (const [reason, count] of [...skipReasons].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(4)} 個  ${reason}`);
    }
  }
  if (stats.skippedWallets) console.log(`\n跳過錢包        ${stats.skippedWallets} 個`);
  if (stats.failed) console.log(`失敗            ${stats.failed} 筆`);
  if (settings.dryRun) console.log('\n模擬都通過之後，加上 --execute 才會真的上鏈。');
}

function firstLine(error: unknown): string {
  return errorText(error).split('\n').slice(0, 3).join(' | ');
}
