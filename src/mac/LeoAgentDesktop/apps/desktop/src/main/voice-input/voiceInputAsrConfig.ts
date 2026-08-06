import {
  LITELLM_REALTIME_TRANSCRIPTION_PATH,
  getVoiceInputAsrProfile,
  type VoiceInputAsrProfile,
  type VoiceInputProviderKind,
} from '../../shared/voiceInputAsrProfiles.js';

export {
  DEFAULT_VOICE_INPUT_ASR_PROVIDER_CHAIN,
  DEFAULT_VOICE_INPUT_PROVIDER_KIND,
  LITELLM_QWEN3_REALTIME_PCM_SAMPLE_RATE,
  LITELLM_QWEN3_REALTIME_TRANSCRIPTION_MODEL,
  LITELLM_QWEN3_REALTIME_TRANSCRIPTION_PATH,
  LITELLM_REALTIME_TRANSCRIPTION_MODEL,
  LITELLM_REALTIME_TRANSCRIPTION_PATH,
  LITELLM_TRANSCRIPTION_MODEL,
  OPENAI_REALTIME_TRANSCRIPTION_MODEL,
  SCRIBE_REALTIME_MODEL,
  VOICE_INPUT_ASR_PROFILES,
  estimateVoiceInputAsrCostUsd,
  getVoiceInputAsrProfile,
  getVoiceInputAsrProfiles,
  isLiteLlmProvider,
  isRealtimeAsrProvider,
  resolveVoiceInputProviderKindAlias,
  voiceInputProviderModel,
  type VoiceInputAsrProfile,
  type VoiceInputProviderKind,
} from '../../shared/voiceInputAsrProfiles.js';

export function buildProxyEndpointUrl(baseUrl: string, endpointPath: string): string {
  const base = new URL(baseUrl);
  const endpoint = new URL(endpointPath, 'https://placeholder.invalid');
  const basePath = base.pathname.replace(/\/+$/, '');
  base.pathname = `${basePath}${endpoint.pathname}`;
  base.search = endpoint.search;
  return base.toString();
}

export function buildLiteLlmRealtimeWebSocketUrl(
  baseUrl: string,
  endpointPath = LITELLM_REALTIME_TRANSCRIPTION_PATH,
): string {
  const url = new URL(buildProxyEndpointUrl(baseUrl, endpointPath));
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  return url.toString();
}

// Handshake-stage failures (issue #220: HTTP 404 when the effective XD
// gateway does not expose the provider-specific ASR passthrough routes) are
// undiagnosable without knowing which address was dialed. host + pathname is
// credential-free: auth rides in headers and the query only carries the model.
export function describeAsrWebSocketTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

// Gateway/upstream trace ids observed on XD LiteLLM and common fronting
// proxies. Surfacing one in the handshake error lets server-side logs be
// correlated without any client-side secret exposure.
const ASR_HANDSHAKE_TRACE_HEADERS = ['x-request-id', 'x-litellm-call-id', 'cf-ray'] as const;

export function describeAsrHandshakeTraceId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  for (const name of ASR_HANDSHAKE_TRACE_HEADERS) {
    const value = headers[name];
    const first = Array.isArray(value) ? value[0] : value;
    const trimmed = first?.trim();
    if (trimmed) return `${name}=${trimmed}`;
  }
  return null;
}

export function liteLlmRealtimeHeaders(profileOrProvider: VoiceInputAsrProfile | VoiceInputProviderKind): Record<string, string> {
  const profile = typeof profileOrProvider === 'string'
    ? getVoiceInputAsrProfile(profileOrProvider)
    : profileOrProvider;
  const headerModel = profile.realtime?.litellmHeaderModel;
  // Some LiteLLM passthroughs select the upstream model through a gateway
  // header (OpenAI passthrough); others select it in the endpoint query
  // (DashScope/Qwen). Keeping this on the profile prevents future models from
  // inheriting the wrong routing convention.
  return headerModel ? { 'x-litellm-model': headerModel } : {};
}
