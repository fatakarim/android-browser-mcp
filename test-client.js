import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const serverPath = process.argv[2];
const tests = JSON.parse(readFileSync(process.argv[3], "utf8"));

const proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const waiters = [];
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      console.log("[non-json]", line.slice(0, 200));
      continue;
    }
    const w = waiters.shift();
    if (w) w(m);
  }
});

function rpc(method, params, id) {
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n"
  );
  return new Promise((resolve, reject) => {
    waiters.push(resolve);
    setTimeout(() => reject(new Error("timeout " + method)), 60000);
  });
}

for (const [i, t] of tests.entries()) {
  const id = i + 1;
  try {
    if (t.method) {
      const r = await rpc(t.method, t.params, id);
      console.log("### " + t.method + " -> " + JSON.stringify(r).slice(0, 1500));
    } else {
      const r = await rpc("tools/call", { name: t.tool, arguments: t.args ?? {} }, id);
      const c = r.result?.content?.[0];
      let text = c?.text ?? "";
      if (c?.type === "image") text = "[image " + (c.data?.length || 0) + " b64 chars]";
      console.log("### " + t.tool + " " + (r.result?.isError ? "[ERR]" : "[ok]"));
      console.log(String(text).slice(0, 900));
    }
  } catch (e) {
    console.log("### " + (t.tool || t.method) + " [THROW] " + e.message);
  }
  console.log();
}
proc.kill();
process.exit(0);