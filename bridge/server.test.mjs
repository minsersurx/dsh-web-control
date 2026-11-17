import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBridgeServer } from './server.mjs';

const panelOrigin = 'https://example.github.io';
const panelKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const launchToken = 'synthetic-launch-token';

function listen(server) {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => `http://127.0.0.1:${server.address().port}`);
}

function requestJson(base, path, { method = 'GET', body, key = panelKey, origin = panelOrigin } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

test('bridge authenticates to DSH server-side, restricts browser origin, and exposes only allowed task routes', async t => {
  const dshAudit = [];
  let capturedPrompt;
  const fakeDsh = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-dsh.local');
    if (url.pathname === '/' && url.searchParams.has('token')) {
      assert.equal(url.searchParams.get('token'), launchToken);
      res.writeHead(303, { Location: './', 'Set-Cookie': 'dsh-auth-test=v1.synthetic; Path=/; HttpOnly; SameSite=Strict' });
      res.end();
      return;
    }
    if (url.pathname === '/' && req.headers.cookie === 'dsh-auth-test=v1.synthetic') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('ok');
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      res.writeHead(404); res.end(); return;
    }
    assert.equal(req.headers.origin, undefined, 'upstream DSH requests must not include browser Origin');
    assert.equal(req.headers.cookie, 'dsh-auth-test=v1.synthetic');
    let text = '';
    for await (const chunk of req) text += chunk;
    const envelope = JSON.parse(text);
    dshAudit.push({ method: req.method, path: url.pathname, envelope });
    const method = envelope.method;
    let value = {};
    if (method === 'session/list') {
      value = { items: [
        { sessionId: 'session-1', updatedAt: 1784330000000, running: false, blank: false, projections: { asOfSeq: 4, values: { title: '测试会话' } } },
        { sessionId: 'child-1', origin: 'subagent', updatedAt: 1784330001000, projections: { asOfSeq: 2, values: { title: '内部子任务' } } }
      ] };
    } else if (method === 'session/create') {
      value = { sessionId: 'created-session', agentPreset: null };
    } else if (method === 'session/prompt') {
      capturedPrompt = envelope.payload.args.request;
      value = undefined;
    } else if (method === 'session/cancel') {
      value = { accepted: true };
    } else if (method === 'session/page') {
      value = { records: [
        { event: { seq: 1, time: 1784330000000, type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '做一件事' }, { type: 'image', attachment: {} }] } } },
        { event: { seq: 2, time: 1784330001000, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '不应返回的思考' }, { type: 'text', text: '已完成。' }, { type: 'tool-call', name: 'internal', arguments: 'secret' }] } } } }
      ] };
    } else {
      res.writeHead(404); res.end(); return;
    }
    const result = { ok: true, rpcId: envelope.rpcId, result: { ok: true, ...(value === undefined ? {} : { value }) } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });

  const dshBase = await listen(fakeDsh);
  t.after(() => new Promise(resolve => fakeDsh.close(resolve)));
  const bridge = createBridgeServer({ dshBaseUrl: dshBase, dshLaunchToken: launchToken, panelKey, panelOrigin });
  const bridgeBase = await listen(bridge);
  t.after(() => new Promise(resolve => bridge.close(resolve)));

  const health = await requestJson(bridgeBase, '/health', { key: null });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, 'dsh-web-bridge');

  const denied = await requestJson(bridgeBase, '/v1/sessions', { key: null });
  assert.equal(denied.status, 401);
  assert.equal(dshAudit.length, 0, 'unauthorized calls must not reach DSH');

  const wrongOrigin = await requestJson(bridgeBase, '/v1/sessions', { origin: 'https://attacker.example' });
  assert.equal(wrongOrigin.status, 403);

  const preflight = await fetch(`${bridgeBase}/v1/sessions`, {
    method: 'OPTIONS',
    headers: { Origin: panelOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), panelOrigin);

  const status = await requestJson(bridgeBase, '/v1/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).dshReady, true);

  const sessionsResponse = await requestJson(bridgeBase, '/v1/sessions');
  const sessions = await sessionsResponse.json();
  assert.deepEqual(sessions.sessions.map(row => row.sessionId), ['session-1']);
  assert.equal(sessions.sessions[0].title, '测试会话');

  const historyResponse = await requestJson(bridgeBase, '/v1/sessions/session-1/history');
  const history = await historyResponse.json();
  assert.deepEqual(history.messages.map(row => [row.role, row.text]), [['user', '做一件事'], ['assistant', '已完成。']]);
  assert.equal(dshAudit.find(row => row.envelope.method === 'session/page').envelope.payload.args.request.throughSeq, 4);

  const createdResponse = await requestJson(bridgeBase, '/v1/sessions', { method: 'POST', body: {} });
  assert.equal(createdResponse.status, 201);
  assert.equal((await createdResponse.json()).session.sessionId, 'created-session');

  const promptResponse = await requestJson(bridgeBase, '/v1/sessions/session-1/prompt', {
    method: 'POST', body: { text: '  请执行一项任务  ', requestId: 'stable-request-id-001', timeZone: 'Asia/Hong_Kong' }
  });
  assert.equal(promptResponse.status, 202);
  assert.equal(capturedPrompt.requestId, 'stable-request-id-001');
  assert.equal(capturedPrompt.content[0].text, '  请执行一项任务  ');
  assert.equal(capturedPrompt.mode, 'queue');

  const cancelResponse = await requestJson(bridgeBase, '/v1/sessions/session-1/cancel', { method: 'POST', body: {} });
  assert.equal(cancelResponse.status, 200);
  assert.equal(dshAudit.every(row => row.envelope.type === 'client-request'), true);
});
