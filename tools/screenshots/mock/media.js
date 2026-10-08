// Runs INSIDE the page, before the app (after scenes.js). Replaces WebCodecs' VideoDecoder with one that "decodes" the sample
// stream: the REAL pipeline above it (WebSocket → frame headers → videoDecoder.js → frame pacer → canvas → window frame) runs
// unchanged; only the last step — turning H.264 into pixels — paints a sample scene instead.
//
// The mock backend (backend.cjs) sends scrcpy-framed packets whose payload is the ASCII marker `SCENE:<name>:<w>:<h>` after a
// config / key-frame start code. Real Chromium builds for automation have no H.264 decoder at all, which is why this is needed.

(() => {
  class SampleVideoDecoder {
    static async isConfigSupported(config) {
      return { supported: true, config };
    }

    constructor({ output, error }) {
      this._output = output;
      this._error = error;
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
    }

    configure() {
      this.state = 'configured';
    }

    decode(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      const marker = /SCENE:([a-z]+):(\d+):(\d+)/.exec(new TextDecoder('latin1').decode(bytes));
      if (!marker) return;                                   // a packet without a picture (the config packet)
      const [, name, w, h] = marker;
      const frame = new VideoFrame(window.__openDexScene(name, Number(w), Number(h)), { timestamp: chunk.timestamp });
      this.decodeQueueSize += 1;
      setTimeout(() => {
        this.decodeQueueSize = Math.max(0, this.decodeQueueSize - 1);
        if (this.state !== 'closed') this._output(frame); else frame.close();
      }, 0);
    }

    flush() { return Promise.resolve(); }
    reset() { this.state = 'unconfigured'; }
    close() { this.state = 'closed'; }
  }

  window.VideoDecoder = SampleVideoDecoder;
})();
