import { useCallback, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { useDropzone } from 'react-dropzone';

const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_COUNT = 5;

export type ImageAttachmentValidation =
  | { valid: true }
  | { valid: false; error?: string };

export function validateImageAttachment(file: File | null | undefined): ImageAttachmentValidation {
  if (!file || typeof file !== 'object') {
    return { valid: false };
  }
  if (!file.type?.startsWith('image/')) {
    return { valid: false };
  }
  if (!file.size || file.size > MAX_IMAGE_SIZE_BYTES) {
    return { valid: false, error: 'File too large (max 5MB)' };
  }
  return { valid: true };
}

export function useChatImageAttachments() {
  const [attachedImages, setAttachedImages] = useState<File[]>([]);
  const [uploadingImages, setUploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors, setImageErrors] = useState<Map<string, string>>(new Map());

  const handleImageFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        const validation = validateImageAttachment(file);
        if (!validation.valid && validation.error) {
          const fileName = file?.name || 'Unknown file';
          setImageErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, validation.error!);
            return next;
          });
        }
        return validation.valid;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedImages((previous) => [...previous, ...validFiles].slice(0, MAX_IMAGE_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file) handleImageFiles([file]);
      }

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        handleImageFiles(Array.from(event.clipboardData.files));
      }
    },
    [handleImageFiles],
  );

  const dropzone = useDropzone({
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'],
    },
    maxSize: MAX_IMAGE_SIZE_BYTES,
    maxFiles: MAX_IMAGE_COUNT,
    onDrop: handleImageFiles,
    noClick: true,
    noKeyboard: true,
  });

  const resetImageAttachments = useCallback(() => {
    setAttachedImages([]);
    setUploadingImages(new Map());
    setImageErrors(new Map());
  }, []);

  return {
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    handlePaste,
    resetImageAttachments,
    getRootProps: dropzone.getRootProps,
    getInputProps: dropzone.getInputProps,
    isDragActive: dropzone.isDragActive,
    openImagePicker: dropzone.open,
  };
}
