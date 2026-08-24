# Deploying executor-bot + api-server to run 24/7

Runs both processes on a single small EC2 instance in us-east-1 — closest
region to Alchemy's and Flashbots' infrastructure (see chat history for why).
The frontend (`arb-scanner`) is separate — deploy that to Netlify instead,
it's a static SPA and doesn't need to live on this server.

## 1. Create the EC2 instance (AWS Console)

- **Region**: US East (N. Virginia) — `us-east-1`
- **AMI**: Ubuntu Server 24.04 LTS
- **Instance type**: `t4g.micro` (ARM/Graviton, cheapest — ~$6/mo on-demand). If you hit any package compatibility issue, `t3.micro` (x86) is the fallback, a couple dollars more/month.
- **Storage**: 20 GB gp3 (default is fine)
- **Key pair**: create a new one, download the `.pem` — this is how you'll SSH in, no password auth
- **Security group**: only open **SSH (22)** from your own IP (not 0.0.0.0/0). Nothing else needs to be open — both processes only make *outbound* connections (to RPC providers, Flashbots, The Graph), and api-server is only reached by executor-bot over `localhost`, never from the internet.

## 2. Copy the code up

From your Mac, in the repo root:

```bash
rsync -avz --exclude node_modules --exclude '*/dist' --exclude '*/.env' \
  ./ ubuntu@<EC2_PUBLIC_IP>:~/arbitrage-scanner/
```

## 3. Run the setup script

```bash
ssh -i /path/to/your-key.pem ubuntu@<EC2_PUBLIC_IP>
cd ~/arbitrage-scanner
bash deploy/ec2-setup.sh
```

This installs Node 24, pnpm, and builds both packages. It never touches
`.env` — those don't exist yet at this point.

## 4. Create the .env files — directly on the server, over this same SSH session

```bash
nano ~/arbitrage-scanner/artifacts/executor-bot/.env
nano ~/arbitrage-scanner/artifacts/api-server/.env
```

Paste the same values you have locally (`ETHEREUM_RPC_URL`, `PRIVATE_KEY`,
`ARB_EXECUTOR_ETHEREUM`, `ARB_EXECUTOR_ARBITRUM`, `FLASHBOTS_PROTECT_RPC_URL`,
`ETHERSCAN_API_KEY`, `GRAPH_API_KEY`, etc.) **typed/pasted directly into this
SSH session** — not through any other tool, not committed anywhere.

For `executor-bot/.env`, also set:

```
API_BASE_URL=http://localhost:8080
```

**Before starting anything**, double check `ENABLE_LIVE_EXECUTION=false` in
`executor-bot/.env`. Let it run in dry-run mode first and watch the logs for
a while before ever flipping this to `true` on a fresh deployment.

## 5. Install the systemd services

```bash
sudo cp ~/arbitrage-scanner/deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now api-server executor-bot
```

`enable` makes both survive a reboot; `Restart=always` in the unit files
means systemd brings them back up if either process crashes.

## 6. Check it's alive

```bash
sudo systemctl status api-server executor-bot
journalctl -u executor-bot -f     # live logs, Ctrl+C to stop watching
journalctl -u api-server -f
curl http://localhost:8080/api/healthz
```

## Updating later

```bash
# from your Mac
rsync -avz --exclude node_modules --exclude '*/dist' --exclude '*/.env' \
  ./ ubuntu@<EC2_PUBLIC_IP>:~/arbitrage-scanner/
# on the server
cd ~/arbitrage-scanner && pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/executor-bot run build
sudo systemctl restart api-server executor-bot
```
