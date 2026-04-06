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

  constructor(config: WalletConfig, assignedStrategy: string, savedState?: WalletState) {
    this.displayName = config.id;
    this.clobApi = process.env.POLYMARKET_CLOB_API ?? 'https://clob.polymarket.com';

    if (savedState && savedState.walletId === config.id) {
      // Restore from persisted state — preserves PnL, balance, and open positions across restarts
      this.state = {
        ...savedState,
        // Always use latest risk limits from config
        riskLimits: {
          maxPositionSize: config.riskLimits?.maxPositionSize ?? savedState.riskLimits.maxPositionSize,
          maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? savedState.riskLimits.maxExposurePerMarket,
          maxDailyLoss: config.riskLimits?.maxDailyLoss ?? savedState.riskLimits.maxDailyLoss,
          maxOpenTrades: config.riskLimits?.maxOpenTrades ?? savedState.riskLimits.maxOpenTrades,
          maxDrawdown: config.riskLimits?.maxDrawdown ?? savedState.riskLimits.maxDrawdown,
        },
      };
      logger.info({
        walletId: config.id,
        restoredBalance: savedState.availableBalance,
        restoredPnl: savedState.realizedPnl,
        openPositions: savedState.openPositions.length,
      }, 'Wallet state restored from disk');
    } else {
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
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  /** Restore trade history from persisted data (called on startup) */
  restoreTradeHistory(trades: TradeRecord[]): void {
    this.trades.length = 0;
    this.trades.push(...trades);
    logger.info({ walletId: this.state.walletId, restoredTrades: trades.length }, 'Trade history restored from disk');
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

    // Use FOK market orders for btc15m strategy (time-sensitive),
    // GTC limit orders for everything else
    const useFok = this.state.assignedStrategy === 'btc15m';

    let orderResponse;

    if (useFok) {
      // FOK: fill immediately at market price or cancel entirely
      const amount = request.side === 'BUY'
        ? request.price * request.size   // dollar amount for buys
        : request.size;                  // share count for sells

      try {
        orderResponse = await client.createAndPostMarketOrder(
          {
            tokenID: tokenId,
            amount,
            side: clobSide as Parameters<ClobClient['createAndPostMarketOrder']>[0]['side'],
            price: request.price,
          },
          undefined,
          OrderType.FOK,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'FOK market order failed');
        consoleLog.error('ORDER', `[${this.state.walletId}] FOK order failed: ${msg}`);
        _clobClient = null;
        throw new Error(`FOK order error: ${msg}`);
      }
    } else {
      // GTC limit order for other strategies
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
        _clobClient = null;
        throw new Error(`Order signing error: ${msg}`);
      }

      try {
        orderResponse = await client.postOrder(signedOrder, OrderType.GTC);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'LIVE order post failed');
        consoleLog.error('ORDER', `[${this.state.walletId}] Order post failed (network): ${msg}`);
        throw new Error(`LIVE order post error: ${msg}`);
      }
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

    /* ── Determine actual fill size ── */
    // For FOK orders, check if the order actually filled.
    // The CLOB may return matched/filled info in the response.
    let filledSize = request.size;
    if (useFok && orderResponse) {
      // FOK: if no matched trades, it wasn't filled
      const matched = orderResponse.matchedTrades ?? orderResponse.matched ?? [];
      if (Array.isArray(matched) && matched.length === 0 && !orderResponse.orderID) {
        logger.warn({ walletId: this.state.walletId, orderResponse }, 'FOK order not filled — no matched trades');
        consoleLog.warn('ORDER', `[${this.state.walletId}] FOK order not filled — skipping state update`);
        return; // Don't update state for unfilled FOK orders
      }
      // If matched trades are available, sum up actual filled size
      if (Array.isArray(matched) && matched.length > 0) {
        filledSize = matched.reduce((sum: number, t: any) => sum + (Number(t.size ?? t.amount ?? 0)), 0);
        if (filledSize <= 0) filledSize = request.size; // fallback
      }
    }

    /* ── Order accepted — update local state ── */
    const entryPrice = this.getExistingEntryPrice(request.marketId, request.outcome);
    this.applyFill({
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: request.price,
      size: filledSize,
    });

    const realizedPnl = request.side === 'SELL' && entryPrice > 0
      ? (request.price - entryPrice) * filledSize
      : 0;
    this.state.realizedPnl += realizedPnl;

    // BUY: deduct cost from balance.  SELL: credit proceeds back.
    if (request.side === 'BUY') {
      this.state.availableBalance -= request.price * filledSize;
    } else {
      this.state.availableBalance += request.price * filledSize;
    }

    const actualCost = request.price * filledSize;
    this.trades.push({
      orderId,
      walletId: this.state.walletId,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: request.price,
      size: filledSize,
      cost: actualCost,
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
      `LIVE order FILLED ${request.side} ${request.outcome} market=${request.marketId} price=${request.price} size=${filledSize}`,
    );

    consoleLog.success('ORDER', `[${this.state.walletId}] ${request.side} ${request.outcome} ×${filledSize} @ $${request.price} → PnL $${realizedPnl.toFixed(2)} | Bal $${this.state.availableBalance.toFixed(2)}`, {
      walletId: this.state.walletId,
      strategy: this.state.assignedStrategy,
      orderId,
      clobOrderId: orderResponse?.orderID,
      marketId: request.marketId,
      outcome: request.outcome,
      side: request.side,
      price: request.price,
      size: filledSize,
      realizedPnl: Number(realizedPnl.toFixed(4)),
      cumulativePnl: Number(this.state.realizedPnl.toFixed(4)),
      balanceAfter: Number(this.state.availableBalance.toFixed(2)),
    });
  }

  /**
   * Remove positions on markets that have expired.
   * Records the cost as a realized loss since the market resolved
   * without the bot exiting the position.
   */
  async reconcileExpiredPositions(): Promise<void> {
    if (this.state.openPositions.length === 0) return;

    const kept: typeof this.state.openPositions = [];

    for (const pos of this.state.openPositions) {
      // Fetch market status directly from Gamma API
      let closed = false;
      let won = false;
      try {
        const res = await fetch(`${_gammaApi}/markets?id=${pos.marketId}`);
        if (res.ok) {
          const markets = await res.json() as Array<{
            outcomePrices?: string;
            closed?: boolean;
            endDate?: string;
            acceptingOrders?: boolean;
          }>;
          const m = markets[0];
          if (m) {
            // Market is done if closed flag is set, or endDate is past, or not accepting orders
            const endMs = m.endDate ? new Date(m.endDate).getTime() : Infinity;
            closed = m.closed === true || (endMs + 120_000 < Date.now());

            if (closed) {
              const prices: number[] = JSON.parse(m.outcomePrices ?? '[]').map(Number);
              const resolvedPrice = pos.outcome === 'YES' ? (prices[0] ?? 0) : (prices[1] ?? 0);
              won = resolvedPrice >= 0.99;
              logger.info({
                marketId: pos.marketId,
                outcome: pos.outcome,
                resolvedPrice,
                won,
                closed: m.closed,
                endDate: m.endDate,
              }, 'Fetched market resolution');
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ marketId: pos.marketId, error: msg }, 'Failed to fetch market status — keeping position');
        kept.push(pos);
        continue;
      }

      if (!closed) {
        kept.push(pos);
        continue;
      }

      // Market is closed — calculate PnL
      let pnl: number;
      if (won) {
        pnl = (1.0 - pos.avgPrice) * pos.size;
        this.state.availableBalance += 1.0 * pos.size;
      } else {
        pnl = -(pos.avgPrice * pos.size);
      }

      this.state.realizedPnl += pnl;

      // Record a trade so win rate and trade history reflect the resolution
      const resolutionOrderId = `resolved-${Date.now()}-${pos.marketId.slice(0, 8)}`;
      this.trades.push({
        orderId: resolutionOrderId,
        walletId: this.state.walletId,
        marketId: pos.marketId,
        outcome: pos.outcome,
        side: 'SELL',
        price: won ? 1.0 : 0,
        size: pos.size,
        cost: won ? pos.size : 0,
        realizedPnl: Number(pnl.toFixed(4)),
        cumulativePnl: Number(this.state.realizedPnl.toFixed(4)),
        balanceAfter: Number(this.state.availableBalance.toFixed(4)),
        timestamp: Date.now(),
      });

      if (this.trades.length > PolymarketWallet.MAX_TRADE_HISTORY) {
        this.trades.splice(0, this.trades.length - PolymarketWallet.MAX_TRADE_HISTORY);
      }

      logger.info({
        walletId: this.state.walletId,
        marketId: pos.marketId,
        outcome: pos.outcome,
        size: pos.size,
        entryPrice: pos.avgPrice,
        won,
        pnl: Number(pnl.toFixed(4)),
        balance: Number(this.state.availableBalance.toFixed(4)),
      }, `Reconciled position — ${won ? 'WIN' : 'LOSS'}`);
    }

    this.state.openPositions = kept;
  }

  /**
   * One-time startup reconciliation: re-derive PnL from trade history
   * by checking each BUY trade's market resolution on Gamma API.
   * Corrects the balance and realizedPnl to match reality.
   */
  async reconcileTradeHistory(): Promise<void> {
    if (this.trades.length === 0) return;

    // Group BUY trades by marketId+outcome to find positions that were entered
    const buysByMarket = new Map<string, { marketId: string; outcome: string; totalCost: number; totalShares: number }>();
    const sellCredits = new Map<string, number>(); // credits already applied via SELL trades

    for (const t of this.trades) {
      const key = `${t.marketId}:${t.outcome}`;
      if (t.side === 'BUY') {
        const existing = buysByMarket.get(key);
        if (existing) {
          existing.totalCost += t.price * t.size;
          existing.totalShares += t.size;
        } else {
          buysByMarket.set(key, { marketId: t.marketId, outcome: t.outcome, totalCost: t.price * t.size, totalShares: t.size });
        }
      } else {
        // SELL — track credits already given
        sellCredits.set(key, (sellCredits.get(key) ?? 0) + t.price * t.size);
      }
    }

    let correctedPnl = 0;
    let correctedBalance = this.state.capitalAllocated;

    for (const [key, pos] of buysByMarket) {
      const sellCredit = sellCredits.get(key) ?? 0;

      // Check market resolution
      try {
        const res = await fetch(`${_gammaApi}/markets?id=${pos.marketId}`);
        if (!res.ok) continue;
        const markets = await res.json() as Array<{ outcomePrices?: string; closed?: boolean }>;
        const m = markets[0];
        if (!m || !m.closed) {
          // Market still open — deduct cost, keep position value
          correctedBalance -= pos.totalCost;
          correctedBalance += sellCredit;
          continue;
        }

        const prices: number[] = JSON.parse(m.outcomePrices ?? '[]').map(Number);
        // YES = index 0, NO = index 1
        const resolvedPrice = pos.outcome === 'YES' ? (prices[0] ?? 0) : (prices[1] ?? 0);
        const payout = resolvedPrice * pos.totalShares;
        const pnl = payout - pos.totalCost;

        correctedPnl += pnl;
        correctedBalance -= pos.totalCost;    // deduct what we paid
        correctedBalance += payout;            // add what we received
        // Don't double-count sell credits for resolved markets
        // (resolution payout replaces any sell credit)

        logger.info({
          walletId: this.state.walletId,
          marketId: pos.marketId,
          outcome: pos.outcome,
          totalCost: Number(pos.totalCost.toFixed(4)),
          payout: Number(payout.toFixed(4)),
          pnl: Number(pnl.toFixed(4)),
          resolvedPrice,
        }, 'Trade history reconciliation');
      } catch {
        // Can't fetch — deduct cost conservatively
        correctedBalance -= pos.totalCost;
        correctedBalance += sellCredit;
      }
    }

    const oldPnl = this.state.realizedPnl;
    const oldBal = this.state.availableBalance;
    this.state.realizedPnl = Number(correctedPnl.toFixed(4));
    this.state.availableBalance = Number(correctedBalance.toFixed(4));

    // Update cumulative PnL on trade records
    for (const t of this.trades) {
      t.cumulativePnl = this.state.realizedPnl;
      t.balanceAfter = this.state.availableBalance;
    }

    logger.info({
      walletId: this.state.walletId,
      oldPnl: Number(oldPnl.toFixed(4)),
      newPnl: this.state.realizedPnl,
      oldBalance: Number(oldBal.toFixed(4)),
      newBalance: this.state.availableBalance,
      trades: this.trades.length,
    }, 'Trade history reconciliation complete');

    consoleLog.success('WALLET', `[${this.state.walletId}] PnL reconciled: $${oldPnl.toFixed(2)} → $${this.state.realizedPnl.toFixed(2)} | Balance: $${oldBal.toFixed(2)} → $${this.state.availableBalance.toFixed(2)}`);
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
