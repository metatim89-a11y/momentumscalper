/**
 * File: backtest_refined.js
 * Version: 3.1.0
 * Description: High-Fidelity Backtest mirroring FULL scalper_machine.js v3.0 logic.
 */

const ccxt = require('ccxt');

const CONFIG = {
    targetPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'ADA/USDT', 'DOGE/USDT'],
    riskPercentPerTrade: 0.10,
    leverageMultiplier: 3,
    smaFast: 16,
    smaMed: 26,
    smaSlow: 39,
    volaMultiplier: 1.2,
    nearSmaThreshold: 0.999,
    stopLossPercent: 0.0026,
    takeProfitPercent: 0.0074,
    takerFeeRate: 0.0006,
    rsiPeriod: 14,
    rsiOversold: 35,
    rsiOverbought: 65,
    momentumBlocks: 3,
    bandBounceConfirmBlocks: 2,
    minSlopeThreshold: 0.00005,
    maxConcurrentSameDirection: 3,
    startingBalance: 1000.00,
    
    // Trailing stop ladder
    trailTriggerPct: 0.70,
    trailSlLockPct:  0.55,
    trailTpBumpPct:  0.0075,
    trailTier2SlPct: 0.0025,

    // Cooldown
    cooldownBlocksBase: 5,
    cooldownBlocksMax: 20,
    consecutiveSLEscalation: 1.5
};

function calculateSMA(prices) {
    if (prices.length === 0) return 0;
    return prices.reduce((acc, p) => acc + p, 0) / prices.length;
}

function calculateStandardDeviation(prices, mean) {
    if (prices.length === 0) return 0;
    const squareDiffs = prices.map(p => Math.pow(p - mean, 2));
    return Math.sqrt(squareDiffs.reduce((acc, val) => acc + val, 0) / prices.length);
}

function calculateRSIWilder(prices, period, state) {
    if (!state.seeded) {
        if (prices.length < period + 1) return null;
        const slice = prices.slice(-(period + 1));
        let gains = 0, losses = 0;
        for (let i = 1; i <= period; i++) {
            const diff = slice[i] - slice[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }
        state.avgGain = gains / period;
        state.avgLoss = losses / period;
        state.prevPrice = slice[slice.length - 1];
        state.seeded = true;
    } else {
        const currentPrice = prices[prices.length - 1];
        const diff = currentPrice - state.prevPrice;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        state.avgGain = (state.avgGain * (period - 1) + gain) / period;
        state.avgLoss = (state.avgLoss * (period - 1) + loss) / period;
        state.prevPrice = currentPrice;
    }
    if (state.avgLoss === 0) return 100;
    const rs = state.avgGain / state.avgLoss;
    return 100 - (100 / (1 + rs));
}

function momentumPct(prices, n) {
    if (prices.length < n + 1) return null;
    const now  = prices[prices.length - 1];
    const then = prices[prices.length - 1 - n];
    if (then === 0) return null;
    return (now - then) / then;
}

function applyTrailingLadder(state, livePrice) {
    const { direction, entryPrice, stopLossPrice, takeProfitPrice, trailTier = 0, originalTpPrice = takeProfitPrice } = state;
    const tpDist  = Math.abs(takeProfitPrice - entryPrice);
    const progress = direction === 'LONG' ? (livePrice - entryPrice) / tpDist : (entryPrice - livePrice) / tpDist;

    let newSl = stopLossPrice, newTp = takeProfitPrice, newTier = trailTier, newOrigTp = originalTpPrice;

    if (trailTier < 1 && progress >= CONFIG.trailTriggerPct) {
        const origTpDist = Math.abs(originalTpPrice - entryPrice);
        newSl = direction === 'LONG' ? entryPrice + (origTpDist * CONFIG.trailSlLockPct) : entryPrice - (origTpDist * CONFIG.trailSlLockPct);
        newTp = direction === 'LONG' ? takeProfitPrice * (1 + CONFIG.trailTpBumpPct) : takeProfitPrice * (1 - CONFIG.trailTpBumpPct);
        newTier = 1;
        return { ...state, stopLossPrice: newSl, takeProfitPrice: newTp, trailTier: newTier, originalTpPrice: newOrigTp };
    }
    if (trailTier === 1 && progress >= CONFIG.trailTriggerPct) {
        newSl = direction === 'LONG' ? takeProfitPrice + (takeProfitPrice * CONFIG.trailTier2SlPct) : takeProfitPrice - (takeProfitPrice * CONFIG.trailTier2SlPct);
        newTp = direction === 'LONG' ? takeProfitPrice * (1 + CONFIG.trailTpBumpPct) : takeProfitPrice * (1 - CONFIG.trailTpBumpPct);
        newTier = 2;
        return { ...state, stopLossPrice: newSl, takeProfitPrice: newTp, trailTier: newTier, originalTpPrice: newOrigTp };
    }
    return null;
}

async function runRefinedBacktest() {
    console.log("=========================================================");
    console.log("🚀 STARTING REFINED 1M CANDLE BACKTEST (V3.0 FULL LOGIC)");
    console.log("=========================================================\n");

    const exchange = new ccxt.weex({ enableRateLimit: true, options: { defaultType: 'swap' } });
    
    for (const pair of CONFIG.targetPairs) {
        try {
            console.log(`📥 Fetching historical 1m data for ${pair}...`);
            let ohlcv = [];
            let since = exchange.milliseconds() - (1500 * 60000);
            while (ohlcv.length < 1500) {
                const batch = await exchange.fetchOHLCV(pair, '1m', since, 1000);
                if (!batch.length) break;
                ohlcv = ohlcv.concat(batch);
                since = batch[batch.length - 1][0] + 60000;
            }
            if (!ohlcv || ohlcv.length < CONFIG.smaSlow + 20) {
                console.log(`⚠️ Insufficient data for ${pair}. Skipping.`);
                continue;
            }

            let wallet = CONFIG.startingBalance;
            let activePosition = null;
            let totalTrades = 0;
            let wins = 0;
            let directionCount = { LONG: 0, SHORT: 0 };

            let priceStream = [];
            let wilderState = { avgGain: 0, avgLoss: 0, prevPrice: null, seeded: false };
            let bandBreach = { upper: null, lower: null };
            let prevSmas = { fast: null, med: null, slow: null };
            let prevClose = null;
            let cooldown = { blocksRemaining: 0, consecutiveSL: 0 };

            for (let i = 0; i < ohlcv.length; i++) {
                // Decrement cooldown
                if (cooldown.blocksRemaining > 0) cooldown.blocksRemaining--;
                const candle = {
                    timestamp: ohlcv[i][0],
                    open: ohlcv[i][1],
                    high: ohlcv[i][2],
                    low: ohlcv[i][3],
                    close: ohlcv[i][4]
                };

                priceStream.push(candle.close);
                if (priceStream.length > CONFIG.smaSlow) priceStream.shift();

                const rsi = calculateRSIWilder(priceStream, CONFIG.rsiPeriod, wilderState);

                if (priceStream.length < CONFIG.smaSlow) {
                    prevClose = candle.close;
                    continue;
                }

                const smaF = calculateSMA(priceStream.slice(-CONFIG.smaFast));
                const smaM = calculateSMA(priceStream.slice(-CONFIG.smaMed));
                const smaS = calculateSMA(priceStream.slice(-CONFIG.smaSlow));
                const stdDev = calculateStandardDeviation(priceStream.slice(-CONFIG.smaMed), smaM);
                const upper = smaM + (CONFIG.volaMultiplier * stdDev);
                const lower = smaM - (CONFIG.volaMultiplier * stdDev);

                if (candle.close < lower) bandBreach.lower = i;
                if (candle.close > upper) bandBreach.upper = i;

                // ── Position Management Logic ───────────────────────────────
                if (activePosition) {
                    // Apply Trailing Ladder
                    const updated = applyTrailingLadder(activePosition, candle.close);
                    if (updated) {
                        activePosition = updated;
                    }

                    const currentAllocation = wallet * CONFIG.riskPercentPerTrade;
                    const leverage = CONFIG.leverageMultiplier;
                    const fees = currentAllocation * CONFIG.takerFeeRate * 2;

                    let triggered = false, pnl = 0;
                    if (activePosition.direction === 'LONG') {
                        if (candle.high >= activePosition.takeProfitPrice) {
                            triggered = true; pnl = (currentAllocation * (activePosition.takeProfitPrice - activePosition.entryPrice) / activePosition.entryPrice * leverage) - fees;
                            wins++;
                        } else if (candle.low <= activePosition.stopLossPrice) {
                            triggered = true; pnl = (currentAllocation * (activePosition.stopLossPrice - activePosition.entryPrice) / activePosition.entryPrice * leverage) - fees;
                        }
                    } else if (activePosition.direction === 'SHORT') {
                        if (candle.low <= activePosition.takeProfitPrice) {
                            triggered = true; pnl = (currentAllocation * (activePosition.entryPrice - activePosition.takeProfitPrice) / activePosition.entryPrice * leverage) - fees;
                            wins++;
                        } else if (candle.high >= activePosition.stopLossPrice) {
                            triggered = true; pnl = (currentAllocation * (activePosition.entryPrice - activePosition.stopLossPrice) / activePosition.entryPrice * leverage) - fees;
                        }
                    }

                    if (triggered) {
                        wallet += pnl;
                        totalTrades++;
                        if (pnl > 0) {
                            wins++;
                            cooldown.consecutiveSL = 0;
                            cooldown.blocksRemaining = 0;
                        } else {
                            cooldown.consecutiveSL++;
                            const multiplier = Math.pow(CONFIG.consecutiveSLEscalation, cooldown.consecutiveSL - 1);
                            cooldown.blocksRemaining = Math.round(Math.min(
                                CONFIG.cooldownBlocksBase * multiplier,
                                CONFIG.cooldownBlocksMax
                            ));
                        }
                        directionCount[activePosition.direction]--;
                        activePosition = null;
                    }
                }

                // ── Position Entry Logic ─────────────────────────────────────
                if (!activePosition && cooldown.blocksRemaining === 0) {
                    const slope = (smaF - smaS) / smaS;
                    const isTrendingUp = slope > CONFIG.minSlopeThreshold;
                    const isTrendingDn = slope < -CONFIG.minSlopeThreshold;
                    const isChoppy = !isTrendingUp && !isTrendingDn;

                    const volaConfirm = stdDev > 0 && Math.abs(candle.close - prevClose) > 0.3 * stdDev;

                    const momPctVal = momentumPct(priceStream, CONFIG.momentumBlocks);
                    const momThresh = stdDev > 0 ? (stdDev / smaM) * CONFIG.volaMultiplier : null;

                    let direction = null;
                    const slPct = (pair === 'DOGE/USDT' ? CONFIG.stopLossPercent * 2 : CONFIG.stopLossPercent);
                    const tpPct = (pair === 'DOGE/USDT' ? CONFIG.takeProfitPercent * 2 : CONFIG.takeProfitPercent);

                    // 1. RSI Extremes
                    if (rsi !== null && rsi <= CONFIG.rsiOversold && (isTrendingUp || candle.close <= lower * 1.005)) {
                        if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                    } else if (rsi !== null && rsi >= CONFIG.rsiOverbought && (isTrendingDn || candle.close >= upper * 0.995)) {
                        if (directionCount.SHORT < CONFIG.maxConcurrentSameDirection) direction = 'SHORT';
                    }
                    // 2. Band Bounce
                    else if (isTrendingUp && volaConfirm && prevClose !== null && prevClose < lower && candle.close >= lower) {
                        if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                    } else if (isTrendingDn && volaConfirm && prevClose !== null && prevClose > upper && candle.close <= upper) {
                        if (directionCount.SHORT < CONFIG.maxConcurrentSameDirection) direction = 'SHORT';
                    }
                    // 3. Double Dip
                    else if (isTrendingUp && bandBreach.lower !== null && i - bandBreach.lower >= CONFIG.bandBounceConfirmBlocks && candle.close <= lower * 1.002) {
                        if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                    }
                    // 4. Momentum
                    else if (!isChoppy && momPctVal !== null && momThresh !== null) {
                        if (isTrendingUp && momPctVal > momThresh && (rsi === null || rsi < CONFIG.rsiOverbought)) {
                            if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                        } else if (isTrendingDn && momPctVal < -momThresh && (rsi === null || rsi > CONFIG.rsiOversold)) {
                            if (directionCount.SHORT < CONFIG.maxConcurrentSameDirection) direction = 'SHORT';
                        }
                    }
                    // 5. Near SMA
                    else if (isTrendingUp && candle.close >= smaM * CONFIG.nearSmaThreshold && candle.close < smaM && rsi !== null && rsi < 50) {
                        if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                    }
                    // 6. Original Band Signals
                    else if (isTrendingUp && candle.close >= upper) {
                        if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                    } else if (isTrendingDn && candle.close <= lower) {
                        if (directionCount.SHORT < CONFIG.maxConcurrentSameDirection) direction = 'SHORT';
                    }
                    // 7. SMA Crosses
                    else if (prevSmas.fast !== null) {
                        if (prevSmas.fast < prevSmas.med && smaF >= smaM && smaM > smaS) {
                            if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                        } else if (prevSmas.med < prevSmas.slow && smaM >= smaS && smaF > smaM) {
                            if (directionCount.LONG < CONFIG.maxConcurrentSameDirection) direction = 'LONG';
                        } else if (prevSmas.fast >= prevSmas.med && smaF < smaM && smaM < smaS) {
                            if (directionCount.SHORT < CONFIG.maxConcurrentSameDirection) direction = 'SHORT';
                        } else if (prevSmas.med >= prevSmas.slow && smaM < smaS && smaF < smaM) {
                            if (directionCount.SHORT < CONFIG.maxConcurrentSameDirection) direction = 'SHORT';
                        }
                    }

                    if (direction) {
                        activePosition = {
                            direction,
                            entryPrice: candle.close,
                            takeProfitPrice: direction === 'LONG' ? candle.close * (1 + tpPct) : candle.close * (1 - tpPct),
                            stopLossPrice: direction === 'LONG' ? candle.close * (1 - slPct) : candle.close * (1 + slPct),
                            trailTier: 0
                        };
                        activePosition.originalTpPrice = activePosition.takeProfitPrice;
                        directionCount[direction]++;
                    }
                }

                prevSmas = { fast: smaF, med: smaM, slow: smaS };
                prevClose = candle.close;
            }

            const roi = ((wallet - CONFIG.startingBalance) / CONFIG.startingBalance) * 100;
            console.log(`---------------------------------------------------------`);
            console.log(`📈 RESULTS FOR ${pair} (${ohlcv.length} candles)`);
            console.log(`⚡ Trades: ${totalTrades} | Win Rate: ${(totalTrades > 0 ? (wins/totalTrades*100) : 0).toFixed(1)}%`);
            console.log(`💰 Bank: $${wallet.toFixed(2)} | Net ROI: ${roi.toFixed(2)}%`);

        } catch (err) {
            console.error(`❌ Error for ${pair}: ${err.message}`);
        }
    }
}

runRefinedBacktest();
