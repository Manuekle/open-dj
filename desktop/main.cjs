/* Shift for Mac: the same Next.js app, its server run inside the app by Electron's own Node (no Node to install).
   Packaged, it starts the standalone server (Resources/server/server.js); from the repo (npm run desktop:dev) it runs
   next dev, or opens SHIFT_DEV_URL when a dev server is already up. Either way it listens on 127.0.0.1 and a fixed port: the library lives in IndexedDB, which is kept per
   origin, so a port that changed between launches would show an empty library.

   The tools the API routes run (ffmpeg, yt-dlp, whisper-cli, Demucs, Ollama) come from Resources/bin when the build
   bundled them, else from Homebrew: an app opened from the Finder gets a bare PATH, so the Homebrew folders go on it.
   Models, the Demucs environment and the disk backup live in ~/Library/Application Support/Shift. */
const { app, BrowserWindow, Menu, dialog, nativeTheme, shell, utilityProcess } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const PORT = Number(process.env.SHIFT_PORT ?? (app.isPackaged ? 47300 : 47301));
const HOST = "127.0.0.1";
// SHIFT_DEV_URL points the window at a dev server already running (Next allows one next dev per folder).
const ATTACH = !app.isPackaged && process.env.SHIFT_DEV_URL;
const URL = (ATTACH || `http://${HOST}:${PORT}`).replace(/\/$/, "");
const REPO = path.join(__dirname, "..");
const HOME = path.join(app.getPath("appData"), "Shift");
const BACKGROUND = "#1e1e1d";

let server;
let win;

function env() {
  const bundled = path.join(process.resourcesPath, "bin");
  const PATH = [bundled, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(":");
  const ownDemucs = path.join(HOME, ".demucs", "bin", "demucs");
  const ownWhisper = path.join(HOME, ".whisper");
  return {
    ...process.env,
    PATH,
    PORT: String(PORT),
    HOSTNAME: HOST,
    NEXT_TELEMETRY_DISABLED: "1",
    // Packaged, everything lives in Application Support; from the repo, what npm run setup:* put there still works.
    ...(app.isPackaged || existsSync(ownDemucs) ? { DEMUCS_BIN: ownDemucs } : {}),
    ...(app.isPackaged || existsSync(ownWhisper) ? { WHISPER_MODELS_DIR: ownWhisper } : {}),
    ...(app.isPackaged ? { DATA_DIR: path.join(HOME, "data") } : {}),
    ...(existsSync(path.join(bundled, "ffmpeg")) ? { FFMPEG_BIN: path.join(bundled, "ffmpeg") } : {}),
    ...(existsSync(path.join(bundled, "yt-dlp")) ? { YTDLP_BIN: path.join(bundled, "yt-dlp") } : {}),
    ...(existsSync(path.join(bundled, "whisper-cli")) ? { WHISPER_BIN: path.join(bundled, "whisper-cli") } : {}),
  };
}

const portFree = () => new Promise(resolve => {
  const probe = net.createServer().once("error", () => resolve(false)).once("listening", () => probe.close(() => resolve(true)));
  probe.listen(PORT, HOST);
});

/** Resolves once the server answers, or rejects after the timeout. */
async function ready(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if ((await fetch(URL, { signal: AbortSignal.timeout(2000) })).status < 500) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`The Shift server did not start on ${URL}.`);
}

function startServer() {
  mkdirSync(HOME, { recursive: true });
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, "server");
    server = utilityProcess.fork(path.join(dir, "server.js"), [], { cwd: dir, env: { ...env(), NODE_ENV: "production" }, stdio: "inherit", serviceName: "Shift server" });
  } else {
    server = spawn(path.join(REPO, "node_modules", ".bin", "next"), ["dev", "-H", HOST, "-p", String(PORT)], { cwd: REPO, env: env(), stdio: "inherit" });
  }
  server.on("exit", code => {
    server = undefined;
    if (!quitting) { dialog.showErrorBox("Shift stopped", `The Shift server exited (code ${code}). Open Shift again.`); app.quit(); }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: "Shift",
    backgroundColor: BACKGROUND,
    // No title bar: the room's header is it (window.css), with the traffic lights in its first cell.
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 40, y: 41 },
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once("ready-to-show", () => win.show());
  const css = name => readFileSync(path.join(__dirname, name), "utf8");
  let lights;
  const showLights = async on => {
    if (lights) { await win.webContents.removeInsertedCSS(lights); lights = undefined; }
    if (on) lights = await win.webContents.insertCSS(css("window-lights.css"));
  };
  win.webContents.on("dom-ready", () => {
    lights = undefined;
    win.webContents.insertCSS(css("window.css"));
    showLights(!win.isFullScreen());
  });
  win.on("enter-full-screen", () => showLights(false));
  win.on("leave-full-screen", () => showLights(true));
  // Links to other sites open in the default browser; the app's own pages stay in the window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) shell.openExternal(url);
    return { action: url.startsWith(URL) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(URL)) { event.preventDefault(); shell.openExternal(url); }
  });
  // The microphone (voice scan, the lyrics' follow mode) is the only permission the app asks for.
  win.webContents.session.setPermissionRequestHandler((_wc, permission, done) => done(["media", "clipboard-sanitized-write", "fullscreen"].includes(permission)));
  win.on("closed", () => { win = undefined; });
  win.loadURL(URL);
}

function menu() {
  const open = (label, route) => ({ label, click: () => win ? win.loadURL(URL + route) : null });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "Go", submenu: [open("Decks", "/"), open("Stems", "/stems"), open("Studio", "/studio"), open("Karaoke", "/lyrics"), open("Rhythm", "/play"), { type: "separator" },
      { label: "Show Data Folder", click: () => shell.openPath(HOME) }] },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

let quitting = false;
app.on("before-quit", () => { quitting = true; server?.kill(); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on("window-all-closed", () => {}); // The Mac way: the app stays in the Dock; the server keeps its jobs.
  app.on("activate", () => { if (!win && (server || ATTACH)) createWindow(); });
  app.whenReady().then(async () => {
    app.setName("Shift");
    nativeTheme.themeSource = "dark"; // Shift is dark only: the title bar and menus follow it, whatever the system uses.
    menu();
    if (ATTACH) {
      try { await ready(10_000); } catch (e) { dialog.showErrorBox("Shift cannot start", String(e.message ?? e)); return app.quit(); }
      return createWindow();
    }
    if (!(await portFree())) {
      dialog.showErrorBox("Shift cannot start", `Port ${PORT} on this Mac is in use by another program. Close it and open Shift again.`);
      return app.quit();
    }
    startServer();
    try { await ready(app.isPackaged ? 30_000 : 120_000); }
    catch (e) { dialog.showErrorBox("Shift cannot start", String(e.message ?? e)); quitting = true; server?.kill(); return app.quit(); }
    createWindow();
  });
}
