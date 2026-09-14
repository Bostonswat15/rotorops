/**
 * RotorOps desktop.
 *
 * One window and two background jobs:
 *   - the app's own Nitro server, started on a free port and loaded in the window
 *   - the MSFS bridge, running in this process
 *
 * Because both live here, pairing codes are unnecessary: the renderer is already
 * signed in, so it mints a device token over IPC the first time it runs.
 */

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const isDev = !app.isPackaged;
// In a packaged build everything ships under resources/.
const rootDir = isDev ? path.join(__dirname, '..') : process.resourcesPath;
const serverEntry = path.join(rootDir, '.output', 'server', 'index.mjs');

// ---------------------------------------------------------------------------
// Diagnostics
//
// supabase-js reports every transport failure as "Failed to fetch", which hides
// whether it was DNS, TLS, a proxy or a blocked request. Chromium knows the
// real reason, so record it to a file the user can actually find.
// ---------------------------------------------------------------------------

let diagPath = null;

function diag(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    if (!diagPath) {
      const dir = app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      diagPath = path.join(dir, 'rotorops-diagnostics.log');
    }
    fs.appendFileSync(diagPath, stamped + '\n');
  } catch {
    /* logging must never break the app */
  }
}

function attachDiagnostics(win) {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) diag(`renderer: ${message} (${sourceId}:${line})`);
  });

  // The actual Chromium network error behind a failed fetch.
  win.webContents.session.webRequest.onErrorOccurred((details) => {
    if (details.url.startsWith('devtools://')) return;
    diag(`network FAILED ${details.method} ${details.url} -> ${details.error}`);
  });

  win.webContents.on('render-process-gone', (_e, d) => diag(`renderer gone: ${d.reason}`));
}

/** Can this machine reach Supabase at all, and if not, why? */
async function probeSupabase() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || bakedSupabaseUrl();
  if (!url) return diag('probe: no Supabase URL available to test');
  try {
    const res = await fetch(`${url}/auth/v1/health`);
    diag(`probe: ${url} reachable (HTTP ${res.status})`);
  } catch (e) {
    const cause = e?.cause?.message || e?.cause?.code || e?.message;
    diag(`probe: ${url} UNREACHABLE from the main process -- ${cause}`);
  }
}

/** The bridge bundle bakes the URL in at build time; reuse it. */
function bakedSupabaseUrl() {
  try {
    return require(path.join(__dirname, 'dist', 'bridge.cjs')).supabaseUrl ?? null;
  } catch {
    return null;
  }
}

let mainWindow = null;
let serverProcess = null;
let tray = null;
let bridge = null;
let bridgeLog = [];
let lastStatus = { simConnected: false, paired: false, flight: null, simAircraft: null, position: null, objectives: null, score: null, trip: null };
let hasExplainedTray = false;

// ---------------------------------------------------------------------------
// The app server
// ---------------------------------------------------------------------------

// Sessions live in localStorage, which is scoped per origin -- and the origin
// here is http://127.0.0.1:<port>. A random port every launch meant a different
// origin every launch, so the saved session was orphaned and you had to sign in
// again each time. Keep the port stable and you stay signed in.
const PREFERRED_PORTS = [47821, 47822, 47823, 47824, 47825];

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The first preferred port that's free, so the origin is the same run to run.
 * Falling through to an arbitrary port still works, but signs you out.
 */
async function stablePort() {
  for (const p of PREFERRED_PORTS) {
    if (await portIsFree(p)) return p;
  }
  const p = await anyFreePort();
  diag(`no preferred port free; using ${p} -- you will need to sign in again`);
  return p;
}

function waitForServer(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('app server did not start'));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

/**
 * Where the UI is served from.
 *
 * A hosted URL turns this app into a thin client: the interface updates for
 * everyone the moment you redeploy, and nobody has to re-download 549 MB to get
 * a fix. Falling back to the bundled server keeps it working offline and for
 * anyone who hasn't set one.
 *
 * Order: env var, then `appUrl` in %APPDATA%\RotorOps\bridge.json, then local.
 */
function configuredAppUrl() {
  if (process.env.ROTOROPS_URL) return process.env.ROTOROPS_URL;
  try {
    const cfg = path.join(process.env.APPDATA || app.getPath('userData'), 'RotorOps', 'bridge.json');
    const url = JSON.parse(fs.readFileSync(cfg, 'utf8')).appUrl;
    if (typeof url === 'string' && /^https?:\/\//.test(url)) return url.replace(/\/+$/, '');
  } catch {
    /* no config, or not valid JSON -- fall through to the bundled server */
  }
  return null;
}

async function startServer() {
  const hosted = configuredAppUrl();
  if (hosted) {
    diag(`using hosted app at ${hosted}`);
    return hosted;
  }

  if (!fs.existsSync(serverEntry)) {
    throw new Error(
      `Built app not found at ${serverEntry}.\nRun \`bun run build\` in the project root first.`,
    );
  }

  const port = await stablePort();
  // ELECTRON_RUN_AS_NODE turns our own binary into a plain Node runtime, so the
  // server runs without requiring Node to be installed on the machine.
  serverProcess = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (d) => console.log(`[server] ${d}`.trimEnd()));
  serverProcess.stderr.on('data', (d) => console.error(`[server] ${d}`.trimEnd()));
  serverProcess.on('exit', (code) => {
    if (code !== 0 && !app.isQuitting) console.error(`[server] exited with ${code}`);
  });

  await waitForServer(port);
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

function pushStatus(patch) {
  lastStatus = { ...lastStatus, ...patch };
  mainWindow?.webContents.send('bridge:status', lastStatus);
  updateTray();
}

function onBridgeEvent(event) {
  if (event.type === 'log' || event.type === 'warn') {
    bridgeLog.push({ ...event, at: Date.now() });
    if (bridgeLog.length > 500) bridgeLog = bridgeLog.slice(-300);
    // The bridge's own log/warn lines only lived in an in-memory ring buffer
    // (readable via IPC while the app is open) and never reached the
    // diagnostics file -- so a report like "Reported N airports near KXXX"
    // was unrecoverable after the fact. Persist it like everything else.
    diag(`bridge: ${event.message}`);
  }
  if (event.type === 'sim') {
    pushStatus({
      simConnected: event.connected,
      simVersion: event.version,
      ...(event.connected ? {} : { position: null, flight: null }),
    });
  }
  // A new flight starts a new score; the last one stays on screen until then.
  if (event.type === 'flight-start') pushStatus({ flight: { ...event, hours: 0 }, score: null });
  // Swapping aircraft throws the old flight away. Keeping its status block kept
  // the In Flight page, Sim Link and the tray naming the aircraft just left.
  if (event.type === 'flight-discarded') pushStatus({ flight: null, score: null });
  if (
    event.type === 'sim-aircraft' &&
    lastStatus.flight?.simTitle &&
    event.simTitle &&
    event.simTitle !== lastStatus.flight.simTitle
  ) {
    pushStatus({ flight: null, score: null });
  }
  if (event.type === 'score') {
    pushStatus({ score: { score: event.score, grade: event.grade, items: event.items } });
  }
  if (event.type === 'flight-progress') {
    pushStatus({ flight: { ...(lastStatus.flight ?? {}), ...event } });
  }
  if (event.type === 'flight-logged') pushStatus({ flight: null });
  if (event.type === 'position') {
    pushStatus({ position: {
      lat: event.lat, lon: event.lon, heading: event.heading,
      agl: event.agl, groundSpeed: event.groundSpeed,
      altitude: event.altitude, onGround: event.onGround,
    } });
  }
  if (event.type === 'objectives') {
    pushStatus({ objectives: {
      missionId: event.missionId,
      missionTitle: event.missionTitle,
      items: event.objectives,
      // Null until a SAR casualty is actually spotted. The bridge is the only
      // thing that knows where they are, so this is the first the app hears.
      sighted: event.sighted ?? null,
    } });
  }
  // The contract resolved or went away: drop its list rather than leaving a
  // finished contract on screen until the next one happens to arm.
  if (event.type === 'objectives-cleared') pushStatus({ objectives: null });
  if (event.type === 'trip') pushStatus({ trip: event.trip });
  if (event.type === 'sim-aircraft') {
    pushStatus({ simAircraft: { simTitle: event.simTitle, matchedId: event.matchedId, matchedName: event.matchedName } });
  }
  mainWindow?.webContents.send('bridge:event', event);
}

async function startBridge(token) {
  const { createBridge } = require(path.join(__dirname, 'dist', 'bridge.cjs'));
  if (bridge) bridge.stop();
  bridge = createBridge(token, onBridgeEvent);
  pushStatus({ paired: true });
  await bridge.start();
}

function readToken() {
  try {
    const cfg = path.join(process.env.APPDATA || app.getPath('userData'), 'RotorOps', 'bridge.json');
    return JSON.parse(fs.readFileSync(cfg, 'utf8')).deviceToken ?? null;
  } catch {
    return null;
  }
}

// The renderer is authenticated, so it can create a pairing code; we redeem it
// here. The user never sees either half.
ipcMain.handle('bridge:provision', async (_e, code) => {
  const { redeemPairingCode } = require(path.join(__dirname, 'dist', 'bridge.cjs'));
  const { writeConfig } = require(path.join(__dirname, 'dist', 'bridge.cjs'));
  const os = require('node:os');
  const result = await redeemPairingCode(code, `RotorOps Desktop (${os.hostname()})`);
  writeConfig({
    deviceToken: result.device_token,
    deviceId: result.device_id,
    companyId: result.company_id,
  });
  await startBridge(result.device_token);
  return { ok: true };
});

ipcMain.handle('bridge:status', () => lastStatus);
ipcMain.handle('bridge:log', () => bridgeLog.slice(-200));
ipcMain.handle('bridge:hasToken', () => !!readToken());
ipcMain.handle('bridge:restart', async () => {
  const token = readToken();
  if (!token) return { ok: false, error: 'not paired' };
  await startBridge(token);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Window and tray
// ---------------------------------------------------------------------------

function updateTray() {
  if (!tray) return;
  const sim = lastStatus.simConnected ? 'MSFS connected' : 'MSFS not connected';
  const flight = lastStatus.flight
    ? `Flying ${lastStatus.flight.simTitle ?? ''}`.trim()
    : 'No flight in progress';
  tray.setToolTip(`RotorOps — ${sim}\n${flight}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: sim, enabled: false },
    { label: flight, enabled: false },
    { type: 'separator' },
    { label: 'Open RotorOps', click: () => mainWindow?.show() },
    { label: 'Quit RotorOps', click: () => { app.isQuitting = true; bridge?.stop(); app.quit(); } },
  ]));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachDiagnostics(mainWindow);

  // External links belong in the user's browser, not in the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => {
    // Hiding to tray only makes sense while the bridge is actually watching a
    // sim. Otherwise closing means closing -- an app that won't quit and has
    // nothing to show for it is just a stuck process.
    if (!app.isQuitting && bridge && lastStatus.paired) {
      e.preventDefault();
      mainWindow.hide();
      if (!hasExplainedTray) {
        hasExplainedTray = true;
        tray?.displayBalloon?.({
          title: 'RotorOps is still running',
          content: 'The sim bridge keeps logging flights. Quit from this tray icon.',
        });
      }
      return;
    }
    app.isQuitting = true;
  });

  try {
    const url = await startServer();
    // Straight into the app. The authenticated layout redirects to /auth if
    // the restored session is missing or expired.
    await mainWindow.loadURL(url.replace(/\/+$/, '') + '/dashboard');
  } catch (e) {
    await mainWindow.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          `<body style="font:14px system-ui;background:#0a0a0a;color:#eee;padding:40px">
             <h2>RotorOps couldn't start</h2><pre>${String(e.message)}</pre></body>`,
        ),
    );
    mainWindow.show();
  }
}

app.whenReady().then(async () => {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
  updateTray();

  await createWindow();
  probeSupabase();

  const token = readToken();
  if (token) {
    startBridge(token).catch((e) => console.error('bridge failed to start:', e));
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  bridge?.stop();
  serverProcess?.kill();
});

app.on('window-all-closed', () => {
  // Tray-resident on Windows; the bridge should outlive the window.
  if (process.platform === 'darwin') return;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else mainWindow?.show();
});
