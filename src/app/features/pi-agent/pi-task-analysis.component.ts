import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnChanges,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { MarkdownModule } from 'ngx-markdown';
import { Task } from '../tasks/task.model';
import { IssueService } from '../issue/issue.service';
import { T } from '../../t.const';
import { LocaleDatePipe } from '../../ui/pipes/locale-date.pipe';
import { DateTimeFormatService } from '../../core/date-time-format/date-time-format.service';
import { PiAgentService, piAgentErrorKey } from './pi-agent.service';
import { ShareService } from '../../core/share/share.service';

@Component({
  selector: 'pi-task-analysis',
  templateUrl: './pi-task-analysis.component.html',
  styleUrl: './pi-task-analysis.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButton,
    MatFormField,
    MatLabel,
    MatInput,
    MatIcon,
    TranslatePipe,
    MarkdownModule,
    LocaleDatePipe,
  ],
})
export class PiTaskAnalysisComponent implements OnChanges {
  private readonly _pi = inject(PiAgentService);
  private readonly _issueService = inject(IssueService);
  private readonly _shareService = inject(ShareService);
  readonly locale = inject(DateTimeFormatService).currentLocale;
  readonly T = T;
  readonly task = input.required<Task>();
  readonly isAvailable = this._pi.isAvailable;
  readonly instruction = signal('');
  readonly busy = signal(false);
  readonly configured = signal(false);
  readonly issueUrl = signal('');
  readonly error = signal<string | null>(null);
  readonly selectedId = signal('');
  readonly state = computed(() => this._pi.tasks()[this.task().id]);
  readonly latest = computed(() => this.state()?.runs[0]);
  readonly running = computed(() => this.latest()?.status === 'RUNNING');
  readonly statusKey = computed(() => {
    const status = this.latest()?.status;
    return status ? T.F.PI_AGENT.STATUS[status] : null;
  });
  readonly runError = computed(() => {
    const error = this.latest()?.error;
    return error ? T.F.PI_AGENT.ERRORS[error] : null;
  });
  readonly reports = computed(
    () => this.state()?.runs.filter((run) => !!run.markdown) ?? [],
  );
  readonly report = computed(
    () => this.reports().find((run) => run.id === this.selectedId()) ?? this.reports()[0],
  );
  readonly isOldProject = computed(
    () => !!this.report() && this.report()?.projectId !== this.task().projectId,
  );
  private _context = '';

  ngOnChanges(): void {
    const task = this.task();
    const key = JSON.stringify([
      task.id,
      task.projectId,
      task.issueType,
      task.issueId,
      task.issueProviderId,
    ]);
    if (key === this._context) return;
    this._context = key;
    this.instruction.set('');
    this.selectedId.set('');
    this.configured.set(false);
    this.issueUrl.set('');
    this.error.set(null);
    if (this.isAvailable) void this._load(key, task);
  }

  async start(newSession: boolean): Promise<void> {
    const task = this.task();
    if (!task.projectId || !this.issueUrl()) return;
    const key = this._context;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this._pi.start({
        taskId: task.id,
        projectId: task.projectId,
        issueUrl: this.issueUrl(),
        instruction: this.instruction(),
        newSession,
      });
      if (key === this._context) this.selectedId.set('');
    } catch (error) {
      if (key === this._context) this.error.set(piAgentErrorKey(error));
    } finally {
      this.busy.set(false);
    }
  }

  async copySessionCommand(runId: string): Promise<void> {
    if (this.busy() || this.running()) return;
    const key = this._context;
    this.busy.set(true);
    this.error.set(null);
    try {
      const command = await this._pi.getResumeCommand(this.task().id, runId);
      if (key !== this._context) return;
      const copied = await this._shareService.copyToClipboard(
        command,
        'Pi terminal command',
      );
      if (!copied.success && key === this._context) {
        this.error.set(T.F.PI_AGENT.COPY_SESSION_COMMAND_FAILED);
      }
    } catch (error) {
      if (key === this._context) this.error.set(piAgentErrorKey(error));
    } finally {
      if (key === this._context) this.busy.set(false);
    }
  }

  async stop(): Promise<void> {
    const key = this._context;
    this.busy.set(true);
    try {
      await this._pi.stop(this.task().id);
    } catch (error) {
      if (key === this._context) this.error.set(piAgentErrorKey(error));
    } finally {
      this.busy.set(false);
    }
  }

  private async _load(key: string, task: Task): Promise<void> {
    try {
      await this._pi.loadTask(task.id);
      if (!task.projectId || !task.issueType || !task.issueId || !task.issueProviderId)
        return;
      const [config, url] = await Promise.all([
        this._pi.getConfig(task.projectId),
        this._issueService.issueLink(task.issueType, task.issueId, task.issueProviderId),
      ]);
      if (key !== this._context) return;
      this.configured.set(config.enabled);
      this.issueUrl.set(url);
    } catch (error) {
      if (key === this._context) this.error.set(piAgentErrorKey(error));
    }
  }
}
