import { WalletConfig, WalletState, Position, TradeRecord, RiskLimits } from '../types';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

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
    const apiKey = process.env.POLYMARKET_API_KEY;
    if (!apiKey) {
      const msg = 'POLYMARKET_API_KEY not set — cannot place LIVE order. Set it in your .env file.';
      logger.error({ walletId: this.state.walletId }, msg);
      consoleLog.error('ORDER', `[${this.state.walletId}] ${msg}`);
      throw new Error(msg);
    }
    // Basic format validation — Polymarket API keys are UUIDs (M-7)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(apiKey)) {
      const msg = 'POLYMARKET_API_KEY has invalid format — expected a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)';
      logger.error({ walletId: this.state.walletId }, msg);
      throw new Error(msg);
    }

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

    /* ── Submit order to Polymarket CLOB API ── */
    const orderPayload = {
      market: request.marketId,
      side: request.side,
      outcome: request.outcome,
      price: request.price,
      size: request.size,
      type: 'limit',
    };

    let apiResponse: Response;
    try {
      apiResponse = await fetch(`${this.clobApi}/order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(orderPayload),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ walletId: this.state.walletId, orderId, error: msg }, 'LIVE order network error');
      consoleLog.error('ORDER', `[${this.state.walletId}] Order failed (network): ${msg}`);
      throw new Error(`LIVE order network error: ${msg}`);
    }

    if (!apiResponse.ok) {
      let errorBody = '';
      try { errorBody = await apiResponse.text(); } catch { /* ignore */ }
      const msg = `LIVE order rejected by Polymarket (HTTP ${apiResponse.status}): ${errorBody}`;
      logger.error({ walletId: this.state.walletId, orderId, status: apiResponse.status, body: errorBody }, msg);
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
