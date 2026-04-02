# 🚀 Step-by-Step Setup Guide

**This guide is for beginners.** No coding experience required. Follow each step in order.

---

## Table of Contents

1. [Install the Prerequisites](#step-1-install-the-prerequisites)
2. [Download the Bot](#step-2-download-the-bot)
3. [Install Dependencies](#step-3-install-dependencies)
4. [Set Up Your .env File](#step-4-set-up-your-env-file)
5. [Run the Bot in Paper Mode (Safe)](#step-5-run-the-bot-in-paper-mode-safe)
6. [Open the Dashboard](#step-6-open-the-dashboard)
7. [Switch to LIVE Trading (Real Money)](#step-7-switch-to-live-trading-real-money)
8. [Customize Your Strategies](#step-8-customize-your-strategies)
9. [Deploy with Docker (Optional)](#step-9-deploy-with-docker-optional)
10. [Troubleshooting](#troubleshooting)

---

## Step 1: Install the Prerequisites

You need two things installed on your computer:

### Install Node.js (version 18 or higher)

<details>
<summary><strong>🍎 Mac</strong></summary>

1. Go to [https://nodejs.org](https://nodejs.org)
2. Click the **LTS** (recommended) download button
3. Open the downloaded `.pkg` file and follow the installer
4. Verify it worked — open **Terminal** (search "Terminal" in Spotlight) and type:
   ```bash
   node --version
   ```
   You should see something like `v20.x.x`
</details>

<details>
<summary><strong>🪟 Windows</strong></summary>

1. Go to [https://nodejs.org](https://nodejs.org)
2. Click the **LTS** download button
3. Run the `.msi` installer — click "Next" through all steps
4. Verify it worked — open **Command Prompt** (search "cmd") and type:
   ```bash
   node --version
   ```
   You should see something like `v20.x.x`
</details>

<details>
<summary><strong>🐧 Linux</strong></summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```
</details>

### Install Git

<details>
<summary><strong>🍎 Mac</strong></summary>

Open Terminal and type:
```bash
git --version
```
If Git is not installed, macOS will prompt you to install it. Follow the prompts.
</details>

<details>
<summary><strong>🪟 Windows</strong></summary>

1. Go to [https://git-scm.com/download/win](https://git-scm.com/download/win)
2. Download and run the installer — use all default settings
</details>

<details>
<summary><strong>🐧 Linux</strong></summary>

```bash
sudo apt-get install git
```
</details>

---

## Step 2: Download the Bot

Open your terminal (Mac/Linux: Terminal; Windows: Command Prompt or PowerShell) and run:

```bash
git clone https://github.com/dylanpersonguy/Polymarket-Trading-Bot.git
cd Polymarket-Trading-Bot
```

---

## Step 3: Install Dependencies

Still in the terminal, run:

```bash
npm install
npm run build
```

Wait for it to finish. You'll see some output — that's normal.

---

## Step 4: Set Up Your .env File

The `.env` file holds your private settings (API keys, trading mode). **It is never uploaded to GitHub.**

### Create the file

**Mac/Linux:**
```bash
cp .env.example .env
```

**Windows (Command Prompt):**
```bash
copy .env.example .env
```

### Edit the file

Open `.env` in any text editor (Notepad, VS Code, TextEdit, etc.) and you'll see:

```env
# Set to "true" to allow LIVE wallets to execute real trades.
ENABLE_LIVE_TRADING=false

# Your Polymarket API key for placing real orders.
POLYMARKET_API_KEY=

# Dashboard port (default: 3000)
DASHBOARD_PORT=3000

# Log level: trace | debug | info | warn | error | fatal
LOG_LEVEL=info
```

**For paper trading (fake money, safe to test):** Leave everything as-is. You're done.

**For live trading (real money):** See [Step 7](#step-7-switch-to-live-trading-real-money) below.

---

## Step 5: Run the Bot in Paper Mode (Safe)

Paper mode uses **fake money** so you can test everything safely. This is the default.

```bash
npm start
```

You should see output like:
```
[INFO] Engine started — 10 wallets active
[INFO] Dashboard running at http://localhost:3000/dashboard
[INFO] Whale scanner started — scanning 50 markets
```

**Leave this terminal window open** — the bot runs as long as this window is open.

---

## Step 6: Open the Dashboard

Open your web browser and go to:

**➡️ [http://localhost:3000/dashboard](http://localhost:3000/dashboard)**

You'll see:
- All your wallets (paper trading mode)
- Live P&L tracking
- Trade signals
- Whale scanner results

---

## Step 7: Switch to LIVE Trading (Real Money)

> ⚠️ **WARNING: LIVE mode uses real money on Polymarket. Start with small amounts. We recommend testing in PAPER mode first for at least a few days.**

Live trading requires **THREE things** to be enabled (this is a safety measure):

### 1. Get your Polymarket API Key

1. Go to [https://polymarket.com](https://polymarket.com) and log in
2. Go to **Settings** → **API Keys**
3. Create a new API key and copy it

### 2. Update your `.env` file

Open your `.env` file and change these two lines:

```env
ENABLE_LIVE_TRADING=true
POLYMARKET_API_KEY=paste_your_api_key_here
```

### 3. Update `config.yaml`

Open `config.yaml` in a text editor and change:

```yaml
environment:
  enable_live_trading: true    # ← Change from false to true
```

Then set at least one wallet to LIVE mode:

```yaml
wallets:
  - id: my_live_wallet
    mode: LIVE                 # ← Change from PAPER to LIVE
    strategy: filtered_high_prob_convergence
    capital: 100               # ← Start small! $100
    risk_limits:
      max_position_size: 20    # ← Max $20 per trade
      max_exposure_per_market: 50
      max_daily_loss: 25       # ← Stop if you lose $25 in a day
      max_open_trades: 5
      max_drawdown: 0.15       # ← Stop if you lose 15% total
```

### 4. Start the bot

```bash
npm start
```

The dashboard will show your wallet as **LIVE** instead of PAPER.

### Safety Features (Always Active)

| Protection | What It Does |
|-----------|--------------|
| **Two-factor enable** | BOTH `.env` AND `config.yaml` must enable live trading |
| **Daily loss limit** | Bot stops trading if daily loss hits your limit |
| **Max drawdown** | Bot stops if total losses exceed your threshold |
| **Per-trade cap** | No single trade can exceed `max_position_size` |
| **Rate limiting** | LIVE mode is limited to 20 orders/minute (vs 120 in paper) |
| **Kill switch** | Emergency stop across all strategies via dashboard |

---

## Step 8: Customize Your Strategies

### Use a different strategy

In `config.yaml`, change the `strategy` field for any wallet:

| Strategy Name | Description |
|--------------|-------------|
| `cross_market_arbitrage` | Exploits price differences between related markets |
| `mispricing_arbitrage` | Finds markets where probabilities don't add up to 100% |
| `filtered_high_prob_convergence` | Targets high-probability outcomes with strict filters |
| `market_making` | Earns the bid-ask spread by quoting both sides |
| `momentum` | Rides short-term price trends |
| `ai_forecast` | AI-powered predictions with web research |
| `copy_trade` | Copies trades from whale wallets |
| `user_defined` | Your own custom strategy |

### Adjust risk limits

Each wallet has its own risk limits in `config.yaml`:

```yaml
risk_limits:
  max_position_size: 200       # Max dollars per single trade
  max_exposure_per_market: 300  # Max dollars in any one market
  max_daily_loss: 150           # Stop trading after losing this much in a day
  max_open_trades: 10           # Max number of trades open at once
  max_drawdown: 0.20            # Stop if total losses hit 20% of capital
```

### Add more wallets

Just add another entry under `wallets:` in `config.yaml`:

```yaml
wallets:
  # ... existing wallets ...

  - id: my_new_wallet           # Give it a unique name
    mode: PAPER                  # PAPER or LIVE
    strategy: momentum           # Pick a strategy
    capital: 5000                # Starting capital
    risk_limits:
      max_position_size: 100
      max_exposure_per_market: 250
      max_daily_loss: 100
      max_open_trades: 10
      max_drawdown: 0.15
```

---

## Step 9: Deploy with Docker (Optional)

Docker lets you run the bot on a server or in the cloud without installing Node.js.

### Build and run

```bash
# Build the Docker image
docker build -t polymarket-bot .

# Run in PAPER mode (safe)
docker run -p 3000:3000 polymarket-bot

# Run in LIVE mode
docker run -p 3000:3000 \
  -e ENABLE_LIVE_TRADING=true \
  -e POLYMARKET_API_KEY=your_api_key_here \
  polymarket-bot
```

### Use a custom config

```bash
docker run -p 3000:3000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  polymarket-bot
```

### Keep it running 24/7

Add `-d` to run in the background:

```bash
docker run -d -p 3000:3000 --name polymarket-bot polymarket-bot
```

Check if it's running:
```bash
docker ps
```

View logs:
```bash
docker logs polymarket-bot
```

Stop it:
```bash
docker stop polymarket-bot
```

---

## Troubleshooting

### "command not found: node"

Node.js is not installed. Go back to [Step 1](#step-1-install-the-prerequisites).

### "command not found: npm"

npm comes with Node.js. Reinstall Node.js from [Step 1](#step-1-install-the-prerequisites).

### "POLYMARKET_API_KEY not set; refusing LIVE order"

Your `.env` file is missing the API key. Open `.env` and add your key:
```env
POLYMARKET_API_KEY=your_key_here
```

### "LIVE trading requested but ENABLE_LIVE_TRADING is false"

You need to enable live trading in **both** places:
1. `.env` file: `ENABLE_LIVE_TRADING=true`
2. `config.yaml`: `enable_live_trading: true`

### "Cannot find module" or build errors

Rebuild the project:
```bash
npm install
npm run build
```

### Dashboard not loading at localhost:3000

1. Make sure the bot is running (terminal should show logs)
2. Try a different port — edit `.env`: `DASHBOARD_PORT=8080`, then open `http://localhost:8080/dashboard`
3. Make sure no other program is using port 3000

### Bot stops trading — "daily loss limit reached"

This is a safety feature. The bot pauses when your daily losses hit the `max_daily_loss` limit in `config.yaml`. It will resume the next day. To change the limit, edit `max_daily_loss` in your wallet config.

### The bot runs but no trades are happening

1. Check if markets pass the strategy filters (dashboard → Market Scanner)
2. Increase risk limits — `max_position_size` might be too small
3. Some strategies only trade in specific conditions (e.g., convergence needs markets with 65-96% probability)

### Docker build fails

Make sure Docker Desktop is installed and running:
- Mac/Windows: [https://www.docker.com/products/docker-desktop/](https://www.docker.com/products/docker-desktop/)
- Linux: `curl -fsSL https://get.docker.com | sh`

---

## Quick Reference

| What you want to do | How to do it |
|---------------------|-------------|
| Run with fake money | `npm start` (default, no changes needed) |
| Run with real money | Set `.env` + `config.yaml` (see [Step 7](#step-7-switch-to-live-trading-real-money)) |
| Change strategies | Edit `strategy` in `config.yaml` |
| Change risk limits | Edit `risk_limits` in `config.yaml` |
| Change dashboard port | Edit `DASHBOARD_PORT` in `.env` |
| See more log details | Set `LOG_LEVEL=debug` in `.env` |
| Run on a server 24/7 | Use Docker (see [Step 9](#step-9-deploy-with-docker-optional)) |
| Stop the bot | Press `Ctrl+C` in the terminal |

---

**Need help?** Contact [@DylanForexia on Telegram](https://t.me/DylanForexia)
