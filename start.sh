#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── 1. Python backend ─────────────────────────────────────────────────────────
echo "▶ Starting Python backend on port 8000..."
venv/bin/python3 live_listener.py &
BACKEND_PID=$!

# ── 3. Frontend dev server ────────────────────────────────────────────────────
echo "▶ Starting frontend dev server on port 5173..."
cd "$ROOT/frontend"

if [ ! -d "node_modules" ]; then
  echo "  Installing npm packages..."
  npm install
fi

VITE_API_URL=http://localhost:8000 npm run dev &
FRONTEND_PID=$!

# ── 4. Cleanup on exit ────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "▶ Stopping servers..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
}
trap cleanup EXIT INT TERM

echo ""
echo "✓ Backend  → http://localhost:8000/data"
echo "✓ Frontend → http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop."

wait
