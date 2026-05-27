/**
 * File: simulate_from_logs.js
 * Version: 1.0.0
 * Description: Log-Based Compounding & Leverage Analysis Tool
 */

const fs = require('fs');

const CONFIG = {
    logFile: './scalper_history.log',
    startingBalance: 300.00,
    riskPercentPerTrade: 0.10,
    leverage: 3,
    takerFeeRate: 0.0006,
    stopLossPercent: 0.0026,
    takeProfitPercent: 0.0074
    };
function simulate(leverage, label) {
    if (!fs.existsSync(CONFIG.logFile)) {
        console.error("Log file not found!");
        return;
    }

    const logs = fs.readFileSync(CONFIG.logFile, 'utf8').split('\n');
    let balance = CONFIG.startingBalance;
    let activeTrades = {}; 
    let stats = { wins: 0, losses: 0, totalPnlPct: 0 };

    // Constant "Risk to Wallet" calculations
    const notionalPct = CONFIG.riskPercentPerTrade * leverage; // e.g., 0.10 * 3 = 30%
    const feePct = notionalPct * (CONFIG.takerFeeRate * 2) * 100;
    const grossWinPct = notionalPct * CONFIG.takeProfitPercent * 100;
    const grossLossPct = notionalPct * CONFIG.stopLossPercent * 100;
    
    const netWinPct = grossWinPct - feePct;
    const netLossPct = grossLossPct + feePct;

    logs.forEach(line => {
        const orderMatch = line.match(/\[ORDER\] Opened (LONG|SHORT) for ([\w/.-]+)/);
        const closeMatch = line.match(/\[CLOSED\] Out of ([\w/.-]+) via (TAKE_PROFIT|STOP_LOSS)/);

        if (orderMatch) {
            const pair = orderMatch[2];
            const allocated = balance * CONFIG.riskPercentPerTrade;
            const entryFee = (allocated * leverage) * CONFIG.takerFeeRate;
            activeTrades[pair] = { allocated, entryFee };
        }

        if (closeMatch) {
            const pair = closeMatch[1];
            const reason = closeMatch[2];
            if (activeTrades[pair]) {
                const trade = activeTrades[pair];
                const exitFee = (trade.allocated * leverage) * CONFIG.takerFeeRate;
                const totalFees = trade.entryFee + exitFee;
                let pnl = 0;
                if (reason === 'TAKE_PROFIT') {
                    pnl = (trade.allocated * CONFIG.takeProfitPercent * leverage) - totalFees;
                    stats.wins++;
                } else {
                    pnl = -(trade.allocated * CONFIG.stopLossPercent * leverage) - totalFees;
                    stats.losses++;
                }
                balance += pnl;
                delete activeTrades[pair];
            }
        }
    });

    console.log(`\n--- ${label} (${leverage}x Leverage) ---`);
    console.log(`📈 Net Profit per Win:  +${netWinPct.toFixed(3)}% of total wallet`);
    console.log(`📉 Net Loss per Loss:   -${netLossPct.toFixed(3)}% of total wallet`);
    console.log(`💰 Final Balance:       $${balance.toFixed(2)}`);
    console.log(`📊 Total Trades:        ${stats.wins + stats.losses} (${stats.wins}W / ${stats.losses}L)`);
}

console.log(`=====================================================`);
console.log(`   RISK PER WALLET ANALYSIS (10% ALLOCATION)`);
console.log(`=====================================================`);
simulate(3, "CURRENT SETUP");
simulate(1, "NO LEVERAGE  ");
