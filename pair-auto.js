// Find open ports on the phone (pairing port changes every time) and pair.
import net from "node:net";
import { spawn } from "node:child_process";

const HOST = process.argv[2] || "192.168.100.212";
const CODE = process.argv[3];

function probe(port, timeout = 400) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeout);
    s.connect(port, HOST, () => fin(true));
    s.on("error", () => fin(false));
    s.on("timeout", () => fin(false));
  });
}

const open = [];
const ports = [];
for (let p = 34000; p <= 46000; p++) ports.push(p);

console.log(`Scanning ${HOST} ports 34000-46000 ...`);
const CONC = 400;
let i = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (i < ports.length) {
      const p = ports[i++];
      if (await probe(p)) {
        open.push(p);
        console.log(`  open: ${p}`);
      }
    }
  })
);

open.sort((a, b) => a - b);
if (!open.length) {
  console.log("Tidak ada port terbuka -> dialog pairing sudah tertutup.");
  process.exit(2);
}
console.log("Ports:", open.join(", "));

if (!CODE) {
  console.log("Buka dialog pairing lagi lalu jalankan ulang dengan kode.");
  process.exit(3);
}

for (const p of open) {
  console.log(`\nMencoba pair ke ${HOST}:${p} ...`);
  const r = await new Promise((resolve) => {
    const adb = spawn("adb", ["pair", `${HOST}:${p}`, CODE]);
    let out = "";
    adb.stdout.on("data", (d) => (out += d));
    adb.stderr.on("data", (d) => (out += d));
    adb.on("close", (c) => resolve({ code: c, out }));
  });
  console.log(r.out.trim().split("\n").pop());
  if (/Successfully paired/i.test(r.out)) {
    console.log("\nBERHASIL. Lanjut: adb connect " + HOST + ":<port-connect>");
    process.exit(0);
  }
}
console.log("\nSemua percobaan gagal.");
process.exit(1);