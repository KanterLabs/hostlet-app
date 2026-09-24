import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync, lstatSync, openSync, fsyncSync, closeSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";

const FIXTURE_PATH = resolve(import.meta.dirname, "../fixtures/m2-repositories.json");
const API_VERSION = "2026-03-10";
const DEFAULT_USER = Object.freeze({ id: 21001, login: "synthetic-student" });
const SECOND_USER = Object.freeze({ id: 21002, login: "synthetic-collaborator" });

function opaque(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitObjectSha(type, value) {
  const bytes = Buffer.from(value, "utf8");
  return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseJsonFixture({ fixtureData, fixturePath } = {}) {
  if (fixtureData !== undefined && fixturePath !== undefined) throw new Error("GitHub fixture accepts fixtureData or fixturePath, not both");
  const path = fixturePath ? resolve(fixturePath) : FIXTURE_PATH;
  const parsed = fixtureData === undefined ? JSON.parse(readFileSync(path, "utf8")) : cloneSafe(fixtureData);
  if (!new Set([1, 2]).has(parsed.schema_version) || !Array.isArray(parsed.repositories)) {
    throw new Error("unsupported synthetic GitHub repository fixture schema");
  }
  return { fixture: parsed, path: fixtureData === undefined ? path : null };
}

function cloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function pathMatches(configured, pathname) {
  return configured === pathname || (configured.endsWith("*") && pathname.startsWith(configured.slice(0, -1)));
}

function linkHeader(baseUrl, pathname, page, lastPage) {
  const links = [];
  if (page < lastPage) links.push(`<${baseUrl}${pathname}?page=${page + 1}&per_page=100>; rel="next"`);
  if (lastPage > 1) links.push(`<${baseUrl}${pathname}?page=${lastPage}&per_page=100>; rel="last"`);
  return links.join(", ");
}

export async function startGitHubFixture(context, { callbackUrl, fixtureData, fixturePath, gitBlobSha1 = false, stableCredentials, stateFile, listenPort = 0, previewOAuthUsers } = {}) {
  if (!context || typeof context.registerSensitiveValues !== "function") {
    throw new Error("GitHub fixture requires an E2E context with sensitive-value registration");
  }

  const parsedFixture = parseJsonFixture({ fixtureData, fixturePath });
  const fixture = parsedFixture.fixture;
  const primaryUser = Object.freeze(cloneSafe(fixture.oauth_users?.primary || DEFAULT_USER));
  const secondaryUser = Object.freeze(cloneSafe(fixture.oauth_users?.secondary || SECOND_USER));
  let previewUsers = null;
  if (previewOAuthUsers !== undefined) {
    if (!previewOAuthUsers || typeof previewOAuthUsers !== "object" || Array.isArray(previewOAuthUsers)) throw new Error("preview OAuth users must be an explicit login map");
    previewUsers = new Map();
    const userIds = new Set();
    for (const [login, candidate] of Object.entries(previewOAuthUsers)) {
      if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(login) || candidate?.login !== login ||
          !Number.isSafeInteger(candidate.id) || candidate.id <= 0 || userIds.has(candidate.id)) {
        throw new Error("preview OAuth user map has an invalid or repeated identity");
      }
      userIds.add(candidate.id);
      previewUsers.set(login, Object.freeze({ id: candidate.id, login }));
    }
    if (previewUsers.size !== 3) throw new Error("preview OAuth requires exactly three distinct owned users");
  }
  const { publicKey: generatedPublicKey, privateKey } = stableCredentials ? { privateKey: stableCredentials.privateKeyPem } : generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const publicKey = generatedPublicKey ?? createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  const appId = stableCredentials?.appId ?? 31001;
  const clientId = stableCredentials?.clientId ?? `Iv1.hostlet-${opaque(9)}`;
  const clientSecret = stableCredentials?.clientSecret ?? opaque(36);
  const webhookSecret = stableCredentials?.webhookSecret ?? opaque(40);
  const privateKeyPem = String(privateKey);
  context.registerSensitiveValues([clientSecret, webhookSecret, privateKeyPem]);
  if (parsedFixture.path) context.registerFixture?.(`${fixture.fixture_name || "synthetic GitHub"} repositories`, parsedFixture.path);

  const repositories = new Map(fixture.repositories.map((repository) => [repository.id, cloneSafe(repository)]));
  const originalRepositories = cloneSafe(fixture.repositories);
  const observations = [];
  const oauthCodes = new Map();
  const userTokens = new Map();
  if (stateFile && existsSync(stateFile)) {
    const stat = lstatSync(stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("persistent provider state must be a private regular file");
    const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
    if (persisted.schema !== "hostlet.beta.synthetic-provider/v1" || !Array.isArray(persisted.userTokens)) throw new Error("invalid persistent provider state");
    for (const entry of persisted.userTokens) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
          !Number.isFinite(entry[1]?.expiresAt) || typeof entry[1]?.user?.id !== "number") throw new Error("invalid persistent provider token state");
      userTokens.set(entry[0], entry[1]);
    }
  }
  function persistTokens() {
    if (!stateFile) return;
    const tmp = `${stateFile}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema: "hostlet.beta.synthetic-provider/v1", userTokens: [...userTokens] })}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    const handle = openSync(tmp, "r");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(tmp, stateFile);
  }
  const installationTokens = new Map();
  const oauthQueue = [];
  const deniedRepositories = new Set();
  const usersWithInstallation = new Set([primaryUser.id, secondaryUser.id, ...(previewUsers ? [...previewUsers.values()].map((user) => user.id) : [])]);
  let grantedRepositoryIds = new Set(repositories.keys());
  let installationRevoked = false;
  let installationSuspended = false;
  let contentsPermission = "read";
  let wrongTokenMode = false;
  let userIdentityOverride = null;
  let treeTruncated = false;
  let invalidBlobEncoding = false;
  let binaryBlob = false;
  let blobShaMismatch = false;
  let extraTreeEntries = [];
  let expectedCallbackUrl = callbackUrl || null;
  let closed = false;
  let unexpectedRequests = 0;
  let installationTokenSequence = 0;
  const rateLimits = [];
  const delays = [];
  const forcedFaults = [];
  const oversize = new Map();
  const pagination = new Map();

  function latestInstallationToken(repositoryId) {
    const expectedRepositoryId = repositoryId === undefined ? null : Number(repositoryId);
    return [...installationTokens.entries()]
      .filter(([, token]) => expectedRepositoryId === null || token.repositoryId === expectedRepositoryId)
      .sort((left, right) => right[1].issuedSequence - left[1].issuedSequence)[0] || null;
  }

  function verifyIssuedInstallationCredential({ repositoryId, minimumUses = 1 } = {}) {
    if (repositoryId !== undefined && !Number.isSafeInteger(Number(repositoryId))) {
      throw new Error("installation credential verifier requires a numeric repository id");
    }
    if (!Number.isSafeInteger(minimumUses) || minimumUses < 0) {
      throw new Error("installation credential verifier requires a non-negative use count");
    }
    const issued = latestInstallationToken(repositoryId);
    if (!issued) throw new Error("no actual synthetic installation credential was issued");
    const [value, token] = issued;
    if (token.useCount < minimumUses) {
      throw new Error(`synthetic installation credential was issued but not used enough times (uses=${token.useCount})`);
    }
    return Object.freeze({
      issued: true,
      synthetic: true,
      repositoryId: token.repositoryId,
      installationId: token.installationId,
      permissions: Object.freeze({ ...token.permissions }),
      useCount: token.useCount,
      tokenDigest: `sha256:${sha256(value)}`,
    });
  }

  const environment = {
    HOSTLET_GITHUB_PROVIDER: "synthetic_loopback",
    HOSTLET_GITHUB_APP_ID: String(appId),
    HOSTLET_GITHUB_CLIENT_ID: clientId,
    HOSTLET_GITHUB_CLIENT_SECRET: clientSecret,
    HOSTLET_GITHUB_PRIVATE_KEY_PEM: privateKeyPem,
    HOSTLET_GITHUB_WEBHOOK_SECRET: webhookSecret,
    HOSTLET_GITHUB_CALLBACK_URL: expectedCallbackUrl || "",
    HOSTLET_GITHUB_API_VERSION: API_VERSION,
  };

  function observe(method, pathname, authKind, status, extra = {}) {
    observations.push(Object.freeze({
      sequence: observations.length + 1,
      method,
      path: pathname,
      authKind,
      status,
      ...extra,
    }));
  }

  function sendJson(response, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(body);
  }

  function sendRedirect(response, location) {
    response.writeHead(302, { Location: location, "Cache-Control": "no-store", "Content-Length": "0" });
    response.end();
  }

  async function readBody(request, limit = 128 * 1024) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error("request body exceeded fixture limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function requestAuth(request) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") return { kind: "none", credential: null };
    const matched = /^(Bearer|token) (\S+)$/i.exec(authorization);
    if (!matched) return { kind: "malformed", credential: null };
    const credential = matched[2];
    if (userTokens.has(credential)) return { kind: "user", credential };
    if (installationTokens.has(credential)) return { kind: "installation", credential };
    if (credential.split(".").length === 3) return { kind: "app_jwt", credential };
    return { kind: "unknown", credential: null };
  }

  function requireApiHeaders(request, response, pathname, authKind) {
    const accept = request.headers.accept || "";
    const version = request.headers["x-github-api-version"];
    const userAgent = request.headers["user-agent"];
    if (!String(accept).includes("application/vnd.github+json") || version !== API_VERSION || !userAgent) {
      observe(request.method, pathname, authKind, 400, { outcome: "required_headers_missing" });
      sendJson(response, 400, { message: "required GitHub API headers missing" });
      return false;
    }
    return true;
  }

  function validUserToken(credential) {
    const token = userTokens.get(credential);
    return token && token.expiresAt > Date.now() && !token.revoked ? token : null;
  }

  function validInstallationToken(credential, repositoryId) {
    const token = installationTokens.get(credential);
    const valid = token && token.expiresAt > Date.now() && token.repositoryId === repositoryId &&
      token.installationId === fixture.installation.id && token.permissions.contents === "read" &&
      !installationRevoked && !installationSuspended && !deniedRepositories.has(repositoryId)
      ? token
      : null;
    if (valid) valid.useCount += 1;
    return valid;
  }

  function verifyAppJwt(jwt) {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    try {
      const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const now = Math.floor(Date.now() / 1000);
      const signatureOk = verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        publicKey,
        Buffer.from(parts[2], "base64url"),
      );
      return header.alg === "RS256" && signatureOk && String(claims.iss) === clientId &&
        Number.isInteger(claims.iat) && Number.isInteger(claims.exp) &&
        claims.iat <= now + 60 && claims.iat >= now - 600 && claims.exp > now && claims.exp <= now + 600;
    } catch {
      return false;
    }
  }

  function repositorySummary(repository) {
    return {
      id: repository.id,
      node_id: `R_${repository.id}`,
      name: repository.name,
      full_name: `${fixture.owner.login}/${repository.name}`,
      private: repository.private,
      owner: { login: fixture.owner.login, id: fixture.owner.id, type: "User" },
      default_branch: repository.default_branch,
      permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    };
  }

  function repositoryByPath(owner, name) {
    if (owner !== fixture.owner.login) return null;
    return [...repositories.values()].find((repository) => repository.name === name) || null;
  }

  function commitFor(repository, sha) {
    return repository.commits[sha] || null;
  }

  function blobsFor(repository, commit) {
    const result = new Map();
    for (const [path, content] of Object.entries(commit.files)) {
      const bytes = Buffer.from(content, "utf8");
      const framed = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
      const blobSha = gitBlobSha1 ? createHash("sha1").update(framed).digest("hex") : sha256(framed).slice(0, 40);
      result.set(blobSha, { path, content, size: bytes.length });
    }
    return result;
  }

  async function injectFault(request, response, pathname, authKind) {
    const forced = forcedFaults.find((fault) => fault.remaining > 0 && pathMatches(fault.path, pathname));
    if (forced) {
      forced.remaining -= 1;
      observe(request.method, pathname, authKind, forced.status, { outcome: "injected_denial" });
      sendJson(response, forced.status, { message: "synthetic provider denial" });
      return true;
    }
    const rateLimit = rateLimits.find((fault) => fault.remaining > 0 && pathMatches(fault.path, pathname));
    if (rateLimit) {
      rateLimit.remaining -= 1;
      observe(request.method, pathname, authKind, 429, { outcome: "injected_rate_limit" });
      sendJson(response, 429, { message: "synthetic rate limit" }, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
        "X-RateLimit-Remaining": "0",
      });
      return true;
    }
    const delay = delays.find((fault) => fault.remaining > 0 && pathMatches(fault.path, pathname));
    if (delay) {
      delay.remaining -= 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay.delayMs));
    }
    return false;
  }

  const server = createServer(async (request, response) => {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const auth = requestAuth(request);

    try {
      if (await injectFault(request, response, pathname, auth.kind)) return;

      if (method === "GET" && pathname === "/login/oauth/authorize") {
        const state = url.searchParams.get("state");
        const challenge = url.searchParams.get("code_challenge");
        const redirectUri = url.searchParams.get("redirect_uri");
        if (state) context.registerSensitiveValues([state]);
        if (challenge) context.registerSensitiveValues([challenge]);
        const requestedPreviewUser = previewUsers?.get(url.searchParams.get("hostlet_preview_login"));
        const next = previewUsers ? { mode: "success", user: requestedPreviewUser } : oauthQueue.shift() || { mode: "success", user: primaryUser };
        const valid = url.searchParams.get("client_id") === clientId && redirectUri === expectedCallbackUrl &&
          typeof state === "string" && state.length >= 32 && typeof challenge === "string" && challenge.length >= 32 &&
          url.searchParams.get("code_challenge_method") === "S256" && (!previewUsers || requestedPreviewUser !== undefined);
        if (!valid) {
          observe(method, pathname, "none", 400, { outcome: "oauth_request_rejected" });
          sendJson(response, 400, { error: "invalid_request" });
          return;
        }
        const target = new URL(redirectUri);
        target.searchParams.set("state", state);
        if (next.mode === "deny") {
          target.searchParams.set("error", "access_denied");
          target.searchParams.set("error_description", "The resource owner denied the request");
          observe(method, pathname, "none", 302, { outcome: "oauth_denied" });
          sendRedirect(response, target.toString());
          return;
        }
        const code = opaque(30);
        context.registerSensitiveValues([code]);
        oauthCodes.set(code, {
          challenge,
          redirectUri,
          user: next.user,
          expiresAt: next.mode === "expired" ? Date.now() - 1 : Date.now() + 5 * 60_000,
          used: false,
        });
        target.searchParams.set("code", code);
        observe(method, pathname, "none", 302, { outcome: "oauth_code_issued" });
        sendRedirect(response, target.toString());
        return;
      }

      if (method === "POST" && pathname === "/login/oauth/access_token") {
        const rawBody = await readBody(request);
        const contentType = request.headers["content-type"] || "";
        let body;
        if (String(contentType).includes("application/json")) body = JSON.parse(rawBody);
        else body = Object.fromEntries(new URLSearchParams(rawBody));
        if (body.code) context.registerSensitiveValues([String(body.code)]);
        if (body.code_verifier) context.registerSensitiveValues([String(body.code_verifier)]);
        const record = oauthCodes.get(body.code);
        const verifierChallenge = body.code_verifier
          ? createHash("sha256").update(String(body.code_verifier)).digest("base64url")
          : null;
        if (body.client_id !== clientId || body.client_secret !== clientSecret || !record || record.used ||
          record.expiresAt <= Date.now() || record.redirectUri !== body.redirect_uri || verifierChallenge !== record.challenge) {
          observe(method, pathname, "client_secret", 400, { outcome: "oauth_exchange_rejected" });
          sendJson(response, 400, { error: "bad_verification_code" });
          return;
        }
        record.used = true;
        const accessToken = opaque(43);
        context.registerSensitiveValues([accessToken]);
        userTokens.set(accessToken, { user: record.user, expiresAt: Date.now() + 8 * 60 * 60_000, revoked: false });
        persistTokens();
        observe(method, pathname, "client_secret", 200, { outcome: "oauth_token_issued" });
        sendJson(response, 200, {
          access_token: accessToken,
          token_type: "bearer",
          scope: "",
          expires_in: 28_800,
        });
        return;
      }

      if (!requireApiHeaders(request, response, pathname, auth.kind)) return;

      if (method === "GET" && pathname === "/user") {
        const token = validUserToken(auth.credential);
        if (!token) {
          observe(method, pathname, auth.kind, 401, { outcome: "user_token_rejected" });
          sendJson(response, 401, { message: "Bad credentials" });
          return;
        }
        const user = userIdentityOverride || token.user;
        observe(method, pathname, "user", 200, { outcome: "current_user" });
        sendJson(response, 200, { id: user.id, login: user.login, type: "User" });
        return;
      }

      if (method === "GET" && pathname === "/user/installations") {
        const token = validUserToken(auth.credential);
        if (!token) {
          observe(method, pathname, auth.kind, 401, { outcome: "user_token_rejected" });
          sendJson(response, 401, { message: "Bad credentials" });
          return;
        }
        const visible = !installationRevoked && usersWithInstallation.has(token.user.id);
        const all = visible ? [{
          id: fixture.installation.id,
          app_id: appId,
          account: { login: fixture.owner.login, id: fixture.owner.id, type: "User" },
          repository_selection: fixture.installation.repository_selection,
          permissions: { contents: contentsPermission, metadata: "read" },
          suspended_at: installationSuspended ? new Date().toISOString() : null,
        }] : [];
        const pageSize = pagination.get("installations") || 100;
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const pageItems = all.slice((page - 1) * pageSize, page * pageSize);
        const lastPage = Math.max(1, Math.ceil(all.length / pageSize));
        const headers = page < lastPage ? { Link: linkHeader(baseUrl, pathname, page, lastPage) } : {};
        observe(method, pathname, "user", 200, { outcome: "installations_listed", page });
        sendJson(response, 200, { total_count: all.length, installations: pageItems }, headers);
        return;
      }

      const repositoryListMatch = /^\/user\/installations\/(\d+)\/repositories$/.exec(pathname);
      if (method === "GET" && repositoryListMatch) {
        const token = validUserToken(auth.credential);
        const installationId = Number(repositoryListMatch[1]);
        if (!token) {
          observe(method, pathname, auth.kind, 401, { outcome: "user_token_rejected" });
          sendJson(response, 401, { message: "Bad credentials" });
          return;
        }
        if (installationId !== fixture.installation.id || installationRevoked || installationSuspended ||
          !usersWithInstallation.has(token.user.id)) {
          observe(method, pathname, "user", 404, { outcome: "installation_unavailable" });
          sendJson(response, 404, { message: "Not Found" });
          return;
        }
        const all = [...grantedRepositoryIds]
          .filter((id) => repositories.has(id) && !deniedRepositories.has(id))
          .map((id) => repositorySummary(repositories.get(id)));
        const pageSize = pagination.get("repositories") || 100;
        const page = Math.max(1, Number(url.searchParams.get("page") || 1));
        const pageItems = all.slice((page - 1) * pageSize, page * pageSize);
        const lastPage = Math.max(1, Math.ceil(all.length / pageSize));
        const headers = page < lastPage ? { Link: linkHeader(baseUrl, pathname, page, lastPage) } : {};
        observe(method, pathname, "user", 200, { outcome: "repositories_listed", page });
        sendJson(response, 200, { total_count: all.length, repositories: pageItems }, headers);
        return;
      }

      const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
      if (method === "POST" && tokenMatch) {
        const installationId = Number(tokenMatch[1]);
        const body = JSON.parse(await readBody(request));
        const requestedRepositoryIds = Array.isArray(body.repository_ids) ? body.repository_ids : [];
        const requestedPermissions = body.permissions && typeof body.permissions === "object" ? body.permissions : {};
        const requestedScopes = {
          repositoryIds: requestedRepositoryIds.map(Number),
          permissions: Object.fromEntries(Object.entries(requestedPermissions).sort(([left], [right]) => left.localeCompare(right))),
        };
        const repositoryId = requestedScopes.repositoryIds[0];
        const narrow = requestedScopes.repositoryIds.length === 1 && Object.keys(requestedPermissions).length === 1 &&
          requestedPermissions.contents === "read";
        if (!verifyAppJwt(auth.credential || "") || installationId !== fixture.installation.id || installationRevoked ||
          installationSuspended || !new Set(["read", "write"]).has(contentsPermission) || !narrow || !grantedRepositoryIds.has(repositoryId) ||
          deniedRepositories.has(repositoryId)) {
          observe(method, pathname, auth.kind, narrow ? 403 : 422, {
            outcome: narrow ? "installation_token_denied" : "installation_token_scope_rejected",
            requestedScopes,
          });
          sendJson(response, narrow ? 403 : 422, { message: "installation token request denied" });
          return;
        }
        const installationToken = opaque(57);
        context.registerSensitiveValues([installationToken]);
        installationTokens.set(installationToken, {
          installationId,
          repositoryId: wrongTokenMode ? -1 : repositoryId,
          permissions: { contents: "read" },
          expiresAt: Date.now() + 60 * 60_000,
          issuedSequence: ++installationTokenSequence,
          useCount: 0,
        });
        observe(method, pathname, "app_jwt", 201, {
          outcome: "installation_token_issued",
          requestedScopes,
        });
        sendJson(response, 201, {
          token: installationToken,
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "read" },
          repository_selection: "selected",
        });
        return;
      }

      const repositoryMatch = /^\/repositories\/(\d+)$/.exec(pathname);
      if (method === "GET" && repositoryMatch) {
        const repositoryId = Number(repositoryMatch[1]);
        const repository = repositories.get(repositoryId);
        if (!repository || !validInstallationToken(auth.credential, repositoryId)) {
          observe(method, pathname, auth.kind, 404, { outcome: "repository_unavailable" });
          sendJson(response, 404, { message: "Not Found" });
          return;
        }
        observe(method, pathname, "installation", 200, { outcome: "repository_read", repositoryId });
        sendJson(response, 200, repositorySummary(repository));
        return;
      }

      const repoRoute = /^\/repos\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
      if (repoRoute) {
        const owner = decodeURIComponent(repoRoute[1]);
        const name = decodeURIComponent(repoRoute[2]);
        const suffix = repoRoute[3];
        const repository = repositoryByPath(owner, name);
        if (!repository || !validInstallationToken(auth.credential, repository.id)) {
          observe(method, pathname, auth.kind, 404, { outcome: "repository_unavailable" });
          sendJson(response, 404, { message: "Not Found" });
          return;
        }

        if (method === "GET" && suffix === "branches") {
          const all = Object.entries(repository.branches).map(([nameValue, sha]) => ({
            name: nameValue,
            commit: { sha, url: `${baseUrl}/repos/${owner}/${name}/git/commits/${sha}` },
            protected: false,
          }));
          const pageSize = pagination.get("branches") || 100;
          const page = Math.max(1, Number(url.searchParams.get("page") || 1));
          const pageItems = all.slice((page - 1) * pageSize, page * pageSize);
          const lastPage = Math.max(1, Math.ceil(all.length / pageSize));
          const headers = page < lastPage ? { Link: linkHeader(baseUrl, pathname, page, lastPage) } : {};
          observe(method, pathname, "installation", 200, { outcome: "branches_listed", repositoryId: repository.id, page });
          sendJson(response, 200, pageItems, headers);
          return;
        }

        const refMatch = /^git\/ref\/heads\/(.+)$/.exec(suffix);
        if (method === "GET" && refMatch) {
          const branch = decodeURIComponent(refMatch[1]);
          const commitSha = repository.branches[branch];
          if (!commitSha) {
            observe(method, pathname, "installation", 404, { outcome: "ref_unavailable", repositoryId: repository.id });
            sendJson(response, 404, { message: "Not Found" });
            return;
          }
          observe(method, pathname, "installation", 200, { outcome: "ref_read", repositoryId: repository.id });
          sendJson(response, 200, {
            ref: `refs/heads/${branch}`,
            node_id: `REF_${repository.id}_${branch}`,
            url: `${baseUrl}/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branch)}`,
            object: { type: "commit", sha: commitSha, url: `${baseUrl}/repos/${owner}/${name}/git/commits/${commitSha}` },
          });
          return;
        }

        const commitMatch = /^git\/commits\/([0-9a-f]{40})$/.exec(suffix);
        if (method === "GET" && commitMatch) {
          const commit = commitFor(repository, commitMatch[1]);
          if (!commit) {
            observe(method, pathname, "installation", 404, { outcome: "commit_unavailable", repositoryId: repository.id });
            sendJson(response, 404, { message: "Not Found" });
            return;
          }
          observe(method, pathname, "installation", 200, { outcome: "commit_read", repositoryId: repository.id });
          sendJson(response, 200, {
            sha: commitMatch[1],
            node_id: `COMMIT_${commitMatch[1]}`,
            url: `${baseUrl}/repos/${owner}/${name}/git/commits/${commitMatch[1]}`,
            tree: { sha: commit.tree, url: `${baseUrl}/repos/${owner}/${name}/git/trees/${commit.tree}` },
            message: commit.message,
          });
          return;
        }

        const treeMatch = /^git\/trees\/([0-9a-f]{40})$/.exec(suffix);
        if (method === "GET" && treeMatch) {
          const entry = Object.entries(repository.commits).find(([, commit]) => commit.tree === treeMatch[1]);
          if (!entry) {
            observe(method, pathname, "installation", 404, { outcome: "tree_unavailable", repositoryId: repository.id });
            sendJson(response, 404, { message: "Not Found" });
            return;
          }
          const [, commit] = entry;
          const blobs = blobsFor(repository, commit);
          const tree = [...blobs.entries()].map(([blobSha, blob]) => ({
            path: blob.path,
            mode: "100644",
            type: "blob",
            sha: blobSha,
            size: oversize.get(`${repository.id}:${blob.path}`) || blob.size,
            url: `${baseUrl}/repos/${owner}/${name}/git/blobs/${blobSha}`,
          })).concat(extraTreeEntries.map((extra) => ({
            path: extra.path,
            mode: extra.mode,
            type: extra.type,
            sha: extra.sha,
            ...(extra.size === undefined ? {} : { size: extra.size }),
            url: `${baseUrl}/repos/${owner}/${name}/git/${extra.type === "blob" ? "blobs" : "trees"}/${extra.sha}`,
          })));
          observe(method, pathname, "installation", 200, { outcome: "tree_read", repositoryId: repository.id, recursive: url.searchParams.get("recursive") === "1" });
          sendJson(response, 200, { sha: treeMatch[1], url: `${baseUrl}${pathname}`, tree, truncated: treeTruncated });
          return;
        }

        const blobMatch = /^git\/blobs\/([0-9a-f]{40})$/.exec(suffix);
        if (method === "GET" && blobMatch) {
          let blob = null;
          for (const commit of Object.values(repository.commits)) {
            blob = blobsFor(repository, commit).get(blobMatch[1]) || blob;
          }
          if (!blob) {
            const injected = extraTreeEntries.find((entry) => entry.type === "blob" && entry.sha === blobMatch[1] && entry.content !== undefined);
            if (injected) blob = { path: injected.path, content: injected.content, size: injected.size };
          }
          if (!blob) {
            observe(method, pathname, "installation", 404, { outcome: "blob_unavailable", repositoryId: repository.id });
            sendJson(response, 404, { message: "Not Found" });
            return;
          }
          let bytes = Buffer.from(blob.content, "utf8");
          const forcedBytes = oversize.get(`${repository.id}:${blob.path}`);
          if (forcedBytes && forcedBytes > bytes.length) bytes = Buffer.alloc(forcedBytes, 0x78);
          if (binaryBlob) bytes = Buffer.from([0xff, 0xfe]);
          observe(method, pathname, "installation", 200, { outcome: "blob_read", repositoryId: repository.id, byteCount: bytes.length });
          sendJson(response, 200, {
            sha: blobShaMismatch ? `${blobMatch[1][0] === "0" ? "1" : "0"}${blobMatch[1].slice(1)}` : blobMatch[1],
            node_id: `BLOB_${blobMatch[1]}`,
            size: bytes.length,
            url: `${baseUrl}${pathname}`,
            content: invalidBlobEncoding ? "***invalid-base64***" : bytes.toString("base64"),
            encoding: "base64",
          });
          return;
        }
      }

      unexpectedRequests += 1;
      observe(method, pathname, auth.kind, 404, { outcome: "unexpected_endpoint" });
      sendJson(response, 404, { message: "fixture endpoint not implemented" });
    } catch (error) {
      observe(method, pathname, auth.kind, 400, { outcome: "malformed_request" });
      sendJson(response, 400, { message: "malformed fixture request" });
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(listenPort, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("GitHub fixture did not bind a TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  environment.HOSTLET_GITHUB_WEB_ORIGIN = baseUrl;
  environment.HOSTLET_GITHUB_API_ORIGIN = baseUrl;

  let listenerPaused = false;
  async function pause() {
    if (closed) throw new Error("the GitHub fixture has been finalized");
    if (listenerPaused) return;
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections?.();
    });
    listenerPaused = true;
  }

  async function resume() {
    if (closed) throw new Error("the GitHub fixture has been finalized");
    if (!listenerPaused) return;
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(address.port, "127.0.0.1", () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
    listenerPaused = false;
  }

  async function close() {
    if (closed) return;
    await pause();
    closed = true;
  }

  context.registerCleanup?.("stop owned synthetic GitHub provider", close);

  function reset() {
    observations.length = 0;
    oauthCodes.clear();
    userTokens.clear();
    installationTokens.clear();
    oauthQueue.length = 0;
    deniedRepositories.clear();
    usersWithInstallation.clear();
    usersWithInstallation.add(primaryUser.id);
    usersWithInstallation.add(secondaryUser.id);
    if (previewUsers) for (const user of previewUsers.values()) usersWithInstallation.add(user.id);
    grantedRepositoryIds = new Set(repositories.keys());
    repositories.clear();
    for (const repository of originalRepositories) repositories.set(repository.id, cloneSafe(repository));
    installationRevoked = false;
    installationSuspended = false;
    contentsPermission = "read";
    wrongTokenMode = false;
    userIdentityOverride = null;
    treeTruncated = false;
    invalidBlobEncoding = false;
    binaryBlob = false;
    blobShaMismatch = false;
    extraTreeEntries = [];
    installationTokenSequence = 0;
    unexpectedRequests = 0;
    rateLimits.length = 0;
    delays.length = 0;
    forcedFaults.length = 0;
    oversize.clear();
    pagination.clear();
  }

  function setCallback(value) {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") throw new Error("fixture callback must use a literal loopback HTTP URL");
    expectedCallbackUrl = parsed.toString();
    environment.HOSTLET_GITHUB_CALLBACK_URL = expectedCallbackUrl;
    return expectedCallbackUrl;
  }

  function grant({ installationId = fixture.installation.id, repositoryIds, contentsPermission: permission = "read", suspended = false }) {
    if (Number(installationId) !== fixture.installation.id) throw new Error("unknown fixture installation");
    const next = new Set(repositoryIds.map(Number));
    for (const repositoryId of next) if (!repositories.has(repositoryId)) throw new Error(`unknown fixture repository ${repositoryId}`);
    grantedRepositoryIds = next;
    contentsPermission = permission;
    installationSuspended = Boolean(suspended);
    installationRevoked = false;
  }

  function setUnsafeTreeCase(kind) {
    const blob = (path, mode, content) => Object.freeze({
      path,
      mode,
      type: "blob",
      sha: gitObjectSha("blob", content),
      size: Buffer.byteLength(content),
      content,
    });
    if (["traversal", "malformed_path", "unsafe_path"].includes(kind)) extraTreeEntries = [blob("../owned-tree-escape.txt", "100644", "owned traversal sentinel\n")];
    else if (["symlink", "120000_symlink", "source_symlink"].includes(kind)) extraTreeEntries = [blob("owned-source-link", "120000", "../../outside-owned-source")];
    else if (["submodule", "160000_submodule", "source_submodule"].includes(kind)) {
      const commit = "tree 0000000000000000000000000000000000000000\n\nowned submodule sentinel\n";
      extraTreeEntries = [Object.freeze({ path: "owned-submodule", mode: "160000", type: "commit", sha: gitObjectSha("commit", commit) })];
    } else if (kind === "special_file") extraTreeEntries = [blob("owned-device", "020000", "owned special-file sentinel\n")];
    else if (["duplicate", "duplicates"].includes(kind)) {
      const entry = blob("owned-duplicate.txt", "100644", "owned duplicate sentinel\n");
      extraTreeEntries = [entry, Object.freeze({ ...entry })];
    } else if (["case_collision", "case_collisions"].includes(kind)) {
      extraTreeEntries = [
        blob("Owned-Case.txt", "100644", "owned upper-case sentinel\n"),
        blob("owned-case.txt", "100644", "owned lower-case sentinel\n"),
      ];
    } else throw new Error(`unknown unsafe tree fixture case: ${kind}`);
  }

  const controls = Object.freeze({
    reset,
    resetObservations() {
      observations.length = 0;
      unexpectedRequests = 0;
    },
    environment(value = expectedCallbackUrl) {
      if (value) setCallback(value);
      if (!expectedCallbackUrl) throw new Error("fixture callback URL must be set before creating the product environment");
      return { ...environment };
    },
    webhookSecret() { return webhookSecret; },
    setCallbackUrl: setCallback,
    authorizeNext({ mode = "success", userId = primaryUser.id, login } = {}) {
      if (!new Set(["success", "deny", "expired"]).has(mode)) throw new Error(`unsupported OAuth fixture mode: ${mode}`);
      const user = { id: Number(userId), login: login || (Number(userId) === secondaryUser.id ? secondaryUser.login : primaryUser.login) };
      oauthQueue.push({ mode, user });
    },
    revokeInstallation(installationId = fixture.installation.id) {
      if (Number(installationId) !== fixture.installation.id) throw new Error("unknown fixture installation");
      installationRevoked = true;
      installationTokens.clear();
    },
    restoreInstallation() { installationRevoked = false; },
    suspendInstallation(value = true) { installationSuspended = Boolean(value); },
    setContentsPermission(value) { contentsPermission = value; },
    denyRepository(repositoryId) { deniedRepositories.add(Number(repositoryId)); },
    allowRepository(repositoryId) { deniedRepositories.delete(Number(repositoryId)); },
    setGrantedRepositories(repositoryIds) {
      const next = new Set(repositoryIds.map(Number));
      for (const repositoryId of next) if (!repositories.has(repositoryId)) throw new Error(`unknown fixture repository ${repositoryId}`);
      grantedRepositoryIds = next;
    },
    setGrant: grant,
    setUserInstallationAccess(userId, allowed) {
      if (allowed) usersWithInstallation.add(Number(userId));
      else usersWithInstallation.delete(Number(userId));
    },
    moveBranch(repositoryId, branch, commitSha) {
      const repository = repositories.get(Number(repositoryId));
      if (!repository || !repository.commits[commitSha]) throw new Error("branch target must be an existing fixture commit");
      repository.branches[branch] = commitSha;
    },
    renameRepository(repositoryId, name) {
      const repository = repositories.get(Number(repositoryId));
      if (!repository || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("invalid fixture repository rename");
      repository.name = name;
    },
    expireUserTokens() { for (const token of userTokens.values()) token.expiresAt = 0; },
    expireUserToken() { for (const token of userTokens.values()) token.expiresAt = 0; },
    revokeUserTokens() { for (const token of userTokens.values()) token.revoked = true; },
    expireInstallationTokens() { for (const token of installationTokens.values()) token.expiresAt = 0; },
    issuedInstallationToken(repositoryId) {
      const issued = latestInstallationToken(repositoryId);
      if (!issued) throw new Error("no actual installation token has been issued for the requested repository");
      const [value, token] = issued;
      return Object.freeze({ value, repositoryId: token.repositoryId, useCount: token.useCount });
    },
    verifyIssuedInstallationCredential,
    verifyIssuedInstallationToken: verifyIssuedInstallationCredential,
    assertIssuedInstallationCredential(options = {}) { return verifyIssuedInstallationCredential({ ...options, minimumUses: options.minimumUses ?? 1 }); },
    setWrongTokenMode(value = true) { wrongTokenMode = Boolean(value); },
    setUserIdentityOverride(user) { userIdentityOverride = user ? { id: Number(user.id), login: String(user.login) } : null; },
    setTreeTruncated(value = true) { treeTruncated = Boolean(value); },
    setInvalidBlobEncoding(value = true) { invalidBlobEncoding = Boolean(value); },
    setBinaryBlob(value = true) { binaryBlob = Boolean(value); },
    setBlobShaMismatch(value = true) { blobShaMismatch = Boolean(value); },
    setExtraTreeEntries(entries) {
      if (!Array.isArray(entries) || entries.length > 2_500) throw new Error("extra tree entries must be an array with at most 2500 items");
      const seen = new Set();
      extraTreeEntries = entries.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("extra tree entry must be an object");
        const { path, mode, type, sha, content } = entry;
        let { size } = entry;
        if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path) > 4_096 ||
          /[\u0000-\u001f\u007f]/.test(path) || seen.has(path)) {
          throw new Error("extra tree entry path is invalid or duplicated");
        }
        if (!new Set(["100644", "100755", "040000", "120000", "160000"]).has(mode) ||
          !new Set(["blob", "tree", "commit"]).has(type) || !/^[0-9a-f]{40}$/.test(sha)) {
          throw new Error("extra tree entry mode, type, or SHA is invalid");
        }
        if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > 128 * 1024 * 1024)) {
          throw new Error("extra tree entry size is invalid");
        }
        if (content !== undefined) {
          if (type !== "blob" || typeof content !== "string" || Buffer.byteLength(content) > 64 * 1024) {
            throw new Error("extra tree entry content must be bounded synthetic text for a blob");
          }
          const contentBytes = Buffer.byteLength(content);
          if (size !== undefined && size !== contentBytes) throw new Error("extra tree entry size must match its content bytes");
          size = contentBytes;
        }
        seen.add(path);
        return Object.freeze({ path, mode, type, sha, ...(size === undefined ? {} : { size }), ...(content === undefined ? {} : { content }) });
      });
    },
    clearExtraTreeEntries() { extraTreeEntries = []; },
    setUnsafeTreeCase,
    setMalformedSourcePath() { setUnsafeTreeCase("traversal"); },
    setSourceSymlink() { setUnsafeTreeCase("symlink"); },
    setSourceSubmodule() { setUnsafeTreeCase("submodule"); },
    setDuplicateSourcePaths() { setUnsafeTreeCase("duplicate"); },
    setCaseCollisionSourcePaths() { setUnsafeTreeCase("case_collision"); },
    setOversize({ repositoryId, path, bytes }) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("oversize bytes must be a positive integer");
      oversize.set(`${Number(repositoryId)}:${path}`, bytes);
    },
    clearOversize() { oversize.clear(); },
    setPagination({ endpoint, pageSize }) {
      if (!new Set(["installations", "repositories", "branches"]).has(endpoint) || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
        throw new Error("invalid pagination fixture control");
      }
      pagination.set(endpoint, pageSize);
    },
    setRateLimit({ path, count = 1, retryAfterSeconds = 1 }) {
      rateLimits.push({ path, remaining: count, retryAfterSeconds });
    },
    setTimeout({ path, count = 1, delayMs }) {
      if (!Number.isSafeInteger(delayMs) || delayMs <= 0) throw new Error("timeout delay must be a positive integer");
      delays.push({ path, remaining: count, delayMs });
    },
    failNext(operation, mode) {
      const paths = {
        oauth_exchange: "/login/oauth/access_token",
        current_user: "/user",
        installations: "/user/installations",
        repositories: "/user/installations/*",
        installation_token: "/app/installations/*",
        repository: "/repositories/*",
        branches: "/repos/*",
        ref: "/repos/*",
        commit: "/repos/*",
        tree: "/repos/*",
        blob: "/repos/*",
      };
      const path = operation.startsWith("/") ? operation : paths[operation];
      if (!path) throw new Error(`unknown synthetic provider operation: ${operation}`);
      if (mode === "rate_limit") rateLimits.push({ path, remaining: 1, retryAfterSeconds: 1 });
      else if (mode === "timeout") delays.push({ path, remaining: 1, delayMs: 20_000 });
      else if (mode === "deny") forcedFaults.push({ path, remaining: 1, status: 403 });
      else throw new Error(`unknown synthetic provider failure mode: ${mode}`);
    },
    requestCounts() {
      const counts = {};
      for (const item of observations) counts[`${item.method} ${item.path}`] = (counts[`${item.method} ${item.path}`] || 0) + 1;
      return Object.freeze({ ...counts, unexpected: unexpectedRequests });
    },
    assertNoUnexpectedRequests() {
      if (unexpectedRequests !== 0) throw new Error(`synthetic GitHub provider observed ${unexpectedRequests} unexpected request(s)`);
    },
  });

  const safeRepositories = Object.freeze(fixture.repositories.map((repository) => Object.freeze({
    id: repository.id,
    name: repository.name,
    defaultBranch: repository.default_branch,
    commits: Object.freeze(Object.keys(repository.commits)),
    expectedAdvisory: repository.expected_advisory,
    expectedReasons: Object.freeze([...repository.expected_reasons]),
  })));
  const sentinels = Object.freeze({
    directoryEnvironment: fixture.sentinels.directory_environment,
    networkEnvironment: fixture.sentinels.network_environment,
    expectedFiles: Object.freeze([...fixture.sentinels.expected_files]),
    expectedNetworkPaths: Object.freeze([...fixture.sentinels.expected_network_paths]),
  });

  return Object.freeze({
    baseUrl,
    environment,
    controls,
    safeObservations: () => Object.freeze(observations.map((item) => Object.freeze(cloneSafe(item)))),
    repositories: safeRepositories,
    sentinels,
    pause,
    resume,
    close,
  });
}
