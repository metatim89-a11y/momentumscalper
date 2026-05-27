/**
 * File: logger_util.js
 * Version: 1.1.0
 * Description: Centralized Provenance Logging System
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_FILE = './scalper_history.log';
const LOGS_DIR = './.logs';

function ensureLogsDir() {
    if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
}

function generateEventId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function getTimestamp() {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const time = now.toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
    return `${date} | ${time}`;
}

function logError(scriptName, errorMsg) {
    ensureLogsDir();
    const timestamp = getTimestamp();
    const errFile = path.join(LOGS_DIR, `${path.basename(scriptName, '.js')}.err`);
    const errLine = `([Script]:${scriptName}) ${timestamp} — ${errorMsg}\n`;
    fs.appendFileSync(errFile, errLine);
}

function log(actor, version, message) {
    const timestamp = getTimestamp();
    const eventId = generateEventId();
    const logLine = `[${timestamp}] [v${version}] [${actor}] [ID:${eventId}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine);
    return eventId;
}

module.exports = { log, logError, ensureLogsDir };
