const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let mainWindow;
let genAI;
let model;

// Get the path for storing the API key (in user's app data)
function getConfigPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'config.json');
}

// Load API key from config file
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

// Save API key to config file
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

// Initialize the AI model
function initializeAI(apiKey) {
  if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
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

  // WINDOWS STEALTH MODE: Hides window from screen capture, screenshots, and screen sharing
  mainWindow.setContentProtection(true);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Toggle Visibility: Ctrl+Shift+A
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

// Check if API key is configured
ipcMain.handle('check-api-key', () => {
  return !!model;
});

// Save API key from settings
ipcMain.handle('save-api-key', async (event, apiKey) => {
  if (!apiKey || apiKey.trim() === '') {
    return { success: false, error: 'API key cannot be empty' };
  }

  // Try to initialize with the new key
  try {
    const testAI = new GoogleGenerativeAI(apiKey);
    const testModel = testAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Quick validation - try to generate something simple
    await testModel.generateContent('Say "OK"');

    // Save and initialize
    saveApiKey(apiKey);
    initializeAI(apiKey);

    return { success: true };
  } catch (err) {
    return { success: false, error: 'Invalid API key: ' + err.message };
  }
});

// Handle text analysis
ipcMain.handle('analyze-text', async (event, text) => {
  if (!model) {
    return { type: 'error', response: 'API Key not configured. Click the settings icon to add your key.' };
  }

  try {
    const prompt = `
      You are a helpful and intelligent AI assistant powered by Google Gemini.
      Your goal is to provide accurate, concise, and well-structured responses to the user's queries.

      User Query: ${text}
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    return { type: 'success', response: response.text() };
  } catch (err) {
    return { type: 'error', response: 'AI Error: ' + err.message };
  }
});

ipcMain.on('close-app', () => mainWindow.hide());
ipcMain.on('quit-app', () => app.quit());
