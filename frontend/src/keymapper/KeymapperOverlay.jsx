import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Gamepad2,
  Plus,
  Trash2,
  RotateCcw,
  Check,
  X,
  Sliders,
  Crosshair,
  Move,
  Edit3,
} from 'lucide-react';
import { useKeymapStore } from './keymapStore.js';
import Button from '../ui/Button.jsx';
import { Dialog } from '../ui/Dialog.jsx';
import { pushEscapeHandler } from '../lib/escapeStack.js';

const AVAILABLE_KEYS = [
  'Space', 'c', 'f', 'r', 'e', 'q', 'v', 'b', 'g', 't', '1', '2', '3', '4', 'Shift', 'Control', 'Alt',
];

export default function KeymapperOverlay({ win, isEditing, onCloseEdit, isHeaderOpen = false }) {
  const {
    getKeymapForPackage,
    addNodeToPackage,
    updateNodeInPackage,
    removeNodeFromPackage,
    resetPackageToDefault,
    clearPackageKeymap,
    overlayOpacity,
    setOverlayOpacity,
  } = useKeymapStore();

  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [editingKeyNodeId, setEditingKeyNodeId] = useState(null);
  const containerRef = useRef(null);
  const activeDragRef = useRef(null);

  const nodes = getKeymapForPackage(win.package);

  // Esc leaves the editor (every change is saved as it is made, so there is nothing to lose). The escape stack consumes
  // the key in the capture phase: it neither leaves full screen nor reaches the phone, and an open key-picker dialog —
  // pushed later — closes first. The latest `onCloseEdit` is read through a ref so the handler is registered once per
  // editing session, not on every render (which would re-order it below the dialog's).
  const closeRef = useRef(onCloseEdit);
  closeRef.current = onCloseEdit;
  useEffect(() => {
    if (!isEditing) return undefined;
    return pushEscapeHandler(() => closeRef.current?.());
  }, [isEditing]);

  const handleAddTapKey = () => {
    addNodeToPackage(win.package, {
      type: 'tap',
      key: 'Space',
      label: 'Tıklama',
      rx: 0.5,
      ry: 0.5,
    });
  };

  const handleAddDpad = () => {
    addNodeToPackage(win.package, {
      type: 'dpad',
      key: 'WASD',
      label: 'Hareket (WASD)',
      rx: 0.25,
      ry: 0.7,
      radius: 0.12,
    });
  };

  const onNodePointerDown = (e, node) => {
    if (!isEditing || e.button !== 0) return;
    if (e.target.closest('button')) return;

    e.stopPropagation();
    e.preventDefault();

    const elem = e.currentTarget;
    try {
      elem.setPointerCapture(e.pointerId);
    } catch {}

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    let currentRx = node.rx;
    let currentRy = node.ry;
    let moveRaf = null;

    activeDragRef.current = {
      nodeId: node.id,
      pointerId: e.pointerId,
    };

    const onPointerMove = (ev) => {
      if (ev.pointerId !== e.pointerId) return;

      currentRx = Math.max(0.04, Math.min(0.96, (ev.clientX - rect.left) / rect.width));
      currentRy = Math.max(0.04, Math.min(0.96, (ev.clientY - rect.top) / rect.height));

      if (!moveRaf) {
        moveRaf = requestAnimationFrame(() => {
          moveRaf = null;
          elem.style.left = `${currentRx * 100}%`;
          elem.style.top = `${currentRy * 100}%`;
        });
      }
    };

    const onPointerUp = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      try {
        elem.releasePointerCapture(e.pointerId);
      } catch {}

      elem.removeEventListener('pointermove', onPointerMove);
      elem.removeEventListener('pointerup', onPointerUp);
      elem.removeEventListener('pointercancel', onPointerUp);

      activeDragRef.current = null;
      if (moveRaf) cancelAnimationFrame(moveRaf);

      updateNodeInPackage(win.package, node.id, {
        rx: currentRx,
        ry: currentRy,
      });
    };

    elem.addEventListener('pointermove', onPointerMove);
    elem.addEventListener('pointerup', onPointerUp);
    elem.addEventListener('pointercancel', onPointerUp);
  };

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 pointer-events-none z-30 overflow-hidden ${
        isEditing ? 'bg-scrim/40 pointer-events-auto' : ''
      }`}
    >
      {/* 1. TOP TOOLBAR IN EDIT MODE */}
      <AnimatePresence>
        {isEditing && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className={`absolute left-1/2 -translate-x-1/2 z-40 flex flex-wrap items-center justify-center gap-1.5 max-w-[96%] rounded-2xl border border-border/80 bg-popover/95 p-1.5 shadow-2xl backdrop-blur-2xl text-xs select-none transition-all duration-300 ${
              isHeaderOpen ? 'top-12' : 'top-2'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 px-1.5 text-xs font-bold text-primary">
              <Gamepad2 className="h-4 w-4 shrink-0" />
              <span className="hidden sm:inline">Tuş Düzenleyici</span>
            </div>

            <button
              type="button"
              onClick={handleAddTapKey}
              className="flex items-center gap-1 rounded-xl bg-primary/15 border border-primary/30 px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/25 cursor-pointer"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>+ Tuş</span>
            </button>

            <button
              type="button"
              onClick={handleAddDpad}
              className="flex items-center gap-1 rounded-xl bg-primary/15 border border-primary/30 px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/25 cursor-pointer"
            >
              <Move className="h-3.5 w-3.5" />
              <span>+ WASD</span>
            </button>

            <button
              type="button"
              onClick={() => resetPackageToDefault(win.package)}
              className="flex items-center gap-1 rounded-xl bg-muted border border-border/70 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
              title="Varsayılan yerleşime sıfırla"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Sıfırla</span>
            </button>

            <button
              type="button"
              onClick={() => clearPackageKeymap(win.package)}
              className="flex items-center gap-1 rounded-xl bg-destructive/15 border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/25 cursor-pointer"
              title="Tüm tuşları temizle"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Temizle</span>
            </button>

            {/* Opacity Slider */}
            <div className="flex items-center gap-1 px-1.5" title="Şeffaflık">
              <Sliders className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={overlayOpacity}
                onChange={(e) => setOverlayOpacity(parseFloat(e.target.value))}
                className="w-12 sm:w-16 accent-primary cursor-pointer"
              />
            </div>

            <button
              type="button"
              onClick={onCloseEdit}
              title="Düzenlemeyi kapat (Esc)"
              className="flex items-center gap-1 rounded-xl bg-primary border border-primary/50 px-2.5 py-1 text-xs font-bold text-primary-foreground shadow-sm hover:bg-primary/90 cursor-pointer"
            >
              <Check className="h-3.5 w-3.5" />
              <span>Kaydet</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 2. RENDER KEY NODES */}
      {nodes.map((node) => {
        const posX = `${node.rx * 100}%`;
        const posY = `${node.ry * 100}%`;

        if (node.type === 'dpad') {
          return (
            <div
              key={node.id}
              onPointerDown={(e) => onNodePointerDown(e, node)}
              style={{
                left: posX,
                top: posY,
                opacity: isEditing ? 1 : overlayOpacity,
                touchAction: 'none',
                userSelect: 'none',
              }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full border-2 transition-shadow ${
                isEditing
                  ? 'cursor-grab active:cursor-grabbing border-primary bg-primary/20 shadow-xl ring-2 ring-primary/40'
                  : 'border-scrim-foreground/30 bg-scrim/35 pointer-events-none'
              }`}
            >
              <div className="relative flex h-24 w-24 items-center justify-center pointer-events-none">
                <span className="absolute top-1 text-[11px] font-bold text-primary">W</span>
                <span className="absolute bottom-1 text-[11px] font-bold text-primary">S</span>
                <span className="absolute left-1 text-[11px] font-bold text-primary">A</span>
                <span className="absolute right-1 text-[11px] font-bold text-primary">D</span>
                <div className="h-6 w-6 rounded-full bg-primary/40 border border-border flex items-center justify-center text-[9px] font-bold text-primary-foreground">
                  JOY
                </div>
              </div>
              {isEditing && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeNodeFromPackage(win.package, node.id);
                  }}
                  className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-md hover:bg-destructive/90 cursor-pointer"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        }

        // Tap Key Node
        return (
          <div
            key={node.id}
            onPointerDown={(e) => onNodePointerDown(e, node)}
            style={{
              left: posX,
              top: posY,
              opacity: isEditing ? 1 : overlayOpacity,
              touchAction: 'none',
              userSelect: 'none',
            }}
            onClick={() => isEditing && setSelectedNodeId(node.id)}
            className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 rounded-xl px-2.5 py-1 border transition-shadow ${
              isEditing
                ? 'cursor-grab active:cursor-grabbing border-primary bg-popover/90 text-foreground shadow-lg ring-2 ring-primary/40'
                : 'border-scrim-foreground/20 bg-scrim/45 text-scrim-foreground pointer-events-none'
            }`}
          >
            <Crosshair className="h-3 w-3 text-primary shrink-0 pointer-events-none" />
            <span className="font-mono text-xs font-bold uppercase pointer-events-none">{node.key}</span>

            {isEditing && (
              <div className="flex items-center gap-1 ml-1 pl-1 border-l border-border/50">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingKeyNodeId(node.id);
                  }}
                  className="text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Tuş değiştir"
                >
                  <Edit3 className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeNodeFromPackage(win.package, node.id);
                  }}
                  className="text-destructive hover:text-destructive/80 cursor-pointer"
                  title="Sil"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* 3. KEY BINDING SELECTION MODAL */}
      <Dialog
        open={Boolean(editingKeyNodeId)}
        onClose={() => setEditingKeyNodeId(null)}
        label="Fiziksel Tuş Seçin"
        overlayClassName="pointer-events-auto"
        className="w-72 p-4"
      >
            <h4 className="mb-2 text-xs font-bold text-foreground">Fiziksel Tuş Seçin</h4>
            <p className="mb-3 text-[11px] text-muted-foreground">Bu dokunma noktasına atanacak klavye tuşu:</p>

            <div className="grid grid-cols-4 gap-1.5 mb-3">
              {AVAILABLE_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    updateNodeInPackage(win.package, editingKeyNodeId, { key: k });
                    setEditingKeyNodeId(null);
                  }}
                  className="rounded-lg border border-border/60 bg-muted/60 py-1.5 font-mono text-xs font-bold text-foreground hover:bg-primary/20 hover:border-primary cursor-pointer transition-colors"
                >
                  {k}
                </button>
              ))}
            </div>

            <Button variant="outline" size="sm" className="w-full" onClick={() => setEditingKeyNodeId(null)}>
              Vazgeç
            </Button>
      </Dialog>
    </div>
  );
}
