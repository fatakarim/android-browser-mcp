import test from "node:test";
import assert from "node:assert/strict";
import {
  PACKAGE_REGEX,
  assertValidPackage,
  sanitizeAdbInputText,
  assertValidUrl,
} from "../android/guardrails.js";

test("PACKAGE_REGEX & assertValidPackage: accepts valid Android package identifiers", () => {
  assert.equal(assertValidPackage("com.android.chrome"), "com.android.chrome");
  assert.equal(assertValidPackage("com.whatsapp"), "com.whatsapp");
  assert.equal(PACKAGE_REGEX.test("org.mozilla.firefox_beta"), true);
});

test("assertValidPackage: rejects shell metacharacters and command injection payloads", () => {
  assert.throws(() => assertValidPackage("com.android.chrome; rm -rf /"), /rejected by guardrail/);
  assert.throws(() => assertValidPackage("com.app$(whoami)"), /rejected by guardrail/);
  assert.throws(() => assertValidPackage("`id`"), /rejected by guardrail/);
});

test("sanitizeAdbInputText: neutralizes spaces and single-quote shell injection", () => {
  const safe = sanitizeAdbInputText("Hello World; $(id)");
  assert.equal(safe, "'Hello%sWorld;%s$(id)'");
});

test("assertValidUrl: enforces http/https allowlist and rejects shell metacharacters", () => {
  assert.equal(assertValidUrl("https://fatakarim.github.io"), "https://fatakarim.github.io");
  assert.throws(() => assertValidUrl("https://example.com; reboot"), /rejected by/);
  assert.throws(() => assertValidUrl("javascript:alert(1)"), /Disallowed URL scheme/);
});
