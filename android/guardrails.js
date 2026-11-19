/**
 * Security Guardrails for Android ADB & MCP Subprocess Execution
 * Mitigates Indirect Prompt Injection -> Host/Device Shell Command Injection
 */

export const PACKAGE_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
export const SHORT_PACKAGE_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;

// Safe read-only diagnostic commands allowed by default in the `shell` tool
export const DIAGNOSTIC_SHELL_PREFIXES = [
  "dumpsys",
  "getprop",
  "pm list",
  "pm path",
  "wm size",
  "wm density",
  "cmd package",
  "settings get",
  " settings list",
  "logcat -d",
  "ifconfig",
  "ip addr",
  "df -h",
  "uptime",
];

/**
 * Validates a full Android package identifier (e.g., com.android.chrome)
 */
export function assertValidPackage(pkg) {
  const clean = String(pkg || "").trim();
  if (!PACKAGE_REGEX.test(clean)) {
    throw new Error(`Invalid Android package identifier rejected by guardrail: "${clean}"`);
  }
  return clean;
}

/**
 * Validates and quotes a string for safe Android `input text` execution via `adb shell`
 * without allowing shell metacharacters (;, |, &, $, `, >, <, newlines) to execute.
 */
export function sanitizeAdbInputText(rawText) {
  const str = String(rawText ?? "");
  const singleLine = str.replace(/[\r\n\0]/g, " ");
  const escapedSpaces = singleLine.replace(/ /g, "%s");
  return `'${escapedSpaces.replace(/'/g, "'\\''")}'`;
}

/**
 * Validates an HTTP/HTTPS/Intent URL before passing to `am start -a android.intent.action.VIEW`
 */
export function assertValidUrl(rawUrl) {
  const str = String(rawUrl || "").trim();
  if (!str || /[\r\n\0;|&`$<>]/.test(str)) {
    throw new Error("Unsafe URL rejected by command-injection guardrail");
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    throw new Error(`Invalid URL format rejected by guardrail: "${str}"`);
  }
  if (!["http:", "https:", "mailto:", "tel:"].includes(parsed.protocol)) {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" rejected by guardrail`);
  }
  return str;
}

/**
 * Enforces a read-only diagnostic allowlist on the `shell` MCP tool by default.
 * Blocks command chaining (;, |, &, `, $(), >, <) and non-diagnostic commands
 * unless ALLOW_UNRESTRICTED_ADB_SHELL=true is explicitly set by the operator.
 */
export function assertSafeDiagnosticShell(command, allowUnrestricted = false) {
  const cmd = String(command || "").trim();
  if (!cmd) {
    throw new Error("Empty shell command rejected by guardrail");
  }
  if (allowUnrestricted) {
    return cmd;
  }
  if (/[\r\n\0;|&`$<>]/.test(cmd)) {
    throw new Error(
      "Shell metacharacters / command chaining rejected by diagnostic guardrail (set ALLOW_UNRESTRICTED_ADB_SHELL=true to override)"
    );
  }
  const lower = cmd.toLowerCase();
  const allowed = DIAGNOSTIC_SHELL_PREFIXES.some((prefix) => lower.startsWith(prefix.trim()));
  if (!allowed) {
    throw new Error(
      `Command "${cmd.split(" ")[0]}" rejected by read-only diagnostic allowlist (allowed prefixes: dumpsys, getprop, pm list, wm, settings get, logcat -d)`
    );
  }
  return cmd;
}
