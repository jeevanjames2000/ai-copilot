# Building AI Copilot installers

## The one rule that shapes everything

**You can only build a macOS installer on a Mac.** Apple's packaging and signing
tools don't exist on Linux or Windows, and no cross-compiler works around it.
Windows `.exe` files can technically be built from Linux/macOS via Wine, but the
result is flaky — build each platform on that platform.

That leaves two paths:

| | What you get | Effort |
|---|---|---|
| **A. GitHub Actions** | All three platforms, every release, automatically | Set up once |
| **B. Local build** | Only the OS you're sitting at | One command |

Use **A** if you want to hand out Mac *and* Windows files. Use **B** to test.

---

## A. Build all three with GitHub Actions (recommended)

The workflow is already in `.github/workflows/build.yml`.

1. Push the project to GitHub:

   ```bash
   git add -A
   git commit -m "Add cross-platform build setup"
   git push
   ```

2. Tag a version. **This is what triggers the release:**

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

3. Wait ~5-10 minutes. Go to your repo → **Releases**.
   You'll find, attached to release `v1.0.0`:

   - `AI Copilot-1.0.0-mac-arm64.dmg` — Apple Silicon (M1/M2/M3/M4)
   - `AI Copilot-1.0.0-mac-x64.dmg` — Intel Macs
   - `AI Copilot-1.0.0-win-x64.exe` — Windows installer
   - `AI Copilot-1.0.0-win-x64.exe` (portable) — no install needed
   - `AI Copilot-1.0.0-linux-x86_64.AppImage`
   - `AI Copilot-1.0.0-linux-amd64.deb`

4. Share the release link. Send people to `INSTALL.md` for setup.

To rebuild without releasing, use the **Actions** tab → *Build installers* →
*Run workflow*. Installers appear under that run's **Artifacts**.

**Bumping versions:** edit `version` in `package.json`, commit, then tag to
match. A tag that doesn't match `package.json` produces confusingly named files.

---

## B. Build locally

```bash
npm install          # once
npm run dist         # builds for whatever OS you're on
```

Output lands in `dist/`. Platform-specific:

```bash
npm run dist:mac     # only on macOS
npm run dist:win     # only on Windows
npm run dist:linux   # only on Linux
```

On Linux you may need one system package for `.deb` output:

```bash
sudo apt-get install -y fakeroot dpkg
```

---

## What was fixed to make packaging work

Worth knowing, because the original config would have shipped a broken app:

- **`node_modules` was excluded** from the `files` whitelist. The renderer
  `require()`s `showdown` and `highlight.js`, so every copy you handed out would
  have shown a blank window. Dependencies are now bundled.
- **The CDN fallback never worked.** `let showdown` shadows `window.showdown`,
  so when `require()` failed the variable stayed `undefined` and the whole
  script block died. It now falls back properly, and degrades to plain text
  instead of a dead UI.
- **Icons were missing.** The config pointed at `icon.icns` and `icon.ico`,
  neither of which existed. Both are now generated in `build/`.
- **`build/` was in `.gitignore`**, which would have stripped those icons in CI.

---

## Signing (optional)

These builds are unsigned, so recipients see a warning once — `INSTALL.md`
covers how to get past it. Signing removes the warning but costs money:

- **macOS**: Apple Developer Program, $99/year. Then set `CSC_LINK` and
  `CSC_KEY_PASSWORD` as repo secrets and remove `"identity": null` from
  `package.json`.
- **Windows**: a code-signing certificate, roughly $100-400/year.

For sharing with people who know you, unsigned plus the `INSTALL.md`
instructions is fine.
