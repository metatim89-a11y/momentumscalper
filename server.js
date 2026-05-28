/**
 * File: server.js
 * Version: 3.0.0
 * Fixes: manual long/short/exit buttons (body parsed once, shared),
 *        Termux notifications on all trade events,
 *        resilient per-pair ticker fetch (no bulk endpoint)
 */

'use strict';

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const ccxt  = require('ccxt');
const { execSync, exec } = require('child_process');

const PORT  = 3000;
const PAIRS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'ADA-USDT', 'DOGE-USDT', 'XRP-USDT', 'BNB-USDT', 'LINK-USDT', 'DOT-USDT', 'AVAX-USDT', 'LTC-USDT', 'TRX-USDT', 'MATIC-USDT', 'NEAR-USDT', 'FIL-USDT', 'ATOM-USDT'];

const exchange = new ccxt.weex({ enableRateLimit: true, timeout: 8000 });

// ─── Config (must match scalper_machine.js) ───────────────────────────────────
const TAKER_FEE    = 0.0006;
const LEVERAGE     = 3;
const SL_PCT       = 0.0026;   // Fixed: match scalper_machine.js CONFIG.stopLossPercent
const TP_PCT       = 0.0074;
const START_BAL    = 300.00;

// ─── Balance helpers ──────────────────────────────────────────────────────────
function getBalance() {
    try {
        if (fs.existsSync('account_balance.json'))
            return JSON.parse(fs.readFileSync('account_balance.json', 'utf8')).balance;
    } catch (_) {}
    return START_BAL;
}
function saveBalance(bal) {
    fs.writeFileSync('account_balance.json', JSON.stringify({ balance: parseFloat(bal.toFixed(2)) }, null, 4));
}
function appendLog(msg) {
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });
    fs.appendFileSync('scalper_history.log', `[${ts}] ${msg}\n`);
}

// ─── Termux notification helper ───────────────────────────────────────────────
function notify(title, content, id = 'scalper_server') {
    try {
        execSync(`termux-notification -t "${title}" -c "${content}" --id ${id} --sound --priority max`);
    } catch (_) { /* termux-api optional */ }
}

// ─── Resilient per-pair ticker (no bulk endpoint) ─────────────────────────────
async function fetchTickerSafe(ccxtPair) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await exchange.fetchTicker(ccxtPair);
        } catch (e) {
            if (attempt === 1) return { last: 0, bid: 0, ask: 0 };
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return { last: 0, bid: 0, ask: 0 };
}

async function fetchAllTickers() {
    const results = await Promise.allSettled(
        PAIRS.map(p => fetchTickerSafe(p.replace('-', '/')).then(t => ({ pair: p, price: t.last || t.close || 0 })))
    );
    const prices = {};
    results.forEach(r => {
        if (r.status === 'fulfilled') prices[r.value.pair] = r.value.price;
    });
    return prices;
}

// ─── Log date parser ──────────────────────────────────────────────────────────
function parseLogDate(dateStr) {
    if (dateStr.includes('|')) {
        const [datePart, timePart] = dateStr.split('|').map(s => s.trim());
        return new Date(`${datePart} ${timePart}`);
    }
    return new Date(dateStr.replace(',', ''));
}

// ─── Indicator helpers ────────────────────────────────────────────────────────
function calculateSMA(prices) {
    if (prices.length === 0) return 0;
    return prices.reduce((acc, p) => acc + p, 0) / prices.length;
}
function calculateStandardDeviation(prices, mean) {
    if (prices.length === 0) return 0;
    const squareDiffs = prices.map(p => Math.pow(p - mean, 2));
    return Math.sqrt(squareDiffs.reduce((acc, val) => acc + val, 0) / prices.length);
}

// ─── Per-pair timeframe map (must match scalper_machine.js TOKEN_CONFIGS) ─────
const PAIR_TIMEFRAME_MAP = {
    'BTC/USDT': '15m', 'ETH/USDT': '15m', 'SOL/USDT': '5m',
    'ADA/USDT': '5m', 'DOGE/USDT': '30m', 'XRP/USDT': '30m',
    'BNB/USDT': '15m', 'LINK/USDT': '30m', 'DOT/USDT': '15m', 'AVAX/USDT': '30m',
    'LTC/USDT': '15m', 'TRX/USDT': '15m', 'MATIC/USDT': '15m', 'NEAR/USDT': '15m',
    'FIL/USDT': '15m', 'ATOM/USDT': '15m'
};

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

    // ── Static dashboard ────────────────────────────────────────────────────
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); res.end('Error loading index.html'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // ── Bot Configuration/Docs API (for help bubble) ──────────────────────
    if (req.url === '/api/config') {
        const config = {
            logic: {
                trailingStop: "Dynamic milestone-based trailing stop triggered at 40% target progress. Locks in profit; disables safety exits once trailTier >= 1.",
                trendFlip: "Invalidates trade if 5m/15m higher-timeframe trend aligns against position. Disabled when Profit Lock is active.",
                timeCutoff: "Closes trade after 30 minutes if position is losing after fees. Disabled when Profit Lock is active."
            },
            parameters: {
                takeProfit: TP_PCT * 100 + "%",
                stopLoss: SL_PCT * 100 + "%",
                leverage: LEVERAGE,
                takerFee: TAKER_FEE * 100 + "%",
                cutoffTime: "30 minutes"
            }
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
    }

    // ── Dashboard data API ───────────────────────────────────────────────────
    if (req.url === '/api/data') {
        const data = {
            balance:        0,
            initialBalance: 300.00,
            startTime:      '2026-05-17T22:33:09',
            positions:      [],
            trades:         [],
            history:        [],
            uptime:         []
        };

        // Balance
        try {
            if (fs.existsSync('account_balance.json'))
                data.balance = JSON.parse(fs.readFileSync('account_balance.json', 'utf8')).balance;
        } catch (_) {}

        // Live prices (individual calls)
        const livePrices = await fetchAllTickers();

        // Active positions
        PAIRS.forEach(pair => {
            try {
                const fp = `scalper_state_${pair}.json`;
                if (!fs.existsSync(fp)) return;
                const st = JSON.parse(fs.readFileSync(fp, 'utf8'));
                if (st.positionActive) {
                    st.currentPrice = livePrices[pair] || 0;
                    data.positions.push(st);
                }
            } catch (_) {}
        });

        // Trade history from log
        try {
            if (fs.existsSync('scalper_history.log')) {
                const lines      = fs.readFileSync('scalper_history.log', 'utf8').split('\n');
                const trades     = [];
                const history    = [];
                const dailyStats = {};

                lines.forEach(line => {
                    if (!line.trim()) return;
                    const tm = line.match(/^\[(.*?)\]/);
                    if (!tm) return;
                    const ts = parseLogDate(tm[1]);
                    if (isNaN(ts.getTime())) return;

                    const dk = ts.toISOString().split('T')[0];
                    if (!dailyStats[dk]) dailyStats[dk] = { pnl: 0, count: 0, first: ts, last: ts };
                    if (ts < dailyStats[dk].first) dailyStats[dk].first = ts;
                    if (ts > dailyStats[dk].last)  dailyStats[dk].last  = ts;

                    if (line.includes('[CLOSED]')) {
                        const pnlM = line.match(/PnL: \$(-?\d+\.\d+)/);
                        const prM  = line.match(/Out of (\S+) via/);
                        const rsM  = line.match(/via (\w+) (?:\(signal:|at)/);
                        const sgM  = line.match(/\(signal: (\w+)\)/);
                        const blM  = line.match(/New Balance: \$(\d+\.\d+)/);
                        if (pnlM && prM) {
                            const pnl = parseFloat(pnlM[1]);
                            trades.push({
                                time:    ts.toLocaleString(),
                                pair:    prM[1],
                                signal:  sgM ? sgM[1] : '—',
                                reason:  rsM ? rsM[1] : 'Unknown',
                                pnl,
                                balance: blM ? parseFloat(blM[1]) : null
                            });
                            dailyStats[dk].pnl   += pnl;
                            dailyStats[dk].count += 1;
                        }
                    }

                    if (line.includes('[CLOSED]') || line.includes('[ORDER]')) history.push(line);
                });

                data.uptime = Object.keys(dailyStats).sort().reverse().map(dk => {
                    const s  = dailyStats[dk];
                    const ms = s.last - s.first;
                    return {
                        date:     dk,
                        duration: `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`,
                        pnl:      s.pnl,
                        trades:   s.count
                    };
                });
                data.trades  = trades;
                data.history = history.reverse().slice(0, 50);
            }
        } catch (e) { console.error('Log parse error:', e.message); }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
        return;
    }

    // ── Candles API ──────────────────────────────────────────────────────────
    if (req.url.startsWith('/api/candles/')) {
        const urlParts = req.url.split('?');
        const pairPath = urlParts[0].split('/api/candles/')[1];
        const pair = pairPath.replace('-', '/');
        
        // Parse query params for timeframe
        const params = new URLSearchParams(urlParts[1] || '');
        const timeframe = params.get('tf') || PAIR_TIMEFRAME_MAP[pair] || '1m';

        try {
            const ohlcv = await exchange.fetchOHLCV(pair, timeframe, undefined, 100);
            const candles = ohlcv.map(c => ({
                time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5]
            }));

            const indicators = candles.map((c, i) => {
                // We need at least 39 candles for SMA Slow (39)
                if (i < 38) return { smaFast: null, smaMed: null, smaSlow: null, upper: null, lower: null };
                
                const sliceF = candles.slice(i - 16 + 1, i + 1).map(x => x.close);
                const sliceM = candles.slice(i - 26 + 1, i + 1).map(x => x.close);
                const sliceS = candles.slice(i - 39 + 1, i + 1).map(x => x.close);
                
                const smaF = calculateSMA(sliceF);
                const smaM = calculateSMA(sliceM);
                const smaS = calculateSMA(sliceS);
                const stdDev = calculateStandardDeviation(sliceM, smaM);
                
                // Use volaMultiplier 1.2 from scalper_machine.js v3.0
                return {
                    smaFast: smaF,
                    smaMed:  smaM,
                    smaSlow: smaS,
                    upper:   smaM + (1.2 * stdDev),
                    lower:   smaM - (1.2 * stdDev)
                };
            });

            // Return the last 50 candles/indicators for a better view
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                candles: candles.slice(-50),
                indicators: indicators.slice(-50)
            }));
        } catch (e) {
            console.error(`[CANDLES ERROR] ${pair}: ${e.message}`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // ── Get Active Mode ──────────────────────────────────────────────────────────
    if (req.url === '/api/mode' && req.method === 'GET') {
        let mode = 'trend';
        try {
            if (fs.existsSync('./mode.json')) {
                const data = JSON.parse(fs.readFileSync('./mode.json', 'utf8'));
                mode = data.mode;
            }
        } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode }));
        return;
    }

    // ── Control API ──────────────────────────────────────────────────────────
    if (req.url === '/api/control') {
        // Collect full body first, then parse ONCE
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', async () => {
            let payload;
            try { payload = JSON.parse(raw); }
            catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Bad JSON' }));
                return;
            }

            const action = payload.action;
            const pair   = payload.pair ? payload.pair.replace('/', '-') : null;

            // ── Manual LONG ────────────────────────────────────────────────
            if (action === 'long') {
                if (!pair) { res.writeHead(400); res.end(JSON.stringify({ error: 'pair required' })); return; }
                fs.writeFileSync(`manual_trade_${pair}.json`, JSON.stringify({ action: 'long', timestamp: Date.now() }));
                notify('📈 Manual LONG', `${pair} manual long queued`, 'scalper_manual');
                res.writeHead(200);
                res.end(JSON.stringify({ status: `Manual LONG queued for ${pair}` }));
                return;
            }

            // ── Manual SHORT ───────────────────────────────────────────────
            if (action === 'short') {
                if (!pair) { res.writeHead(400); res.end(JSON.stringify({ error: 'pair required' })); return; }
                fs.writeFileSync(`manual_trade_${pair}.json`, JSON.stringify({ action: 'short', timestamp: Date.now() }));
                notify('📉 Manual SHORT', `${pair} manual short queued`, 'scalper_manual');
                res.writeHead(200);
                res.end(JSON.stringify({ status: `Manual SHORT queued for ${pair}` }));
                return;
            }

            // ── Manual EXIT — queues exit for scalper_machine ───────────────
            if (action === 'exit') {
                if (!pair) { res.writeHead(400); res.end(JSON.stringify({ error: 'pair required' })); return; }
                fs.writeFileSync(`manual_exit_${pair}.json`, JSON.stringify({ exit: true, timestamp: Date.now() }));
                notify('🚪 Manual EXIT', `${pair} manual exit queued`, 'scalper_manual');
                res.writeHead(200);
                res.end(JSON.stringify({ status: `Manual EXIT queued for ${pair}` }));
                return;
            }

            // ── Update Bot Configuration ──────────────────────────────────
            if (action === 'toggleMode') {
                const mode = payload.value;
                if (mode !== 'trend' && mode !== 'reversal') {
                    res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid mode' })); return;
                }
                const configPath = 'scalper_machine.js';
                let content = fs.readFileSync(configPath, 'utf8');
                content = content.replace(/signalMode:\s*'\w+'/, `signalMode: '${mode}'`);
                fs.writeFileSync(configPath, content);
                notify('🔄 Mode Switched', `Bot mode changed to ${mode}`, 'scalper_control');
                res.writeHead(200);
                res.end(JSON.stringify({ status: `Mode switched to ${mode}` }));
                return;
            }

            if (action === 'toggleTrendFlipPause') {
                const pauseFile = 'trend_flip_pause.json';
                let isPaused = false;
                if (fs.existsSync(pauseFile)) {
                    isPaused = JSON.parse(fs.readFileSync(pauseFile, 'utf8')).paused;
                }
                const newPaused = !isPaused;
                fs.writeFileSync(pauseFile, JSON.stringify({ paused: newPaused }));
                notify('🛡️ Trend Flip', `Trend flip is now ${newPaused ? 'PAUSED' : 'ACTIVE'}`, 'scalper_control');
                res.writeHead(200);
                res.end(JSON.stringify({ status: `Trend flip ${newPaused ? 'paused' : 'resumed'}` }));
                return;
            }

            if (action === 'updateConfig') {
                const configPath = 'scalper_machine.js';
                let content = fs.readFileSync(configPath, 'utf8');
                
                // FIX: Previous regex `key:\s*[0-9\.]+` would match partial key names
                // (e.g. "sl" would match "smaSlow", corrupting the file silently).
                // Now uses word boundaries (\b) and only allows the known safe CONFIG keys.
                const ALLOWED_CONFIG_KEYS = new Set([
                    'fixedPositionSizeUSDT', 'leverageMultiplier', 'stopLossPercent',
                    'takeProfitPercent', 'rsiOversold', 'rsiOverbought', 'volaMultiplier',
                    'nearSmaThreshold', 'minSlopeThreshold', 'maxConcurrentSameDirection',
                    'cooldownBlocksBase', 'cooldownBlocksMax', 'fastBreakevenPct',
                    'trailStepPct', 'trailSlStepPct', 'trailTpBumpPct', 'takerFeeRate'
                ]);

                for (const [key, value] of Object.entries(payload)) {
                    if (key === 'action') continue;
                    if (!ALLOWED_CONFIG_KEYS.has(key)) {
                        console.warn(`[CONFIG] Rejected unknown key: ${key}`);
                        continue;
                    }
                    if (typeof value !== 'number' || !isFinite(value)) {
                        console.warn(`[CONFIG] Rejected non-numeric value for key: ${key}`);
                        continue;
                    }
                    // Word-boundary anchored regex — prevents partial key matches
                    const regex = new RegExp(`\\b(${key}:\\s*)[0-9.]+`);
                    content = content.replace(regex, `$1${value}`);
                }
                
                fs.writeFileSync(configPath, content);
                notify('⚙️ Configuration Updated', 'Settings applied to scalper engine', 'scalper_ctrl');
                res.writeHead(200);
                res.end(JSON.stringify({ status: 'Config updated' }));
                return;
            }

            // ── Bot Configuration/Control ──────────────────────────────────
            if (action === 'toggleMode') {
                // Read current machine config to toggle mode
                const content = fs.readFileSync('scalper_machine.js', 'utf8');
                const newContent = content.replace(/signalMode: '\w+'/, `signalMode: '${payload.value}'`);
                fs.writeFileSync('scalper_machine.js', newContent);
                notify('⚙️ Strategy Mode', `Bot mode set to: ${payload.value}`, 'scalper_ctrl');
                res.writeHead(200);
                res.end(JSON.stringify({ status: `Mode set to ${payload.value}` }));
                return;
            }

            // ── Bot controls ───────────────────────────────────────────────
            if (action === 'start') {
                exec('node scalper_machine.js > .logs/scalper_machine.log 2>&1 &');
                notify('🤖 Bot Started', 'Scalper engine starting up', 'scalper_ctrl');
            } else if (action === 'stop') {
                exec('pkill -f "node scalper_machine.js"');
                notify('🛑 Bot Stopped', 'Scalper engine stopped', 'scalper_ctrl');
            } else if (action === 'restart') {
                exec('pkill -f "node scalper_machine.js" && sleep 1 && node scalper_machine.js > .logs/scalper_machine.log 2>&1 &');
                notify('🔄 Bot Restarted', 'Scalper engine restarting', 'scalper_ctrl');
            } else if (action === 'reset') {
                exec('pkill -f "node scalper_machine.js"');
                if (fs.existsSync('account_balance.json'))
                    fs.writeFileSync('account_balance.json', JSON.stringify({ balance: 300.00 }, null, 4));
                fs.readdirSync('.').forEach(f => {
                    if (f.startsWith('scalper_state_') || f === 'scalper_history.log') fs.unlinkSync(f);
                });
                notify('🔁 Bot Reset', 'Balance and history cleared', 'scalper_ctrl');
            } else if (action === 'status') {
                try {
                    const bal = JSON.parse(fs.readFileSync('account_balance.json', 'utf8')).balance;
                    const roi = (((bal - 300) / 300) * 100).toFixed(3);
                    notify(
                        '📊 Scalper Status',
                        `Balance: $${bal.toFixed(2)} | ROI: ${roi}%`,
                        'scalper_status'
                    );
                } catch (_) {}
            }

            res.writeHead(200);
            res.end(JSON.stringify({ status: `${action} executed` }));
        });
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`[SERVER] Momentum Scalper Dashboard running at http://localhost:${PORT}/`);
    notify('🖥️ Dashboard Online', `Server started on port ${PORT}`, 'scalper_server');
});
