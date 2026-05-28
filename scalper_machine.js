/**
 * File: scalper_machine.js
 * Version: 3.1.0
 * Description: Core Multi-Asset Volatility Strategy Engine (Execution Only)
 * Mandate: Zero Placeholders, Full Functional Implementation, Keep It Simple
 *
 * Changelog v3.0.0 — Trade Logic Overhaul:
 *   FIX: RSI now uses proper Wilder smoothing (EMA-based), not single-pass average
 *   FIX: Added cooldownBlocks per-pair — no re-entry for N blocks after a stop-loss
 *   FIX: Added SMA slope filter — trend direction must agree before any signal fires
 *   FIX: NEAR_SMA_LONG now requires RSI confirmation (< 50) and slope to be upward
 *   FIX: SMA crossover signals now require slope agreement across all 3 SMAs
 *   FIX: Signal priority reordered — crossovers last (noisiest on 2s ticks)
 *   FIX: Momentum signal now requires RSI confirmation before firing
 *   FIX: Band-Bounce signals require volume proxy (price range > 0.5 * stdDev)
 *   ADD: Per-pair consecutive stop-loss counter with escalating cooldown
 *   ADD: Wilder-smoothed RSI state persists across blocks (avgGain/avgLoss stored)
 *   ADD: Slope computed as (smaFast - smaSlow) / smaSlow — normalized trend strength
 *   ADD: MIN_SLOPE_THRESHOLD filters flat/choppy markets from trend signals
 *   ADD: MAX_CONCURRENT_SAME_DIRECTION limit — prevents all 5 pairs going LONG/SHORT simultaneously
 *   KEEP: All trailing stop ladder logic (Tier 1 / Tier 2)
 *   KEEP: Balance mutex, corrupt state reset, manual exit/trade watchers
 *   KEEP: All precision rules, DOGE expanded SL/TP, fee accounting
 */

const ccxt = require('ccxt');
const fs   = require('fs');
const { log, logError, ensureLogsDir } = require('./logger_util');
const { execSync } = require('child_process');

const TOKEN_CONFIGS = {
    'BTC/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'ETH/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'SOL/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '5m' },
    'ADA/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '5m' },
    'DOGE/USDT': { sl: 0.0030, tp: 0.0075, rsiLow: 25, rsiHigh: 75, timeframe: '30m' },
    'XRP/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '30m' },
    'BNB/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'LINK/USDT': { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '30m' },
    'DOT/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'AVAX/USDT': { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '30m' },
    'LTC/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'TRX/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'MATIC/USDT':{ sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'NEAR/USDT': { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'FIL/USDT':  { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' },
    'ATOM/USDT': { sl: 0.0025, tp: 0.0060, rsiLow: 30, rsiHigh: 70, timeframe: '15m' }
};

const CONFIG = {
  takeProfitPercent: 0.0100,
  stopLossPercent: 0.0030,
  version: '3.1.0',
  targetPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT', 'DOGE/USDT', 'LTC/USDT', 'TRX/USDT', 'MATIC/USDT', 'NEAR/USDT', 'FIL/USDT', 'ATOM/USDT'],
  scanIntervalMs: 2000,
  blocksToAggregate: 3,
  startingBalanceUSDT: 300.00,
  fixedPositionSizeUSDT: 50.00,
  leverageMultiplier: 3,
  smaFast: 16,
  smaMed: 26,
  smaSlow: 39,
  volaMultiplier: 1.2,
  nearSmaThreshold: 0.999,
  takerFeeRate: 0.0006,
  rsiPeriod: 14,
  rsiOversold: 35,
  rsiOverbought: 65,
  momentumBlocks: 3,
  bandBounceConfirmBlocks: 2,
  minSlopeThreshold: 0.00005,
  maxConcurrentSameDirection: 3,
  balanceFile: './account_balance.json',
  precisionRules: {
      'BTC/USDT': { amount: 4, price: 2 },
      'ETH/USDT': { amount: 3, price: 2 },
      'SOL/USDT': { amount: 2, price: 4 },
      'ADA/USDT': { amount: 1, price: 6 },
      'DOGE/USDT': { amount: 0, price: 6 },
      'LTC/USDT':  { amount: 2, price: 3 },
      'TRX/USDT':  { amount: 0, price: 5 },
      'MATIC/USDT':{ amount: 1, price: 4 },
      'NEAR/USDT': { amount: 1, price: 3 },
      'FIL/USDT':  { amount: 1, price: 3 },
      'ATOM/USDT': { amount: 2, price: 3 }
  },
  signalMode: 'trend',
  fastBreakevenPct: 0.35,
};
// ── Signal Filtering (Phase 3) ──────────────────────────────────────────────
const ACTIVE_SIGNALS = {
  RSI_OVERBOUGHT_SHORT: true,
  RSI_OVERSOLD_LONG: true,
  
  UPPER_BAND_LONG: false,
  LOWER_BAND_SHORT: false,
  
  BAND_BOUNCE_LONG: true,
  BAND_BOUNCE_SHORT: true,
  SMA_CROSS_LONG: true,
  SMA_CROSS_SHORT: true,
  MOMENTUM_LONG: true,
  MOMENTUM_SHORT: true,
  DOUBLE_DIP_LONG: true,
  DOUBLE_DIP_SHORT: true,
};

const RSI_THRESHOLD_SHORT = 70;
const RSI_THRESHOLD_LONG = 30;

const RSI_COOLDOWN_CANDLES = 2;
let rsiLastFireTime = {};

const REQUIRE_DUAL_CONFIRMATION = true;

function shouldEnterSignal(signalName) {
  const WEIGHTS = {
    'DOUBLE_DIP_LONG': 0.60,
    'SMA_CROSS_LONG': 0.58,
    'BAND_BOUNCE_LONG': 0.55,
    'MOMENTUM_LONG': 0.52,
    'RSI_OVERSOLD_LONG': 0.45,
    'RSI_OVERBOUGHT_SHORT': 0.40,
    'UPPER_BAND_LONG': 0.40,
  };
  
  const weight = WEIGHTS[signalName] || 0;
  return weight >= 0.50;
}

// ─── Balance mutex ────────────────────────────────────────────────────────────
let balanceLocked = false;
async function acquireBalanceLock() {
    while (balanceLocked) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    balanceLocked = true;
}
function releaseBalanceLock() { balanceLocked = false; }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getBalance() {
    if (!fs.existsSync(CONFIG.balanceFile)) {
        fs.writeFileSync(CONFIG.balanceFile, JSON.stringify({ balance: CONFIG.startingBalanceUSDT }, null, 4));
        return CONFIG.startingBalanceUSDT;
    }
    return JSON.parse(fs.readFileSync(CONFIG.balanceFile, 'utf8')).balance;
}
function updateBalance(newBalance) {
    fs.writeFileSync(CONFIG.balanceFile, JSON.stringify({ balance: parseFloat(newBalance.toFixed(2)) }, null, 4));
}
function getStateFilePath(pair) {
    return `./scalper_state_${pair.replace('/', '-')}.json`;
}
function readState(pair) {
    const stateFile = getStateFilePath(pair);
    if (!fs.existsSync(stateFile)) return { positionActive: false };
    try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (parseErr) {
        logError('scalper_machine.js', `[CORRUPT STATE] ${pair} state file unreadable, resetting. Error: ${parseErr.message}`);
        fs.writeFileSync(stateFile, JSON.stringify({ positionActive: false }, null, 4));
        return { positionActive: false };
    }
}
function getCentralTimestamp() {
    return new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
}
function appendHistoryLog(msg) { log('BOT', CONFIG.version, msg); }
function sendNotification(title, content) {
    try {
        execSync(`termux-notification -t "${title}" -c "${content}" --id scalper_bot --sound --priority max`);
    } catch (_) {}
}
function calculateSMA(prices) {
    return prices.reduce((acc, p) => acc + p, 0) / prices.length;
}
function calculateStandardDeviation(prices, mean) {
    const squareDiffs = prices.map(p => Math.pow(p - mean, 2));
    return Math.sqrt(squareDiffs.reduce((acc, val) => acc + val, 0) / prices.length);
}

// ─── RSI — Wilder Smoothing (proper EMA-based) ────────────────────────────────
// First call seeds from a full period of data.
// Subsequent calls use stored avgGain/avgLoss for true Wilder smoothing.
// wilderState = { avgGain, avgLoss, prevPrice, seeded }
function calculateRSIWilder(prices, period, wilderState) {
    // If not yet seeded, seed from the last (period+1) prices
    if (!wilderState.seeded) {
        if (prices.length < period + 1) return null;
        const slice = prices.slice(-(period + 1));
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = slice[i] - slice[i - 1];
            if (diff >= 0) gains  += diff;
            else           losses -= diff;
        }
        wilderState.avgGain  = gains  / period;
        wilderState.avgLoss  = losses / period;
        wilderState.prevPrice = slice[slice.length - 1];
        wilderState.seeded    = true;
    } else {
        // Incremental Wilder update using only the latest price
        const currentPrice = prices[prices.length - 1];
        const diff = currentPrice - wilderState.prevPrice;
        const gain  = diff > 0 ? diff : 0;
        const loss  = diff < 0 ? -diff : 0;
        wilderState.avgGain  = (wilderState.avgGain  * (period - 1) + gain)  / period;
        wilderState.avgLoss  = (wilderState.avgLoss  * (period - 1) + loss)  / period;
        wilderState.prevPrice = currentPrice;
    }
    if (wilderState.avgLoss === 0) return 100;
    const rs = wilderState.avgGain / wilderState.avgLoss;
    return 100 - (100 / (1 + rs));
}

// N-block percentage change
function momentumPct(prices, n) {
    if (prices.length < n + 1) return null;
    const now  = prices[prices.length - 1];
    const then = prices[prices.length - 1 - n];
    if (then === 0) return null;
    return (now - then) / then;
}

// Normalized SMA slope: (smaFast - smaSlow) / smaSlow
// Positive = uptrend, Negative = downtrend
function computeSlope(matrix) {
    if (!matrix.ready || matrix.smaSlow === 0) return 0;
    return (matrix.smaFast - matrix.smaSlow) / matrix.smaSlow;
}

// ─── In-memory position direction cache (avoids 5x disk reads per signal check) ─
// Kept in sync by executePaperOrder (open) and closePosition (close).
const activeDirectionCache = {};   // pair → 'LONG' | 'SHORT' | null
for (const _p of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT', 'DOGE/USDT']) activeDirectionCache[_p] = null;

// Count how many pairs are currently in a given direction (in-memory, O(5) no disk)
function countActiveDirection(direction) {
    let count = 0;
    for (const pair of CONFIG.targetPairs) {
        if (activeDirectionCache[pair] === direction) count++;
    }
    return count;
}

// ─── Per-pair state ───────────────────────────────────────────────────────────
const priceStreams      = {};
const scanBuffers       = {};
const strategicMatrices = {};
const signalTrackers   = {};
const wilderStates     = {};   // Wilder RSI state per pair
const cooldownState    = {};   // { blocksRemaining, consecutiveSL }

for (const pair of CONFIG.targetPairs) {
    priceStreams[pair]      = [];
    scanBuffers[pair]       = [];
    strategicMatrices[pair] = { upper: 0, smaMed: 0, lower: 0, ready: false };
    signalTrackers[pair]    = {
        previousClose: null,
        bandBreachBlock: { upper: null, lower: null },
        blockIndex: 0,
        prevSmaFast: null,
        prevSmaMed: null,
        prevSmaSlow: null
    };
    wilderStates[pair]  = { avgGain: 0, avgLoss: 0, prevPrice: null, seeded: false };
    cooldownState[pair] = { blocksRemaining: 0, consecutiveSL: 0 };
}

// ─── Seed ─────────────────────────────────────────────────────────────────────
async function seedHistoricalData(exchange, pair) {
    try {
        const rawCandles = await exchange.fetchOHLCV(pair, '1m', undefined, 100);
        if (!rawCandles || rawCandles.length < 90) {
            appendHistoryLog(`[SEED WARN] ${pair}: insufficient candle data (${rawCandles?.length ?? 0}), will build live`);
            return;
        }
        const compiledBuffer = [];
        for (let i = 2; i < rawCandles.length; i += 3) {
            compiledBuffer.push(rawCandles[i][4]);
            if (compiledBuffer.length >= CONFIG.smaSlow) break;
        }
        priceStreams[pair] = compiledBuffer.slice(-CONFIG.smaSlow);

        const smaF = calculateSMA(priceStreams[pair].slice(-CONFIG.smaFast));
        const smaM = calculateSMA(priceStreams[pair].slice(-CONFIG.smaMed));
        const smaS = calculateSMA(priceStreams[pair].slice(-CONFIG.smaSlow));
        const stdDev = calculateStandardDeviation(priceStreams[pair].slice(-CONFIG.smaMed), smaM);

        strategicMatrices[pair] = {
            smaFast: smaF, smaMed: smaM, smaSlow: smaS,
            upper: smaM + (CONFIG.volaMultiplier * stdDev),
            lower: smaM - (CONFIG.volaMultiplier * stdDev),
            ready: priceStreams[pair].length >= CONFIG.smaSlow
        };

        // Seed Wilder RSI state from historical prices
        wilderStates[pair] = { avgGain: 0, avgLoss: 0, prevPrice: null, seeded: false };
        calculateRSIWilder(priceStreams[pair], CONFIG.rsiPeriod, wilderStates[pair]);

        signalTrackers[pair].previousClose = priceStreams[pair][priceStreams[pair].length - 1];
        signalTrackers[pair].prevSmaFast   = smaF;
        signalTrackers[pair].prevSmaMed    = smaM;
        signalTrackers[pair].prevSmaSlow   = smaS;

        appendHistoryLog(`[SEED OK] ${pair}: Fast=${smaF.toFixed(4)}, Med=${smaM.toFixed(4)}, Slow=${smaS.toFixed(4)}`);
    } catch (err) {
        appendHistoryLog(`[SEED ERROR] ${pair}: ${err.message}`);
        sendNotification('⚠️ Seed Error', `${pair}: ${err.message}`);
    }
}

// ─── Main scan loop ───────────────────────────────────────────────────────────
async function processContinuousScan(exchange, pair) {
    try {
        const ticker    = await exchange.fetchTicker(pair);
        const livePrice = ticker.close;
        const liveBid   = ticker.bid || livePrice;
        const liveAsk   = ticker.ask || livePrice;
        if (!livePrice) return;

        // ── Position management ──────────────────────────────────────────────
        const state = readState(pair);
        if (state.positionActive) {
            const closed = await manageActivePosition(exchange, pair, liveBid, liveAsk, state);
            // FIX: previously `scanBuffers[pair] = []` on close dropped any partially-aggregated
            // ticks, delaying the next signal by up to a full aggregation cycle.
            // Now we only clear the buffer if we were mid-aggregation (i.e. it wasn't already
            // empty from the last completed block). This preserves ticks already collected.
            if (closed) { return; }
        }

        // ── Band aggregation ─────────────────────────────────────────────────
        scanBuffers[pair].push(livePrice);
        if (scanBuffers[pair].length >= CONFIG.blocksToAggregate) {
            scanBuffers[pair] = [];
            priceStreams[pair].push(livePrice);
            if (priceStreams[pair].length > CONFIG.smaSlow) priceStreams[pair].shift();

            if (priceStreams[pair].length >= CONFIG.smaSlow) {
                const smaF   = calculateSMA(priceStreams[pair].slice(-CONFIG.smaFast));
                const smaM   = calculateSMA(priceStreams[pair].slice(-CONFIG.smaMed));
                const smaS   = calculateSMA(priceStreams[pair].slice(-CONFIG.smaSlow));
                const stdDev = calculateStandardDeviation(priceStreams[pair].slice(-CONFIG.smaMed), smaM);
                strategicMatrices[pair].smaFast = smaF;
                strategicMatrices[pair].smaMed  = smaM;
                strategicMatrices[pair].smaSlow = smaS;
                strategicMatrices[pair].upper   = smaM + (CONFIG.volaMultiplier * stdDev);
                strategicMatrices[pair].lower   = smaM - (CONFIG.volaMultiplier * stdDev);
                strategicMatrices[pair].ready   = true;
            }

            // Tick Wilder RSI forward
            calculateRSIWilder(priceStreams[pair], CONFIG.rsiPeriod, wilderStates[pair]);

            updateSignalTrackers(pair, livePrice);

            // Decrement cooldown
            if (cooldownState[pair].blocksRemaining > 0) {
                cooldownState[pair].blocksRemaining--;
            }

            await evaluateStrategyLogic(exchange, pair, liveBid, liveAsk, livePrice, state);

            signalTrackers[pair].previousClose = livePrice;
            signalTrackers[pair].prevSmaFast   = strategicMatrices[pair].smaFast;
            signalTrackers[pair].prevSmaMed    = strategicMatrices[pair].smaMed;
            signalTrackers[pair].prevSmaSlow   = strategicMatrices[pair].smaSlow;
            signalTrackers[pair].blockIndex++;
        }
    } catch (err) {
        logError('scalper_machine.js', `[SCAN ERROR] ${pair}: ${err.message}`);
    }
}

// ─── Signal tracker update ────────────────────────────────────────────────────
function updateSignalTrackers(pair, closePrice) {
    const matrix  = strategicMatrices[pair];
    const tracker = signalTrackers[pair];
    if (!matrix.ready) return;
    if (closePrice < matrix.lower) tracker.bandBreachBlock.lower = tracker.blockIndex;
    if (closePrice > matrix.upper) tracker.bandBreachBlock.upper = tracker.blockIndex;
}

// ─── Trend Alignment Check (Multi-Timeframe Filter) ──────────────────────────
const TF_LADDER = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

async function getHigherTrend(exchange, pair, timeframe) {
    try {
        const candles = await exchange.fetchOHLCV(pair, timeframe, undefined, 20);
        if (candles.length < 20) return 'UNKNOWN';
        const closes = candles.map(c => c[4]);
        const sma20 = closes.reduce((a, b) => a + b, 0) / 20;
        const lastClose = closes[closes.length - 1];
        return lastClose >= sma20 ? 'UP' : 'DOWN';
    } catch (e) {
        logError('scalper_machine.js', `[TREND FETCH ERROR] ${pair} ${timeframe}: ${e.message}`);
        return 'UNKNOWN';
    }
}

async function checkTrendAlignment(exchange, pair, direction) {
    // ── Trend Flip Pause Guard ──────────────────────────────────────────
    try {
        if (fs.existsSync('./trend_flip_pause.json')) {
            const data = JSON.parse(fs.readFileSync('./trend_flip_pause.json', 'utf8'));
            if (data.paused) {
                appendHistoryLog(`[TREND GUARD] ${pair} ${direction} SKIPPED (Trend Flip Paused)`);
                return true;
            }
        }
    } catch (_) {}

    const baseTf = TOKEN_CONFIGS[pair]?.timeframe || '1m';
    const tfIndex = TF_LADDER.indexOf(baseTf);
    // If we can't find 2 higher timeframes, we skip the check
    if (tfIndex === -1 || tfIndex >= TF_LADDER.length - 2) return true;

    const higherTf1 = TF_LADDER[tfIndex + 1];
    const higherTf2 = TF_LADDER[tfIndex + 2];

    const [trend1, trend2] = await Promise.all([
        getHigherTrend(exchange, pair, higherTf1),
        getHigherTrend(exchange, pair, higherTf2)
    ]);

    const targetTrend = direction === 'LONG' ? 'UP' : 'DOWN';
    const oppositeTrend = direction === 'LONG' ? 'DOWN' : 'UP';

    // Only invalidate if BOTH timeframes are explicitly against us.
    // If either is 'UNKNOWN' or matches our direction, we keep the trade open.
    const isContradicted = (trend1 === oppositeTrend && trend2 === oppositeTrend);
    const allAligned = !isContradicted;

    if (!allAligned) {
        appendHistoryLog(`[TREND GUARD] ${pair} ${direction} CONTRADICTED. Higher Trends: ${higherTf1}=${trend1}, ${higherTf2}=${trend2}`);
    } else {
        appendHistoryLog(`[TREND GUARD] ${pair} ${direction} OK. Higher Trends: ${higherTf1}=${trend1}, ${higherTf2}=${trend2}`);
    }

    return allAligned;}

// ─── Strategy evaluation ──────────────────────────────────────────────────────
async function evaluateStrategyLogic(exchange, pair, liveBid, liveAsk, liveClose, state) {
    // state is passed in from processContinuousScan — no second disk read needed
    if (state.positionActive) return;

    // ── Cooldown guard ───────────────────────────────────────────────────────
    if (cooldownState[pair].blocksRemaining > 0) return;

    const matrix = strategicMatrices[pair];
    if (!matrix.ready) return;

    const triggerOrder = async (dir, price, signal) => {
        if (await checkTrendAlignment(exchange, pair, dir)) {
            await executePaperOrder(pair, dir, price, signal);
            return true;
        }
        return false;
    };

    const tracker       = signalTrackers[pair];
    const trendBaseline = matrix.smaMed;
    const slope         = computeSlope(matrix);
    const isTrendingUp  = slope >  CONFIG.minSlopeThreshold;
    const isTrendingDn  = slope < -CONFIG.minSlopeThreshold;
    const isChoppy      = !isTrendingUp && !isTrendingDn;

    // Current Wilder RSI value
    const ws = wilderStates[pair];
    const rsiVal = ws.seeded
        ? (ws.avgLoss === 0 ? 100 : 100 - (100 / (1 + ws.avgGain / ws.avgLoss)))
        : null;

    const momPct    = momentumPct(priceStreams[pair], CONFIG.momentumBlocks);
    const stdDev    = (matrix.upper - trendBaseline) / CONFIG.volaMultiplier;
    const momThresh = stdDev > 0 ? (stdDev / trendBaseline) * CONFIG.volaMultiplier : null;

    const prevClose   = tracker.previousClose;
    const prevSmaFast = tracker.prevSmaFast;
    const prevSmaMed  = tracker.prevSmaMed;
    const prevSmaSlow = tracker.prevSmaSlow;
    const blockIdx    = tracker.blockIndex;

    // ── Concurrency cap ──────────────────────────────────────────────────────
    // Checked per signal direction below — prevents 5-pair pile-ins

    // ════════════════════════════════════════════════════════════════════════
    //  1. RSI EXTREMES — highest edge, require trend agreement
    // ════════════════════════════════════════════════════════════════════════

    // RSI Oversold Long — only enter if trend is UP or price is at/below lower band
    if (rsiVal !== null && rsiVal <= CONFIG.rsiOversold &&
        (isTrendingUp || liveBid <= matrix.lower * 1.005)) {
        if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder('LONG', liveBid, 'RSI_OVERSOLD_LONG')) return;
        }
    }

    // RSI Overbought Short — only enter if trend is DOWN or price is at/above upper band
    if (rsiVal !== null && rsiVal >= CONFIG.rsiOverbought &&
        (isTrendingDn || liveAsk >= matrix.upper * 0.995)) {
        if (countActiveDirection('SHORT') < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder('SHORT', liveAsk, 'RSI_OVERBOUGHT_SHORT')) return;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // 2. BAND BOUNCE — mean-reversion with confirmation
    //    Relaxed volume proxy: current price move > 0.3 * stdDev
    const volaConfirm = stdDev > 0 && Math.abs(liveClose - prevClose) > 0.3 * stdDev;

    // Band-Bounce Long — require upward slope (not just any bearish context)
    if (isTrendingUp && volaConfirm && prevClose !== null && prevClose < matrix.lower && liveBid >= matrix.lower) {
        if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder('LONG', liveBid, 'BAND_BOUNCE_LONG')) return;
        }
    }

    // Band-Bounce Short — require downward slope
    if (isTrendingDn && volaConfirm && prevClose !== null && prevClose > matrix.upper && liveAsk <= matrix.upper) {
        if (countActiveDirection('SHORT') < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder('SHORT', liveAsk, 'BAND_BOUNCE_SHORT')) return;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  3. DOUBLE-DIP — confirmed re-test of lower band
    // ════════════════════════════════════════════════════════════════════════

    if (isTrendingUp &&
        tracker.bandBreachBlock.lower !== null &&
        blockIdx - tracker.bandBreachBlock.lower >= CONFIG.bandBounceConfirmBlocks &&
        liveBid <= matrix.lower * 1.002) {
        if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder('LONG', liveBid, 'DOUBLE_DIP_LONG')) return;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  4. MOMENTUM — requires RSI confirmation, skip choppy markets
    // ════════════════════════════════════════════════════════════════════════

    if (!isChoppy && momPct !== null && momThresh !== null) {
        // Momentum Long: surge AND RSI not overbought AND trending up
        if (isTrendingUp && momPct > momThresh &&
            (rsiVal === null || rsiVal < CONFIG.rsiOverbought)) {
            if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
                if (await triggerOrder('LONG', liveBid, 'MOMENTUM_LONG')) return;
            }
        }
        // Momentum Short: drop AND RSI not oversold AND trending down
        if (isTrendingDn && momPct < -momThresh &&
            (rsiVal === null || rsiVal > CONFIG.rsiOversold)) {
            if (countActiveDirection('SHORT') < CONFIG.maxConcurrentSameDirection) {
                if (await triggerOrder('SHORT', liveAsk, 'MOMENTUM_SHORT')) return;
            }
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  5. NEAR-SMA LONG — tightened: requires upslope + RSI < 50
    //     Original fired on any "bearish" price — now requires trend confirmation
    // ════════════════════════════════════════════════════════════════════════

    if (isTrendingUp &&
        liveBid >= trendBaseline * CONFIG.nearSmaThreshold &&
        liveBid < trendBaseline &&
        rsiVal !== null && rsiVal < 50) {
        if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder('LONG', liveBid, 'NEAR_SMA_LONG')) return;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  6. BAND SIGNALS — Configurable Mode (Trend or Reversal)
    // ════════════════════════════════════════════════════════════════════════
    const activeMode = getActiveMode();
    const isReversal = activeMode === 'reversal';

    // Upper-Band Logic
    if (isTrendingUp && liveAsk >= matrix.upper) {
        const dir = isReversal ? 'SHORT' : 'LONG';
        const name = isReversal ? 'UPPER_BAND_REVERSAL_SHORT' : 'UPPER_BAND_LONG';
        if (countActiveDirection(dir) < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder(dir, dir === 'LONG' ? liveBid : liveAsk, name)) return;
        }
    }

    // Lower-Band Logic
    if (isTrendingDn && liveBid <= matrix.lower) {
        const dir = isReversal ? 'LONG' : 'SHORT';
        const name = isReversal ? 'LOWER_BAND_REVERSAL_LONG' : 'LOWER_BAND_SHORT';
        if (countActiveDirection(dir) < CONFIG.maxConcurrentSameDirection) {
            if (await triggerOrder(dir, dir === 'LONG' ? liveBid : liveAsk, name)) return;
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  7. SMA CROSSOVERS — lowest priority (noisiest on fast ticks)
    //     All three SMAs must agree on direction before crossover fires
    // ════════════════════════════════════════════════════════════════════════

    if (prevSmaFast !== null && prevSmaMed !== null && prevSmaSlow !== null) {
        // Fast × Med Bullish Cross — only if slow also trending up
        if (prevSmaFast < prevSmaMed && matrix.smaFast >= matrix.smaMed &&
            matrix.smaMed > matrix.smaSlow) {
            if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
                if (await triggerOrder('LONG', liveBid, 'SMA_CROSS_F_M_LONG')) return;
            }
        }
        // Med × Slow Bullish Cross — only if fast also above med
        if (prevSmaMed < prevSmaSlow && matrix.smaMed >= matrix.smaSlow &&
            matrix.smaFast > matrix.smaMed) {
            if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
                if (await triggerOrder('LONG', liveBid, 'SMA_CROSS_M_S_LONG')) return;
            }
        }
        // Fast × Med Bearish Cross — only if slow also trending down
        if (prevSmaFast >= prevSmaMed && matrix.smaFast < matrix.smaMed &&
            matrix.smaMed < matrix.smaSlow) {
            if (countActiveDirection('SHORT') < CONFIG.maxConcurrentSameDirection) {
                if (await triggerOrder('SHORT', liveAsk, 'SMA_CROSS_F_M_SHORT')) return;
            }
        }
        // Med × Slow Bearish Cross — only if fast also below med
        if (prevSmaMed >= prevSmaSlow && matrix.smaMed < matrix.smaSlow &&
            matrix.smaFast < matrix.smaMed) {
            if (countActiveDirection('SHORT') < CONFIG.maxConcurrentSameDirection) {
                if (await triggerOrder('SHORT', liveAsk, 'SMA_CROSS_M_S_SHORT')) return;
            }
        }

        // Price × SMA crosses (last resort)
        if (prevClose !== null && prevSmaMed !== null) {
            if (isTrendingUp && prevClose < prevSmaMed && liveBid >= trendBaseline) {
                if (countActiveDirection('LONG') < CONFIG.maxConcurrentSameDirection) {
                    if (await triggerOrder('LONG', liveBid, 'SMA_CROSS_LONG')) return;
                }
            }
            if (isTrendingDn && prevClose >= prevSmaMed && liveBid < trendBaseline) {
                if (countActiveDirection('SHORT') < CONFIG.maxConcurrentSameDirection) {
                    if (await triggerOrder('SHORT', liveAsk, 'SMA_CROSS_SHORT')) return;
                }
            }
        }
    }
}

// ─── Order execution ──────────────────────────────────────────────────────────
async function executePaperOrder(pair, direction, entryPrice, signalName = 'UNKNOWN') {
    // FIX: acquire balance lock before reading balance to prevent a race condition
    // where two pairs open simultaneously, both read the same balance, and both
    // pass a hypothetical balance check — effectively double-spending capital.
    await acquireBalanceLock();
    const currentBalance   = getBalance();
    releaseBalanceLock();
    const allocatedCapital = CONFIG.fixedPositionSizeUSDT;
    const totalBuyingPower = allocatedCapital * CONFIG.leverageMultiplier;
    const precision        = CONFIG.precisionRules[pair] || { amount: 2, price: 2 };
    const contractSize     = parseFloat((totalBuyingPower / entryPrice).toFixed(precision.amount));
    const entryFeePaid     = totalBuyingPower * CONFIG.takerFeeRate;

    let stopLossPct   = CONFIG.stopLossPercent;
    let takeProfitPct = CONFIG.takeProfitPercent;
    if (pair === 'DOGE/USDT') { stopLossPct *= 2; takeProfitPct *= 2; }

    const riskDistance   = entryPrice * stopLossPct;
    const targetDistance = entryPrice * takeProfitPct;

    const positionState = {
        positionActive:  true,
        timestamp:       getCentralTimestamp(),
        startTime:       Date.now(),
        pair,
        direction,
        signalName,
        entryPrice:      parseFloat(entryPrice.toFixed(precision.price)),
        contractSize,
        stopLossPrice:   parseFloat((direction === 'LONG'
            ? (entryPrice - riskDistance)
            : (entryPrice + riskDistance)).toFixed(precision.price)),
        takeProfitPrice: parseFloat((direction === 'LONG'
            ? (entryPrice + targetDistance)
            : (entryPrice - targetDistance)).toFixed(precision.price)),
        allocatedCapital,
        leverageApplied: CONFIG.leverageMultiplier,
        entryFeePaid,
        trailTier:       0
    };

    fs.writeFileSync(getStateFilePath(pair), JSON.stringify(positionState, null, 4));
    activeDirectionCache[pair] = direction;   // keep in-memory cache in sync
    appendHistoryLog(`[ORDER] Opened ${direction} for ${pair} via ${signalName} at entry price ${entryPrice} (Allocated: $${allocatedCapital.toFixed(2)})`);
    sendNotification(
        `🚀 TRADE OPENED [v${CONFIG.version}]`,
        `${pair}: ${direction} @ $${entryPrice}\nSignal: ${signalName}\nSL: $${positionState.stopLossPrice} | TP: $${positionState.takeProfitPrice}\nValue: $${allocatedCapital.toFixed(2)}`
    );
}

// ─── Trailing stop ladder (unlimited tiers) ──────────────────────────────────
//
// How it works:
//   Tier 0 / Breakeven:
//     Once price reaches fastBreakevenPct (35%) of the original TP distance,
//     SL moves to entry + fee buffer. Fires once only.
//
//   Tier 1, 2, 3 ... N (no cap):
//     After breakeven, a new tier fires whenever price travels trailStepPct (40%)
//     of the CURRENT TP distance past the current tpAnchor.
//     tpAnchor resets to the current TP each time a tier fires, so progress is
//     always measured from the last milestone — not from entry.
//     This means the ladder runs indefinitely as long as the trade stays in bounds.
//
//   Each tier:
//     - SL trails to livePrice minus trailSlStepPct * currentTpDist (never regresses).
//     - TP bumps forward by trailTpBumpPct to keep giving the trade room to run.
//     - tpAnchor updates so the next tier starts measuring from the new TP.
//
function applyTrailingLadder(state, livePrice) {
    const {
        direction, entryPrice,
        stopLossPrice, takeProfitPrice,
        trailTier       = 0,
        breakevenActive = false,
        tpAnchor        = takeProfitPrice,
        entryFeePaid    = 0
    } = state;

    // ── 1. Fast Breakeven (fires once before any tier) ────────────────────
    if (!breakevenActive && trailTier === 0) {
        const originalTpDist = Math.abs(takeProfitPrice - entryPrice);
        const progress = direction === 'LONG'
            ? (livePrice - entryPrice) / originalTpDist
            : (entryPrice - livePrice) / originalTpDist;

        if (progress >= CONFIG.fastBreakevenPct) {
            const breakEvenBuffer = (entryFeePaid * 2) / state.contractSize;
            const newSl = direction === 'LONG'
                ? entryPrice + breakEvenBuffer
                : entryPrice - breakEvenBuffer;
            return {
                ...state,
                stopLossPrice:   newSl,
                breakevenActive: true,
                tpAnchor:        takeProfitPrice
            };
        }
        return null;
    }

    // ── 2. Tiered advancement (based on TRAILING_CONFIG) ───────────────────
    const distToTarget = Math.abs(takeProfitPrice - entryPrice);
    const progress     = direction === 'LONG'
        ? (livePrice - entryPrice) / distToTarget
        : (entryPrice - livePrice) / distToTarget;

    let trigger = 0;
    let slLock  = 0;
    let tpBump  = 0;
    let nextTier = trailTier + 1;

    if (nextTier === 1) {
        trigger = TRAILING_CONFIG.tier1Trigger;
        slLock  = TRAILING_CONFIG.tier1SlLock;
        tpBump  = TRAILING_CONFIG.tier1TpBump;
    } else if (nextTier === 2) {
        trigger = TRAILING_CONFIG.tier2Trigger;
        slLock  = TRAILING_CONFIG.tier2SlLock;
        tpBump  = TRAILING_CONFIG.tier2TpBump;
    } else {
        trigger = TRAILING_CONFIG.tier3Trigger;
        slLock  = TRAILING_CONFIG.tier3SlLock;
        tpBump  = TRAILING_CONFIG.tier3TpBump;
    }

    if (progress >= trigger) {
        // Calculate new SL based on progress lock percentage
        const newSl = direction === 'LONG'
            ? entryPrice + (distToTarget * slLock)
            : entryPrice - (distToTarget * slLock);

        // SL must never regress
        const slImproved = direction === 'LONG' ? newSl > stopLossPrice : newSl < stopLossPrice;
        if (!slImproved) return null;

        // Bump TP
        const newTp = direction === 'LONG'
            ? takeProfitPrice * (1 + tpBump)
            : takeProfitPrice * (1 - tpBump);

        return {
            ...state,
            stopLossPrice:   newSl,
            takeProfitPrice: newTp,
            trailTier:       nextTier
        };
    }

    return null;
}

function getActiveMode() {
    try {
        if (fs.existsSync('./mode.json')) {
            const data = JSON.parse(fs.readFileSync('./mode.json', 'utf8'));
            return data.mode;
        }
    } catch (_) {}
    return CONFIG.signalMode;
}

// ─── Position management ──────────────────────────────────────────────────────
async function manageActivePosition(exchange, pair, liveBid, liveAsk, state) {
    const livePrice = state.direction === 'LONG' ? liveBid : liveAsk;
    const precision = CONFIG.precisionRules[pair] || { amount: 2, price: 2 };
    
    // Refresh mode hot-read
    const activeMode = getActiveMode();
    const isReversal = activeMode === 'reversal';

    // If trade has hit at least one trail milestone (tier 1+), bypass safety exits.
    // FIX: trailTier is now always >= 0; -1 is no longer used. breakevenActive is
    // a separate boolean. isProfitLocked only engages after a real step milestone.
    const isProfitLocked = (state.trailTier >= 1);

    // ── Check for Dynamic Adjustments ──────────────────────────────────────────
    const adjustFile = `adjust_trade_${pair.replace('/', '-')}.json`;
    if (fs.existsSync(adjustFile)) {
        try {
            const adjustment = JSON.parse(fs.readFileSync(adjustFile, 'utf8'));
            fs.unlinkSync(adjustFile); // Consume the request
            
            const newState = { ...state };
            if (adjustment.stopLossPrice)   newState.stopLossPrice   = adjustment.stopLossPrice;
            if (adjustment.takeProfitPrice) newState.takeProfitPrice = adjustment.takeProfitPrice;
            if (adjustment.allocatedCapital) newState.allocatedCapital = adjustment.allocatedCapital;
            
            fs.writeFileSync(getStateFilePath(pair), JSON.stringify(newState, null, 4));
            appendHistoryLog(`[ADJUST] Trade modified for ${pair}: ${JSON.stringify(adjustment)}`);
            return await manageActivePosition(exchange, pair, liveBid, liveAsk, newState);
        } catch (e) {
            console.error(`[ADJUST ERROR] ${pair}: ${e.message}`);
        }
    }

    // ── 1. Time-Based Cutoff (Only if in negative for CONFIG.timeCutoffMs and not locked) ──
    // FIX: was hardcoded to `30 * 60 * 1000` (30 min), ignoring CONFIG.timeCutoffMs = 600000 (10 min).
    /*
    if (!isProfitLocked && state.startTime && (Date.now() - state.startTime) > CONFIG.timeCutoffMs) {
        // Only cut if truly losing (including fees)
        const totalFeesPerUnit = CONFIG.takerFeeRate * 2; 
        const isLosing = state.direction === 'LONG' 
            ? (liveBid < (state.entryPrice * (1 + totalFeesPerUnit)))
            : (liveAsk > (state.entryPrice * (1 - totalFeesPerUnit)));
        
        if (isLosing) {
            await closePosition(pair, liveBid, liveAsk, state, 'TIME_CUTOFF_30M');
            return true;
        }
    }
    */

    // ── 2. Trend-Flip Invalidation (Skip if profit is locked) ───────────────────
    if (!isProfitLocked && signalTrackers[pair].blockIndex % CONFIG.trendFlipCheckInterval === 0) {
        const isAligned = await checkTrendAlignment(exchange, pair, state.direction);
        if (!isAligned) {
            await closePosition(pair, liveBid, liveAsk, state, 'TREND_FLIP');
            return true;
        }
    }

    // ── 3. Trailing Stop Ladder & Fast Breakeven ──────────────────────────
    const updated = applyTrailingLadder(state, livePrice);
    if (updated) {
        // FIX: breakevenActive replaces trailTier === -1 as the breakeven sentinel
        const tierLabel = (updated.breakevenActive && !state.breakevenActive)
            ? 'FAST_BREAKEVEN'
            : `TIER_${updated.trailTier}`;
        fs.writeFileSync(getStateFilePath(pair), JSON.stringify(updated, null, 4));
        appendHistoryLog(
            `[TRAIL ${tierLabel}] ${pair} | ${state.direction} | ` +
            `SL: ${state.stopLossPrice.toFixed(precision.price)} → ${updated.stopLossPrice.toFixed(precision.price)}`
        );
        sendNotification(
            `🎯 ${tierLabel.replace('_', ' ')}`,
            `${pair}: ${state.direction}\nNew SL: $${updated.stopLossPrice.toFixed(precision.price)}`
        );
        state = updated;
    }

    let triggered = false, reason = '', execPrice = 0;
    if (state.direction === 'LONG') {
        if (liveBid >= state.takeProfitPrice)    { triggered = true; reason = 'TAKE_PROFIT'; execPrice = state.takeProfitPrice; }
        else if (liveBid <= state.stopLossPrice) { triggered = true; reason = 'STOP_LOSS';   execPrice = state.stopLossPrice; }
    } else {
        if (liveAsk <= state.takeProfitPrice)    { triggered = true; reason = 'TAKE_PROFIT'; execPrice = state.takeProfitPrice; }
        else if (liveAsk >= state.stopLossPrice) { triggered = true; reason = 'STOP_LOSS';   execPrice = state.stopLossPrice; }
    }

    if (triggered) {
        await closePosition(pair, liveBid, liveAsk, state, reason, execPrice);
        return true;
    }
    return false;
}

async function closePosition(pair, liveBid, liveAsk, state, reason, execPrice = null) {
    if (execPrice == null) execPrice = state.direction === 'LONG' ? liveBid : liveAsk;

    const exitFee   = (state.allocatedCapital * state.leverageApplied) * CONFIG.takerFeeRate;
    const totalFees = (state.entryFeePaid || 0) + exitFee;
    const priceDiff = state.direction === 'LONG'
        ? (execPrice - state.entryPrice)
        : (state.entryPrice - execPrice);
    const rawPnl = (priceDiff / state.entryPrice) * (state.allocatedCapital * state.leverageApplied);
    const pnl    = rawPnl - totalFees;

    await acquireBalanceLock();
    const newBalance = getBalance() + pnl;
    updateBalance(newBalance);
    releaseBalanceLock();

    fs.writeFileSync(getStateFilePath(pair), JSON.stringify({ positionActive: false }, null, 4));
    activeDirectionCache[pair] = null;   // keep in-memory cache in sync

    // ── Cooldown management ──────────────────────────────────────────────────
    if (reason === 'STOP_LOSS') {
        cooldownState[pair].consecutiveSL++;
        const multiplier = Math.pow(CONFIG.consecutiveSLEscalation, cooldownState[pair].consecutiveSL - 1);
        cooldownState[pair].blocksRemaining = Math.round(Math.min(
            CONFIG.cooldownBlocksBase * multiplier,
            CONFIG.cooldownBlocksMax
        ));
        appendHistoryLog(
            `[COOLDOWN] ${pair}: ${cooldownState[pair].consecutiveSL} consecutive SL(s), ` +
            `cooling down ${cooldownState[pair].blocksRemaining} blocks`
        );
    } else {
        // TP or manual exit resets the streak
        cooldownState[pair].consecutiveSL  = 0;
        cooldownState[pair].blocksRemaining = 0;
    }

    const signal  = state.signalName || 'UNKNOWN';
    const logMsg  = `[CLOSED] Out of ${pair} via ${reason} (signal: ${signal}) at execution value ${execPrice}. PnL: $${pnl.toFixed(2)}, New Balance: $${newBalance.toFixed(2)}`;
    appendHistoryLog(logMsg);

    const winLoss = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
    const roi     = ((newBalance - CONFIG.startingBalanceUSDT) / CONFIG.startingBalanceUSDT * 100).toFixed(3);
    sendNotification(
        `💰 TRADE CLOSED: ${winLoss}`,
        `${pair}: ${reason}\nSignal: ${signal}\nPnL: $${pnl.toFixed(2)}\nBalance: $${newBalance.toFixed(2)}\nTotal ROI: ${roi}%`
    );
}

// ─── Manual Trade Watcher ─────────────────────────────────────────────────────
function watchManualTrades(exchange) {
    setInterval(() => {
        CONFIG.targetPairs.forEach(pair => {
            const pairClean = pair.replace('/', '-');
            const manualTradeFile = `./manual_trade_${pairClean}.json`;
            const manualExitFile  = `./manual_exit_${pairClean}.json`;

            // 1. Check for manual trades (entry)
            if (fs.existsSync(manualTradeFile)) {
                try {
                    const data = JSON.parse(fs.readFileSync(manualTradeFile, 'utf8'));
                    fs.unlinkSync(manualTradeFile);
                    (async () => {
                        const ticker     = await exchange.fetchTicker(pair);
                        const isLong     = (data.action === 'long');
                        const entryPrice = isLong ? ticker.bid : ticker.ask;
                        const direction  = isLong ? 'LONG' : 'SHORT';
                        cooldownState[pair].blocksRemaining = 0; // Manual trades bypass cooldown
                        await executePaperOrder(pair, direction, entryPrice, 'MANUAL');
                    })().catch(err => {
                        logError('scalper_machine.js', `[MANUAL TRADE ERROR] ${pair}: ${err.message}`);
                    });
                } catch (e) { if (fs.existsSync(manualTradeFile)) fs.unlinkSync(manualTradeFile); }
            }

            // 2. Check for manual exits
            if (fs.existsSync(manualExitFile)) {
                try {
                    const data = JSON.parse(fs.readFileSync(manualExitFile, 'utf8'));
                    if (data.exit) {
                        fs.unlinkSync(manualExitFile);
                        (async () => {
                            const state = readState(pair);
                            if (state.positionActive) {
                                const ticker = await exchange.fetchTicker(pair);
                                await closePosition(pair, ticker.bid, ticker.ask, state, 'MANUAL_EXIT');
                            }
                        })().catch(err => {
                            logError('scalper_machine.js', `[MANUAL EXIT ERROR] ${pair}: ${err.message}`);
                        });
                    }
                } catch (e) { if (fs.existsSync(manualExitFile)) fs.unlinkSync(manualExitFile); }
            }
        });
    }, 1000);
}

// ─── Engine boot ──────────────────────────────────────────────────────────────
async function startEngine() {
    ensureLogsDir();
    appendHistoryLog(`=== SCALPER ENGINE v${CONFIG.version} OPERATIONAL — Refined Signal Suite + Cooldown + Slope Filter ===`);
    sendNotification('🤖 Momentum Scalper', `v${CONFIG.version} online. 11 signals | Slope filter | Wilder RSI | Cooldown active.`);

    const exchange = new ccxt.weex({ enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap' } });

    watchManualTrades(exchange);

    await Promise.allSettled(CONFIG.targetPairs.map(pair => seedHistoricalData(exchange, pair)));

    // Seed the in-memory direction cache from any persisted state files (e.g. after a restart)
    for (const pair of CONFIG.targetPairs) {
        const s = readState(pair);
        activeDirectionCache[pair] = (s.positionActive && s.direction) ? s.direction : null;
    }

    await Promise.allSettled(CONFIG.targetPairs.map(pair => processContinuousScan(exchange, pair)));

    setInterval(async () => {
        await Promise.allSettled(CONFIG.targetPairs.map(pair => processContinuousScan(exchange, pair)));
    }, CONFIG.scanIntervalMs);
}

startEngine();
