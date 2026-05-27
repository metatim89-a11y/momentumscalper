#!/bin/bash
pkill -f "node server.js" 2>/dev/null
pkill -f "node scalper_machine.js" 2>/dev/null
pkill -f "node strategy_agent.js" 2>/dev/null
sleep 0.5
cd /data/data/com.termux/files/home/momentum_scalper
echo "🚀 Starting Momentum Scalper Dashboard..."
node server.js > dashboard.log 2>&1 &
echo "⚙️ Starting Scalper Engine..."
node scalper_machine.js > .logs/scalper_machine.log 2>&1 &
echo "🧠 Starting Strategy Agent..."
node strategy_agent.js > .logs/strategy_agent.log 2>&1 &
echo "✅ Systems are running."
echo "📄 Check .logs/ for process output."
