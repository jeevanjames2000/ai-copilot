const { BrowserWindow, screen } = require("electron");
const path = require("path");

class WindowHelper {
  constructor(appState) {
    this.appState = appState;
    this.mainWindow = null;
    this.isWindowVisible = false;
    this.windowPosition = null;
    this.windowSize = null;
  }

  createWindow() {
    if (this.mainWindow) return;

    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    this.screenWidth = width;
    this.screenHeight = height;
    this.step = 20;

    this.mainWindow = new BrowserWindow({
      width: 400,
      height: 600,
      minWidth: 300,
      minHeight: 200,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        // preload: path.join(__dirname, "preload.js") // Optional if isolation is false
      },
      show: false,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true
    });

    this.mainWindow.loadFile("index.html");

    this.mainWindow.once("ready-to-show", () => {
      this.centerWindow();
      this.mainWindow.show();
      this.isWindowVisible = true;
    });

    this.mainWindow.on("move", () => {
        if(this.mainWindow) {
            const b = this.mainWindow.getBounds();
            this.windowPosition = {x: b.x, y: b.y};
            this.currentX = b.x;
            this.currentY = b.y;
        }
    });
    
    this.mainWindow.on("closed", () => {
        this.mainWindow = null;
        this.isWindowVisible = false;
    });
  }

  getMainWindow() { return this.mainWindow; }

  isVisible() { return this.isWindowVisible; }

  hideMainWindow() {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          const b = this.mainWindow.getBounds();
          this.windowPosition = { x: b.x, y: b.y };
          this.mainWindow.hide();
          this.isWindowVisible = false;
      }
  }

  showMainWindow() {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          if (this.windowPosition) {
              this.mainWindow.setBounds({ x: this.windowPosition.x, y: this.windowPosition.y, width: 400, height: 600 });
          }
          this.mainWindow.showInactive();
          this.isWindowVisible = true;
      }
  }

  toggleMainWindow() {
      if (this.isWindowVisible) this.hideMainWindow();
      else this.showMainWindow();
  }

  centerWindow() {
      if (!this.mainWindow) return;
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width, height } = primaryDisplay.workAreaSize;
      const bounds = this.mainWindow.getBounds();
      const x = Math.floor((width - bounds.width) / 2);
      const y = Math.floor((height - bounds.height) / 2);
      this.mainWindow.setBounds({ x, y, width: bounds.width, height: bounds.height });
      this.currentX = x;
      this.currentY = y;
  }
  
  centerAndShowWindow() {
      this.centerWindow();
      this.showMainWindow();
      this.mainWindow.setAlwaysOnTop(true);
      this.mainWindow.focus();
  }

  moveWindowLeft() {
     if(!this.mainWindow) return;
     this.currentX -= this.step;
     this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY));
  }
  moveWindowRight() {
     if(!this.mainWindow) return;
     this.currentX += this.step;
     this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY));
  }
  moveWindowUp() {
     if(!this.mainWindow) return;
     this.currentY -= this.step;
     this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY));
  }
  moveWindowDown() {
     if(!this.mainWindow) return;
     this.currentY += this.step;
     this.mainWindow.setPosition(Math.round(this.currentX), Math.round(this.currentY));
  }
}

module.exports = { WindowHelper };
