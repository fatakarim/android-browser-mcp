/**
 * Security Guardrails for Android ADB & MCP Subprocess Execution
 * Mitigates Indirect Prompt Injection -> Host/Device Shell Command Injection
 */

export const PACKAGE_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
export const SHORT_PACKAGE_REGEX = /^[a-zA-Z0-9_.-]{1,128}$/;

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
  // Reject or strip control characters and newlines
  const singleLine = str.replace(/[\r\n\0]/g, " ");
  // Escape spaces as %s for Android `input text` and POSIX-quote the argument
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
