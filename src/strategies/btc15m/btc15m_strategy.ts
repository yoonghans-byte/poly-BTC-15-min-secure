import { BaseStrategy, StrategyContext } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { fetchBtcCandles, BinanceCandle } from '../../data/binance_feed';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BTC 15-Minute Market Strategy  (v2 — FrondEnt-aligned)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Trades Polymarket's recurring "Will BTC be UP or DOWN in the
   next 15 minutes?" markets using multi-indicator TA:

   • Heiken Ashi  — trend confirmation (minor)                  (±10)
   • RSI (14)     — momentum confirmation with slope            (±18)
   • MACD (12/26/9) — histogram + line level                    (±27)
   • VWAP position — price vs volume-weighted average            (±18)
   • VWAP slope   — VWAP trend over last 5 candles              (±18)
   • Failed VWAP reclaim — bearish penalty                       (-15)

   Gating layers (applied in order):
   1. Regime filter — skip CHOP markets
   2. Score threshold — |score| must exceed 40
   3. Time decay — conviction shrinks as market approaches expiry
   4. Edge vs market — model probability must exceed market price
      by a phase-gated threshold (EARLY 5%, MID 10%, LATE 20%)

   Combined score (-95 → +95 pre-decay, time-decayed toward 0):
     > +THRESHOLD  → BUY YES (UP)
     < -THRESHOLD  → BUY NO  (DOWN)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

interface Btc15mParams {
  candleInterval: string;
  candleLimit: number;
  rsiPeriod: number;
  rsiSlopePoints: number;
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
  vwapSlopeLookback: number;
  vwapCrossLookback: number;
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

type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'CHOP';

const DEFAULTS: Btc15mParams = {
  candleInterval: '1m',
  candleLimit: 240,
  rsiPeriod: 14,
  rsiSlopePoints: 3,
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
  vwapSlopeLookback: 5,
  vwapCrossLookback: 20,
};

export interface Btc15mLiveState {
  activeMarket: { slug: string; marketId: string; question: string; endDate?: string; liquidity: number } | null;
  candles: number;
  lastCandleFetch: number;
  scores: {
    ha: number; rsi: number; macd: number;
    vwap: number; vwapSlope: number; failedReclaim: number;
    raw: number; timeDecay: number; total: number;
  } | null;
  regime: Regime | null;
  threshold: number;
  decision: 'BUY YES (UP)' | 'BUY NO (DOWN)' | 'NO TRADE' | 'NO MARKET' | 'WAITING FOR CANDLES' | 'CHOP_SKIP' | 'EDGE_SKIP';
  positions: Btc15mPosition[];
  lastUpdate: number;
}

export class Btc15mStrategy extends BaseStrategy {
  readonly name = 'btc15m';
  protected override cooldownMs = 60_000;

  private params: Btc15mParams = { ...DEFAULTS };
  private candles: BinanceCandle[] = [];
  private lastCandleFetch = 0;
  private positions: Btc15mPosition[] = [];
  /** Markets we've already traded — no re-entry after exit */
  private tradedMarkets = new Set<string>();
  /** Markets that exited via signal reversal — allowed re-entry in opposite direction */
  private reversalExitMarkets = new Set<string>();
  private _lastScores: Btc15mLiveState['scores'] = null;
  private _lastDecision: Btc15mLiveState['decision'] = 'WAITING FOR CANDLES';
  private _lastMarket: Btc15mLiveState['activeMarket'] = null;
  private _lastRegime: Regime | null = null;

  /** Expose live state for the dashboard */
  getLiveState(): Btc15mLiveState {
    return {
      activeMarket: this._lastMarket,
      candles: this.candles.length,
      lastCandleFetch: this.lastCandleFetch,
      scores: this._lastScores,
      regime: this._lastRegime,
      threshold: this.params.scoreThreshold,
      decision: this._lastDecision,
      positions: [...this.positions],
      lastUpdate: Date.now(),
    };
  }

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
        logger.warn({ error: msg, staleSeconds: staleSecs }, 'BTC candle fetch failed — using stale data');
      }
    }
  }

  /* ── Signal generation ──────────────────────────────────────── */

  generateSignals(): Signal[] {
    if (this.candles.length < this.params.macdSlow + this.params.macdSignal) {
      return [];
    }

    const market = this.findActiveBtcMarket();
    if (!market) {
      this._lastMarket = null;
      this._lastScores = null;
      this._lastRegime = null;
      this._lastDecision = 'NO MARKET';
      return [];
    }
    this._lastMarket = {
      slug: market.slug ?? '',
      marketId: market.marketId,
      question: market.question ?? '',
      endDate: market.endDate,
      liquidity: market.liquidity,
    };
    if (!this.hasEnoughTimeRemaining(market)) {
      this._lastDecision = 'NO TRADE';
      this._lastScores = null;
      return [];
    }

    const closes = this.candles.map((c) => c.close);
    const vwapSeries = this.computeVwapSeries();

    // ── Gate 1: Regime filter ──
    const regime = this.detectRegime(vwapSeries);
    this._lastRegime = regime.regime;
    if (regime.regime === 'CHOP') {
      this._lastDecision = 'CHOP_SKIP';
      this._lastScores = null;
      logger.info({ regime: regime.regime, reason: regime.reason }, 'btc15m: CHOP regime — skipping');
      return [];
    }

    // ── Compute sub-scores ──
    const haScore = this.scoreHeikenAshi();                        // ±10
    const rsiScore = this.scoreRsi(closes);                        // ±18
    const macdScore = this.scoreMacd(closes);                      // ±27
    const vwapPosScore = this.scoreVwapPosition(vwapSeries);       // ±18
    const vwapSlopeScore = this.scoreVwapSlope(vwapSeries);        // ±18
    const failedReclaimScore = this.scoreFailedVwapReclaim(vwapSeries); // 0 or -15

    const rawScore = haScore + rsiScore + macdScore + vwapPosScore + vwapSlopeScore + failedReclaimScore;

    // ── Gate 2: Time decay ──
    const timeDecay = this.computeTimeDecay(market);
    const score = Math.round(rawScore * timeDecay);

    this._lastScores = {
      ha: haScore, rsi: rsiScore, macd: macdScore,
      vwap: vwapPosScore, vwapSlope: vwapSlopeScore,
      failedReclaim: failedReclaimScore,
      raw: rawScore, timeDecay, total: score,
    };

    logger.info({
      ...this._lastScores, regime: regime.regime,
      threshold: this.params.scoreThreshold, market: market.slug,
    }, 'btc15m score breakdown');

    // ── Gate 3: Score threshold ──
    const absScore = Math.abs(score);
    if (absScore < this.params.scoreThreshold) {
      this._lastDecision = 'NO TRADE';
      return [];
    }

    // ── Gate 4: Edge vs market price ──
    const remainingMinutes = market.endDate
      ? (new Date(market.endDate).getTime() - Date.now()) / 60_000
      : 15;
    const edgeInfo = this.computeEdgeVsMarket(score, market, remainingMinutes);
    if (!edgeInfo.pass) {
      this._lastDecision = 'EDGE_SKIP';
      logger.info({
        edge: edgeInfo.edge.toFixed(4), phase: edgeInfo.phase,
        modelProb: edgeInfo.modelProb.toFixed(4), threshold: edgeInfo.threshold.toFixed(4),
      }, 'btc15m: insufficient edge vs market');
      return [];
    }

    // Already holding a position in this market — skip
    if (this.positions.some((p) => p.marketId === market.marketId)) {
      this._lastDecision = score > 0 ? 'BUY YES (UP)' : 'BUY NO (DOWN)';
      return [];
    }

    // Already traded this market — allow re-entry only after a signal-reversal exit.
    if (this.tradedMarkets.has(market.marketId)) {
      if (!this.reversalExitMarkets.has(market.marketId)) {
        this._lastDecision = score > 0 ? 'BUY YES (UP)' : 'BUY NO (DOWN)';
        return [];
      }
      this.reversalExitMarkets.delete(market.marketId);
      logger.info({ marketId: market.marketId, score, market: market.slug }, 'btc15m: flipping position after signal reversal');
    }

    this._lastDecision = score > 0 ? 'BUY YES (UP)' : 'BUY NO (DOWN)';

    const confidence = Math.min(0.90, 0.40 + (absScore / 200));
    const edge = Math.max(edgeInfo.edge, Math.min(0.08, absScore / 1_250));

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
      const currentPrice = signal.outcome === 'YES'
        ? (market?.outcomePrices[0] ?? 0.5)
        : (market?.outcomePrices[1] ?? 0.5);
      const dollarSize = capital * this.params.positionSizePct * signal.confidence;
      const shares = Math.floor(dollarSize / Math.max(currentPrice, 0.01));
      const maxFromLiquidity = Math.floor((market?.liquidity ?? 500) * 0.005);
      const size = Math.max(5, Math.min(shares, maxFromLiquidity, 100));

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
    this.tradedMarkets.add(order.marketId);
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

    if (this.positions.length > 0) {
      for (const pos of this.positions) {
        const m = this.markets.get(pos.marketId);
        logger.info({ marketId: pos.marketId, hasMarket: !!m, endDate: m?.endDate, expired: m?.endDate ? new Date(m.endDate).getTime() < Date.now() : 'n/a', posCount: this.positions.length }, 'btc15m: managePositions checking');
      }
    }

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const market = this.markets.get(pos.marketId);

      // If market is gone from cache or has expired, let reconciliation handle it.
      // Don't submit a SELL order with price=0 — the wallet's reconcileExpiredPositions()
      // will fetch the actual resolution from Gamma API and calculate PnL correctly.
      if (!market) {
        logger.warn({ marketId: pos.marketId, outcome: pos.outcome, entryPrice: pos.entryPrice, size: pos.size }, 'btc15m: position on missing market — removing from strategy tracker (wallet reconciliation will handle PnL)');
        toRemove.push(i);
        continue;
      }

      // If market has expired (endDate in the past), remove from strategy tracker.
      // Wallet reconciliation will determine WIN/LOSS from Gamma API.
      if (market.endDate) {
        const endMs = new Date(market.endDate).getTime();
        if (endMs < Date.now()) {
          logger.warn({ marketId: pos.marketId, slug: market.slug, outcome: pos.outcome, entryPrice: pos.entryPrice, size: pos.size }, 'btc15m: market expired — removing from strategy tracker (wallet reconciliation will handle PnL)');
          toRemove.push(i);
          continue;
        }
      }

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

      // Signal-reversal exit: if the score has flipped strongly in the
      // opposite direction, exit now — whether at a profit or a loss.
      // Holding YES (UP) → exit if score < -threshold (strong DOWN)
      // Holding NO (DOWN) → exit if score > +threshold (strong UP)
      if (!shouldExit && this._lastScores) {
        const score = this._lastScores.total;
        const reversed =
          (pos.outcome === 'YES' && score <= -params.scoreThreshold) ||
          (pos.outcome === 'NO' && score >= params.scoreThreshold);
        if (reversed) {
          logger.info(
            { marketId: pos.marketId, outcome: pos.outcome, score, threshold: params.scoreThreshold, edgeBps: Math.round(edgeBps) },
            'btc15m: signal reversal — exiting position',
          );
          shouldExit = true;
          // Allow re-entry in the opposite direction
          this.reversalExitMarkets.add(pos.marketId);
        }
      }

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
     TA Scoring Engine
     Positive = bullish (UP), Negative = bearish (DOWN)
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  /* ── Heiken Ashi score (±10) — minor trend confirmation ──── */

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

    // Only scores if 2+ consecutive same-color candles (like FrondEnt)
    if (consecutive < 2) return 0;
    return lastColor * 10;
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

  /* ── RSI score (±18) — momentum confirmation with slope ─────── */

  private scoreRsi(closes: number[]): number {
    const rsiSeries = this.computeRsiSeries(closes, this.params.rsiPeriod, this.params.rsiSlopePoints);
    if (rsiSeries.length < 2) return 0;

    const rsi = rsiSeries[rsiSeries.length - 1];
    const rsiSlope = (rsiSeries[rsiSeries.length - 1] - rsiSeries[0]) / (rsiSeries.length - 1);

    // Momentum confirmation: both level AND slope must agree (like FrondEnt)
    if (rsi > 55 && rsiSlope > 0) return 18;
    if (rsi < 45 && rsiSlope < 0) return -18;
    // No partial credit — FrondEnt only scores when both conditions hold
    return 0;
  }

  /* ── MACD score (±27) — histogram direction + line level ───── */

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
    const macdCurrent = macdLine[macdLine.length - 1];

    let score = 0;

    // Histogram direction (±18, like FrondEnt's ±2 for expanding hist)
    const expandingGreen = hist > 0 && hist > prevHist;
    const expandingRed = hist < 0 && hist < prevHist;
    if (expandingGreen) score += 18;
    else if (expandingRed) score -= 18;

    // MACD line above/below zero (±9, like FrondEnt's ±1 for line level)
    if (macdCurrent > 0) score += 9;
    else if (macdCurrent < 0) score -= 9;

    return score;
  }

  /* ── VWAP position score (±18) ──────────────────────────────── */

  private scoreVwapPosition(vwapSeries: number[]): number {
    if (this.candles.length === 0 || vwapSeries.length === 0) return 0;

    const vwap = vwapSeries[vwapSeries.length - 1];
    const lastClose = this.candles[this.candles.length - 1].close;

    // Binary: above or below VWAP (like FrondEnt's ±2)
    if (lastClose > vwap) return 18;
    if (lastClose < vwap) return -18;
    return 0;
  }

  /* ── VWAP slope score (±18) ─────────────────────────────────── */

  private scoreVwapSlope(vwapSeries: number[]): number {
    const lb = this.params.vwapSlopeLookback;
    if (vwapSeries.length < lb) return 0;

    const slope = vwapSeries[vwapSeries.length - 1] - vwapSeries[vwapSeries.length - lb];
    if (slope > 0) return 18;
    if (slope < 0) return -18;
    return 0;
  }

  /* ── Failed VWAP reclaim (0 or -15, bearish only) ───────────── */

  private scoreFailedVwapReclaim(vwapSeries: number[]): number {
    if (this.candles.length < 3 || vwapSeries.length < 3) return 0;

    const n = this.candles.length;
    const prevClose = this.candles[n - 2].close;
    const currClose = this.candles[n - 1].close;
    const prevVwap = vwapSeries[vwapSeries.length - 2];
    const currVwap = vwapSeries[vwapSeries.length - 1];

    // Was above VWAP last candle, now dropped below
    if (prevClose > prevVwap && currClose < currVwap) return -15;
    return 0;
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Gating Engines
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  /* ── Regime detection ───────────────────────────────────────── */

  private detectRegime(vwapSeries: number[]): { regime: Regime; reason: string } {
    if (this.candles.length < 20 || vwapSeries.length < this.params.vwapSlopeLookback) {
      return { regime: 'CHOP', reason: 'insufficient_data' };
    }

    const lastClose = this.candles[this.candles.length - 1].close;
    const vwap = vwapSeries[vwapSeries.length - 1];
    const lb = this.params.vwapSlopeLookback;
    const vwapSlope = vwapSeries[vwapSeries.length - 1] - vwapSeries[vwapSeries.length - lb];
    const above = lastClose > vwap;

    // Volume check: recent 20 candles vs average of last 120
    const recentVol = this.candles.slice(-20).reduce((a, c) => a + c.volume, 0);
    const histLen = Math.min(this.candles.length, 120);
    const avgVol = this.candles.slice(-histLen).reduce((a, c) => a + c.volume, 0) * (20 / histLen);
    const lowVolume = recentVol < 0.6 * avgVol;

    if (lowVolume && Math.abs((lastClose - vwap) / vwap) < 0.001) {
      return { regime: 'CHOP', reason: 'low_volume_flat' };
    }

    if (above && vwapSlope > 0) return { regime: 'TREND_UP', reason: 'price_above_vwap_slope_up' };
    if (!above && vwapSlope < 0) return { regime: 'TREND_DOWN', reason: 'price_below_vwap_slope_down' };

    // VWAP cross counting
    const closes = this.candles.map((c) => c.close);
    const crossLb = Math.min(this.params.vwapCrossLookback, closes.length, vwapSeries.length);
    if (crossLb >= 2) {
      let crosses = 0;
      const startIdx = closes.length - crossLb;
      for (let i = startIdx + 1; i < closes.length; i++) {
        const prev = closes[i - 1] - vwapSeries[i - 1];
        const cur = closes[i] - vwapSeries[i];
        if ((prev > 0 && cur < 0) || (prev < 0 && cur > 0)) crosses++;
      }
      if (crosses >= 3) return { regime: 'RANGE', reason: 'frequent_vwap_cross' };
    }

    return { regime: 'RANGE', reason: 'default' };
  }

  /* ── Time decay ─────────────────────────────────────────────── */

  private computeTimeDecay(market: MarketData): number {
    if (!market.endDate) return 1;
    const remainingMs = new Date(market.endDate).getTime() - Date.now();
    const remainingMinutes = remainingMs / 60_000;
    return Math.max(0, Math.min(1, remainingMinutes / 15));
  }

  /* ── Edge vs market price ───────────────────────────────────── */

  private computeEdgeVsMarket(
    score: number,
    market: MarketData,
    remainingMinutes: number,
  ): { pass: boolean; edge: number; phase: string; modelProb: number; threshold: number } {
    // Convert score (-100..+100) to a probability (0..1)
    const rawUp = 0.5 + (score / 200);
    const modelUp = Math.max(0.01, Math.min(0.99, rawUp));
    const modelDown = 1 - modelUp;

    // Market prices for YES (UP) and NO (DOWN)
    const marketUp = market.outcomePrices[0];
    const marketDown = market.outcomePrices[1] ?? (1 - marketUp);

    const edgeUp = modelUp - marketUp;
    const edgeDown = modelDown - marketDown;

    const phase = remainingMinutes > 10 ? 'EARLY' : remainingMinutes > 5 ? 'MID' : 'LATE';
    const threshold = phase === 'EARLY' ? 0.05 : phase === 'MID' ? 0.10 : 0.20;

    const bestEdge = score > 0 ? edgeUp : edgeDown;
    const pass = bestEdge >= threshold;

    return { pass, edge: bestEdge, phase, modelProb: score > 0 ? modelUp : modelDown, threshold };
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     VWAP helpers
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  private computeVwapSeries(): number[] {
    const series: number[] = [];
    let sumPV = 0;
    let sumV = 0;
    for (const c of this.candles) {
      const tp = (c.high + c.low + c.close) / 3;
      sumPV += tp * c.volume;
      sumV += c.volume;
      series.push(sumV === 0 ? 0 : sumPV / sumV);
    }
    return series;
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

  private computeRsiSeries(closes: number[], period: number, count: number): number[] {
    const series: number[] = [];
    for (let offset = count - 1; offset >= 0; offset--) {
      const slice = closes.slice(0, closes.length - offset);
      if (slice.length < period + 1) continue;
      series.push(this.computeRsi(slice, period));
    }
    return series;
  }
}
