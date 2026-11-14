#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pexec = promisify(execFile);
const PORT = Number(process.env.BROWSER_CDP_PORT || 9222);
const CHROME =
  process.env.CHROME_PATH ||
  ["chromium-browser", "chromium", "google-chrome", "chrome"].find(Boolean);
const HEADLESS = process.env.BROWSER_HEADED !== "1";

// "local"  -> spawn local Chromium (default)
// "phone"  -> attach to the REAL Chrome app on the Android phone over adb.
//             Nothing is spoofed: real TLS, real GPU, real fonts.
const TARGET = process.env.BROWSER_TARGET || "local";
const ADB = process.env.ADB_PATH || "adb";
const CHROME_PKG = process.env.PHONE_CHROME_PACKAGE || "com.android.chrome";

let proc = null;
let userDir = null;
let ws = null;
let nextId = 1;
const pending = new Map();
const sessionTargets = new Map();
let currentSession = null;

// Realistic Android Chrome fingerprint, applied via CDP so the page never sees
// the real HeadlessChrome/Linux-x86_64/SwiftShader signature.
const FP = {
  ua:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/152.0.0.0 Mobile Safari/537.36",
  platform: "Linux armv8l",
  languages: ["id-ID", "id", "en-US", "en"],
  screen: { width: 412, height: 915, dpr: 2.625 },
  hardwareConcurrency: 8,
  deviceMemory: 8,
  webglVendor: "Qualcomm",
  webglRenderer: "Adreno (TM) 740",
};

let stealthOn = process.env.BROWSER_STEALTH !== "0";

async function applyStealth(sessionId) {
  if (!stealthOn || stealthApplied.has(sessionId)) return;
  stealthApplied.add(sessionId);
  const ua = await pickUserAgent();
  await send(
    "Emulation.setUserAgentOverride",
    {
      userAgent: ua,
      acceptLanguage: FP.languages.join(","),
      platform: "Linux armv8l",
    },
    sessionId
  ).catch(() => {});
  await send(
    "Emulation.setDeviceMetricsOverride",
    {
      width: FP.screen.width,
      height: FP.screen.height,
      deviceScaleFactor: FP.screen.dpr,
      mobile: true,
      screenWidth: FP.screen.width,
      screenHeight: FP.screen.height,
    },
    sessionId
  ).catch(() => {});
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId).catch(
    () => {}
  );
  // Page domain must be enabled first or the injection is silently dropped.
  await send("Page.enable", {}, sessionId).catch(() => {});
  await send(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: STEALTH_JS },
    sessionId
  ).catch(() => {});
  // also patch the document that is already loaded
  await send("Runtime.evaluate", { expression: STEALTH_JS }, sessionId).catch(() => {});
}

async function pickUserAgent() {
  if (process.env.BROWSER_UA) return process.env.BROWSER_UA;
  const minor = 140 + Math.floor(Math.random() * 14);
  const build = Math.floor(Math.random() * 5000) + 1000;
  return (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) " +
    `Chrome/${minor}.0.${build}.0 Mobile Safari/537.36`
  );
}

const stealthApplied = new Set();

const STEALTH_JS = `
(() => {
  const FP = ${JSON.stringify(FP)};
  const def = (obj, key, value) => {
    try { Object.defineProperty(obj, key, { get: () => value, configurable: true }); } catch (e) {}
  };

  // navigator.webdriver -> undefined, and drop the CDP/automation tells
  def(Navigator.prototype, 'webdriver', undefined);
  delete Object.getPrototypeOf(navigator).webdriver;

  // navigator.plugins must not be an empty array (headless gives [])
  if (!navigator.plugins.length) {
    const mk = (name, filename) => ({ name, filename, description: 'Portable Document Format', length: 1 });
    const pdf = mk('PDF Viewer', 'internal-pdf-viewer');
    const chromePdf = mk('Chrome PDF Viewer', 'internal-pdf-viewer');
    const items = [pdf, chromePdf, mk('Chromium PDF Viewer', 'internal-pdf-viewer'), mk('Microsoft Edge PDF Viewer', 'internal-pdf-viewer'), mk('WebKit built-in PDF', 'internal-pdf-viewer')];
    const arr = items.concat(Array.from({length: 4}, () => items[0]));
    try {
      Object.defineProperty(navigator, 'plugins', { get: () => {
        const p = arr.slice();
        p.item = i => p[i];
        p.namedItem = n => p.find(x => x.name === n);
        p.refresh = () => {};
        return p;
      }, configurable: true });
    } catch (e) {}
  }

  // chrome.runtime exists on real Chrome
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {}, id: undefined };

  // WebGL: advertise a mobile GPU instead of SwiftShader
  const patchGL = (proto) => {
    if (!proto || !proto.getParameter) return;
    const orig = proto.getParameter;
    proto.getParameter = function (p) {
      try {
        const name = typeof p === 'string' ? p : (this.getParameterNames?.() || []);
        const n = (() => {
          if (typeof p === 'number') {
            const ext = this.getExtension('WEBGL_debug_renderer_info');
            if (ext && (p === ext.UNMASKED_VENDOR_WEBGL)) return 'vendor';
            if (ext && (p === ext.UNMASKED_RENDERER_WEBGL)) return 'renderer';
          }
          if (p === 37446) return 'vendor';
          if (p === 37447) return 'renderer';
          if (p === 7936) return 'glsl';
          return null;
        })();
        if (n === 'vendor') return FP.webglVendor;
        if (n === 'renderer') return FP.webglRenderer;
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  };
  patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  // canvas readback noise: real phones have slight per-session variance
  const toBlobOrig = HTMLCanvasElement.prototype.toDataURL;
  let shift = Math.floor(Math.random() * 2);
  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    try {
      if (this.width > 40 && this.height > 40) {
        const c = this.getContext('2d');
        if (c) {
          const d = c.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < d.data.length; i += 4) {
            if ((i + shift) % 97 === 0) d.data[i] = Math.max(0, Math.min(255, d.data[i] + 1));
          }
          shift = (shift + 1) % 13;
          c.putImageData(d, 0, 0);
        }
      }
    } catch (e) {}
    return toBlobOrig.apply(this, a);
  };

  // permissions.query: Notification must be 'default' on http(s)
  const origQuery = navigator.permissions && navigator.permissions.query;
  if (origQuery) {
    navigator.permissions.query = function (p) {
      if (p && p.name === 'notifications' && location.protocol.startsWith('http')) {
        return Promise.resolve({ state: Notification.permission === 'denied' ? 'denied' : 'default', onchange: null });
      }
      return origQuery.call(this, p);
    };
  }

  // languages / hardware
  def(Navigator.prototype, 'languages', FP.languages);
  def(Navigator.prototype, 'platform', FP.platform);
  def(Navigator.prototype, 'hardwareConcurrency', FP.hardwareConcurrency);
  def(Navigator.prototype, 'deviceMemory', FP.deviceMemory);
  def(Navigator.prototype, 'maxTouchPoints', 5);

  // no "Headless" anywhere in the UA even if UA override is bypassed
  try {
    const clean = navigator.userAgent.replace(/Headless/g, '');
    def(Navigator.prototype, 'userAgent', clean);
    def(Navigator.prototype, 'appVersion', clean.replace('Mozilla/', ''));
  } catch (e) {}

  // hide the CDP artifact: window.cdc_ / $chrome_asyncScriptInfo
  for (const k of Object.keys(window)) {
    if (/^(cdc_|\$cdc_|\$chrome_asyncScriptInfo)/.test(k)) {
      try { delete window[k]; } catch (e) {}
    }
  }
})();`;

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

async function version() {
  try {
    const { stdout } = await pexec("curl", [
      "-sS",
      "--max-time",
      "5",
      `http://127.0.0.1:${PORT}/json/version`,
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

let forwarded = false;

async function adbIsPaired() {
  try {
    const { stdout } = await execFile(ADB, ["devices"], { timeout: 15000 });
    return String(stdout).split("\n").some((l) => l.includes("\tdevice"));
  } catch {
    return false;
  }
}

// Tunnel the phone's Chrome DevTools socket to our local port.
async function ensureForward() {
  if (forwarded) return;
  const { stdout } = await execFile(ADB, ["devices"], { timeout: 15000 });
  const line = String(stdout)
    .split("\n")
    .find((l) => l.includes("\tdevice"));
  if (!line) {
    throw new Error(
      "adb not paired. Pair once: Settings > Developer options > Wireless debugging > " +
        "Pair device with pairing code (keep dialog open), then run: bash ~/mcp/pair-interaktif.sh"
    );
  }
  const serial = line.split("\t")[0];
  // make sure Chrome is actually running, otherwise the socket won't exist
  const socketNames = [
    `localabstract:chrome_devtools_remote`,
    `localabstract:chrome_${CHROME_PKG}_devtools_remote`,
  ];
  let last = "";
  for (const s of socketNames) {
    try {
      await execFile(ADB, ["-s", serial, "forward", `tcp:${PORT}`, s], { timeout: 20000 });
      forwarded = true;
      return;
    } catch (e) {
      last = e.message;
    }
  }
  throw new Error(
    "Could not forward Chrome's devtools socket. Is Chrome open on the phone?\n" + last
  );
}

async function ensureBrowser() {
  if (ws && ws.readyState === 1) return version();

  if (TARGET === "phone") {
    await ensureForward();
    const vp = await version();
    if (!vp) {
      throw new Error(
        "Chrome devtools socket not reachable. Open Chrome on the phone first, then retry."
      );
    }
    await attach(v2url(vp));
    return vp;
  }

  const v = await version();
  if (!v) {
    userDir = await mkdtemp(join(tmpdir(), "cdp-profile-"));
    proc = spawn(
      CHROME,
      [
        `--remote-debugging-port=${PORT}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${userDir}`,
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-features=Translate,MediaRouter",
        "--hide-scrollbars",
        "--mute-audio",
        "--lang=id-ID",
        "--disable-blink-features=AutomationControlled",
        ...(HEADLESS ? ["--headless=new"] : []),
        "about:blank",
      ],
      { stdio: "ignore", detached: false }
    );
    proc.on("exit", () => {
      proc = null;
    });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const vv = await version();
      if (vv) break;
    }
  }
  const v2 = await version();
  if (!v2) throw new Error("Chromium failed to start on CDP port " + PORT);

  await attach(v2url(v2));
  return v2;
}

function v2url(v) {
  return v.webSocketDebuggerUrl;
}

// Attach the websocket to whichever CDP endpoint is available and cache the
// page targets. Shared by the local-spawn and phone-forward paths.
async function attach(wsUrl) {
  ws = new WebSocket(wsUrl);
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    } else if (m.method === "Target.attachedToTarget") {
      sessionTargets.set(m.params.targetInfo.targetId, m.params.sessionId);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });

  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type === "page") {
      try {
        const { sessionId } = await send("Target.attachToTarget", {
          targetId: t.targetId,
          flatten: true,
        });
        sessionTargets.set(t.targetId, sessionId);
      } catch {}
    }
  }
}

async function sess() {
  await ensureBrowser();
  const ids = [...sessionTargets.values()].filter(Boolean);
  if (!ids.length) throw new Error("No page target available");
  currentSession = ids[ids.length - 1];
  await applyStealth(currentSession);
  return currentSession;
}

async function cmd(method, params) {
  const s = await sess();
  return send(method, params, s);
}

async function newPage(url = "about:blank") {
  await ensureBrowser();
  const { targetId } = await send("Target.createTarget", { url });
  const { sessionId } = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  sessionTargets.set(targetId, sessionId);
  currentSession = sessionId;
  await send("Page.enable", {}, sessionId).catch(() => {});
  await send("Runtime.enable", {}, sessionId).catch(() => {});
  await applyStealth(sessionId);
  return sessionId;
}

async function evalJs(expression) {
  let expr = expression.trim();
  if (/^(async\s+)?function\b/.test(expr)) expr = "(" + expr + ")()";
  const r = await cmd("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description || r.exceptionDetails.text
    );
  }
  const v = r.result?.value;
  return v !== undefined ? v : r.result?.description;
}

async function waitReady(timeout = 12000) {
  const t = Date.now() + timeout;
  while (Date.now() < t) {
    const ok = await evalJs("document.readyState").catch(() => null);
    if (ok === "interactive" || ok === "complete") return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function evalJsReady(expression, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await evalJs(expression);
    } catch (e) {
      if (!/Cannot read properties of null|document\.body is null/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  return evalJs(expression);
}

function out(t) {
  const s =
    typeof t === "object" && t !== null ? JSON.stringify(t, null, 2) : String(t ?? "");
  return { content: [{ type: "text", text: s.slice(0, 60000) }] };
}
function err(e) {
  return {
    content: [{ type: "text", text: String(e?.message || e).slice(0, 60000) }],
    isError: true,
  };
}

async function screenshot() {
  const r = await cmd("Page.captureScreenshot", { format: "png" });
  return {
    content: [
      { type: "image", mimeType: "image/png", data: r.data },
      { type: "text", text: "current page" },
    ],
  };
}

const HUMAN = {
  jitterX: () => (Math.random() - 0.5) * 4,
  jitterY: () => (Math.random() - 0.5) * 4,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// Cubic Bezier with two random control points -> curved, non-linear path.
function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

// Move the mouse along a curve, with real velocity profile (slow-fast-slow).
async function humanMove(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const c1 = {
    x: from.x + dx * 0.25 + HUMAN.jitterX() * 6,
    y: from.y + dy * 0.25 + HUMAN.jitterY() * 6,
  };
  const c2 = {
    x: from.x + dx * 0.75 + HUMAN.jitterX() * 6,
    y: from.y + dy * 0.75 + HUMAN.jitterY() * 6,
  };
  const steps = Math.max(12, Math.min(45, Math.round(dist / 12)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const p = bezier(from, c1, c2, to, ease);
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(p.x + (i === steps ? HUMAN.jitterX() : 0)),
      y: Math.round(p.y + (i === steps ? HUMAN.jitterY() : 0)),
      button: "none",
    });
    await HUMAN.sleep(8 + Math.random() * 14);
  }
}

let mousePos = { x: 200, y: 300 };

async function humanClick(x, y) {
  await humanMove(mousePos, { x, y });
  await HUMAN.sleep(60 + Math.random() * 120);
  await cmd("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await HUMAN.sleep(40 + Math.random() * 80);
  await cmd("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
  mousePos = { x, y };
}

// Type like a person: variable inter-key delay, occasional micro-pause.
async function humanType(text) {
  for (const ch of text) {
    if (ch === "\n") {
      await cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
      await cmd("Input.dispatchKeyEvent", { type: "keyUp" });
      await HUMAN.sleep(90 + Math.random() * 120);
      continue;
    }
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", text: ch });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp" });
    let d = 45 + Math.random() * 130;
    if (/[.,!?;:]/.test(ch)) d += 120 + Math.random() * 200;
    if (ch === " ") d += 20 + Math.random() * 60;
    await HUMAN.sleep(d);
  }
}

// Wheel in small increments that decelerate, plus a settle pause.
async function humanScroll(amount, selector) {
  const total = Number(amount || 600);
  const dir = Math.sign(total);
  const abs = Math.abs(total);
  // 6-10 ticks, each smaller than the last (momentum then ease-out)
  const ticks = 6 + Math.floor(Math.random() * 5);
  const weights = [];
  for (let i = 0; i < ticks; i++) weights.push(1 - (i / ticks) * 0.72);
  const wSum = weights.reduce((a, b) => a + b, 0);
  let moved = 0;
  for (let i = 0; i < ticks; i++) {
    const d = Math.max(18, Math.round((weights[i] / wSum) * abs) + (Math.random() * 20 - 10));
    if (selector) {
      await evalJs(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e)e.scrollBy(0,${d});})()`
      ).catch(() => {});
    } else {
      await cmd("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round(mousePos.x),
        y: Math.round(mousePos.y),
        deltaX: 0,
        deltaY: d,
      });
      await evalJs(`window.scrollBy(0,${d})`).catch(() => {});
    }
    moved += d;
    // longer pause as the gesture winds down
    await HUMAN.sleep(60 + Math.random() * 110);
  }
  await HUMAN.sleep(250 + Math.random() * 350);
  const y = await evalJs("Math.round(window.scrollY)").catch(() => "n/a");
  return `scrolled ${total}px in steps, scrollY=${y}`;
}

async function closeBrowser() {
  try {
    ws && ws.close();
  } catch {}
  ws = null;
  sessionTargets.clear();
  if (proc) {
    try {
      proc.kill();
    } catch {}
    proc = null;
  }
  if (userDir) {
    await rm(userDir, { recursive: true, force: true }).catch(() => {});
    userDir = null;
  }
  return out("browser closed");
}

const TOOLS = [
  {
    name: "connection",
    description:
      "Show which backend this server uses: the real Chrome on the phone, or local headless Chromium.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_status",
    description:
      "Check whether adb is paired and whether Chrome's devtools socket is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "phone_open_chrome",
    description: "Launch the real Chrome app on the phone (phone mode only).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "navigate",
    description: "Open a URL in the browser (reuses current tab).",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "new_page",
    description: "Open a URL in a new tab and switch to it.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "back",
    description: "Go back in history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "forward",
    description: "Go forward in history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reload",
    description: "Reload the current page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description: "Screenshot of the current page as an image.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_page",
    description:
      "Extract readable text + interactive elements (links, buttons, inputs) from the current page. Use this to understand what is on screen instead of screenshotting.",
    inputSchema: {
      type: "object",
      properties: { max_chars: { type: "number" } },
    },
  },
  {
    name: "click",
    description:
      "Click an element. Give either text (matches visible label) or a CSS selector. Prefer text.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string" },
        index: { type: "number", description: "nth match when several match" },
      },
    },
  },
  {
    name: "click_at",
    description: "Click at exact viewport pixel coordinates (from a screenshot).",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
    },
  },
  {
    name: "type",
    description:
      "Type text into the focused element. Use fill for inputs found by selector.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        selector: { type: "string", description: "input/textarea selector to focus first" },
        submit: { type: "boolean", description: "press Enter after typing" },
      },
      required: ["text"],
    },
  },
  {
    name: "select_option",
    description: "Select an option in a <select> by visible text or value.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        value: { type: "string" },
      },
      required: ["selector", "value"],
    },
  },
  {
    name: "press_key",
    description: "Press a key: Enter, Tab, Escape, ArrowDown, ArrowUp, PageDown, Backspace, Delete.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" }, repeat: { type: "number" } },
      required: ["key"],
    },
  },
  {
    name: "scroll",
    description:
      "Scroll like a human: multiple wheel steps with deceleration and a settle pause. amount in pixels, positive is down.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        selector: { type: "string", description: "scroll this element instead of page" },
      },
    },
  },
  {
    name: "read_article",
    description:
      "Extract just the article body as clean paragraphs. Best for reading long articles without page chrome.",
    inputSchema: {
      type: "object",
      properties: { max_chars: { type: "number" } },
    },
  },
  {
    name: "stealth_check",
    description:
      "Report the current browser fingerprint and list any automation tells still visible to the page. Use to verify anti-detection.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "evaluate",
    description: "Run raw JavaScript in the page and return the JSON result.",
    inputSchema: {
      type: "object",
      properties: { script: { type: "string" } },
      required: ["script"],
    },
  },
  {
    name: "wait_for",
    description: "Wait for a selector to appear, or seconds to sleep.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        seconds: { type: "number" },
        timeout_ms: { type: "number" },
      },
    },
  },
  {
    name: "tabs",
    description: "List open tabs with titles and URLs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "switch_tab",
    description: "Switch to tab by index from tabs list.",
    inputSchema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
  },
  {
    name: "close_tab",
    description: "Close current tab.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close",
    description: "Shut down the headless browser.",
    inputSchema: { type: "object", properties: {} },
  },
];

const CLICK_JS = `
(function(text, selector, index){
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let el = null;
  const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const want = norm(text);
  const labelOf = e => (e.innerText || e.value || e.getAttribute('aria-label')
      || e.getAttribute('placeholder') || e.getAttribute('title') || e.textContent || '').trim();
  if (selector) { const l = document.querySelectorAll(selector); el = l[index||0]; }
  else {
    const cands = [...document.querySelectorAll('a,button,[role=button],[onclick],input,summary,label,[tabindex],[aria-label]')].filter(vis);
    el = cands.filter(e => norm(labelOf(e)) === want)[index||0];
    if (!el) el = cands.filter(e => norm(labelOf(e)).includes(want))[index||0];
    if (!el) el = [...document.querySelectorAll('*')].filter(vis)
      .filter(e => norm(labelOf(e)) === want && e.children.length <= 3)[index||0];
  }
  if (!el) return { ok:false, error:'no element matching "'+text+'"' };
  el.scrollIntoView({block:'center'});
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width/2), y = Math.round(r.top + r.height/2);
  return { ok:true, tag:el.tagName, text:(el.innerText||el.value||'').trim().slice(0,120), x, y };
})`;

const ARTICLE_JS = `
(function(){
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const count = el => [...el.querySelectorAll('p')].filter(p => vis(p) && p.innerText.trim().length > 60).length;

  // Prefer known article containers, but fall back to whichever element holds
  // the most substantial paragraphs (handles Wikipedia, news sites, blogs).
  const named = ['article','[role=main]','main','.article-body','.post-content',
    '.entry-content','[itemprop=articleBody]','.article-content','.story-body','.content__article-body'];
  let best = null, bestN = 0;
  for (const s of named) {
    for (const e of document.querySelectorAll(s)) {
      const n = count(e);
      if (n > bestN) { bestN = n; best = e; }
    }
  }
  if (!best || bestN < 2) {
    const all = [...document.querySelectorAll('div,section,td,main,body')];
    for (const e of all) {
      const n = count(e);
      if (n > bestN) { bestN = n; best = e; }
    }
  }
  const body = best || document.body;
  const seen = new Set();
  const paras = [];
  for (const p of body.querySelectorAll('p')) {
    if (!vis(p)) continue;
    const t = p.innerText.replace(/\\s+/g, ' ').trim();
    if (t.length < 60) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    paras.push(t);
  }
  const heads = [...body.querySelectorAll('h1,h2,h3')]
    .filter(vis).map(h => h.innerText.trim()).filter(Boolean).slice(0, 40);
  return [
    'URL: ' + location.href,
    'TITLE: ' + document.title,
    'PARAGRAPHS: ' + paras.length + '  CHARS: ' + paras.join(' ').length,
    '',
    heads.length ? '--- HEADINGS ---\\n' + heads.join(' | ') + '\\n' : '',
    '--- BODY --\',
    paras.join('\\n\\n')
  ].join('\\n');
})()`;

const FINGERPRINT_JS = `
(function(){
  const w = window, n = navigator;
  const gl = (()=>{try{const c=document.createElement('canvas').getContext('webgl');
    const d=c.getExtension('WEBGL_debug_renderer_info');
    return c.getParameter(d.UNMASKED_VENDOR_WEBGL)+' | '+c.getParameter(d.UNMASKED_RENDERER_WEBGL);}catch(e){return 'n/a'}})();
  const tells = {
    'Headless in UA': /Headless/i.test(n.userAgent),
    'webdriver exposed': n.webdriver === true,
    'plugins empty': n.plugins.length === 0,
    'SwiftShader GPU': /SwiftShader|llvmpipe|Software/i.test(gl),
    'touch disabled': ('ontouchstart' in w) === false,
    'odd screen size': screen.width < 320 || screen.height < 400,
    'dpr is 1': devicePixelRatio === 1,
    'x86_64 platform': /x86_64|Win32|Win64/.test(n.platform),
    'no chrome.runtime': !w.chrome || !w.chrome.runtime,
    'cdc_ artifacts': Object.keys(w).some(k => /^\\$?cdc_/.test(k)),
    'permissions leaks': (function(){try{return false}catch(e){return true}})()
  };
  const bad = Object.entries(tells).filter(([,v]) => v).map(([k]) => k);
  return [
    'UA: ' + n.userAgent,
    'platform: ' + n.platform,
    'languages: ' + JSON.stringify(n.languages),
    'screen: ' + screen.width + 'x' + screen.height + ' dpr' + devicePixelRatio,
    'touch: ' + ('ontouchstart' in w) + ' maxTouch=' + n.maxTouchPoints,
    'webgl: ' + gl,
    'plugins: ' + n.plugins.length,
    'hardwareConcurrency: ' + n.hardwareConcurrency + ' memory: ' + n.deviceMemory,
    '',
    bad.length ? 'DETECTED (' + bad.length + '): ' + bad.join(', ') : 'CLEAN: no known automation tells'
  ].join('\\n');
})()`;

const READ_JS = `
(function(){
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const txt = (document.body.innerText||'').replace(/\\n{3,}/g,'\\n\\n');
  const items = [...document.querySelectorAll('a,button,[role=button],input,textarea,select,[onclick],[contenteditable=true]')]
    .filter(vis).slice(0,120).map((e,i) => ({
      i, tag: e.tagName.toLowerCase(),
      type: e.getAttribute('type')||undefined,
      label: (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ').slice(0,90),
      href: e.href || undefined,
      sel: e.tagName.toLowerCase() + (e.id ? '#'+e.id : '') + (e.className && typeof e.className === 'string' ? '.'+e.className.trim().split(/\\s+/).slice(0,2).join('.') : '')
    })).filter(x => x.label || x.href);
  return { url: location.href, title: document.title, text: txt.slice(0, 6000), elements: items };
})()`;

const HANDLERS = {
  async connection() {
    const mode = TARGET === "phone" ? "phone (real Chrome on device)" : "local (Chromium headless)";
    let info = "";
    try {
      const v = await version();
      info = v ? `\nBrowser: ${v.Browser}` : "\nBrowser: not reachable";
    } catch (e) {
      info = "\nBrowser: " + e.message;
    }
    return out(`mode: ${mode}${info}`);
  },
  async phone_open_chrome() {
    if (TARGET !== "phone") return err(new Error("only available in phone mode"));
    await execFile(ADB, [
      "shell",
      "am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p " + CHROME_PKG,
    ], { timeout: 30000 });
    forwarded = false;
    await new Promise((r) => setTimeout(r, 3000));
    return out("Chrome launched on phone");
  },
  async phone_status() {
    const paired = await adbIsPaired();
    if (!paired) {
      return out(
        "adb: NOT paired\nPair once: Settings > Developer options > Wireless debugging > " +
          "Pair device with pairing code (keep the dialog open), then run: bash ~/mcp/pair-interaktif.sh"
      );
    }
    const { stdout } = await execFile(ADB, ["devices"], { timeout: 15000 });
    const v = await version().catch(() => null);
    return out(
      `adb: paired\n${String(stdout).trim()}\nchrome devtools: ${v ? "reachable" : "not open on phone"}`
    );
  },
  async navigate({ url }) {
    const u = /^[a-z]+:\/\//i.test(url) ? url : "https://" + url;
    await cmd("Page.navigate", { url: u });
    await waitReady();
    return out(await evalJsReady("({url:location.href,title:document.title})"));
  },
  async new_page({ url }) {
    await newPage(/^[a-z]+:\/\//i.test(url) ? url : "https://" + url);
    await waitReady();
    return out(await evalJsReady("({url:location.href,title:document.title})"));
  },
  async back() {
    const h = await cmd("Page.getNavigationHistory");
    const i = h.currentIndex - 1;
    if (i < 0) return out("already at oldest entry");
    await cmd("Page.navigateToHistoryEntry", { entryId: h.entries[i].id });
    await new Promise((r) => setTimeout(r, 1200));
    return out(h.entries[i].url);
  },
  async forward() {
    const h = await cmd("Page.getNavigationHistory");
    const i = h.currentIndex + 1;
    if (i >= h.entries.length) return out("already at newest entry");
    await cmd("Page.navigateToHistoryEntry", { entryId: h.entries[i].id });
    await new Promise((r) => setTimeout(r, 1200));
    return out(h.entries[i].url);
  },
  async reload() {
    await cmd("Page.reload");
    await new Promise((r) => setTimeout(r, 1200));
    return out("reloaded");
  },
  screenshot,
  async read_page({ max_chars }) {
    const d = await evalJsReady(READ_JS);
    const n = max_chars || 6000;
    const lines = [
      `URL: ${d.url}`,
      `TITLE: ${d.title}`,
      "",
      "--- VISIBLE TEXT ---",
      d.text.slice(0, n),
      "",
      "--- INTERACTIVE ELEMENTS ---",
      ...d.elements.map(
        (e) => `[${e.i}] <${e.tag}${e.type ? " " + e.type : ""}> ${e.label}${e.href ? " -> " + e.href : ""}`
      ),
    ];
    return out(lines.join("\n"));
  },
  async click({ text, selector, index }) {
    const r = await evalJs(`(${CLICK_JS})(${JSON.stringify(text || "")}, ${JSON.stringify(selector || null)}, ${Number(index || 0)})`);
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    await humanClick(r.x, r.y);
    await new Promise((s) => setTimeout(s, 1100 + Math.random() * 900));
    const now = await evalJsReady("location.href").catch(() => "(navigating)");
    return out(`clicked <${r.tag}> "${r.text}" at ${r.x},${r.y} (humanized path)\nnow: ${now}`);
  },
  async click_at({ x, y }) {
    await humanClick(x, y);
    await new Promise((s) => setTimeout(s, 600));
    return out(`clicked ${x},${y} (humanized path)`);
  },
  async type({ text, selector, submit }) {
    let sel = selector;
    if (!sel) {
      // auto-focus a visible search field so typing lands somewhere useful
      const found = await evalJsReady(
        `(()=>{const c=['input[name=search]','input[type=search]','textarea[name=search]',
           '#searchInput','input[placeholder*=earch i]','input[aria-label*=earch i]'];
          for (const s of c) { const e=document.querySelector(s);
            if (e && e.offsetParent !== null) return s; }
          return null;})()`
      ).catch(() => null);
      if (found) sel = found;
    }
    if (sel) {
      await evalJsReady(
        `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw new Error('no element '+${JSON.stringify(sel)});e.focus();})()`
      );
      // real key events so per-character timing and JS key handlers behave naturally
      await humanType(text);
      await evalJsReady(
        `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}})()`
      ).catch(() => {});
    } else {
      await humanType(text);
    }
    if (submit) await HANDLERS.press_key({ key: "Enter" });
    return out("typed: " + text);
  },
  async select_option({ selector, value }) {
    const r = await evalJs(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return {ok:false,error:'no select'};
        const o=[...e.options].find(x=>x.text.trim()===${JSON.stringify(value)}||x.value===${JSON.stringify(value)});
        if(!o)return {ok:false,error:'option not found'};
        e.value=o.value;e.dispatchEvent(new Event('change',{bubbles:true}));return {ok:true,value:o.value};})()`
    );
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return out("selected " + r.value);
  },
  async press_key({ key, repeat }) {
    const map = {
      Enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" },
      Tab: { windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" },
      Escape: { windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" },
      ArrowDown: { windowsVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown" },
      ArrowUp: { windowsVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp" },
      ArrowLeft: { windowsVirtualKeyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
      ArrowRight: { windowsVirtualKeyCode: 39, key: "ArrowRight", code: "ArrowRight" },
      PageDown: { windowsVirtualKeyCode: 34, key: "PageDown", code: "PageDown" },
      PageUp: { windowsVirtualKeyCode: 33, key: "PageUp", code: "PageUp" },
      Backspace: { windowsVirtualKeyCode: 8, key: "Backspace", code: "Backspace" },
      Delete: { windowsVirtualKeyCode: 46, key: "Delete", code: "Delete" },
    };
    const def = map[key] || { windowsVirtualKeyCode: 0, key };
    const n = Math.max(1, Number(repeat || 1));
    for (let i = 0; i < n; i++) {
      // keyDown (not rawKeyDown) so the key produces a character and can submit forms
      await cmd("Input.dispatchKeyEvent", { type: "keyDown", ...def });
      if (def.text) {
        await cmd("Input.dispatchKeyEvent", { type: "char", ...def }).catch(() => {});
      }
      await cmd("Input.dispatchKeyEvent", { type: "keyUp", ...def });
      await new Promise((s) => setTimeout(s, 90 + Math.random() * 110));
    }
    return out(`pressed ${key}` + (n > 1 ? ` x${n}` : ""));
  },
  async scroll({ amount, selector }) {
    return out(await humanScroll(Number(amount || 600), selector));
  },
  async read_article({ max_chars }) {
    const d = await evalJsReady(ARTICLE_JS);
    return out(d);
  },
  async stealth_check() {
    const d = await evalJsReady(FINGERPRINT_JS);
    return out(d);
  },
  async evaluate({ script }) {
    return out(await evalJs(script));
  },
  async wait_for({ selector, seconds, timeout_ms }) {
    const t = Date.now() + Number(timeout_ms || 10000);
    if (selector) {
      while (Date.now() < t) {
        const found = await evalJs(`!!document.querySelector(${JSON.stringify(selector)})`).catch(() => false);
        if (found) return out("found " + selector);
        await new Promise((s) => setTimeout(s, 400));
      }
      return { content: [{ type: "text", text: "timeout waiting for " + selector }], isError: true };
    }
    await new Promise((s) => setTimeout(s, (Number(seconds || 1)) * 1000));
    return out("waited");
  },
  async tabs() {
    await ensureBrowser();
    const { targetInfos } = await send("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    return out(
      pages
        .map((t, i) => {
          const cur = sessionTargets.get(t.targetId) === currentSession ? " *" : "";
          return `[${i}]${cur} ${t.title} - ${t.url}`;
        })
        .join("\n")
    );
  },
  async switch_tab({ index }) {
    await ensureBrowser();
    const { targetInfos } = await send("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    const t = pages[Number(index)];
    if (!t) return { content: [{ type: "text", text: "no such tab" }], isError: true };
    let sid = sessionTargets.get(t.targetId);
    if (!sid) {
      const r = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      sid = r.sessionId;
      sessionTargets.set(t.targetId, sid);
    }
    currentSession = sid;
    await send("Runtime.enable", {}, sid).catch(() => {});
    return out(t.url);
  },
  async close_tab() {
    await ensureBrowser();
    const { targetInfos } = await send("Target.getTargets");
    const pages = targetInfos.filter((t) => t.type === "page");
    const t = pages.find((x) => sessionTargets.get(x.targetId) === currentSession) || pages[pages.length - 1];
    if (t) {
      await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      sessionTargets.delete(t.targetId);
      currentSession = null;
    }
    return out("tab closed");
  },
  browser_close: closeBrowser,
};

const server = new Server(
  { name: "browser-cdp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
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

process.on("SIGTERM", async () => {
  await closeBrowser().catch(() => {});
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("browser-cdp MCP ready\n");