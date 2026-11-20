import { IPC, IPCEventValue } from './ipc-events.const';
import { PiAgentElectronApi, PiAgentReply, PiTaskAnalysis } from './pi-agent.model';
import { createOneShotApiConsumer } from './one-shot-api-consumer';

type Invoke = (channel: IPCEventValue, ...args: unknown[]) => Promise<unknown>;

export const createPiPreloadApiConsumer = (
  invoke: Invoke,
  subscribe: (listener: (state: PiTaskAnalysis) => void) => () => void,
): (() => PiAgentElectronApi | null) => {
  // The token stays inside the isolated preload closure, never on window.ea.
  const capability = invoke(IPC.PI_AGENT_REGISTER_CAPABILITY);
  const call = async <T>(
    channel: IPCEventValue,
    ...payload: unknown[]
  ): Promise<PiAgentReply<T>> => {
    const token = await capability;
    if (typeof token !== 'string') return { ok: false, error: 'NOT_AVAILABLE' };
    return invoke(channel, { capabilityToken: token, payload }) as Promise<
      PiAgentReply<T>
    >;
  };
  return createOneShotApiConsumer<PiAgentElectronApi>(() => ({
    getConfig: (projectId) => call(IPC.PI_AGENT_GET_CONFIG, projectId),
    saveConfig: (projectId, config) => call(IPC.PI_AGENT_SAVE_CONFIG, projectId, config),
    getTask: (taskId) => call(IPC.PI_AGENT_GET_TASK, taskId),
    getResumeCommand: (taskId, runId) =>
      call(IPC.PI_AGENT_GET_RESUME_COMMAND, taskId, runId),
    start: (request) => call(IPC.PI_AGENT_START, request),
    stop: (taskId) => call(IPC.PI_AGENT_STOP, taskId),
    onUpdate: subscribe,
  }));
};
