// Fingerprint check against a running CDP endpoint.
const url = process.argv[2] || "http://127.0.0.1:9222";

(async () => {
  const v = await (await fetch(url + "/json/version")).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 1;
  const pend = new Map();
  const send = (m, p = {}, s) => {
    const i = id++;
    ws.send(JSON.stringify({ id: i, method: m, params: p, ...(s ? { sessionId: s } : {}) }));
    return new Promise((r) => pend.set(i, r));
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  };
  await new Promise((r) => (ws.onopen = r));

  const { result: { targetInfos } } = await send("Target.getTargets");
  let page = targetInfos.find((t) => t.type === "page");
  if (!page) {
    const { result } = await send("Target.createTarget", { url: "about:blank" });
    page = { targetId: result.targetId };
  }
  const { result: { sessionId } } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });

  const expr = `JSON.stringify({
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    languages: navigator.languages,
    plugins: navigator.plugins.length,
    webgl: (function(){ try{ var c=document.createElement('canvas').getContext('webgl');
      var d=c.getExtension('WEBGL_debug_renderer_info');
      return c.getParameter(d.UNMASKED_VENDOR_WEBGL)+' | '+c.getParameter(d.UNMASKED_RENDERER_WEBGL);}catch(e){return 'n/a'}})(),
    screen: screen.width+'x'+screen.height+' dpr'+devicePixelRatio,
    touch: 'ontouchstart' in window,
    hardwareConcurrency: navigator.hardwareConcurrency
  })`;

  const r = await send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true },
    sessionId
  );
  if (r.result?.exceptionDetails) {
    console.log("ERR", JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  } else {
    console.log(r.result.result.value);
  }
  ws.close();
  process.exit(0);
})();