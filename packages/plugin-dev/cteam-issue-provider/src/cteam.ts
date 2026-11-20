import type {
  IssueProviderPluginDefinition,
  PluginHttp,
  PluginIssue,
  PluginSearchResult,
} from '@super-productivity/plugin-api';

export const CTEAM_ORIGIN = 'https://devops.cwoa.net';
const ISSUE_API = '/api/open/CTeam/api/service_open/issue/2.1.0';
const CTEAM_CLASSIFIES = ['BUG', 'DEMAND', 'TASK'] as const;
type CTeamClassify = (typeof CTEAM_CLASSIFIES)[number];

interface WorkItemType {
  classify: CTeamClassify;
  modelTypeId: string;
}

export interface CTeamAuth {
  userId: string;
  token: string;
  tenantId?: string;
}

interface CTeamConfig {
  projectKey: string;
  primaryType: WorkItemType;
  workItemTypes: WorkItemType[];
  assigneeField: string;
  excludedStates: string[];
}

interface SearchField {
  id: string;
  name: string;
  label?: string;
}

interface StateOption {
  label: string;
  value: string;
}

const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const required = (value: unknown): string => {
  const result = text(value).trim();
  if (!result) throw new Error('CTeam configuration or response is incomplete.');
  return result;
};

const parseClassify = (value: unknown): CTeamClassify => {
  const classify = text(value).trim().toUpperCase();
  if (CTEAM_CLASSIFIES.includes(classify as CTeamClassify)) {
    return classify as CTeamClassify;
  }
  throw new Error('Classification must be BUG, DEMAND, or TASK.');
};

export const parseAdditionalWorkItemTypes = (value: unknown): WorkItemType[] => {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') {
    throw new Error(
      'Enter additional work-item types as CLASSIFY:MODEL_TYPE_ID, one per line.',
    );
  }

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 100) {
    throw new Error('Add no more than 100 CTeam work-item type filters.');
  }

  const seen = new Set<string>();
  return lines.map((line) => {
    const separator = line.indexOf(':');
    if (separator < 1 || separator === line.length - 1) {
      throw new Error('Each additional work-item type must be CLASSIFY:MODEL_TYPE_ID.');
    }
    const classify = parseClassify(line.slice(0, separator));
    const modelTypeId = line.slice(separator + 1).trim();
    if (!modelTypeId || /\s/.test(modelTypeId)) {
      throw new Error('Model type IDs must be nonempty and contain no spaces.');
    }
    const key = JSON.stringify([classify, modelTypeId]);
    if (seen.has(key)) {
      throw new Error('Remove duplicate CTeam work-item type filters.');
    }
    seen.add(key);
    return { classify, modelTypeId };
  });
};

export const unwrap = (value: unknown): unknown => {
  const envelope = object(value);
  const status = envelope.status ?? envelope.code;
  // Matches CWLink's observed DevOps envelope; do not expose response bodies.
  if (status !== undefined && status !== 0 && status !== '0') {
    throw new Error(
      'CTeam returned an API error. Check local credentials and permissions.',
    );
  }
  return 'data' in envelope ? envelope.data : value;
};

export const parseAuth = (raw: string | null): CTeamAuth => {
  try {
    const auth = object(JSON.parse(raw ?? 'null'));
    return {
      userId: required(auth.userId),
      token: required(auth.token),
      tenantId: text(auth.tenantId).trim(),
    };
  } catch {
    throw new Error('Open CTeam plugin settings and save credentials on this device.');
  }
};

const sameType = (left: WorkItemType, right: WorkItemType): boolean =>
  left.classify === right.classify && left.modelTypeId === right.modelTypeId;

const stateScopeKey = (type: WorkItemType, stateId: string): string =>
  JSON.stringify([type.classify, type.modelTypeId, stateId]);

const configOf = (value: Record<string, unknown>): CTeamConfig => {
  const primaryType = {
    classify: parseClassify(value.classify),
    modelTypeId: required(value.modelTypeId),
  };
  const additionalTypes = parseAdditionalWorkItemTypes(value.additionalWorkItemTypes);
  if (additionalTypes.some((type) => sameType(type, primaryType))) {
    throw new Error(
      'The additional type list already contains the primary work-item type.',
    );
  }
  const excluded = value.excludedStates ?? [];
  if (!Array.isArray(excluded) || !excluded.every((id) => typeof id === 'string')) {
    throw new Error('Select the CTeam states to exclude.');
  }
  return {
    projectKey: required(value.projectKey),
    primaryType,
    workItemTypes: [primaryType, ...additionalTypes],
    // Dynamic options must be loadable before the user can select the field.
    // Enforce this only when testing or running the configured provider.
    assigneeField: text(value.assigneeField).trim(),
    excludedStates: excluded,
  };
};

const issueKey = (project: string, id: string): string =>
  encodeURIComponent(project) + '/' + encodeURIComponent(id);

const parseKey = (key: string): [string, string] => {
  const parts = key.split('/');
  if (parts.length !== 2) throw new Error('Invalid CTeam work-item identity.');
  return [required(decodeURIComponent(parts[0])), required(decodeURIComponent(parts[1]))];
};

const issueLink = (project: string, id: string, classify: string): string => {
  const page =
    classify === 'DEMAND' ? 'twDemand' : classify === 'TASK' ? 'twTask' : 'twBug';
  const url = new URL(
    '/devops/console/vteam/' + encodeURIComponent(project) + '/' + page,
    CTEAM_ORIGIN,
  );
  url.searchParams.set('vmode', 'table');
  url.searchParams.set('id', id);
  return url.toString();
};

const propertyValue = (property: Record<string, unknown>, name: string): unknown =>
  object(property[name]).value;

const mapIssue = (
  value: unknown,
  projectKey: string,
  fallbackClassify: CTeamClassify,
): PluginIssue => {
  const property = object(object(value).property);
  const id = required(propertyValue(property, 'id'));
  const project = text(propertyValue(property, 'projectId')) || projectKey;
  const title = required(propertyValue(property, 'title'));
  const state = object(property.state);
  const modelTypeId = text(propertyValue(property, 'modelTypeId'));
  const classifyValue = text(propertyValue(property, 'typeClassify'));
  const classify = classifyValue ? parseClassify(classifyValue) : fallbackClassify;
  const rawTime = propertyValue(property, 'updateTime');
  const timestamp = typeof rawTime === 'number' ? rawTime : Date.parse(text(rawTime));
  return {
    id: issueKey(project, id),
    title,
    number: text(propertyValue(property, 'number')),
    state: text(state.displayValue) || text(state.value),
    stateId: text(state.value),
    classify,
    modelTypeId,
    url: issueLink(project, id, classify),
    ...(Number.isFinite(timestamp) ? { lastUpdated: timestamp } : {}),
  };
};

const isAssignedTo = (value: unknown, userId: string): boolean =>
  Array.isArray(value)
    ? value.some((item) => isAssignedTo(item, userId))
    : typeof value === 'object' && value !== null
      ? text(object(value).id ?? object(value).value) === userId
      : text(value)
          .split(',')
          .some((candidate) => candidate.trim() === userId);

const isAssigneeField = (field: SearchField): boolean =>
  field.label === '经办人' || field.name === '经办人';

export const createCTeamProvider = (
  getAuth: () => Promise<CTeamAuth>,
  t: (key: string) => string = (key) => key,
): IssueProviderPluginDefinition => {
  const url = async (
    pathname: string,
    params: Record<string, string> = {},
  ): Promise<string> => {
    const target = new URL(pathname, CTEAM_ORIGIN);
    target.search = new URLSearchParams({
      ...params,
      userId: (await getAuth()).userId,
    }).toString();
    return target.toString();
  };

  const getFields = async (
    project: string,
    classify: CTeamClassify,
    http: PluginHttp,
  ): Promise<SearchField[]> => {
    const response = unwrap(
      await http.get(
        await url(
          '/api/open/CTeam/api/user/issue_field/' +
            encodeURIComponent(project) +
            '/query_filters',
          { classify },
        ),
      ),
    );
    if (!Array.isArray(response)) throw new Error('CTeam search fields are unavailable.');
    return response.map((field) => {
      const raw = object(field);
      return { id: required(raw.id), name: required(raw.name), label: text(raw.label) };
    });
  };

  const stateOptionsForClassify = async (
    project: string,
    classify: CTeamClassify,
    http: PluginHttp,
  ): Promise<StateOption[]> => {
    const fields = await getFields(project, classify, http);
    const state = fields.find(
      (field) => field.name === 'state' || field.label === '状态',
    );
    if (!state) throw new Error('CTeam state field is unavailable.');
    const endpoint =
      '/api/open/CTeam/api/service_open/issue_field_value/2.1.0/' +
      encodeURIComponent(project) +
      '/option/' +
      encodeURIComponent(state.id);
    const result = unwrap(
      await http.get(
        await url(endpoint, {
          classify,
          all: 'true',
        }),
      ),
    );
    if (!Array.isArray(result)) throw new Error('CTeam state options are unavailable.');
    const flatten = (items: unknown[]): StateOption[] =>
      items.flatMap((item) => {
        const option = object(item);
        return [
          ...(option.delete === true
            ? []
            : [
                {
                  value: required(option.value ?? option.id),
                  label: text(option.displayValue) || required(option.value ?? option.id),
                },
              ]),
          ...(Array.isArray(option.children) ? flatten(option.children) : []),
        ];
      });
    return flatten(result);
  };

  const stateOptions = async (
    config: Record<string, unknown>,
    http: PluginHttp,
  ): Promise<StateOption[]> => {
    const cfg = configOf(config);
    const byClassify = new Map<CTeamClassify, StateOption[]>();
    const options: StateOption[] = [];
    const seen = new Set<string>();

    for (const type of cfg.workItemTypes) {
      let states = byClassify.get(type.classify);
      if (!states) {
        states = await stateOptionsForClassify(cfg.projectKey, type.classify, http);
        byClassify.set(type.classify, states);
      }
      for (const state of states) {
        const value = sameType(type, cfg.primaryType)
          ? state.value
          : stateScopeKey(type, state.value);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
          value,
          label: type.classify + ' / ' + type.modelTypeId + ' — ' + state.label,
        });
      }
    }
    return options;
  };

  const validateExcludedStates = async (
    cfg: CTeamConfig,
    http: PluginHttp,
  ): Promise<void> => {
    const byClassify = new Map<CTeamClassify, StateOption[]>();
    for (const selected of cfg.excludedStates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(selected);
      } catch {
        parsed = undefined;
      }
      const tuple = Array.isArray(parsed) ? parsed : [];
      const hasScopedType =
        tuple.length === 3 &&
        CTEAM_CLASSIFIES.includes(tuple[0] as CTeamClassify) &&
        typeof tuple[1] === 'string' &&
        typeof tuple[2] === 'string';
      if (tuple.length === 3 && !hasScopedType) {
        throw new Error(
          'CTeam state options changed. Review excluded states before importing.',
        );
      }
      const selectedType = hasScopedType
        ? { classify: tuple[0] as CTeamClassify, modelTypeId: tuple[1] as string }
        : cfg.primaryType;
      const stateId = hasScopedType ? text(tuple[2]) : selected;
      if (!cfg.workItemTypes.some((type) => sameType(type, selectedType)) || !stateId) {
        throw new Error(
          'CTeam state options changed. Review excluded states before importing.',
        );
      }
      let options = byClassify.get(selectedType.classify);
      if (!options) {
        options = await stateOptionsForClassify(
          cfg.projectKey,
          selectedType.classify,
          http,
        );
        byClassify.set(selectedType.classify, options);
      }
      if (!options.some((option) => option.value === stateId)) {
        throw new Error(
          'CTeam state options changed. Review excluded states before importing.',
        );
      }
    }
  };

  const resolveAssigneeField = (
    fields: SearchField[],
    configuredId?: string,
  ): SearchField => {
    const candidates = fields.filter(isAssigneeField);
    if (configuredId) {
      const selected = candidates.find((field) => field.id === configuredId);
      if (!selected) {
        throw new Error(
          'Select the current project’s dynamic 经办人 search field before importing.',
        );
      }
      return selected;
    }
    if (candidates.length !== 1) {
      throw new Error(
        'CTeam must expose exactly one dynamic 经办人 search field for each classification.',
      );
    }
    return candidates[0];
  };

  const isExcluded = (type: WorkItemType, stateId: string, cfg: CTeamConfig): boolean => {
    if (sameType(type, cfg.primaryType) && cfg.excludedStates.includes(stateId)) {
      return true;
    }
    return cfg.excludedStates.includes(stateScopeKey(type, stateId));
  };

  const search = async (
    config: Record<string, unknown>,
    http: PluginHttp,
  ): Promise<PluginSearchResult[]> => {
    const cfg = configOf(config);
    if (!cfg.assigneeField) {
      throw new Error('Select the current project’s dynamic 经办人 search field.');
    }
    const auth = await getAuth();
    const typesByClassify = new Map<CTeamClassify, WorkItemType[]>();
    for (const type of cfg.workItemTypes) {
      const types = typesByClassify.get(type.classify) ?? [];
      types.push(type);
      typesByClassify.set(type.classify, types);
    }

    if (cfg.excludedStates.length) {
      await validateExcludedStates(cfg, http);
    }

    const result = new Map<string, PluginSearchResult>();
    for (const [classify, types] of typesByClassify) {
      const fields = await getFields(cfg.projectKey, classify, http);
      const assignee = resolveAssigneeField(
        fields,
        classify === cfg.primaryType.classify ? cfg.assigneeField : undefined,
      );
      const typeIds = types.map((type) => type.modelTypeId);
      const filters = [
        { name: 'projectId', value: [cfg.projectKey] },
        { name: 'typeClassify', value: [classify] },
        { name: 'modelTypeId', value: typeIds },
        { name: assignee.name, value: [auth.userId] },
      ];
      let pages: number | undefined;
      for (let page = 0; pages === undefined || page < pages; page++) {
        const response = object(
          unwrap(
            await http.post(
              await url(ISSUE_API + '/flat', {
                num: String(page),
                size: '100',
              }),
              filters,
            ),
          ),
        );
        const totalPages = response.totalPages;
        if (
          typeof totalPages !== 'number' ||
          !Number.isInteger(totalPages) ||
          totalPages < 0 ||
          !Array.isArray(response.content) ||
          (pages !== undefined && pages !== totalPages)
        ) {
          throw new Error(
            'CTeam returned an incomplete or changing page set. Retry the full scan.',
          );
        }
        pages = totalPages;
        for (const raw of response.content) {
          const property = object(object(raw).property);
          const field =
            property[assignee.name] ??
            Object.values(property).find(
              (candidate) => object(candidate).id === assignee.id,
            );
          const issue = mapIssue(raw, cfg.projectKey, classify);
          const actualClassify = text(propertyValue(property, 'typeClassify'));
          if (
            parseKey(issue.id)[0] !== cfg.projectKey ||
            actualClassify !== classify ||
            !types.some((type) => type.modelTypeId === issue.modelTypeId) ||
            !isAssignedTo(object(field).value, auth.userId)
          ) {
            throw new Error(
              'CTeam did not confirm exact current-user/project/type filtering. Import stopped.',
            );
          }
          const matchedType = types.find(
            (type) => type.modelTypeId === issue.modelTypeId,
          );
          if (!matchedType) {
            // The model ID is checked above; retain an explicit guard before
            // constructing a per-type state exclusion key.
            throw new Error(
              'CTeam returned a work item outside the configured type scope.',
            );
          }
          const stateId = text(issue.stateId);
          const hasExclusionForType = cfg.excludedStates.some(
            (value) =>
              (sameType(matchedType, cfg.primaryType) && value === stateId) ||
              value === stateScopeKey(matchedType, stateId),
          );
          if (hasExclusionForType && !stateId) {
            throw new Error('CTeam work-item state is unknown. Import stopped.');
          }
          const excludedForType = !!stateId && isExcluded(matchedType, stateId, cfg);
          if (!excludedForType) {
            result.set(issue.id, { ...issue, status: issue.state });
          }
        }
      }
    }
    return [...result.values()];
  };

  return {
    configFields: [
      {
        key: 'projectKey',
        type: 'input',
        label: t('CFG.PROJECT'),
        required: true,
        description: t('CFG.PROJECT_HELP'),
      },
      {
        key: 'classify',
        type: 'select',
        label: t('CFG.CLASSIFY'),
        required: true,
        options: [
          { label: 'Bug / ITR', value: 'BUG' },
          { label: 'Demand', value: 'DEMAND' },
          { label: 'Task', value: 'TASK' },
        ],
      },
      { key: 'modelTypeId', type: 'input', label: t('CFG.MODEL_TYPE'), required: true },
      {
        key: 'additionalWorkItemTypes',
        type: 'textarea',
        label: t('CFG.ADDITIONAL_TYPES'),
        description: t('CFG.ADDITIONAL_TYPES_HELP'),
      },
      {
        key: 'assigneeField',
        type: 'select',
        label: t('CFG.ASSIGNEE'),
        required: true,
        loadOptions: async (config, http) =>
          (
            await getFields(
              required(config.projectKey),
              parseClassify(config.classify),
              http,
            )
          )
            .filter(isAssigneeField)
            .map((field) => ({ label: field.label || field.name, value: field.id })),
      },
      {
        key: 'excludedStates',
        type: 'multiSelect',
        label: t('CFG.EXCLUDED_STATES'),
        description: t('CFG.EXCLUDED_HELP'),
        loadOptions: stateOptions,
      },
    ],
    async getHeaders() {
      const auth = await getAuth();
      return {
        'X-DEVOPS-UID': auth.userId,
        'X-DEVOPS-ACCESS-TOKEN': auth.token,
        ...(auth.tenantId ? { 'X-DEVOPS-TENANT-ID': auth.tenantId } : {}),
      };
    },
    async searchIssues(term, config, http) {
      const issues = await search(config, http);
      const query = term.trim().toLowerCase();
      return issues.filter(
        (issue) =>
          !query ||
          (issue.title + ' ' + text(issue.number)).toLowerCase().includes(query),
      );
    },
    getNewIssuesForBacklog: search,
    async getById(id, config, http) {
      const cfg = configOf(config);
      const [project, issueId] = parseKey(id);
      if (project !== cfg.projectKey) {
        throw new Error('CTeam work item belongs to a different configured project.');
      }
      const response = unwrap(
        await http.get(
          await url(
            ISSUE_API +
              '/' +
              encodeURIComponent(project) +
              '/' +
              encodeURIComponent(issueId),
          ),
        ),
      );
      const issue = mapIssue(response, project, cfg.primaryType.classify);
      if (
        issue.id !== id ||
        !cfg.workItemTypes.some(
          (type) =>
            type.classify === issue.classify && type.modelTypeId === issue.modelTypeId,
        )
      ) {
        throw new Error('CTeam returned a work item outside the configured type scope.');
      }
      return issue;
    },
    getIssueLink(id, config) {
      const cfg = configOf(config);
      if (cfg.workItemTypes.length > 1) return '';
      const [project, issueId] = parseKey(id);
      return issueLink(project, issueId, cfg.primaryType.classify);
    },
    async testConnection(config, http) {
      const cfg = configOf(config);
      if (!cfg.assigneeField) {
        throw new Error('Select the current project’s dynamic 经办人 search field.');
      }
      const classifies = [...new Set(cfg.workItemTypes.map((type) => type.classify))];
      for (const classify of classifies) {
        const fields = await getFields(cfg.projectKey, classify, http);
        resolveAssigneeField(
          fields,
          classify === cfg.primaryType.classify ? cfg.assigneeField : undefined,
        );
      }
      return true;
    },
    issueDisplay: [
      { field: 'number', label: t('ISSUE.NUMBER'), type: 'text' },
      { field: 'title', label: t('ISSUE.TITLE'), type: 'text' },
      { field: 'state', label: t('ISSUE.STATE'), type: 'text' },
      { field: 'url', label: t('ISSUE.LINK'), type: 'link', linkField: 'url' },
    ],
    // No done-state or write-back semantics. Personal completion stays local.
    doneStates: [],
    // The host removes base title pulls for mapped fields. Default off protects
    // personal titles without adding provider-specific logic to shared reducers.
    fieldMappings: [
      {
        taskField: 'title',
        issueField: 'title',
        defaultDirection: 'off',
        toIssueValue: (value) => value,
        toTaskValue: (value) => text(value),
      },
    ],
    extractSyncValues: (issue) => ({ title: issue.title }),
  };
};
