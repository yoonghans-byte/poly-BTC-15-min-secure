export interface BinanceCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

const BINANCE_BASE = 'https://api.binance.com';
const SYMBOL = 'BTCUSDT';
const FETCH_TIMEOUT_MS = 5_000;

function toNum(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchBtcCandles(
  interval: string,
  limit: number,
): Promise<BinanceCandle[]> {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Binance klines HTTP ${res.status}`);
    const raw = (await res.json()) as unknown[][];
    return raw.map((k) => ({
      openTime: k[0] as number,
      open: toNum(k[1]),
      high: toNum(k[2]),
      low: toNum(k[3]),
      close: toNum(k[4]),
      volume: toNum(k[5]),
      closeTime: k[6] as number,
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBtcPrice(): Promise<number> {
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=${SYMBOL}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Binance price HTTP ${res.status}`);
    const data = (await res.json()) as { price: string };
    return toNum(data.price);
  } finally {
    clearTimeout(timer);
  }
}
