import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../../../utils/apiClient';
import type {
  ApiKeyItem,
  ApiKeysResponse,
  CreatedApiKey,
  GithubCredentialItem,
  GithubCredentialsResponse,
} from '../view/tabs/api-settings/types';
import { copyTextToClipboard } from '../../../utils/clipboard';

type UseCredentialsSettingsArgs = {
  confirmDeleteApiKeyText: string;
  confirmDeleteGithubCredentialText: string;
};

const requireSuccess = <T extends { success?: boolean; error?: string }>(payload: T, fallback: string): T => {
  if (payload.success === false) {
    throw new Error(payload.error || fallback);
  }
  return payload;
};

export function useCredentialsSettings({
  confirmDeleteApiKeyText,
  confirmDeleteGithubCredentialText,
}: UseCredentialsSettingsArgs) {
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [githubCredentials, setGithubCredentials] = useState<GithubCredentialItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');

  const [showNewGithubForm, setShowNewGithubForm] = useState(false);
  const [newGithubName, setNewGithubName] = useState('');
  const [newGithubToken, setNewGithubToken] = useState('');
  const [newGithubDescription, setNewGithubDescription] = useState('');

  const [showToken, setShowToken] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<CreatedApiKey | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);

      const [apiKeysPayload, credentialsPayload] = await Promise.all([
        apiClient.get<ApiKeysResponse>('/api/settings/api-keys'),
        apiClient.get<GithubCredentialsResponse>('/api/settings/credentials', { type: 'github_token' }),
      ]);

      setApiKeys(apiKeysPayload.apiKeys || []);
      setGithubCredentials(credentialsPayload.credentials || []);
    } catch (error) {
      console.error('Error fetching settings:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  const createApiKey = useCallback(async () => {
    if (!newKeyName.trim()) {
      return;
    }

    try {
      const payload = requireSuccess(
        await apiClient.post<ApiKeysResponse>('/api/settings/api-keys', { keyName: newKeyName.trim() }),
        'Failed to create API key',
      );

      if (payload.apiKey) {
        setNewlyCreatedKey(payload.apiKey);
      }
      setNewKeyName('');
      setShowNewKeyForm(false);
      await fetchData();
    } catch (error) {
      console.error('Error creating API key:', error);
    }
  }, [fetchData, newKeyName]);

  const deleteApiKey = useCallback(async (keyId: string) => {
    if (!window.confirm(confirmDeleteApiKeyText)) {
      return;
    }

    try {
      requireSuccess(
        await apiClient.delete<ApiKeysResponse>(`/api/settings/api-keys/${encodeURIComponent(keyId)}`),
        'Failed to delete API key',
      );

      await fetchData();
    } catch (error) {
      console.error('Error deleting API key:', error);
    }
  }, [confirmDeleteApiKeyText, fetchData]);

  const toggleApiKey = useCallback(async (keyId: string, isActive: boolean) => {
    try {
      requireSuccess(
        await apiClient.patch<ApiKeysResponse>(
          `/api/settings/api-keys/${encodeURIComponent(keyId)}/toggle`,
          { isActive: !isActive },
        ),
        'Failed to toggle API key',
      );

      await fetchData();
    } catch (error) {
      console.error('Error toggling API key:', error);
    }
  }, [fetchData]);

  const createGithubCredential = useCallback(async () => {
    if (!newGithubName.trim() || !newGithubToken.trim()) {
      return;
    }

    try {
      requireSuccess(
        await apiClient.post<GithubCredentialsResponse>('/api/settings/credentials', {
          credentialName: newGithubName.trim(),
          credentialType: 'github_token',
          credentialValue: newGithubToken,
          description: newGithubDescription.trim(),
        }),
        'Failed to create GitHub credential',
      );

      setNewGithubName('');
      setNewGithubToken('');
      setNewGithubDescription('');
      setShowNewGithubForm(false);
      setShowToken((prev) => ({ ...prev, new: false }));
      await fetchData();
    } catch (error) {
      console.error('Error creating GitHub credential:', error);
    }
  }, [fetchData, newGithubDescription, newGithubName, newGithubToken]);

  const deleteGithubCredential = useCallback(async (credentialId: string) => {
    if (!window.confirm(confirmDeleteGithubCredentialText)) {
      return;
    }

    try {
      requireSuccess(
        await apiClient.delete<GithubCredentialsResponse>(
          `/api/settings/credentials/${encodeURIComponent(credentialId)}`,
        ),
        'Failed to delete GitHub credential',
      );

      await fetchData();
    } catch (error) {
      console.error('Error deleting GitHub credential:', error);
    }
  }, [confirmDeleteGithubCredentialText, fetchData]);

  const toggleGithubCredential = useCallback(async (credentialId: string, isActive: boolean) => {
    try {
      requireSuccess(
        await apiClient.patch<GithubCredentialsResponse>(
          `/api/settings/credentials/${encodeURIComponent(credentialId)}/toggle`,
          { isActive: !isActive },
        ),
        'Failed to toggle GitHub credential',
      );

      await fetchData();
    } catch (error) {
      console.error('Error toggling GitHub credential:', error);
    }
  }, [fetchData]);

  const copyToClipboard = useCallback(async (text: string, id: string) => {
    try {
      await copyTextToClipboard(text);
      setCopiedKey(id);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  }, []);

  const dismissNewlyCreatedKey = useCallback(() => {
    setNewlyCreatedKey(null);
  }, []);

  const cancelNewApiKeyForm = useCallback(() => {
    setShowNewKeyForm(false);
    setNewKeyName('');
  }, []);

  const cancelNewGithubForm = useCallback(() => {
    setShowNewGithubForm(false);
    setNewGithubName('');
    setNewGithubToken('');
    setNewGithubDescription('');
    setShowToken((prev) => ({ ...prev, new: false }));
  }, []);

  const toggleNewGithubTokenVisibility = useCallback(() => {
    setShowToken((prev) => ({ ...prev, new: !prev.new }));
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return {
    apiKeys,
    githubCredentials,
    loading,
    showNewKeyForm,
    setShowNewKeyForm,
    newKeyName,
    setNewKeyName,
    showNewGithubForm,
    setShowNewGithubForm,
    newGithubName,
    setNewGithubName,
    newGithubToken,
    setNewGithubToken,
    newGithubDescription,
    setNewGithubDescription,
    showToken,
    copiedKey,
    newlyCreatedKey,
    createApiKey,
    deleteApiKey,
    toggleApiKey,
    createGithubCredential,
    deleteGithubCredential,
    toggleGithubCredential,
    copyToClipboard,
    dismissNewlyCreatedKey,
    cancelNewApiKeyForm,
    cancelNewGithubForm,
    toggleNewGithubTokenVisibility,
  };
}
