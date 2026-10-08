import { useEffect, useRef, useState } from 'react';
import { Check, Code } from 'lucide-react';
import { api } from '../lib/api.js';

/**
 * Zero-Apps ADB XML Element Inspector (Faz 3+ Deneysel Mod).
 * Renders transparent interactive DOM elements over the Video Canvas.
 * Automatically settles after 300ms debounce when motion stops.
 */
export default function DomOverlayTree({ enabled, windowId, deviceW, deviceH, frameW, frameH, fitMode = 'object-fill' }) {
  const [nodes, setNodes] = useState([]);
  const [settled, setSettled] = useState(true);
  const [copiedText, setCopiedText] = useState(null);
  const pressTimerRef = useRef(null);
  const isLongPressRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setNodes([]);
      return;
    }
    let timer = null;

    const fetchNodes = async () => {
      try {
        const res = await api.get(`/api/window/${windowId}/xml-elements`);
        if (res?.enabled && Array.isArray(res?.nodes)) {
          setNodes(res.nodes);
        } else {
          setNodes([]);
        }
      } catch (e) {
        setNodes([]);
      }
    };

    const triggerFetch = () => {
      setSettled(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSettled(true);
        fetchNodes();
      }, 300);
    };

    triggerFetch();
    window.addEventListener('wheel', triggerFetch, { passive: true });
    window.addEventListener('pointerup', triggerFetch);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('wheel', triggerFetch);
      window.removeEventListener('pointerup', triggerFetch);
    };
  }, [enabled, windowId]);

  const handlePointerDown = (e, text) => {
    isLongPressRef.current = false;
    const targetElement = e.currentTarget;
    const container = targetElement.closest('.relative');
    const canvas = container?.querySelector('canvas');

    if (canvas) {
      canvas.dispatchEvent(new PointerEvent('pointerdown', e.nativeEvent));
    }

    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);

    pressTimerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      if (text) {
        navigator.clipboard.writeText(text);
        setCopiedText(text);
        setTimeout(() => setCopiedText(null), 1800);
      }
      if (canvas) {
        canvas.dispatchEvent(new PointerEvent('pointerup', e.nativeEvent));
      }
    }, 350);
  };

  const handlePointerUp = (e) => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }

    if (!isLongPressRef.current) {
      const container = e.currentTarget.closest('.relative');
      const canvas = container?.querySelector('canvas');
      if (canvas) {
        canvas.dispatchEvent(new PointerEvent('pointerup', e.nativeEvent));
      }
    }
  };

  const handlePointerLeave = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  if (!nodes || nodes.length === 0 || !deviceW || !deviceH || !frameW || !frameH) {
    return null;
  }

  let scaleX = frameW / deviceW;
  let scaleY = frameH / deviceH;
  let offsetX = 0;
  let offsetY = 0;

  const modeStr = String(fitMode || '');
  if (modeStr.includes('contain') || modeStr.includes('cover')) {
    const isCover = modeStr.includes('cover');
    const containerAspect = frameW / frameH;
    const deviceAspect = deviceW / deviceH;
    let videoW, videoH;

    if (isCover) {
      if (containerAspect > deviceAspect) {
        videoW = frameW;
        videoH = videoW / deviceAspect;
        offsetX = 0;
        offsetY = (frameH - videoH) / 2;
      } else {
        videoH = frameH;
        videoW = videoH * deviceAspect;
        offsetX = (frameW - videoW) / 2;
        offsetY = 0;
      }
    } else {
      // contain (letterbox)
      if (containerAspect > deviceAspect) {
        videoH = frameH;
        videoW = videoH * deviceAspect;
        offsetX = (frameW - videoW) / 2;
        offsetY = 0;
      } else {
        videoW = frameW;
        videoH = videoW / deviceAspect;
        offsetX = 0;
        offsetY = (frameH - videoH) / 2;
      }
    }

    scaleX = videoW / deviceW;
    scaleY = videoH / deviceH;
  }

  return (
    <div
      className={`absolute inset-0 pointer-events-none transition-opacity duration-200 z-20 ${
        settled ? 'opacity-100' : 'opacity-0'
      }`}
    >
      {/* Toast Notification when user long presses to copy an element */}
      {copiedText && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-info/95 backdrop-blur-md px-3 py-1.5 text-xs font-semibold text-image-foreground shadow-lg border border-info/40 animate-bounce flex items-center gap-2">
          <Check className="h-3.5 w-3.5 text-image-foreground/85 shrink-0" />
          <span>Basılı Tutularak Kopyalandı:</span>
          <span className="font-mono text-image-foreground/85 max-w-[200px] truncate">"{copiedText}"</span>
        </div>
      )}

      {nodes.map((node, idx) => {
        const left = offsetX + node.x * scaleX;
        const top = offsetY + node.y * scaleY;
        const width = node.w * scaleX;
        const height = node.h * scaleY;
        const displayText = node.text || node.id || 'UI Element';

        return (
          <div
            key={`${node.id || 'node'}-${idx}`}
            title={`Basılı Tut & Kopyala: ${displayText}`}
            onPointerDown={(e) => handlePointerDown(e, displayText)}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
            style={{
              position: 'absolute',
              left: `${left}px`,
              top: `${top}px`,
              width: `${width}px`,
              height: `${height}px`,
            }}
            className="group pointer-events-auto cursor-pointer border border-transparent hover:border-info hover:bg-info/20 hover:shadow-[0_0_8px_var(--info)] rounded transition-all duration-150 text-transparent selection:bg-info/50 selection:text-image-foreground"
          >
            {/* Live Element Badge Label on Hover */}
            <div className="absolute -top-5 left-0 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-150 whitespace-nowrap z-30">
              <span className="inline-flex items-center gap-1 rounded bg-scrim border border-info/50 px-1.5 py-0.5 text-[10px] font-mono text-info shadow-md">
                <Code className="h-3 w-3 text-info shrink-0" />
                <span className="max-w-[150px] truncate">{displayText}</span>
              </span>
            </div>

            {/* Selectable text overlay */}
            <span className="select-text opacity-0 group-hover:opacity-100 text-xs font-mono">
              {node.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
