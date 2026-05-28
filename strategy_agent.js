/**
 * File: strategy_agent.js
 * Version: 2.0.0
 *
 * Strategy Organizer Agent — Multi-Pair, Multi-Indicator
 *
 * What changed from v1:
 *   - Mode is now written to mode.json (hot-read by scalper_machine.js every cycle)
 *     AND persisted into scalper_machine.js source for restarts. Previously only the
 *     source file was touched, which the running process never re-read.
 *   - Decision uses three indicators per pair (ADX trend strength, ATR volatility
 *     ratio, Wilder RSI) instead of a single simplified RSI on BTC alone.
 *   - All 5 traded pairs vote; each vote is weighted by ADX confidence so a strongly
 *     trending BTC doesn't get overruled by a choppy ADA candle.
 *   - Hysteresis: the suggested mode must hold for CONFIRM_INTERVALS consecutive
 *     checks before a switch fires. Prevents thrashing on a single noisy candle.
 *   - Mode hold: after any switch, a MIN_HOLD_MS cooldown blocks further switches.
 *   - currentMode is initialised from mode.json on startup so agent stays in sync
 *     with the running bot after a restart.
 */

'use strict';

const ccxt = require('ccxt');
const http = require('http');
const fs   = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
    checkIntervalMs:   90000,   // Evaluate every 90 s (5 pairs × API calls, be gentle)
    port:              3000,
    modeFile:          './mode.json',
    scalperFile:       './scalper_machine.js',

    // Pairs + their evaluation timeframe (match scalper TOKEN_CONFIGS)
    pairs: [
        { symbol: 'BTC/USDT', tf: '15m', weight: 2.0 },  // BTC gets double weight
        { symbol: 'ETH/USDT', tf: '15m', weight: 1.5 },
        { symbol: 'SOL/USDT', tf:  '5m', weight: 1.0 },
        { symbol: 'ADA/USDT', tf:  '5m', weight: 0.8 },
        { symbol: 'DOGE/USDT',tf: '30m', weight: 0.7 },
    ],

    // Indicator thresholds
    adxPeriod:         14,
    adxTrendMin:       20,    // ADX < 20 → market is ranging, lean reversal
    adxStrongTrend:    30,    // ADX > 30 → strong trend, lean trend mode
    atrPeriod:         14,
    atrVolaRatio:      0.012, // ATR/price > 1.2% → elevated volatility → reversal
    rsiPeriod:         14,
    rsiOversold:       35,
    rsiOverbought:     65,

    // Hysteresis: must agree this many consecutive intervals before switching
    confirmIntervals:  2,

    // Minimum ms to hold a mode after switching (prevents rapid flip-flop)
    minHoldMs:         5 * 60 * 1000,   // 5 minutes
};

// ─── State ────────────────────────────────────────────────────────────────────
let currentMode        = 'trend';
let pendingMode        = null;   // candidate that needs CONFIRM_INTERVALS to confirm
let pendingCount       = 0;
let lastSwitchTime     = 0;

const exchange = new ccxt.weex({ enableRateLimit: true, timeout: 15000 });

// ─── Startup: sync currentMode from mode.json if it exists ───────────────────
function loadPersistedMode() {
    try {
        if (fs.existsSync(CONFIG.modeFile)) {
            const data = JSON.parse(fs.readFileSync(CONFIG.modeFile, 'utf8'));
            if (data.mode === 'trend' || data.mode === 'reversal') {
                currentMode = data.mode;
                console.log(`[AGENT] Loaded persisted mode: ${currentMode}`);
            }
        }
    } catch (_) {}
}

// ─── Indicators ───────────────────────────────────────────────────────────────

// Wilder-smoothed RSI (same algorithm as scalper_machine.js)
function calcRSI(closes, period) {
    if (closes.length < period + 1) return null;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d >= 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period;
    avgLoss /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        const g = d > 0 ? d : 0;
        const l = d < 0 ? -d : 0;
        avgGain = (avgGain * (period - 1) + g) / period;
        avgLoss = (avgLoss * (period - 1) + l) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

// Average True Range
function calcATR(candles, period) {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const high  = candles[i][2], low = candles[i][3], prevClose = candles[i - 1][4];
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    // Wilder smooth ATR
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
    }
    return atr;
}

// Average Directional Index (ADX)
// Returns { adx, plusDI, minusDI }
function calcADX(candles, period) {
    if (candles.length < period * 2) return null;
    const dmPlus = [], dmMinus = [], trs = [];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i][2], low = candles[i][3];
        const prevHigh = candles[i-1][2], prevLow = candles[i-1][3], prevClose = candles[i-1][4];
        const upMove   = high - prevHigh;
        const downMove = prevLow - low;
        dmPlus.push( upMove > downMove && upMove > 0 ? upMove : 0);
        dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    // Wilder smooth all three arrays
    const smooth = (arr) => {
        let val = arr.slice(0, period).reduce((a, b) => a + b, 0);
        const out = [val];
        for (let i = period; i < arr.length; i++) {
            val = val - (val / period) + arr[i];
            out.push(val);
        }
        return out;
    };

    const sTR  = smooth(trs);
    const sDMp = smooth(dmPlus);
    const sDMm = smooth(dmMinus);

    const dxArr = [];
    for (let i = 0; i < sTR.length; i++) {
        if (sTR[i] === 0) continue;
        const pDI = (sDMp[i] / sTR[i]) * 100;
        const mDI = (sDMm[i] / sTR[i]) * 100;
        const dx  = Math.abs(pDI - mDI) / (pDI + mDI) * 100;
        dxArr.push({ dx, pDI, mDI });
    }
    if (dxArr.length < period) return null;

    // Final ADX = Wilder average of DX
    let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
    for (let i = period; i < dxArr.length; i++) {
        adxVal = (adxVal * (period - 1) + dxArr[i].dx) / period;
    }
    const last = dxArr[dxArr.length - 1];
    return { adx: adxVal, plusDI: last.pDI, minusDI: last.mDI };
}

// ─── Per-pair vote ─────────────────────────────────────────────────────────────
// Returns { vote: 'trend'|'reversal', confidence: 0-1, reasons: string[] }
function computeVote(candles, symbol) {
    const closes = candles.map(c => c[4]);
    const rsi    = calcRSI(closes, CONFIG.rsiPeriod);
    const atr    = calcATR(candles, CONFIG.atrPeriod);
    const adxRes = calcADX(candles, CONFIG.adxPeriod);
    const lastClose = closes[closes.length - 1];

    if (rsi === null || atr === null || adxRes === null) {
        return { vote: 'trend', confidence: 0, reasons: ['insufficient data'] };
    }

    const { adx, plusDI, minusDI } = adxRes;
    const atrRatio = atr / lastClose;

    const trendPoints    = [];
    const reversalPoints = [];
    const reasons        = [];

    // ── ADX scoring ──────────────────────────────────────────────────────────
    if (adx >= CONFIG.adxStrongTrend) {
        trendPoints.push(1.5);
        reasons.push(`ADX ${adx.toFixed(1)} (strong trend)`);
    } else if (adx >= CONFIG.adxTrendMin) {
        trendPoints.push(0.8);
        reasons.push(`ADX ${adx.toFixed(1)} (moderate trend)`);
    } else {
        reversalPoints.push(1.0);
        reasons.push(`ADX ${adx.toFixed(1)} (ranging)`);
    }

    // ── DI alignment (trend direction clarity) ───────────────────────────────
    const diSpread = Math.abs(plusDI - minusDI);
    if (diSpread > 15) {
        trendPoints.push(0.7);
        reasons.push(`DI spread ${diSpread.toFixed(1)} (clear direction)`);
    } else {
        reversalPoints.push(0.5);
        reasons.push(`DI spread ${diSpread.toFixed(1)} (choppy)`);
    }

    // ── ATR volatility ───────────────────────────────────────────────────────
    if (atrRatio > CONFIG.atrVolaRatio) {
        reversalPoints.push(1.0);
        reasons.push(`ATR ratio ${(atrRatio * 100).toFixed(3)}% (high vola)`);
    } else {
        trendPoints.push(0.5);
        reasons.push(`ATR ratio ${(atrRatio * 100).toFixed(3)}% (low vola)`);
    }

    // ── RSI extremes ─────────────────────────────────────────────────────────
    if (rsi <= CONFIG.rsiOversold || rsi >= CONFIG.rsiOverbought) {
        reversalPoints.push(1.0);
        reasons.push(`RSI ${rsi.toFixed(1)} (extreme)`);
    } else if (rsi > 45 && rsi < 55) {
        trendPoints.push(0.6);
        reasons.push(`RSI ${rsi.toFixed(1)} (neutral/trending)`);
    } else {
        reasons.push(`RSI ${rsi.toFixed(1)}`);
    }

    const tScore = trendPoints.reduce((a, b) => a + b, 0);
    const rScore = reversalPoints.reduce((a, b) => a + b, 0);
    const total  = tScore + rScore || 1;
    const vote        = tScore >= rScore ? 'trend' : 'reversal';
    const confidence  = Math.abs(tScore - rScore) / total;

    return { vote, confidence, adx, atrRatio, rsi, reasons };
}

// ─── Mode persistence ─────────────────────────────────────────────────────────
function writeModeJson(mode, meta) {
    const payload = {
        mode,
        updatedAt:  new Date().toISOString(),
        reasoning:  meta,
    };
    fs.writeFileSync(CONFIG.modeFile, JSON.stringify(payload, null, 2));
}

// ─── Notify server of mode change ─────────────────────────────────────────────
function notifyServer(mode) {
    return new Promise((resolve) => {
        const data    = JSON.stringify({ action: 'toggleMode', value: mode });
        const options = {
            hostname: 'localhost', port: CONFIG.port,
            path: '/api/control', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        };
        const req = http.request(options, (res) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                console.log(`[AGENT] Server notified: mode = ${mode}`);
            } else {
                console.warn(`[AGENT] Server returned HTTP ${res.statusCode} for mode switch`);
            }
            resolve();
        });
        req.on('error', (err) => {
            console.warn(`[AGENT] Could not notify server: ${err.message}`);
            resolve();
        });
        req.write(data);
        req.end();
    });
}

// ─── Main evaluation loop ─────────────────────────────────────────────────────
async function evaluate() {
    const pairResults = [];
    let   totalWeight = 0;
    let   trendScore  = 0;
    let   reversalScore = 0;

    for (const { symbol, tf, weight } of CONFIG.pairs) {
        try {
            // Fetch enough candles for ADX (needs 2×period), ATR, and RSI
            const needed  = CONFIG.adxPeriod * 2 + CONFIG.rsiPeriod + 5;
            const candles = await exchange.fetchOHLCV(symbol, tf, undefined, needed);
            if (candles.length < needed * 0.8) {
                console.warn(`[AGENT] ${symbol}: only ${candles.length} candles, skipping`);
                continue;
            }

            const result = computeVote(candles, symbol);
            pairResults.push({ symbol, tf, weight, ...result });

            const weightedConfidence = weight * result.confidence;
            if (result.vote === 'trend')    trendScore    += weight + weightedConfidence;
            else                            reversalScore += weight + weightedConfidence;
            totalWeight += weight;

            console.log(
                `[AGENT] ${symbol.padEnd(10)} ${tf.padStart(3)} | ` +
                `Vote: ${result.vote.padEnd(8)} | Conf: ${(result.confidence * 100).toFixed(0).padStart(3)}% | ` +
                `ADX: ${result.adx?.toFixed(1).padStart(5)} | ` +
                `ATR%: ${result.atrRatio != null ? (result.atrRatio * 100).toFixed(3) : '—'} | ` +
                `RSI: ${result.rsi?.toFixed(1).padStart(5)}`
            );
        } catch (err) {
            console.error(`[AGENT] ${symbol} fetch error: ${err.message}`);
        }
    }

    if (totalWeight === 0) {
        console.warn('[AGENT] No valid pair data — skipping this interval');
        return;
    }

    const suggestedMode = trendScore >= reversalScore ? 'trend' : 'reversal';
    const margin = Math.abs(trendScore - reversalScore) / (trendScore + reversalScore);

    console.log(
        `[AGENT] Scores → trend: ${trendScore.toFixed(2)}, reversal: ${reversalScore.toFixed(2)} ` +
        `| Margin: ${(margin * 100).toFixed(1)}% | Suggesting: ${suggestedMode} | Current: ${currentMode}`
    );

    // ── Hysteresis: require CONFIRM_INTERVALS consecutive agreements ──────────
    if (suggestedMode === pendingMode) {
        pendingCount++;
    } else {
        pendingMode  = suggestedMode;
        pendingCount = 1;
    }

    const confirmed = pendingCount >= CONFIG.confirmIntervals;
    const heldLongEnough = (Date.now() - lastSwitchTime) >= CONFIG.minHoldMs;

    if (confirmed && suggestedMode !== currentMode && heldLongEnough) {
        console.log(`[AGENT] ✅ Switching mode: ${currentMode} → ${suggestedMode} (confirmed ${pendingCount}× in a row)`);

        currentMode    = suggestedMode;
        lastSwitchTime = Date.now();
        pendingCount   = 0;

        const meta = pairResults.map(r =>
            `${r.symbol}: ${r.vote} (conf ${(r.confidence * 100).toFixed(0)}%, ADX ${r.adx?.toFixed(1)}, RSI ${r.rsi?.toFixed(1)})`
        );

        writeModeJson(currentMode, meta);         // hot-read by scalper_machine.js
        await notifyServer(currentMode);           // inform server and trigger update


    } else if (!confirmed) {
        console.log(`[AGENT] Pending switch to ${suggestedMode} (${pendingCount}/${CONFIG.confirmIntervals} confirmations)`);
    } else if (!heldLongEnough) {
        const remaining = Math.ceil((CONFIG.minHoldMs - (Date.now() - lastSwitchTime)) / 1000);
        console.log(`[AGENT] Mode hold active — ${remaining}s remaining before switch allowed`);
    }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function run() {
    loadPersistedMode();

    // Write current mode to mode.json immediately on startup so scalper_machine
    // always has a valid file to read even before the first evaluation fires.
    writeModeJson(currentMode, ['agent startup — mode loaded from persistence']);

    console.log(`[AGENT] v2.0.0 started. Mode: ${currentMode}. Evaluating every ${CONFIG.checkIntervalMs / 1000}s`);

    // Run once immediately, then on interval
    await evaluate();
    setInterval(evaluate, CONFIG.checkIntervalMs);
}

run();
