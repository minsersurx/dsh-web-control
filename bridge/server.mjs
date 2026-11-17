import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 8000;
const ALLOWED_ORIGIN_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

class BridgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function normalizeBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DSH_BASE_URL must use HTTP or HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('DSH_BASE_URL must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

function safeEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(response, status, value, origin = null, allowedOrigin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
  if (origin && origin === allowedOrigin) {
    headers['Access-Control-Allow-Origin'] = allowedOrigin;
    headers['Vary'] = 'Origin';
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError(413, 'body_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected object');
    return body;
  } catch {
    throw new BridgeError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
}

function cleanSession(row) {
  const projections = row?.projections && typeof row.projections === 'object' ? row.projections : {};
  const values = projections.values && typeof projections.values === 'object' ? projections.values : {};
  return {
    sessionId: String(row?.sessionId || ''),
    title: typeof values.title === 'string' ? values.title.slice(0, 240) : '',
    updatedAt: Number(row?.updatedAt) || 0,
    running: row?.running === true,
    blank: row?.blank === true,
    cursor: Number.isInteger(projections.asOfSeq) ? projections.asOfSeq : -1
  };
}

function extractHistory(records) {
  const messages = [];
  for (const record of Array.isArray(records) ? records : []) {
    const event = record?.event || record;
    const type = event?.type;
    if (type !== 'user/message' && type !== 'assistant/message') continue;
    const data = event?.data || {};
    const message = data.message || (type === 'user/message' ? data : {});
    const role = type === 'user/message' ? 'user' : 'assistant';
    if (role === 'user' && message?.source?.kind && message.source.kind !== 'user') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
    if (!text.trim()) continue;
    messages.push({ role, text: text.slice(0, 24000), time: Number(event.time) || 0 });
  }
  return messages.slice(-40);
}

export function createBridgeServer(config) {
  const dshBase = normalizeBase(config.dshBaseUrl);
  const launchToken = String(config.dshLaunchToken || '');
  const panelKey = String(config.panelKey || '');
  const panelOrigin = new URL(config.panelOrigin).origin;
  if (!launchToken) throw new Error('DSH_LAUNCH_TOKEN is required');
  if (panelKey.length < 32) throw new Error('PANEL_KEY must be a random string of at least 32 characters');

  let dshCookie = '';
  let loginPromise = null;

  function upstreamUrl(path) {
    return new URL(`${dshBase.pathname}${path}`.replace(/\/+/g, '/'), dshBase.origin);
  }

  async function login() {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const url = upstreamUrl('/');
      url.searchParams.set('token', launchToken);
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { Host: dshBase.host },
          signal: AbortSignal.timeout(10_000)
        });
      } catch {
        throw new BridgeError(502, 'dsh_unreachable', 'Cannot reach the configured DSH host.');
      }
      const cookieHeader = response.headers.getSetCookie?.() || [];
      const cookie = cookieHeader.map(value => value.split(';', 1)[0]).find(value => value.startsWith('dsh-auth-'));
      if (![302, 303].includes(response.status) || !cookie) {
        if (response.status === 401) throw new BridgeError(401, 'launch_token_rejected', 'DSH launch token was rejected or expired.');
        throw new BridgeError(502, 'login_failed', 'DSH did not issue a session cookie; check the DSH URL and launch token.');
      }
      dshCookie = cookie;
      return cookie;
    })();
    try { return await loginPromise; }
    finally { loginPromise = null; }
  }

  async function dshRequest(path, options = {}) {
    if (!dshCookie) await login();
    const headers = { Host: dshBase.host, Cookie: dshCookie, ...(options.headers || {}) };
    let response;
    try {
      response = await fetch(upstreamUrl(path), {
        ...options,
        headers,
        redirect: 'manual',
        signal: options.signal || AbortSignal.timeout(15_000)
      });
    } catch {
      throw new BridgeError(502, 'dsh_unreachable', 'The DSH host did not respond.');
    }
    if (response.status === 401 || response.status === 403) {
      dshCookie = '';
      throw new BridgeError(response.status, 'dsh_auth_required', 'DSH rejected the current session. Restart the bridge with a fresh launch token.');
    }
    return response;
  }

  async function rpc(method, args) {
    const body = {
      type: 'client-request',
      rpcId: randomUUID(),
      method,
      payload: { args }
    };
    const response = await dshRequest(`/api/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (response.status !== 200) throw new BridgeError(502, 'dsh_http_error', `DSH API returned HTTP ${response.status}.`);
    let envelope;
    try { envelope = await response.json(); }
    catch { throw new BridgeError(502, 'dsh_invalid_response', 'DSH returned invalid JSON.'); }
    if (envelope?.result?.ok !== true) {
      const detail = envelope?.result?.error || {};
      const code = typeof detail.code === 'string' ? detail.code.slice(0, 80) : 'dsh_request_failed';
      const message = typeof detail.message === 'string' ? detail.message.slice(0, 220) : 'DSH rejected the request.';
      throw new BridgeError(422, code, message);
    }
    return envelope.result.value ?? {};
  }

  async function dshReady() {
    if (!dshCookie) await login();
    const response = await dshRequest('/');
    return response.status === 200;
  }

  async function route(request) {
    const url = new URL(request.url, 'http://bridge.local');
    if (request.method === 'GET' && url.pathname === '/health') return { status: 200, body: { ok: true, service: 'dsh-web-bridge' }, public: true };
    if (request.method !== 'GET' && request.method !== 'POST') throw new BridgeError(405, 'method_not_allowed', 'Method not allowed.');

    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    if (!safeEqual(supplied, panelKey)) throw new BridgeError(401, 'unauthorized', 'Invalid bridge access key.');

    if (request.method === 'GET' && url.pathname === '/v1/status') {
      return { status: 200, body: { ok: true, dshReady: await dshReady() } };
    }

    if (request.method === 'GET' && url.pathname === '/v1/sessions') {
      const result = await rpc('session/list', { _request: {} });
      const rows = Array.isArray(result?.items) ? result.items : [];
      const sessions = rows.filter(row => row?.origin !== 'subagent').map(cleanSession)
        .filter(row => row.sessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 80);
      return { status: 200, body: { ok: true, sessions } };
    }

    if (request.method === 'POST' && url.pathname === '/v1/sessions') {
      await readJson(request);
      const result = await rpc('session/create', { request: {} });
      if (!result?.sessionId) throw new BridgeError(502, 'session_create_failed', 'DSH did not return a session ID.');
      return { status: 201, body: { ok: true, session: { sessionId: String(result.sessionId), agentPreset: result.agentPreset || null } } };
    }

    const historyMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/history$/);
    if (request.method === 'GET' && historyMatch) {
      const sessionId = decodeURIComponent(historyMatch[1]);
      if (!sessionId || sessionId.length > 256) throw new BridgeError(400, 'invalid_session_id', 'Invalid session ID.');
      const sessions = await rpc('session/list', { _request: {} });
      const row = (Array.isArray(sessions?.items) ? sessions.items : []).find(item => item?.sessionId === sessionId);
      if (!row) throw new BridgeError(404, 'session_not_found', 'DSH session was not found.');
      const cursor = Number.isInteger(row?.projections?.asOfSeq) ? row.projections.asOfSeq : -1;
      if (cursor < 0) return { status: 200, body: { ok: true, messages: [] } };
      const page = await rpc('session/page', {
        request: {
          address: { kind: 'session', sessionId },
          throughSeq: cursor,
          maxMessages: 40
        }
      });
      return { status: 200, body: { ok: true, messages: extractHistory(page?.records) } };
    }

    const promptMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/prompt$/);
    if (request.method === 'POST' && promptMatch) {
      const sessionId = decodeURIComponent(promptMatch[1]);
      if (!sessionId || sessionId.length > 256) throw new BridgeError(400, 'invalid_session_id', 'Invalid session ID.');
      const payload = await readJson(request);
      const text = typeof payload.text === 'string' ? payload.text : '';
      const requestId = typeof payload.requestId === 'string' && /^[\w-]{16,80}$/.test(payload.requestId) ? payload.requestId : randomUUID();
      if (!text.trim()) throw new BridgeError(400, 'empty_prompt', 'Task text cannot be empty.');
      if (text.length > MAX_TEXT_CHARS) throw new BridgeError(413, 'prompt_too_long', `Task text must be at most ${MAX_TEXT_CHARS} characters.`);
      await rpc('session/prompt', {
        request: {
          requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: typeof payload.timeZone === 'string' ? payload.timeZone.slice(0, 64) : 'UTC'
        }
      });
      return { status: 202, body: { ok: true, requestId, accepted: true } };
    }

    const cancelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const sessionId = decodeURIComponent(cancelMatch[1]);
      if (!sessionId || sessionId.length > 256) throw new BridgeError(400, 'invalid_session_id', 'Invalid session ID.');
      await readJson(request);
      const result = await rpc('session/cancel', { request: { sessionId } });
      return { status: 200, body: { ok: true, accepted: result?.accepted !== false } };
    }

    throw new BridgeError(404, 'not_found', 'Bridge API route not found.');
  }

  return http.createServer(async (request, response) => {
    const origin = request.headers.origin || '';
    if (origin && origin !== panelOrigin) {
      sendJson(response, 403, { ok: false, error: { code: 'origin_denied', message: 'This browser origin is not allowed by the bridge.' } });
      return;
    }
    if (request.method === 'OPTIONS') {
      if (origin !== panelOrigin || !ALLOWED_ORIGIN_METHODS.has(request.headers['access-control-request-method'])) {
        sendJson(response, 403, { ok: false, error: { code: 'origin_denied', message: 'This browser origin is not allowed by the bridge.' } });
        return;
      }
      response.writeHead(204, {
        'Access-Control-Allow-Origin': panelOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '300',
        'Vary': 'Origin',
        'Cache-Control': 'no-store'
      });
      response.end();
      return;
    }
    try {
      const result = await route(request);
      sendJson(response, result.status, result.body, origin, panelOrigin);
    } catch (error) {
      const failure = error instanceof BridgeError ? error : new BridgeError(500, 'internal_error', 'Bridge request failed.');
      sendJson(response, failure.status, { ok: false, error: { code: failure.code, message: failure.message } }, origin, panelOrigin);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 4177);
    const server = createBridgeServer({
      dshBaseUrl: process.env.DSH_BASE_URL,
      dshLaunchToken: process.env.DSH_LAUNCH_TOKEN,
      panelKey: process.env.PANEL_KEY,
      panelOrigin: process.env.PANEL_ORIGIN
    });
    server.listen(port, host, () => console.log(`DSH bridge listening on ${host}:${port}; browser credentials and DSH tokens are not logged.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    console.error(`Bridge configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}
