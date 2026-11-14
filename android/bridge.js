// HTTP bridge: kontrol HP lewat app otomatisasi + Accessibility Service.
// Dipakai kalau adb tidak tersedia. Endpoint dibuat lewat Automate (lihat
// docs/setup-automate.md) — semua request pakai GET dengan query param.
import { readFile, unlink } from "node:fs/promises";

const BASE_DEFAULT =
  process.env.BRIDGE_URL || "http://127.0.0.1:8080";
// Automate defaults to 8080; 7979 is a common alternative.
const CANDIDATES = process.env.BRIDGE_URL
  ? [process.env.BRIDGE_URL]
  : ["http://127.0.0.1:8080", "http://127.0.0.1:7979"];
let BASE = BASE_DEFAULT;
const SHOT = process.env.BRIDGE_SHOT_PATH || "/storage/emulated/0/Download/mcp_shot.png";
const TIMEOUT = Number(process.env.BRIDGE_TIMEOUT || 20000);

async function call(action, params = {}) {
  const url = new URL(action, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    const body = await r.text();
    if (!r.ok) throw new Error(`bridge ${action} -> HTTP ${r.status}: ${body.slice(0, 200)}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

export const bridge = {
  async probe() {
    for (const base of CANDIDATES) {
      try {
        const r = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(4000),
        });
        if (r.ok) {
          BASE = base;
          return true;
        }
      } catch {}
    }
    return false;
  },

  async screenText() {
    const t = await call("/ui");
    return String(t).trim();
  },

  async tap(x, y) {
    await call("/tap", { x: Math.round(x), y: Math.round(y) });
    return `tapped ${Math.round(x)},${Math.round(y)} via bridge`;
  },

  async swipe(x1, y1, x2, y2, ms = 300) {
    await call("/swipe", {
      x1: Math.round(x1), y1: Math.round(y1),
      x2: Math.round(x2), y2: Math.round(y2),
      ms: Math.round(ms),
    });
    return `swiped in ${ms}ms via bridge`;
  },

  async text(t) {
    await call("/text", { data: t });
    return "typed: " + t;
  },

  async key(code) {
    await call("/key", { code: Math.round(code) });
    return `keyevent ${code}`;
  },

  async screenshot() {
    await call("/shot");
    const buf = await readFile(SHOT);
    await unlink(SHOT).catch(() => {});
    return {
      content: [
        { type: "image", mimeType: "image/png", data: buf.toString("base64") },
        { type: "text", text: "HP (lewat bridge)" },
      ],
    };
  },

  // Ketuk elemen berdasarkan teks yang muncul di layar.
  async tapText(needle) {
    const ui = await this.screenText();
    // Format yang diharapkan dari Automate: "label<TAB>x<TAB>y" per baris
    for (const line of ui.split("\n")) {
      const [label, x, y] = line.split("\t");
      if (label && label.toLowerCase().includes(needle.toLowerCase())) {
        await this.tap(Number(x), Number(y));
        return `tapped "${label}" at ${x},${y}`;
      }
    }
    return null;
  },

  async fillField(id, text) {
    const ui = await this.screenText();
    for (const line of ui.split("\n")) {
      const [resId, label, x, y] = line.split("\t");
      if (resId === id) {
        await this.tap(Number(x), Number(y));
        await new Promise((r) => setTimeout(r, 400));
        await this.text(text);
        return `filled ${id} ("${label}")`;
      }
    }
    return null;
  },
};