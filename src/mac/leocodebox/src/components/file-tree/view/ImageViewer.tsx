import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { Button } from '../../../shared/view/ui';
import { apiClient } from '../../../utils/apiClient';
import type { FileTreeImageSelection } from '../types/types';

type ImageViewerProps = {
  file: FileTreeImageSelection;
  onClose: () => void;
};

export default function ImageViewer({ file, onClose }: ImageViewerProps) {
  const imagePath = `/api/projects/${file.projectId}/files/content?path=${encodeURIComponent(file.path)}`;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let objectUrl: string | null = null;
    const controller = new AbortController();

    const loadImage = async () => {
      try {
        setLoading(true);
        setError(null);
        setImageUrl(null);

        const response = await apiClient.raw(imagePath, {
          signal: controller.signal,
        });


        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (loadError: unknown) {
        if (loadError instanceof Error && loadError.name === 'AbortError') {
          return;
        }
        console.error('Error loading image:', loadError);
        setError('Unable to load image');
      } finally {
        setLoading(false);
      }
    };

    loadImage();

    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [imagePath]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="mx-4 max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-lg bg-card shadow-elevation-3 dark:bg-muted">
        <div className="flex items-center justify-between border-b p-4">
          <h3 className="text-lg font-semibold text-muted-foreground dark:text-primary-foreground">{file.name}</h3>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-[400px] items-center justify-center bg-muted p-4 dark:bg-muted">
          {loading && (
            <div className="text-center text-muted-foreground dark:text-muted-foreground">
              <p>Loading image...</p>
            </div>
          )}
          {!loading && imageUrl && (
            <img
              src={imageUrl}
              alt={file.name}
              className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-elevation-2"
            />
          )}
          {!loading && !imageUrl && (
            <div className="text-center text-muted-foreground dark:text-muted-foreground">
              <p>{error || 'Unable to load image'}</p>
              <p className="mt-2 break-all text-sm">{file.path}</p>
            </div>
          )}
        </div>

        <div className="border-t bg-muted p-4 dark:bg-muted">
          <p className="text-sm text-muted-foreground dark:text-muted-foreground">{file.path}</p>
        </div>
      </div>
    </div>
  );
}
