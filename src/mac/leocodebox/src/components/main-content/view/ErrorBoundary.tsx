import { useCallback, useState, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ErrorBoundary as ReactErrorBoundary,
  type FallbackProps,
} from 'react-error-boundary';

type ErrorFallbackProps = FallbackProps & {
  showDetails: boolean;
  componentStack: string | null;
};

type ErrorBoundaryProps = {
  children: ReactNode;
  showDetails?: boolean;
  onRetry?: () => void;
  resetKeys?: unknown[];
};

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return String(error);
}

function ErrorFallback({
  error,
  resetErrorBoundary,
  showDetails,
  componentStack,
}: ErrorFallbackProps) {
  const { t } = useTranslation();
  const canShowDetails = showDetails && import.meta.env.DEV;

  return (
    <div className="flex h-full min-h-48 items-center justify-center p-6 text-center">
      <div className="w-full max-w-md rounded-md border border-destructive/30 bg-card p-6 shadow-elevation-1">
        <CircleAlert className="mx-auto h-7 w-7 text-destructive" aria-hidden="true" />
        <h3 className="mt-3 text-sm font-semibold text-foreground">{t('errorBoundary.regionTitle')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t('errorBoundary.regionDescription')}</p>
        {canShowDetails && (
          <details className="mt-4 text-left">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{t('errorBoundary.details')}</summary>
            <pre className="mt-2 max-h-40 overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs text-muted-foreground">
                {formatError(error)}
                {componentStack}
            </pre>
          </details>
        )}
        <button
          type="button"
          onClick={resetErrorBoundary}
          className="mx-auto mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          {t('errorBoundary.reload')}
        </button>
      </div>
    </div>
  );
}

function ErrorBoundary({
  children,
  showDetails = false,
  onRetry = undefined,
  resetKeys = undefined,
}: ErrorBoundaryProps) {
  const [componentStack, setComponentStack] = useState<string | null>(null);

  const handleError = useCallback((error: Error, errorInfo: ErrorInfo) => {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    // Keep component stack for optional debug rendering in fallback UI.
    setComponentStack(errorInfo?.componentStack ?? null);
  }, []);

  const handleReset = useCallback(() => {
    setComponentStack(null);
    onRetry?.();
  }, [onRetry]);

  const renderFallback = useCallback(
    ({ error, resetErrorBoundary }: FallbackProps) => (
      <ErrorFallback
        error={error}
        resetErrorBoundary={resetErrorBoundary}
        showDetails={showDetails}
        componentStack={componentStack}
      />
    ),
    [showDetails, componentStack]
  );

  return (
    <ReactErrorBoundary
      fallbackRender={renderFallback}
      onError={handleError}
      onReset={handleReset}
      resetKeys={resetKeys}
    >
      {children}
    </ReactErrorBoundary>
  );
}

export default ErrorBoundary;
