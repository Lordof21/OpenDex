// Boş sahne: çalan bir şey yok ya da telefon bağlı değil. Afişin dili korunur (serif italik başlık), hareket yok —
// sessizliği anlatan bir ekran kıpırdamaz. Simge kutusu ortam renginde; bağlı değilken fiş simgesi.

import React from 'react';
import { Music2, Unplug } from 'lucide-react';
import { t } from '../../i18n/index.js';

export function EmptyStage({ disconnected }) {
  const Icon = disconnected ? Unplug : Music2;
  return (
    <div className="flex flex-col items-center px-8 pb-10 pt-10 text-center" data-testid="media-empty">
      <span className="grid size-16 place-items-center rounded-[20px] bg-[var(--media-ink-faint)] ring-1 ring-foreground/[0.06]" aria-hidden="true">
        <Icon className="size-7 text-[var(--media-ink)]" strokeWidth={1.6} />
      </span>
      <p className="mt-6 font-display text-[30px] italic leading-[34px] tracking-[-0.01em] text-foreground">
        {disconnected ? t('common.telefon_bagli_degil') : t('taskbar.aktif_medya_yok')}
      </p>
      <p className="mt-2 max-w-[264px] text-[12.5px] leading-[19px] text-muted-foreground">
        {disconnected
          ? t('taskbar.medya_oturumlari_telefon_baglaninca')
          : t('taskbar.telefonunuzda_spotify_youtube_veya')}
      </p>
    </div>
  );
}

export default EmptyStage;
