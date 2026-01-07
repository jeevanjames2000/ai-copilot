const { ipcMain, app } = require("electron");

function initializeIpcHandlers(appState) {
  ipcMain.handle("take-screenshot", async () => {
    const path = await appState.takeScreenshot();
    const preview = await appState.getImagePreview(path);
    return { path, preview };
  });

  ipcMain.handle("get-screenshots", async () => {
    const queue = appState.getView() === "queue" ? appState.getScreenshotQueue() : appState.getExtraScreenshotQueue();
    return Promise.all(queue.map(async p => ({
        path: p,
        preview: await appState.getImagePreview(p)
    })));
  });

  // Legacy / Direct Support
  ipcMain.handle("capture-screen", async () => {
    try {
        const path = await appState.takeScreenshot();
        // Read file to base64 for legacy support
        const fs = require('fs');
        const data = fs.readFileSync(path).toString('base64');
        return { success: true, data, mimeType: "image/png" };
    } catch(e) {
        return { success: false, error: e.message };
    }
  });

  ipcMain.handle("analyze-text", async (e, payload) => {
      // Adapt payload: { text, audio, image }
      const text = payload.text || "";
      const audio = payload.audio; // base64
      let image = payload.image; // base64

      // Legacy support: If no image sent, check if one is pending in queue?
      // The shortcut Cmd+H puts it in queue.
      // If we have items in queue, let's use the LATEST one.
      if (!image) {
          const queue = appState.getScreenshotQueue();
          if (queue.length > 0) {
              try {
                  const lastPath = queue[queue.length - 1]; // Use last
                  const fs = require('fs');
                  image = fs.readFileSync(lastPath).toString('base64');
                  
                  // Optional: Clear queue after use? 
                  // In legacy 'pendingScreenshot' was nulled.
                  // appState.deleteScreenshot(lastPath); // Maybe keep for history? 
                  // Let's keep it for now or clear it to avoid re-sending.
                  // BETTER: Clear it so it behaves like "pending"
                  appState.deleteScreenshot(lastPath);
              } catch(e) { console.error("Failed to read pending screenshot", e); }
          }
      }

      // 1. If we have keys, we need to temporarily construct the prompt
      // The new system is specialized, but we can bridge it.
      const llm = appState.processingHelper.getLLMHelper();
      
      try {
          // Construct parts
          const parts = [];
           if (image) {
              parts.push({
                inlineData: { data: image, mimeType: "image/png" }
              });
           }
           if (audio) {
               parts.push({
                   inlineData: { data: audio, mimeType: "audio/webm" }
               });
           }
           parts.push(text || "Analyze this.");

           if (!llm.model) throw new Error("API Key not set");
           
           const result = await llm.model.generateContent(parts);
           const response = await result.response;
           return { type: 'success', response: response.text() };

      } catch (err) {
          return { type: 'error', response: err.message };
      }
  });

  ipcMain.handle('check-api-key', () => !!appState.processingHelper.getLLMHelper().model);

  ipcMain.handle('save-api-key', async (event, apiKey) => {
       await appState.processingHelper.getLLMHelper().switchToGemini(apiKey);
       const fs = require('fs');
       const p = require('path').join(app.getPath('userData'), 'config.json');
       fs.writeFileSync(p, JSON.stringify({ apiKey }));
       return { success: true };
  });

  ipcMain.handle("gemini-chat", async (e, msg) => {
      return appState.processingHelper.getLLMHelper().chatWithGemini(msg);
  });
  
  // Settings / LLM Config
  ipcMain.handle("switch-to-gemini", async (e, key) => {
      await appState.processingHelper.getLLMHelper().switchToGemini(key);
      // Save key
      const fs = require('fs');
      const p = require('path').join(app.getPath('userData'), 'config.json');
      fs.writeFileSync(p, JSON.stringify({ apiKey: key }));
      return { success: true };
  });

  // Passthroughs
  ipcMain.handle("move-window-left", () => appState.moveWindowLeft());
  ipcMain.handle("move-window-right", () => appState.moveWindowRight());
  ipcMain.handle("move-window-up", () => appState.moveWindowUp());
  ipcMain.handle("move-window-down", () => appState.moveWindowDown());
}

module.exports = { initializeIpcHandlers };
