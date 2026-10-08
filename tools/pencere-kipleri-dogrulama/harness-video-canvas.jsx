// Gerçek VideoCanvas'ın yerine geçen sahte tuval: gerçek akış (WebCodecs/WebSocket) olmadan pencere kabuğunu sınamak için.
// Gerçek bileşenin yaptığı gibi data-window-id taşır; ilk karenin gelişini (decoder.onFrameResolutionChanged) harness bildirir.
import React from 'react';

export default function VideoCanvas({ win }) {
  return (
    <div className="relative min-h-0 flex-1 bg-video-backdrop" data-testid="fake-video">
      <canvas data-window-id={win.id} className="absolute inset-0 size-full" width={win.deviceW || 480} height={win.deviceH || 780} />
    </div>
  );
}
