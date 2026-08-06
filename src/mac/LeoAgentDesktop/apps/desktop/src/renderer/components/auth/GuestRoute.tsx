import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function GuestRoute() {
  const { mode, isInitializing } = useAuth();

  if (isInitializing) return null;
  if (mode === 'cloud' || mode === 'local') return <Navigate to="/" replace />;
  return <Outlet />;
}
