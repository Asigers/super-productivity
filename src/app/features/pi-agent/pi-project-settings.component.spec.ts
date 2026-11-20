import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { PiProjectSettingsComponent } from './pi-project-settings.component';
import { PiAgentClientError, PiAgentService } from './pi-agent.service';
import { DEFAULT_PI_PROJECT_CONFIG } from '../../../../electron/shared-with-frontend/pi-agent.model';

describe('PiProjectSettingsComponent', () => {
  let pi: jasmine.SpyObj<PiAgentService>;

  beforeEach(() => {
    pi = jasmine.createSpyObj<PiAgentService>(
      'PiAgentService',
      ['getConfig', 'saveConfig'],
      { isAvailable: true },
    );
    pi.getConfig.and.resolveTo({ ...DEFAULT_PI_PROJECT_CONFIG });
    pi.saveConfig.and.resolveTo();
    TestBed.configureTestingModule({
      teardown: { destroyAfterEach: true },
      imports: [
        PiProjectSettingsComponent,
        TranslateModule.forRoot(),
        NoopAnimationsModule,
      ],
      providers: [{ provide: PiAgentService, useValue: pi }],
    });
  });

  it('loads local settings without saving or starting a process; edits save only on request', async () => {
    const fixture = TestBed.createComponent(PiProjectSettingsComponent);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(pi.getConfig).toHaveBeenCalledWith('p1');
    expect(pi.saveConfig).not.toHaveBeenCalled();
    fixture.componentInstance.update({
      workingDirectory: '/user/pi',
      prompt: '自由分析 {{issueUrl}}',
    });
    expect(pi.saveConfig).not.toHaveBeenCalled();
    expect(await fixture.componentInstance.save()).toBeTrue();
    expect(pi.saveConfig).toHaveBeenCalledWith(
      'p1',
      jasmine.objectContaining({
        workingDirectory: '/user/pi',
        prompt: '自由分析 {{issueUrl}}',
      }),
    );
  });

  it('requests notification permission only when the user enables import notifications', async () => {
    const request = spyOn(Notification, 'requestPermission').and.resolveTo('granted');
    spyOnProperty(Notification, 'permission', 'get').and.returnValue('default');
    const fixture = TestBed.createComponent(PiProjectSettingsComponent);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(request).not.toHaveBeenCalled();
    expect(fixture.componentInstance.config().notifyOnImport).toBeFalse();

    await fixture.componentInstance.setImportNotifications(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(fixture.componentInstance.config().notifyOnImport).toBeTrue();
    expect(pi.saveConfig).not.toHaveBeenCalled();
    expect(await fixture.componentInstance.save()).toBeTrue();
    expect(pi.saveConfig).toHaveBeenCalledWith(
      'p1',
      jasmine.objectContaining({ enabled: false, notifyOnImport: true }),
    );
    await fixture.componentInstance.setImportNotifications(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not allow the Project dialog to close as saved when native persistence fails', async () => {
    const fixture = TestBed.createComponent(PiProjectSettingsComponent);
    fixture.componentRef.setInput('projectId', 'p1');
    fixture.detectChanges();
    await fixture.whenStable();
    pi.saveConfig.and.rejectWith(new PiAgentClientError('STORAGE_ERROR'));
    expect(await fixture.componentInstance.save()).toBeFalse();
    expect(fixture.componentInstance.error()).toBe('F.PI_AGENT.ERRORS.STORAGE_ERROR');
  });
});
