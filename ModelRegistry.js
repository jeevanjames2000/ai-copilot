/**
 * ModelRegistry
 * -------------
 * Keeps the app's model list current by asking each provider what it actually
 * serves today, instead of trusting hardcoded model IDs that silently rot
 * (e.g. groq's llama3-70b-8192 and deepseek-coder are already retired).
 *
 * Strategy per provider:
 *   1. Hit the provider's own /models endpoint.
 *   2. Filter to chat/generate-capable models.
 *   3. Rank newest-and-best first.
 *   4. Cache to disk with a TTL so we survive being offline / rate limited.
 *   5. If everything fails, fall back to a small baked-in list.
 *
 * Nothing here throws at the caller; callers always get a usable array.
 */

const fs = require('fs');
const path = require('path');

// Bump whenever ranking or filtering changes, so old cached ORDERS are dropped.
const CACHE_VERSION = 2;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // re-check every 6h
const BLOCK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // forget a bad model after a week
const FETCH_TIMEOUT_MS = 8000;

/**
 * Last-resort IDs, only used when the live fetch AND the cache both fail.
 * These intentionally use "-latest" style aliases where a provider offers
 * them, because aliases keep working after a specific dated build retires.
 */
const FALLBACKS = {
  gemini: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  claude: ['claude-sonnet-4-5', 'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-latest'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  openrouter: ['google/gemini-2.0-flash-exp:free', 'meta-llama/llama-3.3-70b-instruct:free'],
};

/** Models we never want to offer as a chat model. */
const GEMINI_EXCLUDE = /embedding|aqa|imagen|veo|tts|image-generation|native-audio|gemma/i;
const OPENROUTER_EXCLUDE = /moderation|embedding/i;

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the release version out of a model id: "gemini-2.5-flash" -> 2.5.
 * Model ids are full of numbers that are NOT versions — parameter counts
 * (70b, 8x7b), context sizes (8192, 32768) and datestamps (20240620) — so
 * those are stripped before anything is parsed.
 */
function versionOf(id) {
  const cleaned = String(id)
    .toLowerCase()
    .replace(/\b\d+x\d+b?\b/g, ' ') // 8x7b mixture-of-experts naming
    // Month-year stamps, matched strictly so a build id like gpt-4-0125 keeps
    // its major version: the month must be 01-12 and the year 19xx/20xx.
    .replace(/\b(?:0[1-9]|1[0-2])[-/](?:19|20)\d{2}\b/g, ' ') // 09-2026
    .replace(/\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])\b/g, ' ') // 2026-09
    .replace(/\b\d{4,}\b/g, ' ') // 8192, 32768, 20240620
    .replace(/\b0\d\b/g, ' ') // 09, 05 — versions are never zero-padded
    .replace(/\b\d+(?:\.\d+)?\s*[bkm]\b/g, ' '); // 70b, 8b, 32k

  // Dotted version is the strongest signal: 2.5, 3.3
  const dotted = cleaned.match(/\b\d{1,2}\.\d{1,2}\b/g);
  if (dotted) return Math.max(...dotted.map(parseFloat));

  // Hyphenated major-minor, as Anthropic writes it: claude-3-5 -> 3.05
  const hyphenated = cleaned.match(/\b\d{1,2}-\d{1,2}\b/g);
  if (hyphenated) {
    return Math.max(
      ...hyphenated.map((h) => {
        const [maj, min] = h.split('-').map(Number);
        return maj + min / 100;
      })
    );
  }

  // Bare major version: llama3, gpt-4, claude-4. No \b here because the digit
  // is often glued to the family name ("llama3").
  const bare = cleaned.match(/(?<!\d)\d{1,2}(?!\d)/g);
  return bare ? Math.max(...bare.map(Number)) : 0;
}

/** Split an id into comparable words: "google/gemini-2.0-flash:free" -> [...] */
function tokensOf(id) {
  return String(id).toLowerCase().split(/[-_./:\s]+/).filter(Boolean);
}

/** Prefer stable builds over preview/experimental ones at the same version. */
function stabilityScore(id) {
  const t = tokensOf(id);
  if (t.includes('exp') || t.includes('experimental')) return 0;
  if (t.includes('preview') || t.includes('beta') || t.some((x) => /^rc\d*$/.test(x))) return 2;
  if (t.includes('latest')) return 6;
  return 5;
}

/**
 * Tier preference. "flash"-class models come first on purpose: this app walks
 * down the list when it hits a 429, so the high-quota fast model should be the
 * first try and the heavier model the fallback.
 *
 * Matching is done on whole tokens, not substrings — "gemini" contains "mini",
 * which would otherwise mis-tier every Google model as a lite one.
 */
function tierScore(id) {
  const t = tokensOf(id);
  const has = (...words) => words.some((w) => t.includes(w));
  if (has('lite', 'mini', 'instant', 'haiku', 'small', 'nano', 'tiny')) return 20;
  if (has('flash', 'fast', 'turbo', 'sonnet', 'versatile')) return 30;
  if (has('pro', 'opus', 'large', 'reasoner', 'max', 'ultra')) return 25;
  return 10;
}

function rank(ids) {
  return [...new Set(ids)].sort((a, b) => {
    const sa = versionOf(a) * 1000 + tierScore(a) + stabilityScore(a);
    const sb = versionOf(b) * 1000 + tierScore(b) + stabilityScore(b);
    if (sb !== sa) return sb - sa;
    return String(a).localeCompare(String(b));
  });
}

/* ------------------------------------------------------------------ *
 * per-provider fetchers -> string[] of model ids, newest/best first
 * ------------------------------------------------------------------ */

const FETCHERS = {
  async gemini(key) {
    if (!key) return [];
    const data = await fetchJSON(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`
    );
    const ids = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((id) => id && !GEMINI_EXCLUDE.test(id));
    return rank(ids);
  },

  async groq(key) {
    if (!key) return [];
    const data = await fetchJSON('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    const ids = (data.data || [])
      .filter((m) => m.active !== false)
      // drop non-chat endpoints groq also lists (whisper, guard, tts)
      .filter((m) => !/whisper|tts|guard|prompt-guard/i.test(m.id))
      .map((m) => m.id);
    return rank(ids);
  },

  async claude(key) {
    if (!key) return [];
    const data = await fetchJSON('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    // Anthropic returns newest-first already; keep that order rather than
    // re-guessing from the id, since their naming changes between generations.
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    return ids.length ? ids : [];
  },

  async deepseek(key) {
    if (!key) return [];
    const data = await fetchJSON('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return rank((data.data || []).map((m) => m.id).filter(Boolean));
  },

  async openrouter(key) {
    // OpenRouter's catalog is public — no key required to list it.
    const data = await fetchJSON('https://openrouter.ai/api/v1/models', {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    const all = (data.data || []).filter((m) => m.id && !OPENROUTER_EXCLUDE.test(m.id));

    const isFree = (m) =>
      /:free$/.test(m.id) ||
      (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0);

    // Newest first by OpenRouter's own created timestamp, free tiers surfaced
    // first because this app is normally run on free keys.
    const byNew = (a, b) => (b.created || 0) - (a.created || 0);
    const free = all.filter(isFree).sort(byNew).map((m) => m.id);
    const paid = all.filter((m) => !isFree(m)).sort(byNew).map((m) => m.id);
    return [...free, ...paid];
  },
};

/* ------------------------------------------------------------------ *
 * registry
 * ------------------------------------------------------------------ */

class ModelRegistry {
  /**
   * @param {string} cacheDir  writable dir (app.getPath('userData'))
   * @param {(name:string)=>Promise<string|undefined>} getKey  resolves an API key by env-var name
   */
  constructor(cacheDir, getKey) {
    this.cachePath = path.join(cacheDir, 'models-cache.json');
    this.getKey = getKey;
    this.cache = this._readCache();
    this.inflight = new Map();
  }

  _readCache() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
        // A cache written by an older ranking algorithm holds a stale ORDER,
        // not just stale ids, so drop it wholesale rather than trusting it.
        if (parsed.version !== CACHE_VERSION) {
          console.log('[models] cache schema changed — refetching');
          return { version: CACHE_VERSION, blocked: parsed.blocked || {} };
        }
        return parsed;
      }
    } catch (e) {
      console.error('[models] cache read failed:', e.message);
    }
    return { version: CACHE_VERSION };
  }

  _writeCache() {
    try {
      this.cache.version = CACHE_VERSION;
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (e) {
      console.error('[models] cache write failed:', e.message);
    }
  }

  _keyNameFor(provider) {
    return {
      gemini: 'GEMINI_API_KEY',
      groq: 'GROQ_API_KEY',
      claude: 'CLAUDE_API_KEY',
      deepseek: 'DEEP_SEEK_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
    }[provider];
  }

  isFresh(provider) {
    const entry = this.cache[provider];
    return !!(entry && entry.ids && entry.ids.length && Date.now() - entry.at < CACHE_TTL_MS);
  }

  /**
   * Record a model that the provider lists but cannot actually serve for this
   * app's request shape — e.g. Gemini's antigravity-preview, which advertises
   * generateContent but rejects systemInstruction with a 400. Being listed is
   * not the same as being usable, so we remember the failure and stop offering
   * it. Entries expire so a model fixed upstream comes back on its own.
   */
  blockModel(provider, id, reason = '') {
    if (!provider || !id) return;
    this.cache.blocked = this.cache.blocked || {};
    this.cache.blocked[`${provider}:${id}`] = { at: Date.now(), reason };
    console.warn(`[models] blocklisted ${provider}/${id}: ${reason}`);
    this._writeCache();
  }

  isBlocked(provider, id) {
    const entry = (this.cache.blocked || {})[`${provider}:${id}`];
    if (!entry) return false;
    if (Date.now() - entry.at > BLOCK_TTL_MS) {
      delete this.cache.blocked[`${provider}:${id}`];
      return false;
    }
    return true;
  }

  _usable(provider, ids) {
    const open = ids.filter((id) => !this.isBlocked(provider, id));
    // Never hand back an empty list just because everything is blocked.
    return open.length ? open : ids;
  }

  /**
   * Ranked model ids for a provider. Never rejects.
   * @param {string} provider
   * @param {{force?: boolean}} opts  force:true ignores the TTL
   */
  async list(provider, { force = false } = {}) {
    if (!FETCHERS[provider]) return [];
    if (!force && this.isFresh(provider)) return this._usable(provider, this.cache[provider].ids);

    // De-dupe concurrent refreshes of the same provider.
    if (this.inflight.has(provider)) return this.inflight.get(provider);

    const job = (async () => {
      try {
        const key = await this.getKey(this._keyNameFor(provider));
        const ids = await FETCHERS[provider](key);
        if (ids && ids.length) {
          this.cache[provider] = { ids, at: Date.now() };
          this._writeCache();
          const usable = this._usable(provider, ids);
          console.log(`[models] ${provider}: ${ids.length} live models, newest = ${usable[0]}`);
          return usable;
        }
        console.warn(`[models] ${provider}: provider returned no usable models`);
      } catch (e) {
        console.warn(`[models] ${provider}: live fetch failed (${e.message})`);
      }
      // stale cache beats a baked-in guess
      const stale = this.cache[provider] && this.cache[provider].ids;
      if (stale && stale.length) return this._usable(provider, stale);
      return this._usable(provider, FALLBACKS[provider] || []);
    })().finally(() => this.inflight.delete(provider));

    this.inflight.set(provider, job);
    return job;
  }

  /** The single best current model for a provider. */
  async best(provider, opts) {
    const ids = await this.list(provider, opts);
    return ids[0] || (FALLBACKS[provider] || [])[0] || null;
  }

  /**
   * Resolve which model to actually call: an explicit user pick if it is still
   * offered by the provider, otherwise today's best.
   */
  async resolve(provider, preferred, opts) {
    const ids = await this.list(provider, opts);
    if (preferred && ids.includes(preferred)) return preferred;
    if (preferred && !ids.length) return preferred; // offline: trust the pick
    return ids[0] || preferred || (FALLBACKS[provider] || [])[0] || null;
  }

  /** Warm every provider in the background; used at app start. */
  async refreshAll({ force = false } = {}) {
    const providers = Object.keys(FETCHERS);
    const out = {};
    await Promise.all(
      providers.map(async (p) => {
        out[p] = await this.list(p, { force });
      })
    );
    return out;
  }
}

module.exports = { ModelRegistry, FALLBACKS };
