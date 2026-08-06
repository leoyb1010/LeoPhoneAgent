import { createContext, useContext, type ReactNode } from 'react';

import type { SessionChatState } from '@/lib/makerChatStore';

export type ChatDisplaySnapshot = Pick<
  SessionChatState,
  | 'messages'
  | 'historyLoaded'
  | 'hasMoreMessages'
> & {
  sessionId?: string;
  /** true 表示当前展示快照仍实时推进；false 表示隐藏 pane 正在使用冻结快照。 */
  chatRealtime: boolean;
};

const ChatDisplaySnapshotContext = createContext<ChatDisplaySnapshot | null>(null);

export function ChatDisplaySnapshotProvider({
  value,
  children,
}: {
  value: ChatDisplaySnapshot;
  children: ReactNode;
}) {
  return (
    <ChatDisplaySnapshotContext.Provider value={value}>
      {children}
    </ChatDisplaySnapshotContext.Provider>
  );
}

export function useChatDisplaySnapshot(sessionId: string | undefined): ChatDisplaySnapshot | null {
  const snapshot = useContext(ChatDisplaySnapshotContext);
  if (!snapshot) return null;
  return snapshot.sessionId === sessionId ? snapshot : null;
}
