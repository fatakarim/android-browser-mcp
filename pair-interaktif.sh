#!/data/data/com.termux/files/usr/bin/bash
# Pairing adb dengan auto-retry.
#
# Known bug ADB 35.x/37.x: "protocol fault (couldn't read status message)"
# Percobaan ulang biasanya berhasil. Script ini otomatis mengulang sampai 12x.
#
# CARA PAKAI:
#  1. Buka dialog "Pair device with pairing code" di HP, JANGAN ditutup.
#  2. Jalankan script ini, masukkan IP:port dan kode saat dialog masih aktif.

echo "=== Pairing ADB (auto-retry) ==="
echo "Pastikan dialog 'Pair device with pairing code' masih TERBUKA di HP."
echo
read -r -p "IP:port  : " ADDR
read -r -p "Kode 6   : " CODE
HOST="${ADDR%%:*}"
PORT="${ADDR##*:}"

if [ -z "$ADDR" ] || [ -z "$CODE" ]; then echo "Batal."; exit 1; fi

adb kill-server >/dev/null 2>&1

for i in $(seq 1 12); do
  if ! timeout 4 bash -c "echo > /dev/tcp/$HOST/$PORT" 2>/dev/null; then
    echo "[$i/12] port $PORT sudah tertutup -> dialog pairing habis. Buka lagi di HP."
    exit 1
  fi
  OUT=$(timeout 20 adb pair "$ADDR" "$CODE" 2>&1)
  if echo "$OUT" | grep -q "Successfully paired"; then
    echo "[$i/12] SUKSES: $OUT"
    echo
    echo "Menyambung ke port connect..."
    adb devices
    echo
    echo "Buka Wireless debugging (bukan Pair device) -> catat IP address & port,"
    echo "lalu jalankan:  bash ~/mcp/connect.sh"
    exit 0
  fi
  echo "[$i/12] gagal: $(echo "$OUT" | tail -1)"
  sleep 1
done

echo
echo "Gagal 12x. Kemungkinan penyebab (coba berurutan):"
echo "  1. Matikan 'Randomized MAC address' :"
echo "     Settings > WiFi > ikon gear > Privacy > Randomized MAC address > Non-persistent"
echo "  2. Pastikan WiFi debugging DAN USB debugging keduanya menyala"
echo "  3. Matikan VPN / private DNS"
echo "  4. Buka dialog pairing lagi lalu jalankan ulang script ini"
exit 1