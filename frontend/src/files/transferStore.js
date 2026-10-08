// Aktarım işleri (kopyala/taşı) — backend'in `fs_transfer` olaylarının tek ön yüz kopyası. Bileşenler yalnız buradan okur;
// işi backend yürütür (pencere kapansa da sürer), ön yüz izler, durdurur, çakışmaları yanıtlar.
import { create } from 'zustand';
import { useSystemStore } from '../state/systemStore.js';
import { fsApi } from './fsApi.js';
import { countLabel, percent } from './formatters.js';

export const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const WHERE = { phone: 'telefona', pc: 'bilgisayara' };
const FROM = { phone: 'Telefon', pc: 'Bilgisayar' };

/** Tamamlanan işin kullanıcıya gösterilecek özeti: { message, tone }. Saf (testli). */
export function summarizeJob(job) {
  const dest = job.dest?.provider;
  const verb = job.op === 'move' ? 'taşındı' : 'kopyalandı';
  if (job.state === 'cancelled') return { message: `İşlem iptal edildi (${countLabel(job.done_files, 'dosya')} ${verb}).`, tone: 'info' };
  if (job.state === 'failed') return { message: job.error?.message || 'Aktarım başarısız oldu.', tone: 'error' };
  const base = `${countLabel(job.done_files, 'dosya')} ${WHERE[dest] ?? ''} ${verb}`.replace(/\s+/g, ' ');
  const notes = [];
  if (job.skipped) notes.push(`${job.skipped} atlandı`);
  if (job.failed) notes.push(`${job.failed} hata`);
  if (job.failed) return { message: `${base} — ${notes.join(', ')}.`, tone: 'warning' };
  const gallery = dest === 'phone' && job.done_files > 0 ? ' Galeri ve müzik uygulamaları yeni dosyaları görecek.' : '';
  return { message: `${base}${notes.length ? ` (${notes.join(', ')})` : ''}.${gallery}`, tone: 'success' };
}

/** İşin başlığı: "12 öğe · Telefon → Bilgisayar". */
export function jobTitle(job) {
  const from = FROM[job.sources?.[0]?.provider] ?? '';
  const to = FROM[job.dest?.provider] ?? '';
  return `${countLabel(job.source_count ?? job.sources?.length ?? 0)} · ${from} → ${to}`;
}

export function jobProgress(job) {
  if (job.state === 'scanning' || job.total_bytes === 0) return job.state === 'completed' ? 100 : null; // belirsiz
  return percent(job.done_bytes, job.total_bytes);
}

export const useTransferStore = create((set, get) => ({
  jobs: {},
  order: [],
  loaded: false,
  trayOpen: false,

  async load() {
    try {
      const { items } = await fsApi.transfers.list();
      items.forEach((job) => get().applyJob(job, { quiet: true }));
    } finally {
      set({ loaded: true });
    }
  },

  /** Olaydan ya da REST yanıtından gelen anlık görüntü. Eski bir durumun yenisini ezmesi (geç gelen ilerleme) engellenir. */
  applyJob(job, { quiet = false } = {}) {
    const previous = get().jobs[job.id];
    if (previous && TERMINAL.has(previous.state) && !TERMINAL.has(job.state)) return;
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: job },
      order: s.order.includes(job.id) ? s.order : [...s.order, job.id],
      // Tepsi: yeni iş başlayınca ve BİR KARAR beklenince (çakışma) kendiliğinden açılır — iş duruyor, kullanıcı görmeli.
      trayOpen: s.trayOpen || (!quiet && ((!previous && !TERMINAL.has(job.state)) || (Boolean(job.conflict) && !previous?.conflict))),
    }));
    if (!quiet && TERMINAL.has(job.state) && !(previous && TERMINAL.has(previous.state))) {
      const { message, tone } = summarizeJob(job);
      useSystemStore.getState().pushToast?.(message, { tone });
    }
  },

  async start(spec) {
    const job = await fsApi.transfers.create(spec);
    get().applyJob(job);
    return job;
  },

  async pause(id) { await fsApi.transfers.pause(id); },
  async resume(id) { await fsApi.transfers.resume(id); },
  async cancel(id) { await fsApi.transfers.cancel(id); },

  async resolve(id, resolution, applyToAll = false) {
    await fsApi.transfers.resolve(id, resolution, applyToAll);
  },

  async dismiss(id) {
    const job = get().jobs[id];
    if (!job || !TERMINAL.has(job.state)) return;
    set((s) => {
      const { [id]: _gone, ...rest } = s.jobs;
      return { jobs: rest, order: s.order.filter((x) => x !== id) };
    });
    try {
      await fsApi.transfers.remove(id);
    } catch {
      /* sunucuda zaten yok */
    }
  },

  async clearFinished() {
    const finished = get().order.filter((id) => TERMINAL.has(get().jobs[id]?.state));
    await Promise.all(finished.map((id) => get().dismiss(id)));
  },

  setTrayOpen: (trayOpen) => set({ trayOpen }),
}));

// ── Seçiciler ───────────────────────────────────────────────────────────────────────────────────────────────
export const selectJobs = (s) => s.order.map((id) => s.jobs[id]).filter(Boolean);
export const selectActiveJobs = (s) => selectJobs(s).filter((j) => !TERMINAL.has(j.state));
/** Yanıt bekleyen ilk çakışma (iş durmuş, kullanıcı karar verecek). */
export const selectConflictJob = (s) => selectJobs(s).find((j) => j.conflict) || null;

/** Tüm etkin işlerin toplamı: görev çubuğu / tepsi özeti için. */
export function overallProgress(jobs) {
  const active = jobs.filter((j) => !TERMINAL.has(j.state));
  const total = active.reduce((a, j) => a + (j.total_bytes || 0), 0);
  const done = active.reduce((a, j) => a + (j.done_bytes || 0), 0);
  return {
    count: active.length,
    pct: total > 0 ? percent(done, total) : null,
    speed: active.reduce((a, j) => a + (j.speed || 0), 0),
    waiting: active.some((j) => j.state === 'waiting'),
    paused: active.length > 0 && active.every((j) => j.pause_reason),
  };
}
