import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '@/contexts/AuthContext';

export function ProtectedRoute() {
  const { canEnterApp, isInitializing, dataOwnerId } = useAuth();

  if (isInitializing) return null;
  if (!canEnterApp) return <Navigate to="/login" replace />;
  // Owner changes must remount the protected tree so transient New Maker
  // drafts and other route-local state cannot leak across data namespaces.
  return <Outlet key={dataOwnerId ?? 'signed-out'} />;
}
