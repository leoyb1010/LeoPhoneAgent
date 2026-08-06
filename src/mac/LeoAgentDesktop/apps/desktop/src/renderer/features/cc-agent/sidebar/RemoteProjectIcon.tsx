import { Globe, MonitorOff, MonitorSmartphone } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { DeviceLinkConnectionStatus } from '@/lib/ccAgent.types';

type RemoteProjectIconKind = 'device-link' | 'ssh';

interface RemoteProjectIconProps {
  kind: RemoteProjectIconKind;
  size?: number;
  strokeWidth?: number;
  connectionStatus?: DeviceLinkConnectionStatus | null;
  className?: string;
}

/** Sidebar remote-project icon shared by project headers and remote session rows. */
export function RemoteProjectIcon({
  kind,
  size = 14,
  strokeWidth = 2,
  connectionStatus,
  className,
}: RemoteProjectIconProps) {
  const disconnected = kind === 'device-link' && connectionStatus === 'disconnected';
  const Icon = disconnected ? MonitorOff : kind === 'device-link' ? MonitorSmartphone : Globe;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      className={cn('shrink-0', disconnected && 'opacity-75', className)}
      aria-hidden
    />
  );
}
