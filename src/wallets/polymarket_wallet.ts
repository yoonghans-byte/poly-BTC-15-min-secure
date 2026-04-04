import { WalletConfig, WalletState, Position, TradeRecord, RiskLimits } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';
import { ClobClient, Chain, OrderType, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

/** Cached CLOB client instance (initialised once per process) */
let _clobClient: ClobClient | null = null;
/** Cached tokenId lookups: Gamma marketId → [yesTokenId, noTokenId] */
const _tokenIdCache = new Map<string, [string, string]>();
/** Gamma API base URL (used for token ID resolution) */
const _gammaApi = process.env.POLYMARKET_GAMMA_API ?? 'https://gamma-api.polymarket.com';

/**
 * Build (or return cached) a fully-authenticated ClobClient.
 * Level-1 auth is used to derive API credentials; Level-2 auth
 * (signer + creds) is required to sign and post orders.
 */
async function getClobClient(clobApi: string): Promise<ClobClient> {
  if (_clobClient) return _clobClient;

  const privateKey = process.env.POLYMARKET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      'POLYMARKET_PRIVATE_KEY not set — required for live order signing. Add it to your .env file.',
    );
  }

  // Normalise: accept with or without 0x prefix
  const normalised = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  // Use @ethersproject/wallet — its _signTypedData satisfies ClobSigner
  const wallet = new Wallet(normalised);

  // Determine signature type: POLY_PROXY for Polymarket.com accounts
  // (Google / Magic Link), EOA for direct-key wallets.
  const sigTypeEnv = (process.env.POLYMARKET_SIG_TYPE ?? 'POLY_PROXY').toUpperCase();
  const sigType =
    sigTypeEnv === 'EOA'
      ? SignatureType.EOA
      : sigTypeEnv === 'POLY_GNOSIS_SAFE'
        ? SignatureType.POLY_GNOSIS_SAFE
        : SignatureType.POLY_PROXY;

  // For POLY_PROXY accounts (Google / Magic Link), the funderAddress is the
  // proxy wallet shown on polymarket.com — where USDC actually lives
  const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS || undefined;

  logger.info({ address: wallet.address, sigType: sigTypeEnv, funderAddress }, 'Initialising CLOB client (Level-1)');

  // Level-1 client: signer only, no creds — used to derive/create API key
  const l1Client = new ClobClient(clobApi, Chain.POLYGON, wallet, undefined, sigType, funderAddress);
  const creds: ApiKeyCreds = await l1Client.createOrDeriveApiKey();

  logger.info({ keyPrefix: creds.key.slice(0, 8) + '…' }, 'CLOB API key derived successfully');

  // Level-2 client: signer + creds — used for authenticated order placement
  _clobClient = new ClobClient(clobApi, Chain.POLYGON, wallet, creds, sigType, funderAddress);

  // Sync CLOB's view of the proxy wallet's USDC balance and allowance
  try {
    const { AssetType } = await import('@polymarket/clob-client');
    await _clobClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const bal = await _clobClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    logger.info({ balance: bal.balance, allowance: bal.allowance }, 'CLOB balance/allowance synced');
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Could not sync balance/allowance — orders may fail');
  }

  return _clobClient;
}

/**
 * Resolve outcome ('YES'|'NO') to the corresponding CLOB token ID for a
 * given Gamma market ID. Uses the Gamma API (which accepts integer IDs)
 * and caches results to avoid redundant calls.
 */
async function resolveTokenId(
  marketId: string,
  outcome: 'YES' | 'NO',
): Promise<string> {
  let cached = _tokenIdCache.get(marketId);
  if (!cached) {
    const res = await fetch(`${_gammaApi}/markets/${marketId}`);
    if (!res.ok) {
      throw new Error(`Gamma API returned HTTP ${res.status} for market ${marketId}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const market = await res.json() as any;
    // Gamma returns clobTokenIds as a JSON-encoded array string
    let tokenIds: string[] = [];
    if (typeof market.clobTokenIds === 'string') {
      tokenIds = JSON.parse(market.clobTokenIds) as string[];
    } else if (Array.isArray(market.clobTokenIds)) {
      tokenIds = market.clobTokenIds as string[];
    }
    if (tokenIds.length < 2) {
      throw new Error(
        `Gamma market ${marketId} returned fewer than 2 clobTokenIds (got ${tokenIds.length})`,
      );
    }
    // Gamma convention: index 0 = YES, index 1 = NO
    cached = [tokenIds[0], tokenIds[1]];
    _tokenIdCache.set(marketId, cached);
    logger.debug(
      { marketId, yesToken: cached[0].slice(0, 12) + '…', noToken: cached[1].slice(0, 12) + '…' },
      'Token IDs cached for market',
    );
  }
  return outcome === 'YES' ? cached[0] : cached[1];
}

export class PolymarketWallet {
  private static readonly MAX_TRADE_HISTORY = 10_000;
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];
  private readonly clobApi: string;
  private displayName: string = '';

  constructor(config: WalletConfig, assignedStrategy: string) {
    this.displayName = config.id;
    this.clobApi = process.env.POLYMARKET_CLOB_API ?? 'https://clob.polymarket.com';
    this.state = {
      walletId: config.id,
      mode: 'LIVE',
      assignedStrategy,
      capitalAllocated: config.capital,
      availableBalance: config.capital,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
        maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
        maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
        maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
        maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
      },
    };
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  getDisplayName(): string {
    return this.displayName;
  }

  setDisplayName(name: string): void {
    this.displayName = name.trim() || this.state.walletId;
  }

  updateRiskLimits(limits: Partial<RiskLimits>): void {
    if (limits.maxPositionSize !== undefined) this.state.riskLimits.maxPositionSize = limits.maxPositionSize;
    if (limits.maxExposurePerMarket !== undefined) this.state.riskLimits.maxExposurePerMarket = limits.maxExposurePerMarket;
    if (limits.maxDailyLoss !== undefined) this.state.riskLimits.maxDailyLoss = limits.maxDailyLoss;
    if (limits.maxOpenTrades !== undefined) this.state.riskLimits.maxOpenTrades = limits.maxOpenTrades;
    if (limits.maxDrawdown !== undefined) this.state.riskLimits.maxDrawdown = limits.maxDrawdown;
    logger.info({ walletId: this.state.walletId, riskLimits: this.state.riskLimits }, 'Risk limits updated');
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<void> {
    const orderId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cost = request.price * request.size;

    logger.info(
      {
        walletId: this.state.walletId,
        orderId,
        marketId: request.marketId,
        outcome: request.outcome,
        side: request.side,
        price: request.price,
        size: request.size,
        cost,
      },
      `LIVE order submitting ${request.side} ${request.outcome} market=${request.marketId} price=${request.price} size=${request.size}`,
    );

    /* ── Build and post a properly EIP-712 signed order ── */
    let client: ClobClient;
    try {
      client = await getClobClient(this.clobApi);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'CLOB client initialisation failed');
      consoleLog.error('ORDER', `[${this.state.walletId}] CLOB init failed: ${msg}`);
      throw new Error(`CLOB client init error: ${msg}`);
    }

    let tokenId: string;
    try {
      tokenId = await resolveTokenId(request.marketId, request.outcome);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ walletId: this.state.walletId, orderId, marketId: request.marketId, error: msg }, 'Token ID resolution failed');
      consoleLog.error('ORDER', `[${this.state.walletId}] Token lookup failed: ${msg}`);
      throw new Error(`Token ID lookup error: ${msg}`);
    }

    // Map our internal side string to the ClobClient Side enum value
    // Both happen to be 'BUY'/'SELL' strings, but we cast for type safety
    const clobSide = request.side as 'BUY' | 'SELL';

    let signedOrder;
    try {
      signedOrder = await client.createOrder({
        tokenID: tokenId,
        price: request.price,
        size: request.size,
        side: clobSide as Parameters<ClobClient['createOrder']>[0]['side'],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'Order signing failed');
      consoleLog.error('ORDER', `[${this.state.walletId}] Order sign failed: ${msg}`);
      // Invalidate cached client so the next attempt re-derives credentials
      _clobClient = null;
      throw new Error(`Order signing error: ${msg}`);
    }

    let orderResponse;
    try {
      orderResponse = await client.postOrder(signedOrder, OrderType.GTC);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'LIVE order post failed');
      consoleLog.error('ORDER', `[${this.state.walletId}] Order post failed (network): ${msg}`);
      throw new Error(`LIVE order post error: ${msg}`);
    }

    // Log the raw response so we can see exactly what Polymarket returned
    logger.info({ walletId: this.state.walletId, orderId, orderResponse }, 'CLOB postOrder raw response');

    // Reject if Polymarket returned an error (success:false OR error field OR HTTP 4xx status)
    const hasError = orderResponse?.success === false
      || typeof orderResponse?.error === 'string'
      || (typeof orderResponse?.status === 'number' && orderResponse.status >= 400);
    if (hasError) {
      const msg = `LIVE order rejected by Polymarket: ${orderResponse?.error ?? orderResponse?.errorMsg ?? `HTTP ${orderResponse?.status}`}`;
      logger.error({ walletId: this.state.walletId, orderId, response: orderResponse }, msg);
      consoleLog.error('ORDER', `[${this.state.walletId}] ${msg}`);
      throw new Error(msg);
    }

    /* ── Order accepted — update local state ── */
    const entryPrice = this.getExistingEntryPrice(request.marketId, request.outcome);
    this.applyFill({
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: request.price,
      size: request.size,
    });

    const realizedPnl = request.side === 'SELL' && entryPrice > 0
      ? (request.price - entryPrice) * request.size
      : 0;
    this.state.realizedPnl += realizedPnl;

    const signedCost = cost * (request.side === 'BUY' ? 1 : -1);
    this.state.availableBalance -= signedCost;

    this.trades.push({
      orderId,
      walletId: this.state.walletId,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: request.price,
      size: request.size,
      cost,
      realizedPnl,
      cumulativePnl: this.state.realizedPnl,
      balanceAfter: this.state.availableBalance,
      timestamp: Date.now(),
    });

    if (this.trades.length > PolymarketWallet.MAX_TRADE_HISTORY) {
      this.trades.splice(0, this.trades.length - PolymarketWallet.MAX_TRADE_HISTORY);
    }

    logger.info(
      {
        walletId: this.state.walletId,
        orderId,
        clobOrderId: orderResponse?.orderID,
        marketId: request.marketId,
        side: request.side,
        outcome: request.outcome,
        price: request.price,
        size: request.size,
        realizedPnl,
        balance: this.state.availableBalance,
      },
      `LIVE order FILLED ${request.side} ${request.outcome} market=${request.marketId} price=${request.price} size=${request.size}`,
    );

    consoleLog.success('ORDER', `[${this.state.walletId}] ${request.side} ${request.outcome} ×${request.size} @ $${request.price} → PnL $${realizedPnl.toFixed(2)} | Bal $${this.state.availableBalance.toFixed(2)}`, {
      walletId: this.state.walletId,
      strategy: this.state.assignedStrategy,
      orderId,
      clobOrderId: orderResponse?.orderID,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: request.price,
      size: request.size,
      realizedPnl: Number(realizedPnl.toFixed(4)),
      cumulativePnl: Number(this.state.realizedPnl.toFixed(4)),
      balanceAfter: Number(this.state.availableBalance.toFixed(2)),
    });
  }

  private getExistingEntryPrice(marketId: string, outcome: 'YES' | 'NO'): number {
    const pos = this.state.openPositions.find(
      (p) => p.marketId === marketId && p.outcome === outcome,
    );
    return pos ? pos.avgPrice : 0;
  }

  private applyFill(fill: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): void {
    const existing = this.state.openPositions.find(
      (pos) => pos.marketId === fill.marketId && pos.outcome === fill.outcome,
    );

    if (!existing) {
      if (fill.side === 'BUY') {
        this.state.openPositions.push({
          marketId: fill.marketId,
          outcome: fill.outcome,
          size: fill.size,
          avgPrice: fill.price,
          realizedPnl: 0,
        });
      }
      return;
    }

    if (fill.side === 'BUY') {
      const newSize = existing.size + fill.size;
      existing.avgPrice =
        (existing.avgPrice * existing.size + fill.price * fill.size) / newSize;
      existing.size = newSize;
    } else {
      existing.size -= Math.min(fill.size, existing.size);
      if (existing.size <= 0) {
        existing.size = 0;
        existing.avgPrice = 0;
      }
    }

    this.state.openPositions = this.state.openPositions.filter((p) => p.size > 0);
  }
}
