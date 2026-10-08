// Runs INSIDE the page (injected before the app, see media.js). Paints the contents of the sample "phone app" windows.
//
// These are illustrations, not captures: fictional apps ("Clips", "Notes", "Chat", …) drawn with plain shapes and system fonts,
// so a screenshot of OpenDeX never carries a real app's interface, logo or someone's content.

(() => {
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  const rr = (ctx, x, y, w, h, r, fill, stroke) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  };
  const text = (ctx, s, x, y, size, color, weight = 400, align = 'left') => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, x, y);
  };
  const gradient = (ctx, x0, y0, x1, y1, stops) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    return g;
  };
  const bar = (ctx, x, y, w, h, color) => rr(ctx, x, y, w, h, h / 2, color);

  const PALETTE = [
    ['#4f8cff', '#7a5cff'], ['#ff7a59', '#ffb347'], ['#16c7a4', '#2b8cff'], ['#e8508f', '#ff8a5c'],
    ['#6a7bff', '#34d0e5'], ['#f5b82e', '#ef5d5d'],
  ];

  // ------------------------------------------------------------------------------------------------------ Clips (video)
  function clips(ctx, w, h) {
    ctx.fillStyle = '#0f1013'; ctx.fillRect(0, 0, w, h);
    const s = Math.min(w, h * 1.5) / 1000;                       // one scale for everything: the scene looks the same at any size
    const pad = 28 * s;
    // top bar
    rr(ctx, pad, 22 * s, 120 * s, 30 * s, 8 * s, '#1c1e24');
    text(ctx, 'Clips', pad + 16 * s, 44 * s, 20 * s, '#f2f3f5', 700);
    rr(ctx, w * 0.3, 20 * s, w * 0.4, 36 * s, 18 * s, '#1c1e24');
    text(ctx, 'Search', w * 0.3 + 18 * s, 44 * s, 16 * s, '#80858f');
    ctx.beginPath(); ctx.arc(w - pad - 18 * s, 38 * s, 18 * s, 0, 7); ctx.fillStyle = '#7a5cff'; ctx.fill();
    // player
    const px = pad, py = 76 * s, pw = w * 0.64, ph = pw * 9 / 16;
    rr(ctx, px, py, pw, ph, 14 * s, gradient(ctx, px, py, px + pw, py + ph, [[0, '#103a5c'], [0.55, '#5b3ea8'], [1, '#e0577d']]));
    // aurora ribbons
    ctx.save(); ctx.beginPath(); ctx.roundRect(px, py, pw, ph, 14 * s); ctx.clip();
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(px, py + ph * (0.3 + i * 0.12));
      ctx.bezierCurveTo(px + pw * 0.3, py + ph * (0.05 + i * 0.1), px + pw * 0.6, py + ph * (0.7 - i * 0.05), px + pw, py + ph * (0.25 + i * 0.1));
      ctx.lineWidth = 26 * s; ctx.strokeStyle = `rgba(120, 255, 220, ${0.10 - i * 0.018})`; ctx.stroke();
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(px + pw / 2, py + ph / 2, 38 * s, 0, 7); ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(px + pw / 2 - 12 * s, py + ph / 2 - 18 * s); ctx.lineTo(px + pw / 2 + 20 * s, py + ph / 2); ctx.lineTo(px + pw / 2 - 12 * s, py + ph / 2 + 18 * s); ctx.fillStyle = '#fff'; ctx.fill();
    bar(ctx, px + 16 * s, py + ph - 22 * s, pw - 32 * s, 5 * s, 'rgba(255,255,255,.3)');
    bar(ctx, px + 16 * s, py + ph - 22 * s, (pw - 32 * s) * 0.38, 5 * s, '#ff4d6d');
    // title block
    text(ctx, 'Northern lights, a month in 4 minutes', px, py + ph + 40 * s, 24 * s, '#f2f3f5', 700);
    text(ctx, 'Sample channel  ·  1.2M views  ·  3 days ago', px, py + ph + 68 * s, 15 * s, '#9aa0ab');
    bar(ctx, px, py + ph + 92 * s, pw * 0.86, 9 * s, '#23262d'); bar(ctx, px, py + ph + 112 * s, pw * 0.62, 9 * s, '#23262d');
    // suggestions
    const sx = px + pw + 26 * s, sw = w - sx - pad;
    for (let i = 0; i < 5; i++) {
      const y = py + i * 98 * s, c = PALETTE[i % PALETTE.length];
      rr(ctx, sx, y, 150 * s, 84 * s, 10 * s, gradient(ctx, sx, y, sx + 150 * s, y + 84 * s, [[0, c[0]], [1, c[1]]]));
      bar(ctx, sx + 164 * s, y + 8 * s, sw - 164 * s, 11 * s, '#e6e8ec'); bar(ctx, sx + 164 * s, y + 30 * s, (sw - 164 * s) * 0.7, 9 * s, '#2b2e36');
      bar(ctx, sx + 164 * s, y + 50 * s, (sw - 164 * s) * 0.45, 9 * s, '#2b2e36');
    }
  }

  // ------------------------------------------------------------------------------------------------------ Notes
  function notes(ctx, w, h) {
    ctx.fillStyle = '#f6f4ef'; ctx.fillRect(0, 0, w, h);
    const s = w / 460;
    text(ctx, 'Notes', 28 * s, 74 * s, 34 * s, '#22201c', 800);
    rr(ctx, 28 * s, 96 * s, w - 56 * s, 42 * s, 21 * s, '#ebe7df');
    text(ctx, 'Search notes', 52 * s, 123 * s, 16 * s, '#8c867a');
    const colors = ['#ffe9a8', '#cfeede', '#d9e3ff', '#ffd6d6', '#e8dcff', '#ffe0c2'];
    const titles = ['Trip plan', 'Groceries', 'Meeting notes', 'Ideas', 'Reading list', 'Budget'];
    const colw = (w - 28 * s * 2 - 14 * s) / 2;
    let heights = [0, 0];
    titles.forEach((title, i) => {
      const col = i % 2, hh = (118 + (i * 37) % 70) * s;
      const x = 28 * s + col * (colw + 14 * s), y = 160 * s + heights[col];
      rr(ctx, x, y, colw, hh, 16 * s, colors[i]);
      text(ctx, title, x + 16 * s, y + 32 * s, 18 * s, '#2a2722', 700);
      for (let k = 0; k < 3 + (i % 2); k++) bar(ctx, x + 16 * s, y + (52 + k * 20) * s, colw * (0.78 - k * 0.12), 8 * s, 'rgba(0,0,0,.14)');
      heights[col] += hh + 14 * s;
    });
    ctx.beginPath(); ctx.arc(w - 56 * s, h - 64 * s, 30 * s, 0, 7); ctx.fillStyle = '#22201c'; ctx.fill();
    text(ctx, '+', w - 56 * s, h - 54 * s, 36 * s, '#f6f4ef', 400, 'center');
  }

  // ------------------------------------------------------------------------------------------------------ Chat
  function chat(ctx, w, h) {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    const s = w / 420;
    ctx.fillStyle = '#1f6f5c'; ctx.fillRect(0, 0, w, 78 * s);
    ctx.beginPath(); ctx.arc(46 * s, 42 * s, 20 * s, 0, 7); ctx.fillStyle = '#9fe0cf'; ctx.fill();
    text(ctx, 'Sample group', 78 * s, 38 * s, 19 * s, '#ffffff', 700);
    text(ctx, '4 members', 78 * s, 60 * s, 13 * s, 'rgba(255,255,255,.75)');
    ctx.fillStyle = '#ece5dd'; ctx.fillRect(0, 78 * s, w, h - 78 * s - 62 * s);
    const msgs = [['in', 'Are we still on for Friday?', 190], ['out', 'Yes! I booked the table for 7.', 210], ['in', 'Perfect. I will bring the photos.', 220],
      ['out', 'Great, see you there', 150], ['in', 'Running 5 minutes late', 170], ['out', 'No problem', 100]];
    let y = 100 * s;
    msgs.forEach(([dir, msg, mw]) => {
      const bw = mw * s, bh = 40 * s, x = dir === 'in' ? 16 * s : w - bw - 16 * s;
      rr(ctx, x, y, bw, bh, 12 * s, dir === 'in' ? '#ffffff' : '#d9fdd3');
      text(ctx, msg, x + 12 * s, y + 26 * s, 14 * s, '#1b1b1b');
      y += bh + 12 * s;
    });
    rr(ctx, 14 * s, h - 52 * s, w - 84 * s, 40 * s, 20 * s, '#ffffff', '#d8d8d8');
    text(ctx, 'Message', 32 * s, h - 26 * s, 15 * s, '#9a9a9a');
    ctx.beginPath(); ctx.arc(w - 34 * s, h - 32 * s, 22 * s, 0, 7); ctx.fillStyle = '#1f6f5c'; ctx.fill();
  }

  // ------------------------------------------------------------------------------------------------------ Maps
  function maps(ctx, w, h) {
    ctx.fillStyle = '#e9efe3'; ctx.fillRect(0, 0, w, h);
    const s = Math.min(w, h * 0.6) / 420;
    ctx.fillStyle = '#c9e2f3';
    ctx.beginPath(); ctx.moveTo(0, h * 0.62); ctx.bezierCurveTo(w * 0.3, h * 0.5, w * 0.6, h * 0.8, w, h * 0.55); ctx.lineTo(w, h * 0.7); ctx.bezierCurveTo(w * 0.6, h * 0.92, w * 0.3, h * 0.62, 0, h * 0.78); ctx.fill();
    ctx.fillStyle = '#d3e7c7'; rr(ctx, w * 0.08, h * 0.12, w * 0.3, h * 0.2, 18 * s, '#d3e7c7');
    ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round';
    [[0.0, 0.3, 1.0, 0.25, 14], [0.2, 0.0, 0.28, 1.0, 12], [0.0, 0.1, 1.0, 0.9, 10], [0.62, 0.0, 0.7, 1.0, 12], [0.0, 0.45, 1.0, 0.42, 8]].forEach(([x0, y0, x1, y1, lw]) => {
      ctx.lineWidth = lw * s; ctx.beginPath(); ctx.moveTo(w * x0, h * y0); ctx.lineTo(w * x1, h * y1); ctx.stroke();
    });
    ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 7 * s; ctx.beginPath(); ctx.moveTo(w * 0.2, h * 0.3); ctx.quadraticCurveTo(w * 0.45, h * 0.4, w * 0.66, h * 0.2); ctx.stroke();
    ctx.beginPath(); ctx.arc(w * 0.66, h * 0.2, 11 * s, 0, 7); ctx.fillStyle = '#e8453c'; ctx.fill();
    ctx.beginPath(); ctx.arc(w * 0.2, h * 0.3, 9 * s, 0, 7); ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.lineWidth = 4 * s; ctx.strokeStyle = '#4f8cff'; ctx.stroke();
    rr(ctx, 18 * s, 18 * s, w - 36 * s, 46 * s, 23 * s, '#ffffff');
    text(ctx, 'Search here', 44 * s, 48 * s, 17 * s, '#7b8089');
    rr(ctx, 0, h - 150 * s, w, 150 * s, 22 * s, '#ffffff');
    bar(ctx, w / 2 - 22 * s, h - 140 * s, 44 * s, 5 * s, '#d4d7dd');
    text(ctx, 'Sample Park', 24 * s, h - 96 * s, 22 * s, '#1b1d21', 700);
    text(ctx, '12 min  ·  3.4 km', 24 * s, h - 68 * s, 15 * s, '#4f8cff', 600);
    bar(ctx, 24 * s, h - 40 * s, w * 0.6, 9 * s, '#e6e8ec');
  }

  // ------------------------------------------------------------------------------------------------------ Photos
  function photos(ctx, w, h) {
    ctx.fillStyle = '#101114'; ctx.fillRect(0, 0, w, h);
    const s = w / 420, cols = w > h ? 5 : 3, gap = 4 * s, cell = (w - gap * (cols + 1)) / cols;
    text(ctx, 'Photos', 20 * s, 54 * s, 28 * s, '#f2f3f5', 800);
    for (let i = 0; i < cols * 8; i++) {
      const c = PALETTE[(i * 5) % PALETTE.length], x = gap + (i % cols) * (cell + gap), y = 78 * s + Math.floor(i / cols) * (cell + gap);
      if (y > h) break;
      rr(ctx, x, y, cell, cell, 4 * s, gradient(ctx, x, y, x + cell, y + cell, [[0, c[0]], [1, c[1]]]));
    }
  }

  // The Workspace's shared virtual display (1920×1080): a quiet background with two freeform tasks at the bounds gen_fixtures.py lists.
  function workspace(ctx, w, h) {
    ctx.fillStyle = gradient(ctx, 0, 0, w, h, [[0, '#17182b'], [1, '#241a33']]); ctx.fillRect(0, 0, w, h);
    const sx = w / 1920, sy = h / 1080;
    [['clips', 80, 90, 1180, 730], ['notes', 1250, 90, 1710, 850]].forEach(([name, l, t, r, b]) => {
      const x = l * sx, y = t * sy, rw = (r - l) * sx, rh = (b - t) * sy;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 36 * sx; ctx.shadowOffsetY = 12 * sx;
      rr(ctx, x, y, rw, rh, 14 * sx, '#000'); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, rw, rh, 14 * sx); ctx.clip();
      ctx.drawImage(window.__openDexScene(name, Math.round(rw), Math.round(rh)), x, y, rw, rh); ctx.restore();
    });
  }

  const SCENES = { clips, notes, chat, maps, photos, workspace };
  const cache = new Map();

  /** An OffscreenCanvas with the named scene at w×h (cached: every frame of a still stream is the same picture). */
  window.__openDexScene = (name, w, h) => {
    const key = `${name}:${w}:${h}`;
    if (!cache.has(key)) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      (SCENES[name] || photos)(ctx, w, h);
      cache.set(key, canvas);
    }
    return cache.get(key);
  };
})();
