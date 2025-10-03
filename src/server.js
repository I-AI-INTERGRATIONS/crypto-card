import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import { nanoid } from 'nanoid';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Simple in-memory user store
const users = new Map(); // key: telegramUserId -> { id, balance, lastWinAt }

function getOrCreateUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, { id: userId, balance: 0, lastWinAt: 0 });
  }
  return users.get(userId);
}

// Rewards: everyone gets a payout per game, win gets bonus and 1s pause on UI
const BASE_PAYOUT = 1; // points
const WIN_BONUS = 4; // additional points on win

// Minimal quotes stub for WBTC/WETH; real integration can use an aggregator
async function fetchQuotes() {
  try {
    const [wbtc, weth] = await Promise.all([
      axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'wrapped-bitcoin', vs_currencies: 'usd' } }),
      axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'weth', vs_currencies: 'usd' } }),
    ]);
    return {
      WBTC_USD: wbtc.data?.['wrapped-bitcoin']?.usd ?? null,
      WETH_USD: weth.data?.['weth']?.usd ?? null,
    };
  } catch (e) {
    return { WBTC_USD: null, WETH_USD: null };
  }
}

// Serve Mini App static files
app.use('/app', express.static(path.join(__dirname, '..', 'webapp')));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Wallet endpoints
app.get('/api/me/:tgId', (req, res) => {
  const user = getOrCreateUser(req.params.tgId);
  res.json({ id: user.id, balance: user.balance });
});

app.post('/api/play/:tgId', (req, res) => {
  const user = getOrCreateUser(req.params.tgId);
  const win = Math.random() < 0.5; // 50% win for demo
  const payout = BASE_PAYOUT + (win ? WIN_BONUS : 0);
  user.balance += payout;
  user.lastWinAt = Date.now();
  res.json({ win, payout, balance: user.balance });
});

app.post('/api/withdraw/:tgId', async (req, res) => {
  // LNURL-withdraw stub; integrate LNbits or LND as needed
  const user = getOrCreateUser(req.params.tgId);
  const amount = Math.min(user.balance, Number(req.body?.amount ?? 0));
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  user.balance -= amount;
  const withdrawalId = nanoid();
  res.json({ ok: true, withdrawalId, amount });
});

app.get('/api/quotes', async (_req, res) => {
  res.json(await fetchQuotes());
});

// Telegram Bot setup
const BOT_TOKEN = process.env.BOT_TOKEN;
let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) => {
    const tgId = String(ctx.from.id);
    getOrCreateUser(tgId);
    const url = `${PUBLIC_URL}/app/index.html?tgId=${tgId}`;
    return ctx.reply(
      'Open the Wallet + Game Mini App',
      Markup.inlineKeyboard([
        [Markup.button.webApp('Open App', url)],
      ])
    );
  });

  bot.command('app', (ctx) => {
    const tgId = String(ctx.from.id);
    const url = `${PUBLIC_URL}/app/index.html?tgId=${tgId}`;
    return ctx.reply('Open the app:', Markup.inlineKeyboard([[Markup.button.webApp('Open App', url)]]));
  });

  bot.launch().then(() => console.log('Bot launched')); 
} else {
  console.warn('No BOT_TOKEN provided; Telegram bot disabled');
}

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

// Graceful stop for bot
process.once('SIGINT', () => bot?.stop('SIGINT'));
process.once('SIGTERM', () => bot?.stop('SIGTERM'));
