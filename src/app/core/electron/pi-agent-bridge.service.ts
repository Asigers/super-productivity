import { inject, Injectable } from '@angular/core';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import { PiAgentElectronApi } from '../../../../electron/shared-with-frontend/pi-agent.model';

@Injectable({ providedIn: 'root' })
export class PiAgentBridgeService {
  private readonly _isElectron = inject(IS_ELECTRON_TOKEN);
  #api: PiAgentElectronApi | null | undefined;

  initialize(): void {
    if (this.#api !== undefined) return;
    this.#api = this._isElectron ? (window.ea?.consumePiAgentApi?.() ?? null) : null;
  }

  getApi(): PiAgentElectronApi | null {
    this.initialize();
    return this.#api ?? null;
  }
}
