# Installing AI Copilot

Pick your system below. Setup takes about two minutes.

> **Heads up:** this app is unsigned, so your computer will warn you the first
> time you open it. That's expected for apps shared outside the App Store — the
> steps below get you past it. You only do this once.

---

## macOS

**Which file?**

- Mac with Apple Silicon (M1/M2/M3/M4) → `...-mac-arm64.dmg`
- Older Intel Mac → `...-mac-x64.dmg`

Not sure? Click  → **About This Mac**. If "Chip" says Apple, use arm64.

**Steps**

1. Open the `.dmg` and drag **AI Copilot** into **Applications**.
2. Open **Applications**, then **right-click** AI Copilot → **Open**.
   (Right-click matters. Double-clicking gives you a dead end with no "open
   anyway" button.)
3. Click **Open** in the dialog.

**If macOS says the app "is damaged and can't be opened":**

Nothing is corrupt. macOS says "damaged" when a downloaded app has no code
signature it can check — on Apple Silicon it refuses to run such a binary at
all. Builds from v1.1.9 onward are ad-hoc signed, which fixes this.

For an older build, or if you still see it, open **Terminal** and run:

```bash
xattr -cr "/Applications/AI Copilot.app"
codesign --force --deep --sign - "/Applications/AI Copilot.app"
```

The first line clears the download quarantine flag; the second adds an ad-hoc
signature. Then open the app normally.

You will still see "unidentified developer" once — that's the expected prompt
for any app without a paid Apple Developer ID, and right-click → **Open**
gets past it.

**Grant permissions.** Two features need explicit access:

- **Screenshots** → System Settings → Privacy & Security → **Screen Recording**
  → enable AI Copilot
- **Microphone** → System Settings → Privacy & Security → **Microphone**

Restart the app after granting.

> **There is no Dock icon by design.** The app runs as a background overlay.
> Press **⌘ + Shift + A** to show or hide it. Close it with the ✕ button.

---

## Windows

**Which file?**

- `...-win-x64.exe` (installer) → normal install, adds a Start Menu shortcut
- `...-win-x64.exe` (portable) → runs directly, no install, good for a USB stick

**Steps**

1. Double-click the `.exe`.
2. Windows SmartScreen will say "Windows protected your PC".
   Click **More info** → **Run anyway**.
3. Follow the installer. Launch from the Start Menu or desktop shortcut.

If your browser blocks the download, choose **Keep** → **Keep anyway**.

---

## Linux

**AppImage** (works on any distro):

```bash
chmod +x "AI Copilot-1.0.0-linux-x86_64.AppImage"
./"AI Copilot-1.0.0-linux-x86_64.AppImage"
```

**Debian / Ubuntu**:

```bash
sudo dpkg -i "ai-copilot-desktop_1.0.0_amd64.deb"
sudo apt-get install -f    # only if it reports missing dependencies
```

---

## First run: add an API key

The app needs at least one AI provider key. It ships with none.

1. Click the **⚙** icon in the title bar.
2. Paste a key next to any provider and click **Save**.

**Start with Groq** — it's free, needs no credit card, and is fastest to set up:
[console.groq.com/keys](https://console.groq.com/keys)

Other options:

| Provider | Free tier | Where |
|---|---|---|
| Groq | Yes, generous | console.groq.com/keys |
| Google Gemini | Yes | aistudio.google.com/apikey |
| OpenRouter | Yes, 50 requests/day | openrouter.ai/keys |
| Anthropic Claude | Paid credits | console.anthropic.com |
| DeepSeek | Paid credits | platform.deepseek.com |

**Add two keys if you can.** When one provider is overloaded the app
automatically falls back to the next — but only to ones you've configured.

Every key is stored locally on your own machine and is sent only to that
provider.

---

## Shortcuts

| Keys | Action |
|---|---|
| **⌘/Ctrl + Shift + A** | Show / hide the window |
| **⌘/Ctrl + Shift + H** | Capture the screen and analyse it |
| **⌘/Ctrl + Shift + D** | Pull the window to the screen your mouse is on |
| **Enter** | Send |
| **Shift + Enter** | New line |

---

## Troubleshooting

**Window opens on the wrong monitor.** Press **⌘/Ctrl + Shift + D** to bring it
to the screen your cursor is on. It follows you automatically; turn that off
with "Follow my active screen" in ⚙.

**"Not set up: Groq, Claude, DeepSeek".** Those providers have no key yet. Not
an error — add a key for any one of them in ⚙.

**"API key rejected".** The key reached the provider and was refused. Generate a
new one; check for missing characters or stray spaces when pasting.

**"Gemini is overloaded".** Temporary demand spike on their side. Wait a moment,
or add a second provider key so the app can fall back.

**Every copy triggers a request.** That's "Auto-send on copy". Turn it off in ⚙
and copied text will just fill the box, ready for you to send.
