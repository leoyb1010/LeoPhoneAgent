import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { LLMProvider, ProviderManifest, ProviderTemplate } from '@/shared/types.js';

/**
 * Static, backend-owned description of what one provider integration supports.
 *
 * The frontend renders its composer UI (permission mode picker, image upload,
 * abort button, ...) purely from this shape, which is what keeps the frontend
 * free of per-provider conditionals. New provider features should be exposed
 * here instead of branching on the provider id in React components.
 */
type ProviderCapabilities = {
  provider: LLMProvider;
  /** Permission modes the provider runtime understands, in cycle order. */
  permissionModes: string[];
  defaultPermissionMode: string;
  /** Whether image attachments can be included in a chat.send. */
  supportsImages: boolean;
  /** Whether an in-flight run can be cancelled via chat.abort. */
  supportsAbort: boolean;
  /** Whether interactive tool permission prompts can reach the UI. */
  supportsPermissionRequests: boolean;
  /** Whether the token-usage endpoint has data for this provider. */
  supportsTokenUsage: boolean;
  /** Whether the provider runtime can accept model-level reasoning effort. */
  supportsEffort: boolean;
};

/**
 * The capability matrix mirrors what each runtime actually implements today:
 * - permission modes match the option sets accepted by each CLI/SDK.
 * - only the Claude SDK integration surfaces interactive permission requests.
 * - Cursor has no token usage endpoint support (its store.db has no usage rows).
 */
const RUNTIME_UI_CAPABILITIES: Record<LLMProvider, ProviderCapabilities> = {
  claude: {
    provider: 'claude',
    permissionModes: ['default', 'auto', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: true,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  cursor: {
    provider: 'cursor',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: false,
    supportsEffort: false,
  },
  codex: {
    provider: 'codex',
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  opencode: {
    provider: 'opencode',
    // Mapped by the runtime onto OpenCode's controls: `--agent plan` (plan),
    // `--auto` (bypassPermissions) and the OPENCODE_PERMISSION env var
    // (acceptEdits). See resolveOpenCodePermissionOptions in opencode-runtime.js.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
  grok: {
    provider: 'grok',
    // grok --permission-mode accepts these values directly (auto/dontAsk exist
    // too but map onto bypassPermissions). No interactive approval round-trip;
    // usage is surfaced from the terminal `end` event; grok-4.5 takes --effort.
    permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
    defaultPermissionMode: 'default',
    supportsImages: true,
    supportsAbort: true,
    supportsPermissionRequests: false,
    supportsTokenUsage: true,
    supportsEffort: true,
  },
};

const runtimeManifests = providerRegistry
  .listManifests({ includeHidden: true })
  .filter((manifest) => manifest.capabilities.chat === 'supported');
for (const manifest of runtimeManifests) {
  if (!RUNTIME_UI_CAPABILITIES[manifest.id as LLMProvider]) {
    throw new Error(`Runtime provider "${manifest.id}" is missing UI capability metadata.`);
  }
}
if (runtimeManifests.length !== Object.keys(RUNTIME_UI_CAPABILITIES).length) {
  throw new Error('Runtime UI capability metadata contains a provider without a supported chat manifest.');
}

/**
 * Application service exposing runtime UI details for providers whose support
 * status is owned by the provider manifest registry.
 */
export const providerCapabilitiesService = {
  getProviderCapabilities(provider: LLMProvider): ProviderCapabilities {
    providerRegistry.requireCapability(provider, 'chat');
    return { ...RUNTIME_UI_CAPABILITIES[provider], permissionModes: [...RUNTIME_UI_CAPABILITIES[provider].permissionModes] };
  },

  listAllProviderCapabilities(): ProviderCapabilities[] {
    return runtimeManifests.map((manifest) => {
      const capabilities = RUNTIME_UI_CAPABILITIES[manifest.id as LLMProvider];
      return { ...capabilities, permissionModes: [...capabilities.permissionModes] };
    });
  },

  listProviderManifests(): ProviderManifest[] {
    return providerRegistry.listManifests();
  },

  listProviderTemplates(): ProviderTemplate[] {
    return providerRegistry.listTemplates();
  },
};
