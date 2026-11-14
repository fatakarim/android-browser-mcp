# Setup: Kontrol HP tanpa adb (Accessibility Bridge)

Cara ini tidak butuh pairing, tidak butuh kabel, tidak butuh root. Berjalan
di HP sendiri, jadi cocok dipakai di mana saja.

Dipakai kalau adb tidak tersedia.

---

## 1. Install app otomatisasi

Rekomendasi: **Automate** (Ollie Fritz, gratis, ada di Play Store).
Alternatif: Tasker + AutoInput (berbayar, tapi AutoInput punya TCP server
yang stabil).

Install **Automate**, lalu:
- Settings > Apps > Automate > **Battery: Unrestricted**
- Izinkan notifikasi (dipakai untuk trigger HTTP)
- Matikan optimasi battery agar tidak dibunuh di latar

---

## 2. Beri izin aksesibilitas

Settings > Accessibility > **Automate** > aktifkan.

> Peringatan: izin aksesibilitas bisa membaca SEMUA isi layar kamu,
> termasuk chat dan password. Ini konsekuensi wajib dari cara ini.
> Pilih app yang kamu percaya, dan cabut izinnya kalau tidak dipakai lagi.

---

## 3. Beri izin file (untuk screenshot)

Automate perlu bisa menulis file ke folder Download:

Automate > Settings > **Storage / File access** > allow
`/storage/emulated/0/Download`

Termux juga perlu izin baca yang sama:
```bash
termux-setup-storage
```

---

## 4. Buat 6 flow

Di Automate, buat flow baru. Untuk masing-masing:

**Trigger:** `HTTP request received`
**URI path:** (lihat tabel)

**Action:** (lihat tabel)

### Tabel flow

| URI path | Action di Automate | Parameter dari query |
|---|---|---|
| `/health` | (tanpa action, cukup reply 200) | — |
| `/ui` | *Text from screen* > loop > *Write to log* ... lihat catatan | — |
| `/tap` | *Click/Tap* di koordinat variabel | `x`, `y` |
| `/swipe` | *Swipe* | `x1`,`y1`,`x2`,`y2`,`ms` |
| `/text` | *Type text* | `data` |
| `/key` | *Send key* (Android keycode) | `code` |
| `/shot` | *Take screenshot* > simpan ke `/storage/emulated/0/Download/mcp_shot.png` | — |

### Cara mengambil parameter query

Di Automate, variabel request HTTP tersedia sebagai
`{uriQueryParameter: nama}`. Contoh untuk `/tap`:

```
URI path        : /tap
Action 1        : Click/Tap
  x             : {uriQueryParameter:x}
  y             : {uriQueryParameter:y}
```

### Cara `/ui` mengembalikan teks

Flow `/ui` harus mengembalikan isi layar ke pemanggil:

```
Action 1 : Text from screen        -> variabel {ui}
Action 2 : Loop each line in {ui}
             split per tab
             append "teks \t x \t y" ke variabel {acc}
Action 3 : Reply to HTTP request
             body = {acc}
```

Format tiap baris: `resource-id \t teks \t x \t y`

Kalau ini terlalu rumit, buat versi sederhana dulu:

```
Action 1 : Text from screen  -> {all}
Action 2 : Reply to HTTP request, body = {all}
```

Cukup untuk `ui_dump`. `tap_text` dan `fill_field` butuh format tab-di atas.

---

## 5. Tes manual

Buka Automate, pastikan tidak ada flow yang error, lalu di browser HP buka:

```
http://127.0.0.1:7979/health
```

Harus muncul halaman kosong / status 200. Kalau timeout, cek:
- Automate dalam keadaan aktif (bukan di-swipe dari recent apps)
- Izinkan battery unrestricted

---

## 6. Set config MCP

Edit `~/.config/opencode/opencode.jsonc`:

```json
"android-phone": {
  "type": "local",
  "command": ["node", "/data/data/com.termux/files/home/mcp/android/index.js"],
  "environment": {
    "BRIDGE_URL": "http://127.0.0.1:7979",
    "BRIDGE_SHOT_PATH": "/storage/emulated/0/Download/mcp_shot.png"
  },
  "enabled": true
}
```

Restart opencode, lalu cek:

```
device_info
```

Kalau `bridge : yes`, semua tool kontrol layar aktif.

---

## Tool yang jadi aktif

`screenshot`, `ui_dump`, `tap`, `tap_text`, `swipe`, `input_text`,
`key_event`, `fill_field`

---

## Keterbatasan

- `tap_text` hanya menemukan elemen yang terekspos accessibility tree.
  Tombol canvas / game 3D sering tidak terbaca. Untuk game pakai
  `screenshot` + `tap` koordinat.
- Bridge hanya jalan saat Automate aktif. Jangan swipe Automate dari
  recent apps.
- Semua action lambat (HTTP round-trip). Untukzor scroll banyak, pakai
  `swipe` berulang, bukan satu Geseran besar.