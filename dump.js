/**
 * File: dump.js
 * Version: 1.0.0
 * Description: Source Aggregator — Dumps full project source into momentum_scalper_dump.txt
 */

const fs = require('fs');

const OUTPUT_FILE = './momentum_scalper_dump.txt';

const TARGET_FILES = [
    'scalper_machine.js',
    'logger_util.js',
    'scalper_backtest.js',
    'simulate_from_logs.js',
    'check_status.js',
    'update_tracker.js',
    'annotate_log.js',
    'captains_log.js',
    'dump.js',
    'env.sh'
];

const timestamp = (() => {
    const now = new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: '2-digit', day: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: true
    });
    const [datePart, timePart] = now.split(', ');
    const [month, day, year] = datePart.split('/');
    return `${day}/${month}/${year} | ${timePart}`;
})();

let output = '';
output += `${'='.repeat(60)}\n`;
output += ` MOMENTUM SCALPER — PROJECT SOURCE DUMP\n`;
output += ` Generated: ${timestamp}\n`;
output += `${'='.repeat(60)}\n\n`;

for (const file of TARGET_FILES) {
    if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        output += `${'-'.repeat(60)}\n`;
        output += ` FILE: ${file}\n`;
        output += `${'-'.repeat(60)}\n`;
        output += content;
        output += `\n\n`;
    } else {
        output += `${'-'.repeat(60)}\n`;
        output += ` FILE: ${file} [NOT FOUND]\n`;
        output += `${'-'.repeat(60)}\n\n`;
    }
}

fs.writeFileSync(OUTPUT_FILE, output);
console.log(`✅ Dump complete: ${OUTPUT_FILE} (${(output.length / 1024).toFixed(1)} KB)`);
