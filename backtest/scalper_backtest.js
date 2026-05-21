/**
 * File: backtest/scalper_backtest.js
 * Version: 2.7.0
 * Description: High-Fidelity Historical Strategy Simulator
 */

const ccxt = require('ccxt');

const CONFIG = {
    targetPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    timeframe: '1m',           
    fetchLimit: 5000,          
    smaWindowSize: 30,         
    volaMultiplier: 2.0,       
    stopLossPercent: 0.0035,   // 0.35%
    takeProfitPercent: 0.0075, // 0.75%
    takerFeeRate: 0.0006,      
    startingWalletUSDT: 1000.00,
    riskPercentPerTrade: 0.10, // 10% of current wallet
    leverage: 3
};

function getStdDev(values, mean) {
    const squareDiffs = values.map(v => Math.pow(v - mean, 2));
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(avgSquareDiff);
}

async function runBacktest() {
    console.log("=========================================================");
    console.log("📊 INITIATING HIGH-FIDELITY GRANULAR SCALPER BACKTEST v2.6");
    console.log("=========================================================\n");

    const exchange = new ccxt.weex({ enableRateLimit: true, options: { defaultType: 'swap' } });
    const totalMinutes = 72 * 60; // 72 hours
    
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

            // Step through history minute-by-minute
            for (let i = 120; i < bars1m.length; i++) {
                const currentBar = bars1m[i];

                if (activePosition) {
                    const currentAllocation = wallet * CONFIG.riskPercentPerTrade;
                    // Position is evaluated on candles AFTER entry to avoid intra-candle paradoxes
                    if (activePosition.direction === 'LONG') {
                        if (currentBar.high >= activePosition.tp) {
                            const profit = (currentAllocation * CONFIG.takeProfitPercent * CONFIG.leverage) - (currentAllocation * CONFIG.takerFeeRate * 2);
                            wallet += profit; wins++; totalTrades++;
                            activePosition = null;
                        } else if (currentBar.low <= activePosition.sl) {
                            const loss = (currentAllocation * CONFIG.stopLossPercent * CONFIG.leverage) + (currentAllocation * CONFIG.takerFeeRate * 2);
                            wallet -= loss; totalTrades++;
                            activePosition = null;
                        }
                    } else if (activePosition.direction === 'SHORT') {
                        if (currentBar.low <= activePosition.tp) {
                            const profit = (currentAllocation * CONFIG.takeProfitPercent * CONFIG.leverage) - (currentAllocation * CONFIG.takerFeeRate * 2);
                            wallet += profit; wins++; totalTrades++;
                            activePosition = null;
                        } else if (currentBar.high >= activePosition.sl) {
                            const loss = (currentAllocation * CONFIG.stopLossPercent * CONFIG.leverage) + (currentAllocation * CONFIG.takerFeeRate * 2);
                            wallet -= loss; totalTrades++;
                            activePosition = null;
                        }
                    }
                } else {
                    // Build historical blocks using chronological grouping up to candle i-1
                    let blocks3m = [];
                    for (let k = 0; k < i; k += 3) {
                        if (bars1m[k] && bars1m[k+1] && bars1m[k+2]) {
                            blocks3m.push({ close: bars1m[k+2].close });
                        }
                    }

                    if (blocks3m.length < CONFIG.smaWindowSize) continue;

                    let targetSlice = blocks3m.slice(-CONFIG.smaWindowSize);
                    let lookbackCloses = targetSlice.map(b => b.close);

                    const sma = lookbackCloses.reduce((a, b) => a + b, 0) / lookbackCloses.length;
                    const stdDev = getStdDev(lookbackCloses, sma);
                    const upperBand = sma + (CONFIG.volaMultiplier * stdDev);
                    const lowerBand = sma - (CONFIG.volaMultiplier * stdDev);

                    // Signal check uses current close, but trade execution tracks forward from next iteration
                    if (currentBar.close > upperBand) {
                        activePosition = {
                            direction: 'SHORT',
                            entry: currentBar.close,
                            tp: currentBar.close * (1 - CONFIG.takeProfitPercent),
                            sl: currentBar.close * (1 + CONFIG.stopLossPercent)
                        };
                    } else if (currentBar.close < lowerBand) {
                        activePosition = {
                            direction: 'LONG',
                            entry: currentBar.close,
                            tp: currentBar.close * (1 + CONFIG.takeProfitPercent),
                            sl: currentBar.close * (1 - CONFIG.stopLossPercent)
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
