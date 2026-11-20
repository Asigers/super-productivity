import { TestBed } from '@angular/core/testing';
import { IS_ELECTRON_TOKEN } from '../../app.constants';
import { PiAgentBridgeService } from './pi-agent-bridge.service';
import { PiAgentElectronApi } from '../../../../electron/shared-with-frontend/pi-agent.model';

describe('PiAgentBridgeService', () => {
  let original: PropertyDescriptor | undefined;
  let consume: jasmine.Spy;
  const api = {} as PiAgentElectronApi;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(window, 'ea');
    consume = jasmine.createSpy('consumePiAgentApi').and.returnValue(api);
    Object.defineProperty(window, 'ea', {
      configurable: true,
      value: { consumePiAgentApi: consume },
    });
    TestBed.configureTestingModule({
      teardown: { destroyAfterEach: true },
      providers: [{ provide: IS_ELECTRON_TOKEN, useValue: true }],
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(window, 'ea', original);
    else delete (window as Partial<Window>).ea;
  });

  it('claims the native API once and keeps it private across repeated initialization', () => {
    const bridge = TestBed.inject(PiAgentBridgeService);
    bridge.initialize();
    bridge.initialize();
    expect(bridge.getApi()).toBe(api);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it('does not claim native process access on web or mobile', () => {
    TestBed.overrideProvider(IS_ELECTRON_TOKEN, { useValue: false });
    expect(TestBed.inject(PiAgentBridgeService).getApi()).toBeNull();
    expect(consume).not.toHaveBeenCalled();
  });
});
