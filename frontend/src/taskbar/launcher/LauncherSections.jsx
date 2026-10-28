// Çekmecenin içerik bölümleri: gezinti ("Tümü": Favoriler → Sık kullanılanlar → A–Z), tek görünüm (Favoriler / Açık / …) ve
// arama sonuçları; boş durumlar; harf dizini. Hepsi aynı `LauncherTile`ı kullanır (ızgara ya da liste).

import React from 'react';
import { EyeOff, History, Layers, SearchX, Settings2, Star } from 'lucide-react';
import { Callout } from '../../settings/controls.jsx';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { LauncherTile, optionKey } from './LauncherTile.jsx';
import { appId, letterOf } from './launcherModel.js';
import { viewLabel } from './LauncherRail.jsx';

const GRID_CLASS = '[grid-template-columns:repeat(auto-fill,minmax(92px,1fr))] grid gap-1';

function Heading({ children, action, className }) {
  return (
    <div className={cn('flex items-center justify-between gap-2 px-1', className)}>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</h3>
      {action}
    </div>
  );
}

function Empty({ icon: Icon, title, hint, action }) {
  return (
    <div className="mx-auto flex max-w-[420px] flex-col items-center gap-2 px-4 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground" aria-hidden="true">
        <Icon className="size-6" strokeWidth={1.6} />
      </span>
      <p className="text-[14px] font-semibold text-foreground">{title}</p>
      {hint && <p className="text-[12px] leading-[17px] text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

const EMPTY_VIEW = {
  favorites: { icon: Star, title: 'launcher.bos_favori', hint: 'launcher.bos_favori_ipucu' },
  frequent: { icon: History, title: 'launcher.bos_sik', hint: 'launcher.bos_sik_ipucu' },
  open: { icon: Layers, title: 'launcher.bos_acik' },
  system: { icon: Settings2, title: 'launcher.bos_sistem' },
  hidden: { icon: EyeOff, title: 'launcher.bos_gizli', hint: 'launcher.bos_gizli_ipucu' },
};

const RefreshButton = ({ onRefresh, busy }) => (
  <button
    type="button"
    onClick={onRefresh}
    disabled={busy}
    className="mt-1 cursor-pointer rounded-full border border-border/70 bg-background px-3 py-1 text-[11px] font-medium text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60"
  >
    {busy ? t('launcher.yenileniyor') : t('launcher.yenile')}
  </button>
);

/** İçerik: `query` varsa sonuçlar, yoksa görünüme göre gezinti / tek görünüm. */
export function LauncherSections({
  view, layout, query, results, browse, flat, ctx, activeKey, appsLoaded, refreshing,
  onOpen, onMenu, onRefresh, onToggleFrequent,
}) {
  const tile = (app, section, highlight = '', letter) => (
    <LauncherTile
      key={optionKey(section, app)}
      app={app}
      section={section}
      letter={letter}
      layout={layout}
      isOpen={ctx.open.has(appId(app))}
      onPhone={ctx.phone.has(appId(app))}
      favorite={ctx.favorites.has(appId(app))}
      active={activeKey === optionKey(section, app)}
      query={highlight}
      onOpen={onOpen}
      onMenu={onMenu}
    />
  );
  const gridClass = layout === 'list' ? 'flex flex-col gap-0.5' : GRID_CLASS;

  const banner = !appsLoaded && (
    <Callout
      tone="warn"
      title={t('launcher.liste_bos')}
      className="mb-4"
      action={<RefreshButton onRefresh={onRefresh} busy={refreshing} />}
    >
      {t('launcher.liste_bos_ipucu')}
    </Callout>
  );

  if (query) {
    if (!results.length) {
      return (
        <>
          {banner}
          <Empty
            icon={SearchX}
            title={t('launcher.sonuc_yok', { query: query.trim() })}
            hint={t('launcher.sonuc_yok_ipucu')}
            action={<RefreshButton onRefresh={onRefresh} busy={refreshing} />}
          />
        </>
      );
    }
    return (
      <section aria-label={t('launcher.sonuc_sayisi', { count: results.length })}>
        {banner}
        <Heading action={<span className="text-[10px] text-muted-foreground">{t('launcher.enter_ac')}</span>}>
          {t('launcher.sonuc_sayisi', { count: results.length })}
        </Heading>
        <div className={cn('mt-1.5', gridClass)}>{results.map((app) => tile(app, 'res', query))}</div>
      </section>
    );
  }

  if (view !== 'all') {
    if (!flat.length) {
      const empty = EMPTY_VIEW[view] || EMPTY_VIEW.open;
      return <Empty icon={empty.icon} title={t(empty.title)} hint={empty.hint ? t(empty.hint) : undefined} />;
    }
    return (
      <section aria-label={viewLabel(view)}>
        <Heading>{viewLabel(view)}</Heading>
        <div className={cn('mt-1.5', gridClass)}>{flat.map((app) => tile(app, view))}</div>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      {banner}
      {browse.favorites.length > 0 && (
        <section aria-label={t('launcher.b_favorites')}>
          <Heading>{t('launcher.b_favorites')}</Heading>
          <div className={cn('mt-1.5', gridClass)}>{browse.favorites.map((app) => tile(app, 'fav'))}</div>
        </section>
      )}
      {browse.frequent.length > 0 && (
        <section aria-label={t('launcher.b_frequent')}>
          <Heading
            action={(
              <button
                type="button"
                onClick={onToggleFrequent}
                className="cursor-pointer rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('launcher.sik_gizle')}
              </button>
            )}
          >
            {t('launcher.b_frequent')}
          </Heading>
          <div className={cn('mt-1.5', gridClass)}>{browse.frequent.map((app) => tile(app, 'freq'))}</div>
        </section>
      )}
      <section aria-label={t('launcher.b_all')}>
        <Heading>{t('launcher.b_all')}</Heading>
        {/* Düz alfabetik liste: harf başlığı yok, sağ kenardaki dizin ilgili harfin ilk uygulamasına atlar. */}
        {browse.sorted.length > 0 && (
          <div className={cn('mt-1.5', gridClass)}>
            {browse.sorted.map((app) => tile(app, 'all', '', browse.letters[letterOf(app)] === appId(app) ? letterOf(app) : undefined))}
          </div>
        )}
        {browse.sorted.length === 0 &&<Empty icon={SearchX} title={t('launcher.liste_bos')} hint={t('launcher.liste_bos_ipucu')} action={<RefreshButton onRefresh={onRefresh} busy={refreshing} />} />}
      </section>
      {browse.frequentCollapsed && (
        <button
          type="button"
          onClick={onToggleFrequent}
          className="cursor-pointer rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('launcher.sik_goster')}
        </button>
      )}
    </div>
  );
}

/** Sağ kenarda harf dizini (yalnız "Tümü" ve arama yokken, yeterince harf varsa): tıkla → o harfin ilk uygulamasına kay. */
export function LetterIndex({ groups, onJump }) {
  if (groups.length < 4) return null;
  return (
    <nav aria-label={t('launcher.harf_dizini')} className="absolute right-[7px] top-1/2 z-[2] hidden -translate-y-1/2 flex-col items-center gap-px rounded-full bg-background/70 py-1 backdrop-blur md:flex">
      {groups.map((group) => (
        <button
          key={group.key}
          type="button"
          tabIndex={-1}
          aria-label={group.key}
          onClick={() => onJump(group.key)}
          className="grid size-4 cursor-pointer place-items-center rounded-full text-[9px] font-semibold leading-none text-muted-foreground outline-none transition-colors hover:bg-primary/15 hover:text-primary"
        >
          {group.key}
        </button>
      ))}
    </nav>
  );
}
