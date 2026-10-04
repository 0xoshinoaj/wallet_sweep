import type { PublicClient } from 'viem'
import type { FeeQuote } from './types.js'

export async function quoteFee(client: PublicClient): Promise<FeeQuote> {
  const fees = await client.estimateFeesPerGas()
  if (fees.maxFeePerGas != null) {
    return {
      feePerGas: fees.maxFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    }
  }
  const gasPrice = 'gasPrice' in fees ? fees.gasPrice : undefined
  if (gasPrice == null) throw new Error('節點沒有回傳 gas 價格')
  return { feePerGas: gasPrice, gasPrice }
}
