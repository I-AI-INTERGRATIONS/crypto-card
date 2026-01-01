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

// Simple in-memory stores (replace with DB in production)
const users = new Map(); // key: telegramUserId -> { id, balance, lastWinAt }
const profiles = new Map(); // key: telegramUserId -> { id, handle, displayName }
const handleToUserId = new Map(); // key: lower(handle) -> telegramUserId
const userIdToTransactions = new Map(); // key: telegramUserId -> Array<Transaction>
const userIdToRequests = new Map(); // key: telegramUserId -> Array<Request>

function getOrCreateUser(userId) {
  if (!users.has(userId)) {
    users.set(userId, { id: userId, balance: 0, lastWinAt: 0 });
  }
  return users.get(userId);
}

function getOrCreateProfile(userId) {
  if (!profiles.has(userId)) {
    profiles.set(userId, { id: userId, handle: null, displayName: null });
  }
  return profiles.get(userId);
}

function getTransactions(userId) {
  if (!userIdToTransactions.has(userId)) {
    userIdToTransactions.set(userId, []);
  }
  return userIdToTransactions.get(userId);
}

function addTransaction(userId, tx) {
  const transactions = getTransactions(userId);
  transactions.unshift(tx);
  // optional: cap history length
  if (transactions.length > 500) transactions.pop();
}

function getRequests(userId) {
  if (!userIdToRequests.has(userId)) {
    userIdToRequests.set(userId, []);
  }
  return userIdToRequests.get(userId);
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
  const profile = getOrCreateProfile(req.params.tgId);
  res.json({ id: user.id, balance: user.balance, profile });
});

app.post('/api/play/:tgId', (req, res) => {
  const user = getOrCreateUser(req.params.tgId);
  const win = Math.random() < 0.5; // 50% win for demo
  const payout = BASE_PAYOUT + (win ? WIN_BONUS : 0);
  user.balance += payout;
  user.lastWinAt = Date.now();
  addTransaction(user.id, {
    id: nanoid(),
    type: 'game_payout',
    direction: 'credit',
    amount: payout,
    counterparty: null,
    note: 'Game round payout',
    timestamp: Date.now(),
  });
  res.json({ win, payout, balance: user.balance });
});

app.post('/api/withdraw/:tgId', async (req, res) => {
  // LNURL-withdraw stub; integrate LNbits or LND as needed
  const user = getOrCreateUser(req.params.tgId);
  const amount = Math.min(user.balance, Number(req.body?.amount ?? 0));
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  user.balance -= amount;
  const withdrawalId = nanoid();
  addTransaction(user.id, {
    id: withdrawalId,
    type: 'withdraw',
    direction: 'debit',
    amount,
    counterparty: null,
    note: 'Withdraw (stub)',
    timestamp: Date.now(),
  });
  res.json({ ok: true, withdrawalId, amount });
});

app.get('/api/quotes', async (_req, res) => {
  res.json(await fetchQuotes());
});

// Profiles: set and get $handle/displayName
function isValidHandle(handle) {
  return /^[a-z0-9_]{2,16}$/i.test(handle);
}

app.post('/api/profile/:tgId', (req, res) => {
  const userId = String(req.params.tgId);
  getOrCreateUser(userId);
  const profile = getOrCreateProfile(userId);
  const displayName = (req.body?.displayName ?? '').toString().trim() || null;
  const handleRaw = (req.body?.handle ?? '').toString().trim();
  if (handleRaw) {
    const handle = handleRaw.replace(/^\$/,'');
    if (!isValidHandle(handle)) return res.status(400).json({ error: 'Invalid handle' });
    const lower = handle.toLowerCase();
    const existingOwner = handleToUserId.get(lower);
    if (existingOwner && existingOwner !== userId) return res.status(409).json({ error: 'Handle taken' });
    // If changing from previous, free old mapping
    if (profile.handle && profile.handle.toLowerCase() !== lower) {
      handleToUserId.delete(profile.handle.toLowerCase());
    }
    handleToUserId.set(lower, userId);
    profile.handle = handle;
  }
  if (displayName !== null) profile.displayName = displayName;
  res.json({ ok: true, profile });
});

app.get('/api/profile/:tgId', (req, res) => {
  const profile = getOrCreateProfile(String(req.params.tgId));
  res.json(profile);
});

app.get('/api/handle/:handle', (req, res) => {
  const lower = String(req.params.handle || '').replace(/^\$/,'').toLowerCase();
  const owner = handleToUserId.get(lower);
  if (!owner) return res.status(404).json({ error: 'Not found' });
  const profile = getOrCreateProfile(owner);
  res.json({ id: owner, handle: profile.handle, displayName: profile.displayName });
});

// P2P transfers
app.post('/api/transfer/:tgId', (req, res) => {
  const senderId = String(req.params.tgId);
  const sender = getOrCreateUser(senderId);
  const to = (req.body?.to ?? '').toString().trim();
  const toId = (req.body?.toId ?? '').toString().trim();
  const note = (req.body?.note ?? '').toString();
  const amount = Number(req.body?.amount ?? 0);

  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  let recipientId = null;
  if (to) {
    const lower = to.replace(/^\$/,'').toLowerCase();
    recipientId = handleToUserId.get(lower) || null;
  }
  if (!recipientId && toId) recipientId = toId;
  if (!recipientId) return res.status(404).json({ error: 'Recipient not found' });
  if (recipientId === senderId) return res.status(400).json({ error: 'Cannot send to self' });

  const recipient = getOrCreateUser(recipientId);
  if (sender.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

  sender.balance -= amount;
  recipient.balance += amount;

  const senderProfile = getOrCreateProfile(senderId);
  const recipientProfile = getOrCreateProfile(recipientId);
  const txId = nanoid();
  const now = Date.now();
  // Record for sender
  addTransaction(senderId, {
    id: txId,
    type: 'transfer_sent',
    direction: 'debit',
    amount,
    counterparty: { id: recipientId, handle: recipientProfile.handle, displayName: recipientProfile.displayName },
    note,
    timestamp: now,
  });
  // Record for recipient
  addTransaction(recipientId, {
    id: txId,
    type: 'transfer_received',
    direction: 'credit',
    amount,
    counterparty: { id: senderId, handle: senderProfile.handle, displayName: senderProfile.displayName },
    note,
    timestamp: now,
  });

  res.json({ ok: true, txId, balances: { [senderId]: sender.balance, [recipientId]: recipient.balance } });
});

// Payment requests
app.post('/api/request/:tgId', (req, res) => {
  const requesterId = String(req.params.tgId);
  getOrCreateUser(requesterId);
  const to = (req.body?.to ?? '').toString().trim(); // who should pay (target)
  const toId = (req.body?.toId ?? '').toString().trim();
  const note = (req.body?.note ?? '').toString();
  const amount = Number(req.body?.amount ?? 0);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  let targetId = null;
  if (to) {
    const lower = to.replace(/^\$/,'').toLowerCase();
    targetId = handleToUserId.get(lower) || null;
  }
  if (!targetId && toId) targetId = toId;
  if (!targetId) return res.status(404).json({ error: 'Target not found' });
  if (targetId === requesterId) return res.status(400).json({ error: 'Cannot request from self' });

  const reqId = nanoid();
  const now = Date.now();
  const request = { id: reqId, from: requesterId, to: targetId, amount, note, status: 'pending', createdAt: now, updatedAt: now };
  getRequests(requesterId).unshift(request);
  getRequests(targetId).unshift(request);
  res.json({ ok: true, request });
});

app.get('/api/requests/:tgId', (req, res) => {
  const userId = String(req.params.tgId);
  const list = getRequests(userId).filter(r => r.status === 'pending');
  res.json(list);
});

app.post('/api/request/:tgId/accept', (req, res) => {
  const payerId = String(req.params.tgId);
  const requestId = (req.body?.requestId ?? '').toString();
  if (!requestId) return res.status(400).json({ error: 'Missing requestId' });
  const all = getRequests(payerId);
  const target = all.find(r => r.id === requestId);
  if (!target) return res.status(404).json({ error: 'Request not found' });
  if (target.to !== payerId) return res.status(403).json({ error: 'Not the payer' });
  if (target.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });

  // Perform transfer payer -> requester
  req.body = { toId: target.from, amount: target.amount, note: target.note };
  // Reuse transfer logic (with toId override)
  const fakeReq = { params: { tgId: payerId }, body: { toId: target.from, amount: target.amount, note: target.note } };
  const fakeRes = { json: (data) => data, status: (code) => ({ json: (e) => ({ code, ...e }) }) };
  const sender = getOrCreateUser(payerId);
  if (sender.balance < target.amount) return res.status(400).json({ error: 'Insufficient balance' });
  // Do the transfer inline for clarity
  const recipient = getOrCreateUser(target.from);
  sender.balance -= target.amount;
  recipient.balance += target.amount;
  const senderProfile = getOrCreateProfile(payerId);
  const recipientProfile = getOrCreateProfile(target.from);
  const txId = nanoid();
  const now = Date.now();
  addTransaction(payerId, { id: txId, type: 'transfer_sent', direction: 'debit', amount: target.amount, counterparty: { id: target.from, handle: recipientProfile.handle, displayName: recipientProfile.displayName }, note: target.note, timestamp: now });
  addTransaction(target.from, { id: txId, type: 'transfer_received', direction: 'credit', amount: target.amount, counterparty: { id: payerId, handle: senderProfile.handle, displayName: senderProfile.displayName }, note: target.note, timestamp: now });

  target.status = 'completed';
  target.updatedAt = Date.now();
  res.json({ ok: true, txId });
});

app.post('/api/request/:tgId/decline', (req, res) => {
  const userId = String(req.params.tgId);
  const requestId = (req.body?.requestId ?? '').toString();
  const all = getRequests(userId);
  const target = all.find(r => r.id === requestId);
  if (!target) return res.status(404).json({ error: 'Request not found' });
  if (target.to !== userId && target.from !== userId) return res.status(403).json({ error: 'No permission' });
  if (target.status !== 'pending') return res.status(400).json({ error: 'Request not pending' });
  target.status = 'declined';
  target.updatedAt = Date.now();
  res.json({ ok: true });
});

// Activity feed
app.get('/api/activity/:tgId', (req, res) => {
  const userId = String(req.params.tgId);
  const items = getTransactions(userId);
  res.json(items);
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
