import { fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { TranslateService } from '@ngx-translate/core';
import { of, Subject } from 'rxjs';
import {
  DEFAULT_PI_PROJECT_CONFIG,
  PiAgentElectronApi,
  PiAnalysisRun,
} from '../../../../electron/shared-with-frontend/pi-agent.model';
import { NotifyService } from '../../core/notify/notify.service';
import { SnackService } from '../../core/snack/snack.service';
import { NavigateToTaskService } from '../../core-ui/navigate-to-task/navigate-to-task.service';
import { T } from '../../t.const';
import { IssueService } from '../issue/issue.service';
import { DEFAULT_TASK, Task } from '../tasks/task.model';
import { TaskService } from '../tasks/task.service';
import { CteamImportService } from './cteam-import.service';
import { PI_AGENT_API, PiAgentService } from './pi-agent.service';

describe('CteamImportService', () => {
  let imported: Subject<string>;
  let taskService: jasmine.SpyObj<TaskService>;
  let issueService: jasmine.SpyObj<IssueService>;
  let api: jasmine.SpyObj<PiAgentElectronApi>;
  let notify: jasmine.SpyObj<NotifyService>;
  let snack: jasmine.SpyObj<SnackService>;
  let navigate: jasmine.SpyObj<NavigateToTaskService>;
  let tasks: Record<string, Task | undefined>;
  let permission: NotificationPermission;
  const issueUrl =
    'https://devops.cwoa.net/devops/console/vteam/opsbpm/twBug?vmode=table&id=42';
  const config = {
    ...DEFAULT_PI_PROJECT_CONFIG,
    enabled: true,
    notifyOnImport: true,
  };
  const makeTask = (id = 'task-1', projectId = 'project-1'): Task => ({
    ...DEFAULT_TASK,
    id,
    projectId,
    issueType: 'plugin:cteam-issue-provider',
    issueId: 'opsbpm/42',
    issueProviderId: 'provider-1',
  });
  const run = (taskId: string, status: PiAnalysisRun['status']): PiAnalysisRun => ({
    id: 'run-' + taskId,
    taskId,
    projectId: 'project-1',
    sessionId: 'session-' + taskId,
    workingDirectory: '/workspace',
    status,
    startedAt: 1,
    issueUrl,
    prompt: 'analyze',
    markdown: '',
  });
  const init = (): CteamImportService => {
    const service = TestBed.inject(CteamImportService);
    service.init();
    return service;
  };
  const settle = (): void => {
    flushMicrotasks();
    tick(500);
    flushMicrotasks();
  };

  beforeEach(() => {
    imported = new Subject<string>();
    tasks = {};
    tasks['task-1'] = makeTask();
    taskService = jasmine.createSpyObj<TaskService>('TaskService', ['getByIdOnce$']);
    taskService.getByIdOnce$.and.callFake((id) => of(tasks[id] as Task));
    issueService = jasmine.createSpyObj<IssueService>('IssueService', ['issueLink'], {
      taskImported$: imported.asObservable(),
    });
    issueService.issueLink.and.resolveTo(issueUrl);
    api = jasmine.createSpyObj<PiAgentElectronApi>('PiAgentApi', [
      'getConfig',
      'saveConfig',
      'getTask',
      'getResumeCommand',
      'start',
      'stop',
      'onUpdate',
    ]);
    api.getConfig.and.resolveTo({ ok: true, data: config });
    api.getTask.and.callFake(async (taskId) => ({
      ok: true,
      data: { taskId, runs: [] },
    }));
    api.start.and.callFake(async (request) => ({
      ok: true,
      data: { taskId: request.taskId, runs: [run(request.taskId, 'RUNNING')] },
    }));
    api.onUpdate.and.returnValue(() => undefined);
    notify = jasmine.createSpyObj<NotifyService>('NotifyService', ['notifyDesktop']);
    notify.notifyDesktop.and.resolveTo(undefined);
    snack = jasmine.createSpyObj<SnackService>('SnackService', ['open']);
    navigate = jasmine.createSpyObj<NavigateToTaskService>('NavigateToTask', [
      'navigate',
    ]);
    navigate.navigate.and.resolveTo();
    permission = 'granted';
    spyOnProperty(Notification, 'permission', 'get').and.callFake(() => permission);
    TestBed.configureTestingModule({
      teardown: { destroyAfterEach: true },
      providers: [
        { provide: IssueService, useValue: issueService },
        { provide: TaskService, useValue: taskService },
        { provide: PI_AGENT_API, useValue: api },
        { provide: NotifyService, useValue: notify },
        { provide: SnackService, useValue: snack },
        { provide: NavigateToTaskService, useValue: navigate },
        { provide: TranslateService, useValue: { instant: (key: string) => key } },
      ],
    });
  });

  it('automatically starts the configured Project session after a local import', fakeAsync(() => {
    init();
    expect(api.start).not.toHaveBeenCalled();
    imported.next('task-1');
    settle();
    expect(api.start).toHaveBeenCalledOnceWith({
      taskId: 'task-1',
      projectId: 'project-1',
      issueUrl,
      instruction: '',
      newSession: true,
    });
    expect(issueService.issueLink).toHaveBeenCalledWith(
      'plugin:cteam-issue-provider',
      'opsbpm/42',
      'provider-1',
    );
  }));

  it('does not start for startup, configuration reads, history loading or sync state alone', fakeAsync(() => {
    init();
    const pi = TestBed.inject(PiAgentService);
    void pi.getConfig('project-1');
    void pi.loadTask('task-1');
    settle();
    expect(api.start).not.toHaveBeenCalled();
    expect(notify.notifyDesktop).not.toHaveBeenCalled();
  }));

  it('runs different Tasks concurrently even within the same Project', fakeAsync(() => {
    tasks['task-2'] = makeTask('task-2');
    api.start.and.returnValue(new Promise(() => undefined));
    init();
    imported.next('task-1');
    imported.next('task-2');
    settle();
    expect(api.start.calls.allArgs().map(([request]) => request.taskId)).toEqual([
      'task-1',
      'task-2',
    ]);
  }));

  it('subscribes only once and ignores the same in-flight import event', fakeAsync(() => {
    const service = init();
    service.init();
    imported.next('task-1');
    imported.next('task-1');
    settle();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(notify.notifyDesktop).toHaveBeenCalledTimes(1);
  }));

  it('does not automatically retry a Task that already has a local run', fakeAsync(() => {
    api.getTask.and.resolveTo({
      ok: true,
      data: { taskId: 'task-1', runs: [run('task-1', 'FAILED')] },
    });
    init();
    imported.next('task-1');
    settle();
    expect(api.start).not.toHaveBeenCalled();
  }));

  it('leaves analysis off when the Project has not enabled Pi, but still notifies import', fakeAsync(() => {
    api.getConfig.and.resolveTo({
      ok: true,
      data: { ...DEFAULT_PI_PROJECT_CONFIG, notifyOnImport: true },
    });
    init();
    imported.next('task-1');
    settle();
    expect(api.start).not.toHaveBeenCalled();
    expect(notify.notifyDesktop).toHaveBeenCalledTimes(1);
  }));

  it('does not notify when the Project has not opted in, without disabling analysis', fakeAsync(() => {
    api.getConfig.and.resolveTo({ ok: true, data: { ...config, notifyOnImport: false } });
    init();
    imported.next('task-1');
    settle();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(notify.notifyDesktop).not.toHaveBeenCalled();
  }));

  it('does not launch a process on platforms without the native Pi API', fakeAsync(() => {
    TestBed.overrideProvider(PI_AGENT_API, { useValue: null });
    init();
    imported.next('task-1');
    settle();
    expect(api.getConfig).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  }));

  it('ignores missing Tasks and other providers', fakeAsync(() => {
    tasks['task-2'] = { ...makeTask('task-2'), issueType: 'GITHUB' };
    init();
    imported.next('gone');
    imported.next('task-2');
    settle();
    expect(api.start).not.toHaveBeenCalled();
    expect(notify.notifyDesktop).not.toHaveBeenCalled();
  }));

  it('reports launch failure without losing the import notification or stopping later imports', fakeAsync(() => {
    api.start.and.resolveTo({ ok: false, error: 'PI_UNAVAILABLE' });
    init();
    imported.next('task-1');
    settle();
    expect(snack.open).toHaveBeenCalledWith(
      jasmine.objectContaining({
        msg: T.F.PI_AGENT.AUTO_START_FAILED,
        translateParams: { reason: T.F.PI_AGENT.ERRORS.PI_UNAVAILABLE },
      }),
    );
    expect(notify.notifyDesktop).toHaveBeenCalledTimes(1);
    tasks['task-2'] = makeTask('task-2');
    imported.next('task-2');
    settle();
    expect(api.start).toHaveBeenCalledTimes(2);
  }));

  it('does not invoke Pi when the work-item link cannot be resolved', fakeAsync(() => {
    issueService.issueLink.and.resolveTo('');
    init();
    imported.next('task-1');
    settle();
    expect(api.start).not.toHaveBeenCalled();
    expect(snack.open).toHaveBeenCalledWith(
      jasmine.objectContaining({
        msg: T.F.PI_AGENT.AUTO_START_FAILED,
        translateParams: { reason: T.F.PI_AGENT.ERRORS.INVALID_REQUEST },
      }),
    );
  }));

  it('groups import notifications by Project without exposing work-item titles', fakeAsync(() => {
    tasks['task-2'] = makeTask('task-2');
    tasks['task-3'] = makeTask('task-3', 'project-2');
    init();
    imported.next('task-1');
    imported.next('task-2');
    imported.next('task-3');
    settle();
    expect(
      notify.notifyDesktop.calls.allArgs().map(([options]) => ({
        count: options.translateParams?.['count'],
        tag: options.tag,
        body: options.body,
        silent: options.silent,
      })),
    ).toEqual([
      {
        count: 2,
        tag: 'cteam-import-project-1',
        body: T.F.PI_AGENT.IMPORT_NOTIFICATION_BODY,
        silent: true,
      },
      {
        count: 1,
        tag: 'cteam-import-project-2',
        body: T.F.PI_AGENT.IMPORT_NOTIFICATION_BODY,
        silent: true,
      },
    ]);
  }));

  it('preserves notification focus behavior and navigates to the imported task on click', fakeAsync(() => {
    const focusApp = jasmine.createSpy('focusApp');
    const notification = { onclick: focusApp } as unknown as Notification;
    notify.notifyDesktop.and.resolveTo(notification);
    init();
    imported.next('task-1');
    settle();
    const event = new Event('click');
    notification.onclick?.call(notification, event);
    flushMicrotasks();
    expect(focusApp).toHaveBeenCalledWith(event);
    expect(navigate.navigate).toHaveBeenCalledOnceWith('task-1');
  }));

  it('uses an in-app notice instead of prompting for browser permissions during import', fakeAsync(() => {
    permission = 'default';
    const requestPermission = spyOn(Notification, 'requestPermission');
    init();
    imported.next('task-1');
    settle();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(notify.notifyDesktop).not.toHaveBeenCalled();
    expect(snack.open).toHaveBeenCalledWith(
      jasmine.objectContaining({
        msg: T.F.PI_AGENT.IMPORT_NOTIFICATION_BODY,
        translateParams: { count: 1 },
      }),
    );
  }));

  it('falls back to an in-app notice if the notification API fails, without preventing analysis', fakeAsync(() => {
    notify.notifyDesktop.and.rejectWith(new Error('notifications unavailable'));
    init();
    imported.next('task-1');
    settle();
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(snack.open).toHaveBeenCalledWith(
      jasmine.objectContaining({
        msg: T.F.PI_AGENT.IMPORT_NOTIFICATION_BODY,
      }),
    );
  }));

  it('unsubscribes and does not start a pending analysis after destruction', fakeAsync(() => {
    let resolveConfig:
      | ((reply: Awaited<ReturnType<PiAgentElectronApi['getConfig']>>) => void)
      | undefined;
    api.getConfig.and.returnValue(
      new Promise((resolve) => {
        resolveConfig = resolve;
      }),
    );
    init();
    imported.next('task-1');
    flushMicrotasks();
    TestBed.resetTestingModule();
    resolveConfig?.({ ok: true, data: config });
    imported.next('task-1');
    settle();
    expect(api.start).not.toHaveBeenCalled();
    expect(notify.notifyDesktop).not.toHaveBeenCalled();
  }));
});
