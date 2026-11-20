const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
require('ts-node').register({ transpileOnly: true, preferTsExts: true });
const {
  createPiPreloadApiConsumer,
} = require('./shared-with-frontend/pi-preload-api.ts');

test('Pi process API is handed to trusted startup exactly once and seals every invocation', async () => {
  const calls = [];
  const consume = createPiPreloadApiConsumer(
    async (channel, payload) => {
      calls.push({ channel, payload });
      return channel === 'PI_AGENT_REGISTER_CAPABILITY'
        ? 'private-capability'
        : { ok: true, data: { taskId: 't', runs: [] } };
    },
    () => () => {},
  );
  const api = consume();
  assert.equal(consume(), null);
  await api.getTask('t');
  await api.getResumeCommand('t', 'r1');
  assert.deepEqual(calls[1], {
    channel: 'PI_AGENT_GET_TASK',
    payload: { capabilityToken: 'private-capability', payload: ['t'] },
  });
  assert.deepEqual(calls[2], {
    channel: 'PI_AGENT_GET_RESUME_COMMAND',
    payload: { capabilityToken: 'private-capability', payload: ['t', 'r1'] },
  });
});

test('Pi main-process endpoints reject missing, foreign and stale capabilities', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-pi-cap-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const handlers = new Map();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron')
      return {
        app: { getPath: () => directory, on: () => {} },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      };
    if (request.endsWith('main-window'))
      return {
        getWin: () => {
          throw new Error('closed');
        },
      };
    return original.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('./ipc-handlers/pi-agent.ts')];
    require('./ipc-handlers/pi-agent.ts').initPiAgentIpc();
  } finally {
    Module._load = original;
  }
  const frame = {};
  const event = { senderFrame: frame, sender: { mainFrame: frame } };
  const register = handlers.get('PI_AGENT_REGISTER_CAPABILITY');
  const get = handlers.get('PI_AGENT_GET_CONFIG');
  const token = register(event);
  assert.equal(typeof token, 'string');
  assert.equal(register({ senderFrame: {}, sender: event.sender }), null);
  assert.equal((await get(event, { payload: ['p1'] })).ok, false);
  assert.equal(
    (await get(event, { capabilityToken: 'wrong', payload: ['p1'] })).ok,
    false,
  );
  assert.equal(
    (
      await get(
        { ...event, senderFrame: {} },
        {
          capabilityToken: token,
          payload: ['p1'],
        },
      )
    ).ok,
    false,
  );
  assert.equal((await get(event, { capabilityToken: token, payload: ['p1'] })).ok, true);
  const nextToken = register(event);
  assert.notEqual(nextToken, token);
  assert.equal((await get(event, { capabilityToken: token, payload: ['p1'] })).ok, false);
  assert.equal(
    (await get(event, { capabilityToken: nextToken, payload: ['p1'] })).ok,
    true,
  );
});
