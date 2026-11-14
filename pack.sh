#!/data/data/com.termux/files/usr/bin/bash
# Buat paket deploy MCP (tanpa node_modules, itu di-install di tujuan).
cd "$(dirname "$0")"
OUT="$HOME/Downloads/mcp-phone-control.tar.gz"
mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" \
  --exclude='node_modules' --exclude='package-lock.json' \
  README.md android browser
echo "Dibuat: $OUT"
ls -lh "$OUT"
