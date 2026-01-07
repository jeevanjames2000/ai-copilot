const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  takeScreenshot: () => ipcRenderer.invoke("take-screenshot"),
  getScreenshots: () => ipcRenderer.invoke("get-screenshots"),
  deleteScreenshot: (path) => ipcRenderer.invoke("delete-screenshot", path),
  
  analyzeAudioFromBase64: (data, mime) => ipcRenderer.invoke("analyze-audio-base64", data, mime),
  geminiChat: (msg) => ipcRenderer.invoke("gemini-chat", msg),
  switchToGemini: (key) => ipcRenderer.invoke("switch-to-gemini", key),
  
  quitApp: () => ipcRenderer.invoke("quit-app"),
  
  // Events
  onScreenshotTaken: (cb) => {
      ipcRenderer.on("screenshot-taken", (_, data) => cb(data));
  },
  onResetView: (cb) => ipcRenderer.on("reset-view", cb),
  
  // Window controls
  moveWindowLeft: () => ipcRenderer.invoke("move-window-left"),
  moveWindowRight: () => ipcRenderer.invoke("move-window-right"),
  // ... maps others
});
