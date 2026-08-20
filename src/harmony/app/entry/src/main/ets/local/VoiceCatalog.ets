export class VoiceTemplate {
  id: string = '';
  name: string = '';
  providerType: string = 'openAI';
  baseURL: string = '';
  appendV1: boolean = false;
  capability: string = 'BOTH';
  models: string[] = [];
  note: string = '';
}

export function voiceCapabilityLabel(capability: string): string {
  if (capability === 'TTS') {
    return '语音合成';
  }
  if (capability === 'ASR') {
    return '语音识别';
  }
  return '识别 + 合成';
}

export function voiceTemplates(): VoiceTemplate[] {
  return [
    voice('elevenlabs', 'ElevenLabs', 'openAI', 'https://api.elevenlabs.io', false, 'TTS',
      ['21m00Tcm4TlvDq8ikWAM', 'pNInz6obpgDQGcFmaJgB', 'EXAVITQu4vr4xnSDxMaL', 'ErXwobaYiN019PkySvjV'], ''),
    voice('deepgram', 'Deepgram', 'openAI', 'https://api.deepgram.com', false, 'BOTH',
      ['nova-2', 'nova-3', 'aura-asteria-en', 'aura-luna-en'], ''),
    voice('minimax', 'MiniMax', 'anthropic', 'https://api.minimax.io', false, 'TTS',
      ['speech-2.8-hd', 'speech-2.8-turbo'], ''),
    voice('alibaba', 'Alibaba Bailian', 'openAI', 'https://dashscope.aliyuncs.com/compatible-mode', true, 'BOTH',
      ['paraformer-realtime-v2', 'cosyvoice-v2'], ''),
    voice('doubao', 'Doubao (Volcano)', 'openAI', 'https://openspeech.bytedance.com', false, 'BOTH',
      ['bigmodel', 'zh_female_cancan_uranus_bigtts', 'zh_male_liufei_uranus_bigtts'], '用火山引擎新控制台的 API Key。'),
    voice('xunfei', 'iFlytek (Xunfei)', 'openAI', 'https://iat-api.xfyun.cn', false, 'BOTH',
      ['iat', 'xiaoyan', 'aisjiuxu'], '讯飞钥匙写成 appId;apiKey;apiSecret。'),
    voice('mimo', 'Xiaomi MiMo', 'openAI', 'https://api.xiaomimimo.com', true, 'BOTH',
      ['mimo-v2.5-asr', 'mimo_default', '冰糖', '茉莉'], '')
  ];
}

function voice(id: string, name: string, providerType: string, baseURL: string, appendV1: boolean,
  capability: string, models: string[], note: string): VoiceTemplate {
  const row = new VoiceTemplate();
  row.id = id;
  row.name = name;
  row.providerType = providerType;
  row.baseURL = baseURL;
  row.appendV1 = appendV1;
  row.capability = capability;
  row.models = models;
  row.note = note;
  return row;
}
