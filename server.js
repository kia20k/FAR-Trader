
require("dotenv").config();

const express = require("express");
const webpush = require("web-push");

const app = express();

app.use(express.json({ limit: "1mb" }));

// تنظیم دسترسی برای GitHub Pages
app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL || "*";

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 3000;

const BYBIT_URL = "https://api.bybit.com";

const SCAN_INTERVAL = 60000;
const SCAN_LIMIT = 20;
const MIN_SCORE = 85;

let signals = [];
let lastScan = null;
let scanRunning = false;
let scanError = null;

const subscriptions = new Map();

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || "mailto:admin@example.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(
    VAPID_EMAIL,
    VAPID_PUBLIC,
    VAPID_PRIVATE
  );
}

// دریافت اطلاعات از Bybit
async function bybit(path) {
  const response = await fetch(BYBIT_URL + path);

  if (!response.ok) {
    throw new Error("Bybit HTTP " + response.status);
  }

  const data = await response.json();

  if (data.retCode !== 0) {
    throw new Error(data.retMsg || "Bybit API error");
  }

  return data.result;
}

// دریافت کندل‌ها
async function getCandles(symbol, interval) {
  const result = await bybit(
    `/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=100`
  );

  return result.list
    .map(c => ({
      time: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5])
    }))
    .reverse()
    .filter(c => c.time + Number(interval) * 60000 <= Date.now());
}

// محاسبه EMA
function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    value = (values[i] - value) * multiplier + value;
  }

  return value;
}

// محاسبه RSI
function rsi(values, period = 14) {
  if (values.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  if (losses === 0) return 100;

  const rs = gains / losses;

  return 100 - 100 / (1 + rs);
}

// تحلیل هر نماد
async function analyzeSymbol(symbol, turnover) {
  try {
    const [oneHour, fifteenMin, fiveMin] = await Promise.all([
      getCandles(symbol, "60"),
      getCandles(symbol, "15"),
      getCandles(symbol, "5")
    ]);

    if (
      oneHour.length < 55 ||
      fifteenMin.length < 30 ||
      fiveMin.length < 30
    ) {
      return null;
    }

    const closes1h = oneHour.map(c => c.close);
    const closes15m = fifteenMin.map(c => c.close);
    const closes5m = fiveMin.map(c => c.close);

    const price = closes5m[closes5m.length - 1];

    const ema20_1h = ema(closes1h, 20);
    const ema50_1h = ema(closes1h, 50);

    const ema20_15m = ema(closes15m, 20);
    const ema50_15m = ema(closes15m, 50);

    const ema20_5m = ema(closes5m, 20);

    const rsi15m = rsi(closes15m);
    const rsi5m = rsi(closes5m);

    const trendUp =
      ema20_1h > ema50_1h &&
      price > ema20_1h;

    const trendDown =
      ema20_1h < ema50_1h &&
      price < ema20_1h;

    let buyScore = 0;
    let sellScore = 0;

    if (trendUp) buyScore += 30;
    if (trendDown) sellScore += 30;

    if (ema20_15m > ema50_15m) buyScore += 20;
    if (ema20_15m < ema50_15m) sellScore += 20;

    if (price > ema20_5m) buyScore += 15;
    if (price < ema20_5m) sellScore += 15;

    if (rsi15m >= 50 && rsi15m <= 68) buyScore += 15;
    if (rsi15m <= 50 && rsi15m >= 32) sellScore += 15;

    if (rsi5m >= 50 && rsi5m <= 70) buyScore += 20;
    if (rsi5m <= 50 && rsi5m >= 30) sellScore += 20;

    const side =
      buyScore >= MIN_SCORE && buyScore > sellScore
        ? "BUY"
        : sellScore >= MIN_SCORE && sellScore > buyScore
        ? "SELL"
        : "WAIT";

    const score = Math.max(buyScore, sellScore);

    const atrValues = fiveMin.slice(-15).map(c => c.high - c.low);
    const atr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;

    const entry = price;

    let sl = 0;
    let tp1 = 0;
    let tp2 = 0;

    if (side === "BUY") {
      sl = entry - atr * 1.5;
      tp1 = entry + atr * 2;
      tp2 = entry + atr * 3;
    }

    if (side === "SELL") {
      sl = entry + atr * 1.5;
      tp1 = entry - atr * 2;
      tp2 = entry - atr * 3;
    }

    return {
      symbol,
      side,
      score,
      price,
      entry: side === "WAIT" ? 0 : entry,
      stopLoss: sl,
      takeProfit1: tp1,
      takeProfit2: tp2,
      rsi15m: Number(rsi15m.toFixed(2)),
      rsi5m: Number(rsi5m.toFixed(2)),
      turnover,
      trend: trendUp ? "BULLISH" : trendDown ? "BEARISH" : "NEUTRAL",
      timeframe: "1H / 15M / 5M",
      updatedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error(symbol, error.message);
    return null;
  }
}

// ارسال اعلان
async function sendPush(signal) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const payload = JSON.stringify({
    title: "FAR Trader | سیگنال ویژه",
    body:
      `${signal.symbol} | ${signal.side} | امتیاز ${signal.score}/100`,
    url: "/",
    symbol: signal.symbol,
    side: signal.side
  });

  for (const [id, subscription] of subscriptions) {
    try {
      await webpush.sendNotification(subscription, payload);
    } catch (error) {
      console.error("Push error:", error.message);

      if (error.statusCode === 404 || error.statusCode === 410) {
        subscriptions.delete(id);
      }
    }
  }
}

// اسکن بازار
async function scanMarket() {
  if (scanRunning) return;

  scanRunning = true;

  try {
    console.log("FAR Trader scanning market...");

    const result = await bybit(
      "/v5/market/tickers?category=linear"
    );

    const symbols = result.list
      .filter(item =>
        item.symbol.endsWith("USDT") &&
        Number(item.turnover24h) > 10000000
      )
      .sort((a, b) =>
        Number(b.turnover24h) - Number(a.turnover24h)
      )
      .slice(0, SCAN_LIMIT);

    const results = await Promise.all(
      symbols.map(item =>
        analyzeSymbol(
          item.symbol,
          Number(item.turnover24h)
        )
      )
    );

    const validSignals = results.filter(Boolean);

    const previousSignals = new Set(
      signals
        .filter(s => s.side !== "WAIT")
        .map(s => `${s.symbol}-${s.side}`)
    );

    signals = validSignals.sort(
      (a, b) => b.score - a.score
    );

    for (const signal of signals) {
      const key = `${signal.symbol}-${signal.side}`;

      if (
        signal.side !== "WAIT" &&
        signal.score >= MIN_SCORE &&
        !previousSignals.has(key)
      ) {
        await sendPush(signal);
      }
    }

    lastScan = new Date().toISOString();
    scanError = null;

    console.log("Scan completed:", signals.length);

  } catch (error) {
    scanError = error.message;
    console.error("Scan failed:", error.message);

  } finally {
    scanRunning = false;
  }
}

// وضعیت سرور
app.get("/api/status", (req, res) => {
  res.json({
    online: true,
    version: "6.8",
    scanning: scanRunning,
    lastScan,
    error: scanError,
    signalCount: signals.length
  });
});

// دریافت سیگنال‌ها
app.get("/api/signals", (req, res) => {
  res.json({
    success: true,
    version: "6.8",
    updatedAt: lastScan,
    signals
  });
});

// دریافت کلید عمومی اعلان
app.get("/api/push/public-key", (req, res) => {
  res.json({
    publicKey: VAPID_PUBLIC || null
  });
});

// ثبت اشتراک اعلان
app.post("/api/push/subscribe", (req, res) => {
  const subscription = req.body;

  if (
    !subscription ||
    !subscription.endpoint ||
    !subscription.keys
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid subscription"
    });
  }

  subscriptions.set(
    subscription.endpoint,
    subscription
  );

  res.json({ success: true });
});

// حذف اشتراک اعلان
app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = req.body?.endpoint;

  if (endpoint) subscriptions.delete(endpoint);

  res.json({ success: true });
});

// شروع سرور
app.listen(PORT, () => {
  console.log(`FAR Trader V6.8 running on port ${PORT}`);

  scanMarket();

  setInterval(scanMarket, SCAN_INTERVAL);
});
