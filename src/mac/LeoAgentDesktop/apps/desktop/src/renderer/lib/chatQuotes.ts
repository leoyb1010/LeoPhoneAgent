/**
 * Renderer compatibility layer for chat quote wire-format helpers.
 *
 * Keep desktop on the shared implementation so encoding / parsing stays
 * byte-for-byte aligned with mobile and maker-shared tests.
 */
export * from '@cindy/maker-shared/chat-quotes';
