#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
cd "$DIR"

echo "======================================================"
echo "          AttendX Local Offline Server Launcher"
echo "======================================================"
echo ""

echo "[1/3] Checking dependencies..."
if [ ! -d "node_modules" ]; then
    echo "Installing frontend dependencies..."
    npm install
fi

if [ ! -d "server/node_modules" ]; then
    echo "Installing server dependencies..."
    cd server && npm install && cd ..
fi

echo "[2/3] Starting AttendX Local Backend Server on port 3001..."
(cd server && npm run start) &
SERVER_PID=$!

echo "[3/3] Starting AttendX Web Application..."
npm run dev

kill $SERVER_PID
