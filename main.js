const { app, BrowserWindow, ipcMain, screen, globalShortcut, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let mainWindow;
let genAI;
let model;
let chatSession;
let pendingScreenshot = null; 
let chatHistory = []; 

function getConfigPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'config.json');
}
function loadApiKey() {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return config.apiKey || null;
    }
  } catch (err) {
    console.error('Error loading config:', err);
  }
  return null;
}

function saveApiKey(apiKey) {
  try {
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify({ apiKey }), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving config:', err);
    return false;
  }
}

const MODELS = [
  "gemini-2.0-flash-exp",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

// ... (rest of imports/init)

async function getOpenRouterModel() {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        // Fallback to Mistral Free if not specified, as it's reliable
        return config.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';
    }
    return process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';
}

async function callOpenRouter(userMsg, systemPrompt) {
    const key = await getProviderKey('OPENROUTER_API_KEY');
    const model = await getOpenRouterModel();
    if (!key) throw new Error("No OpenRouter Key");

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
             'HTTP-Referer': 'https://github.com/jeevanjames2000/ai-copilot', 
             'X-Title': 'AI Copilot'
        },
        body: JSON.stringify({
            model: model,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMsg }
            ]
        })
    });
    
    if(!response.ok) {
        let errBody;
        try { errBody = await response.text(); } catch(e) { errBody = "No Body"; }
        
        if(response.status === 429) throw new Error("OpenRouter: Rate Limit (429)");
        if(response.status === 402) throw new Error("OpenRouter: No Credits (402)");
        throw new Error(`OpenRouter ${response.status}: ${errBody}`);
    }
    const data = await response.json();
    if(data.error) throw new Error("OpenRouter API Error: " + JSON.stringify(data.error));
    if(!data.choices || !data.choices[0]) throw new Error("OpenRouter: Empty Response");
    
    return data.choices[0].message.content;
}
let currentModelIndex = 0;

function initializeAI(apiKey, history = []) {
  if (apiKey) {
    try {
      genAI = new GoogleGenerativeAI(apiKey);
      model = genAI.getGenerativeModel({ 
          model: MODELS[currentModelIndex],
          systemInstruction: {
              parts: [{ text: "You are an expert in Web Dev & CS Fundamentals. \nRULES:\n1. AVOID advanced DSA. Use logical patterns.\n2. Output JavaScript code blocks for solutions.\n3. STRUCTURE:\n   // 1. Brute Force\n   [Compact Code]\n   // 2. Optimal\n   [Compact Code]\n   ### 3. Dry Run\n   [Short trace, small input, 3-4 lines]\n   ### 4. Complexity\n   Time: O(...) | Space: O(...) [Very brief reasoning]\n4. Code Formatting: COMPACT, NO indentation, end-of-line comments only." }]
          }
      });
      
      // Initialize Chat Session
      chatSession = model.startChat({
        history: history,
        generationConfig: {
          maxOutputTokens: 8000,  
        },
      });
      return true;
    } catch (e) {
      console.error("Failed to init AI:", e);
      return false;
    }
  }
  return false;
}

function switchToNextModel() {
  if (currentModelIndex < MODELS.length - 1) {
    currentModelIndex++;
    console.log(`Switching to model: ${MODELS[currentModelIndex]}`);
    
    // Re-initialize with preservation of history
    const apiKey = loadApiKey();
    // Getting current history from the failed session might be partial, 
    // but we use our local 'chatHistory' backup which is synced after success.
    return initializeAI(apiKey, chatHistory);
  }
  return false;
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    x: width - 520,
    y: 50,
    title: "Sticky Notes", // Camouflage
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
    show: true,
  });

  mainWindow.loadFile('index.html');
  mainWindow.setContentProtection(true); // Protects window from being captured by other apps (optional)
  
 
  // mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Toggle Visibility
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
    }
  });
  // Capture Screenshot (Smart Analysis)
  globalShortcut.register('CommandOrControl+Shift+H', async () => {
    try {
      // Hide window to capture screen behind it
      const wasVisible = mainWindow.isVisible();
      if (wasVisible) mainWindow.hide();

      // Small delay to ensure window is hidden
      setTimeout(async () => {
        const displaySize = primaryDisplay.size;
        
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: displaySize
        });

        const primarySource = sources[0]; // Usually the first one is the main screen
        
        if (primarySource) {
          const image = primarySource.thumbnail;
          pendingScreenshot = {
            inlineData: {
              data: image.toPNG().toString('base64'),
              mimeType: "image/png"
            }
          };
          
          // Show window again
          if (wasVisible) mainWindow.show();
          else mainWindow.show();

          // Notify UI
          mainWindow.webContents.send('screenshot-captured');
          console.log('Screenshot captured for analysis');
        }
      }, 200);

    } catch (e) {
      console.error("Screenshot failed:", e);
    }
  });

  // --- Clipboard Watcher ---
  let lastClipboardText = "";
  setInterval(() => {
    const { clipboard } = require('electron');
    const text = clipboard.readText();
    if (text && text !== lastClipboardText && text.trim().length > 0) {
        lastClipboardText = text;
        
        // Simple heuristic: Is this a question or code? 
        // We can send to UI to decide if it should auto-run
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('clipboard-changed', text);
        }
    }
  }, 1000); // Check every second
}

app.whenReady().then(() => {
  const savedKey = loadApiKey();
  if (savedKey) {
    initializeAI(savedKey);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('check-api-key', () => !!model);

ipcMain.handle('get-settings', () => {
    const configPath = getConfigPath();
    if(fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    return {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        CLAUDE_API_KEY: process.env.CLAUDE_API_KEY,
        DEEP_SEEK_API_KEY: process.env.DEEP_SEEK_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        OPENROUTER_MODEL: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free'
    };
});



async function callGroq(userMsg, systemPrompt) {
    const key = await getProviderKey('GROQ_API_KEY');
    if (!key) throw new Error("No Groq Key");

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: "llama3-70b-8192",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMsg }
            ]
        })
    });
    
    if(!response.ok) {
        if(response.status === 429) throw new Error("Groq: Rate Limit Reached");
        throw new Error("Groq Error " + response.status);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

// ... existing callClaude ...

// Main AI Handler
ipcMain.handle('analyze-text', async (event, payload) => {
 try {
  // Prep (Keep same)
  if (!model || !chatSession) {
      const key = await getProviderKey('GEMINI_API_KEY');
      if (key) initializeAI(key);
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
      parts.push({ inlineData: { data: directImage, mimeType: "image/png" } });
  } else if (pendingScreenshot) {
      combinedImage = pendingScreenshot.inlineData.data;
      parts.push(pendingScreenshot);
      pendingScreenshot = null;
  }
  if (audioData) parts.push({ inlineData: { data: audioData, mimeType: "audio/webm" } });
  if (!text && parts.length === 0) return { type: 'error', response: 'No content.' };
  if (!text) text = "Analyze this.";
  parts.push(text);

  const SYSTEM_PROMPT = "You are an expert in Web Dev & CS Fundamentals. RULES: 1. AVOID advanced DSA. 2. Output JS code. 3. Structure: // 1. Brute, // 2. Optimal, ### 3. Dry Run, ### 4. Complexity. 4. COMPACT FORMAT.";

  // ROUTING LOGIC
  console.log("Analyzing with provider:", activeProvider);
  
  // Helpers
  const runGemini = async () => {
       if(!model) throw new Error("Gemini not initialized");
       let attempts = 0;
       while(attempts < MODELS.length) {
           try {
               const result = await chatSession.sendMessage(parts);
               const response = await result.response;
               return { type: 'success', response: response.text(), model: MODELS[currentModelIndex] };
           } catch(e) {
               console.error("Gemini Attempt Error:", e.message);
               if((e.message.includes('429') || e.message.includes('quota')) && switchToNextModel()) {
                   attempts++;
                   continue;
               }
               throw e;
           }
       }
       throw new Error("All Gemini models exhausted");
  };

  const runGroq = async () => ({ type: 'success', response: await callGroq(text, SYSTEM_PROMPT), model: "Groq Llama 3" });
  const runClaude = async () => ({ type: 'success', response: await callClaude(text, SYSTEM_PROMPT, combinedImage), model: "Claude 3.5" });
  const runDeepSeek = async () => ({ type: 'success', response: await callDeepSeek(text, SYSTEM_PROMPT), model: "DeepSeek" });
  const runOpenRouter = async () => ({ type: 'success', response: await callOpenRouter(text, SYSTEM_PROMPT), model: "OpenRouter" });

  try {
      if (activeProvider === 'groq') return await runGroq();
      if (activeProvider === 'claude') return await runClaude();
      if (activeProvider === 'deepseek') return await runDeepSeek();
      if (activeProvider === 'openrouter') return await runOpenRouter();
      
      // Default: Gemini + Fallback Chain
      return await runGemini();
  } catch (primaryErr) {
      const errors = [];
      errors.push(`${activeProvider}: ${primaryErr.message}`);
      console.error(`${activeProvider} failed:`, primaryErr.message);
      
      // Fallback Chain Priority: Groq -> Gemini -> Claude -> Others
      // Don't retry same provider
      try { if(activeProvider !== 'groq') return await runGroq(); } catch(e) { errors.push(`Groq: ${e.message}`); }
      try { if(activeProvider !== 'gemini') { console.log("Fallback Gemini"); return await runGemini(); } } catch(e) { errors.push(`Gemini: ${e.message}`); }
      
      // Keep others
      try { if(activeProvider !== 'claude') return await runClaude(); } catch(e) { /* silent fail or log */ errors.push(`Claude: ${e.message}`); }
      try { if(activeProvider !== 'deepseek') return await runDeepSeek(); } catch(e) { errors.push(`DeepSeek: ${e.message}`); }
      
      return { type: 'error', response: `All Providers Failed:\n${errors.join('\n')}` };
  }
 } catch (fatalErr) {
     console.error("Fatal analyze-text error:", fatalErr);
     return { type: 'error', response: "Internal Error: " + fatalErr.message };
 }
});

ipcMain.handle('save-settings', (event, config) => {
    const configPath = getConfigPath();
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        if(config.GEMINI_API_KEY) initializeAI(config.GEMINI_API_KEY);
        return { success: true };
    } catch(e) { return { success: false, error: e.message }; }
});

async function getProviderKey(name) {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if(config[name]) return config[name];
    }
    return process.env[name];
}

async function getOpenRouterModel() {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
    }
    return process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
}

async function callClaude(messages, systemPrompt, imageBase64) {
    const key = await getProviderKey('CLAUDE_API_KEY');
    if (!key) throw new Error("No Claude Key");
    const content = [];
    if(imageBase64) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 }});
    content.push({ type: "text", text: messages }); 
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: "claude-3-5-sonnet-20240620", max_tokens: 8000, system: systemPrompt, messages: [{ role: "user", content: content }] })
    });
    if(!response.ok) throw new Error(`Claude ${response.status}`);
    const data = await response.json();
    return data.content[0].text;
}

async function callDeepSeek(userMsg, systemPrompt) {
    const key = await getProviderKey('DEEP_SEEK_API_KEY');
    if (!key) throw new Error("No DeepSeek Key");
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: "deepseek-coder", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }], stream: false })
    });
    if(!response.ok) throw new Error("DeepSeek Error " + response.status);
    const data = await response.json();
    return data.choices[0].message.content;
}

async function callOpenRouter(userMsg, systemPrompt) {
    const key = await getProviderKey('OPENROUTER_API_KEY');
    if (!key) throw new Error("No OpenRouter Key");
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: "google/gemini-2.0-flash-exp:free", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }] })
    });
    if(!response.ok) throw new Error("OpenRouter Error " + response.status);
    const data = await response.json();
    return data.choices[0].message.content;
}

// Main AI Handler
ipcMain.handle('capture-screen', async () => {
    try {
        const primaryDisplay = screen.getPrimaryDisplay();
        const size = {
            width: primaryDisplay.size.width * primaryDisplay.scaleFactor,
            height: primaryDisplay.size.height * primaryDisplay.scaleFactor
        };

        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: size,
            fetchWindowIcons: false
        });

        const primarySource = sources.find(s => s.display_id == primaryDisplay.id.toString()) || sources[0];

        if (primarySource) {
            return {
                success: true,
                data: primarySource.thumbnail.toPNG().toString('base64'),
                mimeType: "image/png"
            };
        }
    } catch (e) {
        console.error("Screen capture error:", e);
        return { success: false, error: e.message };
    }
    return { success: false, error: "No source found" };
});

ipcMain.handle('clear-pending-screenshot', () => {
    pendingScreenshot = null;
    return true;
});

// --- Provider Switching State ---
let activeProvider = 'gemini'; // Default

ipcMain.handle('set-model-provider', (event, provider) => {
    console.log("Setting provider to:", provider);
    activeProvider = provider;
    return true;
});

// Update Provider Helpers with Logging
async function callClaude(messages, systemPrompt, imageBase64) {
    const key = await getProviderKey('CLAUDE_API_KEY');
    if (!key) throw new Error("No Claude Key");
    
    const content = [];
    if(imageBase64) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 }});
    }
    content.push({ type: "text", text: messages }); 

    const body = {
        model: "claude-3-5-sonnet-20240620",
        max_tokens: 8000,
        system: systemPrompt,
        messages: [{ role: "user", content: content }]
    };
    
    // console.log("[Claude Req]:", JSON.stringify(body).substring(0,50));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
             'x-api-key': key,
             'anthropic-version': '2023-06-01',
             'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if(!response.ok) {
        const t = await response.text();
        // Specific error mapping
        if(response.status === 402) throw new Error("Claude: Payment Required (Check Credits)");
        if(response.status === 429) throw new Error("Claude: Rate Limit Exceeded");
        if(response.status === 401) throw new Error("Claude: Invalid API Key");
        throw new Error(`Claude ${response.status}: ${t}`);
    }
    const data = await response.json();
    return data.content[0].text;
}

async function callDeepSeek(userMsg, systemPrompt) {
    const key = await getProviderKey('DEEP_SEEK_API_KEY');
    if (!key) throw new Error("No DeepSeek Key");

    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: "deepseek-coder", // Ensure this is valid; commonly 'deepseek-coder'
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMsg }
            ],
            stream: false
        })
    });
    
    if(!response.ok) {
        if(response.status === 402) throw new Error("DeepSeek: Payment Required (No Balance)");
        throw new Error("DeepSeek Error " + response.status);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

// Helper for Renderer Logging
ipcMain.on('log-error', (event, msg) => {
    console.error("[Renderer Error]:", msg);
});

ipcMain.on('close-app', () => mainWindow.hide());
ipcMain.on('quit-app', () => app.quit());
