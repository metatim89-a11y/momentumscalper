#!/bin/bash
pkill -f "node server.js" 2>/dev/null
sleep 0.5
cd /data/data/com.termux/files/home/momentum_scalper
echo "🚀 Starting Momentum Scalper Dashboard..."
node server.js > dashboard.log 2>&1 &
PID=$!
echo "✅ Dashboard is running at http://localhost:3000 (PID: $PID)"
echo "📄 Logs are being written to dashboard.log"
