#!/data/data/com.termux/files/usr/bin/bash
# Connect adb ke HP yang SUDAH di-pairing via Wireless debugging.
# Di HP: Settings > Developer options > Wireless debugging
#         (bukan "Pair device") -> lihat "IP address & port"
# Paste nilai itu di bawah.

HOST="${1:-192.168.100.210}"

echo "Mencari port connect yang aktif di $HOST ..."
# adbd memakai port acak; setelah pairing, port connect tampil di layar.
# Kita mencoba daftar umum, atau Anda bisawz paste manual.
read -r -p "Port connect (atau Enter untuk mencoba daftar umum): " PORT

if [ -n "$PORT" ]; then
  adb connect "$HOST:$PORT"
else
  echo "Mohon cek IP address & port di layar Wireless debugging."
fi

echo
adb devices