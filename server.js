// ======================================================
// FAR TRADER V6.9
// Bybit USDT Perpetual Futures Scanner
// Trend 1H | Structure 15M | Entry 5M
// ======================================================

const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const BYBIT_URL = "https://api.bybit.com";

const VERSION = "6.9";
const SCAN_INTERVAL = 60 * 1000;
const MAX_SYMBOLS = 20;
const MIN_TURNOVER = 10000000;
const MIN_SCORE = 80;

let signals = [];
let history = [];
let lastScan = null;
let scanning = false;
let lastError = null;
let instrumentCache = [];
let instrumentCacheTime = 0;

const subscriptions = new Map();

// ======================================================
// PUSH NOTIFICATION CONFIG
// ======================================================

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        "mailto:admin@example.com",
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

// ======================================================
// GENERAL HELPERS
// ======================================================

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function apiRequest(url) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: {
            "User-Agent": "FAR-Trader/6.9"
        }
    });

    if (!response.ok) {
        throw new Error("HTTP " + response.status);
    }

    const data = await response.json();

    if (data.retCode !== 0) {
        throw new Error(data.retMsg || "Bybit API error");
    }

    return data.result;
}

async function mapLimit(items, limit, callback) {
    const results = new Array(items.length);
    let index = 0;

    async function worker() {
        while (true) {
            const current = index++;

            if (current >= items.length) return;

            try {
                results[current] = await callback(items[current]);
            } catch (error) {
                results[current] = null;
            }
        }
    }

    const workers = [];

    for (let i = 0; i < Math.min(limit, items.length); i++) {
        workers.push(worker());
    }

    await Promise.all(workers);

    return results;
}

function round(value, digits = 6) {
    if (!Number.isFinite(value)) return 0;

    return Number(value.toFixed(digits));
}

// ======================================================
// BYBIT INSTRUMENTS
// ======================================================

async function getInstruments() {
    if (
        instrumentCache.length &&
        Date.now() - instrumentCacheTime < 6 * 60 * 60 * 1000
    ) {
        return instrumentCache;
    }

    let cursor = "";
    let all = [];

    for (let page = 0; page < 10; page++) {
        let url =
            `${BYBIT_URL}/v5/market/instruments-info?category=linear&limit=1000`;

        if (cursor) {
            url += "&cursor=" + encodeURIComponent(cursor);
        }

        const result = await apiRequest(url);

        const list = result.list || [];

        all.push(...list);

        cursor = result.nextPageCursor;

        if (!cursor || !list.length) break;

        await sleep(150);
    }

    instrumentCache = all.filter(item =>
        item.status === "Trading" &&
        item.quoteCoin === "USDT" &&
        item.contractType === "LinearPerpetual"
    );

    instrumentCacheTime = Date.now();

    return instrumentCache;
}

// ======================================================
// TOP VOLUME SYMBOLS
// ======================================================

async function getTopSymbols() {
    const instruments = await getInstruments();

    const result = await apiRequest(
        `${BYBIT_URL}/v5/market/tickers?category=linear`
    );

    const allowed = new Set(
        instruments.map(item => item.symbol)
    );

    return (result.list || [])
        .filter(item =>
            allowed.has(item.symbol) &&
            Number(item.turnover24h) >= MIN_TURNOVER
        )
        .sort((a, b) =>
            Number(b.turnover24h) - Number(a.turnover24h)
        )
        .slice(0, MAX_SYMBOLS)
        .map(item => ({
            symbol: item.symbol,
            price: Number(item.lastPrice),
            turnover: Number(item.turnover24h),
            change24h: Number(item.price24hPcnt) * 100
        }));
}

// ======================================================
// GET CANDLES
// ======================================================

async function getCandles(symbol, interval, limit = 150) {
    const url =
        `${BYBIT_URL}/v5/market/kline?category=linear` +
        `&symbol=${symbol}&interval=${interval}&limit=${limit}`;

    const result = await apiRequest(url);

    return (result.list || [])
        .reverse()
        .map(item => ({
            time: Number(item[0]),
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5]),
            turnover: Number(item[6])
        }));
}

// ======================================================
// TECHNICAL INDICATORS
// ======================================================

function ema(values, period) {
    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let result = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {
        result =
            (values[i] - result) * multiplier + result;
    }

    return result;
}

function rsi(values, period = 14) {
    if (values.length <= period) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        avgGain =
            (avgGain * (period - 1) + Math.max(change, 0)) /
            period;

        avgLoss =
            (avgLoss * (period - 1) + Math.max(-change, 0)) /
            period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
    if (candles.length < period + 1) return 0;

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {
        const current = candles[i];
        const previous = candles[i - 1];

        ranges.push(
            Math.max(
                current.high - current.low,
                Math.abs(current.high - previous.close),
                Math.abs(current.low - previous.close)
            )
        );
    }

    const recent = ranges.slice(-period);

    return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function getLevels(candles) {
    const recent = candles.slice(-30);

    return {
        support: Math.min(...recent.map(c => c.low)),
        resistance: Math.max(...recent.map(c => c.high))
    };
}

function averageVolume(candles, period = 20) {
    const recent = candles.slice(-period);

    if (!recent.length) return 0;

    return recent.reduce((sum, c) => sum + c.volume, 0) /
        recent.length;
}

// ======================================================
// TREND ANALYSIS
// ======================================================

function getTrend(candles) {
    const closes = candles.map(c => c.close);

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);

    const price = closes[closes.length - 1];

    if (!ema20 || !ema50) {
        return "NEUTRAL";
    }

    if (price > ema20 && ema20 > ema50) {
        return "BULLISH";
    }

    if (price < ema20 && ema20 < ema50) {
        return "BEARISH";
    }

    return "NEUTRAL";
}

// ======================================================
// CANDLE CONFIRMATION
// ======================================================

function candleDirection(candles) {
    const last = candles[candles.length - 1];

    if (!last) return "NEUTRAL";

    if (last.close > last.open) return "BUY";

    if (last.close < last.open) return "SELL";

    return "NEUTRAL";
}

// ======================================================
// ANALYZE ONE SYMBOL
// ======================================================

async function analyzeSymbol(item) {
    try {
        const symbol = item.symbol;

        const [h1, m15, m5] = await Promise.all([
            getCandles(symbol, "60", 120),
            getCandles(symbol, "15", 120),
            getCandles(symbol, "5", 120)
        ]);

        if (
            h1.length < 60 ||
            m15.length < 60 ||
            m5.length < 60
        ) {
            return null;
        }

        const price = item.price;

        const trend = getTrend(h1);

        const trend15 = getTrend(m15);

        const trend5 = getTrend(m5);

        const closes15 = m15.map(c => c.close);
        const closes5 = m5.map(c => c.close);

        const ema20_5 = ema(closes5, 20);
        const ema50_5 = ema(closes5, 50);

        const rsi15 = rsi(closes15);
        const rsi5 = rsi(closes5);

        const levels = getLevels(m15);

        const atrValue = atr(m15);

        const last5 = m5[m5.length - 1];

        const previous5 = m5[m5.length - 2];

        const avgVol = averageVolume(m5, 20);

        const volumeStrong =
            last5.volume > avgVol * 1.2;

        const bullishCandle =
            last5.close > last5.open &&
            last5.close > previous5.high;

        const bearishCandle =
            last5.close < last5.open &&
            last5.close < previous5.low;

        let buyScore = 0;
        let sellScore = 0;

        // 1H trend: 25 points
        if (trend === "BULLISH") buyScore += 25;

        if (trend === "BEARISH") sellScore += 25;

        // 15M structure: 20 points
        if (trend15 === "BULLISH") buyScore += 20;

        if (trend15 === "BEARISH") sellScore += 20;

        // 5M EMA: 10 points
        if (
            ema20_5 &&
            ema50_5 &&
            price > ema20_5 &&
            ema20_5 > ema50_5
        ) {
            buyScore += 10;
        }

        if (
            ema20_5 &&
            ema50_5 &&
            price < ema20_5 &&
            ema20_5 < ema50_5
        ) {
            sellScore += 10;
        }

        // RSI 15M: 10 points
        if (rsi15 >= 50 && rsi15 <= 68) {
            buyScore += 10;
        }

        if (rsi15 <= 50 && rsi15 >= 32) {
            sellScore += 10;
        }

        // RSI 5M: 10 points
        if (rsi5 >= 45 && rsi5 <= 68) {
            buyScore += 10;
        }

        if (rsi5 <= 55 && rsi5 >= 32) {
            sellScore += 10;
        }

        // Candle confirmation: 10 points
        if (bullishCandle) buyScore += 10;

        if (bearishCandle) sellScore += 10;

        // Volume: 5 points
        if (volumeStrong) {
            if (last5.close > last5.open) {
                buyScore += 5;
            }

            if (last5.close < last5.open) {
                sellScore += 5;
            }
        }

        // Support / Resistance proximity: 5 points
        const distanceSupport =
            Math.abs(price - levels.support) / price;

        const distanceResistance =
            Math.abs(levels.resistance - price) / price;

        if (distanceSupport < 0.006) {
            buyScore += 5;
        }

        if (distanceResistance < 0.006) {
            sellScore += 5;
        }

        let side = "WAIT";
        let score = Math.max(buyScore, sellScore);

        if (
            buyScore >= MIN_SCORE &&
            buyScore > sellScore &&
            trend === "BULLISH"
        ) {
            side = "BUY";
            score = buyScore;
        } else if (
            sellScore >= MIN_SCORE &&
            sellScore > buyScore &&
            trend === "BEARISH"
        ) {
            side = "SELL";
            score = sellScore;
        }

        let entry = 0;
        let stopLoss = 0;
        let takeProfit1 = 0;
        let takeProfit2 = 0;

        if (side === "BUY") {
            entry = price;

            stopLoss = Math.min(
                levels.support - atrValue * 0.25,
                entry - atrValue
            );

            const risk = entry - stopLoss;

            takeProfit1 = entry + risk * 1.5;

            takeProfit2 = entry + risk * 2.5;
        }

        if (side === "SELL") {
            entry = price;

            stopLoss = Math.max(
                levels.resistance + atrValue * 0.25,
                entry + atrValue
            );

            const risk = stopLoss - entry;

            takeProfit1 = entry - risk * 1.5;

            takeProfit2 = entry - risk * 2.5;
        }

        return {
            symbol,
            side,
            score: round(score, 0),

            price: round(price),

            entry: round(entry),

            stopLoss: round(stopLoss),

            takeProfit1: round(takeProfit1),

            takeProfit2: round(takeProfit2),

            support: round(levels.support),

            resistance: round(levels.resistance),

            trend1H: trend,

            trend15M: trend15,

            trend5M: trend5,

            rsi15M: round(rsi15, 2),

            rsi5M: round(rsi5, 2),

            volumeStrong,

            turnover24h: round(item.turnover, 0),

            change24h: round(item.change24h, 2),

            updatedAt: new Date().toISOString()
        };

    } catch (error) {
        console.error(
            "Analysis error:",
            item.symbol,
            error.message
        );

        return null;
    }
}

// ======================================================
// PUSH NOTIFICATIONS
// ======================================================

async function sendPush(title, message) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        return;
    }

    const payload = JSON.stringify({
        title,
        body: message,
        icon: "./icon-192.png",
        badge: "./icon-192.png"
    });

    for (const [id, subscription] of subscriptions.entries()) {
        try {
            await webpush.sendNotification(
                subscription,
                payload
            );
        } catch (error) {
            if (
                error.statusCode === 404 ||
                error.statusCode === 410
            ) {
                subscriptions.delete(id);
            }

            console.error("Push error:", error.message);
        }
    }
}

async function notifyNewSignals(newSignals) {
    for (const signal of newSignals) {
        if (signal.side === "WAIT") continue;

        const title =
            signal.side === "BUY"
                ? "🟢 FAR Trader | BUY"
                : "🔴 FAR Trader | SELL";

        const message =
            `${signal.symbol} | امتیاز ${signal.score}` +
            ` | ورود: ${signal.entry}` +
            ` | حد ضرر: ${signal.stopLoss}` +
            ` | هدف اول: ${signal.takeProfit1}`;

        await sendPush(title, message);
    }
}

// ======================================================
// MARKET SCANNER
// ======================================================

async function scanMarket() {
    if (scanning) return;

    scanning = true;

    lastError = null;

    console.log("FAR Trader scanning market...");

    try {
        const topSymbols = await getTopSymbols();

        const results = await mapLimit(
            topSymbols,
            4,
            analyzeSymbol
        );

        const valid = results
            .filter(Boolean)
            .sort((a, b) => b.score - a.score);

        const previousMap = new Map(
            signals.map(s => [s.symbol, s.side])
        );

        const newSignals = valid.filter(signal =>
            signal.side !== "WAIT" &&
            previousMap.get(signal.symbol) !== signal.side
        );

        signals = valid;

        history.unshift({
            time: new Date().toISOString(),
            count: valid.length,
            strongSignals: valid.filter(
                s => s.side !== "WAIT"
            ).length
        });

        history = history.slice(0, 100);

        lastScan = new Date().toISOString();

        await notifyNewSignals(newSignals);

        console.log(
            "Scan completed:",
            valid.length,
            "symbols"
        );

    } catch (error) {
        lastError = error.message;

        console.error("Scan failed:", error.message);

    } finally {
        scanning = false;
    }
}

// ======================================================
// ROOT PAGE
// ======================================================

app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport"
              content="width=device-width, initial-scale=1">
        <title>FAR Trader V6.9</title>
        <style>
            body {
                background: #08111f;
                color: white;
                font-family: Arial, sans-serif;
                text-align: center;
                padding: 40px 15px;
            }
            .box {
                background: #142238;
                padding: 25px;
                border-radius: 15px;
                max-width: 500px;
                margin: auto;
            }
            .green { color: #22d3a6; }
        </style>
    </head>
    <body>
        <div class="box">
            <h1>FAR Trader V6.9 🚀</h1>
            <h2 class="green">Backend Online</h2>
            <p>Bybit USDT Perpetual Scanner</p>
            <p>Trend 1H | Structure 15M | Entry 5M</p>
            <p>Scan interval: 60 seconds</p>
            <p><a style="color:#22d3a6"
               href="/api/status">API Status</a></p>
            <p><a style="color:#22d3a6"
               href="/api/signals">API Signals</a></p>
        </div>
    </body>
    </html>
    `);
});

// ======================================================
// API STATUS
// ======================================================

app.get("/api/status", (req, res) => {
    res.json({
        online: true,
        version: VERSION,
        scanning,
        lastScan,
        error: lastError,
        signalCount: signals.length,
        strongSignals: signals.filter(
            s => s.side !== "WAIT"
        ).length,
        symbols: signals.length,
        pushConfigured: Boolean(
            VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY
        ),
        subscriptions: subscriptions.size,
        interval: SCAN_INTERVAL
    });
});

// ======================================================
// API SIGNALS
// ======================================================

app.get("/api/signals", (req, res) => {
    res.json({
        success: true,
        version: VERSION,
        lastScan,
        scanning,
        count: signals.length,
        signals
    });
});

// ======================================================
// API STRONG SIGNALS
// ======================================================

app.get("/api/strong-signals", (req, res) => {
    const strong = signals.filter(
        s => s.side !== "WAIT" && s.score >= MIN_SCORE
    );

    res.json({
        success: true,
        count: strong.length,
        signals: strong
    });
});

// ======================================================
// API HISTORY
// ======================================================

app.get("/api/history", (req, res) => {
    res.json({
        success: true,
        history
    });
});

// ======================================================
// API MANUAL SCAN
// ======================================================

app.post("/api/scan", (req, res) => {
    if (scanning) {
        return res.json({
            success: false,
            message: "Scan already running"
        });
    }

    scanMarket();

    res.json({
        success: true,
        message: "Scan started"
    });
});

// ======================================================
// PUSH PUBLIC KEY
// ======================================================

app.get("/api/push/public-key", (req, res) => {
    res.json({
        publicKey: VAPID_PUBLIC_KEY || null
    });
});

// ======================================================
// PUSH SUBSCRIBE
// ======================================================

app.post("/api/push/subscribe", (req, res) => {
    if (!req.body || !req.body.endpoint) {
        return res.status(400).json({
            success: false,
            message: "Invalid subscription"
        });
    }

    subscriptions.set(
        req.body.endpoint,
        req.body
    );

    res.json({
        success: true,
        message: "Push subscription saved"
    });
});

// ======================================================
// PUSH UNSUBSCRIBE
// ======================================================

app.post("/api/push/unsubscribe", (req, res) => {
    const endpoint = req.body?.endpoint;

    if (endpoint) {
        subscriptions.delete(endpoint);
    }

    res.json({
        success: true
    });
});

// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        version: VERSION,
        time: new Date().toISOString()
    });
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
    console.log(
        `FAR Trader V${VERSION} running on port ${PORT}`
    );

    scanMarket();

    setInterval(() => {
        scanMarket();
    }, SCAN_INTERVAL);
});
