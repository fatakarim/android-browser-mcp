#!/data/data/com.termux/files/usr/bin/bash
# Jalankan CloakBrowser (Chromium stealth asli) di dalam proot Ubuntu,
# lalu expose CDP-nya ke Termux lewat 127.0.0.1:9222.

SEED="${1:-$(( (RANDOM * 32768 + RANDOM) % 90000 + 10000 ))}"
BIN=/root/.cloakbrowser/chromium-146.0.7680.177.3/chrome

# cek binary sudah ada
if [ ! -x "$BIN" ]; then
  echo "Binary CloakBrowser belum ada. Jalankan sekali:"
  echo "  proot-distro login ubuntu -- bash -c 'cd /root/cb && PATH=/usr/local/node22/bin:\$PATH npx cloakbrowser install'"
  exit 1
fi

echo "Menjalankan CloakBrowser (seed=$SEED, profile Windows) ..."
echo "Tahan 1 menit, lalu tekan Ctrl+C untuk menghentikan."

exec proot-distro login ubuntu -- bash -lc "
exec $BIN \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --fingerprint=$SEED \
  --fingerprint-platform=windows \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --user-data-dir=/tmp/cbp-$SEED \
  --lang=id-ID \
  about:blank
"