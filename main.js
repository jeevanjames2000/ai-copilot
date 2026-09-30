const { app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { ModelRegistry } = require('./ModelRegistry');

let mainWindow;
let genAI;
let model;
let chatSession;
let pendingScreenshot = null;
let chatHistory = [];
let registry;

/* ================================================================== *
 * config
 * ================================================================== */

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function readConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error('Error loading config:', err);
  }
  return {};
}

function writeConfig(config) {
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving config:', err);
    return false;
  }
}

function loadApiKey() {
  return readConfig().GEMINI_API_KEY || readConfig().apiKey || null;
}

async function getProviderKey(name) {
  const config = readConfig();
  if (config[name]) return config[name];
  return process.env[name];
}

/** The model the user explicitly pinned for a provider, if any. */
function getPinnedModel(provider) {
  const config = readConfig();
  const pinned = config.SELECTED_MODELS || {};
  if (pinned[provider]) return pinned[provider];
  // legacy single-field setting
  if (provider === 'openrouter') return config.OPENROUTER_MODEL || null;
  return null;
}

function setPinnedModel(provider, modelId) {
  const config = readConfig();
  config.SELECTED_MODELS = { ...(config.SELECTED_MODELS || {}), [provider]: modelId || undefined };
  if (provider === 'openrouter') config.OPENROUTER_MODEL = modelId || undefined;
  writeConfig(config);
}

/**
 * Resolve the model id to actually send. An empty pin means "always use the
 * latest the provider offers", which is the default.
 */
async function modelFor(provider) {
  const pinned = getPinnedModel(provider);
  return registry.resolve(provider, pinned);
}

/* ================================================================== *
 * Gemini
 * ================================================================== */

const SYSTEM_INSTRUCTION =
  'You are an expert in Web Dev & CS Fundamentals. \nRULES:\n1. AVOID advanced DSA. Use logical patterns.\n2. Output JavaScript code blocks for solutions.\n3. STRUCTURE:\n   // 1. Brute Force\n   [Compact Code]\n   // 2. Optimal\n   [Compact Code]\n   ### 3. Dry Run\n   [Short trace, small input, 3-4 lines]\n   ### 4. Complexity\n   Time: O(...) | Space: O(...) [Very brief reasoning]\n4. Code Formatting: COMPACT, NO indentation, end-of-line comments only.';

const SYSTEM_PROMPT =
  'You are an expert in Web Dev & CS Fundamentals. RULES: 1. AVOID advanced DSA. 2. Output JS code. 3. Structure: // 1. Brute, // 2. Optimal, ### 3. Dry Run, ### 4. Complexity. 4. COMPACT FORMAT.';

// Populated live from the Gemini API; walked down when we hit a 429.
let geminiModels = [];
let currentModelIndex = 0;

async function refreshGeminiChain() {
  const ids = await registry.list('gemini');
  const pinned = getPinnedModel('gemini');
  // A pinned model becomes the first attempt; the rest stay as fallbacks.
  geminiModels = pinned && ids.includes(pinned) ? [pinned, ...ids.filter((i) => i !== pinned)] : ids;
  if (!geminiModels.length) geminiModels = ['gemini-flash-latest'];
  currentModelIndex = 0;
  return geminiModels;
}

function initializeAI(apiKey, history = []) {
  if (!apiKey) return false;
  try {
    const modelId = geminiModels[currentModelIndex] || 'gemini-flash-latest';
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: modelId,
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    });
    chatSession = model.startChat({
      history,
      generationConfig: { maxOutputTokens: 8000 },
    });
    console.log('[gemini] using', modelId);
    return true;
  } catch (e) {
    console.error('Failed to init AI:', e);
    return false;
  }
}

/**
 * Sort a provider error into how we should react to it.
 *
 *   fatal     - credentials/permissions; trying another model changes nothing
 *   unusable  - this model can't serve our request shape; remember and skip it
 *   missing   - the model is gone from the API
 *   transient - overload, rate limit, network; the SAME model may work later
 */
function classifyModelError(msg = '') {
  if (/\b401\b|\b403\b|api key not valid|permission denied|unauthorized/i.test(msg)) return 'fatal';
  if (
    /developer instruction is not enabled|system.?instruction|not enabled|not supported|unsupported|invalid argument|\b400\b/i.test(
      msg
    )
  )
    return 'unusable';
  if (/\b404\b|not found/i.test(msg)) return 'missing';
  if (
    /\b(429|500|502|503|504)\b|quota|rate.?limit|overload|high demand|service unavailable|try again later|timeout|etimedout|econnreset|fetch failed/i.test(
      msg
    )
  )
    return 'transient';
  return 'unknown';
}

function switchToNextModel() {
  if (currentModelIndex < geminiModels.length - 1) {
    currentModelIndex++;
    console.log(`Switching to model: ${geminiModels[currentModelIndex]}`);
    return initializeAI(loadApiKey(), chatHistory);
  }
  return false;
}

/* ================================================================== *
 * window placement
 *
 * The old build asked for screen.getPrimaryDisplay() and positioned with
 * `x: width - 520`, which ignores workArea.x. On a multi-monitor Mac that
 * always lands the overlay on the built-in display, and because the window
 * was never marked visible-on-all-workspaces it also stayed stuck on the
 * Space it launched in. Both are fixed here.
 * ================================================================== */

const DEFAULT_SIZE = { width: 500, height: 600 };
const EDGE_MARGIN = 20;

/** The display the user is actually looking at, i.e. the one with the cursor. */
function getActiveDisplay() {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

/** Top-right corner of a given display, in global screen coordinates. */
function boundsForDisplay(display, size = DEFAULT_SIZE) {
  const wa = display.workArea; // already excludes menu bar / dock
  const width = Math.min(size.width, Math.max(320, wa.width - EDGE_MARGIN * 2));
  const height = Math.min(size.height, Math.max(240, wa.height - EDGE_MARGIN * 2));
  return {
    width: Math.round(width),
    height: Math.round(height),
    x: Math.round(wa.x + wa.width - width - EDGE_MARGIN),
    y: Math.round(wa.y + EDGE_MARGIN + 30),
  };
}

/** Keep the window inside whatever display it currently overlaps. */
function clampToDisplay(win) {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - b.width);
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - b.height);
  if (x !== b.x || y !== b.y) win.setBounds({ ...b, x: Math.round(x), y: Math.round(y) });
}

/**
 * Make the window behave like an overlay rather than a normal app window:
 * float above everything (including fullscreen apps) and appear on whichever
 * Space / desktop the user is currently on.
 */
function applyOverlayBehavior(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
    if (process.platform === 'darwin') win.setFullScreenable(false);
  } catch (e) {
    console.error('applyOverlayBehavior failed:', e.message);
  }
}

/** Move the overlay onto the display the cursor is on, preserving its size. */
function moveToActiveDisplay(win, { force = false } = {}) {
  if (!win || win.isDestroyed()) return;
  const active = getActiveDisplay();
  const b = win.getBounds();
  const current = screen.getDisplayMatching(b);
  if (!force && current && current.id === active.id) {
    clampToDisplay(win);
    return;
  }
  win.setBounds(boundsForDisplay(active, { width: b.width, height: b.height }));
}

/** Show on the current screen + current Space without stealing focus. */
function showOverlay({ focus = true } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  moveToActiveDisplay(mainWindow);
  applyOverlayBehavior(mainWindow);
  if (focus) mainWindow.show();
  else mainWindow.showInactive();
}

/**
 * If the user walks over to another monitor and starts working there, bring
 * the overlay along. Only fires when the overlay is hidden or unfocused, so it
 * never yanks the window out from under an active cursor drag.
 */
let followTimer = null;
function startDisplayFollower() {
  const FOLLOW_INTERVAL_MS = 1200;
  let settledOn = null;
  let settledCount = 0;

  followTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    if (mainWindow.isFocused()) return; // user is typing in it, leave it alone
    if (readConfig().FOLLOW_ACTIVE_SCREEN === false) return;

    const active = getActiveDisplay();
    const currentId = screen.getDisplayMatching(mainWindow.getBounds()).id;
    if (active.id === currentId) {
      settledOn = null;
      settledCount = 0;
      return;
    }
    // Require the cursor to stay on the other display for two ticks so a
    // quick pass-through doesn't drag the window around.
    if (settledOn === active.id) settledCount++;
    else {
      settledOn = active.id;
      settledCount = 1;
    }
    if (settledCount >= 2) {
      moveToActiveDisplay(mainWindow, { force: true });
      applyOverlayBehavior(mainWindow);
      settledOn = null;
      settledCount = 0;
    }
  }, FOLLOW_INTERVAL_MS);
}

/* ================================================================== *
 * capture
 * ================================================================== */

/** Grab the display the user is looking at, not always the built-in one. */
async function captureActiveDisplay() {
  const display = getActiveDisplay();
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  const source =
    sources.find((s) => String(s.display_id) === String(display.id)) || sources[0] || null;
  return source ? source.thumbnail : null;
}

/* ================================================================== *
 * window
 * ================================================================== */

function createWindow() {
  const start = boundsForDisplay(getActiveDisplay());

  mainWindow = new BrowserWindow({
    ...start,
    title: 'Sticky Notes', // Camouflage
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    skipTaskbar: true,
    show: false,
  });

  mainWindow.loadFile('index.html');
  mainWindow.setContentProtection(true);
  applyOverlayBehavior(mainWindow);

  mainWindow.once('ready-to-show', () => showOverlay({ focus: true }));

  // Displays can come and go (docking a laptop, unplugging a monitor).
  screen.on('display-removed', () => moveToActiveDisplay(mainWindow, { force: true }));
  screen.on('display-metrics-changed', () => clampToDisplay(mainWindow));

  // Only watch once the page can actually receive the event — an IPC message
  // sent before the renderer finishes loading is silently discarded.
  mainWindow.webContents.on('did-finish-load', () => startClipboardWatcher());

  startDisplayFollower();
  registerShortcuts();
}

function registerShortcuts() {
  // Toggle visibility — always reappears on the current screen and Space.
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showOverlay({ focus: true });
  });

  // Yank the overlay to the screen the cursor is on, right now.
  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    moveToActiveDisplay(mainWindow, { force: true });
    showOverlay({ focus: true });
  });

  // Capture the active screen for analysis.
  globalShortcut.register('CommandOrControl+Shift+H', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wasVisible = mainWindow.isVisible();
    try {
      if (wasVisible) mainWindow.hide();
      setTimeout(async () => {
        try {
          const image = await captureActiveDisplay();
          if (image) {
            pendingScreenshot = {
              inlineData: { data: image.toPNG().toString('base64'), mimeType: 'image/png' },
            };
            mainWindow.webContents.send('screenshot-captured');
            console.log('Screenshot captured for analysis');
          }
        } catch (e) {
          console.error('Screenshot failed:', e);
        } finally {
          showOverlay({ focus: true });
        }
      }, 200);
    } catch (e) {
      console.error('Screenshot failed:', e);
      showOverlay({ focus: true });
    }
  });
}

let clipboardTimer = null;

function startClipboardWatcher() {
  if (clipboardTimer) return; // survive reloads without stacking intervals
  const { clipboard } = require('electron');

  // Seed with what is already on the clipboard, so the first tick reacts to
  // the next real copy rather than replaying stale content at startup.
  let lastClipboardText = clipboard.readText();

  clipboardTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const text = clipboard.readText();
    if (!text || text === lastClipboardText || !text.trim()) return;
    lastClipboardText = text;
    mainWindow.webContents.send('clipboard-changed', text);
  }, 1000);
}

/* ================================================================== *
 * app lifecycle
 * ================================================================== */

app.whenReady().then(async () => {
  // Accessory app: no Dock icon, and critically, showing the window never
  // yanks macOS to another Space.
  if (process.platform === 'darwin') {
    try {
      app.setActivationPolicy('accessory');
      app.dock.hide();
    } catch (e) {
      console.error('activation policy:', e.message);
    }
  }

  registry = new ModelRegistry(app.getPath('userData'), getProviderKey);

  // Pull today's model list before the first call, but never block the UI on it.
  await refreshGeminiChain().catch(() => {});
  const savedKey = loadApiKey();
  if (savedKey) initializeAI(savedKey);

  createWindow();

  // Warm the rest of the providers in the background.
  registry
    .refreshAll()
    .then(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('models-updated');
    })
    .catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showOverlay({ focus: true });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (followTimer) clearInterval(followTimer);
  if (clipboardTimer) clearInterval(clipboardTimer);
});

/* ================================================================== *
 * providers
 * ================================================================== */

async function callGroq(userMsg, systemPrompt) {
  const key = await getProviderKey('GROQ_API_KEY');
  if (!key) throw new Error('No Groq Key');
  const modelId = await modelFor('groq');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 429) throw new Error('Groq: Rate Limit Reached');
    if (response.status === 404 || response.status === 400) {
      // Model was retired between refreshes — force a re-list and retry once.
      await registry.list('groq', { force: true });
      throw new Error(`Groq: model ${modelId} rejected (${response.status}). Model list refreshed.`);
    }
    throw new Error(`Groq Error ${response.status}: ${body}`);
  }
  const data = await response.json();
  return { text: data.choices[0].message.content, model: modelId };
}

async function callClaude(userMsg, systemPrompt, imageBase64) {
  const key = await getProviderKey('CLAUDE_API_KEY');
  if (!key) throw new Error('No Claude Key');
  const modelId = await modelFor('claude');

  const content = [];
  if (imageBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });
  }
  content.push({ type: 'text', text: userMsg });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) {
    const t = await response.text().catch(() => '');
    if (response.status === 402) throw new Error('Claude: Payment Required (Check Credits)');
    if (response.status === 429) throw new Error('Claude: Rate Limit Exceeded');
    if (response.status === 401) throw new Error('Claude: Invalid API Key');
    if (response.status === 404) {
      await registry.list('claude', { force: true });
      throw new Error(`Claude: model ${modelId} not found. Model list refreshed.`);
    }
    throw new Error(`Claude ${response.status}: ${t}`);
  }
  const data = await response.json();
  return { text: data.content[0].text, model: modelId };
}

async function callDeepSeek(userMsg, systemPrompt) {
  const key = await getProviderKey('DEEP_SEEK_API_KEY');
  if (!key) throw new Error('No DeepSeek Key');
  const modelId = await modelFor('deepseek');

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    if (response.status === 402) throw new Error('DeepSeek: Payment Required (No Balance)');
    throw new Error('DeepSeek Error ' + response.status);
  }
  const data = await response.json();
  return { text: data.choices[0].message.content, model: modelId };
}

async function callOpenRouter(userMsg, systemPrompt) {
  const key = await getProviderKey('OPENROUTER_API_KEY');
  if (!key) throw new Error('No OpenRouter Key');
  const modelId = await modelFor('openrouter');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/jeevanjames2000/ai-copilot',
      'X-Title': 'AI Copilot',
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => 'No Body');
    if (response.status === 429) throw new Error('OpenRouter: Rate Limit (429)');
    if (response.status === 402) throw new Error('OpenRouter: No Credits (402)');
    throw new Error(`OpenRouter ${response.status}: ${errBody}`);
  }
  const data = await response.json();
  if (data.error) throw new Error('OpenRouter API Error: ' + JSON.stringify(data.error));
  if (!data.choices || !data.choices[0]) throw new Error('OpenRouter: Empty Response');
  return { text: data.choices[0].message.content, model: modelId };
}

/* ================================================================== *
 * IPC
 * ================================================================== */

let activeProvider = 'gemini';

ipcMain.handle('check-api-key', () => !!model);

ipcMain.handle('get-settings', () => {
  const config = readConfig();
  if (Object.keys(config).length) return config;
  return {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
    DEEP_SEEK_API_KEY: process.env.DEEP_SEEK_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    SELECTED_MODELS: {},
  };
});

ipcMain.handle('save-settings', async (event, config) => {
  try {
    const existing = readConfig();
    const merged = { ...existing, ...config };
    // Keep the legacy OPENROUTER_MODEL field and the SELECTED_MODELS map in
    // sync, so the settings dropdown and the title-bar dropdown agree.
    if ('OPENROUTER_MODEL' in config) {
      merged.SELECTED_MODELS = {
        ...(merged.SELECTED_MODELS || {}),
        openrouter: config.OPENROUTER_MODEL || undefined,
      };
    }
    writeConfig(merged);
    // New keys may unlock providers we couldn't list before.
    await registry.refreshAll({ force: true }).catch(() => {});
    await refreshGeminiChain().catch(() => {});
    if (config.GEMINI_API_KEY) initializeAI(config.GEMINI_API_KEY);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-model-provider', (event, provider) => {
  console.log('Setting provider to:', provider);
  activeProvider = provider;
  return true;
});

/** Live model list for a provider, newest first. */
ipcMain.handle('get-models', async (event, provider, opts = {}) => {
  try {
    const ids = await registry.list(provider, { force: !!opts.force });
    return { success: true, models: ids, selected: getPinnedModel(provider) || ids[0] || null };
  } catch (e) {
    return { success: false, error: e.message, models: [] };
  }
});

/** Force a re-fetch of every provider's catalog. */
ipcMain.handle('refresh-models', async () => {
  try {
    const all = await registry.refreshAll({ force: true });
    await refreshGeminiChain();
    if (activeProvider === 'gemini') initializeAI(loadApiKey(), chatHistory);
    return { success: true, models: all };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

/** Pin a specific model, or pass null to go back to "always latest". */
ipcMain.handle('set-model', async (event, provider, modelId) => {
  setPinnedModel(provider, modelId || null);
  if (provider === 'gemini') {
    await refreshGeminiChain();
    initializeAI(loadApiKey(), chatHistory);
  }
  return true;
});

ipcMain.handle('analyze-text', async (event, payload) => {
  try {
    if (!model || !chatSession) {
      const key = await getProviderKey('GEMINI_API_KEY');
      if (key) {
        await refreshGeminiChain().catch(() => {});
        initializeAI(key);
      }
    }

    let text = '';
    let audioData = null;
    let directImage = null;
    if (typeof payload === 'string') text = payload;
    else if (payload) {
      text = payload.text || '';
      audioData = payload.audio || null;
      directImage = payload.image || null;
    }

    const parts = [];
    let combinedImage = null;

    if (directImage) {
      combinedImage = directImage;
      parts.push({ inlineData: { data: directImage, mimeType: 'image/png' } });
    } else if (pendingScreenshot) {
      combinedImage = pendingScreenshot.inlineData.data;
      parts.push(pendingScreenshot);
      pendingScreenshot = null;
    }
    if (audioData) parts.push({ inlineData: { data: audioData, mimeType: 'audio/webm' } });
    if (!text && parts.length === 0) return { type: 'error', response: 'No content.' };
    if (!text) text = 'Analyze this.';
    parts.push(text);

    console.log('Analyzing with provider:', activeProvider);

    const runGemini = async () => {
      if (!model) throw new Error('Gemini not initialized');
      let attempts = 0;
      let sweeps = 0;
      // Room for one walk down the chain, plus one retry sweep after a pause.
      const maxAttempts = Math.max(geminiModels.length, 1) * 2 + 2;
      while (attempts < maxAttempts) {
        try {
          const result = await chatSession.sendMessage(parts);
          const response = await result.response;
          return {
            type: 'success',
            response: response.text(),
            model: geminiModels[currentModelIndex],
          };
        } catch (e) {
          const msg = e.message || '';
          const failed = geminiModels[currentModelIndex];
          const kind = classifyModelError(msg);
          console.error(`Gemini [${failed}] ${kind}:`, msg);

          // Bad credentials won't improve on a different model.
          if (kind === 'fatal') throw e;

          // Permanently wrong for us: remember it so we stop picking it.
          if (kind === 'unusable' || kind === 'missing') {
            registry.blockModel('gemini', failed, msg.slice(0, 160));
            await refreshGeminiChain().catch(() => {});
            if (geminiModels.length && initializeAI(loadApiKey(), chatHistory)) {
              attempts++;
              continue;
            }
            throw e;
          }

          // Overloaded or rate limited: the model is fine, the moment isn't.
          // Try the next one down the chain rather than giving up.
          if (kind === 'transient') {
            if (switchToNextModel()) {
              attempts++;
              continue;
            }
            // Whole chain is busy — a demand spike usually hits several models
            // at once, so pause briefly and sweep from the top one more time.
            if (sweeps < 1) {
              sweeps++;
              await new Promise((r) => setTimeout(r, 1500));
              currentModelIndex = 0;
              if (initializeAI(loadApiKey(), chatHistory)) {
                attempts++;
                continue;
              }
            }
            throw new Error(`All Gemini models are busy right now. Last tried ${failed}.`);
          }

          throw e;
        }
      }
      throw new Error('All Gemini models exhausted');
    };

    const wrap = (fn, label) => async () => {
      const r = await fn();
      return { type: 'success', response: r.text, model: `${label}: ${r.model}` };
    };
    const runGroq = wrap(() => callGroq(text, SYSTEM_PROMPT), 'Groq');
    const runClaude = wrap(() => callClaude(text, SYSTEM_PROMPT, combinedImage), 'Claude');
    const runDeepSeek = wrap(() => callDeepSeek(text, SYSTEM_PROMPT), 'DeepSeek');
    const runOpenRouter = wrap(() => callOpenRouter(text, SYSTEM_PROMPT), 'OpenRouter');

    try {
      if (activeProvider === 'groq') return await runGroq();
      if (activeProvider === 'claude') return await runClaude();
      if (activeProvider === 'deepseek') return await runDeepSeek();
      if (activeProvider === 'openrouter') return await runOpenRouter();
      return await runGemini();
    } catch (primaryErr) {
      const errors = [`${activeProvider}: ${primaryErr.message}`];
      console.error(`${activeProvider} failed:`, primaryErr.message);

      try {
        if (activeProvider !== 'groq') return await runGroq();
      } catch (e) {
        errors.push(`Groq: ${e.message}`);
      }
      try {
        if (activeProvider !== 'gemini') return await runGemini();
      } catch (e) {
        errors.push(`Gemini: ${e.message}`);
      }
      try {
        if (activeProvider !== 'claude') return await runClaude();
      } catch (e) {
        errors.push(`Claude: ${e.message}`);
      }
      try {
        if (activeProvider !== 'deepseek') return await runDeepSeek();
      } catch (e) {
        errors.push(`DeepSeek: ${e.message}`);
      }
      try {
        if (activeProvider !== 'openrouter') return await runOpenRouter();
      } catch (e) {
        errors.push(`OpenRouter: ${e.message}`);
      }

      return { type: 'error', response: `All Providers Failed:\n${errors.join('\n')}` };
    }
  } catch (fatalErr) {
    console.error('Fatal analyze-text error:', fatalErr);
    return { type: 'error', response: 'Internal Error: ' + fatalErr.message };
  }
});

ipcMain.handle('capture-screen', async () => {
  try {
    const image = await captureActiveDisplay();
    if (image) {
      return { success: true, data: image.toPNG().toString('base64'), mimeType: 'image/png' };
    }
  } catch (e) {
    console.error('Screen capture error:', e);
    return { success: false, error: e.message };
  }
  return { success: false, error: 'No source found' };
});

ipcMain.handle('clear-pending-screenshot', () => {
  pendingScreenshot = null;
  return true;
});

/** Manually pull the overlay onto the screen the cursor is on. */
ipcMain.handle('move-to-active-screen', () => {
  moveToActiveDisplay(mainWindow, { force: true });
  showOverlay({ focus: true });
  return true;
});

ipcMain.on('log-error', (event, msg) => console.error('[Renderer Error]:', msg));
ipcMain.on('close-app', () => mainWindow && mainWindow.hide());
ipcMain.on('quit-app', () => app.quit());
