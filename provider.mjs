// Hub provider plugin: Shisa's own service.
//
// NOT built into the hub: the hub imports this module from this plugin
// directory. The sign-in is the platform's device-code contract (the same one
// Jouzu's private sign-in uses) with the same client_id for now — a dedicated
// id is a later platform change, and it is a constant of THIS plugin, never of
// the hub. The authorization runs inside the hub process: the hub creates the
// operation, this plugin reports the steps and finishes it, and the hub stores
// the credential in its own secret store so every compatible harness receives
// it through the existing grant path. This plugin never touches another
// harness's private credentials.
//
// Model capability metadata (thinking levels, context window) lives in the
// platform's own model catalog, not in the OpenAI-style /models list. The
// sign-in response names that catalog; the hub keeps the URL and hands it back
// on every refresh, so a plugin can report what the service accepts without
// anyone typing levels in.
import crypto from 'node:crypto';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const CLIENT_ID = 'jouzu';   // temporary, by decision; a dedicated id is a platform change
// The platform's model catalog is versioned media: it answers 406 to a plain
// application/json accept, exactly like the runtime's own catalog client.
const MODEL_CATALOG_ACCEPT = 'application/vnd.jouzu.model-catalog+json; version=1';   // temporary, by decision; a dedicated id is a platform change
const DEFAULT_GATEWAY = 'https://gateway.shisa.ai';
const VERSION = 1;

// The platform uses install_id to offer key replacement on reconnect and the
// request is refused without one. The plugin has no storage of its own, so it is
// derived from this machine and this provider: stable across restarts, distinct
// per provider, and never shared with another client's identity.
function installId(providerId) {
  const h = crypto.createHash('sha256').update(`${os.hostname()}|${providerId}|hub-provider-shisa`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
// Older providers signed in before the hub stored a catalog URL. The platform
// serves its catalog under a product-owned path on the same host as the model
// API; when sign-in gave us the URL we use that, and this only fills the gap so
// an existing provider does not need to sign in again to gain thinking levels.
function derivedCatalogUrl(endpoint) {
  try { const u = new URL(endpoint?.url || ''); return `${u.origin}/v1/jouzu/model-catalog`; } catch { return null; }
}
function gatewayUrl(env = process.env) {
  const raw = typeof env.JOUZU_SHISA_PLATFORM_URL === 'string' ? env.JOUZU_SHISA_PLATFORM_URL.trim() : '';
  return (raw || DEFAULT_GATEWAY).replace(/\/+$/, '');
}
const error = (code, message) => Object.assign(new Error(message), { code });

async function readJsonBounded(response, limit = 16 * 1024 * 1024) {
  const reader = response.body?.getReader?.();
  if (!reader) return null;
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
async function getJson(url, credential, { signal, timeoutMs = 15000, accept = 'application/json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, { headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), accept }, redirect: 'error', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    return await readJsonBounded(response);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
async function postJson(url, payload, { signal, token } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload ?? {}),
    redirect: 'error',
    signal,
  });
  const body = await readJsonBounded(response);
  return { status: response.status, body };
}
function wireErrorName(body) {
  if (typeof body?.error === 'string') return body.error;
  if (body?.error && typeof body.error.code === 'string') return body.error.code;
  return undefined;
}

// The level names the hub's model schema carries: the names every harness in
// this system expresses a reasoning level with. A vendor name outside this set
// has no meaning downstream — there is no mapping for it here — so it is left
// out of the model entry instead of travelling as a string nobody can honour.
const HUB_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// One catalog offering -> one hub model entry. This translation IS the plugin's
// job: the vendor publishes its facts in its own document (`supportedThinkingLevels`
// in the client vocabulary the catalog contract defines, `modalities`, `limits`),
// and each one is carried into the hub schema under the name that schema uses —
// the levels are normalized to the names the harnesses understand and unknown
// ones dropped, modalities reduced to the ones the schema has, limits mapped to
// the window/token fields. An offering that states no levels gets none; nothing
// is inferred on the service's behalf.
function offeringToModel(offering) {
  if (!offering || typeof offering.modelId !== 'string' || !offering.modelId) return null;
  const stated = Array.isArray(offering.supportedThinkingLevels)
    ? offering.supportedThinkingLevels.filter((level) => typeof level === 'string' && level.trim())
    : null;
  const levels = stated ? [...new Set(stated.map((level) => level.trim().toLowerCase()).filter((level) => HUB_THINKING_LEVELS.includes(level)))] : null;
  const input = Array.isArray(offering.modalities) ? offering.modalities.filter((m) => m === 'text' || m === 'image') : null;
  const limits = offering.limits && typeof offering.limits === 'object' ? offering.limits : {};
  return {
    id: offering.modelId,
    name: typeof offering.name === 'string' && offering.name ? offering.name : offering.modelId,
    ...(levels && levels.length ? { thinkingLevels: levels } : {}),
    ...(input && input.length ? { input } : {}),
    ...(Number.isInteger(limits.contextWindow) && limits.contextWindow > 0 ? { contextWindow: limits.contextWindow } : {}),
    ...(Number.isInteger(limits.maxOutputTokens) && limits.maxOutputTokens > 0 ? { maxTokens: limits.maxOutputTokens } : {}),
  };
}
// The OpenAI-compatible list: ids and names only. Used when the rich catalog is
// unavailable, with a note so the caller knows capabilities are missing.
async function fetchOpenAiModels(endpoint, credential) {
  let url;
  try {
    url = new URL(endpoint?.url || '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    url.pathname = url.pathname.replace(/\/$/, '') + '/models';
    url.hash = '';
  } catch { throw error('validation_failed', 'the provider has no endpoint yet; sign in first'); }
  const document = await getJson(url.href, credential).catch((e) => { throw error('provider_catalog_failed', `catalog connection failed (${e.message})`); });
  const list = Array.isArray(document?.data) ? document.data : Array.isArray(document?.models) ? document.models : null;
  if (!list) throw error('provider_catalog_failed', 'catalog response has no model array');
  const unique = new Map();
  for (const item of list) {
    const id = typeof item === 'string' ? item : item?.id;
    if (typeof id !== 'string' || !id.trim()) throw error('provider_catalog_failed', 'catalog contains an invalid model id');
    unique.set(id, { id, name: typeof item?.name === 'string' ? item.name : id });
  }
  return [...unique.values()];
}

export default {
  apiVersion: 1,
  descriptor: {
    id: 'shisa',
    version: VERSION,
    owner: 'hub',
    name: { en: 'Shisa', 'zh-CN': 'Shisa', 'zh-TW': 'Shisa', ja: 'Shisa' },
    authMethods: ['device-code'],
    // Nothing to paste: the person approves a code in the browser. The endpoint
    // is learned from the sign-in response, so it is not a configuration field.
    configuration: { modelDeclarations: false, fields: [] },
    catalog: { refresh: true },
  },
  configure(input, previous) {
    if (input.url !== undefined || input.api !== undefined) throw error('validation_failed', 'Shisa learns its endpoint from sign-in; there is nothing to set here');
    if (input.declarations !== undefined) throw error('validation_failed', 'Shisa does not accept custom model declarations');
    // Keep whatever sign-in established; before sign-in there is no endpoint.
    return { url: previous?.url || null, api: previous?.api || null };
  },
  async fetchCatalog({ endpoint, credential, catalogUrl }) {
    const catalogSource = catalogUrl || derivedCatalogUrl(endpoint);
    if (catalogSource) {
      try {
        const document = await getJson(catalogSource, credential, { accept: MODEL_CATALOG_ACCEPT });
        const offerings = Array.isArray(document?.modelOfferings) ? document.modelOfferings : null;
        if (!offerings) throw new Error('the catalog has no modelOfferings list');
        const unique = new Map();
        for (const offering of offerings) {
          const model = offeringToModel(offering);
          if (model && !unique.has(model.id)) unique.set(model.id, model);
        }
        if (!unique.size) throw new Error('the catalog listed no usable models');
        return { models: [...unique.values()], catalogUrl: catalogSource };
      } catch (e) {
        const models = await fetchOpenAiModels(endpoint, credential);
        return { models, note: `the model catalog could not be read (${e.message}); thinking levels are not shown` };
      }
    }
    const models = await fetchOpenAiModels(endpoint, credential);
    return { models, note: 'no model catalog URL was learned at sign-in; thinking levels are not shown' };
  },
  // The hub calls this to start an authorization; the operation is the hub's,
  // the steps and the vendor protocol are this plugin's.
  async beginAuth({ providerId, report, signal }) {
    const gateway = gatewayUrl();
    const code = await postJson(`${gateway}/device/code`, {
      client_id: CLIENT_ID,
      client_version: String(VERSION),
      install_id: installId(providerId || 'shisa'),
      device_name: os.hostname(),
      platform: `${process.platform}-${process.arch}`,
    }, { signal }).catch((e) => { throw error('upstream_blocked', `could not reach the Shisa platform: ${e.message}`); });
    if (code.status !== 201 || !code.body?.device_code || !code.body?.user_code || !code.body?.verification_uri) {
      throw error('upstream_blocked', `the Shisa platform could not start the sign-in request (HTTP ${code.status})`);
    }
    const expiresIn = Number(code.body.expires_in) > 0 ? Number(code.body.expires_in) : 900;
    report({
      kind: 'device-code',
      userCode: String(code.body.user_code),
      verifyUrl: typeof code.body.verification_uri_complete === 'string' && code.body.verification_uri_complete ? code.body.verification_uri_complete : String(code.body.verification_uri),
      expiresInSeconds: expiresIn,
      intervalSeconds: Number(code.body.interval) > 0 ? Number(code.body.interval) : 5,
    });
    const deadline = Date.now() + expiresIn * 1000;
    let intervalMs = Math.max(1, Number(code.body.interval) || 5) * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalMs, undefined, { signal });
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      const token = await postJson(`${gateway}/device/token`, { client_id: CLIENT_ID, device_code: code.body.device_code }, { signal });
      if (token.status === 200) {
        const t = token.body;
        if (!t?.api_key?.secret || !t?.endpoints?.openai_base_url) throw error('upstream_blocked', 'the Shisa platform returned an unexpected sign-in response');
        // Acknowledgement is idempotent and only gates the delivery window.
        if (t.link_token) {
          try { await postJson(`${gateway}/device/link/ack`, {}, { signal, token: String(t.link_token) }); } catch { /* best effort */ }
        }
        return {
          credential: String(t.api_key.secret),
          endpoint: { url: String(t.endpoints.openai_base_url), api: 'openai-completions' },
          ...(typeof t.endpoints.model_catalog_url === 'string' && t.endpoints.model_catalog_url ? { catalogUrl: t.endpoints.model_catalog_url } : {}),
          account: {
            ...(t.org?.name ? { org: String(t.org.name) } : {}),
            ...(t.user?.email ? { email: String(t.user.email) } : {}),
          },
        };
      }
      const wire = wireErrorName(token.body);
      if (token.status >= 500 || token.status === 429 || token.status === 408 || wire === 'authorization_pending') continue;
      if (wire === 'slow_down') { intervalMs += 5000; continue; }
      if (wire === 'expired_token') throw error('upstream_blocked', 'the sign-in request expired; start it again');
      if (wire === 'access_denied') throw error('upstream_blocked', 'the sign-in request was declined in the browser; start it again');
      throw error('upstream_blocked', `Shisa sign-in failed (HTTP ${token.status})`);
    }
    throw error('upstream_blocked', 'the sign-in request expired; start it again');
  },
};
