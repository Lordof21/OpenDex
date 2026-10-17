// Fareyle bakış / nişan (oyun düzeni): fare hareketi, bakış alanındaki TEK sanal parmağı kaydırır (keymapperEngine.moveLook), fare
// düğmeleri düzene bağlı dokunma noktalarına basar (sol tık = ateş gibi).
//
// Fare "hedefe doğru gider": imleç yakalanır (pointer lock) — görünmez, ekranın kenarına çarpmaz; hareketin yönü ve miktarı gider.
//   · Etkin olması için: Ayarlar'da açık + bu uygulamanın düzeninde en az bir düğüm + pencere girişe açık (odakta, donuk değil).
//   · Tuşa basılı tutulan **Ctrl** fareyi serbest bırakır: imleç geri gelir, tıklamalar normal dokunma olur (menüler, düğmeler);
//     Ctrl bırakılınca bakış kaldığı yerden sürer. Esc de yakalamayı bırakır (tarayıcı kuralı); yeniden yakalamak için tıklayın.
//   · Yakalama bir kullanıcı eylemi ister: ilk tıklama fareyi yakalar (dokunma göndermez).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeymapStore } from './keymapStore.js';
import { handleKeymapperMouseButton, handleKeymapperWheel, lookRegion, moveLook, releaseLook } from './keymapperEngine.js';

/**
 * @param {object} p
 * @param {{current: HTMLElement|null}} p.canvasRef    yakalanacak öğe (görüntü tuvali)
 * @param {string} p.targetId                          motor durumunun anahtarı (pencere ya da Workspace görevi)
 * @param {Array}  p.nodes                             bu uygulamanın tuş düzeni
 * @param {boolean} p.enabled                          Ayarlar'daki "fareyle bakış"
 * @param {boolean} p.active                           pencere girişe açık mı
 * @param {number} p.sensitivity                       duyarlılık çarpanı (1 = imleçle aynı hız)
 * @param {() => {x:number,y:number,w:number,h:number}} p.getFrame   düzenin yaslandığı kutu (soket uzayı)
 * @param {() => object|null} p.getTouch               dokunma soketi
 * @param {() => {sx:number, sy:number}} p.getScale    1 CSS px fare hareketi = kaç soket px'i
 */
export function useMouseLook({ canvasRef, targetId, nodes, enabled, active, sensitivity = 1, getFrame, getTouch, getScale }) {
  const [locked, setLocked] = useState(false);
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [refused, setRefused] = useState(false);
  // Herhangi bir tuş düzenleyicisi açıkken (hangi pencerede/görevde olursa olsun) fare YAKALANMAZ: düzenlerken yalnız normal tıklama vardır;
  // aksi hâlde başka pencerenin tuvali imleci tutup düzenleyicideki düğmelere ulaşılamazdı.
  const editorOpen = useKeymapStore((s) => s.editWindowId != null && s.livePlayWindowId !== s.editWindowId);   // "Oyna" açıkken düzenleyici yakalamayı engellemez
  // Yalnız BAKIŞ ALANI olan bir düzende: bakış alanı yoksa fareyi yakalamanın anlamı yok (menüler, düğmeler normal tıklama kalır).
  const hasLook = Array.isArray(nodes) && nodes.some((n) => n?.type === 'look' && n.enabled !== false);
  const live = enabled && active && !editorOpen && hasLook;

  const latest = useRef({});
  latest.current = { targetId, nodes, sensitivity, getFrame, getTouch, getScale };
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrlHeld;
  // The press that asks for the lock is not a game click: it (and its release) must not reach the layout's fire button.
  const lockingPress = useRef(false);

  useEffect(() => {
    if (!live) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const doc = canvas.ownerDocument;
    const view = doc.defaultView || window;
    const isLocked = () => doc.pointerLockElement === canvas;

    let pendingX = 0;
    let pendingY = 0;
    let raf = 0;
    const flush = () => {
      raf = 0;
      const dx = pendingX;
      const dy = pendingY;
      pendingX = 0;
      pendingY = 0;
      if (!dx && !dy) return;
      const L = latest.current;
      const frame = L.getFrame();
      const scale = L.getScale();
      if (!frame || !scale) return;
      const region = lookRegion(L.nodes, frame.w, frame.h, frame);
      // Düzenin bakış düğümü kendi X/Y duyarlılığını ve Y ters seçeneğini taşır (genel çarpanın ÜSTÜNE biner).
      const look = L.nodes.find((n) => n.type === 'look' && n.enabled !== false);
      const gainX = L.sensitivity * (look?.sensX ?? 1);
      const gainY = L.sensitivity * (look?.sensY ?? 1) * (look?.invertY ? -1 : 1);
      moveLook(L.targetId, L.getTouch(), region, dx * scale.sx * gainX, dy * scale.sy * gainY, frame, look?.id);
    };
    const dropPending = () => {
      pendingX = 0;
      pendingY = 0;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const liftLook = () => {
      dropPending();
      const { targetId: id, nodes: layout, getTouch: touch } = latest.current;
      releaseLook(id, touch(), layout.find((n) => n.type === 'look')?.id);
    };

    const onMouseMove = (e) => {
      if (!isLocked()) return;
      pendingX += e.movementX || 0;
      pendingY += e.movementY || 0;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    // Fare düğmeleri `pointer*` olaylarından dinlenir, `mouse*` olaylarından DEĞİL: tuval `pointerdown`'ı iptal eder (preventDefault) ve
    // tarayıcı iptal edilmiş bir basışın `mousedown`/`mouseup` uyumluluk olaylarını hiç üretmez — sol tık (ateş) hiç gelmezdi.
    const onMouseButton = (isDown) => (e) => {
      if (lockingPress.current) {
        if (!isDown) lockingPress.current = false;
        return;
      }
      if (!isLocked() || (e.pointerType && e.pointerType !== 'mouse')) return;
      const L = latest.current;
      const frame = L.getFrame();
      if (!frame) return;
      if (handleKeymapperMouseButton(e.button, isDown, L.targetId, L.nodes, L.getTouch(), frame.w, frame.h, frame)) e.preventDefault();
    };
    // Tekerlek: yakalıyken `WheelUp`/`WheelDown` tuşuna bağlı bir nokta varsa kısa bir basış olur (silah değiştir); yoksa normal kaydırma kalır.
    const onWheel = (e) => {
      if (!isLocked()) return;
      const L = latest.current;
      const frame = L.getFrame();
      if (frame && handleKeymapperWheel(e.deltaY, L.targetId, L.nodes, L.getTouch(), frame.w, frame.h, frame)) e.preventDefault();
    };
    // Geri/ileri fare düğmeleri tarayıcıda sayfa gezintisidir: yakalıyken oyun düğmesidir, sayfayı geri götürmemeli.
    const onSideButton = (e) => {
      if (isLocked() && e.button >= 3) e.preventDefault();
    };
    const onLockChange = () => {
      const now = isLocked();
      setLocked(now);
      if (now) setRefused(false);
      if (!now) liftLook(); // kilit düştü (Esc, Ctrl, odak kaybı): basılı bakış parmağı kalmasın
    };
    const onLockError = () => setRefused(true); // tarayıcı yakalamayı reddetti (kısa süre önce Esc, pencere odakta değil...)
    const onKeyDown = (e) => {
      if (e.key !== 'Control') return;
      setCtrlHeld(true);
      if (isLocked()) doc.exitPointerLock();
      liftLook();
    };
    const onKeyUp = (e) => {
      if (e.key !== 'Control') return;
      setCtrlHeld(false);
      // Betikle bırakılmış kilit çoğu zaman jest istemeden geri alınır; olmazsa bir sonraki tıklama yakalar.
      try {
        const result = canvas.requestPointerLock?.();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* jest yok: tıklama bekler */ }
    };
    const onBlur = () => {
      setCtrlHeld(false);
      if (isLocked()) doc.exitPointerLock();
      liftLook();
    };

    const onDown = onMouseButton(true);
    const onUp = onMouseButton(false);
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('pointerdown', onDown);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('wheel', onWheel, { passive: false });
    doc.addEventListener('mouseup', onSideButton);
    doc.addEventListener('auxclick', onSideButton);
    doc.addEventListener('pointerlockchange', onLockChange);
    doc.addEventListener('pointerlockerror', onLockError);
    view.addEventListener('keydown', onKeyDown);
    view.addEventListener('keyup', onKeyUp);
    view.addEventListener('blur', onBlur);
    setLocked(isLocked());

    return () => {
      doc.removeEventListener('mousemove', onMouseMove);
      doc.removeEventListener('pointerdown', onDown);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('wheel', onWheel);
      doc.removeEventListener('mouseup', onSideButton);
      doc.removeEventListener('auxclick', onSideButton);
      doc.removeEventListener('pointerlockchange', onLockChange);
      doc.removeEventListener('pointerlockerror', onLockError);
      view.removeEventListener('keydown', onKeyDown);
      view.removeEventListener('keyup', onKeyUp);
      view.removeEventListener('blur', onBlur);
      if (isLocked()) doc.exitPointerLock();
      liftLook();
      setLocked(false);
      setRefused(false);
      setCtrlHeld(false);
    };
  }, [live, canvasRef, targetId]);

  /**
   * Tuvalde bir fare basışı: fareyi bu özellik yönetiyorsa true (çağıran dokunma GÖNDERMEZ), değilse false (normal dokunma).
   * Yakalı değilse bu basış fareyi yakalar (kullanıcı jesti). Ctrl basılıyken fare serbest: normal dokunma.
   */
  const claimPointer = useCallback((e) => {
    if (!live || ctrlRef.current || e?.ctrlKey) return false;
    const canvas = canvasRef.current;
    if (!canvas) return false;
    if (canvas.ownerDocument.pointerLockElement !== canvas) {
      lockingPress.current = true;
      try {
        const result = canvas.requestPointerLock?.();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch { /* yakalanamadı: normal dokunma değil, tıklama yutulur; bir sonraki deneme yakalar */ }
    }
    return true;
  }, [live, canvasRef]);

  const status = !live ? 'off' : ctrlHeld ? 'free' : locked ? 'locked' : refused ? 'refused' : 'idle';
  return { status, claimPointer };
}

export default useMouseLook;
