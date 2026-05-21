/**
 * File: check_status.js
 * Version: 1.0.0
 * Description: Real-time system health and version monitor
 */

const fs = require('fs');
const { execSync } = require('child_process');

function getRunningVersion() {
    try {
        // Check if scalper_machine.js is running and find its PID
        const psOutput = execSync('ps -ef | grep scalper_machine.js | grep -v grep').toString();
        
        // Read the version directly from the file (since it's the source of truth)
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
    const pairs = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'];
    let active = [];
    pairs.forEach(pair => {
        const path = `./scalper_state_${pair}.json`;
        if (fs.existsSync(path)) {
            const state = JSON.parse(fs.readFileSync(path, 'utf8'));
            if (state.positionActive) {
                active.push(`${pair} (${state.direction})`);
            }
        }
    });
    return active.length > 0 ? active.join(', ') : 'None';
}

function getSystemUptime() {
    try {
        // Find the start time of the scalper_machine.js process
        const psOutput = execSync('ps -eo etimes,command | grep scalper_machine.js | grep -v grep | head -n 1').toString();
        const seconds = parseInt(psOutput.trim().split(/\s+/)[0]);
        
        if (isNaN(seconds)) return 'N/A (Process Offline)';

        const days = Math.floor(seconds / (24 * 3600));
        const hours = Math.floor((seconds % (24 * 3600)) / 3600);
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
        const currentBalance = data.balance;
        const roi = ((currentBalance - startingBalance) / startingBalance) * 100;
        return `${roi >= 0 ? '+' : ''}${roi.toFixed(3)}%`;
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
console.log(`⏰ System Time         : ${new Date().toLocaleString()}`);
console.log(`=====================================================`);
