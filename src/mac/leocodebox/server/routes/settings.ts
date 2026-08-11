import express from 'express';
import type { Response } from 'express';

import {
  apiKeysDb,
  appConfigDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
} from '../modules/database/index.js';
import { getPublicKey } from '../services/vapid-keys.js';
import { createNotificationEvent, notifyUserIfEnabled } from '../services/notification-orchestrator.js';
import { IS_LOCAL_ONLY_AUTH } from '../middleware/auth.js';

const router = express.Router();

type AppPreferences = {
  language: string; defaultProvider: string; defaultModel: string; permissionMode: string;
  density: string; accent: string; reduceMotion: boolean;
};


const DEFAULT_APP_PREFERENCES = Object.freeze({
  language: 'zh-CN',
  defaultProvider: 'codex',
  defaultModel: '',
  permissionMode: 'default',
  density: 'compact',
  accent: 'blue',
  reduceMotion: false,
});

const PREFERENCE_ENUMS = Object.freeze({
  language: new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'it', 'ru', 'tr']),
  defaultProvider: new Set(['claude', 'cursor', 'codex', 'opencode', 'grok']),
  permissionMode: new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto']),
  density: new Set(['compact', 'comfortable']),
  accent: new Set(['blue', 'green', 'amber']),
});

function getPreferencesKey(userId: number): string {
  return `user_preferences:${userId}`;
}

function sanitizePreferences(input: unknown, current: AppPreferences = DEFAULT_APP_PREFERENCES): AppPreferences {
  const source: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const result: AppPreferences = { ...DEFAULT_APP_PREFERENCES, ...current };

  for (const [key, allowed] of Object.entries(PREFERENCE_ENUMS)) {
    if (typeof source[key] === 'string' && allowed.has(source[key] as string)) result[key as keyof AppPreferences] = source[key] as never;
  }
  if (typeof source.defaultModel === 'string' && source.defaultModel.length <= 160) {
    result.defaultModel = source.defaultModel.trim();
  }
  if (typeof source.reduceMotion === 'boolean') result.reduceMotion = source.reduceMotion;
  return result;
}

function readAppPreferences(userId: number): AppPreferences {
  const stored = appConfigDb.get(getPreferencesKey(userId));
  if (!stored) return { ...DEFAULT_APP_PREFERENCES };
  try {
    return sanitizePreferences(JSON.parse(stored));
  } catch {
    return { ...DEFAULT_APP_PREFERENCES };
  }
}

function rejectWebPushInLocalOnly(res: Response) {
  return res.status(404).json({ error: 'Web push notifications are disabled in local-only mode.' });
}

// Local, single-machine product preferences. The app_config repository is
// SQLite-backed and already participates in startup migrations and backups.
router.get('/preferences', (req, res) => {
  res.json({ success: true, preferences: readAppPreferences(req.user.id) });
});

router.put('/preferences', (req, res) => {
  try {
    const preferences = sanitizePreferences(req.body, readAppPreferences(req.user.id));
    appConfigDb.set(getPreferencesKey(req.user.id), JSON.stringify(preferences));
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving app preferences:', error);
    res.status(500).json({ error: 'Failed to save app preferences' });
  }
});

// ===============================
// API Keys Management
// ===============================

// Get all API keys for the authenticated user
router.get('/api-keys', async (req, res) => {
  try {
    const apiKeys = apiKeysDb.getApiKeys(req.user.id);
    // Don't send the full API key in the list for security
    // Stored keys are hashes; the display prefix carries the recognizable part.
    const sanitizedKeys = apiKeys.map(key => ({
      ...key,
      api_key: (key.key_prefix || key.api_key.substring(0, 10)) + '...'
    }));
    res.json({ apiKeys: sanitizedKeys });
  } catch (error) {
    console.error('Error fetching API keys:', error);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// Create a new API key
router.post('/api-keys', async (req, res) => {
  try {
    const { keyName } = req.body;

    if (!keyName || !keyName.trim()) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const result = apiKeysDb.createApiKey(req.user.id, keyName.trim());
    res.json({
      success: true,
      apiKey: result
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// Delete an API key
router.delete('/api-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const success = apiKeysDb.deleteApiKey(req.user.id, parseInt(keyId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error deleting API key:', error);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
});

// Toggle API key active status
router.patch('/api-keys/:keyId/toggle', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = apiKeysDb.toggleApiKey(req.user.id, parseInt(keyId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'API key not found' });
    }
  } catch (error) {
    console.error('Error toggling API key:', error);
    res.status(500).json({ error: 'Failed to toggle API key' });
  }
});

// ===============================
// Generic Credentials Management
// ===============================

// Get all credentials for the authenticated user (optionally filtered by type)
router.get('/credentials', async (req, res) => {
  try {
    const { type } = req.query;
    const credentials = credentialsDb.getCredentials(req.user.id, typeof type === 'string' ? type : null);
    // Don't send the actual credential values for security
    res.json({ credentials });
  } catch (error) {
    console.error('Error fetching credentials:', error);
    res.status(500).json({ error: 'Failed to fetch credentials' });
  }
});

// Create a new credential
router.post('/credentials', async (req, res) => {
  try {
    const { credentialName, credentialType, credentialValue, description } = req.body;

    if (!credentialName || !credentialName.trim()) {
      return res.status(400).json({ error: 'Credential name is required' });
    }

    if (!credentialType || !credentialType.trim()) {
      return res.status(400).json({ error: 'Credential type is required' });
    }

    if (!credentialValue || !credentialValue.trim()) {
      return res.status(400).json({ error: 'Credential value is required' });
    }

    const result = credentialsDb.createCredential(
      req.user.id,
      credentialName.trim(),
      credentialType.trim(),
      credentialValue.trim(),
      description?.trim() || null
    );

    res.json({
      success: true,
      credential: result
    });
  } catch (error) {
    console.error('Error creating credential:', error);
    res.status(500).json({ error: 'Failed to create credential' });
  }
});

// Delete a credential
router.delete('/credentials/:credentialId', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const success = credentialsDb.deleteCredential(req.user.id, parseInt(credentialId));

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error deleting credential:', error);
    res.status(500).json({ error: 'Failed to delete credential' });
  }
});

// Toggle credential active status
router.patch('/credentials/:credentialId/toggle', async (req, res) => {
  try {
    const { credentialId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    const success = credentialsDb.toggleCredential(req.user.id, parseInt(credentialId), isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Credential not found' });
    }
  } catch (error) {
    console.error('Error toggling credential:', error);
    res.status(500).json({ error: 'Failed to toggle credential' });
  }
});

// ===============================
// Notification Preferences
// ===============================

router.get('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.getPreferences(req.user.id);
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error fetching notification preferences:', error);
    res.status(500).json({ error: 'Failed to fetch notification preferences' });
  }
});

router.put('/notification-preferences', async (req, res) => {
  try {
    const preferences = notificationPreferencesDb.updatePreferences(req.user.id, req.body || {});
    res.json({ success: true, preferences });
  } catch (error) {
    console.error('Error saving notification preferences:', error);
    res.status(500).json({ error: 'Failed to save notification preferences' });
  }
});

// ===============================
// Push Subscription Management
// ===============================

router.get('/push/vapid-public-key', async (req, res) => {
  if (IS_LOCAL_ONLY_AUTH) return rejectWebPushInLocalOnly(res);

  try {
    const publicKey = getPublicKey();
    res.json({ publicKey });
  } catch (error) {
    console.error('Error fetching VAPID public key:', error);
    res.status(500).json({ error: 'Failed to fetch VAPID public key' });
  }
});

router.post('/push/subscribe', async (req, res) => {
  if (IS_LOCAL_ONLY_AUTH) return rejectWebPushInLocalOnly(res);

  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing subscription fields' });
    }
    pushSubscriptionsDb.saveSubscription(req.user.id, endpoint, keys.p256dh, keys.auth);

    // Enable webPush in preferences so the confirmation goes through the full pipeline
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (!currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs?.channels, webPush: true },
      });
    }

    res.json({ success: true });

    // Send a confirmation push through the full notification pipeline
    const event = createNotificationEvent({
      provider: 'system',
      kind: 'info',
      code: 'push.enabled',
      meta: { message: 'Push notifications are now enabled!' },
      severity: 'info'
    });
    notifyUserIfEnabled({ userId: req.user.id, event });
  } catch (error) {
    console.error('Error saving push subscription:', error);
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

router.post('/push/unsubscribe', async (req, res) => {
  if (IS_LOCAL_ONLY_AUTH) return rejectWebPushInLocalOnly(res);

  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'Missing endpoint' });
    }
    pushSubscriptionsDb.removeSubscription(endpoint);

    // Disable webPush in preferences to match subscription state
    const currentPrefs = notificationPreferencesDb.getPreferences(req.user.id);
    if (currentPrefs?.channels?.webPush) {
      notificationPreferencesDb.updatePreferences(req.user.id, {
        ...currentPrefs,
        channels: { ...currentPrefs.channels, webPush: false },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing push subscription:', error);
    res.status(500).json({ error: 'Failed to remove push subscription' });
  }
});

export default router;
