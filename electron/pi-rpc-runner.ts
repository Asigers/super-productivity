import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { PiAgentError, PiProjectConfig } from './shared-with-frontend/pi-agent.model';

export class PiAgentFailure extends Error {
  constructor(readonly code: PiAgentError) {
    super(code);
  }
}

interface RpcRecord {
  [key: string]: unknown;
}

export interface PiRpcResult {
  markdown: string;
  error?: PiAgentError;
  cancelled: boolean;
}

export interface PiRpcOptions {
  config: PiProjectConfig;
  sessionDirectory?: string;
  sessionId: string;
  resumeSession?: boolean;
  prompt: string;
  signal: AbortSignal;
}

// npm's Windows .cmd shim cannot be spawned with shell:false. Run its actual
// JS entry with Electron's Node mode instead; the prompt never enters a shell.
export const resolvePiExecutable = (
  executable: string,
  platform = process.platform,
  searchPath = process.env.PATH ?? '',
): { command: string; args: string[]; env: NodeJS.ProcessEnv } => {
  let entry = executable;
  if (platform === 'win32') {
    const candidates = path.isAbsolute(entry)
      ? [entry]
      : searchPath
          .split(path.delimiter)
          .flatMap((dir) => [
            path.join(dir, entry + '.exe'),
            path.join(dir, entry + '.cmd'),
          ]);
    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (resolved) entry = resolved;
    if (/\.cmd$/i.test(entry)) {
      const cli = path.join(
        path.dirname(entry),
        'node_modules',
        '@earendil-works',
        'pi-coding-agent',
        'dist',
        'cli.js',
      );
      if (!existsSync(cli)) throw new PiAgentFailure('PI_UNAVAILABLE');
      entry = cli;
    }
  }
  if (/\.[cm]?js$/i.test(entry)) {
    return {
      command: process.execPath,
      args: [entry],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }
  return { command: entry, args: [], env: { ...process.env } };
};

const asRecord = (value: unknown): RpcRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RpcRecord)
    : {};

const assistantText = (message: RpcRecord): string =>
  Array.isArray(message.content)
    ? message.content
        .filter((block) => asRecord(block).type === 'text')
        .map((block) => asRecord(block).text)
        .filter((text): text is string => typeof text === 'string')
        .join('\n')
    : '';

export const runPiRpc = (options: PiRpcOptions): Promise<PiRpcResult> => {
  if (options.signal.aborted) {
    return Promise.resolve({ markdown: '', cancelled: true });
  }
  const resolved = resolvePiExecutable(options.config.executable);
  const args = [
    ...resolved.args,
    '--mode',
    'rpc',
    ...(options.sessionDirectory ? ['--session-dir', options.sessionDirectory] : []),
    // Continuing must fail if the old session was deleted or moved; --session-id
    // would silently create a new, empty conversation with the same ID.
    options.resumeSession ? '--session' : '--session-id',
    options.sessionId,
    ...(options.config.model ? ['--model', options.config.model] : []),
  ];

  return new Promise((resolve) => {
    const child: ChildProcessWithoutNullStreams = spawn(resolved.command, args, {
      cwd: options.config.workingDirectory,
      env: resolved.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let markdown = '';
    let messageError = false;
    let error: PiAgentError | undefined;
    let settled = false;
    let cancelled = false;
    let closing = false;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (value: RpcRecord): void => {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) {
        child.stdin.write(JSON.stringify(value) + '\n');
      }
    };
    const close = (): void => {
      if (closing) return;
      closing = true;
      clearTimeout(startupTimer);
      child.stdin.end();
      // This is only a shutdown deadline, not a limit on analysis time.
      shutdownTimer = setTimeout(() => {
        if (child.pid && process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            stdio: 'ignore',
          });
          killer.on('error', () => child.kill());
        } else if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, 1000);
      shutdownTimer.unref();
    };
    const fail = (code: PiAgentError): void => {
      error = code;
      close();
    };
    const cancel = (): void => {
      cancelled = true;
      // Keep queue clearing ordered before abort, as required by Pi RPC.
      send({ id: 'clear', type: 'clear_queue' });
      send({ id: 'abort', type: 'abort' });
      close();
    };
    const receive = (record: RpcRecord): void => {
      if (record.type === 'response') {
        if (record.success === false) {
          fail('PROTOCOL_ERROR');
        } else if (record.id === 'state' && !closing) {
          if (asRecord(record.data).sessionId !== options.sessionId) {
            fail('PROTOCOL_ERROR');
            return;
          }
          clearTimeout(startupTimer);
          send({ id: 'analysis', type: 'prompt', message: options.prompt });
        } else if (
          record.id === 'analysis' &&
          asRecord(record.data).disposition === 'handled'
        ) {
          fail('EMPTY_RESULT');
        }
      } else if (record.type === 'message_end') {
        const message = asRecord(record.message);
        if (message.role === 'assistant') {
          markdown = assistantText(message);
          messageError =
            message.stopReason === 'error' ||
            message.stopReason === 'aborted' ||
            message.stopReason === 'length';
        }
      } else if (record.type === 'agent_settled') {
        settled = true;
        cancelled ||= record.aborted === true;
        if (!cancelled && messageError) error = 'RUNTIME_ERROR';
        if (!cancelled && !error && !markdown.trim()) error = 'EMPTY_RESULT';
        close();
      } else if (record.type === 'extension_ui_request') {
        const method = record.method;
        if (['select', 'confirm', 'input', 'editor'].includes(String(method))) {
          // Never auto-approve an extension's permission or confirmation dialog.
          send({ type: 'extension_ui_response', id: record.id, cancelled: true });
          fail('INTERACTION_REQUIRED');
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      // Only LF frames JSONL. U+2028/U+2029 are valid inside Markdown strings.
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          receive(asRecord(JSON.parse(line)));
        } catch {
          fail('PROTOCOL_ERROR');
        }
      }
    });
    // Drain diagnostics, but never log tool output, user code or credentials.
    child.stderr.resume();
    child.stdin.on('error', () => {
      if (!closing) fail('RUNTIME_ERROR');
    });
    child.on('error', () => {
      error = 'PI_UNAVAILABLE';
    });
    child.on('close', (code) => {
      clearTimeout(startupTimer);
      clearTimeout(shutdownTimer);
      options.signal.removeEventListener('abort', cancel);
      resolve({
        markdown,
        cancelled,
        error:
          error ?? (!cancelled && (!settled || code !== 0) ? 'RUNTIME_ERROR' : undefined),
      });
    });
    options.signal.addEventListener('abort', cancel, { once: true });
    // get_state both verifies RPC startup and ensures listeners are installed
    // before any prompt can produce events.
    const startupTimer = setTimeout(() => fail('PROTOCOL_ERROR'), 30000);
    send({ id: 'state', type: 'get_state' });
    if (options.signal.aborted) cancel();
  });
};
