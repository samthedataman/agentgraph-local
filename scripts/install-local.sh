#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
mkdir -p "$BIN_DIR"
cd "$ROOT"
[[ -d node_modules ]] || npm install
npm run build
cat > "$BIN_DIR/agentgraph" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/dist/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/agentgraph"
echo "Installed agentgraph to $BIN_DIR/agentgraph"
echo "Run: export PATH=\"\$HOME/.local/bin:\$PATH\" && agentgraph setup && agentgraph doctor"
