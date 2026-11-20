import { DestroyRef, inject, Injectable } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslateService } from '@ngx-translate/core';
import { buffer, debounceTime, firstValueFrom, Subject } from 'rxjs';
import { IS_ELECTRON } from '../../app.constants';
import { isBrowserNotificationGranted } from '../../core/notify/browser-notification-permission';
import { NotifyService } from '../../core/notify/notify.service';
import { SnackService } from '../../core/snack/snack.service';
import { NavigateToTaskService } from '../../core-ui/navigate-to-task/navigate-to-task.service';
import { T } from '../../t.const';
import { IssueService } from '../issue/issue.service';
import { Task } from '../tasks/task.model';
import { TaskService } from '../tasks/task.service';
import { PiAgentClientError, PiAgentService, piAgentErrorKey } from './pi-agent.service';

const CTEAM_PROVIDER = 'plugin:cteam-issue-provider';
const IMPORT_NOTIFICATION_DELAY_MS = 500;

/**
 * Device-local follow-up to a successful issue import, not a task-state observer.
 * No synced actions, project lock, startup scan or automatic retry is involved.
 */
@Injectable({ providedIn: 'root' })
export class CteamImportService {
  private readonly _issues = inject(IssueService);
  private readonly _tasks = inject(TaskService);
  private readonly _pi = inject(PiAgentService);
  private readonly _notify = inject(NotifyService);
  private readonly _snack = inject(SnackService);
  private readonly _translate = inject(TranslateService);
  private readonly _navigate = inject(NavigateToTaskService);
  private readonly _destroyRef = inject(DestroyRef);
  private readonly _imports = new Subject<Task>();
  private readonly _inFlight = new Set<string>();
  private _initialized = false;

  init(): void {
    if (this._initialized) return;
    this._initialized = true;
    // Event-driven buffering: no timer runs while there are no new imports.
    this._imports
      .pipe(
        buffer(this._imports.pipe(debounceTime(IMPORT_NOTIFICATION_DELAY_MS))),
        takeUntilDestroyed(this._destroyRef),
      )
      .subscribe((tasks) => {
        const projects = new Map<string, Task[]>();
        for (const task of tasks) {
          const key = task.projectId ?? '';
          const group = projects.get(key) ?? [];
          group.push(task);
          projects.set(key, group);
        }
        for (const group of projects.values()) void this._notifyImports(group);
      });
    this._issues.taskImported$
      .pipe(takeUntilDestroyed(this._destroyRef))
      .subscribe((taskId) => void this._handleImport(taskId));
  }

  private async _handleImport(taskId: string): Promise<void> {
    if (this._inFlight.has(taskId)) return;
    this._inFlight.add(taskId);
    try {
      const task = await firstValueFrom(this._tasks.getByIdOnce$(taskId));
      if (
        this._destroyRef.destroyed ||
        !task ||
        task.issueType !== CTEAM_PROVIDER ||
        !task.issueId ||
        !task.issueProviderId
      )
        return;

      if (!this._pi.isAvailable || !task.projectId) return;

      const config = await this._pi.getConfig(task.projectId);
      if (this._destroyRef.destroyed) return;
      if (config.notifyOnImport) this._imports.next(task);
      if (!config.enabled) return;
      await this._pi.loadTask(task.id);
      // An existing manual, running, completed or failed run is never retried
      // merely because the same import event is observed again.
      if (this._pi.tasks()[task.id]?.runs.length || this._destroyRef.destroyed) return;

      const issueUrl = await this._issues.issueLink(
        task.issueType,
        task.issueId,
        task.issueProviderId,
      );
      if (this._destroyRef.destroyed) return;
      if (!issueUrl) throw new PiAgentClientError('INVALID_REQUEST');
      await this._pi.start({
        taskId: task.id,
        projectId: task.projectId,
        issueUrl,
        instruction: '',
        newSession: true,
      });
    } catch (error) {
      if (
        !this._destroyRef.destroyed &&
        !(error instanceof PiAgentClientError && error.code === 'ALREADY_RUNNING')
      ) {
        this._snack.open({
          type: 'ERROR',
          msg: T.F.PI_AGENT.AUTO_START_FAILED,
          translateParams: {
            reason: this._translate.instant(piAgentErrorKey(error)),
          },
          actionStr: T.F.PI_AGENT.PANEL_TITLE,
          actionFn: () => this._navigate.navigate(taskId),
        });
      }
    } finally {
      this._inFlight.delete(taskId);
    }
  }

  private async _notifyImports(tasks: Task[]): Promise<void> {
    if (!tasks.length || this._destroyRef.destroyed) return;
    const options = {
      title: T.F.PI_AGENT.IMPORT_NOTIFICATION_TITLE,
      body: T.F.PI_AGENT.IMPORT_NOTIFICATION_BODY,
      translateParams: { count: tasks.length },
      tag: 'cteam-import-' + (tasks[0].projectId ?? ''),
      silent: true,
    };
    try {
      // Background polling must not open a browser permission prompt.
      // Electron uses its existing desktop notification/OS permission path.
      const notification =
        IS_ELECTRON || isBrowserNotificationGranted()
          ? await this._notify.notifyDesktop(options)
          : undefined;
      if (this._destroyRef.destroyed) return;
      if (notification) {
        const focusApp = notification.onclick;
        notification.onclick = (event) => {
          focusApp?.call(notification, event);
          void this._navigate.navigate(tasks[0].id);
        };
        return;
      }
    } catch {
      // Permission/API failures must not prevent import or Pi analysis.
    }
    if (!this._destroyRef.destroyed) {
      this._snack.open({
        msg: options.body,
        translateParams: options.translateParams,
        ico: 'download_done',
        actionStr: T.F.TASK.S.GO_TO_TASK,
        actionFn: () => this._navigate.navigate(tasks[0].id),
      });
    }
  }
}
