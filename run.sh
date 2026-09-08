#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Create .env from the template on first run
if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo 'Created .env from .env.example. Review it and fill in any real values required by the project (keys, database URLs, etc.).'
fi

# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v "^#" .env | xargs)
fi

# Install Node.js dependencies
if [ ! -d node_modules ]; then
  echo 'Installing Node dependencies...'
  pnpm install --frozen-lockfile --silent
fi

echo 'Starting app...'
# Start all services in parallel
echo 'Starting service 1: pnpm --filter @workspace/api-server run dev'
pnpm --filter @workspace/api-server run dev &
echo 'Starting service 2: pnpm --filter @workspace/mockup-sandbox run dev'
pnpm --filter @workspace/mockup-sandbox run dev &
echo 'Starting service 3: pnpm --filter @workspace/replit-to-local run dev'
pnpm --filter @workspace/replit-to-local run dev &
wait
