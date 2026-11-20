import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_PI_PROJECT_CONFIG,
  PiAgentError,
  PiAnalysisRequest,
  PiAnalysisRun,
  PiProjectConfig,
  PiTaskAnalysis,
} from './shared-with-frontend/pi-agent.model';
import { buildPiSessionResumeCommand } from './pi-session-command';
import { PiAgentFailure, runPiRpc } from './pi-rpc-runner';

const fileKey = (id: string): string => createHash('sha256').update(id).digest('hex');

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const requiredString = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PiAgentFailure('INVALID_REQUEST');
  }
  return value;
};

export const parsePiConfig = (value: unknown): PiProjectConfig => {
  const cfg = record(value);
  if (
    typeof cfg.enabled !== 'boolean' ||
    (cfg.notifyOnImport !== undefined && typeof cfg.notifyOnImport !== 'boolean') ||
    typeof cfg.workingDirectory !== 'string' ||
    typeof cfg.executable !== 'string' ||
    typeof cfg.model !== 'string' ||
    typeof cfg.prompt !== 'string'
  )
    throw new PiAgentFailure('INVALID_REQUEST');
  return {
    enabled: cfg.enabled,
    notifyOnImport: cfg.notifyOnImport === true,
    workingDirectory: cfg.workingDirectory.trim(),
    executable: requiredString(cfg.executable).trim(),
    model: cfg.model.trim(),
    prompt: requiredString(cfg.prompt),
  };
};

export const parsePiRequest = (value: unknown): PiAnalysisRequest => {
  const input = record(value);
  const issueUrl = requiredString(input.issueUrl);
  let url: URL;
  try {
    url = new URL(issueUrl);
  } catch {
    throw new PiAgentFailure('INVALID_REQUEST');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    typeof input.instruction !== 'string' ||
    typeof input.newSession !== 'boolean'
  ) {
    throw new PiAgentFailure('INVALID_REQUEST');
  }
  return {
    taskId: requiredString(input.taskId),
    projectId: requiredString(input.projectId),
    issueUrl,
    instruction: input.instruction,
    newSession: input.newSession,
  };
};

export const buildPiPrompt = (template: string, request: PiAnalysisRequest): string => {
  const values = { issueUrl: request.issueUrl, taskId: request.taskId };
  const prompt = template.replace(
    /{{\s*(issueUrl|taskId)\s*}}/g,
    (_match, key: keyof typeof values) => values[key],
  );
  // The work item is still supplied when a user's custom prompt has no variable.
  return [
    prompt,
    ...(!/{{\s*issueUrl\s*}}/.test(template)
      ? ['CTeam work item: ' + request.issueUrl]
      : []),
    ...(request.instruction.trim() ? [request.instruction] : []),
  ].join('\n\n');
};

interface ActiveRun {
  projectId: string;
  controller: AbortController;
  finished: Promise<void>;
  finish: () => void;
}

/** Device-local settings/reports only. Never writes Task, Project or Git state. */
export class PiAgentManager {
  private readonly _active = new Map<string, ActiveRun>();
  private readonly _tasks = new Map<string, Promise<PiTaskAnalysis>>();
  private _writes = Promise.resolve();

  constructor(
    private readonly _directory: string,
    private readonly _onUpdate: (state: PiTaskAnalysis) => void = () => undefined,
  ) {}

  get isRunning(): boolean {
    return this._active.size > 0;
  }

  async getConfig(projectId: string): Promise<PiProjectConfig> {
    requiredString(projectId);
    const saved = await this._read('projects', projectId);
    return saved === null
      ? { ...DEFAULT_PI_PROJECT_CONFIG }
      : parsePiConfig({ ...DEFAULT_PI_PROJECT_CONFIG, ...record(saved) });
  }

  async saveConfig(projectId: string, value: unknown): Promise<PiProjectConfig> {
    requiredString(projectId);
    const config = parsePiConfig(value);
    if (config.enabled) await this._checkDirectory(config.workingDirectory);
    await this._write('projects', projectId, config);
    if (!config.enabled) {
      await Promise.all(
        [...this._active.entries()]
          .filter(([, run]) => run.projectId === projectId)
          .map(([taskId]) => this.stop(taskId)),
      );
    }
    return config;
  }

  async getTask(taskId: string): Promise<PiTaskAnalysis> {
    requiredString(taskId);
    if (!this._tasks.has(taskId)) {
      const loaded = this._loadTask(taskId);
      this._tasks.set(taskId, loaded);
      loaded.catch(() => this._tasks.delete(taskId));
    }
    return structuredClone(await this._tasks.get(taskId)!);
  }

  async getResumeCommand(taskId: string, runId: string): Promise<string> {
    requiredString(taskId);
    requiredString(runId);
    if (this._active.has(taskId)) throw new PiAgentFailure('ALREADY_RUNNING');
    const state = await this.getTask(taskId);
    const run = state.runs.find((entry) => entry.id === runId);
    if (!run || !run.sessionId || run.status === 'RUNNING') {
      throw new PiAgentFailure('INVALID_REQUEST');
    }
    const config = await this.getConfig(run.projectId);
    await this._checkDirectory(run.workingDirectory);
    return buildPiSessionResumeCommand({
      executable: config.executable,
      workingDirectory: run.workingDirectory,
      sessionDirectory: this._sessionDirectory(run),
      sessionId: run.sessionId,
    });
  }

  async start(value: unknown): Promise<PiTaskAnalysis> {
    const request = parsePiRequest(value);
    if (this._active.has(request.taskId)) {
      throw new PiAgentFailure('ALREADY_RUNNING');
    }
    // Reserve the Task before any await, not the Project. Different Tasks can
    // launch concurrently even when their configured cwd is identical.
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const active: ActiveRun = {
      projectId: request.projectId,
      controller: new AbortController(),
      finished,
      finish,
    };
    this._active.set(request.taskId, active);
    try {
      const config = await this.getConfig(request.projectId);
      if (!config.enabled) throw new PiAgentFailure('CONFIG_REQUIRED');
      await this._checkDirectory(config.workingDirectory);
      const state = await this.getTask(request.taskId);
      const previous = state.runs[0];
      const continued =
        !request.newSession &&
        previous?.projectId === request.projectId &&
        previous.workingDirectory === config.workingDirectory &&
        previous.sessionId
          ? previous
          : undefined;
      const run: PiAnalysisRun = {
        id: randomUUID(),
        taskId: request.taskId,
        projectId: request.projectId,
        workingDirectory: config.workingDirectory,
        sessionId: continued?.sessionId ?? 'sp-' + randomUUID(),
        sessionStorage: continued ? continued.sessionStorage : 'pi-default',
        status: 'RUNNING',
        startedAt: Date.now(),
        issueUrl: request.issueUrl,
        prompt: buildPiPrompt(config.prompt, request),
        markdown: '',
      };
      const sessionDirectory = this._sessionDirectory(run);
      if (sessionDirectory) await fs.mkdir(sessionDirectory, { recursive: true });
      state.runs = [run, ...state.runs].slice(0, 10);
      await this._saveTask(state);
      this._tasks.set(request.taskId, Promise.resolve(state));
      void this._execute(state, run, config, sessionDirectory, !!continued, active).then(
        active.finish,
        active.finish,
      );
      return structuredClone(state);
    } catch (error) {
      this._active.delete(request.taskId);
      active.finish();
      throw error;
    }
  }

  async stop(taskId: string): Promise<PiTaskAnalysis> {
    requiredString(taskId);
    const active = this._active.get(taskId);
    if (active) {
      active.controller.abort();
      await active.finished;
    }
    return this.getTask(taskId);
  }

  async stopAll(): Promise<void> {
    const runs = [...this._active.values()];
    runs.forEach((run) => run.controller.abort());
    await Promise.allSettled(runs.map((run) => run.finished));
  }

  private async _execute(
    state: PiTaskAnalysis,
    run: PiAnalysisRun,
    config: PiProjectConfig,
    sessionDirectory: string | undefined,
    resumeSession: boolean,
    active: ActiveRun,
  ): Promise<void> {
    const resultRun: PiAnalysisRun = { ...run };
    try {
      const result = await runPiRpc({
        config,
        sessionDirectory,
        sessionId: run.sessionId,
        resumeSession,
        prompt: run.prompt,
        signal: active.controller.signal,
      });
      resultRun.markdown = result.markdown;
      resultRun.error = result.error;
      resultRun.status = result.cancelled
        ? 'CANCELLED'
        : result.error
          ? 'FAILED'
          : 'COMPLETED';
    } catch (error) {
      resultRun.status = active.controller.signal.aborted ? 'CANCELLED' : 'FAILED';
      resultRun.error = error instanceof PiAgentFailure ? error.code : 'RUNTIME_ERROR';
    }
    resultRun.finishedAt = Date.now();
    const completed = {
      ...state,
      runs: state.runs.map((entry) => (entry.id === run.id ? resultRun : entry)),
    };
    try {
      await this._write('tasks', run.taskId, completed);
    } catch {
      resultRun.status = 'FAILED';
      resultRun.error = 'STORAGE_ERROR';
    }
    // Publish completion only after persistence and lock release. A new
    // analysis may start immediately when the UI observes this state.
    this._tasks.set(run.taskId, Promise.resolve(completed));
    this._active.delete(run.taskId);
    this._onUpdate(structuredClone(completed));
  }

  private async _loadTask(taskId: string): Promise<PiTaskAnalysis> {
    const saved = await this._read('tasks', taskId);
    if (saved === null) return { taskId, runs: [] };
    const data = record(saved);
    if (data.taskId !== taskId || !Array.isArray(data.runs)) {
      throw new PiAgentFailure('STORAGE_ERROR');
    }
    const state = data as unknown as PiTaskAnalysis;
    let changed = false;
    for (const run of state.runs) {
      if (run.status === 'RUNNING') {
        run.status = 'INTERRUPTED';
        run.finishedAt = Date.now();
        changed = true;
      }
    }
    if (changed) await this._saveTask(state);
    return state;
  }

  private _sessionDirectory(run: PiAnalysisRun): string | undefined {
    // Older runs have no storage marker and continue to use their original files.
    return run.sessionStorage === 'pi-default'
      ? undefined
      : path.join(this._directory, 'sessions');
  }

  private async _checkDirectory(directory: string): Promise<void> {
    if (!directory || !path.isAbsolute(directory)) {
      throw new PiAgentFailure('DIRECTORY_UNAVAILABLE');
    }
    try {
      if (!(await fs.stat(directory)).isDirectory()) {
        throw new PiAgentFailure('DIRECTORY_UNAVAILABLE');
      }
    } catch {
      throw new PiAgentFailure('DIRECTORY_UNAVAILABLE');
    }
  }

  private async _read(kind: string, id: string): Promise<unknown> {
    try {
      return JSON.parse(
        await fs.readFile(
          path.join(this._directory, kind, fileKey(id) + '.json'),
          'utf8',
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new PiAgentFailure('STORAGE_ERROR');
    }
  }

  private _write(kind: string, id: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    const save = async (): Promise<void> => {
      const directory = path.join(this._directory, kind);
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, fileKey(id) + '.json');
      const temporary = file + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, json, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, file);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    };
    const pending = this._writes.then(save, save);
    this._writes = pending.catch(() => undefined);
    return pending.catch(() => {
      throw new PiAgentFailure('STORAGE_ERROR');
    });
  }

  private async _saveTask(state: PiTaskAnalysis): Promise<void> {
    await this._write('tasks', state.taskId, state);
    this._onUpdate(structuredClone(state));
  }
}

export const piFailureCode = (error: unknown): PiAgentError =>
  error instanceof PiAgentFailure ? error.code : 'STORAGE_ERROR';
