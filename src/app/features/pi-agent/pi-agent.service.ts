import { DestroyRef, inject, Injectable, InjectionToken, signal } from '@angular/core';
import { PiAgentBridgeService } from '../../core/electron/pi-agent-bridge.service';
import {
  PiAgentElectronApi,
  PiAgentError,
  PiAgentReply,
  PiAnalysisRequest,
  PiProjectConfig,
  PiTaskAnalysis,
} from '../../../../electron/shared-with-frontend/pi-agent.model';
import { T } from '../../t.const';

export const PI_AGENT_API = new InjectionToken<PiAgentElectronApi | null>(
  'PI_AGENT_API',
  {
    providedIn: 'root',
    factory: () => inject(PiAgentBridgeService).getApi(),
  },
);

export class PiAgentClientError extends Error {
  constructor(readonly code: PiAgentError) {
    super(code);
  }
}

export const piAgentErrorKey = (error: unknown): string =>
  T.F.PI_AGENT.ERRORS[error instanceof PiAgentClientError ? error.code : 'RUNTIME_ERROR'];

@Injectable({ providedIn: 'root' })
export class PiAgentService {
  private readonly _api = inject(PI_AGENT_API);
  private readonly _destroyRef = inject(DestroyRef);
  private _listening = false;
  private readonly _tasks = signal<Record<string, PiTaskAnalysis>>({});
  readonly tasks = this._tasks.asReadonly();
  readonly isAvailable = !!this._api;

  async getConfig(projectId: string): Promise<PiProjectConfig> {
    return this._unwrap(await this._requireApi().getConfig(projectId));
  }

  async saveConfig(projectId: string, config: PiProjectConfig): Promise<void> {
    this._unwrap(await this._requireApi().saveConfig(projectId, config));
  }

  async loadTask(taskId: string): Promise<void> {
    this._listen();
    this._accept(this._unwrap(await this._requireApi().getTask(taskId)));
  }

  async getResumeCommand(taskId: string, runId: string): Promise<string> {
    return this._unwrap(await this._requireApi().getResumeCommand(taskId, runId));
  }

  async start(request: PiAnalysisRequest): Promise<void> {
    this._listen();
    this._accept(this._unwrap(await this._requireApi().start(request)));
  }

  async stop(taskId: string): Promise<void> {
    this._accept(this._unwrap(await this._requireApi().stop(taskId)));
  }

  private _listen(): void {
    if (this._listening) return;
    const unsubscribe = this._requireApi().onUpdate((state) => this._accept(state));
    this._destroyRef.onDestroy(unsubscribe);
    this._listening = true;
  }

  private _accept(state: PiTaskAnalysis): void {
    const current = this._tasks()[state.taskId]?.runs[0];
    const incoming = state.runs[0];
    // A completion event may arrive before the start/get IPC response.
    if (
      current &&
      (!incoming ||
        current.startedAt > incoming.startedAt ||
        (current.id === incoming.id &&
          current.status !== 'RUNNING' &&
          incoming.status === 'RUNNING'))
    )
      return;
    this._tasks.update((tasks) => ({ ...tasks, [state.taskId]: state }));
  }

  private _requireApi(): PiAgentElectronApi {
    if (!this._api) throw new PiAgentClientError('NOT_AVAILABLE');
    return this._api;
  }

  private _unwrap<TValue>(reply: PiAgentReply<TValue>): TValue {
    if (!reply.ok) throw new PiAgentClientError(reply.error);
    return reply.data;
  }
}
