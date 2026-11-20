import { PluginIframeMessageType } from '@super-productivity/plugin-api';
import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import type { AuthInfo } from './credentials';

declare const PluginAPI: PluginAPIType;

const authMessage = (action: string, payload?: unknown): Promise<AuthInfo> =>
  new Promise((resolve, reject) => {
    const messageId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('CTeam setup message timed out.'));
    }, 10000);
    const receive = (event: MessageEvent): void => {
      if (event.source !== window.parent || event.data?.messageId !== messageId) return;
      if (
        event.data.type !== PluginIframeMessageType.MESSAGE_RESPONSE &&
        event.data.type !== PluginIframeMessageType.MESSAGE_ERROR
      )
        return;
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      if (event.data.type === PluginIframeMessageType.MESSAGE_ERROR) {
        reject(new Error('CTeam setup failed.'));
      } else {
        resolve(event.data.result as AuthInfo);
      }
    };
    window.addEventListener('message', receive);
    window.parent.postMessage(
      {
        type: PluginIframeMessageType.MESSAGE,
        messageId,
        message: { type: 'cteam-auth', action, payload },
      },
      '*',
    );
  });

const initialize = async (): Promise<void> => {
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = await PluginAPI.translate(element.dataset.i18n!);
  }
  const user = document.querySelector<HTMLInputElement>('#user')!;
  const token = document.querySelector<HTMLInputElement>('#token')!;
  const tenant = document.querySelector<HTMLInputElement>('#tenant')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const show = async (key: string): Promise<void> => {
    status.textContent = await PluginAPI.translate(key);
  };
  try {
    const auth = await authMessage('info');
    user.value = auth.userId;
    tenant.value = auth.tenantId;
    if (auth.configured) await show('AUTH.CONFIGURED');
  } catch {
    await show('AUTH.ERROR');
  }
  document
    .querySelector<HTMLFormElement>('#credentials')!
    .addEventListener('submit', (event) => {
      event.preventDefault();
      void (async () => {
        try {
          await authMessage('save', {
            userId: user.value.trim(),
            token: token.value.trim(),
            tenantId: tenant.value.trim(),
          });
          token.value = '';
          await show('AUTH.SAVED');
        } catch {
          await show('AUTH.ERROR');
        }
      })();
    });
  document.querySelector<HTMLButtonElement>('#remove')!.addEventListener('click', () => {
    void authMessage('remove')
      .then(async () => {
        token.value = '';
        await show('AUTH.REMOVED');
      })
      .catch(() => show('AUTH.ERROR'));
  });
};
void initialize();
