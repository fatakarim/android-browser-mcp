# Kontrol HP dari Laptop / VPS

MCP iniivismengendalikan HP asli lewat adb: scroll, ketik, isi form, buka app,
screenshot layar, baca teks tombol.

## Isi paket

```
android/   -> 20 tool kontrol HP (butuh adb)
browser/   -> 20 tool browsing (Chromium headless + stealth)
```

## Syarat

- Node.js 20+
- adb (Android platform-tools)
- HP: Settings > Developer options > **USB debugging** ON

## Cara 1: Kabel USB (paling andal)

```bash
# di laptop
adb devices                      # pastikan HP terdeteksi "device"
adb tcpip 5555                   # sekali saja, lalu cable boleh dicabut
```

Lalu di HP buka Wireless debugging, catat `IP address & port`, dari laptop:

```bash
adb connect 192.168.100.212:5555
```

## Cara 2: Wireless (pairing sekali)

Di HP: Settings > Developer options > Wireless debugging > Pair device with
pairing code. Dari laptop:

```bash
adb pair <IP>:<port-pairing> <KODE>
adb connect <IP>:<port-connect>
```

Sekali berhasil, tidak perlu ulangi sampai HP restart.

## Install

```bash
npm install --prefix android
npm install --prefix browser
```

## Daftarkan ke opencode / Claude Desktop / Cursor

```json
{
  "mcp": {
    "android-phone": {
      "type": "local",
      "command": ["node", "/path/ke/mcp/android/index.js"],
      "environment": { "ADB_TARGET": "192.168.100.212:5555" },
      "enabled": true
    },
    "browser": {
      "type": "local",
      "command": ["node", "/path/ke/mcp/browser/index.js"],
      "enabled": true
    }
  }
}
```

`ADB_TARGET` opsional. diisi kalau HP di IP+port tertentu (remote/VPS).
Diisi dengan `-` untuk USB saja.

## Varian: Chrome ASLI di HP

Browser di HP expose DevTools socket. Kalau yang ingin dikendalikan adalah
Chrome sungguhan (fingerprint asli, anti-bot kuat), pakai mode `phone`:

```json
"phone-browser": {
  "type": "local",
  "command": ["node", "/path/ke/mcp/browser/index.js"],
  "environment": {
    "BROWSER_TARGET": "phone",
    "BROWSER_CDP_PORT": "9223",
    "ADB_TARGET": "192.168.100.212:5555"
  }
}
```

Chrome di HP harus sudah terbuka.

## Tool utama (android)

| Tool | Fungsi |
|---|---|
| `screenshot` | lihat layar HP |
| `ui_dump` | baca teks semua tombol di layar |
| `tap` / `tap_text` | ketuk koordinat / ketuk berdasarkan teks |
| `swipe` | scroll |
| `input_text` | ketik |
| `fill_field` | isi field form by resource-id |
| `open_app` / `stop_app` | buka / tutup app |
| `device_info` | cek status koneksi |

## Catatan

- `tap_text` hanya menemukan elemen yang terekspos ke accessibility tree.
  Tombol yang digambar lewat canvas atau game 3D sering tidak terbaca.
- Untuk game, pakai `screenshot` + `tap` koordinat (akurat tapi tidak tahan
  perubahan layout).
- Jangan tempelkan password di chat. Kalau perlu login, lebih baik login manual.