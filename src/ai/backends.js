'use strict';

// Die zwei Sprachen eines lokalen KI-Servers (docs/local-ai.md §3):
//   ollama – /api/version, /api/tags, /api/ps, /api/pull, /api/delete, /api/chat (NDJSON)
//   openai – OpenAI-kompatibel (LM Studio …): /v1/models, /v1/chat/completions (SSE)
// Beide liefern dasselbe: Modelle, geladene Modelle, und chat() mit Teiltexten
// über onDelta und am Ende { inputTokens, outputTokens, finish }.

const { requestJson, streamLines, err } = require('./client');
const { cleanText } = require('../print/config');

const MAX_MODELS = 48;

// 401/403: der Server will einen (anderen) API-Schlüssel
const DENIED = new Set([401, 403]);

function check(r, what) {
  if (DENIED.has(r.status)) throw err('unauthorized', `${what}: access denied (API key missing or wrong)`);
  if (r.json === undefined) throw err('bad_response', `${what}: no JSON`);
  if (r.status === 404) throw err('not_found', `${what}: not found`);
  if (r.status < 200 || r.status >= 300) throw err('http_' + r.status, `${what}: http ${r.status}`);
  return r.json || {};
}

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
const iso = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

function createOllama(base) {
  return {
    api: 'ollama',
    async version() {
      const j = check(await requestJson({ base, path: '/api/version', timeoutMs: 5000 }), 'version');
      return cleanText(j.version, 32) || null;
    },
    async models() {
      const j = check(await requestJson({ base, path: '/api/tags', timeoutMs: 10_000 }), 'tags');
      return (Array.isArray(j.models) ? j.models : []).slice(0, MAX_MODELS).filter((m) => m && typeof m.name === 'string').map((m) => ({
        name: cleanText(m.name, 120), size: num(m.size),
        family: cleanText(m.details && m.details.family, 32) || null,
        params: cleanText(m.details && m.details.parameter_size, 16) || null,
        quant: cleanText(m.details && m.details.quantization_level, 16) || null,
        modified: iso(m.modified_at),
      }));
    },
    async loaded() {
      const j = check(await requestJson({ base, path: '/api/ps', timeoutMs: 5000 }), 'ps');
      return (Array.isArray(j.models) ? j.models : []).slice(0, 4).filter((m) => m && typeof m.name === 'string').map((m) => ({
        name: cleanText(m.name, 120), size: num(m.size), vram: num(m.size_vram), until: iso(m.expires_at),
      }));
    },
    /** Herunterladen mit Fortschritt; Abbrechen über signal (Ollama setzt später fort). */
    async pull(model, { onProgress, signal }) {
      const layers = new Map(); // digest → { total, completed }
      let status = null;
      await streamLines({
        base, path: '/api/pull', body: { model, stream: true }, timeoutMs: 12 * 3600_000, idleMs: 10 * 60_000, maxBytes: 64 * 1024 * 1024, signal,
        onLine: (o) => {
          if (o && typeof o.error === 'string') throw err('pull_failed', cleanText(o.error, 200));
          status = cleanText(o && o.status, 80) || status;
          if (o && typeof o.digest === 'string' && Number(o.total) > 0) {
            layers.set(o.digest.slice(0, 80), { total: num(o.total), completed: Math.min(num(o.completed), num(o.total)) });
          }
          let total = 0;
          let completed = 0;
          for (const l of layers.values()) { total += l.total; completed += l.completed; }
          onProgress({ status, total, completed });
        },
      });
      if (status !== 'success') throw err('pull_failed', status || 'pull ended without success');
    },
    async remove(model) {
      const r = await requestJson({ base, method: 'DELETE', path: '/api/delete', body: { model }, timeoutMs: 30_000 });
      if (r.status === 404) throw err('not_found', 'model not found');
      if (r.status < 200 || r.status >= 300) throw err('http_' + r.status, 'delete failed');
    },
    async chat(q, { onDelta, signal }) {
      const body = {
        model: q.model, stream: true, keep_alive: '10m',
        messages: [...(q.system ? [{ role: 'system', content: q.system }] : []), ...q.messages],
        options: { num_predict: q.maxTokens, num_ctx: q.numCtx, ...(q.temperature != null ? { temperature: q.temperature } : {}) },
        ...(q.schema ? { format: q.schema } : {}),
      };
      const out = { inputTokens: 0, outputTokens: 0, finish: 'stop' };
      try {
        await streamLines({
          base, path: '/api/chat', body, timeoutMs: q.timeoutMs, idleMs: q.timeoutMs, signal,
          onLine: (o) => {
            if (o && typeof o.error === 'string') throw err('model_error', cleanText(o.error, 200));
            const piece = o && o.message && typeof o.message.content === 'string' ? o.message.content : '';
            if (piece) onDelta(piece);
            if (o && o.done) {
              out.inputTokens = num(o.prompt_eval_count);
              out.outputTokens = num(o.eval_count);
              out.finish = o.done_reason === 'length' ? 'length' : 'stop';
            }
          },
        });
      } catch (e) {
        if (e.code === 'http_404') throw err('model_missing', 'model not on this server');
        if (e.code === 'http_401' || e.code === 'http_403') throw err('unauthorized', 'access denied (API key missing or wrong)');
        throw e;
      }
      return out;
    },
  };
}

function createOpenAi(base) {
  async function list() {
    const j = check(await requestJson({ base, path: '/v1/models', timeoutMs: 10_000 }), 'models');
    return (Array.isArray(j.data) ? j.data : []).slice(0, MAX_MODELS).filter((m) => m && typeof m.id === 'string')
      .map((m) => ({ name: cleanText(m.id, 120), size: 0, family: null, params: null, quant: null, modified: null }));
  }
  return {
    api: 'openai',
    async version() { await list(); return null; },
    models: list,
    async loaded() { return []; },
    async chat(q, { onDelta, signal }) {
      const body = {
        model: q.model, stream: true, stream_options: { include_usage: true }, max_tokens: q.maxTokens,
        messages: [...(q.system ? [{ role: 'system', content: q.system }] : []), ...q.messages],
        ...(q.temperature != null ? { temperature: q.temperature } : {}),
        ...(q.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: q.schema } } } : {}),
      };
      const out = { inputTokens: 0, outputTokens: 0, finish: 'stop' };
      try {
        await streamLines({
          base, path: '/v1/chat/completions', body, timeoutMs: q.timeoutMs, idleMs: q.timeoutMs, signal, sse: true,
          onLine: (o) => {
            if (o && o.error) throw err('model_error', cleanText(typeof o.error === 'string' ? o.error : o.error.message, 200));
            const c = o && Array.isArray(o.choices) ? o.choices[0] : null;
            const piece = c && c.delta && typeof c.delta.content === 'string' ? c.delta.content : '';
            if (piece) onDelta(piece);
            if (c && c.finish_reason) out.finish = c.finish_reason === 'length' ? 'length' : 'stop';
            if (o && o.usage) { out.inputTokens = num(o.usage.prompt_tokens); out.outputTokens = num(o.usage.completion_tokens); }
          },
        });
      } catch (e) {
        if (e.code === 'http_404') throw err('model_missing', 'model not on this server');
        if (e.code === 'http_401' || e.code === 'http_403') throw err('unauthorized', 'access denied (API key missing or wrong)');
        throw e;
      }
      return out;
    },
  };
}

module.exports = { createOllama, createOpenAi, MAX_MODELS };
