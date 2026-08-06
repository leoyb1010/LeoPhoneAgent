import { useTranslation } from 'react-i18next';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { useBrandLogo } from '@/hooks/useBrandLogo';

export function WelcomePage() {
  const { t } = useTranslation();
  const brandLogo = useBrandLogo();
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <img
        src={brandLogo}
        alt={BRAND_NAME}
        className="w-[120px] object-contain pointer-events-none"
        draggable={false}
      />
      <p className="mt-[20px] text-28 font-semibold text-welcome-text">
        {t('welcome.greeting')}
      </p>
    </div>
  );
}
