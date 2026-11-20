import { app, ipcMain, WebFrameMain } from 'electron';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { getWin } from '../main-window';
import { IPC } from '../shared-with-frontend/ipc-events.const';
import { PiAgentReply } from '../shared-with-frontend/pi-agent.model';
import { PiAgentManager, piFailureCode } from '../pi-agent';
import { PiAgentFailure } from '../pi-rpc-runner';

export const initPiAgentIpc = (): void => {
  const tokens = new WeakMap<WebFrameMain, string>();
  ipcMain.handle(IPC.PI_AGENT_REGISTER_CAPABILITY, (event) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null;
    const token = randomBytes(32).toString('base64url');
    tokens.set(event.senderFrame, token);
    return token;
  });
  const manager = new PiAgentManager(
    path.join(app.getPath('userData'), 'pi-agent'),
    (state) => {
      // The main window can already be gone during orderly app shutdown.
      try {
        const win = getWin();
        if (!win.isDestroyed()) win.webContents.send(IPC.PI_AGENT_UPDATED, state);
      } catch {
        // The result is persisted even when there is no renderer to notify.
      }
    },
  );
  const handle = <T>(
    channel: IPC,
    operation: (...args: unknown[]) => Promise<T>,
  ): void => {
    ipcMain.handle(
      channel,
      async (event, envelope: unknown): Promise<PiAgentReply<T>> => {
        const value =
          typeof envelope === 'object' && envelope !== null
            ? (envelope as Record<string, unknown>)
            : {};
        if (
          !event.senderFrame ||
          event.senderFrame !== event.sender.mainFrame ||
          typeof value.capabilityToken !== 'string' ||
          tokens.get(event.senderFrame) !== value.capabilityToken ||
          !Array.isArray(value.payload)
        ) {
          return { ok: false, error: 'INVALID_REQUEST' };
        }
        try {
          return { ok: true, data: await operation(...value.payload) };
        } catch (error) {
          return { ok: false, error: piFailureCode(error) };
        }
      },
    );
  };
  const id = (value: unknown): string => {
    if (typeof value !== 'string') throw new PiAgentFailure('INVALID_REQUEST');
    return value;
  };
  handle(IPC.PI_AGENT_GET_CONFIG, (projectId) => manager.getConfig(id(projectId)));
  handle(IPC.PI_AGENT_SAVE_CONFIG, (projectId, config) =>
    manager.saveConfig(id(projectId), config),
  );
  handle(IPC.PI_AGENT_GET_TASK, (taskId) => manager.getTask(id(taskId)));
  handle(IPC.PI_AGENT_GET_RESUME_COMMAND, (taskId, runId) =>
    manager.getResumeCommand(id(taskId), id(runId)),
  );
  handle(IPC.PI_AGENT_START, (request) => manager.start(request));
  handle(IPC.PI_AGENT_STOP, (taskId) => manager.stop(id(taskId)));

  let stopping = false;
  app.on('before-quit', (event) => {
    if (!event.defaultPrevented && manager.isRunning && !stopping) {
      event.preventDefault();
      stopping = true;
      void manager.stopAll().finally(() => app.quit());
    }
  });
};
