#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { bridge } from "./bridge.js";
import {
  PACKAGE_REGEX,
  assertValidPackage,
  sanitizeAdbInputText,
  assertValidUrl,
  assertSafeDiagnosticShell,
} from "./guardrails.js";

const pexec = promisify(execFile);
const ADB = process.env.ADB_PATH || "adb";
// Remote setup: run this MCP on a laptop/VPS and point it at the phone.
//   ADB_TARGET=192.168.100.212:5555   -> auto `adb connect` once at startup
const ADB_TARGET = process.env.ADB_TARGET || "";
const OUT_DIR = join(tmpdir(), "android-mcp-shots");
const MAX = 8 * 1024 * 1024;

let connected = false;

async function ensureConnected() {
  if (connected || !ADB_TARGET) return;
  try {
    await adb(["connect", ADB_TARGET], { timeout: 20000 });
  } catch {}
  connected = true;
}

async function adb(args, opts = {}) {
  const { binary = false, timeout = 45000 } = opts;
  const r = await pexec(ADB, args, {
    timeout,
    maxBuffer: MAX,
    encoding: binary ? "buffer" : "utf8",
  });
  return binary ? r.stdout : r.stdout;
}

async function device() {
  await ensureConnected();
  const stdout = await adb(["devices"]);
  const lines = String(stdout).split("\n").slice(1).filter((l) => l.trim());
  const online = lines.find((l) => l.includes("\tdevice"));
  if (!online) {
    const off = lines.map((l) => l.trim()).join("; ");
    throw new Error(
      "No authorized adb device. Enable Wireless debugging on the phone, then run: adb pair <ip>:<port> with the pairing code. Current: " +
        (off || "none")
    );
  }
  return online.split("\t")[0];
}

async function sh(cmd, binary = false) {
  const d = await device();
  return adb(["-s", d, "shell", cmd], { binary });
}

// --- Local backend: works WITHOUT adb pairing -------------------------------
// Termux ships `am` and `pm`, which the Android platform allows without shell
// privileges. That covers app open/close/list but NOT tap/swipe/screenshot.
let adbReady = null;

async function hasDevice() {
  if (adbReady === null) {
    await ensureConnected();
    adbReady = await adb(["devices"])
      .then((s) => String(s).split("\n").some((l) => l.includes("\tdevice")))
      .catch(() => false);
  }
  return adbReady;
}

function local(bin, args, timeout = 30000) {
  return pexec(bin, args, { timeout, maxBuffer: MAX });
}

async function localAm(args) {
  const r = await local("am", args);
  return (r.stdout || "") + (r.stderr || "");
}

async function localPm(args) {
  const r = await local("pm", args);
  return (r.stdout || "") + (r.stderr || "");
}

function needAdb(tool) {
  return {
    content: [
      {
        type: "text",
        text:
          `${tool} butuh salah satu:\n` +
          "  A) adb over Wireless debugging (belum berhasil pairing)\n" +
          "  B) app otomatisasi + Accessibility Service\n" +
          "     Lihat docs/setup-automate.md\n" +
          "     lalu set BRIDGE_URL di config MCP.",
      },
    ],
    isError: true,
  };
}

function out(s) {
  return { content: [{ type: "text", text: String(s ?? "").slice(0, 60000) }] };
}
function err(e) {
  const m = (e && (e.stderr || e.message)) || String(e);
  return { content: [{ type: "text", text: m.slice(0, 60000) }], isError: true };
}

async function shot() {
  await mkdir(OUT_DIR, { recursive: true });
  await device();
  const remote = "/sdcard/_android_mcp_shot.png";
  const p = join(OUT_DIR, randomUUID() + ".png");
  await adb(["shell", "screencap", "-p", remote]);
  await adb(["pull", remote, p]);
  try {
    await adb(["shell", "rm", "-f", remote]);
  } catch {}
  const buf = await readFile(p);
  await unlink(p).catch(() => {});
  return {
    content: [
      { type: "image", mimeType: "image/png", data: buf.toString("base64") },
      { type: "text", text: p },
    ],
  };
}

const TOOLS = [
  {
    name: "device_info",
    description:
      "Show whether adb is paired, the device IP, and which mode is active (full vs local-only).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screen_size",
    description: "Get phone screen size and density. Use this to compute tap coordinates.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "Capture the current phone screen and return it as an image. Best first step for any UI task.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ui_dump",
    description:
      "Dump the current view hierarchy as text (nodes with text, content-desc, resource-id, bounds). Use to find exact tap targets instead of guessing coordinates.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tap",
    description: "Tap at absolute screen coordinates. Get coordinates from screenshot or ui_dump.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "swipe",
    description: "Swipe from one point to another. Use for scrolling, page swipes, back gestures.",
    inputSchema: {
      type: "object",
      properties: {
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        duration_ms: { type: "number", description: "default 300" },
      },
      required: ["x1", "y1", "x2", "y2"],
    },
  },
  {
    name: "input_text",
    description: "Type text into the focused field. Spaces must be escaped as %s.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "key_event",
    description:
      "Send a keycode. Useful ones: 4 BACK, 3 HOME, 66 ENTER, 84 SEARCH, 26 POWER. See Android keycodes list.",
    inputSchema: {
      type: "object",
      properties: { keycode: { type: "number" } },
      required: ["keycode"],
    },
  },
  {
    name: "open_app",
    description: "Launch an app by package name (com.whatsapp, com.android.chrome, ...).",
    inputSchema: {
      type: "object",
      properties: { package: { type: "string" } },
      required: ["package"],
    },
  },
  {
    name: "list_apps",
    description: "List installed packages, optionally filtered by a name substring.",
    inputSchema: {
      type: "object",
      properties: { filter: { type: "string" } },
    },
  },
  {
    name: "current_app",
    description: "Show which app is in the foreground.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "stop_app",
    description: "Force-stop a running app by package name.",
    inputSchema: {
      type: "object",
      properties: {
        package: { type: "string" },
        all_users: { type: "boolean" },
      },
      required: ["package"],
    },
  },
  {
    name: "app_info",
    description:
      "Show installed/launchable state, version, and path of an app.",
    inputSchema: {
      type: "object",
      properties: { package: { type: "string" } },
      required: ["package"],
    },
  },
  {
    name: "recent_apps",
    description: "Show recently used tasks (what has been running in the background).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "launchable_apps",
    description:
      "List apps that have a launcher icon, i.e. the ones that can actually be opened. Much shorter than list_apps.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_url",
    description: "Open a URL in the phone's default browser, or an app if a package is given.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        package: { type: "string", description: "optional app to open it in" },
      },
      required: ["url"],
    },
  },
  {
    name: "wait_and_screenshot",
    description:
      "Wait a few seconds (for an app to load) then screenshot. Use after open_app.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number" } },
    },
  },
  {
    name: "fill_field",
    description:
      "Set the text of an input field by its resource-id, then optionally submit. Combines ui_dump lookup with tap+type.",
    inputSchema: {
      type: "object",
      properties: {
        resource_id: { type: "string", description: "e.g. com.app:id/search" },
        text: { type: "string" },
        submit: { type: "boolean" },
      },
      required: ["resource_id", "text"],
    },
  },
  {
    name: "tap_text",
    description:
      "Find a UI element whose text or content-desc contains a string and tap its centre. Safer than guessing coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        exact: { type: "boolean" },
      },
      required: ["text"],
    },
  },
  {
    name: "shell",
    description:
      "Run an arbitrary adb shell command (non-interactive). Use for dumpsys, settings, pm list, etc.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "clipboard_get",
    description: "Read the device clipboard. Often easier than reading text off screen.",
    inputSchema: { type: "object", properties: {} },
  },
];

let bridgeReady = null;

async function useBridge() {
  if (bridgeReady === null) bridgeReady = await bridge.probe();
  return bridgeReady;
}

// dipakai oleh tool yang butuh kontrol layar: adb dulu, bridge kalau tidak ada
async function viaControl(fn, adbFn) {
  if (await hasDevice()) return adbFn();
  if (await useBridge()) return fn();
  return needAdb("tool ini");
}

const HANDLERS = {
  async screen_size() {
    if (!(await hasDevice())) return needAdb("screen_size");
    const size = await sh("wm size");
    const dens = await sh("wm density");
    return out((size + dens).trim());
  },
  async screenshot() {
    return viaControl(
      () => bridge.screenshot(),
      () => shot()
    );
  },
  async ui_dump() {
    if (await hasDevice()) {
      const r = await sh("uiautomator dump /dev/tty", true);
      let s = r.toString("utf8");
      const start = s.indexOf("<?xml");
      const end = s.lastIndexOf("</hierarchy>");
      if (start >= 0 && end > start) s = s.slice(start, end + 12);
      return out(s || "UI dump empty (screen may be locked or animating)");
    }
    if (await useBridge()) return out(await bridge.screenText());
    return needAdb("ui_dump");
  },
  async tap({ x, y }) {
    return viaControl(
      () => bridge.tap(x, y).then(out),
      async () => {
        await sh(`input tap ${Math.round(x)} ${Math.round(y)}`);
        return out(`tapped ${Math.round(x)},${Math.round(y)}`);
      }
    );
  },
  async swipe({ x1, y1, x2, y2, duration_ms }) {
    return viaControl(
      () => bridge.swipe(x1, y1, x2, y2, duration_ms || 300).then(out),
      async () => {
        const d = Math.round(duration_ms || 300);
        await sh(
          `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${d}`
        );
        return out(`swiped in ${d}ms`);
      }
    );
  },
  async input_text({ text }) {
    return viaControl(
      () => bridge.text(text).then(out),
      async () => {
        const safeArg = sanitizeAdbInputText(text);
        await sh(`input text ${safeArg}`);
        return out("typed: " + text);
      }
    );
  },
  async key_event({ keycode }) {
    return viaControl(
      () => bridge.key(keycode).then(out),
      async () => {
        await sh(`input keyevent ${Math.round(keycode)}`);
        return out(`keyevent ${Math.round(keycode)}`);
      }
    );
  },
  async open_app({ package: pkg }) {
    const raw = String(pkg || "").trim();
    let target = raw;
    // Allow "chrome", "Google Chrome", "com.android.chrome" -> resolve to a real package.
    if (!raw.includes(".")) {
      const clean = raw.replace(/[^\w]/g, "");
      const q = await hasDevice()
        ? await sh(
            `pm list packages | grep -iE '(^|\\.)${clean}' | head -1`
          ).catch(() => "")
        : (
            await localPm(["list", "packages"])
          )
            .split("\n")
            .map((l) => l.replace(/^package:/, "").trim())
            .filter((p) => p.toLowerCase().includes(clean.toLowerCase()))
            .slice(0, 3)
            .join("\n");
      const first = String(q).split("\n")[0] || "";
      target = first.replace("package:", "").trim();
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `no package matched "${raw}". Use list_apps or launchable_apps to find it, or pass a full package name.`,
            },
          ],
          isError: true,
        };
      }
    }
    if (!PACKAGE_REGEX.test(target)) {
      throw new Error(`Invalid Android package identifier rejected by guardrail: "${target}"`);
    }
    if (await hasDevice()) {
      await sh(`monkey -p ${target} -c android.intent.category.LAUNCHER 1`);
      return out(`launched ${target}`);
    }

    // Local mode: "am start -p" only resolves when the package exposes a
    // LAUNCHER category entry. Fall back to explicit activity names.
    const attempts = [];
    const resolved = await local("cmd", [
      "package",
      "resolve-activity",
      "--user",
      "0",
      "--brief",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
      target,
    ])
      .then((r) => {
        const line = (r.stdout || "")
          .split("\n")
          .find((l) => /^[a-zA-Z][\w.]*\//.test(l.trim()));
        return line ? line.trim() : null;
      })
      .catch(() => null);
    if (resolved) attempts.push(["-n", resolved]);

    for (const suffix of [".Main", ".ui.Launcher", ".MainActivity", ".launcher.Launcher"]) {
      attempts.push(["-n", target + suffix]);
    }

    let lastErr = "";
    for (const args of attempts) {
      const r = await localAm(["start", ...args]);
      const text = String(r);
      if (/^Error:|unable to resolve|Permission Denial|does not exist/i.test(text)) {
        lastErr = text.trim();
        continue;
      }
      return out(`launched ${args[1]} (mode lokal: tanpa adb)`);
    }
    throw new Error(
      `Tidak bisa membuka ${target}. Percobaan terakhir: ${lastErr.split("\n")[0]}`
    );
  },
  async list_apps({ filter }) {
    const r = await hasDevice()
      ? await sh("pm list packages")
      : await localPm(["list", "packages"]);
    let pkgs = String(r)
      .split("\n")
      .map((l) => l.replace(/^package:/, "").trim())
      .filter(Boolean);
    if (filter) pkgs = pkgs.filter((p) => p.includes(filter));
    return out(
      (await hasDevice() ? "" : "[mode lokal: tanpa adb] ") + pkgs.join("\n")
    );
  },
  async current_app() {
    const r = await sh(
      "dumpsys activity activities | grep -m1 -oE 'mResumedActivity/ResumedActivity' || true"
    );
    const f = await sh(
      "dumpsys window | grep -m1 -E 'mCurrentFocus|mFocusedApp' || true"
    );
    return out((r + "\n" + f).trim());
  },
  async shell({ command }) {
    const allowUnrestricted = process.env.ALLOW_UNRESTRICTED_ADB_SHELL === "true";
    const safeCmd = assertSafeDiagnosticShell(command, allowUnrestricted);
    return out(await sh(safeCmd));
  },
  async stop_app({ package: pkg, all_users }) {
    const validPkg = assertValidPackage(pkg);
    if (await hasDevice()) {
      await sh(`am force-stop ${all_users ? "--user 0 " : ""}${validPkg}`);
    } else {
      await localAm(["force-stop", validPkg]);
    }
    return out("force-stopped " + validPkg + ((await hasDevice()) ? "" : " (mode lokal)"));
  },
  async app_info({ package: pkg }) {
    const validPkg = assertValidPackage(pkg);
    const path = await sh(`pm path ${validPkg} 2>/dev/null || true`);
    const ver = await sh(`dumpsys package ${validPkg} | grep -E "versionName|versionCode" | head -2 || true`);
    const enabled = await sh(
      `pm list packages -d ${validPkg} | grep -q . && echo DISABLED || echo ENABLED`
    );
    return out((path + ver + enabled).trim());
  },
  async recent_apps() {
    const r = await sh(
      "dumpsys activity recents | grep -oE 'A=[a-zA-Z0-9_.:]+' | sort -u | head -30 || true"
    );
    return out(r.trim() || "no recent apps listed");
  },
  async launchable_apps() {
    const r = await sh(
      "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null | grep -E '^[^ ]+/' | awk '{print $1}' | sort -u"
    );
    const list = String(r).split("\n").map((s) => s.trim()).filter(Boolean);
    return out(list.length ? list.join("\n") : "none found (try: pm list packages)");
  },
  async open_url({ url, package: pkg }) {
    const safeUrl = assertValidUrl(url);
    const validPkg = pkg ? assertValidPackage(pkg) : null;
    const args = ["start", "-a", "android.intent.action.VIEW", "-d", safeUrl];
    if (validPkg) args.push(validPkg);
    const r = await hasDevice()
      ? await sh(`am start -a android.intent.action.VIEW -d '${safeUrl.replace(/'/g, "'\\''")}'${validPkg ? " " + validPkg : ""}`)
      : await localAm(args);
    if (/^Error:|unable to resolve|does not exist|Permission Denial/i.test(String(r)))
      throw new Error(String(r).trim());
    return out(`opened ${safeUrl}${validPkg ? " in " + validPkg : " (default handler)"}${(await hasDevice()) ? "" : " [mode lokal]"}`);
  },
  async device_info() {
    const has = await hasDevice();
    const br = await useBridge();
    const ip = await local("ifconfig", [])
      .then((r) => (r.stdout.match(/wlan0[\s\S]*?inet (\d+\.\d+\.\d+\.\d+)/) || [])[1] || "?")
      .catch(() => "?");
    const rel = await local("getprop", ["ro.build.version.release"])
      .then((r) => r.stdout.trim())
      .catch(() => "n/a");
    return out(
      [
        `adb connected : ${has ? "yes" : "no"}`,
        `bridge       : ${br ? "yes" : "no"} (${process.env.BRIDGE_URL || "http://127.0.0.1:7979"})`,
        `device IP     : ${ip}`,
        `android       : ${rel}`,
        has
          ? "mode         : penuh (adb)"
          : br
          ? "mode         : bridge (accessibility service)"
          : "mode         : lokal saja (buka/tutup app + URL)",
      ].join("\n")
    );
  },
  async wait_and_screenshot({ seconds }) {
    const s = Math.min(30, Math.max(0.5, Number(seconds || 2)));
    await new Promise((r) => setTimeout(r, s * 1000));
    return shot();
  },
  async fill_field({ resource_id, text, submit }) {
    if (await useBridge() && !(await hasDevice())) {
      const r = await bridge.fillField(resource_id, text);
      if (r) {
        if (submit) await bridge.key(66);
        return out(r + (submit ? " + submitted" : ""));
      }
      return {
        content: [{ type: "text", text: `no field with id "${resource_id}". Run ui_dump.` }],
        isError: true,
      };
    }
    const id = resource_id.includes("/") ? resource_id : resource_id;
    const found = await sh(
      `uiautomator dump /dev/tty 2>/dev/null || true`,
      true
    ).catch(() => Buffer.from(""));
    const xml = found.toString("utf8");
    const re = new RegExp(
      `resource-id="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
      "i"
    );
    const m = xml.match(re);
    if (!m) {
      return {
        content: [
          {
            type: "text",
            text: `no visible field with resource-id "${id}". Run ui_dump to see available ids.`,
          },
        ],
        isError: true,
      };
    }
    const cx = Math.round((Number(m[1]) + Number(m[3])) / 2);
    const cy = Math.round((Number(m[2]) + Number(m[4])) / 2);
    await sh(`input tap ${cx} ${cy}`);
    await new Promise((r) => setTimeout(r, 400));
    await sh(`input text ${sanitizeAdbInputText(text)}`);
    if (submit) {
      await new Promise((r) => setTimeout(r, 300));
      await sh("input keyevent 66");
    }
    return out(`typed into ${id} at ${cx},${cy}${submit ? " + submitted" : ""}`);
  },
  async tap_text({ text, exact }) {
    if (await useBridge() && !(await hasDevice())) {
      const r = await bridge.tapText(text);
      return r ? out(r) : {
        content: [{ type: "text", text: `no element matching "${text}". Run ui_dump.` }],
        isError: true,
      };
    }
    const found = await sh("uiautomator dump /dev/tty 2>/dev/null || true", true).catch(
      () => Buffer.from("")
    );
    const xml = found.toString("utf8");
    const needle = text.toLowerCase();
    const re = /text="([^"]*)"[^>]*content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"|text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/gi;
    let m;
    while ((m = re.exec(xml))) {
      const t = (m[1] || m[7] || "").toLowerCase();
      const cd = (m[2] || "").toLowerCase();
      const bx = exact ? [t, cd] : [t, cd].filter(Boolean);
      const hit = exact
        ? t === needle || cd === needle
        : t.includes(needle) || cd.includes(needle);
      if (!hit || bx.length === 0) continue;
      const off = m[1] !== undefined ? 3 : 7;
      const cx = Math.round((Number(m[off]) + Number(m[off + 2])) / 2);
      const cy = Math.round((Number(m[off + 1]) + Number(m[off + 3])) / 2);
      await sh(`input tap ${cx} ${cy}`);
      return out(`tapped "${text}" at ${cx},${cy}`);
    }
    return {
      content: [
        {
          type: "text",
          text: `no visible element matching "${text}". Run ui_dump to see what is on screen.`,
        },
      ],
      isError: true,
    };
  },
  async clipboard_get() {
    const s = await sh("cmd clipboard get-primary-clip 2>/dev/null || echo ''");
    return out(s.trim() || "(empty or unavailable)");
  },
};

const server = new Server(
  { name: "android-phone", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const fn = HANDLERS[name];
  if (!fn) return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  try {
    return await fn(args || {});
  } catch (e) {
    return err(e);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("android-phone MCP ready\n");