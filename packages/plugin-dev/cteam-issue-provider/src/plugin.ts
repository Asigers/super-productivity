import type { PluginAPI as PluginAPIType } from '@super-productivity/plugin-api';
import { createCTeamProvider, parseAuth } from './cteam';
import { createCredentialHandler } from './credentials';

declare const PluginAPI: PluginAPIType;

PluginAPI.registerIssueProvider(
  createCTeamProvider(
    async () => parseAuth(await PluginAPI.getSecret('cteam-auth')),
    (key) => PluginAPI.translate(key),
  ),
);
PluginAPI.onMessage!(createCredentialHandler(PluginAPI));
PluginAPI.registerConfigHandler(() => PluginAPI.showIndexHtmlAsView());
