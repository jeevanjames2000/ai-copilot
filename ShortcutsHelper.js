const { globalShortcut } = require("electron");

class ShortcutsHelper {
  constructor(appState) {
    this.appState = appState;
  }

  registerGlobalShortcuts() {
    globalShortcut.register("CommandOrControl+Shift+Space", () => {
      this.appState.centerAndShowWindow();
    });

    globalShortcut.register("CommandOrControl+H", async () => {
        try {
            const path = await this.appState.takeScreenshot();
            const win = this.appState.getMainWindow();
            if(win) {
                 const prev = await this.appState.getImagePreview(path);
                 win.webContents.send("screenshot-taken", { path, preview: prev });
            }
        } catch(e) { console.error(e); }
    });

    globalShortcut.register("CommandOrControl+Enter", () => {
        this.appState.processingHelper.processScreenshots();
    });
    
    globalShortcut.register("CommandOrControl+R", () => {
        this.appState.clearQueues();
        const win = this.appState.getMainWindow();
        if(win) win.webContents.send("reset-view");
    });

    // Arrow keys movement
    globalShortcut.register("CommandOrControl+Left", () => this.appState.moveWindowLeft());
    globalShortcut.register("CommandOrControl+Right", () => this.appState.moveWindowRight());
    globalShortcut.register("CommandOrControl+Up", () => this.appState.moveWindowUp());
    globalShortcut.register("CommandOrControl+Down", () => this.appState.moveWindowDown());
  }
}

module.exports = { ShortcutsHelper };
