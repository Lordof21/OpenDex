import React, { useEffect, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import QRCode from 'qrcode';
import {
  QrCode,
  Hash,
  CheckCircle2,
  ArrowRight,
  RefreshCw,
  Zap,
  AlertCircle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Wifi,
  Smartphone,
  X,
  Check,
  RotateCw,
  AlertTriangle,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useSystemStore } from '../state/systemStore.js';
import { Dialog } from '../ui/Dialog.jsx';
import { IconButton } from '../ui/IconButton.jsx';
import { cn } from '../lib/utils.js';

// ── Themed QR Skeleton ────────────────────────────────────────────────────────
function QrCodeSkeleton() {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 w-full py-1">
      <div className="relative size-[160px] rounded-xl border border-border/60 bg-muted/40 p-3 flex flex-col justify-between overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/[0.04] to-transparent animate-shimmer" />
        <div className="flex justify-between w-full">
          <div className="size-10 rounded-md border-4 border-primary/30 bg-primary/10 p-1 flex items-center justify-center">
            <div className="size-3.5 rounded-xs bg-primary/50" />
          </div>
          <div className="size-10 rounded-md border-4 border-primary/30 bg-primary/10 p-1 flex items-center justify-center">
            <div className="size-3.5 rounded-xs bg-primary/50" />
          </div>
        </div>
        <div className="grid grid-cols-6 gap-1.5 px-1">
          {[...Array(18)].map((_, i) => (
            <div
              key={i}
              className={`size-2 rounded-xs ${i % 2 === 0 ? 'bg-foreground/10' : 'bg-primary/20'}`}
            />
          ))}
        </div>
        <div className="flex justify-between items-end w-full">
          <div className="size-10 rounded-md border-4 border-primary/30 bg-primary/10 p-1 flex items-center justify-center">
            <div className="size-3.5 rounded-xs bg-primary/50" />
          </div>
          <div className="flex flex-col gap-1 items-end">
            <div className="h-2 w-10 rounded bg-foreground/8" />
            <div className="h-2 w-7 rounded bg-foreground/6" />
          </div>
        </div>
        {/* scanning line */}
        <div className="absolute inset-x-0 h-0.5 bg-gradient-to-r from-transparent via-primary to-transparent opacity-60 animate-scanline pointer-events-none" />
      </div>
      <div className="flex flex-col items-center gap-2 w-full max-w-[220px]">
        <div className="relative h-2.5 w-4/5 rounded-md bg-foreground/[0.05] overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" />
        </div>
        <div className="relative h-2 w-3/5 rounded-md bg-foreground/[0.04] overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" />
        </div>
      </div>
    </div>
  );
}

// ── Manual IP / TCP 5555 ──────────────────────────────────────────────────────
export function ManualIpEntry({ initialIp = '' }) {
  const [ip, setIp] = useState(initialIp);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [tcpipBusy, setTcpipBusy] = useState(false);
  const pushToast = useSystemStore((s) => s.pushToast);

  useEffect(() => {
    if (!ip) {
      api.get('/api/pairing/detected-ip')
        .then((res) => { if (res?.ip) setIp(res.ip); })
        .catch(() => {});
    }
  }, [ip]);

  const switchTcpip = async () => {
    setTcpipBusy(true);
    try {
      const res = await api.post('/api/device/tcpip?port=5555');
      pushToast(res?.message || '🎉 TCP 5555 modu aktif!');
      setPort('5555');
    } catch (err) {
      pushToast(err?.detail || 'USB bağlı cihaz bulunamadı.');
    } finally {
      setTcpipBusy(false);
    }
  };

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/api/pairing/manual', { ip, port: Number(port) });
      pushToast('Bağlantı kuruluyor...');
    } catch (err) {
      pushToast(err.detail || 'Bağlantı başarısız — IP/Port veya Güvenlik Duvarını kontrol edin.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Quick 5555 banner */}
      <div className="rounded-lg border border-border/70 bg-muted/40 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Zap className="size-3.5 shrink-0 text-primary" />
          <span className="text-[11.5px] font-semibold text-foreground">En Hızlı Yöntem: Tek Tıkla Kablosuz (5555)</span>
        </div>
        <p className="text-[10.5px] text-muted-foreground leading-relaxed mb-3">
          Telefonu USB ile 1 saniye takın ve butona basın. Kabloyu çekip sonsuza dek kablosuz kullanabilirsiniz.
        </p>
        <button
          type="button"
          onClick={switchTcpip}
          disabled={tcpipBusy}
          className="flex items-center justify-center gap-2 w-full h-9 px-4 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {tcpipBusy ? (
            <span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          ) : (
            <Zap className="size-3.5" />
          )}
          <span>{tcpipBusy ? '5555 Modu Etkinleştiriliyor…' : 'USB ile 5555 Modunu Etkinleştir'}</span>
        </button>
      </div>

      {/* Manuel IP */}
      <div className="rounded-lg border border-border/60 bg-background/60 p-3">
        <p className="text-[10.5px] text-muted-foreground mb-2.5">
          Veya IP ve Port bilgilerini manuel girin:
        </p>
        <form onSubmit={connect} className="flex items-center gap-2 w-full">
          <input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.105"
            required
            className="flex-1 h-8 rounded-md border border-border/70 bg-background px-3 text-[11px] font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all"
          />
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            placeholder="Port"
            required
            pattern="\d+"
            className="w-24 h-8 rounded-md border border-border/70 bg-background px-3 text-[11px] font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all"
          />
          <button
            type="submit"
            disabled={busy}
            className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold flex items-center gap-1.5 transition-colors hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
          >
            {busy ? <span className="size-3 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <ArrowRight className="size-3.5" />}
            <span>{busy ? 'Bağlanıyor…' : 'Bağlan'}</span>
          </button>
        </form>
      </div>

      {/* 5555 avantaj ipucu */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground block mb-0.5 flex items-center gap-1.5">
          <ShieldCheck className="size-3.5 inline text-primary" /> Neden 5555 Modu?
        </span>
        Dinamik port veya eşleme kodlarıyla uğraşmadan, USB kablosunu bir kez takıp çıkardığınızda kalıcı kablosuz bağlantı sağlar. Telefon Hotspot modundayken de çalışır.
      </div>
    </div>
  );
}

// ── 6-Digit PIN Pairing ───────────────────────────────────────────────────────
export function PairingCodeEntry() {
  const [ip, setIp] = useState('');
  const [pairPort, setPairPort] = useState('');
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState(false);
  const [connectPort, setConnectPort] = useState('');
  const [connectBusy, setConnectBusy] = useState(false);
  const pushToast = useSystemStore((s) => s.pushToast);
  const digitInputRefs = useRef([]);

  useEffect(() => {
    if (!ip) {
      api.get('/api/pairing/detected-ip')
        .then((res) => { if (res?.ip) setIp(res.ip); })
        .catch(() => {});
    }
  }, [ip]);

  const handleDigitChange = (index, value) => {
    const clean = value.replace(/\D/g, '');
    if (clean.length > 1) {
      const chars = clean.slice(0, 6).split('');
      const newDigits = [...digits];
      chars.forEach((c, i) => { if (index + i < 6) newDigits[index + i] = c; });
      setDigits(newDigits);
      digitInputRefs.current[Math.min(5, index + chars.length)]?.focus();
      return;
    }
    const newDigits = [...digits];
    newDigits[index] = clean;
    setDigits(newDigits);
    if (clean && index < 5) digitInputRefs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0)
      digitInputRefs.current[index - 1]?.focus();
  };

  const pair = async (e) => {
    e.preventDefault();
    const code = digits.join('');
    if (code.length !== 6) { pushToast('Lütfen 6 haneli kodu tam girin.'); return; }
    setBusy(true);
    try {
      await api.post('/api/pairing/pair-code', { ip, port: Number(pairPort), pairing_code: code });
      setPaired(true);
      pushToast('🎉 Eşleştirme Başarılı! Şimdi bağlantı portunu girin.');
    } catch (err) {
      pushToast(err.detail || 'Eşleştirme başarısız — Kodu veya IP:Portu kontrol edin.');
    } finally {
      setBusy(false);
    }
  };

  const connect = async (e) => {
    e.preventDefault();
    setConnectBusy(true);
    try {
      await api.post('/api/pairing/manual', { ip, port: Number(connectPort) });
      pushToast('Bağlantı kuruluyor...');
    } catch (err) {
      pushToast(err.detail || 'Bağlantı başarısız — Bağlantı portunu kontrol edin.');
    } finally {
      setConnectBusy(false);
    }
  };

  if (paired) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col gap-3 w-full"
      >
        <div className="flex items-center gap-2 text-[12px] font-semibold text-foreground">
          <CheckCircle2 className="size-4 text-status-active shrink-0" />
          <span>Cihaz Başarıyla Eşleştirildi!</span>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-[10.5px] text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground block mb-1 flex items-center gap-1.5">
            <AlertCircle className="size-3.5 inline" /> Xiaomi / HyperOS / Samsung İpucu
          </span>
          Telefonda <b className="text-foreground">«Kablosuz Hata Ayıklama»</b> anahtarını bir kez kapatıp tekrar açın; bağlantı portu güncellenecektir.
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[10.5px] text-muted-foreground leading-relaxed">
          <span className="font-semibold text-foreground block mb-1 flex items-center gap-1.5 text-[11px]">
            <AlertTriangle className="size-3.5 inline text-warning shrink-0" /> Port Numarası Boş / Görünmüyor mu?
          </span>
          Telefonunuz Hotspot (Erişim Noktası) modundaysa Android bağlantı portunu vermez (telefon host, laptop alıcı olamaz). Bu durumda lütfen <b className="text-foreground">«5555 / USB»</b> sekmesini kullanın veya laptop'tan Hotspot açarak telefonu bağlayın.
        </div>
        <p className="text-[10.5px] text-muted-foreground">
          Ana ekrandaki <b className="text-foreground">«IP adresi ve Bağlantı Noktası»</b> satırından bağlantı portunu girin:
        </p>
        <form onSubmit={connect} className="flex items-center gap-2 w-full">
          <span className="h-8 flex items-center px-3 rounded-md border border-border/70 bg-muted/50 text-[11px] font-mono text-muted-foreground shrink-0">
            {ip} :
          </span>
          <input
            value={connectPort}
            onChange={(e) => setConnectPort(e.target.value)}
            placeholder="Bağlantı Portu"
            required
            autoFocus
            pattern="\d+"
            className="flex-1 h-8 rounded-md border border-border/70 bg-background px-3 text-[11px] font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all"
          />
          <button
            type="submit"
            disabled={connectBusy}
            className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold flex items-center gap-1.5 transition-colors hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
          >
            {connectBusy ? <span className="size-3 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <ArrowRight className="size-3.5" />}
            <span>{connectBusy ? 'Bağlanıyor…' : 'Bağlan'}</span>
          </button>
        </form>
      </motion.div>
    );
  }

  return (
    <form onSubmit={pair} className="flex flex-col gap-3 w-full">
      {/* Hotspot limitation warning */}
      <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[10.5px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground block mb-1 flex items-center gap-1.5 text-[11px]">
          <AlertTriangle className="size-3.5 inline text-warning shrink-0" />
          Telefon Hotspot Olamaz
        </span>
        Telefon dağıtıcı (Hotspot), laptop alıcı durumundayken Android bağlantı portu açmaz. İki cihaz da <b className="text-foreground">aynı Wi-Fi ağına</b> bağlı olmalı veya <b className="text-foreground">Laptop'un Mobil Etkin Noktası</b> açılmalıdır (ya da <b className="text-foreground">«5555 / USB»</b> sekmesini kullanın).
      </div>

      <p className="text-[10.5px] text-muted-foreground">
        Telefonda <b className="text-foreground">«Cihazı eşleme koduyla eşle»</b> penceresindeki IP, Port ve 6 haneli kodu girin:
      </p>
      <div className="flex items-center gap-2">
        <input
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="IP (192.168.1.105)"
          required
          className="flex-1 h-8 rounded-md border border-border/70 bg-background px-3 text-[11px] font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all"
        />
        <input
          value={pairPort}
          onChange={(e) => setPairPort(e.target.value)}
          placeholder="Eşleme Portu"
          required
          pattern="\d+"
          className="w-28 h-8 rounded-md border border-border/70 bg-background px-3 text-[11px] font-mono text-foreground placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 focus:outline-none transition-all"
        />
      </div>

      {/* 6-digit boxes */}
      <div className="flex items-center justify-center gap-2">
        {digits.map((val, idx) => (
          <input
            key={idx}
            ref={(el) => (digitInputRefs.current[idx] = el)}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={val}
            onChange={(e) => handleDigitChange(idx, e.target.value)}
            onKeyDown={(e) => handleKeyDown(idx, e)}
            className="size-10 rounded-md border border-border/70 bg-background text-center text-sm font-mono font-bold text-foreground focus:border-primary focus:ring-2 focus:ring-primary/25 focus:outline-none transition-all"
          />
        ))}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="h-9 w-full flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold transition-colors hover:bg-primary/90 disabled:opacity-50 cursor-pointer"
      >
        {busy ? (
          <span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
        ) : (
          <>
            <span>Cihazı Eşleştir</span>
            <ArrowRight className="size-3.5" />
          </>
        )}
      </button>

      {/* Nereden Alırım Rehberi */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 text-[10px] text-muted-foreground leading-relaxed">
        <span className="font-semibold text-foreground block mb-0.5 flex items-center gap-1.5">
          <Smartphone className="size-3.5 inline text-primary" /> Kodu Nereden Alırım?
        </span>
        Telefonda <b className="text-foreground">Ayarlar → Geliştirici Seçenekleri → Kablosuz Hata Ayıklama</b> menüsüne girip <b className="text-foreground">«Cihazı eşleme koduyla eşle»</b> seçeneğine dokunun.
      </div>
    </form>
  );
}

// ── Master QrPairing Export ───────────────────────────────────────────────────
const QR_CARD_LAYOUT = { layout: true, transition: { layout: { duration: 0.28, ease: [0.4, 0, 0.2, 1] } } };

export default function QrPairing({ onClose }) {
  const [activeTab, setActiveTab] = useState('qr');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showArchGuide, setShowArchGuide] = useState(false);
  const [showCodeHint, setShowCodeHint] = useState(false);

  // Backend QrPayload: { service_name, password, text }
  // text = "WIFI:T:ADB;S:<service>;P:<password>;;" — QR olarak taratılacak string
  const fetchQr = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post('/api/pairing/qr');
      if (!res.service_name || !res.password || !res.text) {
        throw new Error('Geçerli eşleştirme verisi alınamadı. Backend yanıtı eksik alan içeriyor.');
      }
      const dataUrl = await QRCode.toDataURL(res.text, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      console.warn('[OpenDeX Wireless 📡] QR kodu oluşturulamadı:', err);
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchQr(); }, [fetchQr]);

  // Proactive fallback nudge (Cihaz Geçiş Planı §5.1): the backend's own
  // mDNS listener only warns in its log after 120s of silence — by the time
  // a user is staring at a QR code that never scans, that's a long wait.
  // Suggest the mDNS-independent 6-digit code well before that, without
  // waiting for the backend to give up.
  useEffect(() => {
    if (activeTab !== 'qr' || loading || error || !qrDataUrl) {
      setShowCodeHint(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowCodeHint(true), 45000);
    return () => window.clearTimeout(timer);
  }, [activeTab, loading, error, qrDataUrl]);

  const TABS = [
    { id: 'qr',   label: 'QR Kod',       desc: 'Kamerayla tara',       icon: QrCode },
    { id: 'code', label: '6 Haneli Kod',  desc: 'PIN / Kod ile',        icon: Hash },
    { id: 'ip',   label: '5555 / USB',    desc: 'Tek tıkla kablosuz',   icon: Zap },
  ];

  return (
    // Esc (escapeStack) ve dış tıklama Dialog'dan gelir; kart yüksekliği sekme değişince `layout` ile yumuşak büyür.
    <Dialog
      open
      onClose={onClose}
      label="Kablosuz Eşleştirme"
      align="top"
      overlayClassName="p-3 pb-10 pt-6 sm:p-6 sm:pt-10"
      className="relative flex max-w-[480px] shrink-0 flex-col overflow-hidden rounded-xl"
      cardProps={QR_CARD_LAYOUT}
    >
        {/* ── Titlebar ──────────────────────────────────────────────────── */}
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 select-none">
          <span className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-primary text-[10px] font-semibold text-primary-foreground">
            W
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold leading-none text-foreground">
              Kablosuz Eşleştirme
            </p>
            <p className="mt-0.5 truncate text-[9px] text-muted-foreground">
              OpenDeX · ADB Kablosuz Bağlantı Merkezi
            </p>
          </div>
          <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-background px-2 py-1 text-[9px] font-medium text-muted-foreground sm:inline-flex">
            <span className="size-1.5 rounded-full bg-status-active" />
            Dinleniyor
          </span>
          {onClose && (
            <IconButton label="Kapat" size="sm" danger="close" tooltipPosition="bottom" tooltipAlign="end" onClick={onClose}>
              <X />
            </IconButton>
          )}
        </header>

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 p-4 sm:p-5">

          {/* Tab Switcher */}
          <div className="grid grid-cols-3 gap-1.5 shrink-0">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  aria-pressed={active}
                  className={cn(
                    'flex flex-col items-start gap-0.5 p-2.5 rounded-md border text-left transition-colors cursor-pointer',
                    active
                      ? 'border-primary bg-primary/8 shadow-xs'
                      : 'border-border/60 bg-background/70 hover:border-border hover:bg-background'
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className={cn('size-3.5 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                    <span className={cn('text-[11px] font-semibold leading-[15px]', active ? 'text-foreground' : 'text-foreground/80')}>
                      {tab.label}
                    </span>
                    {active && (
                      <span className="ml-auto grid size-3.5 shrink-0 place-items-center rounded-full border border-primary bg-primary text-primary-foreground">
                        <Check className="size-2.5" />
                      </span>
                    )}
                  </span>
                  <span className="text-[9.5px] text-muted-foreground leading-tight pl-5">
                    {tab.desc}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Tab Content — Smooth animated layout transition */}
          <motion.div
            layout
            transition={{ layout: { duration: 0.26, ease: [0.4, 0, 0.2, 1] } }}
            className="relative"
          >
          <AnimatePresence mode="popLayout" initial={false}>
            {/* ── QR Kod ── */}
            {activeTab === 'qr' && (
              <motion.div
                key="tab-qr"
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="flex flex-col gap-2.5 w-full"
              >
                {/* Info strip */}
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border/60 bg-muted/40">
                  <Wifi className="size-3 shrink-0 text-primary" />
                  <span className="text-[10.5px] text-muted-foreground">
                    Wi-Fi ağı için ideal · Windows ağınızın <b className="text-foreground">"Özel Ağ"</b> olduğundan emin olun
                  </span>
                </div>

                {/* Hotspot limitation warning */}
                <div className="rounded-lg border border-border/70 bg-muted/40 p-3 text-[10.5px] text-muted-foreground leading-relaxed">
                  <span className="font-semibold text-foreground block mb-1 flex items-center gap-1.5 text-[11px]">
                    <AlertTriangle className="size-3.5 inline text-warning shrink-0" />
                    Önemli Ağ Kuralı: Telefon Hotspot Olamaz
                  </span>
                  Telefon dağıtıcı (Hotspot), laptop alıcı durumundayken Android kablosuz hata ayıklamayı başlatmaz. İki cihaz da <b className="text-foreground">aynı Wi-Fi ağına</b> bağlı olmalı veya <b className="text-foreground">Laptop'un Mobil Etkin Noktası</b> açılmalıdır (ya da <b className="text-foreground">«5555 / USB»</b> sekmesini kullanın).
                </div>

                <p className="text-[10.5px] text-muted-foreground leading-relaxed">
                  Telefonda <b className="text-foreground">Ayarlar → Geliştirici Seçenekleri → Kablosuz Hata Ayıklama → «QR kod ile eşleştir»</b> yolunu izleyip bu kodu tarayın.
                </p>

                {/* QR display */}
                <div className="flex flex-col items-center gap-2 py-0.5">
                  {loading ? (
                    <QrCodeSkeleton />
                  ) : error ? (
                    <div className="flex flex-col items-center gap-2.5 w-full p-4 rounded-lg border border-border/60 bg-muted/35">
                      <AlertTriangle className="size-5 text-muted-foreground" />
                      <p className="text-[11px] font-semibold text-foreground">QR Kod Üretilemedi</p>
                      <p className="text-[10px] text-muted-foreground text-center">{error}</p>
                      <button
                        type="button"
                        onClick={fetchQr}
                        className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold transition-colors hover:bg-primary/90 cursor-pointer"
                      >
                        <RotateCw className="size-3.5" />
                        <span>Tekrar Dene</span>
                      </button>
                    </div>
                  ) : qrDataUrl ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="p-2 bg-white rounded-lg border border-border/60 shadow-sm">
                        <img
                          src={qrDataUrl}
                          alt="OpenDeX Wireless Pairing QR"
                          className="size-[160px] rounded block"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={fetchQr}
                        className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      >
                        <RefreshCw className="size-3" />
                        <span>Kodu Yenile</span>
                      </button>
                    </div>
                  ) : null}
                </div>

                <AnimatePresence>
                  {showCodeHint && (
                    <motion.button
                      type="button"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      onClick={() => setActiveTab('code')}
                      className="flex w-full items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-2 text-left transition-colors hover:bg-warning/15 cursor-pointer"
                    >
                      <AlertTriangle className="size-3.5 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1 text-[10.5px] leading-snug text-foreground">
                        Telefon taramıyor gibi mi görünüyor? <b className="font-semibold">6 Haneli Kod</b> mDNS gerektirmez →
                      </span>
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {/* ── 6 Haneli Kod ── */}
            {activeTab === 'code' && (
              <motion.div
                key="tab-code"
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="flex flex-col gap-2.5 w-full"
              >
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border/60 bg-muted/40">
                  <ShieldCheck className="size-3 shrink-0 text-primary" />
                  <span className="text-[10.5px] text-muted-foreground">
                    mDNS ve Güvenlik Duvarı engellerini aşar · Doğrudan güvenli TCP
                  </span>
                </div>
                <PairingCodeEntry />
              </motion.div>
            )}

            {/* ── 5555 / USB ── */}
            {activeTab === 'ip' && (
              <motion.div
                key="tab-ip"
                initial={{ opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="flex flex-col gap-2.5 w-full"
              >
                <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border/60 bg-muted/40">
                  <Zap className="size-3 shrink-0 text-primary" />
                  <span className="text-[10.5px] text-muted-foreground">
                    Kabloyu 1 kez tak, sonsuza dek kablosuz kullan
                  </span>
                </div>
                <ManualIpEntry />
              </motion.div>
            )}
          </AnimatePresence>
          </motion.div>

          {/* ── Ağ Mimarisi Accordion ──────────────────────────────────── */}
          <div className="border-t border-border/50 pt-3">
            <button
              type="button"
              onClick={() => setShowArchGuide((p) => !p)}
              className="flex items-center justify-between w-full text-left group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="text-[11px] font-semibold text-foreground group-hover:text-primary transition-colors">
                  Neden "Özel Ağ (Private)" Gereklidir?
                </span>
              </div>
              {showArchGuide
                ? <ChevronUp className="size-3.5 text-muted-foreground" />
                : <ChevronDown className="size-3.5 text-muted-foreground" />
              }
            </button>

            <AnimatePresence>
              {showArchGuide && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2.5 flex flex-col gap-1.5">
                    {[
                      {
                        num: '1',
                        title: 'Windows Güvenlik Duvarı (Özel Ağ Kuralı)',
                        body: 'Ağ profili "Ortak (Public)" ise Windows, mDNS (UDP 5353) yayınlarını engeller. QR eşleştirme için Wi-Fi profilinin "Özel Ağ (Private)" olması gerekir.',
                      },
                      {
                        num: '2',
                        title: 'Android Hotspot İzolasyonu',
                        body: 'Taşınabilir Hotspot ağlarında Android, istemciler arası Multicast paketlerini pil/güvenlik gerekçesiyle köprülemez — bu bir hata değil, yerleşik güvenlik kuralıdır.',
                      },
                      {
                        num: '3',
                        title: 'OpenDeX Çözümü',
                        body: '«6 Haneli Kod» ve «5555 Modu», mDNS\'i tamamen devre dışı bırakıp doğrudan TCP soketiyle bağlantı kurar.',
                        accent: true,
                      },
                    ].map((item) => (
                      <div
                        key={item.num}
                        className={cn(
                          'flex items-start gap-2.5 rounded-md border p-2.5',
                          item.accent
                            ? 'border-border/60 bg-primary/5'
                            : 'border-border/60 bg-background/60'
                        )}
                      >
                        <span className={cn(
                          'text-[10px] font-bold shrink-0 mt-0.5',
                          item.accent ? 'text-primary' : 'text-muted-foreground'
                        )}>
                          {item.num}.
                        </span>
                        <div>
                          <p className="text-[11px] font-semibold text-foreground leading-tight mb-0.5">{item.title}</p>
                          <p className="text-[10px] text-muted-foreground leading-relaxed">{item.body}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
    </Dialog>
  );
}
