/**
 * Strategy Organizer Agent
 * 
 * Monitors BTC market indicators via CCXT to autonomously switch the bot's mode.
 * - Trend: High momentum, clear direction.
 * - Reversal: High volatility, range-bound, RSI extremes.
 */

const ccxt = require('ccxt');
const http = require('http');

const CONFIG = {
    checkIntervalMs: 60000,
    port: 3000,
    symbol: 'BTC/USDT',
    currentMode: 'trend'
};

const exchange = new ccxt.weex({ enableRateLimit: true });

// Basic indicator helper
function calculateRSI(candles) {
    // Simplified RSI: (14 periods)
    let gains = 0, losses = 0;
    for (let i = candles.length - 14; i < candles.length; i++) {
        const diff = candles[i][4] - candles[i-1][4];
        if (diff > 0) gains += diff; else losses -= Math.abs(diff);
    }
    const rs = (gains / 14) / (losses / 14);
    return 100 - (100 / (1 + rs));
}

async function setMode(mode) {
    if (mode === CONFIG.currentMode) return;
    
    const data = JSON.stringify({ action: 'toggleMode', value: mode });
    const options = {
        hostname: 'localhost',
        port: CONFIG.port,
        path: '/api/control',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    };

    const req = http.request(options, (res) => {
        CONFIG.currentMode = mode;
        console.log(`[STRATEGY AGENT] Successfully switched to: ${mode}`);
    });
    req.write(data);
    req.end();
}

async function runStrategyAgent() {
    console.log("[STRATEGY AGENT] Started. Monitoring BTC...");
    
    setInterval(async () => {
        try {
            const ohlcv = await exchange.fetchOHLCV(CONFIG.symbol, '15m', undefined, 20);
            const rsi = calculateRSI(ohlcv);
            
            // Intelligence: 
            // If RSI is at extreme, market is likely topping/bottoming (Reversal)
            // If RSI is mid-range, we trust the trend
            const newMode = (rsi > 65 || rsi < 35) ? 'reversal' : 'trend';
            
            console.log(`[STRATEGY AGENT] BTC RSI: ${rsi.toFixed(2)} | Suggesting Mode: ${newMode}`);
            await setMode(newMode);
        } catch (err) {
            console.error("[STRATEGY AGENT] Error:", err.message);
        }
    }, CONFIG.checkIntervalMs);
}

runStrategyAgent();
