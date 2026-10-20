// Fiziksel cihazlar (deviceModel.groupDevices) — backend'in ittiği cihaz durumu + kayıtlı cihazlar. Cihaz Merkezi,
// "Cihaz bağla" penceresi ve taskbar düğmesi aynı türetmeyi okur.
import { useEffect, useMemo } from 'react';
import { useSystemStore } from '../state/systemStore.js';
import { useDeviceHubStore } from './deviceHubStore.js';
import { groupDevices } from './deviceModel.js';
import { t } from '../i18n/index.js';

export function useDevices() {
  const devices = useSystemStore((s) => s.devices);
  const session = useSystemStore((s) => s.deviceSession);
  const linkWeak = useSystemStore((s) => s.linkWeak);
  const known = useDeviceHubStore((s) => s.known);
  const groups = useMemo(
    () => groupDevices({
      devices,
      known,
      session: { phase: session?.phase ?? null, switching: Boolean(session?.switching), linkWeak },
      fallbackName: t('common.android_cihazi'),
    }),
    [devices, known, session, linkWeak],
  );
  return { ...groups, session };
}

/** Bir yüzey (panel, pencere) açıkken kayıtlı cihazları tazeler ve kapanınca bırakır. */
export function useWatchKnownDevices() {
  useEffect(() => useDeviceHubStore.getState().watchKnown(), []);
}
