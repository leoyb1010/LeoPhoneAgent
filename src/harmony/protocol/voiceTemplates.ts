export type VoiceTemplate = {
  id: string
  name: string
  providerType: string
  baseURL: string
  appendV1: boolean
  capability: string
  models: string[]
  note: string
}

export function voiceCapabilityLabel(capability: string): string {
  if (capability === "TTS") return "语音合成"
  if (capability === "ASR") return "语音识别"
  return "识别 + 合成"
}

export function voiceTemplates(): VoiceTemplate[] {
  return [
    {
      id: "elevenlabs",
      name: "ElevenLabs",
      providerType: "openAI",
      baseURL: "https://api.elevenlabs.io",
      appendV1: false,
      capability: "TTS",
      models: ["21m00Tcm4TlvDq8ikWAM", "pNInz6obpgDQGcFmaJgB", "EXAVITQu4vr4xnSDxMaL", "ErXwobaYiN019PkySvjV"],
      note: "",
    },
    {
      id: "deepgram",
      name: "Deepgram",
      providerType: "openAI",
      baseURL: "https://api.deepgram.com",
      appendV1: false,
      capability: "BOTH",
      models: ["nova-2", "nova-3", "aura-asteria-en", "aura-luna-en"],
      note: "",
    },
    {
      id: "minimax",
      name: "MiniMax",
      providerType: "anthropic",
      baseURL: "https://api.minimax.io",
      appendV1: false,
      capability: "TTS",
      models: ["speech-2.8-hd", "speech-2.8-turbo"],
      note: "",
    },
    {
      id: "alibaba",
      name: "Alibaba Bailian",
      providerType: "openAI",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode",
      appendV1: true,
      capability: "BOTH",
      models: ["paraformer-realtime-v2", "cosyvoice-v2"],
      note: "",
    },
    {
      id: "doubao",
      name: "Doubao (Volcano)",
      providerType: "openAI",
      baseURL: "https://openspeech.bytedance.com",
      appendV1: false,
      capability: "BOTH",
      models: ["bigmodel", "zh_female_cancan_uranus_bigtts", "zh_male_liufei_uranus_bigtts"],
      note: "用火山引擎新控制台的 API Key。",
    },
    {
      id: "xunfei",
      name: "iFlytek (Xunfei)",
      providerType: "openAI",
      baseURL: "https://iat-api.xfyun.cn",
      appendV1: false,
      capability: "BOTH",
      models: ["iat", "xiaoyan", "aisjiuxu"],
      note: "讯飞钥匙写成 appId;apiKey;apiSecret。",
    },
    {
      id: "mimo",
      name: "Xiaomi MiMo",
      providerType: "openAI",
      baseURL: "https://api.xiaomimimo.com",
      appendV1: true,
      capability: "BOTH",
      models: ["mimo-v2.5-asr", "mimo_default", "冰糖", "茉莉"],
      note: "",
    },
  ]
}

export function matchVoiceTemplate(baseURL: string): VoiceTemplate | null {
  const base = baseURL.trim().toLowerCase()
  if (!base) return null
  const rows = voiceTemplates()
  for (const row of rows) {
    if (base.indexOf(row.id) >= 0 || base.indexOf(row.baseURL.replace("https://", "")) >= 0) {
      return row
    }
  }
  return null
}
