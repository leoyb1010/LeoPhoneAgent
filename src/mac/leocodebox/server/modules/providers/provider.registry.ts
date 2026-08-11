import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { GrokProvider } from '@/modules/providers/list/grok/grok.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { CHAT_PROVIDER_IDS, PROVIDER_MANIFESTS, PROVIDER_TEMPLATES } from '@/modules/providers/provider.manifests.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderCapabilityName,
  ProviderId,
  ProviderManifest,
  ProviderTemplate,
  ProviderTemplateId,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const providers = new Map<LLMProvider, IProvider>([
  ['claude', new ClaudeProvider()],
  ['codex', new CodexProvider()],
  ['cursor', new CursorProvider()],
  ['opencode', new OpenCodeProvider()],
  ['grok', new GrokProvider()],
]);

const manifests = new Map<ProviderId, ProviderManifest>();
for (const manifest of PROVIDER_MANIFESTS) {
  if (manifests.has(manifest.id)) {
    throw new Error(`Duplicate provider manifest "${manifest.id}".`);
  }
  if (manifest.runtimeProvider && manifest.runtimeProvider !== manifest.id) {
    throw new Error(`Provider manifest "${manifest.id}" has a mismatched runtime provider.`);
  }
  manifests.set(manifest.id, manifest);
}

for (const provider of providers.keys()) {
  const manifest = manifests.get(provider);
  if (!manifest || manifest.runtimeProvider !== provider || manifest.capabilities.chat !== 'supported') {
    throw new Error(`Runtime provider "${provider}" does not have a matching supported manifest.`);
  }
}

for (const provider of CHAT_PROVIDER_IDS) {
  if (!providers.has(provider)) {
    throw new Error(`Supported chat manifest "${provider}" does not have a runtime provider adapter.`);
  }
}

const templates = new Map<ProviderTemplateId, ProviderTemplate>();
for (const template of PROVIDER_TEMPLATES) {
  if (templates.has(template.id)) {
    throw new Error(`Duplicate provider template "${template.id}".`);
  }
  templates.set(template.id, template);
}

function capabilityError(provider: ProviderId, capability: ProviderCapabilityName): AppError {
  const status = manifests.get(provider)?.capabilities[capability] ?? 'unsupported';
  const code = status === 'unverified'
    ? 'PROVIDER_CAPABILITY_UNVERIFIED'
    : status === 'unavailable'
      ? 'PROVIDER_CAPABILITY_UNAVAILABLE'
      : 'PROVIDER_CAPABILITY_UNSUPPORTED';
  return new AppError(`Provider "${provider}" does not have a usable ${capability} capability.`, {
    code,
    statusCode: 400,
  });
}

/** Central registry for provider metadata and concrete operational adapters. */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return Array.from(providers.values());
  },

  listManifests(options?: { includeHidden?: boolean }): ProviderManifest[] {
    return Array.from(manifests.values())
      .filter((manifest) => options?.includeHidden || manifest.visibility !== 'hidden')
      .sort((a, b) => a.order - b.order)
      .map((manifest) => ({ ...manifest, capabilities: { ...manifest.capabilities } }));
  },

  listTemplates(): ProviderTemplate[] {
    return Array.from(templates.values(), (template) => ({ ...template }));
  },

  resolveTemplate(templateId: string): ProviderTemplate {
    const template = templates.get(templateId as ProviderTemplateId);
    if (!template) {
      throw new AppError(`Unsupported provider template "${templateId}".`, {
        code: 'UNSUPPORTED_PROVIDER_TEMPLATE',
        statusCode: 400,
      });
    }
    return template;
  },

  resolveManifest(provider: string): ProviderManifest {
    const manifest = manifests.get(provider as ProviderId);
    if (!manifest) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }
    return manifest;
  },

  hasCapability(provider: string, capability: ProviderCapabilityName): boolean {
    return providerRegistry.resolveManifest(provider).capabilities[capability] === 'supported';
  },

  requireCapability(provider: string, capability: ProviderCapabilityName): ProviderManifest {
    const manifest = providerRegistry.resolveManifest(provider);
    if (manifest.capabilities[capability] !== 'supported') {
      throw capabilityError(manifest.id, capability);
    }
    return manifest;
  },

  resolveProvider(provider: string): IProvider {
    providerRegistry.requireCapability(provider, 'chat');
    const resolvedProvider = providers.get(provider as LLMProvider);
    if (!resolvedProvider) {
      throw capabilityError(provider as ProviderId, 'chat');
    }
    return resolvedProvider;
  },
};
