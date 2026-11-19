# 🔌 Sandboxed Model Context Protocol (MCP) Device & Browser Bridge

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![CI](https://github.com/fatakarim/android-browser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/fatakarim/android-browser-mcp/actions)
[![Protocol](https://img.shields.io/badge/Protocol-MCP_JSON--RPC_2.0-6C63FF?style=for-the-badge)](https://modelcontextprotocol.io)
[![Tools](https://img.shields.io/badge/Exposed_Tools-44_ADB_%26_CDP-10B981?style=for-the-badge)](https://github.com/fatakarim/android-browser-mcp)
[![License](https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge)](LICENSE)

A **Model Context Protocol (MCP)** JSON-RPC 2.0 `stdio` server written in Node.js that bridges AI coding assistants (Claude Desktop, Cursor, OpenCode) to physical **Android hardware via Android Debug Bridge (ADB)** and **Chromium instances via Chrome DevTools Protocol (CDP)** for deterministic End-to-End (E2E) UI verification.

---

## 🛡️ Architecture & Security Guardrails

```text
[AI Coding Assistant] ⇄ (JSON-RPC 2.0 over stdio) ⇄ [Node.js MCP Security Boundary]
                                                        ├──► Android Module (21 ADB Tools)
                                                        └──► Browser Module (23 CDP Tools)
```

1. **Parameterized Subprocess Execution:** Uses `child_process.execFile('adb', args)` without invoking a shell interpreter (`sh -c`), preventing host-side command injection when handling untrusted UI labels or DOM text.
2. **XML Accessibility Tree Resolution:** Parses `uiautomator dump` XML nodes to resolve bounding-box centroids (`tap_text`, `fill_field`) rather than fragile pixel coordinates.
3. **Strict Input Schema Validation:** Enforces JSON schema types and regex allowlists on package identifiers and keycodes.

---

## 📋 Complete 40+ MCP Tool Reference Table

### 1. Android ADB Module (`android/index.js` — 21 Tools)

| # | Tool Name | Category | Description |
| :--- | :--- | :--- | :--- |
| 1 | `device_info` | Telemetry | Inspect ADB connection status, model, Android version, and battery state |
| 2 | `screen_size` | Telemetry | Retrieve physical screen resolution and display density |
| 3 | `screenshot` | Visual Verification | Capture current Android screen buffer as PNG image |
| 4 | `wait_and_screenshot` | Visual Verification | Wait specified delay (ms) and capture screen state |
| 5 | `ui_dump` | Accessibility Tree | Dump parsed `uiautomator` XML hierarchy of all visible UI elements |
| 6 | `tap` | Interaction | Dispatch touch event at explicit `(x, y)` coordinates |
| 7 | `tap_text` | Accessibility Tree | Locate UI node by visible text/content-desc and tap its centroid |
| 8 | `fill_field` | Accessibility Tree | Locate input field by `resource-id` or label and populate text |
| 9 | `swipe` | Interaction | Execute directional swipe/scroll gesture `(x1, y1) -> (x2, y2)` |
| 10 | `input_text` | Interaction | Inject sanitized text string into focused input element |
| 11 | `key_event` | Interaction | Send Android keycode event (Home, Back, Enter, Volume, etc.) |
| 12 | `open_app` | App Lifecycle | Launch application by validated package identifier |
| 13 | `stop_app` | App Lifecycle | Force-stop running package by identifier |
| 14 | `current_app` | App Lifecycle | Inspect foreground activity and active package name |
| 15 | `app_info` | App Lifecycle | Query package version, permissions, and install metadata |
| 16 | `list_apps` | App Lifecycle | List installed packages on target device |
| 17 | `launchable_apps` | App Lifecycle | Enumerate packages exposing a MAIN/LAUNCHER intent |
| 18 | `recent_apps` | App Lifecycle | Inspect recent task stack |
| 19 | `open_url` | Intent Dispatch | Dispatch `ACTION_VIEW` intent to open URL on device |
| 20 | `clipboard_get` | System | Read device clipboard content for verification |
| 21 | `shell` | Diagnostics | Run scoped diagnostic command on target ADB device |

### 2. Chromium CDP Browser Module (`browser/index.js` — 23 Tools)

| # | Tool Name | Category | Description |
| :--- | :--- | :--- | :--- |
| 22 | `connection` | Lifecycle | Inspect CDP WebSocket connection and browser target status |
| 23 | `phone_status` | Bridge | Verify ADB port-forwarding (`tcp:9223`) to mobile Chrome DevTools socket |
| 24 | `phone_open_chrome` | Bridge | Launch Chrome on physical Android target with remote debugging ready |
| 25 | `navigate` | Navigation | Navigate active tab to target URL and await lifecycle load |
| 26 | `new_page` | Tab Management | Open new browser tab and optionally navigate to URL |
| 27 | `back` | Navigation | Navigate backward in tab history |
| 28 | `forward` | Navigation | Navigate forward in tab history |
| 29 | `reload` | Navigation | Reload current page |
| 30 | `screenshot` | Visual Verification | Capture viewport or full-page screenshot via CDP |
| 31 | `read_page` | DOM Inspection | Extract structured interactive DOM tree and visible text |
| 32 | `read_article` | DOM Inspection | Extract main readable article content from page |
| 33 | `click` | Interaction | Click DOM element matching CSS selector or text |
| 34 | `click_at` | Interaction | Dispatch mouse click at viewport `(x, y)` coordinates |
| 35 | `type` | Interaction | Focus selector and type text input |
| 36 | `select_option` | Interaction | Select `<option>` value inside `<select>` dropdown |
| 37 | `press_key` | Interaction | Dispatch keyboard key press (Enter, Escape, Tab, etc.) |
| 38 | `scroll` | Interaction | Scroll viewport or target container vertically/horizontally |
| 39 | `wait_for` | Synchronization | Await selector visibility or network idle condition |
| 40 | `evaluate` | Diagnostics | Execute JavaScript expression inside page context |
| 41 | `stealth_check` | Diagnostics | Verify browser fingerprint and navigator properties |
| 42 | `tabs` | Tab Management | List all open browser tabs and active target IDs |
| 43 | `switch_tab` | Tab Management | Switch active CDP session to specified tab index/ID |
| 44 | `close_tab` / `browser_close` | Lifecycle | Close specified tab or terminate browser instance cleanly |

---

## 🚀 Installation & MCP Configuration

```bash
git clone https://github.com/fatakarim/android-browser-mcp.git
cd android-browser-mcp
npm install --prefix android
npm install --prefix browser
```

Register in `claude_desktop_config.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "android-phone": {
      "command": "node",
      "args": ["/absolute/path/to/android-browser-mcp/android/index.js"],
      "env": { "ADB_TARGET": "192.168.1.100:5555" }
    },
    "browser-cdp": {
      "command": "node",
      "args": ["/absolute/path/to/android-browser-mcp/browser/index.js"]
    }
  }
}
```

## 👨‍💻 Author
**Fata Fatikhul Karim** — [fatakarim.github.io](https://fatakarim.github.io) • [LinkedIn](https://www.linkedin.com/in/fata-fatikhul-karim) • [HackerOne (@zeonmaltius)](https://hackerone.com/zeonmaltius)
