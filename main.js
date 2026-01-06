const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let mainWindow;
let genAI;
let model;

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
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b"
];
let currentModelIndex = 0;

function initializeAI(apiKey) {
  if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: MODELS[currentModelIndex] });
    return true;
  }
  return false;
}

function switchToNextModel() {
  if (currentModelIndex < MODELS.length - 1) {
    currentModelIndex++;
    model = genAI.getGenerativeModel({ model: MODELS[currentModelIndex] });
    console.log(`Switched to model: ${MODELS[currentModelIndex]}`);
    return true;
  }
  return false;
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    x: width - 520,
    y: 50,
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

  mainWindow.setContentProtection(true);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  globalShortcut.register('CommandOrControl+Shift+A', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true);
    }
  });
}

app.whenReady().then(() => {
  // Try to load saved API key
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

ipcMain.handle('check-api-key', () => {
  return !!model;
});
ipcMain.handle('save-api-key', async (event, apiKey) => {
  if (!apiKey || apiKey.trim() === '') {
    return { success: false, error: 'API key cannot be empty' };
  }

  if (!apiKey.startsWith('AI') || apiKey.length < 30) {
    return { success: false, error: 'Invalid API key format. Keys should start with "AI" and be at least 30 characters.' };
  }
  try {
    saveApiKey(apiKey);
    initializeAI(apiKey);
    return { success: true };
  } catch (err) {
    return { success: false, error: 'Failed to save API key: ' + err.message };
  }
});

ipcMain.handle('analyze-text', async (event, text) => {
  if (!model) {
    return { type: 'error', response: 'API Key not configured. Click the settings icon to add your key.' };
  }

  const prompt = `
    You are a helpful and intelligent AI assistant powered by Google Gemini.
    Your goal is to provide accurate, concise, and well-structured responses to the user's queries.

    User Query: ${text}
  `;

  let attempts = 0;
  const maxAttempts = MODELS.length;

  while (attempts < maxAttempts) {
    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return { type: 'success', response: response.text(), model: MODELS[currentModelIndex] };
    } catch (err) {
      const errorMessage = err.message || '';

      if (errorMessage.includes('429') || errorMessage.includes('quota') || errorMessage.includes('rate')) {
        console.log(`Rate limit hit on ${MODELS[currentModelIndex]}, trying next model...`);

        if (switchToNextModel()) {
          attempts++;
          continue;
        } else {
          return {
            type: 'error',
            response: `All models rate limited. Please wait a few minutes and try again.\n\nModels tried: ${MODELS.slice(0, currentModelIndex + 1).join(', ')}`
          };
        }
      }

      // Other errors
      return { type: 'error', response: 'AI Error: ' + err.message };
    }
  }

  return { type: 'error', response: 'Failed after trying all available models.' };
});

ipcMain.on('close-app', () => mainWindow.hide());
ipcMain.on('quit-app', () => app.quit());
