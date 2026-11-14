// Pantau port Automate; begitu terbuka, langsung tembak /health.
const PORT = process.argv[2] || "8080";
const DUR = Number(process.argv[3] || 90);

const t0 = Date.now();
let fired = false;

async function tryHealth() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await r.text();
    console.log(`\n>>> HTTP ${r.status} :: ${body.slice(0, 200)}`);
    fired = true;
    process.exit(0);
  } catch (e) {
    console.log(`  [!] ${e.message}`);
  }
}

console.log(`Memantau 127.0.0.1:${PORT} selama ${DUR}s ...`);
console.log("Jalankan flow di Automate sekarang.\n");

const iv = setInterval(async () => {
  if (fired) return;
  const el = Math.round((Date.now() - t0) / 1000);
  try {
    //只要 TCP 能连上就直接发请求
    const net = await import("node:net");
    const ok = await new Promise((res) => {
      const s = net.connect(PORT, "127.0.0.1");
      s.on("connect", () => (s.destroy(), res(true)));
      s.on("error", () => res(false));
      setTimeout(() => (s.destroy(), res(false)), 800);
    });
    if (ok) {
      console.log(`[${el}s] port terbuka! mengirim request ...`);
      clearInterval(iv);
      await tryHealth();
    }
  } catch {}
}, 700);

setTimeout(() => {
  if (!fired) {
    console.log("\nTimeout: port tidak pernah terbuka.");
    process.exit(1);
  }
}, DUR * 1000);