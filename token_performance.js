/**
 * File: token_performance.js
 * Description: Generates a space-efficient 24-hour performance report per token.
 */

const fs = require('fs');

const LOG_FILE = './scalper_history.log';
const HOURS_24 = 24 * 60 * 60 * 1000;
const NOW = Date.now();

function parseLogDate(dateStr) {
    if (dateStr.includes('|')) {
        const [datePart, timePart] = dateStr.split('|').map(s => s.trim());
        return new Date(`${datePart} ${timePart}`);
    }
    return new Date(dateStr.replace(',', ''));
}

function generateReport() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log("No log file found.");
        return;
    }

    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    const stats = {};

    lines.forEach(line => {
        if (!line.includes('[CLOSED]')) return;

        const tmMatch = line.match(/^\[(.*?)\]/);
        if (!tmMatch) return;
        const ts = parseLogDate(tmMatch[1]);
        if (isNaN(ts.getTime()) || (NOW - ts.getTime()) > HOURS_24) return;

        const pairMatch = line.match(/Out of (\S+) via/);
        const pnlMatch = line.match(/PnL: \$(-?\d+\.\d+)/);

        if (pairMatch && pnlMatch) {
            const pair = pairMatch[1];
            const pnl = parseFloat(pnlMatch[1]);

            if (!stats[pair]) {
                stats[pair] = { pnl: 0, trades: 0, wins: 0 };
            }

            stats[pair].pnl += pnl;
            stats[pair].trades += 1;
            if (pnl > 0) stats[pair].wins += 1;
        }
    });

    const data = Object.entries(stats).map(([pair, s]) => ({
        Token: pair,
        PnL: `$${s.pnl.toFixed(2)}`,
        Trades: s.trades,
        'Win%': `${((s.wins / s.trades) * 100).toFixed(1)}%`
    }));

    if (data.length === 0) {
        console.log("\nNo trades recorded in the last 24 hours.\n");
        return;
    }

    // Determine column widths
    const cols = ['Token', 'PnL', 'Trades', 'Win%'];
    const widths = {};
    cols.forEach(col => {
        widths[col] = Math.max(col.length, ...data.map(d => String(d[col]).length));
    });

    // Print Table
    const hr = cols.map(col => '-'.repeat(widths[col])).join('---');
    console.log(`\n📊 24-HOUR TOKEN PERFORMANCE`);
    console.log(hr);
    console.log(cols.map(col => col.padEnd(widths[col])).join(' | '));
    console.log(hr);
    data.sort((a,b) => parseFloat(b.PnL.replace('$','')) - parseFloat(a.PnL.replace('$',''))).forEach(d => {
        console.log(cols.map(col => String(d[col]).padEnd(widths[col])).join(' | '));
    });
    console.log(hr + '\n');
}

generateReport();
