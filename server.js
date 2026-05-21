const http = require('http');
const fs = require('fs');
const path = require('path');
const ccxt = require('ccxt');

const PORT = 3000;
const PAIRS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
const exchange = new ccxt.weex({ enableRateLimit: true, timeout: 10000 });

const server = http.createServer(async (req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/api/data') {
        const data = {
            balance: 0,
            initialBalance: 300.00, // Based on notification logic in scalper_machine.js
            startTime: '2026-05-17T22:33:09', // Extracted from log start
            positions: [],
            history: []
        };

        // Read Balance
        try {
            if (fs.existsSync('account_balance.json')) {
                data.balance = JSON.parse(fs.readFileSync('account_balance.json', 'utf8')).balance;
            }
        } catch (e) { console.error('Error reading balance', e); }

        // Read Positions and Fetch Live Prices
        const livePrices = {};
        try {
            const tickers = await exchange.fetchTickers(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
            Object.keys(tickers).forEach(pair => {
                livePrices[pair.replace('/', '-')] = tickers[pair].last;
            });
        } catch (e) { console.error('Error fetching tickers', e); }

        PAIRS.forEach(pair => {
            try {
                const statePath = `scalper_state_${pair}.json`;
                if (fs.existsSync(statePath)) {
                    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                    if (state.positionActive) {
                        state.currentPrice = livePrices[pair] || 0;
                        data.positions.push(state);
                    }
                }
            } catch (e) { console.error(`Error reading state for ${pair}`, e); }
        });

        // Read History Logs and Parse Trades/Uptime
        try {
            if (fs.existsSync('scalper_history.log')) {
                const logContent = fs.readFileSync('scalper_history.log', 'utf8');
                const lines = logContent.split('\n');
                
                const trades = [];
                const history = [];
                const dailyStats = {}; // { 'YYYY-MM-DD': { pnl: 0, trades: 0, first: Date, last: Date } }

                function parseLogDate(dateStr) {
                    if (dateStr.includes('|')) {
                        // Format: [18/05/26 | 08:38 PM]
                        const parts = dateStr.split('|');
                        const dateParts = parts[0].trim().split('/');
                        const timeStr = parts[1].trim();
                        // Assume 20xx for year
                        return new Date(`20${dateParts[2]}-${dateParts[1]}-${dateParts[0]} ${timeStr}`);
                    } else {
                        // Format: [5/17/2026, 10:33:09 PM]
                        return new Date(dateStr.replace(',', ''));
                    }
                }

                lines.forEach(line => {
                    if (!line.trim()) return;
                    
                    const timeMatch = line.match(/^\[(.*?)\]/);
                    if (!timeMatch) return;
                    
                    const timestamp = parseLogDate(timeMatch[1]);
                    if (isNaN(timestamp.getTime())) return;

                    const dateKey = timestamp.toISOString().split('T')[0];
                    if (!dailyStats[dateKey]) {
                        dailyStats[dateKey] = { pnl: 0, count: 0, first: timestamp, last: timestamp };
                    }
                    if (timestamp < dailyStats[dateKey].first) dailyStats[dateKey].first = timestamp;
                    if (timestamp > dailyStats[dateKey].last) dailyStats[dateKey].last = timestamp;

                    if (line.includes('[CLOSED]')) {
                        const pnlMatch = line.match(/PnL: \$(-?\d+\.\d+)/);
                        const pairMatch = line.match(/Out of (\S+) via/);
                        const reasonMatch = line.match(/via (\S+) at/);
                        const balanceMatch = line.match(/New Balance: \$(\d+\.\d+)/);

                        if (pnlMatch && pairMatch) {
                            const pnlValue = parseFloat(pnlMatch[1]);
                            trades.push({
                                time: timestamp.toLocaleString(),
                                pair: pairMatch[1],
                                reason: reasonMatch ? reasonMatch[1] : 'Unknown',
                                pnl: pnlValue,
                                balance: balanceMatch ? parseFloat(balanceMatch[1]) : null
                            });
                            dailyStats[dateKey].pnl += pnlValue;
                            dailyStats[dateKey].count += 1;
                        }
                    }
                    
                    if (line.includes('[CLOSED]') || line.includes('[ORDER]')) {
                        history.push(line);
                    }
                });

                // Format Daily Stats for Frontend
                data.uptime = Object.keys(dailyStats).sort().reverse().map(date => {
                    const stats = dailyStats[date];
                    const diffMs = stats.last - stats.first;
                    const hours = Math.floor(diffMs / (1000 * 60 * 60));
                    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
                    return {
                        date,
                        duration: `${hours}h ${minutes}m`,
                        pnl: stats.pnl,
                        trades: stats.count
                    };
                });

                data.trades = trades;
                data.history = history.reverse().slice(0, 50);
            }
        } catch (e) { console.error('Error reading logs', e); }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
