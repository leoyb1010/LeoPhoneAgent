declare module 'web-push' {
  type PushSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  type WebPushError = Error & { statusCode?: number };
  type VapidKeys = { publicKey: string; privateKey: string };
  const webPush: {
    sendNotification(subscription: PushSubscription, payload?: string): Promise<unknown>;
    generateVAPIDKeys(): VapidKeys;
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  };
  export default webPush;
}
