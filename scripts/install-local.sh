#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
cd "$ROOT"
[[ -d node_modules ]] || npm install
npm run build
NODE_BIN="$(command -v node || true)"
if [[ -x "${HOME}/.nvm/versions/node/v22.12.0/bin/node" ]]; then
  NODE_BIN="${HOME}/.nvm/versions/node/v22.12.0/bin/node"
fi
if [[ -z "$NODE_BIN" ]] || ! "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 19) ? 0 : 1)'; then
  echo "AgentGraph requires Node 20.19+. Install/use Node 22, then rerun this installer." >&2
  exit 1
fi
cat > "$BIN_DIR/agentgraph" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$ROOT/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/agentgraph"
echo "Installed agentgraph to $BIN_DIR/agentgraph"
echo "Run: export PATH=\"\$HOME/.local/bin:\$PATH\" && agentgraph setup && agentgraph daemon start && agentgraph doctor"
