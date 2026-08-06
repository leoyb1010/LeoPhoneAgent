import { useMemo } from 'react';
import { useDeviceLink } from './DeviceLinkContext';
import {
  createMobileMakerTransport,
  type MobileMakerTransport,
} from './mobileMakerTransport';

export function useMobileMakerTransport(deviceId: string): MobileMakerTransport {
  const { invoke } = useDeviceLink();
  return useMemo(
    () => createMobileMakerTransport({ deviceId, invoke }),
    [deviceId, invoke],
  );
}
