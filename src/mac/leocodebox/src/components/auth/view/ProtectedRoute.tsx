import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';
import VisualStateArtwork from '../../ui/VisualStateArtwork';

import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { t } = useTranslation('auth');
  const { user, error, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();
  const isLocalDesktop = typeof window !== 'undefined' && window.leocodeboxLocal?.enabled === true;

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (isLocalDesktop && error && !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div role="alert" className="w-full max-w-lg border border-destructive/40 bg-card p-6">
          <VisualStateArtwork name="local-service-failed" category="errors" className="mx-auto mb-3 h-40 w-full max-w-sm" />
          <h1 className="text-lg font-semibold">{t('localDesktop.localServiceTitle')}</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {t('localDesktop.reload')}
          </button>
        </div>
      </main>
    );
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
