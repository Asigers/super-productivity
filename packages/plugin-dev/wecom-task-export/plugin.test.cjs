const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, 'plugin.js'), 'utf8');
const webhook =
  'https://qyapi.weixin.qq.com/cgi-bin/wedoc/smartsheet/webhook?key=example';

function harness(existingStorage = new Map()) {
  const state = {
    tasks: [],
    projects: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ],
    requests: [],
    secrets: new Map(),
    timers: new Map(),
    id: 0,
    fail: false,
    emptyUpdate: false,
    hooks: {},
  };
  const api = {
    Hooks: { DATA_CHANGED: 'dataChanged' },
    registerHook: (name, cb) => {
      state.hooks[name] = cb;
    },
    registerConfigHandler: () => {},
    showIndexHtmlAsView: () => {},
    onMessage: (cb) => {
      state.message = cb;
    },
    onReady: (cb) => {
      state.ready = cb;
    },
    onUnload: (cb) => {
      state.unload = cb;
    },
    getTasks: async () => state.tasks,
    getAllProjects: async () => state.projects,
    getSecret: async (key) => state.secrets.get(key) || null,
    setSecret: async (key, value) => state.secrets.set(key, value),
    showSnack: () => {},
    request: async (_url, opts) => {
      state.requests.push(opts.body);
      if (state.fail) throw new Error('network');
      if (opts.body.add_records)
        return { errcode: 0, add_records: [{ record_id: `r${state.requests.length}` }] };
      return {
        errcode: 0,
        update_records: state.emptyUpdate
          ? []
          : [{ record_id: opts.body.update_records[0].record_id }],
      };
    },
  };
  const localStorage = {
    getItem: (key) => existingStorage.get(key) || null,
    setItem: (key, value) => existingStorage.set(key, value),
  };
  const sandbox = {
    PluginAPI: api,
    localStorage,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    URL,
    setTimeout: (fn) => {
      const id = ++state.id;
      state.timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => state.timers.delete(id),
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(source, sandbox);
  state.call = (action, payload) =>
    state.message({ type: 'wecom-export', action, payload });
  state.tick = async () => {
    const entries = [...state.timers.values()];
    state.timers.clear();
    for (const fn of entries) fn();
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!(await state.call('info')).running) return;
    }
    throw new Error('sync did not finish');
  };
  state.configure = async () => state.call('save', { webhook, itsm: 'a', interop: 'b' });
  return state;
}
const task = (id, extra = {}) => ({
  id,
  projectId: 'a',
  title: 'Task',
  notes: 'Detail',
  isDone: false,
  ...extra,
});

test('preview is read-only; sync filters projects and subtasks, adds once then updates by record id', async () => {
  const h = harness();
  h.tasks = [
    task('one'),
    task('child', { parentId: 'one' }),
    task('other', { projectId: 'c' }),
  ];
  await h.configure();
  const preview = await h.call('preview');
  assert.equal(preview.count, 1);
  assert.equal(preview.newCount, 1);
  assert.equal(h.requests.length, 0);
  await h.call('start');
  await h.tick();
  assert.equal(h.requests.length, 1);
  const values = h.requests[0].add_records[0].values;
  assert.equal(values.fik94t, 'one');
  assert.equal(values.fpV0E5, 'Detail');
  assert.equal(values.fElDo8, false);
  assert.equal(values.fNQseV[0].text, 'ITSM');
  assert.equal(Object.hasOwn(values, 'fvu6pW'), false);
  h.hooks.dataChanged();
  await h.tick();
  assert.equal(h.requests.length, 1);
  h.tasks[0] = task('one', { isDone: true, projectId: 'b', dueDay: '2026-06-20' });
  h.hooks.dataChanged();
  await h.tick();
  assert.equal(h.requests[1].update_records[0].record_id, 'r1');
  assert.equal(h.requests[1].update_records[0].values.fNQseV[0].text, '互联互通');
  assert.equal(h.requests[1].update_records[0].values.fvu6pW, '2026-06-20');
  h.tasks[0] = task('one', { isDone: true });
  h.hooks.dataChanged();
  await h.tick();
  assert.equal((await h.call('info')).staleDates[0], 'one');
  await h.call('ack-dates', { taskIds: ['one'] });
  assert.equal((await h.call('info')).staleDates.length, 0);
});

test('ambiguous create persists and blocks retry until manually resolved', async () => {
  const storage = new Map();
  const h = harness(storage);
  h.tasks = [task('one')];
  await h.configure();
  h.fail = true;
  await h.call('start');
  await h.tick();
  assert.equal((await h.call('info')).pending.taskId, 'one');
  h.hooks.dataChanged();
  await h.tick();
  assert.equal(h.requests.length, 1);
  const reloaded = harness(storage);
  reloaded.tasks = [task('one')];
  reloaded.secrets = h.secrets;
  reloaded.ready();
  await reloaded.tick();
  assert.equal(reloaded.requests.length, 0);
  await reloaded.call('resolve', { taskId: 'one', recordId: 'existing' });
  await reloaded.tick();
  assert.equal(reloaded.requests.length, 1);
  assert.equal(reloaded.requests[0].update_records[0].record_id, 'existing');
});

test('refuses changing webhook with mappings and leaves secret unchanged', async () => {
  const h = harness();
  h.tasks = [task('one')];
  await h.configure();
  await h.call('start');
  await h.tick();
  await assert.rejects(
    h.call('save', { webhook: webhook + '2', itsm: 'a', interop: 'b' }),
  );
  assert.equal(h.secrets.get('wecom-webhook'), webhook);
});

test('failed updates can retry without creating a second row', async () => {
  const h = harness();
  h.tasks = [task('one')];
  await h.configure();
  await h.call('start');
  await h.tick();
  h.fail = true;
  h.tasks[0] = task('one', { title: 'Changed' });
  h.hooks.dataChanged();
  await h.tick();
  assert.equal((await h.call('info')).pending, null);
  h.fail = false;
  h.hooks.dataChanged();
  await h.tick();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].update_records[0].record_id, 'r1');
});

test('an update response that does not confirm the row is retried', async () => {
  const h = harness();
  h.tasks = [task('one')];
  await h.configure();
  await h.call('start');
  await h.tick();
  h.tasks[0] = task('one', { title: 'Changed' });
  h.emptyUpdate = true;
  h.hooks.dataChanged();
  await h.tick();
  h.emptyUpdate = false;
  h.hooks.dataChanged();
  await h.tick();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].update_records[0].record_id, 'r1');
});

test('optional priority column updates existing rows and maps numeric and historical values', async () => {
  const h = harness();
  h.tasks = [task('one', { priority: 3 })];
  await h.configure();
  await h.call('start');
  await h.tick();
  assert.equal(h.requests[0].add_records[0].values.fPriority, undefined);
  await h.call('save', { itsm: 'a', interop: 'b', priorityFieldId: 'fPriority' });
  await h.call('start');
  await h.tick();
  assert.equal(h.requests[1].update_records[0].record_id, 'r1');
  assert.equal(h.requests[1].update_records[0].values.fPriority[0].text, '高');
  for (const [priority, expected] of [
    [2, '中'],
    ['low', '低'],
    [null, '未设置'],
    ['high', '高'],
    ['medium', '中'],
    [1, '低'],
  ]) {
    h.tasks[0] = task('one', { priority });
    h.hooks.dataChanged();
    await h.tick();
    assert.equal(h.requests.at(-1).update_records[0].values.fPriority[0].text, expected);
  }
});

test('priority is included in new records and can be disabled', async () => {
  const h = harness();
  h.tasks = [task('one', { priority: 2 })];
  await h.call('save', {
    webhook,
    itsm: 'a',
    interop: 'b',
    priorityFieldId: 'fPriority',
  });
  await h.call('start');
  await h.tick();
  assert.equal(h.requests[0].add_records[0].values.fPriority[0].text, '中');
  await h.call('save', { itsm: 'a', interop: 'b', priorityFieldId: '' });
  await h.call('start');
  await h.tick();
  assert.equal(Object.hasOwn(h.requests[1].update_records[0].values, 'fPriority'), false);
});

test('priority field cannot overwrite a built-in column', async () => {
  const h = harness();
  await assert.rejects(
    h.call('save', { webhook, itsm: 'a', interop: 'b', priorityFieldId: 'fuYjri' }),
  );
});

test('corrupt mapping fails closed', async () => {
  const h = harness(new Map([['wecom-task-export:v1', 'not json']]));
  assert.equal((await h.call('info')).broken, true);
  await assert.rejects(h.configure());
});
