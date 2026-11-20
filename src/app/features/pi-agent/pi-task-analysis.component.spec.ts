import { TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { MarkdownModule } from 'ngx-markdown';
import { PiTaskAnalysisComponent } from './pi-task-analysis.component';
import { PiAgentService } from './pi-agent.service';
import { IssueService } from '../issue/issue.service';
import { ShareService } from '../../core/share/share.service';
import { DateTimeFormatService } from '../../core/date-time-format/date-time-format.service';
import { DEFAULT_TASK } from '../tasks/task.model';
import {
  DEFAULT_PI_PROJECT_CONFIG,
  PiTaskAnalysis,
} from '../../../../electron/shared-with-frontend/pi-agent.model';

describe('PiTaskAnalysisComponent', () => {
  const markdown =
    '# 自由标题\n\n| Evidence | Note |\n| --- | --- |\n| src/file.ts | arbitrary layout |\n\n' +
    '<script>window.bad = true;</script>\n\n[unsafe](javascript:alert(1))';
  const task = {
    ...DEFAULT_TASK,
    id: 'task-1',
    projectId: 'p1',
    issueId: 'p17/42',
    issueType: 'plugin:cteam-issue-provider' as const,
    issueProviderId: 'provider-1',
  };
  let pi: jasmine.SpyObj<PiAgentService>;
  let tasks: WritableSignal<Record<string, PiTaskAnalysis>>;
  let issue: jasmine.SpyObj<IssueService>;
  let share: jasmine.SpyObj<ShareService>;

  beforeEach(() => {
    tasks = signal<Record<string, PiTaskAnalysis>>({
      [task.id]: {
        taskId: 'task-1',
        runs: [
          {
            id: 'r1',
            taskId: 'task-1',
            projectId: 'p1',
            sessionId: 's1',
            workingDirectory: '/workspace',
            status: 'COMPLETED',
            startedAt: 1000,
            markdown,
            prompt: 'analyze',
            issueUrl: 'https://devops.cwoa.net/devops/console/vteam/p17/twBug?id=42',
          },
        ],
      },
    });
    pi = jasmine.createSpyObj<PiAgentService>(
      'PiAgentService',
      ['loadTask', 'getConfig', 'getResumeCommand', 'start', 'stop'],
      { isAvailable: true, tasks },
    );
    pi.loadTask.and.resolveTo();
    pi.getConfig.and.resolveTo({ ...DEFAULT_PI_PROJECT_CONFIG, enabled: true });
    pi.getResumeCommand.and.resolveTo('pi --session-dir "...\\sessions" --session "s1"');
    pi.start.and.resolveTo();
    pi.stop.and.resolveTo();
    issue = jasmine.createSpyObj<IssueService>('IssueService', ['issueLink']);
    issue.issueLink.and.resolveTo(
      'https://devops.cwoa.net/devops/console/vteam/p17/twBug?id=42',
    );
    share = jasmine.createSpyObj<ShareService>('ShareService', ['copyToClipboard']);
    share.copyToClipboard.and.resolveTo({ success: true, target: 'clipboard-text' });
    TestBed.configureTestingModule({
      teardown: { destroyAfterEach: true },
      imports: [
        PiTaskAnalysisComponent,
        TranslateModule.forRoot(),
        NoopAnimationsModule,
        MarkdownModule.forRoot(),
      ],
      providers: [
        { provide: PiAgentService, useValue: pi },
        { provide: IssueService, useValue: issue },
        { provide: ShareService, useValue: share },
        { provide: DateTimeFormatService, useValue: { currentLocale: signal('en-GB') } },
      ],
    });
  });

  it('renders free-form Markdown headings and tables through the existing sanitizer', async () => {
    const fixture = TestBed.createComponent(PiTaskAnalysisComponent);
    fixture.componentRef.setInput('task', task);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.markdown h1')?.textContent).toBe('自由标题');
    expect(element.querySelector('.markdown table')).not.toBeNull();
    expect(element.querySelector('.markdown script')).toBeNull();
    expect(element.querySelector('.markdown a')?.getAttribute('href') ?? '').not.toMatch(
      /^javascript:/,
    );
    expect(pi.start).not.toHaveBeenCalled();
  });

  it('passes the source link and user instructions on an explicit start, without copying report content into a schema', async () => {
    const fixture = TestBed.createComponent(PiTaskAnalysisComponent);
    fixture.componentRef.setInput('task', task);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.instruction.set('请自行选择分析方式');
    await fixture.componentInstance.start(false);
    expect(pi.start).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'p1',
      issueUrl: 'https://devops.cwoa.net/devops/console/vteam/p17/twBug?id=42',
      instruction: '请自行选择分析方式',
      newSession: false,
    });
    expect(fixture.componentInstance.report()?.markdown).toBe(markdown);
  });

  it('copies a terminal command for the selected Task Session', async () => {
    const fixture = TestBed.createComponent(PiTaskAnalysisComponent);
    fixture.componentRef.setInput('task', task);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.copySessionCommand('r1');

    expect(pi.getResumeCommand).toHaveBeenCalledWith('task-1', 'r1');
    expect(share.copyToClipboard).toHaveBeenCalledWith(
      'pi --session-dir "...\\sessions" --session "s1"',
      'Pi terminal command',
    );
  });

  it('does not copy a terminal resume command while Pi is running', async () => {
    tasks.update((current) => ({
      [task.id]: {
        ...current['task-1'],
        runs: [{ ...current['task-1'].runs[0], status: 'RUNNING' }],
      },
    }));
    const fixture = TestBed.createComponent(PiTaskAnalysisComponent);
    fixture.componentRef.setInput('task', task);
    fixture.detectChanges();
    await fixture.whenStable();

    await fixture.componentInstance.copySessionCommand('r1');

    expect(pi.getResumeCommand).not.toHaveBeenCalled();
    expect(share.copyToClipboard).not.toHaveBeenCalled();
  });

  it('does not require headings or JSON fields to display a plain-text result', async () => {
    tasks.update((current) => ({
      [task.id]: {
        ...current['task-1'],
        runs: [{ ...current['task-1'].runs[0], markdown: 'Just a paragraph.' }],
      },
    }));
    const fixture = TestBed.createComponent(PiTaskAnalysisComponent);
    fixture.componentRef.setInput('task', task);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('.markdown')?.textContent,
    ).toContain('Just a paragraph.');
  });
});
