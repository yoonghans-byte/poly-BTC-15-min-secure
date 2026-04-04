import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { fetchBtcCandles, BinanceCandle } from '../../data/binance_feed';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BTC 15-Minute Market Strategy
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Trades Polymarket's recurring "Will BTC be UP or DOWN in the
   next 15 minutes?" markets using multi-indicator TA:

   • Heiken Ashi  — trend direction & consecutive candle count
   • RSI (14)     — momentum / overbought / oversold
   • MACD (12/26/9) — histogram direction & crossover
   • VWAP         — price vs volume-weighted average

   Combined score (-100 → +100):
     > +THRESHOLD  → BUY YES (UP)
     < -THRESHOLD  → BUY NO  (DOWN)

   Configuration (via strategyConfig.btc15m in config.yaml):
   {
     candleInterval: '1m',          // Binance kline interval
     candleLimit: 50,               // Candles to fetch
     rsiPeriod: 14,
     macdFast: 12,
     macdSlow: 26,
     macdSignal: 9,
     scoreThreshold: 40,            // Min |score| to trade (0–100)
     minLiquidity: 500,             // Skip illiquid markets
     minTimeRemainingMs: 180000,    // Don't enter < 3 min before expiry
     positionSizePct: 0.05,         // % of capital per position
     takeProfitBps: 150,
     stopLossBps: 100,
     maxHoldMinutes: 12,
     candleRefreshMs: 30000,        // How often to re-fetch Binance candles
   }
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

interface Btc15mParams {
  candleInterval: string;
  candleLimit: number;
  rsiPeriod: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  scoreThreshold: number;
  minLiquidity: number;
  minTimeRemainingMs: number;
  positionSizePct: number;
  takeProfitBps: number;
  stopLossBps: number;
  maxHoldMinutes: number;
  candleRefreshMs: number;
}

interface HACandle {
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Btc15mPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  entryTime: number;
  peakBps: number;
}

const DEFAULTS: Btc15mParams = {
  candleInterval: '1m',
  candleLimit: 50,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  scoreThreshold: 40,
  minLiquidity: 500,
  minTimeRemainingMs: 3 * 60 * 1_000,
  positionSizePct: 0.05,
  takeProfitBps: 150,
  stopLossBps: 100,
  maxHoldMinutes: 12,
  candleRefreshMs: 30_000,
};

export class Btc15mStrategy extends BaseStrategy {
  readonly name = 'btc15m';
  protected override cooldownMs = 60_000;

  private params: Btc15mParams = { ...DEFAULTS };
  private candles: BinanceCandle[] = [];
  private lastCandleFetch = 0;
  private positions: Btc15mPosition[] = [];

  /* ── Lifecycle ──────────────────────────────────────────────── */

  override initialize(context: StrategyContext): void {
    super.initialize(context);
    const cfg = (context.config ?? {}) as Partial<Btc15mParams>;
    this.params = { ...DEFAULTS, ...cfg };
  }

  /* ── Timer tick: refresh Binance candles ────────────────────── */

  override async onTimer(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCandleFetch < this.params.candleRefreshMs) return;
    try {
      this.candles = await fetchBtcCandles(
        this.params.candleInterval,
        this.params.candleLimit,
      );
      this.lastCandleFetch = now;
    } catch (err) {
      // Keep using stale candles — do not crash the engine tick
      const staleSecs = Math.round((now - this.lastCandleFetch) / 1000);
      const msg = err instanceof Error ? err.message : String(err);
      if (this.lastCandleFetch > 0) {
        // Only warn if we had candles before — avoids noise on first fetch
        import('../../reporting/logs').then(({ logger }) => {
          logger.warn({ error: msg, staleSeconds: staleSecs }, 'BTC candle fetch failed — using stale data');
        }).catch(() => {});
      }
    }
  }

  /* ── Signal generation ──────────────────────────────────────── */

  generateSignals(): Signal[] {
    if (this.candles.length < this.params.macdSlow + this.params.macdSignal) {
      return [];
    }

    const market = this.findActiveBtcMarket();
    if (!market) return [];
    if (!this.hasEnoughTimeRemaining(market)) return [];

    const score = this.computeScore();
    const absScore = Math.abs(score);
    if (absScore < this.params.scoreThreshold) return [];

    // Already holding a position in this market
    if (this.positions.some((p) => p.marketId === market.marketId)) return [];

    const confidence = Math.min(0.90, 0.40 + (absScore / 200));
    const edge = Math.min(0.08, absScore / 1_250);

    if (score > 0) {
      return [{
        marketId: market.marketId,
        outcome: 'YES',
        side: 'BUY',
        confidence,
        edge,
      }];
    } else {
      return [{
        marketId: market.marketId,
        outcome: 'NO',
        side: 'BUY',
        confidence,
        edge,
      }];
    }
  }

  /* ── Custom position sizing ─────────────────────────────────── */

  override sizePositions(signals: Signal[]): OrderRequest[] {
    const capital = this.context?.wallet.availableBalance ?? 100;
    const walletId = this.context?.wallet.walletId ?? 'unknown';

    return signals.map((signal) => {
      const market = this.markets.get(signal.marketId);
      const baseSize = capital * this.params.positionSizePct * signal.confidence;
      const maxFromLiquidity = (market?.liquidity ?? 500) * 0.005;
      const size = Math.max(1, Math.floor(Math.min(baseSize, maxFromLiquidity, 50)));

      const currentPrice = signal.outcome === 'YES'
        ? (market?.outcomePrices[0] ?? 0.5)
        : (market?.outcomePrices[1] ?? 0.5);

      return {
        walletId,
        marketId: signal.marketId,
        outcome: signal.outcome,
        side: signal.side,
        price: Number(Math.max(0.01, Math.min(0.99, currentPrice)).toFixed(4)),
        size,
        strategy: this.name,
      };
    });
  }

  /* ── Position tracking ──────────────────────────────────────── */

  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    this.positions.push({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      size: order.size,
      entryTime: Date.now(),
      peakBps: 0,
    });
  }

  /* ── Position management: TP / SL / time exit ───────────────── */

  override managePositions(): void {
    const { params } = this;
    const toRemove: number[] = [];

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const market = this.markets.get(pos.marketId);
      if (!market) continue;

      const currentPrice = pos.outcome === 'YES'
        ? market.outcomePrices[0]
        : (market.outcomePrices[1] ?? 1 - market.outcomePrices[0]);

      const edgeBps = pos.side === 'BUY'
        ? (currentPrice - pos.entryPrice) * 10_000
        : (pos.entryPrice - currentPrice) * 10_000;

      const peakBps = Math.max(pos.peakBps, edgeBps);
      this.positions[i] = { ...pos, peakBps };

      const holdingMin = (Date.now() - pos.entryTime) / 60_000;
      let shouldExit = false;

      if (edgeBps >= params.takeProfitBps) shouldExit = true;
      if (!shouldExit && edgeBps <= -params.stopLossBps) shouldExit = true;
      if (!shouldExit && holdingMin > params.maxHoldMinutes) shouldExit = true;
      // Exit if market is about to expire
      if (!shouldExit && !this.hasEnoughTimeRemaining(market)) shouldExit = true;

      if (shouldExit) {
        toRemove.push(i);
        const exitSide: 'BUY' | 'SELL' = pos.side === 'BUY' ? 'SELL' : 'BUY';
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: exitSide,
          price: currentPrice,
          size: pos.size,
          strategy: this.name,
        });
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.positions.splice(toRemove[i], 1);
    }
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     TA Scoring Engine  (returns -100 to +100)
     Positive = bullish (UP), Negative = bearish (DOWN)
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  private computeScore(): number {
    const closes = this.candles.map((c) => c.close);

    const haScore = this.scoreHeikenAshi();       // ±30
    const rsiScore = this.scoreRsi(closes);       // ±25
    const macdScore = this.scoreMacd(closes);     // ±25
    const vwapScore = this.scoreVwap();           // ±20

    return haScore + rsiScore + macdScore + vwapScore;
  }

  /* ── Heiken Ashi score (±30) ────────────────────────────────── */

  private scoreHeikenAshi(): number {
    const ha = this.buildHeikenAshi();
    if (ha.length < 2) return 0;

    const last = ha[ha.length - 1];
    if (!last) return 0;
    let consecutive = 0;
    const lastColor = last.close > last.open ? 1 : -1;

    for (let i = ha.length - 1; i >= 0; i--) {
      const color = ha[i].close > ha[i].open ? 1 : -1;
      if (color !== lastColor) break;
      consecutive++;
    }

    // Cap at 6 consecutive candles, worth 5 points each
    const capped = Math.min(consecutive, 6);
    return lastColor * capped * 5;
  }

  private buildHeikenAshi(): HACandle[] {
    if (this.candles.length === 0) return [];
    const ha: HACandle[] = [];

    const first = this.candles[0];
    ha.push({
      open: (first.open + first.close) / 2,
      high: Math.max(first.high, first.open, first.close),
      low: Math.min(first.low, first.open, first.close),
      close: (first.open + first.high + first.low + first.close) / 4,
    });

    for (let i = 1; i < this.candles.length; i++) {
      const c = this.candles[i];
      const prev = ha[i - 1];
      const haClose = (c.open + c.high + c.low + c.close) / 4;
      const haOpen = (prev.open + prev.close) / 2;
      ha.push({
        open: haOpen,
        high: Math.max(c.high, haOpen, haClose),
        low: Math.min(c.low, haOpen, haClose),
        close: haClose,
      });
    }

    return ha;
  }

  /* ── RSI score (±25) ────────────────────────────────────────── */

  private scoreRsi(closes: number[]): number {
    const rsi = this.computeRsi(closes, this.params.rsiPeriod);

    if (rsi >= 70) return -25;
    if (rsi >= 60) return -10;
    if (rsi <= 30) return 25;
    if (rsi <= 40) return 10;
    // Neutral zone 40–60: slight directional bias
    return rsi < 50 ? 5 : -5;
  }

  /* ── MACD score (±25) ───────────────────────────────────────── */

  private scoreMacd(closes: number[]): number {
    const emaFast = this.computeEma(closes, this.params.macdFast);
    const emaSlow = this.computeEma(closes, this.params.macdSlow);

    if (emaFast.length < 2 || emaSlow.length < 2) return 0;

    // Align arrays to same length (slow is shorter)
    const len = Math.min(emaFast.length, emaSlow.length);
    const macdLine = Array.from({ length: len }, (_, i) =>
      emaFast[emaFast.length - len + i] - emaSlow[emaSlow.length - len + i],
    );

    const signalLine = this.computeEma(macdLine, this.params.macdSignal);
    if (signalLine.length < 2) return 0;

    const hist = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
    const prevHist =
      macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];

    // Cross above zero line
    const macdCurrent = macdLine[macdLine.length - 1];
    const macdPrev = macdLine[macdLine.length - 2];
    const bullishCross = macdPrev < 0 && macdCurrent >= 0;
    const bearishCross = macdPrev > 0 && macdCurrent <= 0;

    if (bullishCross) return 25;
    if (bearishCross) return -25;

    // Histogram growing
    if (hist > 0 && hist > prevHist) return 15;
    if (hist > 0) return 8;
    if (hist < 0 && hist < prevHist) return -15;
    if (hist < 0) return -8;
    return 0;
  }

  /* ── VWAP score (±20) ───────────────────────────────────────── */

  private scoreVwap(): number {
    if (this.candles.length === 0) return 0;

    let sumPV = 0;
    let sumV = 0;
    for (const c of this.candles) {
      const typical = (c.high + c.low + c.close) / 3;
      sumPV += typical * c.volume;
      sumV += c.volume;
    }
    if (sumV === 0) return 0;

    const vwap = sumPV / sumV;
    const lastClose = this.candles[this.candles.length - 1].close;
    const pctAbove = (lastClose - vwap) / vwap;

    // Price clearly above VWAP = bullish
    if (pctAbove > 0.002) return 20;
    if (pctAbove > 0) return 10;
    if (pctAbove < -0.002) return -20;
    if (pctAbove < 0) return -10;
    return 0;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Market helpers
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  private findActiveBtcMarket(): MarketData | undefined {
    const now = Date.now();
    let best: MarketData | undefined;
    let bestEndMs = Infinity;

    for (const market of this.markets.values()) {
      if (!this.isBtc15mMarket(market)) continue;
      if (market.liquidity < this.params.minLiquidity) continue;

      const endMs = market.endDate ? new Date(market.endDate).getTime() : Infinity;
      if (endMs < now) continue; // already expired

      if (endMs < bestEndMs) {
        bestEndMs = endMs;
        best = market;
      }
    }

    return best;
  }

  private isBtc15mMarket(market: MarketData): boolean {
    const slug = (market.slug ?? '').toLowerCase();
    const question = (market.question ?? '').toLowerCase();

    const hasBtc = slug.includes('btc') || question.includes('btc') || question.includes('bitcoin');
    const has15m =
      slug.includes('15m') ||
      slug.includes('15-m') ||
      question.includes('15 min') ||
      question.includes('15min') ||
      question.includes('15-min');

    return hasBtc && has15m;
  }

  private hasEnoughTimeRemaining(market: MarketData): boolean {
    if (!market.endDate) return true;
    const remaining = new Date(market.endDate).getTime() - Date.now();
    return remaining >= this.params.minTimeRemainingMs;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Math helpers
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  private computeEma(values: number[], period: number): number[] {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    const result: number[] = [sum / period];
    for (let i = period; i < values.length; i++) {
      result.push(values[i] * k + result[result.length - 1] * (1 - k));
    }
    return result;
  }

  private computeRsi(prices: number[], period: number): number {
    if (prices.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    const start = prices.length - period - 1;
    for (let i = start + 1; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }
}
