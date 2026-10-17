// Tuş düzeni kaplaması: pencerenin (ya da Workspace görevinin) üstünde durur.
//   · Oyun içi (isEditing=false): hafif rozetler (HUD) — basılan tuş yanar, tıklamayı engellemez.
//   · Düzenleme (isEditing=true): Atölye (editor/Workbench.jsx) — sürükle-bırak, denetçi, şablonlar, test modu.
//
// Kaplama kabın tamamına değil, VİDEONUN GERÇEKTEN ÇİZİLDİĞİ dikdörtgene oturur (`fit`: pencerenin görüntü ölçeği). Böylece harf kutulu
// ya da yakınlaştırılmış görüntüde bile çizilen nokta, motorun telefonda vurduğu pikselle aynıdır. Tasarım: OYUN_TUS_DUZENI_TASARIM_PLANI.md
import { useEffect, useMemo, useRef } from 'react';
import { layoutKey, useKeymapStore } from './keymapStore.js';
import { pushEscapeHandler } from '../lib/escapeStack.js';
import { cn } from '../lib/utils.js';
import NodeView from './editor/NodeView.jsx';
import Workbench from './editor/Workbench.jsx';
import { useKeymapActivity } from './editor/useKeymapActivity.js';
import { useVideoFrame } from './editor/useVideoFrame.js';

const EMPTY = Object.freeze([]);

export default function KeymapperOverlay({ win, isEditing, onCloseEdit, isHeaderOpen = false, fit }) {
  const containerRef = useRef(null);
  // Pencerenin KENDİ düzeni varsa (`win:<id>`) o, yoksa uygulamanın düzeni. Oyun içinde yalnız etkin düğümler çizilir.
  const keyId = useKeymapStore((s) => layoutKey(s, win.id, win.package));
  const nodes = useKeymapStore((s) => s.getActiveKeymap(keyId)) ?? EMPTY;
  const uiPrefs = useKeymapStore((s) => s.uiPrefs);
  const livePlay = useKeymapStore((s) => s.livePlayWindowId === win.id);
  const deviceKnown = Boolean(win.deviceW > 0 && win.deviceH > 0);
  const knownDevice = useMemo(() => ({ w: win.deviceW || 0, h: win.deviceH || 0 }), [win.deviceW, win.deviceH]);
  const frame = useVideoFrame(containerRef, knownDevice, fit);
  // Cihaz boyutu bilinmiyorsa (Workspace görevi: düzen görev kutusuna yaslanır) çerçevenin kendi boyutu kullanılır — boyutlar kısa kenarın
  // ORANIdır, oran aynı kalır; yalnız "cihaz pikseli" gösterimi anlamsız olur ve gizlenir.
  const device = useMemo(
    () => (deviceKnown ? knownDevice : { w: Math.round(frame.rect.width) || 1280, h: Math.round(frame.rect.height) || 720 }),
    [deviceKnown, knownDevice, frame.rect.width, frame.rect.height],
  );
  const activity = useKeymapActivity(win.id);
  const hud = useMemo(
    () => ({ scale: uiPrefs.hudScale, opacity: uiPrefs.hudOpacity, showLabels: uiPrefs.showLabels, showLook: uiPrefs.showLook }),
    [uiPrefs.hudScale, uiPrefs.hudOpacity, uiPrefs.showLabels, uiPrefs.showLook],
  );

  // Esc düzenleyiciden çıkar (her değişiklik yapıldıkça kaydedildiği için kaybedilecek bir şey yok). Esc yığını olayı yakalama aşamasında
  // tüketir: tam ekrandan çıkmaz, telefona gitmez, ve sonradan eklenen (açık diyalog, tuş dinleme, test modu) önce kapanır. Güncel
  // `onCloseEdit` ref ile okunur: işleyici düzenleme oturumu başına bir kez kaydolur, her çizimde değil (yoksa diyaloğun altına düşerdi).
  const closeRef = useRef(onCloseEdit);
  closeRef.current = onCloseEdit;
  useEffect(() => {
    if (!isEditing) return undefined;
    return pushEscapeHandler(() => closeRef.current?.());
  }, [isEditing]);

  return (
    <div
      ref={containerRef}
      data-keymap-overlay=""
      className={cn(
        'absolute inset-0 z-30 overflow-hidden',
        // "Oyna": kaplama tıklamayı geçirir (tuval fareyi / dokunmayı alır); yalnız düzenleyicinin kendi çubukları tıklanır kalır.
        isEditing ? (livePlay ? 'pointer-events-none [&_[data-workbench-chrome]]:pointer-events-auto' : 'pointer-events-auto bg-scrim/40') : 'pointer-events-none',
      )}
    >
      {isEditing ? (
        <Workbench win={win} layoutKeyId={keyId} device={device} deviceKnown={deviceKnown} frame={frame} isHeaderOpen={isHeaderOpen} onClose={() => closeRef.current?.()} />
      ) : (
        <div style={{ position: 'absolute', ...frame.style }} data-keymap-frame="">
          {nodes.map((node) => (
            <NodeView
              key={node.id}
              node={node}
              frame={{ w: frame.rect.width, h: frame.rect.height }}
              device={device}
              mode="play"
              active={activity}
              hud={hud}
            />
          ))}
        </div>
      )}
    </div>
  );
}
