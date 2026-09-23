import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

function safeLabel(value) {
  const label = String(value || "browser").replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!label || label === "." || label === "..") throw new Error("browser label is invalid");
  return label.slice(0, 80);
}

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("browser output directory is unsafe");
  }
  chmodSync(path, 0o700);
}

function browserEnvironment() {
  const environment = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function loopbackPageUrl(value, ownedHttpsHostname = null) {
  if (value === "about:blank") return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("browser navigation URL is invalid");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  const ownedHttps = ownedHttpsHostname !== null && parsed.hostname === ownedHttpsHostname && parsed.protocol === "https:";
  if ((!loopback && !ownedHttps) || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error("browser navigation is restricted to loopback HTTP");
  }
  return parsed.href;
}

function boundedSignal(abortSignal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (abortSignal) signals.push(abortSignal);
  return AbortSignal.any(signals);
}

function delay(ms, abortSignal) {
  if (abortSignal?.aborted) return Promise.reject(abortSignal.reason);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish(abortSignal.reason);
    function finish(error) {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise();
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchJson(url, { method = "GET", abortSignal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(url, {
    method,
    cache: "no-store",
    signal: boundedSignal(abortSignal, timeoutMs),
  });
  if (!response.ok) throw new Error("Chromium debugging endpoint was unavailable");
  try {
    return await response.json();
  } catch {
    throw new Error("Chromium debugging endpoint returned an invalid response");
  }
}

async function waitForDebugger(port, processHandle, abortSignal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (abortSignal?.aborted) throw abortSignal.reason;
    if (processHandle.child.exitCode !== null || processHandle.child.signalCode !== null) {
      throw new Error("Chromium exited before its debugging endpoint was ready");
    }
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`, {
        abortSignal,
        timeoutMs: Math.min(750, Math.max(1, deadline - Date.now())),
      });
    } catch {
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), abortSignal);
    }
  }
  throw new Error("Chromium debugging endpoint did not become ready");
}

function validateDebuggerUrl(value, port) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Chromium returned an invalid page debugging target");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (!loopback || parsed.protocol !== "ws:" || Number(parsed.port) !== port) {
    throw new Error("Chromium page debugging target was not loopback-only");
  }
  return parsed.href;
}

class CdpConnection {
  constructor(webSocketUrl, abortSignal, timeoutMs) {
    this.abortSignal = abortSignal;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => finish(new Error("Chromium connection timed out")), timeoutMs);
      const onAbort = () => finish(abortSignal.reason);
      const onOpen = () => finish();
      const onError = () => finish(new Error("Chromium connection failed"));
      const finish = (error) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
        if (error) reject(error);
        else resolvePromise();
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.#receive(event.data));
    this.socket.addEventListener("close", () => this.#failPending("Chromium connection closed"));
    this.socket.addEventListener("error", () => this.#failPending("Chromium connection failed"));
  }

  async #receive(data) {
    try {
      const text = typeof data === "string" ? data : await data.text();
      const message = JSON.parse(text);
      if (!Number.isSafeInteger(message.id)) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending.finish(message.error ? new Error("Chromium command failed") : null, message.result);
    } catch {
      this.#failPending("Chromium returned an invalid protocol response");
    }
  }

  #failPending(message) {
    if (this.closed) return;
    for (const pending of this.pending.values()) pending.finish(new Error(message));
    this.pending.clear();
  }

  async send(method, params = {}, timeoutMs = this.timeoutMs) {
    await this.ready;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chromium connection is closed");
    }
    if (this.abortSignal?.aborted) throw this.abortSignal.reason;
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => finish(new Error("Chromium command timed out")), timeoutMs);
      const onAbort = () => finish(this.abortSignal.reason);
      const finish = (error, result) => {
        clearTimeout(timer);
        this.abortSignal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolvePromise(result);
      };
      this.pending.set(id, { finish });
      this.abortSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        finish(new Error("Chromium command could not be sent"));
      }
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.finish(new Error("Chromium connection closed"));
    this.pending.clear();
    try {
      this.socket.close();
    } catch {
      // The managed Chromium process remains the lifecycle authority.
    }
  }
}

function runtimeScriptResult(result) {
  if (result?.exceptionDetails || result?.result?.subtype === "error") {
    throw new Error("browser page operation failed");
  }
  return result?.result?.value;
}

function expressionForPredicate(predicate) {
  if (typeof predicate === "function") return `(${String(predicate)})()`;
  if (typeof predicate === "string") {
    return `Boolean(document.querySelector(${JSON.stringify(predicate)}))`;
  }
  throw new Error("browser wait target must be a selector or predicate function");
}

function assertInside(parent, child) {
  const absoluteParent = resolve(parent);
  const absoluteChild = resolve(child);
  if (!absoluteChild.startsWith(`${absoluteParent}${sep}`)) {
    throw new Error("browser output path escaped its owned directory");
  }
}

export async function beginBrowser(
  context,
  { url = "about:blank", width = 1440, height = 1000, label = "interactive", timeoutMs = DEFAULT_TIMEOUT_MS,
    ownedHttpsHostname = null, certificateSpkiSha256 = null } = {},
) {
  if (!context?.chromiumPath || !context?.tempDir || !context?.artifactDir) {
    throw new Error("interactive browser requires a complete E2E context");
  }
  if (!Number.isSafeInteger(width) || width < 320 || width > 7680 || !Number.isSafeInteger(height) || height < 240 || height > 4320) {
    throw new Error("browser dimensions are invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 120_000) {
    throw new Error("browser timeout is invalid");
  }
  if ((ownedHttpsHostname === null) !== (certificateSpkiSha256 === null)) {
    throw new Error("owned browser TLS hostname and SPKI must be supplied together");
  }
  if (ownedHttpsHostname !== null) {
    if (typeof ownedHttpsHostname !== "string" || ownedHttpsHostname !== ownedHttpsHostname.toLowerCase() ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.localowned\.test$/.test(ownedHttpsHostname)) {
      throw new Error("owned browser TLS hostname is invalid");
    }
    if (typeof certificateSpkiSha256 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(certificateSpkiSha256) ||
        Buffer.from(certificateSpkiSha256, "base64").length !== 32) {
      throw new Error("owned browser certificate SPKI digest is invalid");
    }
  }
  const ownedCookieOrigin = url === "about:blank"
    ? null
    : new URL(loopbackPageUrl(url, ownedHttpsHostname)).origin;

  const ownedLabel = safeLabel(label);
  const profile = join(context.tempDir, `chromium-interactive-${ownedLabel}`);
  const browserDir = join(context.artifactDir, "browser");
  assertInside(context.tempDir, profile);
  assertInside(context.artifactDir, browserDir);
  privateDirectory(profile);
  privateDirectory(browserDir);

  const debuggingPort = await context.allocatePort();
  const chromium = context.spawnManaged(
    `interactive Chromium ${ownedLabel}`,
    context.chromiumPath,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-domain-reliability",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      ...(ownedHttpsHostname === null ? [] : [
        `--host-resolver-rules=MAP ${ownedHttpsHostname} 127.0.0.1,EXCLUDE localhost`,
        `--ignore-certificate-errors-spki-list=${certificateSpkiSha256}`,
      ]),
      "about:blank",
    ],
    { cwd: context.repo, env: browserEnvironment() },
    `chromium-interactive-${ownedLabel}.log`,
  );

  let connection = null;
  let closed = false;
  let profileRemoved = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    connection?.close();
    try {
      await context.stopManaged(chromium, `interactive browser ${ownedLabel} close`);
    } finally {
      if (existsSync(profile)) rmSync(profile, { recursive: true, force: true });
      profileRemoved = true;
      context.state.cleanup.push({
        resource: `interactive Chromium ${ownedLabel} profile`,
        action: "delete run-owned browser profile",
        result: "removed",
      });
    }
  };
  context.registerCleanup(`interactive Chromium ${ownedLabel} profile`, close);

  try {
    await waitForDebugger(debuggingPort, chromium, context.abortSignal, timeoutMs);
    const target = await fetchJson(`http://127.0.0.1:${debuggingPort}/json/new?about%3Ablank`, {
      method: "PUT",
      abortSignal: context.abortSignal,
      timeoutMs,
    });
    if (typeof target.webSocketDebuggerUrl !== "string") {
      throw new Error("Chromium did not provide a page debugging target");
    }
    const debuggerUrl = validateDebuggerUrl(target.webSocketDebuggerUrl, debuggingPort);
    connection = new CdpConnection(debuggerUrl, context.abortSignal, timeoutMs);
    await connection.ready;
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");
    await connection.send("Network.enable");
    await connection.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const evaluate = async (expression, { evaluationTimeoutMs = timeoutMs } = {}) => {
      if (typeof expression !== "string" || expression.length === 0) {
        throw new Error("browser expression must be a non-empty string");
      }
      if (!Number.isSafeInteger(evaluationTimeoutMs) || evaluationTimeoutMs < 1 || evaluationTimeoutMs > 120_000) {
        throw new Error("browser evaluation timeout is invalid");
      }
      const result = await connection.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        timeout: evaluationTimeoutMs,
      }, evaluationTimeoutMs);
      return runtimeScriptResult(result);
    };

    const waitForExpression = async (expression, waitTimeoutMs) => {
      if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 120_000) {
        throw new Error("browser wait timeout is invalid");
      }
      const deadline = Date.now() + waitTimeoutMs;
      const signal = boundedSignal(context.abortSignal, waitTimeoutMs);
      while (true) {
        if (signal.aborted) throw new Error("browser wait timed out");
        const remaining = Math.max(1, deadline - Date.now());
        if (await evaluate(expression, { evaluationTimeoutMs: remaining })) return true;
        await delay(POLL_INTERVAL_MS, signal).catch((error) => {
          if (context.abortSignal?.aborted) throw context.abortSignal.reason;
          void error;
          throw new Error("browser wait timed out");
        });
      }
    };

    const waitFor = async (selectorOrPredicate, { waitTimeoutMs = timeoutMs } = {}) =>
      waitForExpression(expressionForPredicate(selectorOrPredicate), waitTimeoutMs);

    const setHttpOnlyCookie = async (name, value, destination) => {
      if (ownedHttpsHostname === null || ownedCookieOrigin === null) {
        throw new Error("HttpOnly browser cookies require an owned HTTPS origin");
      }
      if (typeof name !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
        throw new Error("browser cookie name is invalid");
      }
      if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[;\r\n]/.test(value)) {
        throw new Error("browser cookie value is invalid");
      }
      if (typeof destination !== "string" || destination.length === 0) {
        throw new Error("browser cookie URL is invalid");
      }
      const safeUrl = loopbackPageUrl(destination, ownedHttpsHostname);
      const parsed = new URL(safeUrl);
      if (parsed.protocol !== "https:" || parsed.hostname !== ownedHttpsHostname || parsed.origin !== ownedCookieOrigin) {
        throw new Error("browser cookie URL is outside the exact owned HTTPS origin");
      }
      const result = await connection.send("Network.setCookie", {
        name,
        value,
        url: `${parsed.origin}/`,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      });
      if (result?.success !== true) throw new Error("browser HttpOnly cookie was not accepted");
      return true;
    };

    const navigate = async (destination) => {
      const safeUrl = loopbackPageUrl(destination, ownedHttpsHostname);
      const result = await connection.send("Page.navigate", { url: safeUrl });
      if (result?.errorText) throw new Error("browser navigation failed");
      await waitFor(() => document.readyState === "complete");
    };

    const selectorOperation = async (selector, body) => {
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("browser selector must be a non-empty string");
      }
      const result = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return { ok: false };
        ${body}
        return { ok: true };
      })()`);
      if (!result?.ok) throw new Error("browser element was not found");
      return result.value;
    };

    const click = async (selector) => {
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("browser selector must be a non-empty string");
      }
      await waitForExpression(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return Boolean(element && !element.matches(":disabled") && !element.disabled &&
          element.getAttribute("aria-disabled") !== "true");
      })()`, timeoutMs);
      return selectorOperation(selector, `
        if (element.matches(":disabled") || element.disabled ||
          element.getAttribute("aria-disabled") === "true") return { ok: false };
        element.scrollIntoView({ block: "center", inline: "center" });
        element.focus();
        element.click();
      `);
    };

    const fill = async (selector, value) => {
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("browser selector must be a non-empty string");
      }
      await waitForExpression(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return Boolean(element && !element.matches(":disabled") && !element.disabled && !element.readOnly &&
          element.getAttribute("aria-disabled") !== "true");
      })()`, timeoutMs);
      return selectorOperation(selector, `
        if (element.matches(":disabled") || element.disabled || element.readOnly ||
          element.getAttribute("aria-disabled") === "true") return { ok: false };
        const value = ${JSON.stringify(String(value))};
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) return { ok: false };
        element.focus();
        setter.call(element, value);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: null }));
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      `);
    };

    const select = async (selector, value) => {
      if (typeof selector !== "string" || selector.length === 0) {
        throw new Error("browser selector must be a non-empty string");
      }
      const selectedValue = String(value);
      await waitForExpression(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return Boolean(element instanceof HTMLSelectElement && !element.matches(":disabled") && !element.disabled &&
          element.getAttribute("aria-disabled") !== "true" &&
          [...element.options].some((option) => option.value === ${JSON.stringify(selectedValue)}));
      })()`, timeoutMs);
      return selectorOperation(selector, `
        if (!(element instanceof HTMLSelectElement) || element.matches(":disabled") || element.disabled ||
          element.getAttribute("aria-disabled") === "true" ||
          ![...element.options].some((option) => option.value === ${JSON.stringify(selectedValue)})) return { ok: false };
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        if (!setter) return { ok: false };
        setter.call(element, ${JSON.stringify(selectedValue)});
        element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: null }));
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      `);
    };

    const text = (selector) => selectorOperation(selector, `
      return { ok: true, value: element.textContent ?? "" };
    `);

    const screenshot = async (shotLabel) => {
      const name = `${safeLabel(shotLabel)}.png`;
      const path = join(browserDir, name);
      assertInside(browserDir, path);
      const result = await connection.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      if (typeof result?.data !== "string") throw new Error("browser screenshot capture failed");
      const image = Buffer.from(result.data, "base64");
      if (image.length < 8 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
        throw new Error("browser screenshot was not a PNG");
      }
      writeFileSync(path, image, { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    };

    const captureDom = async (domLabel, { safe = false } = {}) => {
      if (safe !== true) throw new Error("DOM capture requires an explicit safe marker");
      const html = await evaluate(`(() => {
        const root = document.documentElement.cloneNode(true);
        root.querySelectorAll("script,noscript,template").forEach((node) => node.remove());
        root.querySelectorAll("input,textarea,option").forEach((node) => {
          node.removeAttribute("value");
          node.removeAttribute("checked");
          if (node instanceof HTMLTextAreaElement) node.textContent = "";
        });
        root.querySelectorAll("*").forEach((node) => {
          for (const attribute of [...node.attributes]) {
            if (/^(?:data-|on)/i.test(attribute.name)) node.removeAttribute(attribute.name);
            if (["href", "src", "action", "formaction"].includes(attribute.name.toLowerCase())) {
              try {
                const url = new URL(attribute.value, document.baseURI);
                url.search = "";
                url.hash = "";
                node.setAttribute(attribute.name, url.href);
              } catch {
                node.removeAttribute(attribute.name);
              }
            }
          }
        });
        return "<!doctype html>\\n" + root.outerHTML;
      })()`);
      if (typeof html !== "string") throw new Error("browser DOM capture failed");
      const path = join(browserDir, `${safeLabel(domLabel)}.html`);
      assertInside(browserDir, path);
      writeFileSync(path, context.redact(html), { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
      return path;
    };

    if (url !== "about:blank") await navigate(url);

    return Object.freeze({
      navigate,
      click,
      fill,
      select,
      text,
      waitFor,
      evaluate,
      setHttpOnlyCookie,
      screenshot,
      captureDom,
      close,
    });
  } catch (error) {
    await close();
    throw error;
  } finally {
    if (closed && !profileRemoved && existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  }
}
