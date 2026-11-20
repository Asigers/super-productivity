import { parseAuth } from './cteam';

export interface AuthInfo {
  configured: boolean;
  userId: string;
  tenantId: string;
}

interface Secrets {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

// The iframe bridge intentionally does not expose secret APIs. Keep credential
// operations in plugin.js and return only non-secret setup information.
export const createCredentialHandler =
  (secrets: Secrets) =>
  async (message: unknown): Promise<AuthInfo> => {
    const input =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : {};
    if (input.type !== 'cteam-auth') throw new Error('Unsupported CTeam message.');
    if (input.action === 'save') {
      const auth = parseAuth(JSON.stringify(input.payload));
      await secrets.setSecret('cteam-auth', JSON.stringify(auth));
      return { configured: true, userId: auth.userId, tenantId: auth.tenantId ?? '' };
    }
    if (input.action === 'remove') {
      await secrets.deleteSecret('cteam-auth');
      return { configured: false, userId: '', tenantId: '' };
    }
    if (input.action === 'info') {
      const raw = await secrets.getSecret('cteam-auth');
      if (!raw) return { configured: false, userId: '', tenantId: '' };
      const auth = parseAuth(raw);
      return { configured: true, userId: auth.userId, tenantId: auth.tenantId ?? '' };
    }
    throw new Error('Unsupported CTeam credential action.');
  };
