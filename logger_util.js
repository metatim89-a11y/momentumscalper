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
    const now = new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago',
        month: '2-digit',
        day: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
    });
    const [datePart, timePart] = now.split(', ');
    const [month, day, year] = datePart.split('/');
    return `${day}/${month}/${year} | ${timePart}`;
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
