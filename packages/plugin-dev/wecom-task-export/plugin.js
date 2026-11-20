/* Enterprise WeChat export: all state and credentials stay on this device. */
(() => {
  const KEY = 'wecom-task-export:v1';
  const SECRET = 'wecom-webhook';
  const FIELDS = {
    done: 'fElDo8',
    title: 'fuYjri',
    notes: 'fpV0E5',
    date: 'fvu6pW',
    project: 'fNQseV',
    id: 'fik94t',
  };
  const initial = () => ({
    version: 1,
    projects: {},
    records: [],
    pending: null,
    enabled: false,
    webhookHash: null,
  });
  let state;
  let broken = false;
  try {
    const raw = localStorage.getItem(KEY);
    state = raw ? JSON.parse(raw) : initial();
    if (
      state.version !== 1 ||
      !Array.isArray(state.records) ||
      !state.projects ||
      typeof state.projects !== 'object'
    )
      throw new Error('invalid state');
  } catch {
    state = initial();
    broken = true; // Never recreate records after a corrupt mapping.
  }
  let running = false;
  let rescan = false;
  let unloaded = false;
  let timer = null;
  let lastError = '';
  const save = () => {
    if (broken)
      throw new Error('本机映射数据无法读取，已停止同步。请先恢复数据，勿重新创建记录。');
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      broken = true;
      throw new Error('无法保存本机映射，已停止同步。');
    }
  };
  const hash = async (value) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (n) =>
      n.toString(16).padStart(2, '0'),
    ).join('');
  };
  const validWebhook = (value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === 'https:' &&
        u.hostname === 'qyapi.weixin.qq.com' &&
        !u.port &&
        !u.username &&
        !u.password &&
        u.pathname === '/cgi-bin/wedoc/smartsheet/webhook' &&
        !!u.searchParams.get('key') &&
        [...u.searchParams.keys()].length === 1 &&
        !u.hash
      );
    } catch {
      return false;
    }
  };
  const getSelected = async () => {
    const [tasks, projects] = await Promise.all([
      PluginAPI.getTasks(),
      PluginAPI.getAllProjects(),
    ]);
    const known = new Set(projects.map((p) => p.id));
    const ids = Object.values(state.projects);
    if (ids.length !== 2 || new Set(ids).size !== 2 || ids.some((id) => !known.has(id))) {
      throw new Error('请选择两个不同且存在的项目。');
    }
    return tasks.filter((t) => !t.parentId && ids.includes(t.projectId));
  };
  const priorityLabel = (priority) => {
    switch (priority) {
      case 3:
      case 'high':
        return '高';
      case 2:
      case 'medium':
        return '中';
      case 1:
      case 'low':
        return '低';
      default:
        return '未设置';
    }
  };
  const valuesFor = (task) => {
    const project = Object.entries(state.projects).find(
      ([, id]) => id === task.projectId,
    )?.[0];
    const values = {
      [FIELDS.done]: !!task.isDone,
      [FIELDS.title]: task.title || '',
      [FIELDS.notes]: task.notes || '',
      [FIELDS.project]: [{ text: project }],
      [FIELDS.id]: task.id,
    };
    // The official Webhook contract does not document how to clear a date.
    // Omit absent dates rather than sending an undocumented null.
    if (task.dueWithTime != null) values[FIELDS.date] = String(task.dueWithTime);
    else if (task.dueDay) values[FIELDS.date] = task.dueDay;
    if (state.priorityFieldId) {
      values[state.priorityFieldId] = [{ text: priorityLabel(task.priority) }];
    }
    return values;
  };
  const post = async (webhook, body) => {
    const result = await PluginAPI.request(webhook, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    if (!result || result.errcode !== 0)
      throw new Error('企业微信请求未成功，请检查表格字段、权限和网络。');
    return result;
  };
  const sync = async () => {
    if (running) {
      rescan = true;
      return;
    }
    if (unloaded || !state.enabled || broken || state.pending) return;
    running = true;
    try {
      const webhook = await PluginAPI.getSecret(SECRET);
      if (
        !webhook ||
        !validWebhook(webhook) ||
        (await hash(webhook)) !== state.webhookHash
      )
        throw new Error('Webhook 未配置或与本机映射不匹配。');
      const tasks = await getSelected();
      for (const task of tasks) {
        if (unloaded || !state.enabled) break;
        const values = valuesFor(task);
        const fingerprint = await hash(JSON.stringify(values));
        let record = state.records.find((r) => r.taskId === task.id);
        if (record && record.fingerprint === fingerprint) continue;
        if (!record) {
          // A durable intent is written BEFORE sending. Any ambiguous result blocks
          // further creates until the user reconciles it against the sheet.
          state.pending = { taskId: task.id };
          save();
          const result = await post(webhook, { add_records: [{ values }] });
          const recordId = result.add_records?.[0]?.record_id;
          if (typeof recordId !== 'string' || !recordId)
            throw new Error('新增结果未包含记录 ID，需要人工核对。');
          record = {
            taskId: task.id,
            recordId,
            fingerprint,
            hadDate: !!values[FIELDS.date],
            dateStale: false,
          };
          state.records.push(record);
          state.pending = null;
          save();
        } else {
          const result = await post(webhook, {
            update_records: [{ record_id: record.recordId, values }],
          });
          if (
            !result.update_records?.some((item) => item.record_id === record.recordId)
          ) {
            throw new Error('更新响应未确认目标记录。');
          }
          record.fingerprint = fingerprint;
          record.dateStale = !!record.hadDate && !values[FIELDS.date];
          if (values[FIELDS.date]) record.hadDate = true;
          save();
        }
      }
      lastError = '';
    } catch {
      lastError = state.pending
        ? '新增结果不确定：请先在企微按任务ID核对，并在插件设置中处理。'
        : '同步失败，请检查网络、Webhook、字段和项目配置。';
      PluginAPI.showSnack({ msg: lastError, type: 'ERROR' });
    } finally {
      running = false;
      if (rescan) {
        rescan = false;
        schedule();
      }
    }
  };
  const schedule = (delay = 3000) => {
    if (unloaded || !state.enabled) return;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void sync();
    }, delay);
  };
  PluginAPI.registerHook(PluginAPI.Hooks.DATA_CHANGED, () => schedule());
  PluginAPI.registerConfigHandler(() => PluginAPI.showIndexHtmlAsView());
  PluginAPI.onMessage(async (message) => {
    if (!message || message.type !== 'wecom-export')
      throw new Error('Unsupported message');
    if (message.action === 'info') {
      const projects = await PluginAPI.getAllProjects();
      return {
        projects: projects.map(({ id, title }) => ({ id, title })),
        selected: state.projects,
        priorityFieldId: state.priorityFieldId || '',
        configured: !!state.webhookHash,
        enabled: state.enabled,
        pending: state.pending,
        mapped: state.records.length,
        staleDates: state.records.filter((r) => r.dateStale).map((r) => r.taskId),
        broken,
        running,
        error: lastError,
      };
    }
    if (broken) throw new Error('本机映射损坏，已停止同步，请恢复本机数据。');
    if (message.action === 'save') {
      if (running) throw new Error('同步进行中，请稍后修改配置。');
      const { webhook, itsm, interop, priorityFieldId = '' } = message.payload || {};
      if (
        typeof priorityFieldId !== 'string' ||
        (priorityFieldId &&
          (!/^f[a-zA-Z0-9]+$/.test(priorityFieldId) ||
            Object.values(FIELDS).includes(priorityFieldId)))
      )
        throw new Error('优先级字段 ID 无效或与其他字段重复。');
      const projects = await PluginAPI.getAllProjects();
      if (
        !itsm ||
        !interop ||
        itsm === interop ||
        !projects.some((p) => p.id === itsm) ||
        !projects.some((p) => p.id === interop)
      )
        throw new Error('请选择两个不同的项目。');
      let webhookHash = state.webhookHash;
      if (webhook) {
        if (!validWebhook(webhook))
          throw new Error('请输入智能表格的 HTTPS Webhook 地址。');
        webhookHash = await hash(webhook);
        if (
          state.webhookHash &&
          state.webhookHash !== webhookHash &&
          (state.records.length || state.pending)
        )
          throw new Error('已有记录映射，不能直接更换 Webhook；请先备份并人工迁移映射。');
        await PluginAPI.setSecret(SECRET, webhook);
      }
      if (!webhookHash || !(await PluginAPI.getSecret(SECRET)))
        throw new Error('请填写 Webhook。');
      state.projects = { ITSM: itsm, 互联互通: interop };
      state.priorityFieldId = priorityFieldId;
      state.webhookHash = webhookHash;
      state.enabled = false;
      save();
      return { ok: true };
    }
    if (message.action === 'preview') {
      if (!state.webhookHash) throw new Error('请先保存配置。');
      const tasks = await getSelected();
      return {
        count: tasks.length,
        newCount: tasks.filter((t) => !state.records.some((r) => r.taskId === t.id))
          .length,
      };
    }
    if (message.action === 'start') {
      if (state.pending) throw new Error('请先处理待核对的新增记录。');
      await getSelected();
      if (!state.webhookHash || !(await PluginAPI.getSecret(SECRET)))
        throw new Error('请先保存配置。');
      state.enabled = true;
      save();
      schedule(0);
      return { ok: true };
    }
    if (message.action === 'stop') {
      state.enabled = false;
      clearTimeout(timer);
      timer = null;
      save();
      return { ok: true };
    }
    if (message.action === 'ack-dates') {
      if (running) throw new Error('同步进行中，请稍后确认。');
      const ids = message.payload?.taskIds;
      if (!Array.isArray(ids)) throw new Error('请选择已核对的任务。');
      for (const record of state.records) {
        if (record.dateStale && ids.includes(record.taskId)) {
          record.dateStale = false;
          record.hadDate = false;
        }
      }
      save();
      return { ok: true };
    }
    if (message.action === 'resolve') {
      if (running || !state.pending || message.payload?.taskId !== state.pending.taskId)
        throw new Error('当前没有对应的待核对记录。');
      const recordId = String(message.payload.recordId || '').trim();
      if (recordId)
        state.records.push({
          taskId: state.pending.taskId,
          recordId,
          fingerprint: null,
          hadDate: true,
        });
      // Empty ID means the user explicitly confirmed no row exists.
      state.pending = null;
      save();
      schedule(0);
      return { ok: true };
    }
    throw new Error('Unsupported message');
  });
  let retryTimer;
  PluginAPI.onReady(() => {
    if (state.enabled) schedule(30000);
    retryTimer = setInterval(() => schedule(0), 60000);
  });
  PluginAPI.onUnload(() => {
    unloaded = true;
    clearTimeout(timer);
    clearInterval(retryTimer);
  });
})();
