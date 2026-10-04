import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gravity,
  mainnet,
  optimism,
  polygon,
  robinhood,
  type Chain,
} from 'viem/chains'
import { getAddress, type Address } from 'viem'
import type { TokenRef } from './types.js'

export type ChainPreset = {
  key: string
  chain: Chain
  rpcUrls: string[]
  llamaChain: string
  nativeCoingeckoId: string
  nativeSymbol?: string
  blockscoutUrl?: string
  tokens: TokenRef[]
}

function token(symbol: string, address: string, assumedUsd?: number, decimals?: number): TokenRef {
  return {
    symbol,
    address: getAddress(address),
    ...(assumedUsd != null ? { assumedUsd } : {}),
    ...(decimals != null ? { decimals } : {}),
  }
}

const stable = (symbol: string, address: string, decimals = 18) => token(symbol, address, 1, decimals)

export const PRESETS: Record<string, ChainPreset> = {
  ethereum: {
    key: 'ethereum',
    chain: mainnet,
    rpcUrls: ['https://ethereum.publicnode.com', 'https://eth.llamarpc.com'],
    llamaChain: 'ethereum',
    nativeCoingeckoId: 'ethereum',
    blockscoutUrl: 'https://eth.blockscout.com',
    tokens: [
      stable('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
      stable('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
      stable('DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F'),
      token('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
      token('WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', undefined, 8),
      token('wstETH', '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'),
      token('LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA'),
      token('UNI', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984'),
      token('AAVE', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9'),
      token('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', undefined, 8),
    ],
  },
  base: {
    key: 'base',
    chain: base,
    rpcUrls: ['https://mainnet.base.org', 'https://base.publicnode.com'],
    llamaChain: 'base',
    nativeCoingeckoId: 'ethereum',
    blockscoutUrl: 'https://base.blockscout.com',
    tokens: [
      stable('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
      stable('USDbC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 6),
      stable('DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'),
      token('WETH', '0x4200000000000000000000000000000000000006'),
      token('cbBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', undefined, 8),
    ],
  },
  arbitrum: {
    key: 'arbitrum',
    chain: arbitrum,
    rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one.publicnode.com'],
    llamaChain: 'arbitrum',
    nativeCoingeckoId: 'ethereum',
    blockscoutUrl: 'https://arbitrum.blockscout.com',
    tokens: [
      token('WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
      stable('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
      stable('USDC.e', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6),
      stable('USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6),
      stable('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'),
      token('WBTC', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', undefined, 8),
      token('ARB', '0x912CE59144191C1204E64559FE8253a0e49E6548'),
    ],
  },
  optimism: {
    key: 'optimism',
    chain: optimism,
    rpcUrls: ['https://mainnet.optimism.io', 'https://optimism.publicnode.com'],
    llamaChain: 'optimism',
    nativeCoingeckoId: 'ethereum',
    blockscoutUrl: 'https://optimism.blockscout.com',
    tokens: [
      token('WETH', '0x4200000000000000000000000000000000000006'),
      stable('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
      stable('USDC.e', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 6),
      stable('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6),
      stable('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'),
      token('OP', '0x4200000000000000000000000000000000000042'),
      token('WBTC', '0x68f180fcCe6836688e9084f035309E29Bf0A2095', undefined, 8),
    ],
  },
  polygon: {
    key: 'polygon',
    chain: polygon,
    rpcUrls: [
      'https://polygon.drpc.org',
      'https://gateway.tenderly.co/public/polygon',
      'https://polygon.api.onfinality.io/public',
    ],
    llamaChain: 'polygon',
    nativeCoingeckoId: 'polygon-ecosystem-token',
    nativeSymbol: 'POL',
    blockscoutUrl: 'https://polygon.blockscout.com',
    tokens: [
      token('WMATIC', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'),
      stable('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
      stable('USDC.e', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6),
      stable('USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6),
      stable('DAI', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'),
      token('WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'),
      token('WBTC', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', undefined, 8),
    ],
  },
  bsc: {
    key: 'bsc',
    chain: bsc,
    rpcUrls: ['https://bsc-dataseed.binance.org', 'https://bsc.publicnode.com'],
    llamaChain: 'bsc',
    nativeCoingeckoId: 'binancecoin',
    tokens: [
      token('WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'),
      stable('USDT', '0x55d398326f99059fF775485246999027B3197955'),
      stable('USDC', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
      stable('DAI', '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3'),
      token('BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'),
      token('ETH', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8'),
    ],
  },
  avalanche: {
    key: 'avalanche',
    chain: avalanche,
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain.publicnode.com'],
    llamaChain: 'avax',
    nativeCoingeckoId: 'avalanche-2',
    tokens: [
      token('WAVAX', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'),
      stable('USDC', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', 6),
      stable('USDC.e', '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', 6),
      stable('USDT', '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', 6),
      stable('DAI.e', '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70'),
      token('WETH.e', '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB'),
      token('BTC.b', '0x152b9d0FdC40C096757F570A51E494bd4b943E50', undefined, 8),
    ],
  },
  gravity: {
    key: 'gravity',
    chain: gravity,
    rpcUrls: ['https://rpc.gravity.xyz'],
    llamaChain: 'gravity',
    nativeCoingeckoId: 'g-token',
    tokens: [
      token('wG', '0xBB859E225ac8Fb6BE1C7e38D87b767e95Fef0EbD'),
      stable('USDT', '0x816E810f9F787d669FB71932DeabF6c83781Cd48', 6),
      stable('USDC.e', '0xFbDa5F676cB37624f28265A144A48B0d6e87d3b6', 6),
      stable('DAI', '0xBFBBc4dA47508e85AC18DFC961fa182194E85f9a'),
      token('WETH', '0xf6f832466Cd6C21967E0D954109403f36Bc8ceaA'),
      token('WBTC', '0x729ed87bbE7B7e4B7F09BCb9c668580818d98BB9', undefined, 8),
    ],
  },
  robinhood: {
    key: 'robinhood',
    chain: robinhood,
    rpcUrls: ['https://rpc.mainnet.chain.robinhood.com', 'https://rpc.ordofi.network'],
    llamaChain: 'robinhood',
    nativeCoingeckoId: 'ethereum',
    blockscoutUrl: 'https://robinhoodchain.blockscout.com',
    tokens: [
      token('WETH', '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
      stable('USDC', '0xab41341A2B89Ac6e572C83894869DD2ff25dFc86'),
      stable('USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 6),
    ],
  },
}

export const PRESET_NAMES = Object.keys(PRESETS)

export function tokenAddress(value: string): Address {
  return getAddress(value)
}
