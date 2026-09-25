import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Credentials are supplied only in CDP's response to a Basic challenge. They
// never enter a URL, Chromium command line, browser profile on disk, or trace.
export async function openBrowser({ chromiumPath, username, password, origins, onRequest, onResponse, onFailure }) {
  const profiles = fileURLToPath(new URL("../../.local/e2e-beta/", import.meta.url));
  mkdirSync(profiles, { recursive: true, mode: 0o700 });
  const profile = mkdtempSync(join(profiles, "chromium-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(chromiumPath, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--disable-background-networking", "--no-first-run", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG } });
  let socket;
  let sequence = 0;
  const pending = new Map();
  const saveResponses = new Map();
  const saveRequests = new Set();
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  try {
    let target;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Chromium exited before CDP was ready");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(300) });
        target = (await response.json()).find((item) => item.type === "page")?.webSocketDebuggerUrl;
        if (target) break;
      } catch { /* readiness poll */ }
      await delay(100);
    }
    if (!target) throw new Error("Chromium CDP readiness timed out");
    socket = new WebSocket(target);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium WebSocket timed out")), 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chromium WebSocket failed")); }, { once: true });
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chromium ${method} timed out`)); }, 20000);
      pending.set(id, (message) => { clearTimeout(timer); message.error ? reject(new Error(`Chromium ${method} failed`)) : resolve(message.result); });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
      if (message.method === "Fetch.requestPaused") {
        let permitted = false;
        try { permitted = allowed.has(new URL(message.params.request.url).origin); } catch { /* fail closed */ }
        const method = permitted ? "Fetch.continueRequest" : "Fetch.failRequest";
        const params = permitted
          ? { requestId: message.params.requestId }
          : { requestId: message.params.requestId, errorReason: "BlockedByClient" };
        void send(method, params).catch(() => {});
      }
      if (message.method === "Fetch.authRequired") {
        let permitted = false;
        try { permitted = allowed.has(new URL(message.params.request.url).origin); } catch { /* cancel auth */ }
        const response = permitted
          ? { response: "ProvideCredentials", username, password }
          : { response: "CancelAuth" };
        void send("Fetch.continueWithAuth", { requestId: message.params.requestId, authChallengeResponse: response }).catch(() => {});
      }
      if (message.method === "Network.requestWillBeSent") {
        try {
          const url = new URL(message.params.request.url);
          let expectedRevision = null;
          if (url.pathname === "/v1/portfolio/preview-revisions") {
            saveRequests.add(message.params.requestId);
            const etag = message.params.request.headers?.["If-Match"] ?? message.params.request.headers?.["if-match"];
            if (typeof etag === "string" && /^"[0-9]+"$/.test(etag)) expectedRevision = Number(etag.slice(1, -1));
          }
          onRequest?.({ requestId: message.params.requestId, origin: url.origin, path: url.pathname, method: message.params.request.method, at: new Date().toISOString(), expectedRevision });
        } catch { /* browser-internal URL */ }
      }
      if (message.method === "Network.responseReceived") {
        try {
          const url = new URL(message.params.response.url);
          const event = { requestId: message.params.requestId, origin: url.origin, path: url.pathname, status: message.params.response.status, mimeType: message.params.response.mimeType, type: message.params.type, at: new Date().toISOString() };
          onResponse?.(event);
          if (url.pathname === "/v1/portfolio/preview-revisions" && message.params.requestId) {
            saveResponses.set(message.params.requestId, event);
          }
        } catch { /* browser-internal URL */ }
      }
      if (message.method === "Network.loadingFinished") {
        const event = saveResponses.get(message.params.requestId);
        if (event) {
          saveResponses.delete(message.params.requestId);
          saveRequests.delete(message.params.requestId);
            void send("Network.getResponseBody", { requestId: message.params.requestId }).then(({ body, base64Encoded }) => {
              if (base64Encoded || body.length > 65536) return;
              let payload; try { payload = JSON.parse(body); } catch { return; }
              const issuePaths = Array.isArray(payload?.error?.details?.issues) ? payload.error.details.issues.map((issue) => issue?.path).filter((path) => typeof path === "string" && /^[a-zA-Z0-9_.\[\]-]{1,120}$/.test(path)).slice(0, 20) : [];
              onResponse?.({ ...event, safeBody: { code: typeof payload?.error?.code === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(payload.error.code) ? payload.error.code : null, issuePaths, revision: Number.isSafeInteger(payload?.revision) ? payload.revision : null, id: typeof payload?.id === "string" && /^[a-f0-9-]{36}$/.test(payload.id) ? payload.id : null } });
            }).catch(() => {});
        }
      }
      if (message.method === "Network.loadingFailed" && saveRequests.has(message.params.requestId)) { saveRequests.delete(message.params.requestId); onFailure?.({ requestId: message.params.requestId, code: String(message.params.errorText ?? "network failure").slice(0, 100), at: new Date().toISOString() }); }
    });
    await send("Page.enable");
    await send("Network.enable");
    await send("Fetch.enable", { handleAuthRequests: true });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error("Chromium page evaluation failed");
      return result.result?.value;
    };
    const wait = async (expression, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression).catch(() => false)) return;
        await delay(100);
      }
      throw new Error(`Chromium page condition timed out: ${expression.slice(0, 80)}`);
    };
    const navigate = async (url) => {
      if (!allowed.has(new URL(url).origin)) throw new Error("Chromium navigation outside configured preview origins");
      const result = await send("Page.navigate", { url });
      if (result.errorText) throw new Error("Chromium navigation failed");
      await wait(`location.href === ${JSON.stringify(new URL(url).href)} && document.readyState === 'complete'`);
      return evaluate("({url:location.origin+location.pathname,title:document.title,text:document.body?.innerText?.slice(0,12000)})");
    };
    const click = async (selector) => {
      await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled)`);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const fill = async (selector, value) => {
      await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
      await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const s=Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;s.call(e,${JSON.stringify(value)});e.dispatchEvent(new InputEvent('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    };
    return { navigate, evaluate, wait, click, fill, close: async () => {
      socket?.close(); child.kill("SIGTERM");
      for (let i = 0; i < 30 && child.exitCode === null; i++) await delay(100);
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
    } };
  } catch (error) {
    socket?.close(); child.kill("SIGKILL"); rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}
