const test = require('node:test');
const assert = require('node:assert/strict');
require('ts-node').register({
  transpileOnly: true,
  preferTsExts: true,
  compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
});
const { createCTeamProvider, parseAuth } = require('./src/cteam.ts');
const cteamManifest = require('./src/manifest.json');
const { createCredentialHandler } = require('./src/credentials.ts');

test('iframe credential setup uses the plugin message bridge and never returns a token', async () => {
  let stored = null;
  const handler = createCredentialHandler({
    getSecret: async () => stored,
    setSecret: async (key, value) => {
      assert.equal(key, 'cteam-auth');
      stored = value;
    },
    deleteSecret: async (key) => {
      assert.equal(key, 'cteam-auth');
      stored = null;
    },
  });
  const info = await handler({
    type: 'cteam-auth',
    action: 'save',
    payload: {
      userId: 'u-1',
      token: 'not-a-real-token',
      tenantId: 't-1',
    },
  });
  assert.deepEqual(info, { configured: true, userId: 'u-1', tenantId: 't-1' });
  assert.equal(JSON.parse(stored).token, 'not-a-real-token');
  assert.deepEqual(await handler({ type: 'cteam-auth', action: 'info' }), info);
  assert.ok(!JSON.stringify(info).includes('token'));
  await assert.rejects(handler({ type: 'other', action: 'info' }), /Unsupported/);
  await handler({ type: 'cteam-auth', action: 'remove' });
  assert.equal((await handler({ type: 'cteam-auth', action: 'info' })).configured, false);
});
test('bundled auto-import polling interval is 30 minutes', () => {
  assert.equal(cteamManifest.issueProvider.pollIntervalMs, 30 * 60 * 1000);
  assert.equal(cteamManifest.issueProvider.defaultAutoAddToBacklog, false);
});

const auth = { userId: 'u-1', token: 'test-not-a-real-token', tenantId: 'tenant-1' };
const config = {
  projectKey: 'p17',
  classify: 'BUG',
  modelTypeId: 'deployed-bug-id',
  assigneeField: 'dynamic-assignee-7',
  excludedStates: ['closed'],
};
const fields = [
  { id: 'dynamic-assignee-7', name: 'handler', label: '经办人' },
  { id: 'dynamic-state-8', name: 'state', label: '状态' },
];
const issue = (id, changes = {}, type = {}) => {
  const classify = type.classify ?? 'BUG';
  const modelTypeId = type.modelTypeId ?? 'deployed-bug-id';
  const assigneeName = type.assigneeName ?? 'handler';
  return {
    property: {
      id: { value: id },
      projectId: { value: 'p17' },
      number: { value: 'p17_' + id },
      title: { value: 'Issue ' + id },
      state: { value: 'open', displayValue: 'Open' },
      typeClassify: { value: classify },
      modelTypeId: { value: modelTypeId },
      updateTime: { value: '2026-11-03T08:00:00Z' },
      [assigneeName]: { id: type.assigneeFieldId ?? 'dynamic-assignee-7', value: 'u-1' },
      ...changes,
    },
  };
};
const setup = (pages = [[issue('42')]], options = {}) => {
  const calls = [];
  const provider = createCTeamProvider(async () => auth);
  const http = {
    get: async (input) => {
      const url = new URL(input);
      calls.push({ method: 'GET', url });
      assert.equal(url.origin, 'https://devops.cwoa.net');
      assert.equal(url.searchParams.get('userId'), 'u-1');
      if (url.pathname.endsWith('/query_filters')) {
        const classify = url.searchParams.get('classify');
        return {
          status: 0,
          data: options.fieldsByClassify?.[classify] ?? options.fields ?? fields,
        };
      }
      if (url.pathname.includes('/issue_field_value/'))
        return {
          code: '0',
          data: options.statesByClassify?.[url.searchParams.get('classify')] ??
            options.states ?? [
              { id: 'option-open', value: 'open', displayValue: 'Open' },
              { id: 'option-closed', value: 'closed', displayValue: 'Closed' },
              { id: 'option-tested', value: 'tested', displayValue: '测试完成' },
            ],
        };
      return { status: 0, data: options.detail ?? issue('42') };
    },
    post: async (input, body) => {
      const url = new URL(input);
      calls.push({ method: 'POST', url, body });
      assert.equal(url.pathname, '/api/open/CTeam/api/service_open/issue/2.1.0/flat');
      const page = Number(url.searchParams.get('num'));
      const classify =
        body.find((filter) => filter.name === 'typeClassify')?.value?.[0] ?? 'BUG';
      const selectedPages = options.pagesByClassify?.[classify] ?? pages;
      if (options.failPage === page || options.failClassify === classify)
        throw new Error('page failed');
      return {
        status: 0,
        data: {
          content: selectedPages[page],
          number: page,
          totalPages: options.badPages ? undefined : selectedPages.length,
          totalElements: selectedPages.flat().length,
        },
      };
    },
  };
  return { provider, http, calls };
};

test('dynamic search options load before the required 经办人 field can be selected', async () => {
  const { provider, http } = setup();
  const configWithoutAssignee = {
    projectKey: config.projectKey,
    classify: config.classify,
    modelTypeId: config.modelTypeId,
    excludedStates: [],
  };
  const assigneeField = provider.configFields.find(
    (field) => field.key === 'assigneeField',
  );
  const stateField = provider.configFields.find(
    (field) => field.key === 'excludedStates',
  );
  assert.deepEqual(await assigneeField.loadOptions(configWithoutAssignee, http), [
    { label: '经办人', value: 'dynamic-assignee-7' },
  ]);
  assert.equal((await stateField.loadOptions(configWithoutAssignee, http)).length, 3);
  await assert.rejects(provider.testConnection(configWithoutAssignee, http), /经办人/);
  assert.equal(
    await provider.testConnection(
      { ...configWithoutAssignee, assigneeField: 'dynamic-assignee-7' },
      http,
    ),
    true,
  );
});

test('matches the current user within a comma-separated multi-assignee value', async () => {
  const multiAssignee = issue('42', {
    handler: { id: 'dynamic-assignee-7', value: 'another-user, u-1, third-user' },
  });
  const { provider, http } = setup([[multiAssignee]]);
  const results = await provider.getNewIssuesForBacklog(config, http);
  assert.deepEqual(
    results.map((item) => item.id),
    ['p17/42'],
  );
});

test('does not match the current user as a substring of another comma-separated ID', async () => {
  const multiAssignee = issue('42', {
    handler: { id: 'dynamic-assignee-7', value: 'u-10,another-user' },
  });
  const { provider, http } = setup([[multiAssignee]]);
  await assert.rejects(
    provider.getNewIssuesForBacklog(config, http),
    /exact current-user\/project\/type filtering/,
  );
});

test('discovers the dynamic 经办人 field and sends it in server-side filtering', async () => {
  const { provider, http, calls } = setup();
  const result = await provider.getNewIssuesForBacklog(config, http);
  const post = calls.find((call) => call.method === 'POST');
  assert.deepEqual(post.body, [
    { name: 'projectId', value: ['p17'] },
    { name: 'typeClassify', value: ['BUG'] },
    { name: 'modelTypeId', value: ['deployed-bug-id'] },
    { name: 'handler', value: ['u-1'] },
  ]);
  assert.equal(post.url.searchParams.get('userId'), 'u-1');
  assert.equal(result[0].id, 'p17/42');
  assert.equal(result[0].title, 'Issue 42');
});

test('one provider searches multiple classes and model type IDs with per-class assignee fields', async () => {
  const multiConfig = {
    ...config,
    additionalWorkItemTypes:
      'BUG:deployed-itr-id\nDEMAND:demand-type-id\nTASK:task-type-id',
  };
  const pagesByClassify = {
    BUG: [[issue('42'), issue('43', {}, { modelTypeId: 'deployed-itr-id' })]],
    DEMAND: [
      [
        issue(
          '44',
          {},
          {
            classify: 'DEMAND',
            modelTypeId: 'demand-type-id',
            assigneeName: 'demandOwner',
            assigneeFieldId: 'dynamic-demand-assignee',
          },
        ),
      ],
    ],
    TASK: [
      [
        issue(
          '45',
          {},
          {
            classify: 'TASK',
            modelTypeId: 'task-type-id',
            assigneeName: 'taskOwner',
            assigneeFieldId: 'dynamic-task-assignee',
          },
        ),
      ],
    ],
  };
  const { provider, http, calls } = setup(undefined, {
    pagesByClassify,
    fieldsByClassify: {
      BUG: fields,
      DEMAND: [
        { id: 'dynamic-demand-assignee', name: 'demandOwner', label: '经办人' },
        { id: 'dynamic-state-demand', name: 'state', label: '状态' },
      ],
      TASK: [
        { id: 'dynamic-task-assignee', name: 'taskOwner', label: '经办人' },
        { id: 'dynamic-state-task', name: 'state', label: '状态' },
      ],
    },
  });

  const result = await provider.getNewIssuesForBacklog(multiConfig, http);
  assert.deepEqual(
    result.map((row) => row.id),
    ['p17/42', 'p17/43', 'p17/44', 'p17/45'],
  );
  const requests = calls.filter((call) => call.method === 'POST');
  assert.equal(requests.length, 3);
  const byClassify = Object.fromEntries(
    requests.map((call) => [
      call.body.find((filter) => filter.name === 'typeClassify').value[0],
      call.body,
    ]),
  );
  assert.deepEqual(byClassify.BUG.find((filter) => filter.name === 'modelTypeId').value, [
    'deployed-bug-id',
    'deployed-itr-id',
  ]);
  assert.equal(
    byClassify.BUG.find((filter) => filter.name === 'handler').value[0],
    'u-1',
  );
  assert.equal(
    byClassify.DEMAND.find((filter) => filter.name === 'demandOwner').value[0],
    'u-1',
  );
  assert.equal(
    byClassify.TASK.find((filter) => filter.name === 'taskOwner').value[0],
    'u-1',
  );
});

test('extra types filter the exact classification and reject mismatched upstream rows', async () => {
  const multiConfig = {
    ...config,
    additionalWorkItemTypes: 'DEMAND:demand-type-id',
  };
  const { provider, http } = setup(undefined, {
    pagesByClassify: {
      BUG: [[]],
      DEMAND: [
        [
          issue(
            '44',
            {},
            {
              classify: 'DEMAND',
              modelTypeId: 'demand-type-id',
              assigneeName: 'demandOwner',
              assigneeFieldId: 'dynamic-demand-assignee',
            },
          ),
        ],
      ],
    },
    fieldsByClassify: {
      BUG: fields,
      DEMAND: [{ id: 'dynamic-demand-assignee', name: 'demandOwner', label: '经办人' }],
    },
  });
  const result = await provider.getNewIssuesForBacklog(multiConfig, http);
  assert.deepEqual(
    result.map((row) => row.classify),
    ['DEMAND'],
  );

  const invalid = setup(undefined, {
    pagesByClassify: {
      BUG: [[]],
      DEMAND: [
        [
          issue(
            '44',
            {},
            {
              classify: 'BUG',
              modelTypeId: 'demand-type-id',
              assigneeName: 'demandOwner',
              assigneeFieldId: 'dynamic-demand-assignee',
            },
          ),
        ],
      ],
    },
    fieldsByClassify: {
      BUG: fields,
      DEMAND: [{ id: 'dynamic-demand-assignee', name: 'demandOwner', label: '经办人' }],
    },
  });
  await assert.rejects(
    invalid.provider.getNewIssuesForBacklog(multiConfig, invalid.http),
    /exact current-user\/project\/type filtering/,
  );
});

test('per-type state options and exclusions remain distinct in a multi-type provider', async () => {
  const multiConfig = {
    ...config,
    additionalWorkItemTypes: 'DEMAND:demand-type-id',
  };
  const { provider, http } = setup(undefined, {
    pagesByClassify: {
      BUG: [
        [issue('1', { state: { value: 'closed', displayValue: 'Closed' } }), issue('2')],
      ],
      DEMAND: [
        [
          issue(
            '3',
            {
              state: { value: 'closed', displayValue: 'Closed' },
            },
            {
              classify: 'DEMAND',
              modelTypeId: 'demand-type-id',
              assigneeName: 'demandOwner',
              assigneeFieldId: 'dynamic-demand-assignee',
            },
          ),
          issue(
            '4',
            {},
            {
              classify: 'DEMAND',
              modelTypeId: 'demand-type-id',
              assigneeName: 'demandOwner',
              assigneeFieldId: 'dynamic-demand-assignee',
            },
          ),
        ],
      ],
    },
    fieldsByClassify: {
      BUG: fields,
      DEMAND: [
        { id: 'dynamic-demand-assignee', name: 'demandOwner', label: '经办人' },
        { id: 'dynamic-state-demand', name: 'state', label: '状态' },
      ],
    },
  });
  const stateField = provider.configFields.find(
    (field) => field.key === 'excludedStates',
  );
  const options = await stateField.loadOptions(multiConfig, http);
  const demandClosed = options.find((option) => {
    try {
      const value = JSON.parse(option.value);
      return value[0] === 'DEMAND' && value[2] === 'closed';
    } catch {
      return false;
    }
  });
  assert.ok(demandClosed);
  assert.match(demandClosed.label, /DEMAND \/ demand-type-id/);

  const result = await provider.getNewIssuesForBacklog(
    {
      ...multiConfig,
      excludedStates: ['closed', demandClosed.value],
    },
    http,
  );
  assert.deepEqual(
    result.map((row) => row.id),
    ['p17/2', 'p17/4'],
  );
});

test('multi-type configuration rejects duplicate pairs, malformed lines and unsupported classes', async () => {
  const { provider, http } = setup();
  await assert.rejects(
    provider.getNewIssuesForBacklog(
      {
        ...config,
        additionalWorkItemTypes: 'BUG:deployed-bug-id',
      },
      http,
    ),
    /already contains the primary/,
  );
  await assert.rejects(
    provider.getNewIssuesForBacklog(
      {
        ...config,
        additionalWorkItemTypes: 'DEMAND',
      },
      http,
    ),
    /CLASSIFY:MODEL_TYPE_ID/,
  );
  await assert.rejects(
    provider.getNewIssuesForBacklog(
      {
        ...config,
        additionalWorkItemTypes: 'OTHER:custom-id',
      },
      http,
    ),
    /BUG, DEMAND, or TASK/,
  );
});

test('reads all zero-based pages and deduplicates by project + internal issue ID', async () => {
  const { provider, http, calls } = setup([[issue('42')], [issue('42'), issue('43')]]);
  const result = await provider.getNewIssuesForBacklog(config, http);
  assert.deepEqual(
    result.map((row) => row.id),
    ['p17/42', 'p17/43'],
  );
  assert.deepEqual(
    calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.url.searchParams.get('num')),
    ['0', '1'],
  );
});

test('partial page failure returns no partial import batch', async () => {
  const { provider, http } = setup([[issue('42')], [issue('43')]], { failPage: 1 });
  await assert.rejects(provider.getNewIssuesForBacklog(config, http), /page failed/);
});

test('missing pagination is not treated as a complete scan', async () => {
  const { provider, http } = setup(undefined, { badPages: true });
  await assert.rejects(provider.getNewIssuesForBacklog(config, http), /incomplete/);
});

test('user-configured stable states are excluded before creating tasks, not by hardcoded names', async () => {
  const { provider, http } = setup([
    [
      issue('1', { state: { value: 'closed', displayValue: '任意本地化名称' } }),
      issue('2', { state: { value: 'tested', displayValue: '测试完成' } }),
    ],
  ]);
  const result = await provider.getNewIssuesForBacklog(config, http);
  assert.deepEqual(
    result.map((row) => row.id),
    ['p17/2'],
  );
  const excluded = await provider.getNewIssuesForBacklog(
    { ...config, excludedStates: ['closed', 'tested'] },
    http,
  );
  assert.deepEqual(excluded, []);
});

test('an empty exclusion selection is allowed and excludes nothing', async () => {
  const { provider, http } = setup([
    [issue('1', { state: { value: 'closed', displayValue: 'Closed' } })],
  ]);
  assert.equal(
    (await provider.getNewIssuesForBacklog({ ...config, excludedStates: [] }, http))
      .length,
    1,
  );
});

test('changed exclusion options stop import instead of silently dropping rules', async () => {
  const { provider, http } = setup(undefined, {
    states: [{ value: 'new-state', displayValue: 'New' }],
  });
  await assert.rejects(provider.getNewIssuesForBacklog(config, http), /options changed/);
});

for (const [name, changes] of [
  ['assignee', { handler: { value: 'another-user' } }],
  ['project', { projectId: { value: 'another-project' } }],
  ['work-item type', { modelTypeId: { value: 'another-type' } }],
]) {
  test('rejects a server result not matching the current ' + name, async () => {
    const { provider, http } = setup([[issue('42', changes)]]);
    await assert.rejects(
      provider.getNewIssuesForBacklog(config, http),
      /exact current-user/,
    );
  });
}

test('does not assume a dedicated my-issues endpoint or fall back to full-project queries', async () => {
  const { provider, http, calls } = setup(undefined, {
    fields: [{ id: 'x', name: 'owner', label: 'Owner' }],
  });
  await assert.rejects(
    provider.getNewIssuesForBacklog({ ...config, excludedStates: [] }, http),
    /经办人/,
  );
  assert.equal(
    calls.some((call) => call.method === 'POST'),
    false,
  );
});

test('work-item links include table mode so CTeam does not redirect away from the item', () => {
  const { provider } = setup();
  const id = 'f6726834b14d49029411ba33876ee706';
  assert.equal(
    provider.getIssueLink('opsbpm/' + id, { ...config, projectKey: 'opsbpm' }),
    'https://devops.cwoa.net/devops/console/vteam/opsbpm/twBug?vmode=table&id=' + id,
  );
  for (const [classify, page] of [
    ['DEMAND', 'twDemand'],
    ['TASK', 'twTask'],
  ]) {
    const link = new URL(provider.getIssueLink('p17/42', { ...config, classify }));
    assert.equal(link.pathname, '/devops/console/vteam/p17/' + page);
    assert.equal(link.searchParams.get('vmode'), 'table');
    assert.equal(link.searchParams.get('id'), '42');
  }
});

test('source detail exposes only number, title, status and original link, with no write-back hooks', async () => {
  const { provider, http, calls } = setup();
  const result = await provider.getById('p17/42', config, http);
  assert.deepEqual(
    provider.issueDisplay.map((field) => field.field),
    ['number', 'title', 'state', 'url'],
  );
  assert.equal(result.number, 'p17_42');
  assert.equal(new URL(result.url).searchParams.get('id'), '42');
  assert.equal(new URL(result.url).searchParams.get('vmode'), 'table');
  assert.equal(result.body, undefined);
  assert.equal(result.comments, undefined);
  assert.deepEqual(provider.doneStates, []);
  for (const name of ['updateIssue', 'createIssue', 'deleteIssue', 'timeTracking'])
    assert.equal(provider[name], undefined);
  assert.ok(calls.every((call) => call.method === 'GET'));
  assert.equal(provider.fieldMappings[0].defaultDirection, 'off');
});

test('multi-type detail uses the actual CTeam type for its link and falls back for link resolution', async () => {
  const multiConfig = {
    ...config,
    additionalWorkItemTypes: 'DEMAND:demand-type-id',
  };
  const demandIssue = issue(
    '44',
    {},
    {
      classify: 'DEMAND',
      modelTypeId: 'demand-type-id',
      assigneeName: 'demandOwner',
      assigneeFieldId: 'dynamic-demand-assignee',
    },
  );
  const { provider, http } = setup(undefined, { detail: demandIssue });
  const result = await provider.getById('p17/44', multiConfig, http);
  assert.equal(result.classify, 'DEMAND');
  assert.equal(new URL(result.url).pathname, '/devops/console/vteam/p17/twDemand');
  assert.equal(provider.getIssueLink('p17/44', multiConfig), '');
});

test('additional work-item type configuration is exposed as a multiline field', async () => {
  const { provider } = setup();
  const field = provider.configFields.find(
    (configField) => configField.key === 'additionalWorkItemTypes',
  );
  assert.equal(field.type, 'textarea');
  assert.equal(field.description, 'CFG.ADDITIONAL_TYPES_HELP');
});

test('secrets are read locally, never declared as synced configuration fields', async () => {
  const { provider } = setup();
  const headers = await provider.getHeaders(config);
  assert.equal(headers['X-DEVOPS-UID'], auth.userId);
  assert.equal(headers['X-DEVOPS-ACCESS-TOKEN'], auth.token);
  assert.equal(headers['X-DEVOPS-TENANT-ID'], auth.tenantId);
  assert.ok(
    provider.configFields.every(
      (field) => field.type !== 'password' && !/token|userId/i.test(field.key),
    ),
  );
  assert.throws(() => parseAuth(null), /this device/);
});

test('dynamic field and state option values come from live metadata', async () => {
  const { provider, http } = setup();
  const assignee = provider.configFields.find((field) => field.key === 'assigneeField');
  assert.deepEqual(await assignee.loadOptions(config, http), [
    { label: '经办人', value: 'dynamic-assignee-7' },
  ]);
  const states = provider.configFields.find((field) => field.key === 'excludedStates');
  const values = await states.loadOptions(config, http);
  assert.deepEqual(
    values.map((row) => row.value),
    ['open', 'closed', 'tested'],
  );
});
