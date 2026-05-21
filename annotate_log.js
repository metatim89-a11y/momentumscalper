/**
 * File: annotate_log.js
 * Version: 1.0.0
 * Description: Manual Log Entry Portal
 */

const { log } = require('./logger_util');
const fs = require('fs');

const comment = process.argv.slice(2).join(' ');

if (!comment) {
    console.log('Usage: node annotate_log.js "Your comment here"');
    process.exit(1);
}

// Get version from scalper_machine.js
const machineContent = fs.readFileSync('./scalper_machine.js', 'utf8');
const versionMatch = machineContent.match(/version:\s*'([\d.]+)'/);
const version = versionMatch ? versionMatch[1] : '?.?.?';

log('USER', version, comment);
console.log(`✅ Added to log as USER: ${comment}`);
