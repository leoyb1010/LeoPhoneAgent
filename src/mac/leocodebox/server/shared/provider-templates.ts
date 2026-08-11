import type { ProviderTemplate } from './types.js';

// Shared provider-template metadata consumed by both the TypeScript registry and legacy JS routes.
// Keep execution details (targets, CLI commands, config writers) out of this catalog.

export const PROVIDER_TEMPLATES = [
  { id: 'anthropic', name: 'Anthropic', vendor: 'Anthropic', target: 'claude', baseUrl: 'https://api.anthropic.com', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://console.anthropic.com/' },
  { id: 'openai', name: 'OpenAI', vendor: 'OpenAI', target: 'codex', baseUrl: 'https://api.openai.com/v1', defaultModel: '', wireApi: 'responses', status: 'verified', docsUrl: 'https://platform.openai.com/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', vendor: 'DeepSeek', target: 'codex', baseUrl: 'https://api.deepseek.com/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', name: 'Kimi / Moonshot', vendor: 'Moonshot', target: 'codex', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', name: 'GLM / 智谱', vendor: 'Zhipu AI', target: 'codex', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'qwen', name: 'Qwen / DashScope', vendor: 'Alibaba Cloud', target: 'codex', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'minimax', name: 'MiniMax', vendor: 'MiniMax', target: 'codex', baseUrl: 'https://api.minimax.chat/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://platform.minimaxi.com/' },
  { id: 'siliconflow', name: 'SiliconFlow', vendor: 'SiliconFlow', target: 'codex', baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'openrouter', name: 'OpenRouter', vendor: 'OpenRouter', target: 'codex', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'groq', name: 'Groq', vendor: 'Groq', target: 'codex', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://console.groq.com/keys' },
  { id: 'xai', name: 'xAI / Grok', vendor: 'xAI', target: 'codex', baseUrl: 'https://api.x.ai/v1', defaultModel: '', wireApi: 'chat', status: 'beta', docsUrl: 'https://console.x.ai/' },
  { id: 'volcengine', name: '火山方舟', vendor: 'Volcengine', target: 'codex', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://console.volcengine.com/ark' },
  { id: 'gemini', name: 'Google Gemini', vendor: 'Google', target: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', defaultModel: '', wireApi: 'chat', status: 'verified', docsUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openai-compatible', name: 'OpenAI Compatible', vendor: 'Custom', target: 'codex', baseUrl: 'https://api.example.com/v1', defaultModel: '', wireApi: 'chat', status: 'preview' },
  { id: 'opencode-compatible', name: 'OpenCode Compatible', vendor: 'Custom', target: 'opencode', baseUrl: 'https://api.example.com/v1', defaultModel: '', wireApi: 'chat', status: 'preview' },
  { id: 'hermes-compatible', name: 'Hermes Compatible', vendor: 'Custom', target: 'hermes', baseUrl: 'https://api.example.com/v1', defaultModel: '', wireApi: 'chat', status: 'preview' },
] satisfies ProviderTemplate[];
