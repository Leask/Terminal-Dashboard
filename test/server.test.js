import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { createDashboardService } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');
const dashboardScript = path.join(fixturesDir, 'dummy-dashboard.sh');

const createStubHeadlessBundle = (cols = 80, rows = 24) => {
  const state = {
    cols,
    rows,
    writes: [],
    disposed: false,
  };

  const term = {
    cols: state.cols,
    rows: state.rows,
    write(data, cb) {
      state.writes.push(data);
      cb?.();
    },
    resize(nextCols, nextRows) {
      state.cols = nextCols;
      state.rows = nextRows;
      term.cols = nextCols;
      term.rows = nextRows;
    },
    reset() {
      state.writes.length = 0;
    },
    dispose() {
      state.disposed = true;
    },
  };

  const serializer = {
    serialize() {
      return state.writes.join('');
    },
  };

  return { term, serializer };
};

class MockTimer {
  constructor(fn, ms) {
    this.fn = fn;
    this.ms = ms;
    this.cleared = false;
  }

  clear() {
    this.cleared = true;
  }

  trigger() {
    if (!this.cleared) {
      this.fn();
    }
  }

  unref() {}
}

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  listen(port, host, onListening) {
    this.port = port;
    this.host = host;
    queueMicrotask(() => {
      this.emit('listening');
      if (onListening) {
        onListening();
      }
    });
  }

  close(cb) {
    this.closed = true;
    queueMicrotask(() => cb?.());
  }

  address() {
    return { port: this.port, address: this.host };
  }
}

class MockWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  close(cb) {
    this.closed = true;
    queueMicrotask(() => cb?.());
  }

  emitConnection(ws) {
    this.emit('connection', ws);
  }
}

class MockWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = MockWebSocket.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

MockWebSocket.OPEN = 1;
MockWebSocket.CLOSED = 3;

class FakePty {
  constructor() {
    this.emitter = new EventEmitter();
    this.killed = false;
    this.resizeCalls = [];
  }

  onData(listener) {
    this.emitter.on('data', listener);
    return { dispose: () => this.emitter.off('data', listener) };
  }

  onExit(listener) {
    this.emitter.on('exit', listener);
    return { dispose: () => this.emitter.off('exit', listener) };
  }

  emitData(chunk) {
    this.emitter.emit('data', chunk);
  }

  emitExit(info = { exitCode: 0, signal: null }) {
    this.emitter.emit('exit', info);
  }

  kill() {
    if (this.killed) {
      return;
    }
    this.killed = true;
    queueMicrotask(() => this.emitExit());
  }

  resize(cols, rows) {
    this.resizeCalls.push({ cols, rows });
  }
}

test('createDashboardService throws when dashboard script is missing', () => {
  const bogusPath = path.join(fixturesDir, 'does-not-exist.sh');
  assert.throws(
    () => createDashboardService({ scriptPath: bogusPath }),
    /dashboard script not found/,
  );
});

test('service start spawns the dashboard process and stop cleans up', async () => {
  const mockServer = new MockServer();
  const mockWss = new MockWebSocketServer();
  const fakePty = new FakePty();
  const spawnCalls = [];
  const timers = new Set();

  const service = createDashboardService({
    scriptPath: dashboardScript,
    port: 9200,
    host: '127.0.0.1',
    createHttpServer: (handler) => {
      mockServer.handler = handler;
      return mockServer;
    },
    createWebSocketServer: (serverInstance) => {
      assert.equal(serverInstance, mockServer);
      return mockWss;
    },
    setTimeoutFn: (fn, ms) => {
      const timer = new MockTimer(fn, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      timer?.clear();
      timers.delete(timer);
    },
    pty: {
      spawn: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return fakePty;
      },
    },
    snapshotInterval: 0,
    createHeadlessBundle: createStubHeadlessBundle,
  });

  const startInfo = await service.start(9301);
  assert.equal(startInfo.port, 9301);
  assert.equal(startInfo.host, '127.0.0.1');

  assert.equal(spawnCalls.length, 1);
  const spawnCall = spawnCalls[0];
  assert.equal(spawnCall.command, dashboardScript);
  assert.deepEqual(spawnCall.args, []);
  assert.equal(spawnCall.options.cols, 426);
  assert.equal(spawnCall.options.rows, 110);
  assert.match(spawnCall.options.env.LANG, /UTF-8/);

  await assert.rejects(service.start(), /already started/);

  const client = new MockWebSocket();
  mockWss.emitConnection(client);
  await new Promise((resolve) => setImmediate(resolve));
  fakePty.emitData('hello');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.sent.length > 0, true);

  await service.stop();

  assert.equal(fakePty.killed, true);
  assert.equal(mockServer.closed, true);
  assert.equal(mockWss.closed, true);
  assert.equal(timers.size, 0);

});

// test('websocket resize messages resize the pty and refresh history', async () => {
//   const mockServer = new MockServer();
//   const mockWss = new MockWebSocketServer();
//   const fakePty = new FakePty();
//
//   const service = createDashboardService({
//     scriptPath: dashboardScript,
//     createHttpServer: () => mockServer,
//     createWebSocketServer: () => mockWss,
//     pty: {
//       spawn: () => fakePty,
//     },
//     snapshotInterval: 0,
//     createHeadlessBundle: createStubHeadlessBundle,
//   });
//
//   await service.start(9400);
//
//   const client = new MockWebSocket();
//   mockWss.emitConnection(client);
//
//   client.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 120, rows: 40 })));
//
//   await new Promise((resolve) => setImmediate(resolve));
//
//   assert.equal(fakePty.resizeCalls.length > 0, true);
//   const { cols, rows } = fakePty.resizeCalls.at(-1);
//   assert.equal(cols, 120);
//   assert.equal(rows, 40);
//
//   await service.stop();
// });
