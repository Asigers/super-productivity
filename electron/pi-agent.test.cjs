const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

require('ts-node').register({
  transpileOnly: true,
  preferTsExts: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    ignoreDeprecations: '6.0',
  },
});
const {
  PiAgentManager,
  buildPiPrompt,
  parsePiRequest,
  parsePiConfig,
} = require('./pi-agent.ts');
const { DEFAULT_PI_PROJECT_CONFIG } = require('./shared-with-frontend/pi-agent.model.ts');
const { runPiRpc } = require('./pi-rpc-runner.ts');

const fixture = path.join(__dirname, 'fixtures/pi-rpc-fixture.cjs');
const request = (taskId = 'task-1', instruction = '') => ({
  taskId,
  projectId: 'project-1',
  issueUrl: 'https://devops.cwoa.net/devops/console/vteam/p17/twBug?id=123',
  instruction,
  newSession: false,
});
const setup = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sp-pi-test-'));
  const cwd = path.join(directory, 'workspace');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'User-owned instructions.\n');
  const updates = [];
  const manager = new PiAgentManager(path.join(directory, 'local'), (state) =>
    updates.push(structuredClone(state)),
  );
  await manager.saveConfig('project-1', {
    ...DEFAULT_PI_PROJECT_CONFIG,
    enabled: true,
    workingDirectory: cwd,
    executable: fixture,
  });
  t.after(async () => {
    await manager.stopAll();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { manager, cwd, directory, updates };
};
const finished = async (manager, taskId) => {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await manager.getTask(taskId);
    if (state.runs[0] && state.runs[0].status !== 'RUNNING') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Pi fixture did not finish');
};

test('old local Project settings default import notifications to off', () => {
  const { notifyOnImport, ...oldConfig } = DEFAULT_PI_PROJECT_CONFIG;
  assert.equal(parsePiConfig(oldConfig).notifyOnImport, false);
  assert.equal(
    parsePiConfig({ ...oldConfig, notifyOnImport: true }).notifyOnImport,
    true,
  );
  assert.throws(
    () => parsePiConfig({ ...oldConfig, notifyOnImport: 'true' }),
    (error) => error.code === 'INVALID_REQUEST',
  );
});

test('subprocess returns arbitrary Markdown, Unicode and tables without a JSON report schema', async (t) => {
  const { manager, cwd, directory } = await setup(t);
  const before = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8');
  await manager.start(request());
  const state = await finished(manager, 'task-1');
  assert.equal(state.runs[0].status, 'COMPLETED');
  assert.match(state.runs[0].markdown, /^# A freely written result/);
  assert.ok(state.runs[0].markdown.includes('\u2028 and \u2029. 中文。'));
  assert.match(state.runs[0].markdown, /\| A \| B \|/);
  assert.equal(await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf8'), before);
  assert.deepEqual((await fs.readdir(cwd)).sort(), ['AGENTS.md', 'rpc-inputs.jsonl']);
  const restored = new PiAgentManager(path.join(directory, 'local'));
  assert.equal(
    (await restored.getTask('task-1')).runs[0].markdown,
    state.runs[0].markdown,
  );
});

test('new sessions and resume commands use Pi storage for the original working directory', async (t) => {
  const { manager, cwd } = await setup(t);
  const started = await manager.start(request('resume-command'));
  await finished(manager, 'resume-command');

  const command = await manager.getResumeCommand('resume-command', started.runs[0].id);
  assert.ok(command.includes(cwd));
  assert.ok(command.includes(started.runs[0].sessionId));
  assert.ok(!command.includes('--session-dir'));
  assert.ok(command.includes('--session'));
  assert.ok(!command.includes('--session-id'));
  assert.ok(command.includes('Set-Location -LiteralPath') || command.includes('cd --'));
  const input = JSON.parse(
    (await fs.readFile(path.join(cwd, 'rpc-inputs.jsonl'), 'utf8')).split('\n')[0],
  );
  assert.ok(!input.fixtureArgs.includes('--session-dir'));
  assert.equal(
    input.fixtureArgs[input.fixtureArgs.indexOf('--session-id') + 1],
    started.runs[0].sessionId,
  );
});

test('legacy sessions remain in their original directory for resume and continuation', async (t) => {
  const { manager, cwd, directory } = await setup(t);
  const taskId = 'legacy-session';
  const legacyRun = {
    id: 'old-run',
    taskId,
    projectId: 'project-1',
    workingDirectory: cwd,
    sessionId: 'sp-legacy',
    status: 'COMPLETED',
    startedAt: 1,
    issueUrl: request().issueUrl,
    prompt: 'old prompt',
    markdown: 'old result',
  };
  const local = path.join(directory, 'local');
  const tasks = path.join(local, 'tasks');
  const sessions = path.join(local, 'sessions');
  await fs.mkdir(tasks, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(sessions, 'legacy.jsonl'), 'old conversation');
  await fs.writeFile(
    path.join(tasks, createHash('sha256').update(taskId).digest('hex') + '.json'),
    JSON.stringify({ taskId, runs: [legacyRun] }),
  );

  const command = await manager.getResumeCommand(taskId, legacyRun.id);
  assert.ok(command.includes('--session-dir'));
  assert.ok(command.includes(sessions));
  assert.ok(command.includes(legacyRun.sessionId));

  const continued = await manager.start(request(taskId));
  assert.equal(continued.runs[0].sessionId, legacyRun.sessionId);
  await finished(manager, taskId);
  const input = JSON.parse(
    (await fs.readFile(path.join(cwd, 'rpc-inputs.jsonl'), 'utf8')).split('\n')[0],
  );
  assert.equal(
    input.fixtureArgs[input.fixtureArgs.indexOf('--session-dir') + 1],
    sessions,
  );
  assert.equal(
    input.fixtureArgs[input.fixtureArgs.indexOf('--session') + 1],
    legacyRun.sessionId,
  );
  assert.ok(!input.fixtureArgs.includes('--session-id'));
  assert.equal(
    await fs.readFile(path.join(sessions, 'legacy.jsonl'), 'utf8'),
    'old conversation',
  );

  const fresh = await manager.start({ ...request(taskId), newSession: true });
  assert.notEqual(fresh.runs[0].sessionId, legacyRun.sessionId);
  await finished(manager, taskId);
  const starts = (await fs.readFile(path.join(cwd, 'rpc-inputs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((entry) => entry.type === 'get_state');
  assert.ok(!starts[1].fixtureArgs.includes('--session-dir'));
  assert.ok(
    !(await manager.getResumeCommand(taskId, fresh.runs[0].id)).includes('--session-dir'),
  );
});

test('does not send a prompt if Pi opens a different session', async (t) => {
  const { manager, cwd } = await setup(t);
  await fs.writeFile(path.join(cwd, 'rpc-session-id-override'), 'wrong-session');
  await manager.start(request('mismatched-session'));
  const state = await finished(manager, 'mismatched-session');
  assert.equal(state.runs[0].status, 'FAILED');
  assert.equal(state.runs[0].error, 'PROTOCOL_ERROR');
  const inputs = (await fs.readFile(path.join(cwd, 'rpc-inputs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    inputs.map((input) => input.type),
    ['get_state'],
  );
});

test('refuses to copy an external resume command while this Task has an active writer', async (t) => {
  const { manager } = await setup(t);
  const started = await manager.start(request('resume-running', '[WAIT]'));
  await assert.rejects(
    manager.getResumeCommand('resume-running', started.runs[0].id),
    /ALREADY_RUNNING/,
  );
  await manager.stop('resume-running');
});

test('same-Project Tasks run concurrently with distinct Sessions', async (t) => {
  const { manager } = await setup(t);
  const [a, b] = await Promise.all([
    manager.start(request('a', '[WAIT]')),
    manager.start(request('b', '[WAIT]')),
  ]);
  assert.equal(a.runs[0].status, 'RUNNING');
  assert.equal(b.runs[0].status, 'RUNNING');
  assert.notEqual(a.runs[0].sessionId, b.runs[0].sessionId);
  await assert.rejects(manager.start(request('a')), /ALREADY_RUNNING/);
  await manager.stopAll();
  assert.equal((await manager.getTask('a')).runs[0].status, 'CANCELLED');
  assert.equal((await manager.getTask('b')).runs[0].status, 'CANCELLED');
});

test('disabling Pi cancels this Project’s active Tasks but not other Projects', async (t) => {
  const { manager } = await setup(t);
  const config = await manager.getConfig('project-1');
  await manager.saveConfig('project-2', config);
  await Promise.all([
    manager.start(request('a', '[WAIT]')),
    manager.start({ ...request('b', '[WAIT]'), projectId: 'project-2' }),
  ]);
  await manager.saveConfig('project-1', { ...config, enabled: false });
  assert.equal((await manager.getTask('a')).runs[0].status, 'CANCELLED');
  assert.equal((await manager.getTask('b')).runs[0].status, 'RUNNING');
  await manager.stop('b');
});

test('agent_end is not completion; wait for final retry and agent_settled', async (t) => {
  const { manager } = await setup(t);
  await manager.start(request('retry', '[EARLY_END]'));
  const state = await finished(manager, 'retry');
  assert.equal(state.runs[0].status, 'COMPLETED');
  assert.notEqual(state.runs[0].markdown, 'intermediate');
});

for (const [marker, error] of [
  ['[FAIL]', 'RUNTIME_ERROR'],
  ['[EMPTY]', 'EMPTY_RESULT'],
  ['[HANDLED]', 'EMPTY_RESULT'],
  ['[INVALID]', 'PROTOCOL_ERROR'],
  ['[EXIT]', 'RUNTIME_ERROR'],
  ['[UI]', 'INTERACTION_REQUIRED'],
]) {
  test('reports a real subprocess failure for ' + marker, async (t) => {
    const { manager } = await setup(t);
    await manager.start(request(marker, marker));
    const run = (await finished(manager, marker)).runs[0];
    assert.equal(run.status, 'FAILED');
    assert.equal(run.error, error);
  });
}

test('continue reuses the Task Session; new analysis or cwd change creates a Session', async (t) => {
  const { manager, directory, cwd } = await setup(t);
  const first = await manager.start(request());
  await finished(manager, 'task-1');
  const restored = new PiAgentManager(path.join(directory, 'local'));
  t.after(() => restored.stopAll());
  assert.ok(
    !(await restored.getResumeCommand('task-1', first.runs[0].id)).includes(
      '--session-dir',
    ),
  );
  const continued = await restored.start(request());
  assert.equal(first.runs[0].sessionId, continued.runs[0].sessionId);
  await finished(restored, 'task-1');
  const starts = (await fs.readFile(path.join(cwd, 'rpc-inputs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((entry) => entry.type === 'get_state');
  assert.ok(!starts[1].fixtureArgs.includes('--session-dir'));
  assert.equal(
    starts[1].fixtureArgs[starts[1].fixtureArgs.indexOf('--session') + 1],
    first.runs[0].sessionId,
  );
  assert.ok(!starts[1].fixtureArgs.includes('--session-id'));
  const fresh = await restored.start({ ...request(), newSession: true });
  assert.notEqual(first.runs[0].sessionId, fresh.runs[0].sessionId);
  await finished(restored, 'task-1');
  const config = await restored.getConfig('project-1');
  const other = path.join(directory, 'other');
  await fs.mkdir(other);
  await restored.saveConfig('project-1', { ...config, workingDirectory: other });
  const moved = await restored.start(request());
  assert.notEqual(moved.runs[0].sessionId, fresh.runs[0].sessionId);
  await finished(restored, 'task-1');
});

test('restarting marks an unfinished persisted run interrupted, without dispatching Pi', async (t) => {
  const { directory, cwd } = await setup(t);
  const local = path.join(directory, 'local');
  const tasks = path.join(local, 'tasks');
  await fs.mkdir(tasks, { recursive: true });
  const taskId = 'previous-crash';
  await fs.writeFile(
    path.join(tasks, createHash('sha256').update(taskId).digest('hex') + '.json'),
    JSON.stringify({ taskId, runs: [{ id: 'old', status: 'RUNNING', markdown: '' }] }),
  );
  const restored = new PiAgentManager(local);
  assert.equal((await restored.getTask(taskId)).runs[0].status, 'INTERRUPTED');
  assert.equal(restored.isRunning, false);
  assert.deepEqual(await fs.readdir(cwd), ['AGENTS.md']);
});

test('credentials and shell-sensitive work-item input are not passed on the command line', async (t) => {
  const { manager, cwd } = await setup(t);
  const input = request('literal', 'literal \"quoted\" $HOME & echo should-not-run');
  await manager.start(input);
  await finished(manager, 'literal');
  const commands = (await fs.readFile(path.join(cwd, 'rpc-inputs.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(commands[0].type, 'get_state');
  const prompt = commands.find((command) => command.type === 'prompt');
  assert.ok(prompt.message.endsWith(input.instruction));
  assert.ok(prompt.message.includes(input.issueUrl));
});

test('custom prompts substitute values once and always receive the work-item link', () => {
  const input = request();
  assert.equal(
    buildPiPrompt('自由分析', input),
    '自由分析\n\nCTeam work item: ' + input.issueUrl,
  );
  assert.equal(
    buildPiPrompt('{{taskId}}: {{issueUrl}}', input),
    input.taskId + ': ' + input.issueUrl,
  );
  assert.throws(
    () => parsePiRequest({ ...input, issueUrl: 'javascript:alert(1)' }),
    /INVALID_REQUEST/,
  );
});

test('disabled configuration, missing directory and missing executable fail visibly', async (t) => {
  const { manager, cwd } = await setup(t);
  await assert.rejects(
    manager.start({ ...request(), projectId: 'not-configured' }),
    /CONFIG_REQUIRED/,
  );
  await assert.rejects(
    manager.saveConfig('p', {
      ...DEFAULT_PI_PROJECT_CONFIG,
      enabled: true,
      workingDirectory: path.join(cwd, 'missing'),
    }),
    /DIRECTORY_UNAVAILABLE/,
  );
  const config = await manager.getConfig('project-1');
  await manager.saveConfig('project-1', {
    ...config,
    executable: path.join(cwd, 'not-pi.exe'),
  });
  await manager.start(request());
  assert.equal((await finished(manager, 'task-1')).runs[0].error, 'PI_UNAVAILABLE');
});

test('an already cancelled request never starts the subprocess', async (t) => {
  const { cwd } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const result = await runPiRpc({
    config: { ...DEFAULT_PI_PROJECT_CONFIG, executable: fixture, workingDirectory: cwd },
    sessionDirectory: cwd,
    sessionId: 'cancelled',
    prompt: 'test',
    signal: controller.signal,
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(await fs.readdir(cwd), ['AGENTS.md']);
});
