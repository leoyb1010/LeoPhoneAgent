export function isInvalidEncryptedContentError(message: string | null | undefined): boolean {
  return /invalid_encrypted_content/i.test(message ?? '');
}
