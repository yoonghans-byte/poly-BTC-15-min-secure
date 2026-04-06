import { WalletState, TradeRecord } from '../types';
import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(process.cwd(), '.runtime');
const STATE_FILE = path.join(STATE_DIR, 'wallet_state.json');
const TRADES_FILE = path.join(STATE_DIR, 'trade_history.json');

export class Database {
  async connect(): Promise<void> {
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }
  }

  async saveWallets(wallets: WalletState[]): Promise<void> {
    try {
      const data = JSON.stringify(wallets, null, 2);
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('[DB] Failed to persist wallet state:', err instanceof Error ? err.message : String(err));
    }
  }

  async loadWallets(): Promise<WalletState[]> {
    try {
      if (!fs.existsSync(STATE_FILE)) return [];
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw) as WalletState[];
    } catch {
      return [];
    }
  }

  async saveTrades(trades: Map<string, TradeRecord[]>): Promise<void> {
    try {
      const obj: Record<string, TradeRecord[]> = {};
      for (const [walletId, records] of trades) {
        obj[walletId] = records;
      }
      const data = JSON.stringify(obj, null, 2);
      const tmp = TRADES_FILE + '.tmp';
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, TRADES_FILE);
    } catch (err) {
      console.error('[DB] Failed to persist trade history:', err instanceof Error ? err.message : String(err));
    }
  }

  async loadTrades(): Promise<Map<string, TradeRecord[]>> {
    try {
      if (!fs.existsSync(TRADES_FILE)) return new Map();
      const raw = fs.readFileSync(TRADES_FILE, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, TradeRecord[]>;
      return new Map(Object.entries(obj));
    } catch {
      return new Map();
    }
  }
}
