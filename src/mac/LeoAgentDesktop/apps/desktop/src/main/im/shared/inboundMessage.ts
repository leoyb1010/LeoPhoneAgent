import type { UserContentBlock, UserMessage } from '@cindy/maker-core';
import type { IMAttachment } from '@cindy/im';

const TAKEOVER_DELIVERY_CONTEXT =
  '<cindy_delivery_context>' +
  'Reply normally to the user message in this turn. LeoAgent automatically delivers your final response ' +
  'to the conversation that sent it. Do not ask the user to configure a bot, webhook, or outbound ' +
  'integration, and do not use a proactive outbound tool unless the user explicitly requests a separate ' +
  'outbound message. This delivery rule is transport-independent; never infer a persistent destination ' +
  'from earlier turns.' +
  '</cindy_delivery_context>';

/**
 * Build the model-facing message for an IM turn.
 *
 * Attached desktop sessions are created without channel vendor options, so the
 * model needs to know that normal replies are already delivered. Native agents
 * may retain this UserMessage in their own history; consequently the hint is a
 * transport-invariant rule and deliberately contains no vendor or destination.
 * The local transcript still receives the original user text in turnRunner.
 */
export function buildImUserMessage(
  text: string,
  attachments: IMAttachment[],
  attachedTakeover = false,
): UserMessage {
  const deliveryContext = attachedTakeover ? TAKEOVER_DELIVERY_CONTEXT : null;

  if (attachments.length === 0) {
    return {
      type: 'user',
      content: deliveryContext ? `${deliveryContext}\n\n${text}` : text,
    };
  }

  const blocks: UserContentBlock[] = [];
  if (deliveryContext) blocks.push({ type: 'text', text: deliveryContext });
  if (text) blocks.push({ type: 'text', text });
  for (const att of attachments) {
    blocks.push({
      type: att.kind === 'image' ? 'image' : 'file',
      path: att.absPath,
      mimeType: att.mimeType,
    });
  }
  return { type: 'user', content: blocks };
}
