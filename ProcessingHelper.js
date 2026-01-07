const { LLMHelper } = require("./LLMHelper");

class ProcessingHelper {
  constructor(appState) {
    this.appState = appState;
    this.llmHelper = new LLMHelper(this.loadApiKey()); // Initial load
  }

  loadApiKey() {
      const fs = require('fs');
      const path = require('path');
      const { app } = require('electron');
      try {
          const configPath = path.join(app.getPath('userData'), 'config.json');
          if (fs.existsSync(configPath)) {
              return JSON.parse(fs.readFileSync(configPath, 'utf8')).apiKey;
          }
      } catch(e) {}
      return null;
  }

  getLLMHelper() {
    return this.llmHelper;
  }

  async processAudioBase64(data, mimeType) {
    return this.llmHelper.analyzeAudioFromBase64(data, mimeType);
  }

  async processAudioFile(filePath) {
      // Stub
      return { text: "Audio processing from file not fully implemented.", timestamp: Date.now() };
  }
  
  async processScreenshots() {
      // Get screenshots from queue
      const queue = this.appState.getScreenshotQueue();
      if (queue.length === 0) return;
      
      const mainWindow = this.appState.getMainWindow();
      if(mainWindow) mainWindow.webContents.send("initial-start");

      try {
          const result = await this.llmHelper.extractProblemFromImages(queue);
          if (mainWindow) {
             mainWindow.webContents.send("problem-extracted", result);
             const solution = await this.llmHelper.generateSolution(result);
             mainWindow.webContents.send("solution-success", solution);
          }
      } catch (e) {
          if(mainWindow) mainWindow.webContents.send("solution-error", e.message);
      }
  }

  cancelOngoingRequests() {
      // tough to cancel promises. assume logic handles ignore.
  }
}

module.exports = { ProcessingHelper };
