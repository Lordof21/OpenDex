// Denetçi: seçili düğümün TÜM alanları (tuş, ad, boyut, konum, mod …); seçim yokken düzen özeti (duyarlılık, HUD, yapışma, çakışmalar).
import React, { useEffect, useState } from 'react';
import { Copy, Crosshair, MousePointer2, Move, ScanEye, Trash2, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { t } from '../../i18n/index.js';
import { PrecisionSlider } from '../../ui/PrecisionSlider.jsx';
import { SegmentedControl } from '../../ui/SegmentedControl.jsx';
import { Switch } from '../../ui/Switch.jsx';
import {
  DPAD_SCHEMES,
  LIMITS,
  hitPoint,
  roundPosition,
} from '../model.js';
import { HUD_OPACITY_RANGE, HUD_SCALE_RANGE, MOUSE_SENSITIVITY_RANGE } from '../keymapStore.js';
import { keyCapLabel } from '../keycaps.js';
import KeyCapture from './KeyCapture.jsx';
import { tip } from './tip.js';

const TYPE_META = {
  tap: { icon: Crosshair, title: () => t('keymapper.tus') },
  dpad: { icon: Move, title: () => t('keymapper.joystick') },
  look: { icon: ScanEye, title: () => t('keymapper.bakis') },
};

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">{label}</span>
        {hint && <span className="font-mono text-[10px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function SwitchRow({ label, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] font-medium text-foreground">{label}</span>
      <Switch checked={checked} onChange={() => onChange(!checked)} label={label} size="sm" />
    </div>
  );
}

/** Yüzde girişi (0–100): yazarken serbest, Enter/odak kaybında uygulanır; dışarıdan değişirse (sürükleme, ok tuşu) güncellenir. */
function PercentField({ label, value, onCommit }) {
  const shown = (value * 100).toFixed(1);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const parsed = parseFloat(String(text).replace(',', '.'));
    if (!Number.isFinite(parsed)) {
      setText(shown);
      return;
    }
    onCommit(roundPosition(parsed / 100));
  };
  return (
    <label className="flex flex-1 items-center gap-1.5 rounded-xl border border-border/70 bg-muted/60 px-2 py-1.5 focus-within:border-primary">
      <span className="text-[10px] font-semibold text-muted-foreground">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          }
        }}
        className="w-full min-w-0 bg-transparent text-right font-mono text-[11px] text-foreground outline-none"
      />
      <span className="text-[10px] text-muted-foreground">%</span>
    </label>
  );
}

/** Oran alanını (kısa kenara göre) piksel olarak ayarlayan kaydırıcı: kullanıcı "146 px" görür, motor oranı saklar. */
function PixelSlider({ field, node, limits, short, label, actions }) {
  const px = Math.round((node[field] ?? limits.def) * short);
  const min = Math.max(1, Math.round(limits.min * short));
  const max = Math.round(limits.max * short);
  return (
    <PrecisionSlider
      value={Math.min(max, Math.max(min, px))}
      min={min}
      max={max}
      step={1}
      unit="px"
      label={label}
      onChange={(v) => actions.update({ [field]: Math.round((v / short) * 10000) / 10000 }, `size:${node.id}`)}
    />
  );
}

export function NodeInspector({ node, device, deviceKnown = true, actions, conflicts, autoCapture = false, onAutoCaptured }) {
  const meta = TYPE_META[node.type];
  const Icon = meta.icon;
  const short = Math.min(device.w, device.h) || 720;
  const point = hitPoint(node, device.w, device.h);
  const conflicting = conflicts?.get(node.id) || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-lg bg-primary/15 text-primary"><Icon className="size-4" aria-hidden="true" /></span>
        <h3 className="flex-1 text-xs font-bold text-foreground">{meta.title()}</h3>
        {node.type === 'tap' && (
          <button type="button" onClick={actions.duplicate} {...tip(t('keymapper.cogalt_ctrl_d'), 'bottom', 'end')} aria-label={t('keymapper.cogalt_ctrl_d')} className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer">
            <Copy className="size-3.5" aria-hidden="true" />
          </button>
        )}
        <button type="button" onClick={actions.remove} {...tip(t('keymapper.sil_del'), 'bottom', 'end')} aria-label={t('keymapper.sil_del')} className="grid size-7 place-items-center rounded-lg text-destructive transition-colors hover:bg-destructive/15 cursor-pointer">
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-1">
        <SwitchRow label={t('keymapper.etkin')} checked={node.enabled !== false} onChange={(enabled) => actions.update({ enabled })} />
        {node.enabled === false && <p className="text-[10.5px] leading-snug text-muted-foreground">{t('keymapper.devre_disi_dugum_aciklama')}</p>}
      </div>

      {conflicting.length > 0 && (
        <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warning/50 bg-warning/15 px-2 py-1.5 text-[10.5px] leading-snug text-foreground">
          <TriangleAlert className="mt-px size-3 shrink-0 text-warning" aria-hidden="true" />
          {t('keymapper.ayni_tus_baska_dugumde_de')}
        </p>
      )}

      {node.type === 'tap' && (
        <Section title={t('keymapper.tus')}>
          <KeyCapture value={node.key} onChange={(key) => actions.update({ key })} label={t('keymapper.tus_ata')} autoStart={autoCapture} onAutoStarted={onAutoCaptured} />
          <Row label={t('keymapper.davranis')}>
            <SegmentedControl
              label={t('keymapper.davranis')}
              value={node.mode}
              onChange={(mode) => actions.update({ mode })}
              options={[
                { value: 'hold', label: t('keymapper.basili_tut'), title: t('keymapper.basili_tut_aciklama') },
                { value: 'toggle', label: t('keymapper.bas_ac_bas_kapa'), title: t('keymapper.bas_ac_bas_kapa_aciklama') },
              ]}
            />
            <p data-testid="mode-help" className="text-[10.5px] leading-snug text-muted-foreground">
              {node.mode === 'toggle' ? t('keymapper.bas_ac_bas_kapa_aciklama') : t('keymapper.basili_tut_aciklama')}
            </p>
          </Row>
          <Row label={t('keymapper.etiket')}>
            <input
              type="text"
              value={node.label}
              maxLength={24}
              placeholder={t('keymapper.ornek_ates')}
              aria-label={t('keymapper.etiket')}
              onChange={(e) => actions.update({ label: e.target.value }, `label:${node.id}`)}
              className="h-9 w-full rounded-xl border border-border/70 bg-muted/60 px-2.5 text-[11px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary"
            />
          </Row>
          <Row label={t('keymapper.halka_boyutu')} hint={t('keymapper.yalniz_gorunum')}>
            <PixelSlider field="size" node={node} limits={LIMITS.tapSize} short={short} label={t('keymapper.halka_boyutu')} actions={actions} />
          </Row>
        </Section>
      )}

      {node.type === 'dpad' && (
        <Section title={t('keymapper.joystick')}>
          <Row label={t('keymapper.tus_sablonu')}>
            <SegmentedControl
              label={t('keymapper.tus_sablonu')}
              value={node.scheme}
              onChange={(scheme) => actions.update({ scheme })}
              options={Object.keys(DPAD_SCHEMES).map((scheme) => ({
                value: scheme,
                label: scheme === 'arrows' ? '↑←↓→' : scheme.toUpperCase(),
              }))}
            />
          </Row>
          <Row label={t('keymapper.menzil')} hint={t('keymapper.gercek_menzil')}>
            <PixelSlider field="radius" node={node} limits={LIMITS.dpadRadius} short={short} label={t('keymapper.menzil')} actions={actions} />
          </Row>
          <Row label={t('keymapper.yuru_tusu')} hint={t('keymapper.itmeyi_kisar')}>
            <KeyCapture
              value={node.walkKey}
              clearable
              allowPointer={false}
              onChange={(walkKey) => actions.update({ walkKey })}
              label={t('keymapper.yuru_tusu')}
            />
          </Row>
          {node.walkKey && (
            <Row label={t('keymapper.yuruyus_orani')} hint={`${Math.round(node.walkScale * 100)}%`}>
              <PrecisionSlider
                value={Math.round(node.walkScale * 100)}
                min={Math.round(LIMITS.walkScale.min * 100)}
                max={Math.round(LIMITS.walkScale.max * 100)}
                step={5}
                unit="%"
                label={t('keymapper.yuruyus_orani')}
                onChange={(v) => actions.update({ walkScale: v / 100 }, `walk:${node.id}`)}
              />
            </Row>
          )}
        </Section>
      )}

      {node.type === 'look' && (
        <Section title={t('keymapper.bakis')}>
          <Row label={t('keymapper.alan_boyutu')} hint={t('keymapper.gercek_alan')}>
            <PixelSlider field="radius" node={node} limits={LIMITS.lookRadius} short={short} label={t('keymapper.alan_boyutu')} actions={actions} />
          </Row>
          <Row label={t('keymapper.yatay_duyarlilik')} hint={`${node.sensX.toFixed(1)}×`}>
            <PrecisionSlider value={node.sensX} min={LIMITS.sens.min} max={LIMITS.sens.max} step={0.1} unit="×" label={t('keymapper.yatay_duyarlilik')} onChange={(v) => actions.update({ sensX: Math.round(v * 10) / 10 }, `sx:${node.id}`)} />
          </Row>
          <Row label={t('keymapper.dikey_duyarlilik')} hint={`${node.sensY.toFixed(1)}×`}>
            <PrecisionSlider value={node.sensY} min={LIMITS.sens.min} max={LIMITS.sens.max} step={0.1} unit="×" label={t('keymapper.dikey_duyarlilik')} onChange={(v) => actions.update({ sensY: Math.round(v * 10) / 10 }, `sy:${node.id}`)} />
          </Row>
          <SwitchRow label={t('keymapper.dikey_ekseni_ters_cevir')} checked={node.invertY} onChange={(invertY) => actions.update({ invertY })} />
        </Section>
      )}

      <Section title={t('keymapper.konum')}>
        <div className="flex gap-1.5">
          <PercentField label="X" value={node.rx} onCommit={(rx) => actions.update({ rx }, `pos:${node.id}`)} />
          <PercentField label="Y" value={node.ry} onCommit={(ry) => actions.update({ ry }, `pos:${node.id}`)} />
        </div>
        {deviceKnown && (
          <p className="font-mono text-[10px] text-muted-foreground" data-testid="hit-readout">
            {t('keymapper.vurus_noktasi')}: {point.x} × {point.y} px
            <span className="ml-1 opacity-70">({device.w}×{device.h})</span>
          </p>
        )}
        <p className="text-[10px] leading-snug text-muted-foreground">{t('keymapper.ok_tuslari_ince_ayar_shift_cok_ince')}</p>
      </Section>
    </div>
  );
}

export function LayoutInspector({ nodes, conflicts, prefs, setMousePrefs, uiPrefs, setUiPrefs, onSelect, layoutEnabled = true, setLayoutEnabled, ownLayout = false, onToggleOwn, onPromote }) {
  const conflictIds = [...conflicts.keys()];
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-bold text-foreground">{t('keymapper.duzen')}</h3>
        <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">
          {nodes.length === 0 ? t('keymapper.bos_duzen_ipucu') : t('keymapper.count_dugum_secmek_icin_tikla', { count: nodes.length })}
        </p>
      </div>

      {onToggleOwn && (
        <Section title={t('keymapper.kapsam')}>
          <SwitchRow label={t('keymapper.bu_pencereye_ozel_duzen')} checked={ownLayout} onChange={onToggleOwn} />
          <p className="text-[10.5px] leading-snug text-muted-foreground">{ownLayout ? t('keymapper.kapsam_pencere_aciklama') : t('keymapper.kapsam_uygulama_aciklama')}</p>
          {ownLayout && onPromote && (
            <button type="button" onClick={onPromote} className="h-8 w-full rounded-xl border border-border/70 bg-muted/60 text-[11px] font-semibold text-foreground transition-colors hover:border-primary hover:bg-accent cursor-pointer">
              {t('keymapper.uygulama_duzeni_olarak_kaydet')}
            </button>
          )}
        </Section>
      )}

      {setLayoutEnabled && (
        <Section title={t('keymapper.durum')}>
          <SwitchRow label={t('keymapper.duzen_etkin_bu_uygulama')} checked={layoutEnabled} onChange={setLayoutEnabled} />
          {!layoutEnabled && <p role="status" className="text-[10.5px] leading-snug text-muted-foreground">{t('keymapper.duzen_kapali_aciklama')}</p>}
        </Section>
      )}

      {conflictIds.length > 0 && (
        <Section title={t('keymapper.cakismalar')}>
          <ul className="space-y-1">
            {conflictIds.map((id) => {
              const node = nodes.find((n) => n.id === id);
              return node && (
                <li key={id}>
                  <button type="button" onClick={() => onSelect(id)} className="flex w-full items-center gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2 py-1 text-left text-[10.5px] text-foreground transition-colors hover:bg-warning/20 cursor-pointer">
                    <TriangleAlert className="size-3 shrink-0 text-warning" aria-hidden="true" />
                    <span className="truncate">{node.type === 'tap' ? keyCapLabel(node.key) : TYPE_META[node.type].title()}{node.label ? ` · ${node.label}` : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      <Section title={t('keymapper.fare_ile_nisan')}>
        <SwitchRow label={t('keymapper.fareyle_bakis')} checked={prefs.mouseLook} onChange={(mouseLook) => setMousePrefs({ mouseLook })} />
        {prefs.mouseLook && (
          <Row label={t('keymapper.genel_duyarlilik')} hint={`${prefs.mouseSensitivity.toFixed(1)}×`}>
            <PrecisionSlider
              value={prefs.mouseSensitivity}
              min={MOUSE_SENSITIVITY_RANGE.min}
              max={MOUSE_SENSITIVITY_RANGE.max}
              step={0.1}
              unit="×"
              label={t('keymapper.genel_duyarlilik')}
              onChange={(v) => setMousePrefs({ mouseSensitivity: Math.round(v * 10) / 10 })}
            />
          </Row>
        )}
        <p className="flex items-start gap-1.5 text-[10px] leading-snug text-muted-foreground">
          <MousePointer2 className="mt-px size-3 shrink-0" aria-hidden="true" />
          {t('keymapper.bakis_duyarliligi_ipucu')}
        </p>
      </Section>

      <Section title={t('keymapper.oyun_ici_gorunum')}>
        <Row label={t('keymapper.rozet_boyutu')} hint={`${uiPrefs.hudScale.toFixed(1)}×`}>
          <PrecisionSlider value={uiPrefs.hudScale} min={HUD_SCALE_RANGE.min} max={HUD_SCALE_RANGE.max} step={HUD_SCALE_RANGE.step} unit="×" label={t('keymapper.rozet_boyutu')} onChange={(v) => setUiPrefs({ hudScale: Math.round(v * 10) / 10 })} />
        </Row>
        <Row label={t('keymapper.seffaflik')} hint={`${Math.round(uiPrefs.hudOpacity * 100)}%`}>
          <PrecisionSlider value={Math.round(uiPrefs.hudOpacity * 100)} min={Math.round(HUD_OPACITY_RANGE.min * 100)} max={100} step={5} unit="%" label={t('keymapper.seffaflik')} onChange={(v) => setUiPrefs({ hudOpacity: v / 100 })} />
        </Row>
        <SwitchRow label={t('keymapper.etiketleri_goster')} checked={uiPrefs.showLabels} onChange={(showLabels) => setUiPrefs({ showLabels })} />
        <SwitchRow label={t('keymapper.bakis_alanini_goster')} checked={uiPrefs.showLook} onChange={(showLook) => setUiPrefs({ showLook })} />
      </Section>

      <Section title={t('keymapper.yerlesim')}>
        <SwitchRow label={t('keymapper.hizaya_yapis')} checked={uiPrefs.snap} onChange={(snap) => setUiPrefs({ snap })} />
        <SwitchRow label={t('keymapper.izgarayi_goster_ve_yapis')} checked={uiPrefs.grid} onChange={(grid) => setUiPrefs({ grid })} />
      </Section>
    </div>
  );
}
