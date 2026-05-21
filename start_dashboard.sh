#!/bin/bash

# Kill any existing server instance
pkill -f "node server.js" 2>/dev/null

echo "🚀 Starting Momentum Scalper Dashboard..."
node server.js > dashboard.log 2>&1 &

# Get the PID
PID=$!
echo "✅ Dashboard is running at http://localhost:3000 (PID: $PID)"
echo "📄 Logs are being written to dashboard.log"
