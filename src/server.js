import Koa from 'koa';
import serve from 'koa-static';
import mount from 'koa-mount';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const { Terminal: HeadlessTerminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(projectRoot, '..');

const defaultPublicDir = path.resolve(projectRoot, 'public');
const defaultIndexPath = path.resolve(defaultPublicDir, 'index.html');
const xtermPackageDir = path.resolve(
  projectRoot,
  'node_modules',
  '@xterm',
  'xterm',
);
const xtermLibDir = path.resolve(xtermPackageDir, 'lib');
const xtermCssDir = path.resolve(xtermPackageDir, 'css');

const parseIntSafe = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const parseOptionalInt = (value) => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const createHeadlessBundle = (cols, rows, scrollback) => {
  const term = new HeadlessTerminal({
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
  });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
};

export function createDashboardService(options = {}) {
  const {
    scriptPath: explicitScript,
    port: explicitPort,
    host: explicitHost,
    restartDelay: explicitRestartDelay,
    cols: explicitCols,
    rows: explicitRows,
    scrollback: explicitScrollback,
    historyBytes: explicitHistoryBytes,
    pty: explicitPty,
    publicDir: explicitPublicDir,
    indexPath: explicitIndexPath,
    createHttpServer,
    createWebSocketServer,
    setTimeoutFn,
    clearTimeoutFn,
    snapshotInterval: explicitSnapshotInterval,
    createHeadlessBundle: explicitHeadlessFactory,
  } = options;

  const DEFAULT_DASHBOARD_COLS = 426;
  const DEFAULT_DASHBOARD_ROWS = 110;
  const scriptPath =
    explicitScript ??
    process.env.DASHBOARD_SCRIPT ?? '/home/leask/dotfiles/dashboard';

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`dashboard script not found at ${scriptPath}`);
  }

  const port = explicitPort ?? parseIntSafe(process.env.PORT, 8098);
  const host = explicitHost ?? process.env.HOST ?? '0.0.0.0';
  const restartDelay =
    explicitRestartDelay ?? parseIntSafe(process.env.RESTART_DELAY, 5000);
  const initialCols =
    typeof explicitCols === 'number' ? explicitCols : DEFAULT_DASHBOARD_COLS;
  const initialRows =
    typeof explicitRows === 'number' ? explicitRows : DEFAULT_DASHBOARD_ROWS;

  const envScrollback = parseOptionalInt(process.env.DASHBOARD_SCROLLBACK);
  const envHistoryBytes = parseOptionalInt(process.env.DASHBOARD_HISTORY_BYTES);
  const envSnapshotInterval = parseOptionalInt(process.env.HISTORY_SNAPSHOT_INTERVAL);
  const envResyncInterval = parseOptionalInt(process.env.DASHBOARD_RESYNC_INTERVAL);
  const optionHistoryBytes =
    typeof explicitHistoryBytes === 'number'
      ? explicitHistoryBytes
      : undefined;
  const historyBytesFromEnv =
    typeof envHistoryBytes === 'number' ? envHistoryBytes : undefined;

  const estimateScrollbackFromBytes = (bytes, cols) => {
    if (typeof bytes !== 'number' || bytes <= 0) {
      return undefined;
    }
    const safeCols = Math.max(1, cols);
    return Math.max(0, Math.floor(bytes / safeCols));
  };

  const derivedScrollback =
    explicitScrollback ??
    estimateScrollbackFromBytes(optionHistoryBytes, initialCols) ??
    envScrollback ??
    estimateScrollbackFromBytes(historyBytesFromEnv, initialCols) ??
    2000;

  const scrollback = Math.max(0, derivedScrollback);
  const snapshotIntervalCandidate =
    typeof explicitSnapshotInterval === 'number'
      ? explicitSnapshotInterval
      : envSnapshotInterval ?? envResyncInterval ?? 10000;
  const snapshotIntervalMs =
    typeof snapshotIntervalCandidate === 'number'
      ? snapshotIntervalCandidate
      : 10000;
  const ptyModule = explicitPty ?? pty;
  const headlessFactory =
    typeof explicitHeadlessFactory === 'function'
      ? explicitHeadlessFactory
      : (cols, rows, historyScrollback) =>
        createHeadlessBundle(cols, rows, historyScrollback);

  const publicDir = explicitPublicDir ?? defaultPublicDir;
  const indexPath = explicitIndexPath ?? defaultIndexPath;

  const makeHttpServer =
    createHttpServer ??
    ((handler) => createServer(handler));
  const makeWebSocketServer =
    createWebSocketServer ??
    ((serverInstance) => new WebSocketServer({ server: serverInstance }));
  const scheduleTimeout =
    setTimeoutFn ??
    ((fn, ms) => setTimeout(fn, ms));
  const cancelTimeout =
    clearTimeoutFn ??
    ((handle) => clearTimeout(handle));

  const app = new Koa();
  if (fs.existsSync(xtermCssDir)) {
    app.use(mount('/vendor/xterm', serve(xtermCssDir)));
  }
  if (fs.existsSync(xtermLibDir)) {
    app.use(mount('/vendor/xterm', serve(xtermLibDir)));
  }
  app.use(serve(publicDir));
  app.use(async (ctx, next) => {
    await next();
    if (ctx.status === 404 && ctx.method === 'GET') {
      ctx.type = 'html';
      ctx.body = fs.createReadStream(indexPath);
    }
  });

  const server = makeHttpServer(app.callback());
  const wss = makeWebSocketServer(server);
  const clients = new Set();
  const clientsMeta = new Map();

  let currentCols = initialCols;
  let currentRows = initialRows;
  let currentPty = null;
  let restartTimer = null;
  let shuttingDown = false;
  let started = false;

  let headlessBundle = headlessFactory(currentCols, currentRows, scrollback);
  let headlessQueue = Promise.resolve();
  const bufferHighWaterMark = parseIntSafe(
    process.env.CLIENT_BUFFER_HIGH_WATER ?? '262144',
    262144,
  );
  const bufferLowWaterMark = Math.max(1024, Math.floor(bufferHighWaterMark / 2));
  let snapshotTimer = null;

  const queueHeadless = (task) => {
    headlessQueue = headlessQueue
      .then(() => task(headlessBundle))
      .catch((error) => {
        console.error('headless terminal task failed', error);
      });
    return headlessQueue;
  };

  const writeHeadless = (data) =>
    queueHeadless(
      ({ term }) =>
        new Promise((resolve) => {
          term.write(data, resolve);
        }),
    );

  const resetHeadless = (cols, rows) =>
    queueHeadless(({ term }) => {
      term.reset();
      term.resize(cols, rows);
    });

  const serializeScreen = async () => {
    await headlessQueue;
    return headlessBundle.serializer.serialize({
      scrollback: false,
    });
  };

  const sendHistoryPayload = (ws, screen) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    ws.send(JSON.stringify({ type: 'history', data: screen }));
    const meta = clientsMeta.get(ws);
    if (meta) {
      meta.deferHistory = false;
      meta.lastHistoryAt = Date.now();
    }
  };

  const broadcastHistory = (predicate) => {
    if (!clients.size) {
      return;
    }
    serializeScreen()
      .then((screen) => {
        for (const ws of clients) {
          if (predicate && !predicate(ws)) {
            continue;
          }
          sendHistoryPayload(ws, screen);
        }
      })
      .catch((error) => {
        console.error('Failed to serialize dashboard screen', error);
      });
  };

  const sendHistoryTo = (ws) => {
    broadcastHistory((candidate) => candidate === ws);
  };

  const ensureSnapshotTimer = () => {
    if (snapshotTimer || snapshotIntervalMs <= 0) {
      return;
    }
    snapshotTimer = setInterval(() => {
      if (clients.size > 0) {
        broadcastHistory();
      }
    }, snapshotIntervalMs);
    if (typeof snapshotTimer.unref === 'function') {
      snapshotTimer.unref();
    }
  };

  const clearSnapshotTimer = () => {
    if (snapshotTimer) {
      clearInterval(snapshotTimer);
      snapshotTimer = null;
    }
  };

  const broadcast = (message) => {
    const payload = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  };

  const startPty = () => {
    if (currentPty || shuttingDown) {
      return;
    }

    broadcast({ type: 'status', status: 'starting' });

    currentPty = ptyModule.spawn(scriptPath, [], {
      name: 'xterm-256color',
      cols: currentCols,
      rows: currentRows,
      cwd: repoRoot,
      env: {
        ...process.env,
        LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
      },
    });

    resetHeadless(currentCols, currentRows)
      .then(() => {
        broadcastHistory();
      })
      .catch((error) => {
        console.error('Failed to reset headless terminal', error);
      });
    broadcast({ type: 'status', status: 'running' });

    currentPty.onData((chunk) => {
      writeHeadless(chunk);
      const payload = JSON.stringify({ type: 'data', data: chunk });
      const needsHistory = [];

      for (const ws of clients) {
        if (ws.readyState !== WebSocket.OPEN) {
          continue;
        }
        const meta = clientsMeta.get(ws);
        if (meta?.deferHistory) {
          if (ws.bufferedAmount <= bufferLowWaterMark) {
            needsHistory.push(ws);
          }
          continue;
        }
        if (ws.bufferedAmount > bufferHighWaterMark) {
          if (meta) {
            meta.deferHistory = true;
          }
          continue;
        }
        ws.send(payload);
      }

      if (needsHistory.length) {
        serializeScreen()
          .then((screen) => {
            for (const ws of needsHistory) {
              sendHistoryPayload(ws, screen);
            }
          })
          .catch((error) => {
            console.error('Failed to serialize dashboard screen', error);
          });
      }
    });

    currentPty.onExit(({ exitCode, signal }) => {
      currentPty = null;
      broadcast({
        type: 'status',
        status: 'exited',
        code: exitCode,
        signal,
      });

      if (shuttingDown) {
        return;
      }

      if (restartTimer) {
        cancelTimeout(restartTimer);
      }

      restartTimer = scheduleTimeout(() => {
        restartTimer = null;
        startPty();
      }, restartDelay);
      if (typeof restartTimer?.unref === 'function') {
        restartTimer.unref();
      }
    });
  };

  wss.on('connection', (ws) => {
    clients.add(ws);
    clientsMeta.set(ws, { deferHistory: false, lastHistoryAt: Date.now() });
    ensureSnapshotTimer();

    const send = (message) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    };

    send({ type: 'status', status: currentPty ? 'running' : 'starting' });
    sendHistoryTo(ws);

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message?.type === 'request-history') {
          sendHistoryTo(ws);
        }
      } catch (error) {
        console.warn('dashboard: invalid ws message', error);
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      clientsMeta.delete(ws);
      if (clients.size === 0) {
        clearSnapshotTimer();
      }
    });

    ws.on('error', () => {
      clients.delete(ws);
      clientsMeta.delete(ws);
      if (clients.size === 0) {
        clearSnapshotTimer();
      }
      try {
        ws.close();
      } catch (_) {
        // ignore
      }
    });
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error', error);
  });

  const start = (listenPort = port) =>
    new Promise((resolve, reject) => {
      if (started) {
        reject(new Error('dashboard service already started'));
        return;
      }

      started = true;
      shuttingDown = false;

      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };

      const onListening = () => {
        server.off('error', onError);
        startPty();
        ensureSnapshotTimer();
        const address = server.address();
        const actualPort =
          typeof address === 'object' && address ? address.port : listenPort;
        resolve({ port: actualPort, host });
      };

      server.once('error', onError);
      server.listen(listenPort, host, onListening);
    });

  const stop = async () => {
    if (!started && !currentPty) {
      return;
    }

    shuttingDown = true;

    if (restartTimer) {
      cancelTimeout(restartTimer);
      restartTimer = null;
    }

    const waitForExit = new Promise((resolve) => {
      if (!currentPty) {
        resolve();
        return;
      }

      let resolved = false;
      const disposer = currentPty.onExit(() => {
        if (!resolved) {
          resolved = true;
          if (disposer && typeof disposer.dispose === 'function') {
            disposer.dispose();
          }
          resolve();
        }
      });

      try {
        currentPty.kill();
      } catch (_) {
        if (!resolved) {
          resolved = true;
          if (disposer && typeof disposer.dispose === 'function') {
            disposer.dispose();
          }
          resolve();
        }
      }
    });

    await waitForExit;
    currentPty = null;

    for (const ws of clients) {
      try {
        ws.close();
      } catch (_) {
        // ignore
      }
    }
    clients.clear();
    clientsMeta.clear();
    clearSnapshotTimer();

    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    await headlessQueue;
    headlessBundle.term.dispose();

    headlessBundle = headlessFactory(currentCols, currentRows, scrollback);
    headlessQueue = Promise.resolve();
    started = false;
  };

  return {
    start,
    stop,
    address: () => server.address(),
    host: () => host,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let service;
  try {
    service = createDashboardService();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  service
    .start()
    .then(({ port: runningPort, host: runningHost }) => {
      const displayHost =
        runningHost === '0.0.0.0' ? 'localhost' : runningHost;
      console.log(
        `dashboard.srv listening on http://${displayHost}:${runningPort}`,
      );

      const shutdown = async () => {
        try {
          await service.stop();
        } finally {
          process.exit(0);
        }
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error('Failed to start dashboard service', error);
      process.exit(1);
    });
}
