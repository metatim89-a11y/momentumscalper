/**
 * File: update_tracker.js
 * Version: 1.1.0
 * Description: Automated Version Watcher & Update Manifest Manager
 */

const fs = require('fs');
const { log } = require('./logger_util');

const CONFIG = {
    targetFile: './scalper_machine.js',
    historyLog: './scalper_history.log',
    updateManifest: './updates.json',
    archiveDir: './archive',
    checkIntervalMs: 5000
};

let lastVersion = null;

function getVersionFromFile() {
    try {
        const content = fs.readFileSync(CONFIG.targetFile, 'utf8');
        const match = content.match(/Version:\s*([\d.]+)/) || content.match(/version:\s*'([\d.]+)'/);
        return match ? match[1] : null;
    } catch (e) {
        return null;
    }
}

function initManifest() {
    if (!fs.existsSync(CONFIG.updateManifest)) {
        fs.writeFileSync(CONFIG.updateManifest, JSON.stringify([], null, 4));
    }
}

function archiveVersion(version) {
    if (!fs.existsSync(CONFIG.archiveDir)) {
        fs.mkdirSync(CONFIG.archiveDir, { recursive: true });
    }
    const dest = `${CONFIG.archiveDir}/scalper_machine.v${version}.js`;
    if (!fs.existsSync(dest)) {
        fs.copyFileSync(CONFIG.targetFile, dest);
        console.log(`📦 Archived: ${dest}`);
    }
}

function recordUpdate(version) {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' });

    const updateEntry = {
        version: version,
        timestamp: timestamp,
        issue: "Detected version bump.",
        fix: "Code updated.",
        status: "PENDING_DESCRIPTION"
    };

    archiveVersion(version);

    const manifest = JSON.parse(fs.readFileSync(CONFIG.updateManifest, 'utf8'));
    manifest.push(updateEntry);
    fs.writeFileSync(CONFIG.updateManifest, JSON.stringify(manifest, null, 4));

    log('SYSTEM', version, `Version bumped to v${version}. Archived to archive/scalper_machine.v${version}.js`);

    console.log(`\n🚀 NEW VERSION DETECTED: v${version}`);
    console.log(`📦 Archived to ${CONFIG.archiveDir}/scalper_machine.v${version}.js`);
    console.log(`📝 Logged to ${CONFIG.historyLog}`);
    console.log(`📂 Added entry to ${CONFIG.updateManifest}. Please update the "issue" and "fix" fields.`);
}

function watch() {
    console.log(`👀 Watching ${CONFIG.targetFile} for version updates...`);
    initManifest();
    lastVersion = getVersionFromFile();
    console.log(`Current active version: v${lastVersion}`);

    setInterval(() => {
        const currentVersion = getVersionFromFile();
        if (currentVersion && currentVersion !== lastVersion) {
            recordUpdate(currentVersion);
            lastVersion = currentVersion;
        }
    }, CONFIG.checkIntervalMs);
}

watch();
