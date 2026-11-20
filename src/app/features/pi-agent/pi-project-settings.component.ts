import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatCheckbox } from '@angular/material/checkbox';
import { MatFormField, MatHint, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { TranslatePipe } from '@ngx-translate/core';
import {
  DEFAULT_PI_PROJECT_CONFIG,
  PiProjectConfig,
} from '../../../../electron/shared-with-frontend/pi-agent.model';
import { T } from '../../t.const';
import { requestBrowserNotificationPermission } from '../../core/notify/browser-notification-permission';
import { PiAgentService, piAgentErrorKey } from './pi-agent.service';

@Component({
  selector: 'pi-project-settings',
  templateUrl: './pi-project-settings.component.html',
  styleUrl: './pi-project-settings.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatCheckbox,
    MatFormField,
    MatLabel,
    MatHint,
    MatInput,
    TranslatePipe,
  ],
})
export class PiProjectSettingsComponent implements OnInit {
  private readonly _pi = inject(PiAgentService);
  readonly T = T;
  readonly projectId = input.required<string>();
  readonly config = signal<PiProjectConfig>({ ...DEFAULT_PI_PROJECT_CONFIG });
  readonly isAvailable = this._pi.isAvailable;
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  private _loaded = false;

  ngOnInit(): void {
    void this._load();
  }

  update(change: Partial<PiProjectConfig>): void {
    this.config.update((config) => ({ ...config, ...change }));
  }

  async setImportNotifications(enabled: boolean): Promise<void> {
    this.update({ notifyOnImport: enabled });
    // Only this explicit user gesture may ask for browser notification permission.
    if (enabled) await requestBrowserNotificationPermission();
  }

  async save(): Promise<boolean> {
    if (!this.isAvailable) return true;
    if (!this._loaded || this.saving()) return false;
    this.saving.set(true);
    this.error.set(null);
    try {
      await this._pi.saveConfig(this.projectId(), this.config());
      return true;
    } catch (error) {
      this.error.set(piAgentErrorKey(error));
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  private async _load(): Promise<void> {
    if (!this.isAvailable) {
      this.loading.set(false);
      return;
    }
    try {
      this.config.set(await this._pi.getConfig(this.projectId()));
      this._loaded = true;
    } catch (error) {
      this.error.set(piAgentErrorKey(error));
    } finally {
      this.loading.set(false);
    }
  }
}
