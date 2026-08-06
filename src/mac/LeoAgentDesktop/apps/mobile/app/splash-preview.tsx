import { Redirect } from 'expo-router';
import { CenteredScreen } from '@/components/CenteredScreen';
import { MOBILE_VISUAL_MOCK_ENABLED } from '@/config/env';

/**
 * Dev-only visual mock route for manual/capture validation of the app-internal
 * splash. Production startup gates keep their original timing and behavior.
 */
export default function SplashPreviewScreen() {
  if (!MOBILE_VISUAL_MOCK_ENABLED) return <Redirect href="/" />;
  return <CenteredScreen title="Cindy" variant="splash" />;
}
