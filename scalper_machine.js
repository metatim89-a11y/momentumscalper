/**
 * File: scalper_machine.js
 * Version: 2.7.1
 * Description: Core Multi-Asset Volatility Strategy Engine (Execution Only)
 * Mandate: Zero Placeholders, Full Functional Implementation, Keep It Simple
 */

const ccxt = require('ccxt');
const fs = require('fs');
const { log, logError, ensureLogsDir } = require('./logger_util');
const { execSync } = require('child_process');

const CONFIG = {
    version: '2.7.1',
    targetPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    scanIntervalMs: 60000,
    blocksToAggregate: 3,
    startingBalanceUSDT: 1000.00,
    riskPercentPerTrade: 0.10,
    leverageMultiplier: 3,
    smaWindowSize: 30,
    volaMultiplier: 2.0,
    stopLossPercent: 0.0035,
    takeProfitPercent: 0.0075,
    takerFeeRate: 0.0006,
    logFile: './scalper_history.log',
    balanceFile: './account_balance.json',
    precisionRules: {
        'BTC/USDT': { amount: 4, price: 2 },
        'ETH/USDT': { amount: 3, price: 2 },
        'SOL/USDT': { amount: 2, price: 4 }
    }
};

function getBalance() {
    if (!fs.existsSync(CONFIG.balanceFile)) {
        fs.writeFileSync(CONFIG.balanceFile, JSON.stringify({ balance: CONFIG.startingBalanceUSDT }, null, 4));
        return CONFIG.startingBalanceUSDT;
    }
    const data = JSON.parse(fs.readFileSync(CONFIG.balanceFile, 'utf8'));
    return data.balance;
}

function updateBalance(newBalance) {
    fs.writeFileSync(CONFIG.balanceFile, JSON.stringify({ balance: parseFloat(newBalance.toFixed(2)) }, null, 4));
}

// Balance mutex — prevents race condition on simultaneous multi-pair closes
let balanceLocked = false;
async function acquireBalanceLock() {
    while (balanceLocked) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    balanceLocked = true;
}
function releaseBalanceLock() {
    balanceLocked = false;
}

ensureLogsDir();

const priceStreams = { 'BTC/USDT': [], 'ETH/USDT': [], 'SOL/USDT': [] };
const scanBuffers = { 'BTC/USDT': [], 'ETH/USDT': [], 'SOL/USDT': [] };
const strategicMatrices = {
    'BTC/USDT': { upper: 0, sma: 0, lower: 0 },
    'ETH/USDT': { upper: 0, sma: 0, lower: 0 },
    'SOL/USDT': { upper: 0, sma: 0, lower: 0 }
};

function getStateFilePath(pair) {
    return `./scalper_state_${pair.replace('/', '-')}.json`;
}

function getCentralTimestamp() {
    return new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
}

function appendHistoryLog(msg) {
    log('BOT', CONFIG.version, msg);
}

function sendNotification(title, content) {
    try {
        execSync(`termux-notification -t "${title}" -c "${content}" --id scalper_bot --sound --priority max`);
    } catch (err) {
        // Silent fail if termux-api is missing
    }
}

function calculateSMA(prices) {
    return prices.reduce((acc, p) => acc + p, 0) / prices.length;
}

function calculateStandardDeviation(prices, mean) {
    const squareDiffs = prices.map(p => Math.pow(p - mean, 2));
    return Math.sqrt(squareDiffs.reduce((acc, val) => acc + val, 0) / prices.length);
}

async function seedHistoricalData(exchange, pair) {
    try {
        const rawCandles = await exchange.fetchOHLCV(pair, '1m', undefined, 91);
        if (!rawCandles || rawCandles.length < 90) return;

        const compiledBuffer = [];
        for (let i = 2; i < rawCandles.length; i += 3) {
            compiledBuffer.push(rawCandles[i][4]);
            if (compiledBuffer.length >= CONFIG.smaWindowSize) break;
        }

        priceStreams[pair] = compiledBuffer;
        const sma = calculateSMA(compiledBuffer);
        const stdDev = calculateStandardDeviation(compiledBuffer, sma);
        strategicMatrices[pair] = {
            sma: sma,
            upper: sma + (CONFIG.volaMultiplier * stdDev),
            lower: sma - (CONFIG.volaMultiplier * stdDev)
        };
    } catch (err) {
        appendHistoryLog(`[SEED ERROR] ${pair}: ${err.message}`);
    }
}

async function processContinuousScan(exchange, pair) {
    try {
        const ticker = await exchange.fetchTicker(pair);
        const livePrice = ticker.close;
        if (!livePrice) return;

        scanBuffers[pair].push(livePrice);

        const stateFile = getStateFilePath(pair);
        if (fs.existsSync(stateFile)) {
            let state;
            try {
                state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            } catch (parseErr) {
                logError('scalper_machine.js', `[CORRUPT STATE] ${pair} state file unreadable, resetting. Error: ${parseErr.message}`);
                fs.writeFileSync(stateFile, JSON.stringify({ positionActive: false }, null, 4));
                state = { positionActive: false };
            }
            if (state.positionActive) {
                await manageActivePosition(pair, ticker.bid || livePrice, ticker.ask || livePrice, state);
            }
        }

        if (scanBuffers[pair].length >= CONFIG.blocksToAggregate) {
            scanBuffers[pair] = [];
            priceStreams[pair].push(livePrice);
            if (priceStreams[pair].length > CONFIG.smaWindowSize) priceStreams[pair].shift();

            const sma = calculateSMA(priceStreams[pair]);
            const stdDev = calculateStandardDeviation(priceStreams[pair], sma);

            strategicMatrices[pair].sma = sma;
            strategicMatrices[pair].upper = sma + (CONFIG.volaMultiplier * stdDev);
            strategicMatrices[pair].lower = sma - (CONFIG.volaMultiplier * stdDev);

            await evaluateStrategyLogic(pair, livePrice, ticker.bid || livePrice, ticker.ask || livePrice);
        }
    } catch (err) {
        logError('scalper_machine.js', `[SCAN ERROR] ${pair}: ${err.message}`);
    }
}

async function evaluateStrategyLogic(pair, price, liveBid, liveAsk) {
    const stateFile = getStateFilePath(pair);
    if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.positionActive) return;
    }

    const matrix = strategicMatrices[pair];
    if (price >= matrix.upper) {
        await executePaperOrder(pair, 'SHORT', liveBid);
    } else if (price <= matrix.lower) {
        await executePaperOrder(pair, 'LONG', liveAsk);
    }
}

async function executePaperOrder(pair, direction, entryPrice) {
    const currentBalance = getBalance();
    const allocatedCapital = currentBalance * CONFIG.riskPercentPerTrade;
    const totalBuyingPower = allocatedCapital * CONFIG.leverageMultiplier;
    const precision = CONFIG.precisionRules[pair] || { amount: 2, price: 2 };
    const finalizedContractSize = parseFloat((totalBuyingPower / entryPrice).toFixed(precision.amount));
    const entryFeePaid = totalBuyingPower * CONFIG.takerFeeRate;
    const riskDistance = entryPrice * CONFIG.stopLossPercent;
    const targetDistance = entryPrice * CONFIG.takeProfitPercent;

    const positionState = {
        positionActive: true,
        timestamp: getCentralTimestamp(),
        pair: pair,
        direction: direction,
        entryPrice: parseFloat(entryPrice.toFixed(precision.price)),
        contractSize: finalizedContractSize,
        stopLossPrice: parseFloat((direction === 'LONG' ? (entryPrice - riskDistance) : (entryPrice + riskDistance)).toFixed(precision.price)),
        takeProfitPrice: parseFloat((direction === 'LONG' ? (entryPrice + targetDistance) : (entryPrice - targetDistance)).toFixed(precision.price)),
        allocatedCapital: allocatedCapital,
        leverageApplied: CONFIG.leverageMultiplier,
        entryFeePaid: entryFeePaid
    };

    fs.writeFileSync(getStateFilePath(pair), JSON.stringify(positionState, null, 4));
    const msg = `Opened ${direction} for ${pair} at entry price ${entryPrice} (Allocated: $${allocatedCapital.toFixed(2)})`;
    appendHistoryLog(`[ORDER] ${msg}`);
    sendNotification(`🚀 TRADE OPENED [v${CONFIG.version}]`, `${pair}: ${direction} @ $${entryPrice}\nValue: $${allocatedCapital.toFixed(2)}`);
}

async function manageActivePosition(pair, liveBid, liveAsk, state) {
    let triggered = false;
    let reason = '';
    let execPrice = 0;

    const currentPrice = state.direction === 'LONG' ? liveBid : liveAsk;
    const priceChangePct = state.direction === 'LONG' 
        ? (currentPrice - state.entryPrice) / state.entryPrice 
        : (state.entryPrice - currentPrice) / state.entryPrice;

    // --- TRAILING LOGIC START ---
    // If profit hits 0.40% and we haven't trailed yet, move SL to Break Even and push TP up
    if (!state.trailingActive && priceChangePct >= 0.0040) {
        const moveDistance = state.entryPrice * CONFIG.stopLossPercent; // The distance we are moving SL (to break even)
        
        state.stopLossPrice = state.entryPrice; // Move SL to Entry (Break Even)
        state.takeProfitPrice = state.direction === 'LONG' 
            ? state.takeProfitPrice + moveDistance 
            : state.takeProfitPrice - moveDistance;
        
        state.trailingActive = true;
        fs.writeFileSync(getStateFilePath(pair), JSON.stringify(state, null, 4));
        
        appendHistoryLog(`[TRAILING] ${pair} profit reached 0.4%. SL moved to Break Even ($${state.entryPrice}), TP moved to $${state.takeProfitPrice.toFixed(2)}`);
        sendNotification(`🛡️ TRAILING ACTIVE: ${pair}`, `SL moved to Break Even\nNew TP: $${state.takeProfitPrice.toFixed(2)}`);
    }
    // --- TRAILING LOGIC END ---

    if (state.direction === 'LONG') {
        if (liveBid >= state.takeProfitPrice) { triggered = true; reason = 'TAKE_PROFIT'; execPrice = state.takeProfitPrice; }
        else if (liveBid <= state.stopLossPrice) { triggered = true; reason = 'STOP_LOSS'; execPrice = state.stopLossPrice; }
    } else {
        if (liveAsk <= state.takeProfitPrice) { triggered = true; reason = 'TAKE_PROFIT'; execPrice = state.takeProfitPrice; }
        else if (liveAsk >= state.stopLossPrice) { triggered = true; reason = 'STOP_LOSS'; execPrice = state.stopLossPrice; }
    }

    if (triggered) {
        const exitFee = (state.allocatedCapital * state.leverageApplied) * CONFIG.takerFeeRate;
        const totalFees = state.entryFeePaid + exitFee;
        let pnl = 0;

        if (reason === 'TAKE_PROFIT') {
            pnl = (state.allocatedCapital * CONFIG.takeProfitPercent * state.leverageApplied) - totalFees;
        } else {
            pnl = -(state.allocatedCapital * CONFIG.stopLossPercent * state.leverageApplied) - totalFees;
        }

        await acquireBalanceLock();
        const currentBalance = getBalance();
        const newBalance = currentBalance + pnl;
        updateBalance(newBalance);
        releaseBalanceLock();

        fs.writeFileSync(getStateFilePath(pair), JSON.stringify({ positionActive: false }, null, 4));
        const logMsg = `[CLOSED] Out of ${pair} via ${reason} at execution value ${execPrice}. PnL: $${pnl.toFixed(2)}, New Balance: $${newBalance.toFixed(2)}`;
        appendHistoryLog(logMsg);

        const winLoss = pnl >= 0 ? '✅ WIN' : '❌ LOSS';
        const roi = ((newBalance - 300.00) / 300.00 * 100).toFixed(3);
        sendNotification(`💰 TRADE CLOSED: ${winLoss}`, `${pair}: ${reason}\nPnL: $${pnl.toFixed(2)}\nBalance: $${newBalance.toFixed(2)}\nTotal ROI: ${roi}%`);
    }
}

async function startEngine() {
    appendHistoryLog("=== SCALPER ENGINE OPERATIONAL BUFFER ONLINE ===");
    const exchange = new ccxt.weex({ enableRateLimit: true, timeout: 20000, options: { defaultType: 'swap' } });

    for (const pair of CONFIG.targetPairs) {
        await seedHistoricalData(exchange, pair);
    }
    for (const pair of CONFIG.targetPairs) {
        await processContinuousScan(exchange, pair);
    }

    setInterval(async () => {
        for (const pair of CONFIG.targetPairs) {
            await processContinuousScan(exchange, pair);
        }
    }, CONFIG.scanIntervalMs);
}

startEngine();
