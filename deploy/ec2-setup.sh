#!/usr/bin/env bash
# Run ONCE on a fresh Ubuntu 22.04/24.04 EC2 instance (as the ubuntu user,
# not root — this script uses sudo where it needs it). Installs Node.js,
# pnpm, and builds both api-server and executor-bot. Does NOT touch any
# .env file — those are created separately, directly on the server, and are
# never part of this script or the repo.
set -euo pipefail

echo "== Installing Node.js 24 =="
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "== Installing pnpm =="
sudo npm install -g pnpm@latest

echo "== Installing build essentials (needed by some native deps) =="
sudo apt-get install -y build-essential

REPO_DIR="$HOME/arbitrage-scanner"
if [ ! -d "$REPO_DIR" ]; then
  echo "== $REPO_DIR not found =="
  echo "Copy the repo here first, e.g. from your Mac:"
  echo "  rsync -avz --exclude node_modules --exclude '*/dist' --exclude '*/.env' \\"
  echo "    \"/path/to/arbitrage-scanner-main/\" ubuntu@<EC2_IP>:~/arbitrage-scanner/"
  echo "Then re-run this script."
  exit 1
fi

cd "$REPO_DIR"
echo "== Installing dependencies =="
pnpm install --frozen-lockfile

echo "== Building api-server =="
pnpm --filter @workspace/api-server run build

echo "== Building executor-bot =="
pnpm --filter @workspace/executor-bot run build

echo ""
echo "== Build complete. Next steps: =="
echo "1. Create artifacts/api-server/.env and artifacts/executor-bot/.env directly on"
echo "   this server (nano/vim over this same SSH session) — never copy the real"
echo "   PRIVATE_KEY through any other channel."
echo "2. Copy deploy/*.service to /etc/systemd/system/, then:"
echo "     sudo systemctl daemon-reload"
echo "     sudo systemctl enable --now api-server executor-bot"
echo "3. Check status: sudo systemctl status api-server executor-bot"
echo "4. Check logs:   journalctl -u executor-bot -f"
