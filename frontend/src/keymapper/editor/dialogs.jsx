// Düzenleyici iletişim kutuları: tür şablonu, içe aktar, başka uygulamadan kopyala.
import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, LayoutTemplate, Pencil, Trash2 } from 'lucide-react';
import { Dialog } from '../../ui/Dialog.jsx';
import Button from '../../ui/Button.jsx';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { TEMPLATES, buildTemplate } from '../templates.js';
import { TEMPLATE_NAME_MAX, USER_TEMPLATE_LIMIT } from '../keymapStore.js';
import { tip } from './tip.js';

const IMPORT_ERRORS = {
  invalid_json: () => t('keymapper.ice_aktar_hata_gecersiz_json'),
  not_a_layout: () => t('keymapper.ice_aktar_hata_duzen_degil'),
  no_valid_nodes: () => t('keymapper.ice_aktar_hata_gecerli_dugum_yok'),
};

/** Şablonun küçük önizlemesi (16:9): halka = tuş, büyük halka = joystick, kesikli = bakış alanı. */
function TemplatePreview({ nodes }) {
  return (
    <svg viewBox="0 0 160 90" role="img" aria-hidden="true" className="aspect-video w-full rounded-lg border border-border/60 bg-muted/60">
      {nodes.map((node) => {
        const cx = node.rx * 160;
        const cy = node.ry * 90;
        if (node.type === 'dpad') return <circle key={node.id} cx={cx} cy={cy} r={(node.radius ?? 0.12) * 90} className="fill-primary/15 stroke-primary" strokeWidth="1" />;
        if (node.type === 'look') return <circle key={node.id} cx={cx} cy={cy} r={(node.radius ?? 0.18) * 90} className="fill-none stroke-primary/70" strokeWidth="1" strokeDasharray="3 2" />;
        return <circle key={node.id} cx={cx} cy={cy} r={Math.max(2.2, (node.size ?? 0.045) * 90)} className="fill-primary/25 stroke-primary" strokeWidth="0.8" />;
      })}
    </svg>
  );
}

/** Kullanıcının kendi şablon kartı: tıkla = uygula; kalem = adını değiştir; çöp = sil (ilk tık onay ister). */
function UserTemplateCard({ template, onApply, onRename, onDelete }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(template.name);
  const [armed, setArmed] = useState(false);
  const commit = () => {
    if (name.trim() && name.trim() !== template.name) onRename(template.id, name);
    else setName(template.name);
    setRenaming(false);
  };
  return (
    <div data-user-template={template.id} className="space-y-2 rounded-xl border border-border/70 bg-background/60 p-2">
      <button type="button" aria-label={template.name} onClick={() => onApply(template.id)} className="block w-full cursor-pointer">
        <TemplatePreview nodes={template.nodes} />
      </button>
      <div className="flex items-center gap-1">
        {renaming ? (
          <input
            autoFocus
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            aria-label={t('keymapper.sablon_adi')}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setName(template.name);
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 rounded-lg border border-primary bg-muted/60 px-2 py-1 text-xs font-bold text-foreground outline-none"
          />
        ) : (
          <button type="button" onClick={() => onApply(template.id)} className="min-w-0 flex-1 cursor-pointer truncate text-left text-xs font-bold text-foreground">{template.name}</button>
        )}
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{template.nodes.length}</span>
        <button type="button" onClick={() => setRenaming(true)} aria-label={t('keymapper.sablon_adini_degistir')} {...tip(t('keymapper.sablon_adini_degistir'))} className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer">
          <Pencil className="size-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => (armed ? onDelete(template.id) : setArmed(true))}
          onBlur={() => setArmed(false)}
          aria-label={armed ? t('keymapper.silmek_icin_tekrar_tikla') : t('keymapper.sablonu_sil')}
          {...tip(armed ? t('keymapper.silmek_icin_tekrar_tikla') : t('keymapper.sablonu_sil'), 'top', 'end')}
          className={cn('grid size-6 shrink-0 place-items-center rounded-md transition-colors cursor-pointer', armed ? 'bg-destructive text-destructive-foreground' : 'text-destructive hover:bg-destructive/15')}
        >
          <Trash2 className="size-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function TemplatesDialog({ open, onClose, onApply, hasLayout, userTemplates = [], canSave = false, onSave, onApplyUser, onRenameUser, onDeleteUser }) {
  const previews = useMemo(() => (open ? Object.fromEntries(TEMPLATES.map(({ id }) => [id, buildTemplate(id) || []])) : {}), [open]);
  const [name, setName] = useState('');
  const full = userTemplates.length >= USER_TEMPLATE_LIMIT;
  const save = () => {
    if (onSave?.(name)) setName('');
  };
  return (
    <Dialog open={open} onClose={onClose} label={t('keymapper.sablonlar')} overlayClassName="pointer-events-auto" className="max-w-xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <LayoutTemplate className="size-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">{t('keymapper.sablonlar')}</h3>
      </div>
      <p className="mb-3 text-[11px] leading-snug text-muted-foreground">
        {hasLayout ? t('keymapper.sablon_mevcut_duzenin_yerine_gecer_geri_alinabilir') : t('keymapper.sablon_baslangic_noktasidir')}
      </p>

      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('keymapper.benim_sablonlarim')}</h4>
      {userTemplates.length === 0 ? (
        <p className="mb-2 rounded-xl border border-dashed border-border/70 px-3 py-2.5 text-[11px] leading-snug text-muted-foreground">{t('keymapper.henuz_sablonun_yok')}</p>
      ) : (
        <div className="mb-2 grid grid-cols-2 gap-3">
          {userTemplates.map((template) => (
            <UserTemplateCard key={template.id} template={template} onApply={onApplyUser} onRename={onRenameUser} onDelete={onDeleteUser} />
          ))}
        </div>
      )}
      <form
        className="mb-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input
          value={name}
          maxLength={TEMPLATE_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('keymapper.sablon_adi')}
          aria-label={t('keymapper.sablon_adi')}
          className="h-9 min-w-0 flex-1 rounded-xl border border-border/70 bg-muted/60 px-2.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
        />
        <Button type="submit" size="sm" disabled={!canSave || !name.trim() || full}>{t('keymapper.mevcut_duzeni_kaydet')}</Button>
      </form>
      {full && <p className="-mt-3 mb-3 text-[10.5px] text-muted-foreground">{t('keymapper.sablon_siniri', { count: USER_TEMPLATE_LIMIT })}</p>}

      <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t('keymapper.hazir_sablonlar')}</h4>
      <div className="grid grid-cols-2 gap-3">
        {TEMPLATES.map(({ id, name: templateName, description }) => (
          <button
            key={id}
            type="button"
            data-template={id}
            onClick={() => onApply(id)}
            className="space-y-2 rounded-xl border border-border/70 bg-background/60 p-2 text-left transition-colors hover:border-primary hover:bg-accent/50 cursor-pointer"
          >
            <TemplatePreview nodes={previews[id] || []} />
            <div>
              <p className="text-xs font-bold text-foreground">{templateName()}</p>
              <p className="text-[10.5px] leading-snug text-muted-foreground">{description()}</p>
            </div>
          </button>
        ))}
      </div>
      <Button variant="outline" size="sm" className="mt-3 w-full" onClick={onClose}>{t('common.vazgec')}</Button>
    </Dialog>
  );
}

export function ImportDialog({ open, onClose, onImport }) {
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const submit = () => {
    const result = onImport(text);
    if (result.ok) {
      setText('');
      setError(null);
      onClose();
    } else {
      setError(result.error);
    }
  };
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} label={t('keymapper.ice_aktar')} overlayClassName="pointer-events-auto" className="max-w-lg p-4">
      <div className="mb-2 flex items-center gap-2">
        <Download className="size-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">{t('keymapper.ice_aktar')}</h3>
      </div>
      <p className="mb-2 text-[11px] leading-snug text-muted-foreground">{t('keymapper.ice_aktar_aciklama')}</p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        rows={8}
        spellCheck={false}
        aria-label={t('keymapper.duzen_metni')}
        placeholder='{ "format": "opendex-keymap", "nodes": [ … ] }'
        className="w-full resize-none rounded-xl border border-border/70 bg-muted/60 p-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
      />
      {error && <p role="alert" className="mt-1.5 text-[11px] font-medium text-destructive">{(IMPORT_ERRORS[error] || IMPORT_ERRORS.not_a_layout)()}</p>}
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={close}>{t('common.vazgec')}</Button>
        <Button size="sm" className="flex-1" disabled={!text.trim()} onClick={submit}>{t('keymapper.ice_aktar')}</Button>
      </div>
    </Dialog>
  );
}

export function CopyFromDialog({ open, onClose, sources, onCopy }) {
  return (
    <Dialog open={open} onClose={onClose} label={t('keymapper.baska_uygulamadan_kopyala')} overlayClassName="pointer-events-auto" className="max-w-sm p-4">
      <div className="mb-2 flex items-center gap-2">
        <Copy className="size-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-bold text-foreground">{t('keymapper.baska_uygulamadan_kopyala')}</h3>
      </div>
      {sources.length === 0 ? (
        <p className="py-4 text-center text-[11px] text-muted-foreground">{t('keymapper.baska_uygulamada_duzen_yok')}</p>
      ) : (
        <ul className="dex-scroll max-h-64 space-y-1 overflow-y-auto">
          {sources.map(({ pkg, count }) => (
            <li key={pkg}>
              <button
                type="button"
                data-copy-from={pkg}
                onClick={() => onCopy(pkg)}
                className={cn('flex w-full items-center justify-between gap-2 rounded-xl border border-border/70 bg-background/60 px-3 py-2 text-left text-xs transition-colors hover:border-primary hover:bg-accent/50 cursor-pointer')}
              >
                <span className="truncate font-medium text-foreground">{pkg}</span>
                <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground">
                  <Check className="size-3" aria-hidden="true" />
                  {t('keymapper.count_dugum', { count })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button variant="outline" size="sm" className="mt-3 w-full" onClick={onClose}>{t('common.vazgec')}</Button>
    </Dialog>
  );
}
