# sweap

同一個專案裡的兩條鏈：

- **EVM**：把多組自己的錢包，在設定檔啟用的鏈上，把值得轉的資產送到同一個接收地址。
- **Solana**：關掉舊錢包裡閒置的 SPL Token / Token-2022 帳戶，退回租金，並把代幣與剩餘 SOL 送到接收地址。手續費可以由 gas 錢包支付。

兩邊的程式都是 TypeScript，放在 `src/evm/` 與 `src/solana/`。參數分別寫在 `config/evm.json` 與 `config/solana.json`。預設都是模擬，加上 `--execute` 才會簽名送出。

## 安裝

```bash
npm install
npm start
```

第一次 `npm start` 會把還不存在的檔案從範例複製出來，已存在的不會覆蓋：

| 範例 | 建立成 |
| --- | --- |
| `config/evm.example.json` | `config/evm.json` |
| `config/solana.example.json` | `config/solana.json` |
| `wallets_keys/evm_keys.example` | `wallets_keys/evm_keys` |
| `wallets_keys/evm_gas_provider.example` | `wallets_keys/evm_gas_provider` |
| `wallets_keys/solana_keys.example` | `wallets_keys/solana_keys` |
| `wallets_keys/solana_gas_provider.example` | `wallets_keys/solana_gas_provider` |

私鑰都在 `wallets_keys/`。`keys` 是來源錢包，`gas_provider` 是幫它們付手續費的錢包。

| 路徑 | 用途 |
| --- | --- |
| `config/evm.json` | EVM 接收地址、要掃的鏈、各鏈 RPC、過濾條件。不放私鑰 |
| `wallets_keys/evm_keys` | EVM 來源私鑰，一行一組 |
| `wallets_keys/evm_gas_provider` | 可選。幫沒有原生幣的 EVM 錢包補 gas，只放一組私鑰 |
| `config/solana.json` | Solana RPC、接收地址與開關。不放私鑰。選單會直接改這個檔 |
| `wallets_keys/solana_keys` | Solana 舊錢包。掃描可放公鑰，回收要放私鑰 |
| `wallets_keys/solana_gas_provider` | 可選。Solana gas 錢包私鑰，只放一組。沒有這個檔就由各舊錢包自己付 |

`config/evm.json`、`config/solana.json` 與 `wallets_keys` 裡的私鑰檔已在 `.gitignore`。這兩個設定檔會放私人 RPC 和 API 金鑰。範例檔 `config/evm.example.json`、`config/solana.example.json` 可以提交。

## 執行

```bash
npm start                              # 先選 EVM 或 Solana，再選模擬、正式或設定
npm run evm                            # EVM 模擬
npm run evm -- --execute               # EVM 正式轉帳
npm run solana                         # Solana 選單
npm run solana:scan -- --verbose       # 只掃描，來源檔可只放公鑰
npm run solana:reclaim                 # Solana 模擬
npm run solana:reclaim -- --execute    # Solana 正式回收
```

## EVM

每條鏈是獨立網路。`config/evm.json` 的 `chains` 決定範圍，`enabled: false` 就略過。內建 `ethereum`、`base`、`arbitrum`、`optimism`、`polygon`、`bsc`、`avalanche`、`gravity`、`robinhood`。自訂鏈要自己給 chain id、RPC、原生幣價格代號與 DefiLlama 的鏈名。

要換某一條鏈的節點，在該鏈加上 `rpcUrl`，或用 `rpcUrls` 放多個（前面的失敗會換下一個）：

```json
{ "preset": "ethereum", "enabled": true, "rpcUrl": "https://你的節點" }
```

沒寫 `rpcUrl` 時，用 `src/evm/chains.ts` 裡該鏈的公開節點。

`discovery`：

| 值 | 行為 |
| --- | --- |
| `allowlist`（預設） | 只查原生幣和內建白名單 |
| `blockscout` | 再加上該鏈 Blockscout 看得到的 ERC-20，然後過濾 |
| `etherscan` | 用 Etherscan API v2。把金鑰寫在 `etherscanApiKey`。免費方案每秒 5 次，程式把呼叫間隔開，維持在每秒 4 次以內 |

白名單以外的代幣要同時通過這些關卡才會轉：名稱不像空投、瀏覽器沒標成詐騙、DefiLlama 有夠新的美元價格、GoPlus 沒標成蜜罐且賣出稅不超過 `maxSellTax`、`eth_estimateGas` 模擬成功、扣稅後的美元價值高過 gas。

同一個錢包會先轉代幣，再掃剩餘原生幣。代幣沒轉成時，這次留下原生幣。`gasProviderFile` 留空代表不補 gas。

正式執行會先印出計畫，再要求輸入接收地址的末 4 碼。輸入不符就取消，不會簽名。

## Solana

RPC 寫在 `config/solana.json` 的 `rpcUrl`。選單「設定」裡的 RPC 也是改這個欄位。留空會用公共節點 `https://api.mainnet-beta.solana.com`。

`config/solana.json` 裡最常用的開關：

```json
{
  "transferTokensBeforeClose": true,
  "sweepNativeSol": true,
  "receiverMustExist": true
}
```

正式執行還要輸入接收地址的末 4 碼。一筆交易依實際序列化大小自動分批，不超過 1232 bytes。

腳本會擋住這些情況：接收地址打錯或尚未存在、把 SOL 轉進代幣帳戶、`keepSol` 落在 0 和免租下限之間、凍結或 `closeAuthority` 不是本人、讀不到 mint decimals、模擬失敗。

Solana 規定交易結束時餘額只能是 0 或 ≥ `0.00089088` SOL。gas 錢包付手續費時，來源錢包可以轉到剩 0。

## 測試

```bash
npm test                 # Solana 分批與計畫、EVM 過濾，都不上鏈
npm run test:solana-sim  # 用主網公開帳戶模擬轉帳，需要 RPC
npm run typecheck
```
