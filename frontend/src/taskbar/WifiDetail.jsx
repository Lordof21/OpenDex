// Wi-Fi detail page — QuickSettings view 'wifi'.
// Connected-network card, nearby networks (scan) and saved networks; join with a password or, for a saved network,
// without one (daemon). The phone is re-read after every action: nothing is shown as done before it is.

import { useEffect, useMemo, useState } from 'react';
import { Eye, EyeOff, LoaderCircle, Lock, RefreshCw, Wifi } from 'lucide-react';
import { cn } from '../lib/utils.js';
import { useConnectivityStore } from '../state/connectivityStore.js';
import { useSystemStore } from '../state/systemStore.js';
import { isWirelessLink, sessionRunsOverWifi } from '../wireless/connectionStatus.js';
import { SignalBars } from './connectivityParts.jsx';
import Button from '../ui/Button.jsx';
import { Card } from '../ui/Card.jsx';
import { ConfirmStrip, EmptyNote, KeyValueRow } from '../ui/Feedback.jsx';
import { SectionLabel } from '../ui/Typography.jsx';
import { t } from '../i18n/index.js';

const STATUS_POLL_MS = 5000;
const SAVED_PREVIEW = 5;

const STANDARD = {
  legacy: '802.11a/b/g',
  '11n': 'Wi-Fi 4 (802.11n)',
  '11ac': 'Wi-Fi 5 (802.11ac)',
  '11ax': 'Wi-Fi 6 (802.11ax)',
  '11ad': 'WiGig (802.11ad)',
  '11be': 'Wi-Fi 7 (802.11be)',
};

const SECURITY = {
  open: t('taskbar.acik_sifresiz'),
  owe: t('taskbar.gelismis_acik_owe'),
  wep: t('taskbar.wep_guvensiz'),
  wpa2: t('taskbar.wpa2_kisisel'),
  wpa3: t('taskbar.wpa3_kisisel'),
  eap: t('taskbar.wpa2_3_kurumsal'),
  'eap-wpa3': t('taskbar.wpa3_kurumsal'),
  'eap-192': t('taskbar.wpa3_kurumsal_192_bit'),
  'wapi-psk': 'WAPI-PSK',
  'wapi-cert': t('taskbar.wapi_sertifika'),
  passpoint: 'Passpoint',
  'passpoint-r3': 'Passpoint R3',
  osen: 'OSEN',
  dpp: 'Easy Connect (DPP)',
};

const QUALITY = [t('taskbar.cok_zayif'), t('taskbar.zayif'), t('common.orta'), t('common.iyi'), t('taskbar.mukemmel')];

export function channelOf(freq) {
  if (!freq) return null;
  if (freq === 2484) return 14;
  if (freq >= 2412 && freq < 2484) return (freq - 2407) / 5;
  if (freq >= 5955 && freq <= 7115) return (freq - 5950) / 5;
  if (freq >= 5000 && freq < 5925) return (freq - 5000) / 5;
  return null;
}

export function standardLabel(standard, band) {
  if (standard === '11ax' && band === '6 GHz') return 'Wi-Fi 6E (802.11ax)';
  return STANDARD[standard] || standard || null;
}

const securityLabel = (s) => SECURITY[s] || (s ? s.toUpperCase() : null);

function speedLabel(tx, rx) {
  if (!tx && !rx) return null;
  if (tx && rx) return `↑ ${tx} / ↓ ${rx} Mbps`;
  return `${tx || rx} Mbps`;
}

function ConnectedCard({ wifi, onForget, onDisconnect }) {
  const [confirm, setConfirm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // This very session runs over the phone's Wi-Fi: leaving it would cut OpenDeX off (the backend refuses too).
  const carriesSession = useSystemStore((s) => sessionRunsOverWifi(s.devices, wifi.ip));
  const disconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
    } finally {
      setDisconnecting(false);
    }
  };
  const channel = channelOf(wifi.frequency);
  return (
    <Card className="py-2">
      <div className="flex items-center gap-2.5 pb-1.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <Wifi className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold" title={wifi.ssid}>{wifi.ssid}</div>
          <div className="text-[9px] text-status-active">{t('common.bagli')}</div>
        </div>
        <SignalBars n={wifi.bars} className="text-foreground" />
      </div>
      <KeyValueRow
        label={t('taskbar.sinyal')}
        value={wifi.rssi != null ? `${wifi.rssi} dBm · ${QUALITY[wifi.bars ?? 0]}` : null}
      />
      <KeyValueRow label={t('taskbar.baglanti_hizi')} value={speedLabel(wifi.tx_mbps, wifi.rx_mbps)} />
      <KeyValueRow
        label={t('taskbar.bant')}
        value={wifi.band && `${wifi.band} · ${wifi.frequency} MHz${channel ? ` · kanal ${channel}` : ''}`}
      />
      <KeyValueRow label={t('taskbar.standart')} value={standardLabel(wifi.standard, wifi.band)} />
      <KeyValueRow label={t('taskbar.guvenlik')} value={securityLabel(wifi.security)} />
      <KeyValueRow label={t('taskbar.ip_adresi')} value={wifi.ip && (wifi.prefix != null ? `${wifi.ip}/${wifi.prefix}` : wifi.ip)} />
      <KeyValueRow label={t('taskbar.ag_gecidi')} value={wifi.gateway} />
      <KeyValueRow
        label="MAC"
        value={wifi.mac && `${wifi.mac}${wifi.mac_randomized ? ' (rastgele)' : wifi.mac_randomized === false ? ' (cihaz)' : ''}`}
      />
      <KeyValueRow label="BSSID" value={wifi.bssid} />
      {confirm ? (
        <ConfirmStrip
          message={t('taskbar.bu_ag_unutulsun_mu_yeniden_baglanmak')}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onForget(wifi.network_id);
          }}
        />
      ) : (
        <>
          <div className="flex justify-end gap-1.5 pt-1">
            <Button size="2xs" variant="ghost" disabled={disconnecting || carriesSession} onClick={disconnect}>
              {disconnecting ? t('taskbar.kesiliyor') : t('taskbar.baglantiyi_kes')}
            </Button>
            {wifi.network_id != null && (
              <Button size="2xs" variant="destructive-ghost" disabled={carriesSession} onClick={() => setConfirm(true)}>
                {t('taskbar.bu_agi_unut')}
              </Button>
            )}
          </div>
          {carriesSession && (
            <p className="pt-1 text-[10px] leading-snug text-muted-foreground" data-testid="wifi-carries-session">
              {t('taskbar.opendex_bu_wi_fi_uzerinden_bagli')}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function PasswordForm({ network, onCancel, onSubmit }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const valid = password.length >= 8 && password.length <= 63;

  const submit = async (e) => {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const r = await onSubmit(password);
    setBusy(false);
    if (!r.ok) setError(r.error || t('taskbar.baglanilamadi'));
  };

  return (
    <form onSubmit={submit} className="my-1 rounded-md border border-primary/30 bg-background/70 p-2" aria-label={t('taskbar.ssid_sifresi', { ssid: network.ssid })}>
      <label className="block text-[10px] text-muted-foreground" htmlFor="wifi-password">
        {t('taskbar.ssid_icin_sifre_securitylabel', { ssid: network.ssid, securityLabel: securityLabel(network.security) })}
      </label>
      <div className="mt-1 flex items-center gap-1 rounded-md border border-border bg-background px-2">
        <input
          id="wifi-password"
          type={show ? 'text' : 'password'}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={63}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-7 min-w-0 flex-1 bg-transparent text-[11px] outline-none"
        />
        <button
          type="button"
          className="grid size-6 place-items-center text-muted-foreground hover:text-foreground cursor-pointer"
          aria-label={show ? t('taskbar.sifreyi_gizle') : t('taskbar.sifreyi_goster')}
          onClick={() => setShow((v) => !v)}
        >
          {show ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-[10px] text-destructive">{error}</p>}
      {!error && password.length > 0 && !valid && (
        <p className="mt-1 text-[10px] text-muted-foreground">{t('taskbar.sifre_8_63_karakter_olmali')}</p>
      )}
      <div className="mt-1.5 flex justify-end gap-1">
        <Button size="2xs" variant="ghost" onClick={onCancel}>{t('common.iptal')}</Button>
        <Button size="2xs" type="submit" disabled={!valid || busy}>
          {busy ? t('common.baglaniyor') : t('common.baglan')}
        </Button>
      </div>
    </form>
  );
}

function NetworkRow({ network, saved, joining, onJoin }) {
  const title = network.connectable || saved ? undefined : t('taskbar.kurumsal_wep_aglara_telefonun_kendi');
  return (
    <button
      type="button"
      onClick={() => onJoin(network)}
      title={title}
      aria-label={t('taskbar.ssid_agina_baglan', { ssid: network.ssid })}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent/60 cursor-pointer',
        !network.connectable && !saved && 'opacity-60',
      )}
    >
      <SignalBars n={network.bars} className="text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium">{network.ssid}</span>
        <span className="block text-[9px] text-muted-foreground">
          {[saved ? t('taskbar.kayitli') : null, network.band, securityLabel(network.security)].filter(Boolean).join(' · ')}
        </span>
      </span>
      {joining ? (
        <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label={t('taskbar.baglaniyor')} />
      ) : (
        network.secured && <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  );
}

function SavedRow({ network, inRange, onConnect, onForget }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="border-b border-border/40 py-1 last:border-b-0">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium">{network.ssid}</span>
          <span className="block text-[9px] text-muted-foreground">
            {[inRange ? t('taskbar.menzilde') : t('taskbar.menzil_disinda'), securityLabel(network.kind || network.security)].join(' · ')}
          </span>
        </span>
        {inRange && network.kind && (
          <Button size="2xs" variant="ghost" onClick={() => onConnect(network)} aria-label={t('taskbar.ssid_agina_baglan', { ssid: network.ssid })}>
            {t('common.baglan')}
          </Button>
        )}
        <Button size="2xs" variant="destructive-ghost" onClick={() => setConfirm(true)} aria-label={t('taskbar.ssid_agini_unut', { ssid: network.ssid })}>
          {t('taskbar.unut')}
        </Button>
      </div>
      {confirm && (
        <ConfirmStrip
          message={t('taskbar.bu_ag_unutulsun_mu_yeniden_baglanmak')}
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            onForget(network.network_id);
          }}
        />
      )}
    </div>
  );
}

export default function WifiDetail({ enabled }) {
  const wifi = useConnectivityStore((s) => s.wifi);
  const saved = useConnectivityStore((s) => s.saved);
  const scan = useConnectivityStore((s) => s.scan);
  const scanning = useConnectivityStore((s) => s.scanning);
  const wifiError = useConnectivityStore((s) => s.wifiError);
  const joining = useConnectivityStore((s) => s.joining);
  const [ask, setAsk] = useState(null); // network awaiting its password
  const [showAllSaved, setShowAllSaved] = useState(false);

  useEffect(() => {
    const store = useConnectivityStore.getState();
    store.loadWifi();
    const id = setInterval(() => useConnectivityStore.getState().loadWifi(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // Over Wi-Fi the phone's radio carries the video stream, and a scan makes it leave the connected channel (hundreds of
  // ms per band, DFS channels longer): the picture freezes. So there, opening the page shows the last scan only; the
  // refresh button scans on request.
  const wirelessLink = useSystemStore((s) => isWirelessLink(s.devices));

  // Nearby networks: the last scan at once, then a fresh one (not over Wi-Fi) — and again whenever Wi-Fi is switched on.
  useEffect(() => {
    if (!enabled) return;
    const store = useConnectivityStore.getState();
    store.loadNetworks().then(() => {
      if (!isWirelessLink(useSystemStore.getState().devices)) useConnectivityStore.getState().scanWifi();
    });
  }, [enabled]);

  const connectedSsid = wifi?.connected ? wifi.ssid : null;
  const savedBySsid = useMemo(() => new Map(saved.map((n) => [n.ssid, n])), [saved]);
  const inRange = useMemo(() => new Set(scan.map((n) => n.ssid)), [scan]);
  const nearby = scan.filter((n) => n.ssid !== connectedSsid);
  const savedOthers = saved.filter((n) => n.ssid !== connectedSsid);
  const savedShown = showAllSaved ? savedOthers : savedOthers.slice(0, SAVED_PREVIEW);
  const toast = (m) => useSystemStore.getState().pushToast?.(m);

  const join = async (network) => {
    const store = useConnectivityStore.getState();
    const known = savedBySsid.get(network.ssid);
    if (known) {
      const r = await store.connectSaved(known);
      if (r.needPassword) setAsk({ ssid: known.ssid, security: known.kind });
      else if (!r.ok && r.error) toast(r.error);
      return;
    }
    if (!network.connectable) {
      toast(t('taskbar.kurumsal_wep_aglara_telefonun_kendi_2'));
      return;
    }
    if (network.secured) {
      setAsk({ ssid: network.ssid, security: network.security });
      return;
    }
    const r = await store.connectWifi(network.ssid, network.security, null);
    if (!r.ok) toast(r.error);
  };

  const submitPassword = async (password) => {
    const r = await useConnectivityStore.getState().connectWifi(ask.ssid, ask.security, password);
    if (r.ok) setAsk(null);
    return r;
  };

  const forget = (networkId) => useConnectivityStore.getState().forgetWifi(networkId);

  if (enabled === false) {
    return <EmptyNote>{t('taskbar.wi_fi_kapali_cevredeki_aglari_gormek')}</EmptyNote>;
  }

  return (
    <div className="pb-1">
      {wifiError && !wifi && <EmptyNote>{t('taskbar.wi_fi_durumu_okunamadi_wifierror', { wifiError })}</EmptyNote>}

      {wifi?.connected && <div className="mt-2"><ConnectedCard wifi={wifi} onForget={forget} onDisconnect={() => useConnectivityStore.getState().disconnectWifi()} /></div>}
      {wifi && !wifi.connected && !joining && <EmptyNote>{t('taskbar.bir_aga_bagli_degil')}</EmptyNote>}
      {joining && joining !== connectedSsid && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-muted/45 px-2 py-1.5 text-[10px]" role="status">
          <LoaderCircle className="size-3.5 animate-spin" />{t('taskbar.joining_agina_baglaniliyor', { joining })}
        </div>
      )}

      {ask && (
        <PasswordForm key={ask.ssid} network={ask} onCancel={() => setAsk(null)} onSubmit={submitPassword} />
      )}

      <SectionLabel
        action={
          <button
            type="button"
            onClick={() => useConnectivityStore.getState().scanWifi()}
            disabled={scanning}
            aria-label={t('taskbar.aglari_yeniden_tara')}
            title={wirelessLink ? t('taskbar.telefon_wi_fi_ile_bagliyken_tarama') : undefined}
            className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer disabled:cursor-default"
          >
            <RefreshCw className={cn('size-3', scanning && 'animate-spin')} />
          </button>
        }
      >
        {t('taskbar.cevredeki_aglar')}
      </SectionLabel>
      <Card className="px-1 py-0.5">
        {nearby.length ? (
          nearby.map((n) => (
            <NetworkRow
              key={n.bssid}
              network={n}
              saved={savedBySsid.has(n.ssid)}
              joining={joining === n.ssid}
              onJoin={join}
            />
          ))
        ) : (
          <EmptyNote>{scanning ? t('taskbar.taraniyor') : t('taskbar.cevrede_ag_bulunamadi')}</EmptyNote>
        )}
      </Card>

      {savedOthers.length > 0 && (
        <>
          <SectionLabel>{t('taskbar.kayitli_aglar')}</SectionLabel>
          <Card className="py-0.5">
            {savedShown.map((n) => (
              <SavedRow
                key={n.network_id}
                network={n}
                inRange={inRange.has(n.ssid)}
                onConnect={join}
                onForget={forget}
              />
            ))}
            {savedOthers.length > SAVED_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAllSaved((v) => !v)}
                className="w-full py-1 text-center text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              >
                {showAllSaved ? t('taskbar.daha_az_goster') : t('taskbar.tumunu_goster_count', { count: savedOthers.length })}
              </button>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
