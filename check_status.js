/**
 * File: check_status.js
 * Version: 1.1.0
 * Description: Real-time system health and version monitor
 * Updated: Covers all 5 pairs (ADA + DOGE added), shows signal names
 * Fix: Removed duplicate v1.0.0 body that caused SyntaxError on startup
 */

const fs = require('fs');
const { execSync } = require('child_process');

const PAIRS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'ADA-USDT', 'DOGE-USDT'];

function getRunningVersion() {
    try {
        execSync('ps -ef | grep scalper_machine.js | grep -v grep');
        const machineContent = fs.readFileSync('./scalper_machine.js', 'utf8');
        const versionMatch = machineContent.match(/version:\s*'([\d.]+)'/);
        return versionMatch ? versionMatch[1] : 'Unknown';
    } catch (e) {
        return 'OFFLINE';
    }
}

function getBalance() {
    if (fs.existsSync('./account_balance.json')) {
        const data = JSON.parse(fs.readFileSync('./account_balance.json', 'utf8'));
        return `$${data.balance.toFixed(2)}`;
    }
    return 'N/A';
}

function getActivePositions() {
    let active = [];
    PAIRS.forEach(pair => {
        const filePath = `./scalper_state_${pair}.json`;
        if (fs.existsSync(filePath)) {
            const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (state.positionActive) {
                const signal = state.signalName ? ` [${state.signalName}]` : '';
                active.push(`${pair} (${state.direction}${signal})`);
            }
        }
    });
    return active.length > 0 ? active.join('\n                           ') : 'None';
}

function getSystemUptime() {
    try {
        const psOutput = execSync('ps -eo etimes,command | grep scalper_machine.js | grep -v grep | head -n 1').toString();
        const seconds = parseInt(psOutput.trim().split(/\s+/)[0]);
        if (isNaN(seconds)) return 'N/A (Process Offline)';
        const days    = Math.floor(seconds / (24 * 3600));
        const hours   = Math.floor((seconds % (24 * 3600)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${days}d ${hours}h ${minutes}m`;
    } catch (e) {
        return 'OFFLINE';
    }
}

function getROI() {
    try {
        const data = JSON.parse(fs.readFileSync('./account_balance.json', 'utf8'));
        const startingBalance = 300.00;
        const roi = ((data.balance - startingBalance) / startingBalance) * 100;
        return `${roi >= 0 ? '+' : ''}${roi.toFixed(3)}%`;
    } catch (e) {
        return 'N/A';
    }
}

function getSignalStats() {
    try {
        if (!fs.existsSync('./scalper_history.log')) return 'No log yet';
        const lines   = fs.readFileSync('./scalper_history.log', 'utf8').split('\n');
        const counts  = {};
        lines.forEach(line => {
            const m = line.match(/via (\w+) at entry price/);
            if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
        });
        if (Object.keys(counts).length === 0) return 'No trades yet';
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}:${v}`)
            .join('  ');
    } catch (e) {
        return 'N/A';
    }
}

console.log(`=====================================================`);
console.log(`📊 MOMENTUM SCALPER SYSTEM STATUS`);
console.log(`=====================================================`);
console.log(`🔹 Core Engine Version : v${getRunningVersion()}`);
console.log(`💰 Current Wallet Bank : ${getBalance()}`);
console.log(`📈 Total Strategy ROI  : ${getROI()}`);
console.log(`⏱️  System Uptime      : ${getSystemUptime()}`);
console.log(`⚡ Active Positions    : ${getActivePositions()}`);
console.log(`📡 Signal Counts       : ${getSignalStats()}`);
console.log(`⏰ System Time         : ${new Date().toLocaleString()}`);
console.log(`=====================================================`);
