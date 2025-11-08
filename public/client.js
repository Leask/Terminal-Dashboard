const TerminalCtor = window.Terminal;

if (!TerminalCtor) {
  throw new Error('xterm.js failed to load');
}

const container = document.getElementById('terminal');
let term;
let terminalWrapper;

const RESYNC_TIMEOUT_MS = 600;
const DATA_BUFFER_LIMIT = 65536;
const TARGET_COLS = 426;
const TARGET_ROWS = 110;

let socket;
let reconnectDelay = 1000;
const maxReconnectDelay = 10000;

let lastHistory = null;
let resyncPending = true;
let bufferedData = '';
let historyTimeout = null;
let fixedPixelWidth = null;
let fixedPixelHeight = null;

const loadBundledFonts = async () => {
  if (!('FontFace' in window)) {
    return false;
  }

  const fontDefs = [
    {
      family: 'SF Mono Terminal',
      sources: [
        'fonts/SFMonoTerminal-Regular.woff2',
        'fonts/SFMonoTerminal-Regular.woff',
      ],
      descriptors: {
        weight: '400',
        style: 'normal',
        display: 'swap',
      },
    },
  ];

  let loadedAny = false;

  for (const def of fontDefs) {
    let loaded = false;
    for (const src of def.sources) {
      try {
        const response = await fetch(src, { cache: 'force-cache' });
        if (!response.ok) {
          continue;
        }
        const data = await response.arrayBuffer();
        const face = new FontFace(def.family, data, def.descriptors);
        await face.load();
        document.fonts.add(face);
        loaded = true;
        loadedAny = true;
        break;
      } catch (error) {
        console.warn(`font load failed for ${src}`, error);
      }
    }

    if (!loaded) {
      console.warn(
        `dashboard: bundled font "${def.family}" not found; falling back to system font.`, 
      );
    } else {
      console.info(`dashboard: loaded bundled font "${def.family}".`);
    }
  }

  return loadedAny;
};

const nextDelay = () => {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(maxReconnectDelay, Math.floor(reconnectDelay * 1.5));
  return delay;
};

const resetDelay = () => {
  reconnectDelay = 1000;
};

const clearHistoryTimeout = () => {
  if (historyTimeout) {
    clearTimeout(historyTimeout);
    historyTimeout = null;
  }
};

const scheduleHistoryTimeout = (reason) => {
  clearHistoryTimeout();
  historyTimeout = window.setTimeout(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'request-history',
          reason: `${reason}-timeout`,
        }),
      );
    }
  }, RESYNC_TIMEOUT_MS);
};

const requestHistory = (reason = 'manual') => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ type: 'request-history', reason }));
};

const beginResync = (reason, { request = true } = {}) => {
  resyncPending = true;
  bufferedData = '';
  scheduleHistoryTimeout(reason);
  if (request) {
    requestHistory(reason);
  }
};

const flushBufferedData = () => {
  if (!bufferedData) {
    return;
  }
  if (!term) {
    return;
  }
  term.write(bufferedData);
  bufferedData = '';
};

const refreshTerminalView = () => {
  if (!term) {
    return;
  }
  const rows = typeof term.rows === 'number' ? term.rows : 0;
  if (rows > 0) {
    term.refresh(0, rows - 1);
    term.scrollToBottom();
  }
  applyScale();
};

const applyScale = () => {
  if (!terminalWrapper || !fixedPixelWidth || !fixedPixelHeight) {
    return;
  }

  // The aspect ratio is now derived from the *actual measured* dimensions
  const spaceAspectRatio = fixedPixelWidth / fixedPixelHeight;
  const viewportWidth = container?.clientWidth ?? window.innerWidth;
  const viewportHeight = container?.clientHeight ?? window.innerHeight;

  let spaceWidth = viewportWidth;
  let spaceHeight = viewportWidth / spaceAspectRatio;

  if (spaceHeight > viewportHeight) {
    spaceHeight = viewportHeight;
    spaceWidth = viewportHeight * spaceAspectRatio;
  }

  if (!spaceWidth || !spaceHeight) {
    return;
  }

  // The scale is now perfect because the aspect ratios match
  const scale = spaceWidth / fixedPixelWidth;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

  terminalWrapper.style.width = `${fixedPixelWidth}px`;
  terminalWrapper.style.height = `${fixedPixelHeight}px`;
  terminalWrapper.style.transform = `scale(${safeScale})`;
};

const initialiseFixedTerminalSize = () => {
  if (!term) {
    return;
  }

  term.resize(TARGET_COLS, TARGET_ROWS);

  const screenElement = terminalWrapper.querySelector('.xterm-screen');
  if (!screenElement) {
    console.error('Could not find .xterm-screen element for measurement.');
    return;
  }

  // Measure the real rendered dimensions
  fixedPixelWidth = screenElement.offsetWidth;
  fixedPixelHeight = screenElement.offsetHeight;

  refreshTerminalView();
  applyScale();
};

const handleHistory = (historyValue) => {
  const history = typeof historyValue === 'string' ? historyValue : '';
  const isIdentical = history === lastHistory;
  if (!resyncPending && isIdentical) {
    flushBufferedData();
    return;
  }

  resyncPending = true;
  if (!term) {
    return;
  }
  const payload = `\x1b[3J\x1b[H${history}`;
  term.write(payload, () => {
    lastHistory = history;
    resyncPending = false;
    clearHistoryTimeout();
    refreshTerminalView();
    flushBufferedData();
  });
};

const handleData = (data) => {
  if (!data) {
    return;
  }
  if (resyncPending) {
    bufferedData = (bufferedData + data).slice(-DATA_BUFFER_LIMIT);
    return;
  }
  if (!term) {
    return;
  }
  term.write(data);
};

const handleMessage = (event) => {
  try {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case 'history':
        handleHistory(message.data);
        break;
      case 'data':
        handleData(message.data);
        break;
      case 'status':
        if (message.status === 'starting') {
          beginResync('backend-restarting', { request: false });
        } else if (message.status === 'exited') {
          term.write(
            `\r\n[dashboard exited code=${message.code ?? 'null'} signal=${ 
              message.signal ?? 'null'
            }]\r\n`,
          );
        }
        break;
      default:
        break;
    }
  } catch (error) {
    console.error('Failed to parse message', error);
  }
};

const createSocketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
};

const scheduleReconnect = () => {
  const delay = nextDelay();
  setTimeout(connect, delay);
};

const connect = () => {
  clearHistoryTimeout();
  resyncPending = true;
  bufferedData = '';
  lastHistory = null;
  socket = new WebSocket(createSocketUrl());

  socket.addEventListener('open', () => {
    resetDelay();
    beginResync('connect');
    term.write('[connected]\r\n');
  });

  socket.addEventListener('message', handleMessage);

  socket.addEventListener('close', () => {
    clearHistoryTimeout();
    term.write('\r\n[connection lost, retrying...]\r\n');
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    socket.close();
  });
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!resyncPending) {
      beginResync('visibility');
    } else {
      scheduleHistoryTimeout('visibility');
    }
  }
});

window.addEventListener('resize', applyScale);

const boot = async () => {
  try {
    await loadBundledFonts();
  } catch (error) {
    console.warn('dashboard: failed to load bundled fonts', error);
  }

  term = new TerminalCtor({
    convertEol: true,
    fontFamily:
      '"SF Mono Terminal", "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2, // A comfortable default for rendering
    letterSpacing: 1,  // A comfortable default for rendering
    theme: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3',
    },
    allowTransparency: true,
    scrollback: 4000,
    rendererType: 'canvas',
  });

  terminalWrapper = document.createElement('div');
  terminalWrapper.className = 'terminal-wrapper';
  container.appendChild(terminalWrapper);

  term.open(terminalWrapper);
  term.write('Connecting to dashboard...\r\n');

  initialiseFixedTerminalSize();
  applyScale();
  connect();
};

boot().catch((error) => {
  console.error('dashboard: failed to initialise terminal', error);
});

window.addEventListener('beforeunload', () => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
});