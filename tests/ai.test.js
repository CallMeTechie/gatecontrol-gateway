'use strict';

// Lokale KI (Phase 3c, Schritt 3 – docs/local-ai.md): features.ai prüfen,
// Steuerdatei/Wächter, Download mit Fortschritt und Abbruch, Löschen, die
// Chat-Weiterleitung als NDJSON-Strom (Ollama und OpenAI-kompatibel), die
// Warteschlange, die Grenzen (Body, Antwort, keine Weiterleitungen) und der
// Wächter-Code aus docker-compose.example.yml mit einem falschen ollama.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createApiServer } = require('../src/api/server');
const { createFeaturesRouter } = require('../src/api/routes/features');
const { normalizeAi, parseLanUrl, validModel } = require('../src/ai/config');
const { AiService, parseChat, detectGpus } = require('../src/ai/ai');
const { createOllama, createOpenAi } = require('../src/ai/backends');
const { normalizeFeatures } = require('../src/features/config');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(15); }
  throw new Error('timeout waiting for condition');
}

// ─── Stub eines KI-Servers (Ollama + OpenAI-kompatibel) ──────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { try { resolve(JSON.parse(b || 'null')); } catch { resolve(null); } });
  });
}

async function startStub(opts = {}) {
  const seen = [];
  const st = { models: ['llama3.2:3b'], pullAborted: false, chatDelayMs: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = req.method === 'GET' ? null : await readBody(req);
    seen.push({ method: req.method, url: req.url, body });
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (opts.redirect) { res.writeHead(302, { Location: 'http://8.8.8.8/' }); res.end(); return; }
    if (req.url === '/api/version') return json(200, { version: '0.40.8' });
    if (req.url === '/api/tags') return json(200, { models: st.models.map((name) => ({ name, size: 2019393189, modified_at: '2026-11-01T10:00:00Z', details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } })) });
    if (req.url === '/api/ps') return json(200, { models: [{ name: 'llama3.2:3b', size: 2700000000, size_vram: 0, expires_at: '2026-11-06T22:00:00Z' }] });
    if (req.url === '/api/delete') {
      if (!st.models.includes(body.model)) return json(404, { error: 'model not found' });
      st.models = st.models.filter((m) => m !== body.model);
      return json(200, {});
    }
    if (req.url === '/api/pull') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      let gone = false;
      res.on('close', () => { gone = true; st.pullAborted = true; });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      const total = 2000;
      for (let done = 0; done <= total; done += 500) {
        if (gone) return;
        res.write(JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total, completed: done }) + '\n');
        await wait(opts.pullStepMs || 5);
      }
      if (opts.pullHang) return;
      st.models.push(body.model);
      res.end(JSON.stringify({ status: 'success' }) + '\n');
      return;
    }
    if (req.url === '/api/chat') {
      if (!st.models.includes(body.model)) return json(404, { error: `model "${body.model}" not found, try pulling it first` });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      await wait(st.chatDelayMs);
      for (const w of (opts.words || ['Kurz: ', 'Rechnung ', 'bezahlen.'])) {
        res.write(JSON.stringify({ message: { role: 'assistant', content: w }, done: false }) + '\n');
        await wait(2);
      }
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 812, eval_count: 9 }) + '\n');
      return;
    }
    if (req.url === '/v1/models') return json(200, { data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'llama-3.2-3b' }] });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const w of ['Hallo', ' Welt']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = { protocol: 'http:', host: '127.0.0.1', port: srv.address().port };
  return { srv, base, seen, st, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

/** Ordner mit dem Wächter-Zustand „läuft“ (wie der Dienst ki ihn schreibt). */
function ctlDir(state = 'running') {
  const d = tmp('gc-ai-ctl-');
  if (state) fs.writeFileSync(path.join(d, 'ki.state'), `${state} ${Math.floor(Date.now() / 1000)}\n`);
  return d;
}

// ─── features.ai ─────────────────────────────────────────────────────────

describe('ai: features.ai', () => {
  it('missing (older server) → off; service is the default source', () => {
    assert.deepEqual(normalizeAi(undefined), { enabled: false, source: 'service', lan: null });
    assert.deepEqual(normalizeFeatures(undefined).ai, { enabled: false, source: 'service', lan: null });
    assert.deepEqual(normalizeAi({ enabled: true }), { enabled: true, source: 'service', lan: null });
  });

  it('LAN server: only http/https to a private IPv4 address with a port, no path, no credentials', () => {
    const ok = normalizeAi({ enabled: true, source: 'lan', lan: { url: 'http://192.168.1.20:11434', api: 'ollama' } });
    assert.deepEqual(ok.lan, { url: 'http://192.168.1.20:11434', api: 'ollama' });
    assert.equal(normalizeAi({ enabled: true, source: 'lan', lan: { url: 'http://10.0.0.5:1234/v1', api: 'openai' } }).lan.url, 'http://10.0.0.5:1234');
    assert.equal(parseLanUrl('https://172.16.4.2').port, 443);
    for (const bad of ['http://8.8.8.8:11434', 'http://example.com:11434', 'http://127.0.0.1:11434', 'http://169.254.169.254/',
      'ftp://192.168.1.2', 'http://user:pw@192.168.1.2:11434', 'http://192.168.1.2:11434/api', 'http://192.168.1.2:11434/?x=1',
      'http://[::1]:11434', 'http://[fd00::1]:11434', 'http://192.168.1.2:99999', '', 42, null]) {
      assert.equal(parseLanUrl(bad), null, String(bad));
    }
    // Oktal/Hex schreibt die WHATWG-URL zur normalen Form um – geprüft wird, was danach dasteht
    assert.equal(parseLanUrl('http://0300.0250.1.2:11434').host, '192.168.1.2');
    assert.equal(parseLanUrl('http://0x08080808:80'), null);
    assert.equal(normalizeAi({ enabled: true, source: 'lan', lan: { url: 'http://8.8.8.8' } }).lan, null);
    assert.equal(normalizeAi({ enabled: true, source: 'lan', lan: { url: 'http://192.168.1.2:1', api: 'evil' } }).lan.api, 'ollama');
  });

  it('model names and chat requests are checked', () => {
    for (const m of ['llama3.2:3b', 'qwen2.5:7b', 'gemma2:9b', 'library/llama3.2:1b', 'hf.co-x/y:latest']) assert.ok(validModel(m), m);
    for (const m of ['', '../x', 'a b', 'X:1', 'a:' + 'b'.repeat(70), 'a/b/c', null]) assert.ok(!validModel(m), String(m));
    const q = parseChat({ model: 'llama3.2:3b', system: 'S', messages: [{ role: 'user', content: 'Hi' }] });
    assert.deepEqual({ maxTokens: q.maxTokens, numCtx: q.numCtx, timeoutMs: q.timeoutMs, schema: q.schema }, { maxTokens: 1024, numCtx: 8192, timeoutMs: 300000, schema: null });
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [] }), null);
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [{ role: 'system', content: 'x' }] }), null);
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'x' }], maxTokens: 0 }), null);
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'x' }], timeoutMs: 999 }), null);
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'x' }], temperature: 5 }), null);
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'x'.repeat(1_000_001) }] }), null);
    assert.equal(parseChat({ model: 'llama3.2:3b', messages: [{ role: 'user', content: 'x' }], schema: [] }), null);
  });

  it('GPU hint from sysfs (PCI class 0x03…)', () => {
    const sys = tmp('gc-ai-sys-');
    const dev = (n, cls, vendor) => { const d = path.join(sys, 'bus/pci/devices', n); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'class'), cls + '\n'); fs.writeFileSync(path.join(d, 'vendor'), vendor + '\n'); };
    dev('0000:00:02.0', '0x030000', '0x8086');
    dev('0000:01:00.0', '0x030200', '0x10de');
    dev('0000:00:1f.0', '0x060100', '0x8086');
    assert.deepEqual(detectGpus(sys), [{ vendor: 'intel' }, { vendor: 'nvidia' }]);
    assert.deepEqual(detectGpus('/nonexistent-gc'), []);
  });
});

// ─── Dienst, Steuerdatei, Download ───────────────────────────────────────

describe('ai: service on the gateway (stub Ollama)', () => {
  let stub;
  let svc;
  let ctl;
  let state;
  beforeEach(async () => {
    stub = await startStub();
    ctl = ctlDir();
    state = tmp('gc-ai-state-');
  });
  afterEach(async () => { if (svc) svc.stop(); svc = null; await stub.close(); });

  it('switch: run file + ai.json, watcher state, telemetry', async () => {
    svc = new AiService({ stateDir: state, ctlDir: ctl, sysRoot: '/nonexistent-gc', serviceBackend: createOllama(stub.base) });
    await svc.apply({ enabled: true, source: 'service' });
    assert.equal(fs.readFileSync(path.join(ctl, 'run'), 'utf8'), 'RUN=1\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'ai.json'), 'utf8')), { want: true });
    await svc.tick();
    const t = svc.featureTelemetry();
    assert.equal(t.state, 'running');
    assert.equal(t.service, 'managed');
    assert.equal(t.version, '0.40.8');
    assert.deepEqual(t.models, [{ name: 'llama3.2:3b', size: 2019393189 }]);
    assert.equal(t.loaded[0].size, 2700000000);
    assert.ok(t.host.memTotal > 0 && t.host.cores > 0);
    assert.ok(JSON.stringify(t).length < 3000, 'heartbeat limit 16 KB');
    await svc.apply({ enabled: false });
    assert.ok(!fs.existsSync(path.join(ctl, 'run')), 'off: watcher stops ollama');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'ai.json'), 'utf8')), { want: false });
    assert.equal(svc.featureTelemetry().state, 'off');
  });

  it('service states: missing (old compose), absent (container gone), Pi: asks the host', async () => {
    svc = new AiService({ stateDir: state, ctlDir: '/nonexistent-gc-ai', serviceBackend: createOllama({ protocol: 'http:', host: '127.0.0.1', port: 1 }) });
    await svc.apply({ enabled: true });
    assert.equal(svc.service(), 'missing');
    assert.equal(svc.state(), 'service_missing');
    svc.stop();
    const stale = tmp('gc-ai-ctl-');
    fs.writeFileSync(path.join(stale, 'ki.state'), `running ${Math.floor(Date.now() / 1000) - 600}\n`);
    fs.writeFileSync(path.join(state, 'hardware.json'), JSON.stringify({ ai_start: true }));
    svc = new AiService({ stateDir: state, ctlDir: stale, serviceBackend: createOllama({ protocol: 'http:', host: '127.0.0.1', port: 1 }) });
    await svc.apply({ enabled: true });
    assert.equal(svc.service(), 'absent');
    await svc.tick();
    assert.ok(fs.existsSync(path.join(state, 'ai-start')), 'Pi image: gatecontrol-ai.path creates the container');
  });

  it('pull with progress, then cancel; delete; one pull at a time', async () => {
    await stub.close();
    stub = await startStub({ pullStepMs: 30 });
    svc = new AiService({ stateDir: state, ctlDir: ctl, serviceBackend: createOllama(stub.base) });
    await svc.apply({ enabled: true });
    await svc.tick();
    assert.equal(svc.requestPull('bad name'), 'invalid_model');
    assert.equal(svc.requestPull('qwen2.5:7b'), 'accepted');
    assert.equal(svc.requestPull('gemma2:9b'), 'pull_running');
    await until(() => svc.featureTelemetry().pull.completed >= 500);
    assert.equal(svc.featureTelemetry().pull.total, 2000);
    await until(() => svc.featureTelemetry().pull.state === 'done', 5000);
    assert.equal(svc.featureTelemetry().pull.completed, 2000);
    assert.ok(svc.models.some((m) => m.name === 'qwen2.5:7b'), 'model list refreshed after the download');
    assert.equal(await svc.removeModel('qwen2.5:7b'), 'deleted');
    assert.equal(await svc.removeModel('qwen2.5:7b'), 'not_found');
    // abbrechen
    await stub.close();
    stub = await startStub({ pullStepMs: 40, pullHang: true });
    svc.serviceBackend = createOllama(stub.base);
    assert.equal(svc.requestPull('gemma2:9b'), 'accepted');
    await until(() => svc.featureTelemetry().pull.completed > 0);
    assert.equal(svc.cancelPull(), 'accepted');
    await until(() => svc.featureTelemetry().pull.state === 'cancelled');
    assert.equal(svc.cancelPull(), 'no_pull');
    // LAN-Server: kein Download
    await svc.apply({ enabled: true, source: 'lan', lan: { url: 'http://192.168.1.20:11434' } });
    assert.equal(svc.requestPull('llama3.2:1b'), 'lan_source');
  });
});

// ─── Management-Routen und Strom ─────────────────────────────────────────

const TOK = 'e'.repeat(64);
async function serve(ai) {
  const a = createApiServer({ bindIp: '127.0.0.1', port: 0, expectedToken: TOK, routerFactories: { '/api': () => createFeaturesRouter({ featureMgr: { ai } }) } });
  const srv = a.listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  return srv;
}
function post(srv, p, body, { raw = false, token = TOK } = {}) {
  return new Promise((resolve, reject) => {
    const d = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Gateway-Token': token } }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => {
        if (raw) return resolve({ status: r.statusCode, type: r.headers['content-type'], lines: b.split('\n').filter(Boolean).map((l) => JSON.parse(l)) });
        let j = null;
        try { j = b ? JSON.parse(b) : null; } catch { j = b; }
        resolve({ status: r.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.end(d);
  });
}
const CHAT = { model: 'llama3.2:3b', system: 'Fasse zusammen.', messages: [{ role: 'user', content: 'Mail: Bitte die Rechnung bis Freitag bezahlen.' }], maxTokens: 200, numCtx: 4096, timeoutMs: 20000 };

describe('ai: management routes', () => {
  let stub;
  let svc;
  let api;
  beforeEach(async () => {
    stub = await startStub();
    svc = new AiService({ stateDir: tmp('gc-ai-state-'), ctlDir: ctlDir(), serviceBackend: createOllama(stub.base) });
    await svc.apply({ enabled: true });
    await svc.tick();
    api = await serve(svc);
  });
  afterEach(async () => { svc.stop(); api.close(); await stub.close(); });

  it('status, pull, cancel, delete; token required', async () => {
    const s = await post(api, '/api/ai/status', {});
    assert.equal(s.status, 200);
    assert.equal(s.body.ai.state, 'running');
    assert.equal(s.body.ai.models[0].params, '3.2B');
    assert.equal((await post(api, '/api/ai/status', {}, { token: 'x'.repeat(64) })).status, 403);
    assert.deepEqual(await post(api, '/api/ai/pull', { model: 'x y' }), { status: 400, body: { error: 'invalid_model' } });
    assert.equal((await post(api, '/api/ai/pull', { model: 'llama3.2:1b' })).status, 202);
    await until(() => svc.featureTelemetry().pull.state === 'done');
    assert.deepEqual(await post(api, '/api/ai/pull/cancel', {}), { status: 409, body: { error: 'no_pull' } });
    assert.deepEqual(await post(api, '/api/ai/delete', { model: 'llama3.2:1b' }), { status: 200, body: { deleted: true } });
    assert.deepEqual(await post(api, '/api/ai/delete', { model: 'llama3.2:1b' }), { status: 404, body: { error: 'not_found' } });
  });

  it('chat: NDJSON stream with the text, tokens and the end', async () => {
    const r = await post(api, '/api/ai/chat', CHAT, { raw: true });
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/x-ndjson/);
    const text = r.lines.filter((l) => l.d).map((l) => l.d).join('');
    assert.equal(text, 'Kurz: Rechnung bezahlen.');
    const end = r.lines[r.lines.length - 1];
    assert.equal(end.done, true);
    assert.equal(end.inputTokens, 812);
    assert.equal(end.outputTokens, 9);
    assert.equal(end.finish, 'stop');
    // was Ollama bekam
    const sent = stub.seen.find((x) => x.url === '/api/chat').body;
    assert.equal(sent.messages[0].role, 'system');
    assert.equal(sent.options.num_ctx, 4096);
    assert.equal(sent.options.num_predict, 200);
    assert.equal(sent.stream, true);
  });

  it('chat: missing model → error line; invalid → 400; off → 503', async () => {
    const r = await post(api, '/api/ai/chat', { ...CHAT, model: 'gemma2:9b' }, { raw: true });
    assert.equal(r.lines[r.lines.length - 1].error, 'model_missing');
    assert.deepEqual(await post(api, '/api/ai/chat', { ...CHAT, messages: [] }), { status: 400, body: { error: 'invalid_request' } });
    await svc.apply({ enabled: false });
    assert.equal((await post(api, '/api/ai/chat', CHAT)).status, 503);
    assert.equal((await post(api, '/api/ai/status', {})).status, 503);
  });

  it('chat body up to 2 MB, every other route stays at 16 KB', async () => {
    const big = { ...CHAT, messages: [{ role: 'user', content: 'x'.repeat(600_000) }] };
    const r = await post(api, '/api/ai/chat', big, { raw: true });
    assert.equal(r.status, 200);
    assert.equal(r.lines[r.lines.length - 1].done, true);
    assert.equal((await post(api, '/api/ai/pull', { model: 'llama3.2:1b', pad: 'x'.repeat(20_000) })).status, 413);
    assert.equal((await post(api, '/api/ai/chat', { ...CHAT, pad: 'x'.repeat(2_200_000) })).status, 413);
  });

  it('one answer at a time, two wait, more → 429 busy', async () => {
    stub.st.chatDelayMs = 300;
    const all = [1, 2, 3, 4].map(() => post(api, '/api/ai/chat', CHAT, { raw: true }).catch((e) => ({ status: 0, e })));
    await wait(10);
    const extra = await post(api, '/api/ai/chat', CHAT);
    assert.deepEqual(extra, { status: 429, body: { error: 'busy' } });
    const rs = await Promise.all(all);
    const codes = rs.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 200, 200, 429], 'four at once: one active, two waiting, the fourth busy');
    assert.equal(svc.active, 0);
    assert.equal(svc.waiting.length, 0);
  });

  it('the server hangs up → the request to Ollama is cancelled, the slot is free again', async () => {
    stub.st.chatDelayMs = 400;
    await new Promise((resolve) => {
      const d = JSON.stringify(CHAT);
      const req = http.request({ host: '127.0.0.1', port: api.address().port, path: '/api/ai/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d), 'X-Gateway-Token': TOK } }, (r) => {
        r.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => resolve());
      req.end(d);
      setTimeout(() => { req.destroy(); resolve(); }, 100);
    });
    await until(() => svc.active === 0);
  });
});

describe('ai: existing server in the LAN', () => {
  let stub;
  afterEach(async () => { if (stub) await stub.close(); });

  it('OpenAI-compatible (LM Studio): models and a streamed answer with usage', async () => {
    stub = await startStub();
    const b = createOpenAi(stub.base);
    assert.deepEqual((await b.models()).map((m) => m.name), ['qwen2.5-7b-instruct', 'llama-3.2-3b']);
    let text = '';
    const r = await b.chat({ model: 'llama-3.2-3b', system: 'S', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50, timeoutMs: 5000, schema: { type: 'object' } }, { onDelta: (d) => { text += d; }, signal: new AbortController().signal });
    assert.equal(text, 'Hallo Welt');
    assert.deepEqual(r, { inputTokens: 30, outputTokens: 2, finish: 'stop' });
    const sent = stub.seen.find((x) => x.url === '/v1/chat/completions').body;
    assert.equal(sent.response_format.type, 'json_schema');
    assert.equal(sent.max_tokens, 50);
  });

  it('only the configured address: the service talks to lan.url, never follows a redirect', async () => {
    stub = await startStub({ redirect: true });
    const svc = new AiService({ stateDir: null, ctlDir: '/nonexistent-gc-ai', lanBackend: (lan) => {
      assert.deepEqual(lan, { url: 'http://192.168.77.5:1234', api: 'openai' });
      return createOpenAi(stub.base);
    } });
    await svc.apply({ enabled: true, source: 'lan', lan: { url: 'http://192.168.77.5:1234/v1', api: 'openai' } });
    await svc.tick();
    assert.equal(svc.state(), 'unreachable');
    assert.equal(svc.lastError.code, 'redirect');
    assert.equal(stub.seen.length, 1, 'one request, no second one to the redirect target');
    svc.stop();
  });

  it('a host that does not answer is unreachable within the connect limit', async () => {
    const b = createOllama({ protocol: 'http:', host: '127.0.0.1', port: 9 });
    await assert.rejects(b.version(), (e) => e.code === 'unreachable');
  });
});

// ─── Wächter aus docker-compose.example.yml ──────────────────────────────

describe('ai: watcher of the ki service (docker-compose.example.yml)', () => {
  it('starts `ollama serve` while /gc-ai/run exists and stops it without', { timeout: 30000 }, async () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.example.yml'), 'utf8');
    const block = yml.slice(yml.indexOf('\n  ki:\n'));
    const m = /- \|\n((?: {8}.*\n)+)/.exec(block);
    assert.ok(m, 'watcher script found');
    const dir = tmp('gc-ai-watch-');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // falsches ollama: merkt sich den Start, läuft bis TERM
    fs.writeFileSync(path.join(bin, 'ollama'), `#!/bin/sh\necho "$1" >>"${dir}/calls"\ntrap 'echo stopped >>"${dir}/calls"; exit 0' TERM\nwhile :; do sleep 0.2; done\n`, { mode: 0o755 });
    const ctl = path.join(dir, 'ctl');
    fs.mkdirSync(ctl);
    const script = m[1].split('\n').map((l) => l.slice(8)).join('\n').replace(/\$\$/g, '$').replace('C=/gc-ai;', `C=${ctl};`);
    const child = spawn('/bin/sh', ['-c', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const kiState = () => read(path.join(ctl, 'ki.state'));
    try {
      await until(() => /^idle \d+\n$/.test(kiState()), 8000);
      assert.equal(read(path.join(dir, 'calls')), '', 'without run: no ollama');
      fs.writeFileSync(path.join(ctl, 'run'), 'RUN=1\n');
      await until(() => read(path.join(dir, 'calls')) === 'serve\n' && /^running \d+\n$/.test(kiState()), 8000);
      fs.rmSync(path.join(ctl, 'run'));
      await until(() => /stopped/.test(read(path.join(dir, 'calls'))) && /^idle /.test(kiState()), 8000);
    } finally { child.kill('SIGTERM'); }
  });
});
