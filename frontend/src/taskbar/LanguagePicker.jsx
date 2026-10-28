import React, { useMemo, useRef, useState } from 'react';
import { Check, Languages, Search, X } from 'lucide-react';
import { activeLocale, changeLanguage, currentLanguage, describeLanguages, systemLanguage, t } from '../i18n/index.js';
import { cn } from '../lib/utils.js';

// Arama için büyük/küçük harf ve aksan farkı yok sayılır ("turkce" → "Türkçe", "espanol" → "Español").
const fold = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

// Intl.DisplayNames oluşturmak (ICU verisi) pahalıdır: arayüz dili başına bir kez.
const displayNames = new Map();

/** Dilin ARAYÜZ dilindeki adı ("Japonca" / "Japanese"): yalnızca ikinci satır ve arama içindir; desteklenmeyen kodda boş. */
export function languageLabel(code, locale = activeLocale()) {
  try {
    if (!displayNames.has(locale)) displayNames.set(locale, new Intl.DisplayNames([locale], { type: 'language' }));
    return displayNames.get(locale).of(code) || '';
  } catch {
    return '';
  }
}

/** Yerel ad, arayüz dilindeki ad ve koda göre süzer; boş arama hepsini döndürür. */
export function filterLanguages(languages, query) {
  const needle = fold(query).trim();
  if (!needle) return languages;
  return languages.filter(({ code, name, label }) => fold(`${name} ${label} ${code}`).includes(needle));
}

const CodeBadge = ({ code, active }) => (
  <span
    className={cn(
      'grid h-6 w-9 shrink-0 place-items-center rounded-md text-[9px] font-bold tracking-wide',
      active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
    )}
    aria-hidden="true"
  >
    {code.toUpperCase()}
  </span>
);

/** Dil listesi: arama kutusu, yerel ad + arayüz dilindeki ad, sistem dili ipucu, ok tuşlarıyla gezinme. Seçince sayfa yeniden yüklenir. */
export function LanguageView() {
  const active = currentLanguage();
  const system = useMemo(() => systemLanguage(), []);
  // Liste eşzamanlıdır (adlar derleme zamanında gelir): panel ilk karede tam çizilir, hiçbir dil paketi yüklenmez.
  const languages = useMemo(() => describeLanguages().map((item) => ({ ...item, label: languageLabel(item.code) })), []);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const visible = useMemo(() => filterLanguages(languages, query), [languages, query]);

  const options = () => [...(listRef.current?.querySelectorAll('[data-language-option]') ?? [])];
  const onKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = options();
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') items[Math.min(at + 1, items.length - 1)].focus();
    else if (at <= 0) searchRef.current?.focus();
    else items[at - 1].focus();
  };
  const onSearchKeyDown = (event) => {
    if (event.key === 'Enter' && visible.length === 1) changeLanguage(visible[0].code);
  };

  return (
    <div onKeyDown={onKeyDown}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
          <Languages className="size-3.5" aria-hidden="true" />
        </span>
        <p className="flex-1 truncate text-xs font-semibold">{t('taskbar.dil')}</p>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground" aria-hidden="true">
          {languages.length}
        </span>
      </div>

      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t('taskbar.dil_ara')}
          aria-label={t('taskbar.dil_ara')}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-7 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-primary"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
            aria-label={t('common.aramayi_temizle')}
            className="absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground cursor-pointer hover:text-foreground"
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label={t('taskbar.dil')}
        className="dex-scroll -mr-1 max-h-[min(18rem,calc(100vh-260px))] space-y-0.5 overflow-y-auto overscroll-contain pr-1"
      >
        {visible.map(({ code, name, label }) => {
          const isActive = code === active;
          // Yerel adla aynıysa ikinci satır gereksiz; sistem dilinin ipucu aynı satıra eklenir (düzen kaymaz).
          const sub = [fold(label) === fold(name) ? '' : label, code === system ? t('taskbar.sistem_dili') : ''].filter(Boolean).join(' · ');
          return (
            <button
              key={code}
              type="button"
              role="option"
              lang={code}
              aria-selected={isActive}
              data-language-option
              onClick={() => changeLanguage(code)}
              className={cn(
                'flex min-h-10 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                isActive && 'bg-accent text-accent-foreground',
              )}
            >
              <CodeBadge code={code} active={isActive} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium leading-tight">{name}</span>
                {sub && (
                  <span className="block truncate text-[10px] leading-tight text-muted-foreground" lang={activeLocale()}>
                    {sub}
                  </span>
                )}
              </span>
              {isActive && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
            </button>
          );
        })}
        {!visible.length && <p className="px-2 py-6 text-center text-[11px] text-muted-foreground">{t('taskbar.dil_bulunamadi')}</p>}
      </div>

      <p className="mt-2 px-1 text-[10px] leading-snug text-muted-foreground">{t('taskbar.dil_degisince_yeniden_yuklenir')}</p>
    </div>
  );
}
