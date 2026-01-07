const path = require("path");
const fs = require("fs");
const { app } = require("electron");
const { v4: uuidv4 } = require("uuid");
const screenshot = require("screenshot-desktop");

class ScreenshotHelper {
  constructor(view = "queue") {
    this.view = view;
    this.screenshotQueue = [];
    this.extraScreenshotQueue = [];
    this.MAX_SCREENSHOTS = 5;

    this.screenshotDir = path.join(app.getPath("userData"), "screenshots");
    this.extraScreenshotDir = path.join(app.getPath("userData"), "extra_screenshots");

    if (!fs.existsSync(this.screenshotDir)) fs.mkdirSync(this.screenshotDir);
    if (!fs.existsSync(this.extraScreenshotDir)) fs.mkdirSync(this.extraScreenshotDir);
  }

  getView() { return this.view; }
  setView(view) { this.view = view; }
  getScreenshotQueue() { return this.screenshotQueue; }
  getExtraScreenshotQueue() { return this.extraScreenshotQueue; }

  clearQueues() {
    this.screenshotQueue.forEach(p => fs.unlink(p, () => {}));
    this.screenshotQueue = [];
    this.extraScreenshotQueue.forEach(p => fs.unlink(p, () => {}));
    this.extraScreenshotQueue = [];
  }

  async takeScreenshot(hideWindow, showWindow) {
    try {
      if (hideWindow) hideWindow();
      await new Promise(r => setTimeout(r, 200)); // Delay for hide

      let screenshotPath = "";
      const filename = `${uuidv4()}.png`;

      // Use screenshot-desktop to capture
      // Note: screenshot-desktop returns absolute path usually
      if (this.view === "queue") {
        screenshotPath = path.join(this.screenshotDir, filename);
        await screenshot({ filename: screenshotPath, format: 'png' });
        this.screenshotQueue.push(screenshotPath);
        if (this.screenshotQueue.length > this.MAX_SCREENSHOTS) {
            const rem = this.screenshotQueue.shift();
            if (rem) fs.unlink(rem, () => {});
        }
      } else {
        screenshotPath = path.join(this.extraScreenshotDir, filename);
        await screenshot({ filename: screenshotPath, format: 'png' });
        this.extraScreenshotQueue.push(screenshotPath);
         if (this.extraScreenshotQueue.length > this.MAX_SCREENSHOTS) {
            const rem = this.extraScreenshotQueue.shift();
            if (rem) fs.unlink(rem, () => {});
        }
      }
      
      return screenshotPath;
    } catch (e) {
      console.error("Screenshot error:", e);
      throw e;
    } finally {
      if (showWindow) showWindow();
    }
  }

  async getImagePreview(filepath) {
    const data = await fs.promises.readFile(filepath);
    return `data:image/png;base64,${data.toString("base64")}`;
  }

  async deleteScreenshot(filepath) {
      try {
          await fs.promises.unlink(filepath);
          if (this.view === "queue") {
              this.screenshotQueue = this.screenshotQueue.filter(p => p !== filepath);
          } else {
              this.extraScreenshotQueue = this.extraScreenshotQueue.filter(p => p !== filepath);
          }
          return { success: true };
      } catch (e) {
          return { success: false, error: e.message };
      }
  }
}

module.exports = { ScreenshotHelper };
