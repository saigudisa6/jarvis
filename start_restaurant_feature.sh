#!/bin/bash

# JARVIS Restaurant Feature Quick Start
# Runs all components needed for restaurant recommendations

set -e

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║        🍽️  JARVIS RESTAURANT SUGGESTION FEATURE           ║"
echo "║                     Quick Start                                  ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if .env exists
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file not found${NC}"
    echo "Creating .env from .env.example..."
    cp .env.example .env
    echo -e "${YELLOW}⚠️  Please edit .env and add your API keys!${NC}"
    exit 1
fi

# Check if ports are available
check_port() {
    if lsof -i :$1 > /dev/null 2>&1; then
        echo -e "${RED}❌ Port $1 is already in use${NC}"
        return 1
    fi
    return 0
}

echo -e "${BLUE}🔍 Checking ports...${NC}"
if ! check_port 8001; then
    echo "Kill process on port 8001: lsof -ti:8001 | xargs kill -9"
    exit 1
fi

if ! check_port 9000; then
    echo "Kill process on port 9000: lsof -ti:9000 | xargs kill -9"
    exit 1
fi

echo -e "${GREEN}✓ Ports available${NC}"
echo ""

# Start components
echo -e "${BLUE}📡 Starting services...${NC}"
echo ""

# Terminal 1: Restaurant Agent
echo -e "${BLUE}[1/2] Starting Restaurant Suggestion Agent (Port 8001)...${NC}"
python restaurant_agent.py &
RESTAURANT_PID=$!
sleep 2

echo ""

# Terminal 2: Bridge Server
echo -e "${BLUE}[2/2] Starting Bridge Server (Port 9000)...${NC}"
python extension_bridge.py &
BRIDGE_PID=$!
sleep 2

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║                    ✅ ALL SERVICES RUNNING                      ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${GREEN}Services:${NC}"
echo "  🤖 Restaurant Agent      → http://localhost:8001"
echo "  🌉 Bridge Server         → http://127.0.0.1:9000"
echo ""
echo -e "${GREEN}Next Steps:${NC}"
echo "  1. Load the extension in Chrome (chrome://extensions/)"
echo "  2. Go to https://google.com"
echo "  3. Search for: 'restaurants near me' or 'best pizza'"
echo "  4. Watch this terminal for recommendations! 🎉"
echo ""
echo -e "${YELLOW}To stop services, press Ctrl+C${NC}"
echo ""

# Cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down services...${NC}"
    kill $RESTAURANT_PID 2>/dev/null || true
    kill $BRIDGE_PID 2>/dev/null || true
    echo -e "${GREEN}✓ Services stopped${NC}"
    exit 0
}

trap cleanup EXIT INT TERM

# Keep script running
wait
