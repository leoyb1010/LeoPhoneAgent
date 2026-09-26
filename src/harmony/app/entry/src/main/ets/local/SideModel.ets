import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { OpenAICompatClient, StreamTurn } from './OpenAICompatClient';
import { FailoverSlot, LoopTurn } from './LocalProtocol';
import { providerStore } from '../store/ProviderStore';

/**
 * 只要一段文字的旁路请求:写压缩摘要、起标题。不带工具、不显示过程,按当前服务商顺序试,
 * 一个不行换下一个;都不行返回空字符串,调用方照旧(标题保持原样,压缩退回直接截断)。
 * ponytail: iOS 用单独的便宜模型槽做这两件事;鸿蒙没有这个设置,用当前模型。
 */
export class SideModel {
  static async complete(context: common.Context, systemPrompt: string, userText: string): Promise<string> {
    await providerStore.ensureLoaded(context);
    const queue: FailoverSlot[] = providerStore.queue();
    for (let i = 0; i < queue.length; i++) {
      const slot = queue[i];
      try {
        const client = await OpenAICompatClient.open(providerStore.slotRoot(slot.instanceId),
          providerStore.keyFor(slot.instanceId), slot.model, providerStore.slotType(slot.instanceId),
          providerStore.slotCredential(slot.instanceId), slot.instanceId);
        const text = await SideModel.collect(client, systemPrompt, userText);
        if (text.trim().length > 0) {
          return text.trim();
        }
      } catch (_err) {
        // 换下一个服务商
      }
    }
    return '';
  }

  private static collect(client: OpenAICompatClient, systemPrompt: string, userText: string): Promise<string> {
    return new Promise<string>((resolve: (text: string) => void, reject: (err: Error) => void) => {
      const turn = new LoopTurn();
      turn.role = 'user';
      turn.content = userText;
      let req: http.HttpRequest | null = null;
      const release = (): void => {
        // 在请求自己的回调里,推到下一轮再销毁
        setTimeout(() => {
          try {
            req?.destroy();
          } catch (_err) {
            // 已经销毁
          }
        }, 0);
      };
      req = client.streamTurn([turn], systemPrompt, '', () => {
        // 不显示过程
      }, (done: StreamTurn) => {
        release();
        resolve(done.text);
      }, (message: string) => {
        release();
        reject(new Error(message));
      }, false);
    });
  }
}
