import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/files/fsApi.js', () => ({
  fsApi: {
    transfers: {
      list: vi.fn(),
      create: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      resolve: vi.fn(),
      remove: vi.fn(async () => ({ ok: true })),
    },
  },
}));

import { fsApi } from '../../src/files/fsApi.js';
import { useSystemStore } from '../../src/state/systemStore.js';
import { jobProgress, jobTitle, overallProgress, selectActiveJobs, selectConflictJob, summarizeJob, useTransferStore } from '../../src/files/transferStore.js';

const job = (over = {}) => ({
  id: 'j1', op: 'copy', state: 'running', source_count: 3, sources: [{ provider: 'phone' }], dest: { provider: 'pc' },
  total_files: 3, total_bytes: 300, done_files: 1, done_bytes: 100, skipped: 0, failed: 0, speed: 50, errors: [], conflict: null, ...over,
});

beforeEach(() => {
  useTransferStore.setState({ jobs: {}, order: [], loaded: false, trayOpen: false });
  useSystemStore.setState({ toasts: [] });
  vi.clearAllMocks();
});

describe('özet', () => {
  it.each([
    [{ state: 'completed', done_files: 12, dest: { provider: 'pc' } }, "12 dosya bilgisayara kopyalandı.", 'success'],
    [{ state: 'completed', done_files: 12, op: 'move', dest: { provider: 'phone' } }, '12 dosya telefona taşındı. Galeri ve müzik uygulamaları yeni dosyaları görecek.', 'success'],
    [{ state: 'completed', done_files: 5, skipped: 2, dest: { provider: 'pc' } }, '5 dosya bilgisayara kopyalandı (2 atlandı).', 'success'],
    [{ state: 'completed', done_files: 5, failed: 1, skipped: 1, dest: { provider: 'pc' } }, '5 dosya bilgisayara kopyalandı — 1 atlandı, 1 hata.', 'warning'],
    [{ state: 'failed', error: { message: 'Hedefte yeterli yer yok.' } }, 'Hedefte yeterli yer yok.', 'error'],
    [{ state: 'cancelled', done_files: 3, dest: { provider: 'pc' } }, 'İşlem iptal edildi (3 dosya kopyalandı).', 'info'],
  ])('%j', (over, message, tone) => expect(summarizeJob(job(over))).toEqual({ message, tone }));

  it('başlık ve ilerleme', () => {
    expect(jobTitle(job())).toBe('3 öğe · Telefon → Bilgisayar');
    expect(jobProgress(job())).toBeCloseTo(33.33, 1);
    expect(jobProgress(job({ state: 'scanning' }))).toBeNull();                 // belirsiz çubuk
    expect(jobProgress(job({ total_bytes: 0, state: 'running' }))).toBeNull();
    expect(jobProgress(job({ total_bytes: 0, state: 'completed' }))).toBe(100);
  });
});

describe('olaylar', () => {
  it('yeni iş tepsiyi açar; ilerleme günceller; sıra korunur', () => {
    const { applyJob } = useTransferStore.getState();
    applyJob(job());
    applyJob(job({ done_bytes: 200 }));
    applyJob(job({ id: 'j2' }));
    const s = useTransferStore.getState();
    expect(s.order).toEqual(['j1', 'j2']);
    expect(s.jobs.j1.done_bytes).toBe(200);
    expect(s.trayOpen).toBe(true);
  });

  it('bitmiş işi geç gelen eski ilerleme olayı geri çevirmez', () => {
    const { applyJob } = useTransferStore.getState();
    applyJob(job({ state: 'completed', done_bytes: 300 }));
    applyJob(job({ state: 'running', done_bytes: 250 }));
    expect(useTransferStore.getState().jobs.j1.state).toBe('completed');
  });

  it('tamamlanınca BİR kez bildirim: ton ve metin', () => {
    const { applyJob } = useTransferStore.getState();
    applyJob(job());
    applyJob(job({ state: 'completed', done_files: 3, done_bytes: 300 }));
    applyJob(job({ state: 'completed', done_files: 3, done_bytes: 300 }));      // tekrar eden olay
    const toasts = useSystemStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('3 dosya bilgisayara kopyalandı.');
    expect(toasts[0].tone).toBe('success');
  });

  it('açılışta yüklenen eski işler sessizce gelir (bildirim yok, tepsi kapalı)', async () => {
    fsApi.transfers.list.mockResolvedValue({ items: [job({ id: 'old', state: 'completed' })] });
    await useTransferStore.getState().load();
    const s = useTransferStore.getState();
    expect(s.loaded).toBe(true);
    expect(s.order).toEqual(['old']);
    expect(s.trayOpen).toBe(false);
    expect(useSystemStore.getState().toasts).toHaveLength(0);
  });

  it('başlat: REST yanıtı da aynı yoldan işlenir', async () => {
    fsApi.transfers.create.mockResolvedValue(job({ id: 'n1', state: 'queued' }));
    const created = await useTransferStore.getState().start({ op: 'copy', sources: [], dest: {} });
    expect(created.id).toBe('n1');
    expect(useTransferStore.getState().jobs.n1.state).toBe('queued');
  });
});

describe('seçiciler ve eylemler', () => {
  it('etkin işler, çakışma, toplam', () => {
    const { applyJob } = useTransferStore.getState();
    applyJob(job({ id: 'a', speed: 100 }), { quiet: true });
    applyJob(job({ id: 'b', state: 'waiting', conflict: { name: 'x.txt', choices: ['replace'] }, speed: 0 }), { quiet: true });
    applyJob(job({ id: 'c', state: 'completed' }), { quiet: true });
    const s = useTransferStore.getState();
    expect(selectActiveJobs(s).map((j) => j.id)).toEqual(['a', 'b']);
    expect(selectConflictJob(s).id).toBe('b');
    const all = overallProgress(selectActiveJobs(s));
    expect(all.count).toBe(2);
    expect(all.speed).toBe(100);
    expect(all.waiting).toBe(true);
    expect(all.pct).toBeCloseTo(33.33, 1);
    expect(overallProgress([]).pct).toBeNull();
  });

  it('çakışmayı yanıtla, durdur/sürdür/iptal REST’e gider', async () => {
    const st = useTransferStore.getState();
    await st.resolve('b', 'keep_both', true);
    await st.pause('a');
    await st.resume('a');
    await st.cancel('a');
    expect(fsApi.transfers.resolve).toHaveBeenCalledWith('b', 'keep_both', true);
    expect(fsApi.transfers.pause).toHaveBeenCalledWith('a');
    expect(fsApi.transfers.resume).toHaveBeenCalledWith('a');
    expect(fsApi.transfers.cancel).toHaveBeenCalledWith('a');
  });

  it('yalnız bitmiş iş kapatılır; hepsini temizle', async () => {
    const { applyJob } = useTransferStore.getState();
    applyJob(job({ id: 'run' }), { quiet: true });
    applyJob(job({ id: 'done', state: 'completed' }), { quiet: true });
    await useTransferStore.getState().dismiss('run');
    expect(useTransferStore.getState().order).toEqual(['run', 'done']);
    await useTransferStore.getState().clearFinished();
    expect(useTransferStore.getState().order).toEqual(['run']);
    expect(fsApi.transfers.remove).toHaveBeenCalledWith('done');
  });
});
