/**
 * File: scalper_backtest.js
 * Version: 2.7.1
 * Description: High-Fidelity Historical Strategy Simulator
 */

const ccxt = require('ccxt');

const CONFIG = {
    targetPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT', 'DOGE/USDT', 'LTC/USDT', 'TRX/USDT', 'MATIC/USDT', 'NEAR/USDT', 'FIL/USDT', 'ATOM/USDT'],
    timeframe: '1m',
    fetchLimit: 5000,
    smaWindowSize: 30,         
    volaMultiplier: 1.2,       
    stopLossPercent: 0.0030,   // 0.30%
    takeProfitPercent: 0.0100, // 1.00%
    takerFeeRate: 0.0006,
    startingWalletUSDT: 300.00,
    riskPercentPerTrade: 0.10,
    leverage: 3
};

function getStdDev(values, mean) {
    const squareDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
}

async function runBacktest() {
    console.log("=========================================================");
    console.log("📊 INITIATING HIGH-FIDELITY GRANULAR SCALPER BACKTEST v2.7.1");
    console.log("=========================================================\n");

    const exchange = new ccxt.weex({ enableRateLimit: true, options: { defaultType: 'swap' } });
    const totalMinutes = 72 * 60;

    for (const pair of CONFIG.targetPairs) {
        try {
            console.log(`📥 Fetching 72 hours of historical 1m lines for ${pair}...`);
            let allBars = [];
            let since = exchange.milliseconds() - (totalMinutes * 60 * 1000);

            while (allBars.length < totalMinutes) {
                const ohlcv = await exchange.fetchOHLCV(pair, CONFIG.timeframe, since, 1000);
                if (!ohlcv.length) break;
                allBars = allBars.concat(ohlcv);
                since = ohlcv[ohlcv.length - 1][0] + 60000;
                if (ohlcv.length < 1000) break;
            }

            let bars1m = allBars.map(b => ({ timestamp: b[0], open: b[1], high: b[2], low: b[3], close: b[4] }));
            console.log(`✅ Successfully retrieved ${bars1m.length} minutes of data.`);

            let wallet = CONFIG.startingWalletUSDT;
            let activePosition = null;
            let totalTrades = 0;
            let wins = 0;

            // Bug #8 fix: build the 3m-block array incrementally so it costs O(n) total,
            // and each bar only ever sees blocks derived from bars strictly before it
            // (no lookahead bias).
            const blocks3m = [];

            for (let i = 120; i < bars1m.length; i++) {
                // Incrementally extend blocks3m: add a new block whenever i crosses a 3m boundary
                // A new block closes at i when (i % 3 === 2) and all three bars exist.
                if (i % 3 === 2 && bars1m[i - 2] && bars1m[i - 1] && bars1m[i]) {
                    blocks3m.push({ close: bars1m[i].close });
                }

                const currentBar = bars1m[i];

                if (activePosition) {
                    // Bug #7 fix: fees were already captured at entry price/allocation — use stored values.
                    const totalFees = activePosition.entryFees + activePosition.exitFees;
                    if (activePosition.direction === 'LONG') {
                        if (currentBar.high >= activePosition.tp) {
                            wallet += (activePosition.allocation * CONFIG.takeProfitPercent * CONFIG.leverage) - totalFees;
                            wins++; totalTrades++; activePosition = null;
                        } else if (currentBar.low <= activePosition.sl) {
                            wallet -= (activePosition.allocation * CONFIG.stopLossPercent * CONFIG.leverage) + totalFees;
                            totalTrades++; activePosition = null;
                        }
                    } else if (activePosition.direction === 'SHORT') {
                        if (currentBar.low <= activePosition.tp) {
                            wallet += (activePosition.allocation * CONFIG.takeProfitPercent * CONFIG.leverage) - totalFees;
                            wins++; totalTrades++; activePosition = null;
                        } else if (currentBar.high >= activePosition.sl) {
                            wallet -= (activePosition.allocation * CONFIG.stopLossPercent * CONFIG.leverage) + totalFees;
                            totalTrades++; activePosition = null;
                        }
                    }
                } else {
                    if (blocks3m.length < CONFIG.smaWindowSize) continue;

                    let lookbackCloses = blocks3m.slice(-CONFIG.smaWindowSize).map(b => b.close);
                    const sma = lookbackCloses.reduce((a, b) => a + b, 0) / lookbackCloses.length;
                    const stdDev = getStdDev(lookbackCloses, sma);
                    const upperBand = sma + (CONFIG.volaMultiplier * stdDev);
                    const lowerBand = sma - (CONFIG.volaMultiplier * stdDev);

                    // Bug #7 fix: capture allocation and both fee legs at entry time.
                    if (currentBar.close > upperBand) {
                        const allocation = wallet * CONFIG.riskPercentPerTrade;
                        const notional   = allocation * CONFIG.leverage;
                        activePosition = {
                            direction: 'SHORT',
                            entry:      currentBar.close,
                            tp:         currentBar.close * (1 - CONFIG.takeProfitPercent),
                            sl:         currentBar.close * (1 + CONFIG.stopLossPercent),
                            allocation,
                            entryFees:  notional * CONFIG.takerFeeRate,
                            exitFees:   notional * CONFIG.takerFeeRate
                        };
                    } else if (currentBar.close < lowerBand) {
                        const allocation = wallet * CONFIG.riskPercentPerTrade;
                        const notional   = allocation * CONFIG.leverage;
                        activePosition = {
                            direction: 'LONG',
                            entry:      currentBar.close,
                            tp:         currentBar.close * (1 + CONFIG.takeProfitPercent),
                            sl:         currentBar.close * (1 - CONFIG.stopLossPercent),
                            allocation,
                            entryFees:  notional * CONFIG.takerFeeRate,
                            exitFees:   notional * CONFIG.takerFeeRate
                        };
                    }
                }
            }

            const netROI = ((wallet - CONFIG.startingWalletUSDT) / CONFIG.startingWalletUSDT) * 100;
            const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

            console.log(`---------------------------------------------------------`);
            console.log(`📈 RESULTS FOR ASSET PAIR: ${pair}`);
            console.log(`---------------------------------------------------------`);
            console.log(`⚡ Total Executed Trades: ${totalTrades}`);
            console.log(`🎯 Win Rate Percentage:  ${winRate.toFixed(1)}%`);
            console.log(`💰 Final Simulated Bank: $${wallet.toFixed(2)} USDT`);
            console.log(`📊 Strategy Net Yield:   ${netROI >= 0 ? '+' : ''}${netROI.toFixed(2)}% ROI\n`);

        } catch (error) {
            console.error(`❌ Error processing data for ${pair}:`, error.message);
        }
    }
}

runBacktest();
