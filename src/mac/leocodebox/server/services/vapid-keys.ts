import webPush from 'web-push';

import { logger } from '@/modules/logging/index.js';

import { getConnection } from '../modules/database/connection.js';

type VapidKeys = { publicKey: string; privateKey: string };
let cachedKeys: VapidKeys | null = null;
const db = getConnection();

function ensureVapidKeys(): VapidKeys {
  if (cachedKeys) return cachedKeys;

  const row = db.prepare('SELECT public_key, private_key FROM vapid_keys ORDER BY id DESC LIMIT 1').get() as { public_key: string; private_key: string } | undefined;
  if (row) {
    cachedKeys = { publicKey: row.public_key, privateKey: row.private_key };
    return cachedKeys;
  }

  const keys = webPush.generateVAPIDKeys();
  db.prepare('INSERT INTO vapid_keys (public_key, private_key) VALUES (?, ?)').run(keys.publicKey, keys.privateKey);
  cachedKeys = keys;
  return cachedKeys;
}

function getPublicKey(): string {
  return ensureVapidKeys().publicKey;
}

function configureWebPush(): void {
  const keys = ensureVapidKeys();
  webPush.setVapidDetails(
    'mailto:noreply@leocodebox.local',
    keys.publicKey,
    keys.privateKey
  );
  logger.info('Web Push notifications configured');
}

export { ensureVapidKeys, getPublicKey, configureWebPush };
