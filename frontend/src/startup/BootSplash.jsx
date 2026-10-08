import { api } from '../lib/api.js';
import { BASE, ensureApiToken } from '../lib/apiToken.js';
import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Layers,
  Minus,
  Monitor,
  RotateCw,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { bootSteps } from './bootSteps.js';

const HEALTH_POLL_MS = 350;
const HEALTH_MAX_ATTEMPTS = 35; // ≈ 12 s for the backend process to answer at all
const STARTUP_POLL_MS = 300; // /api/startup is in-memory on the backend: it asks neither adb nor the phone
// A binding that never settles (an unanswered RSA prompt, a phone that keeps dropping) must not hold the desktop: past
// this the desktop opens with whatever is known, and its own connection UI takes over.
const STARTUP_MAX_MS = 25_000;
const READY_HOLD_MS = 450; // "Masaüstü hazır" stays readable for a moment before the splash fades

const STEP_ICONS = { core: Cpu, device: Smartphone, daemon: Activity, services: Layers };

export default function BootSplash({ onReady }) {
  const [stage, setStage] = useState({ core: 'pending', snapshot: null });
  const [run, setRun] = useState(0); // "Yeniden dene" starts the checks over without reloading the page
  // The parent passes a fresh arrow on every render; reading it through a ref keeps the checks below from restarting.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let active = true;
    let timer;
    let healthAttempts = 0;
    let coreOkAt = 0;
    const later = (fn, ms) => { timer = setTimeout(fn, ms); };
    const finish = () => later(() => { if (active) onReadyRef.current(); }, READY_HOLD_MS);

    const pollStartup = async () => {
      let snapshot;
      try {
        snapshot = await api.get('/api/startup');
      } catch {
        snapshot = null;
      }
      if (!active) return;
      if (!snapshot) {
        // No startup state to show (an older backend, a refused token): the core is up — the desktop can open.
        setStage({ core: 'ok', snapshot: null });
        finish();
        return;
      }
      setStage({ core: 'ok', snapshot });
      if (bootSteps('ok', snapshot).done || Date.now() - coreOkAt > STARTUP_MAX_MS) finish();
      else later(pollStartup, STARTUP_POLL_MS);
    };

    const checkHealth = async () => {
      healthAttempts += 1;
      try {
        // /api/health is the one unauthenticated route; the token is resolved right after (Tauri IPC / dev define).
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) {
          await ensureApiToken();
          if (!active) return;
          coreOkAt = Date.now();
          setStage({ core: 'ok', snapshot: null });
          pollStartup();
          return;
        }
      } catch { /* backend still starting */ }
      if (!active) return;
      if (healthAttempts < HEALTH_MAX_ATTEMPTS) later(checkHealth, HEALTH_POLL_MS);
      else setStage({ core: 'error', snapshot: null });
    };

    setStage({ core: 'pending', snapshot: null });
    checkHealth();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [run]);

  const { steps, progress: progressPercent, headline } = bootSteps(stage.core, stage.snapshot);
  const failed = stage.core === 'error';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 0.99, filter: 'blur(10px)' }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
      className="fixed inset-0 z-headsUpToast flex flex-col items-center justify-center overflow-hidden bg-background select-none"
    >
      {/* ── Masaüstü Skeleton Arka Plan ─────────────────────────────────────── */}
      <div className="pointer-events-none absolute inset-0 z-0 opacity-60 transition-opacity duration-700">
        {/* Sol üst: Uygulama ikonu iskeletleri */}
        <div className="p-8 grid grid-cols-2 sm:grid-cols-3 gap-6 w-fit">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex flex-col items-center gap-2">
              <div className="relative size-12 rounded-2xl bg-muted border border-border/40 overflow-hidden shadow-sm">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/5 to-transparent animate-shimmer" />
              </div>
              <div className="relative h-2.5 w-12 rounded bg-muted overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/8 to-transparent animate-shimmer" />
              </div>
            </div>
          ))}
        </div>

        {/* Orta: Pencere iskelet çerçevesi */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[720px] max-w-[90vw] h-[400px] rounded-xl border border-border/30 bg-popover/40 shadow-xl backdrop-blur-sm overflow-hidden hidden md:block">
          {/* Titlebar iskelet */}
          <div className="h-10 border-b border-border/30 bg-muted/30 px-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="size-3 rounded-full bg-window-close/30" />
              <div className="size-3 rounded-full bg-window-minimize/30" />
              <div className="size-3 rounded-full bg-window-expand/30" />
            </div>
            <div className="relative h-3 w-32 rounded bg-muted overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/8 to-transparent animate-shimmer" />
            </div>
            <div className="size-4" />
          </div>
          {/* Pencere içi iskelet */}
          <div className="p-6 space-y-4">
            <div className="relative h-28 rounded-xl bg-muted/50 border border-border/25 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/5 to-transparent animate-shimmer" />
            </div>
            <div className="grid grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="relative h-20 rounded-xl bg-muted/50 border border-border/25 overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/5 to-transparent animate-shimmer" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Alt: Taskbar iskelet */}
        <div className="fixed bottom-0 inset-x-0 h-[50px] border-t border-border/30 bg-taskbar backdrop-blur-xl px-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="relative size-9 rounded-xl bg-muted border border-border/40 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/10 to-transparent animate-shimmer" />
            </div>
            <div className="relative size-9 rounded-xl bg-muted/70 border border-border/30 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/8 to-transparent animate-shimmer" />
            </div>
            <div className="h-4 w-px bg-border/50 mx-1" />
            {[...Array(4)].map((_, i) => (
              <div key={i} className="relative size-9 rounded-xl bg-muted/50 border border-border/25 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/8 to-transparent animate-shimmer" />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <div className="relative h-4 w-12 rounded bg-muted/60 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/8 to-transparent animate-shimmer" />
            </div>
            <div className="relative h-6 w-20 rounded-xl bg-muted/60 border border-border/30 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/8 to-transparent animate-shimmer" />
            </div>
          </div>
        </div>
      </div>

      {/* ── Merkez HUD Kartı ─────────────────────────────────────────────────── */}
      <motion.div
        initial={{ scale: 0.97, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ duration: 0.38, ease: 'easeOut' }}
        className="relative z-10 flex flex-col items-center w-full max-w-[460px] rounded-xl border border-border/80 bg-popover/95 backdrop-blur-2xl shadow-[var(--shadow-window)] p-6 sm:p-8"
      >
        {/* ── Logo ──────────────────────────────────────────────────────────── */}
        <div className="relative mb-5 flex items-center justify-center">
          <div className="relative size-16 rounded-2xl border border-border/60 bg-muted/50 p-0.5 shadow-md flex items-center justify-center overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-primary/5" />
            <motion.div
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ repeat: Infinity, duration: 2.4, ease: 'easeInOut' }}
              className="relative flex items-center justify-center text-primary"
            >
              <Monitor className="size-8 drop-shadow-sm" />
              <Smartphone className="size-4 absolute -bottom-1 -right-1 text-muted-foreground" />
            </motion.div>
          </div>
        </div>

        {/* ── Başlık ────────────────────────────────────────────────────────── */}
        <div className="text-center mb-5">
          <div className="flex items-center justify-center gap-2 mb-1">
            <h1 className="text-[22px] font-black tracking-tight text-foreground">
              Open<span className="text-primary">DeX</span>
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-primary/12 text-primary border border-primary/20">
              v0.1.0
            </span>
          </div>
          <p className="text-[11px] text-muted-foreground font-medium">
            Yeni Nesil Android Masaüstü ve Çoklu Görev Motoru
          </p>
        </div>

        {/* ── İlerleme Çubuğu ───────────────────────────────────────────────── */}
        <div className="w-full mb-5">
          <div className="flex items-center justify-between text-[10.5px] font-semibold mb-1.5">
            <span className="text-muted-foreground flex min-w-0 items-center gap-1.5">
              <span className={`size-1.5 rounded-full ${failed ? 'bg-window-close' : 'bg-primary animate-ping'}`} />
              <span className="truncate" aria-live="polite">{headline}</span>
            </span>
            <span className="font-mono text-primary tabular-nums">{progressPercent}%</span>
          </div>
          <div className="relative h-1.5 w-full rounded-full bg-muted overflow-hidden border border-border/40">
            <motion.div
              className="h-full rounded-full bg-primary relative"
              initial={{ width: '15%' }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.35, ease: 'easeOut' }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary-foreground/20 to-transparent animate-shimmer" />
            </motion.div>
          </div>
        </div>

        {/* ── Sistem Adımları (gerçek durum: bootSteps.js) ─────────────────── */}
        <div className="w-full flex flex-col gap-1.5 mb-4">
          {steps.map((step) => {
            const Icon = STEP_ICONS[step.id];
            const settled = step.status === 'done' || step.status === 'warn' || step.status === 'skipped';
            const current = step.status === 'active';
            return (
              <div
                key={step.id}
                className={`flex items-center justify-between p-2.5 rounded-md border transition-all duration-200 ${
                  step.status === 'error'
                    ? 'border-window-close/40 bg-window-close/5 text-foreground'
                    : settled
                    ? 'border-border/60 bg-muted/30 text-foreground'
                    : current
                    ? 'border-primary/30 bg-primary/6 text-foreground shadow-xs'
                    : 'border-border/40 bg-background/50 text-muted-foreground opacity-55'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className={`size-7 rounded-md flex items-center justify-center shrink-0 border ${
                    step.status === 'done'
                      ? 'bg-muted border-border/50 text-status-active'
                      : step.status === 'warn'
                      ? 'bg-muted border-border/50 text-warning'
                      : current
                      ? 'bg-primary/10 border-primary/30 text-primary'
                      : 'bg-background border-border/30 text-muted-foreground'
                  }`}>
                    <Icon className="size-3.5" />
                  </div>
                  <div className="min-w-0 text-left">
                    <p className="text-[11px] font-semibold truncate leading-tight">{step.label}</p>
                    <p className="text-[9.5px] opacity-70 truncate" title={step.detail}>{step.detail}</p>
                  </div>
                </div>

                <div className="shrink-0 ml-2" aria-label={step.status}>
                  {step.status === 'done' ? (
                    <CheckCircle2 className="size-4 text-status-active" />
                  ) : step.status === 'warn' ? (
                    <AlertTriangle className="size-4 text-warning" />
                  ) : step.status === 'error' ? (
                    <AlertTriangle className="size-4 text-window-close" />
                  ) : step.status === 'skipped' ? (
                    <Minus className="size-4 text-muted-foreground" />
                  ) : current ? (
                    <div className="size-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                  ) : (
                    <div className="size-2 rounded-full bg-border mx-1" />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Hata Durumu ───────────────────────────────────────────────────── */}
        <AnimatePresence>
          {failed && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="w-full pt-3 border-t border-border/50"
            >
              <div className="flex items-start gap-2.5 p-3 rounded-lg border border-border/60 bg-muted/40 text-foreground mb-3">
                <AlertTriangle className="size-4 text-window-close shrink-0 mt-0.5" />
                <div className="text-xs">
                  <p className="font-semibold text-foreground mb-0.5">Bağlantı kurulamadı</p>
                  <p className="text-[10.5px] text-muted-foreground leading-relaxed">
                    OpenDeX arka uç servisi yanıt vermiyor. Yeniden deneyin; sorun sürerse OpenDeX&apos;i kapatıp yeniden açın.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setRun((n) => n + 1)}
                className="w-full flex items-center justify-center gap-2 h-9 rounded-md bg-primary text-primary-foreground text-[11px] font-semibold transition-colors hover:bg-primary/90 cursor-pointer"
              >
                <RotateCw className="size-3.5" />
                <span>Yeniden Dene</span>
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ── Alt Etiket ──────────────────────────────────────────────────────── */}
      <div className="absolute bottom-4 z-10 flex items-center gap-2 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
        <Sparkles className="size-3 text-primary/50" />
        <span>OpenDeX Engine · Localhost IPC Gateway</span>
      </div>
    </motion.div>
  );
}
