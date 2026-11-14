#!/data/data/com.termux/files/usr/bin/bash
# CloakBrowser dengan tampilan di layar HP.
#   - X11 server (termux-x11) dinyalakan otomatis kalau belum jalan
#   - CloakBrowser jalan TERLIHAT di jendela X11, bukan headless
#   - CDP tetap terbuka di 127.0.0.1:9222 supaya AI bisa kendalikan
#
# Jalankan:  bash ~/mcp/cloak-tampil.sh
# Biarkan terminal ini terbuka. Ctrl+C untuk berhenti.

SEED="${1:-41230}"
BIN=/root/.cloakbrowser/chromium-146.0.7680.177.3/chrome

echo "=== CloakBrowser (tampil) ==="

# 1. pastikan Termux:X11 app + server jalan
if ! timeout 3 bash -c 'echo > /dev/tcp/127.0.0.1/6000' 2>/dev/null; then
  echo "[1/2] Menyalakan X11 server..."
  setsid termux-x11 -listen tcp -port 6000 >/dev/null 2>&1 < /dev/null &
  disown
  sleep 6
  if timeout 3 bash -c 'echo > /dev/tcp/127.0.0.1/6000' 2>/dev/null; then
    echo "      X11 server OK (port 6000)"
  else
    echo "      GAGAL: X11 server tidak start."
    echo "      Pastikan aplikasi Termux:X11 sudah terinstall."
    exit 1
  fi
else
  echo "[1/2] X11 server sudah jalan."
fi

echo "[2/2] Menjalankan CloakBrowser (seed=$SEED, profile Windows)..."
echo
echo "  Jendela akan muncul di Termux:X11."
echo "  Ketuk window Termux:X11 di HP kamu untuk melihat/menyentuh."
echo "  AI tetap bisa kendalikan lewat CDP port 9222."
echo
echo "  Tekan Ctrl+C di terminal ini untuk menghentikan."
echo

# 2. jalankan browser TERLIHAT di dalam proot
exec proot-distro login ubuntu -- bash -lc "
export DISPLAY=127.0.0.1:0
exec $BIN \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --fingerprint=$SEED \
  --fingerprint-platform=windows \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  --user-data-dir=/tmp/cb-tampil-$SEED \
  --window-size=430,860 \
  --window-position=0,0 \
  --lang=id-ID \
  https://www.google.com
"