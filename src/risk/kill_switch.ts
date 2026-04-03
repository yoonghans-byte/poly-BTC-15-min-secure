import fs from 'fs';
import path from 'path';

const STATE_FILE = path.resolve('.runtime/kill_switch.json');

export class KillSwitch {
  private enabled: boolean;

  constructor() {
    // Restore persisted state on startup so a crash + restart doesn't re-enable trading (M-6)
    this.enabled = this.loadState();
  }

  activate(): void {
    this.enabled = true;
    this.saveState();
  }

  deactivate(): void {
    this.enabled = false;
    this.saveState();
  }

  isActive(): boolean {
    return this.enabled;
  }

  private loadState(): boolean {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as { enabled?: boolean };
        return parsed.enabled === true;
      }
    } catch {
      // If state file is corrupt, default to safe (enabled = true blocks trading)
      return true;
    }
    return false;
  }

  private saveState(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ enabled: this.enabled }), { mode: 0o600 });
    } catch {
      // Non-fatal — state is still held in memory for this process lifetime
    }
  }
}
