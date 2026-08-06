import type {
  ConversationSearchRequest,
  ConversationSearchResponse,
} from '../../shared/conversationSearch';
import { ApiError } from '@/lib/httpClient';
import { extractIpcError } from '@/utils/ipcError';

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((err: unknown) => {
    const ipcError = extractIpcError(err);
    if (ipcError) {
      throw new ApiError(ipcError.code, 0, ipcError.message);
    }
    if (err instanceof Error) {
      throw new ApiError('UNKNOWN', 0, err.message);
    }
    throw new ApiError('UNKNOWN', 0, String(err));
  });
}

export function searchConversations(
  request: ConversationSearchRequest,
): Promise<ConversationSearchResponse> {
  return wrap(window.electronAPI.localDb.conversations.search(request));
}
