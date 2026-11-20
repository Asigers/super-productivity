import { TestBed } from '@angular/core/testing';
import { PI_AGENT_API, PiAgentClientError, PiAgentService } from './pi-agent.service';
import {
  DEFAULT_PI_PROJECT_CONFIG,
  PiAgentElectronApi,
  PiAnalysisRun,
  PiTaskAnalysis,
} from '../../../../electron/shared-with-frontend/pi-agent.model';

describe('PiAgentService', () => {
  let api: jasmine.SpyObj<PiAgentElectronApi>;
  let update: (state: PiTaskAnalysis) => void;
  let unsubscribe: jasmine.Spy;
  let service: PiAgentService;
  const run = (status: PiAnalysisRun['status']): PiAnalysisRun => ({
    id: 'run-1',
    taskId: 'task-1',
    projectId: 'p1',
    sessionId: 's1',
    workingDirectory: '/workspace',
    status,
    startedAt: 1,
    issueUrl: 'https://example.com/issue',
    prompt: 'analyze',
    markdown: '',
  });

  beforeEach(() => {
    unsubscribe = jasmine.createSpy('unsubscribe');
    api = jasmine.createSpyObj<PiAgentElectronApi>('PiAgent', [
      'getConfig',
      'saveConfig',
      'getTask',
      'getResumeCommand',
      'start',
      'stop',
      'onUpdate',
    ]);
    api.onUpdate.and.callFake((listener) => {
      update = listener;
      return unsubscribe;
    });
    api.getConfig.and.resolveTo({ ok: true, data: { ...DEFAULT_PI_PROJECT_CONFIG } });
    api.getTask.and.resolveTo({ ok: true, data: { taskId: 'task-1', runs: [] } });
    TestBed.configureTestingModule({
      teardown: { destroyAfterEach: true },
      providers: [{ provide: PI_AGENT_API, useValue: api }],
    });
    service = TestBed.inject(PiAgentService);
  });

  it('returns the exact Task session resume command from the native API', async () => {
    api.getResumeCommand.and.resolveTo({ ok: true, data: 'pi --session id-1' });
    await expectAsync(service.getResumeCommand('task-1', 'run-1')).toBeResolvedTo(
      'pi --session id-1',
    );
    expect(api.getResumeCommand).toHaveBeenCalledWith('task-1', 'run-1');
  });

  it('does not start Pi when loading configuration or reports', async () => {
    await service.getConfig('p1');
    await service.loadTask('task-1');
    expect(api.start).not.toHaveBeenCalled();
    expect(api.onUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not let a late RUNNING response overwrite a completion event', async () => {
    api.start.and.callFake(async () => {
      update({
        taskId: 'task-1',
        runs: [{ ...run('COMPLETED'), markdown: '# 自由输出' }],
      });
      return { ok: true, data: { taskId: 'task-1', runs: [run('RUNNING')] } };
    });
    await service.start({
      taskId: 'task-1',
      projectId: 'p1',
      issueUrl: 'https://example.com/issue',
      instruction: '',
      newSession: false,
    });
    expect(service.tasks()['task-1'].runs[0].status).toBe('COMPLETED');
    expect(service.tasks()['task-1'].runs[0].markdown).toBe('# 自由输出');
  });

  it('keeps different Tasks independent and unsubscribes on destruction', async () => {
    await service.loadTask('task-1');
    await service.loadTask('task-2');
    update({ taskId: 'task-2', runs: [{ ...run('RUNNING'), taskId: 'task-2' }] });
    expect(service.tasks()['task-1'].runs).toEqual([]);
    expect(service.tasks()['task-2'].runs[0].status).toBe('RUNNING');
    TestBed.resetTestingModule();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('surfaces native failures instead of treating them as successful runs', async () => {
    api.getConfig.and.resolveTo({ ok: false, error: 'STORAGE_ERROR' });
    await expectAsync(service.getConfig('p1')).toBeRejectedWithError(
      PiAgentClientError,
      'STORAGE_ERROR',
    );
  });

  it('does not expose a runtime on web or mobile', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      teardown: { destroyAfterEach: true },
      providers: [{ provide: PI_AGENT_API, useValue: null }],
    });
    const unavailable = TestBed.inject(PiAgentService);
    expect(unavailable.isAvailable).toBeFalse();
    await expectAsync(unavailable.loadTask('task-1')).toBeRejectedWithError(
      PiAgentClientError,
      'NOT_AVAILABLE',
    );
  });
});
