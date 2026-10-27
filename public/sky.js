// The night sky behind the page: a fixed canvas of stars gathered along a faint
// band of the Milky Way. Some stars twinkle and the odd meteor crosses, unless
// the system asks for reduced motion. Decorative only: it never reads the journal.

(() => {
  const TAU = Math.PI * 2;
  const BAND_ANGLE = -0.42;
  const FPS = 30;
  const TINTS = ["255,255,255", "255,255,255", "214,228,255", "255,238,220", "190,236,247"];

  const canvas = document.createElement("canvas");
  canvas.className = "sky";
  canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const ctx = canvas.getContext("2d");
  const backdrop = document.createElement("canvas");
  const still = matchMedia("(prefers-reduced-motion: reduce)");

  const rand = (a, b) => a + Math.random() * (b - a);
  // Roughly normal, from -1 to 1, so the band is densest along its middle.
  const bell = () => (Math.random() + Math.random() + Math.random()) / 1.5 - 1;

  // Positions are fractions of the window, so resizing stretches the same sky
  // instead of scattering a new one.
  function makeStars() {
    const count = Math.min(1200, Math.max(300, Math.round((screen.width * screen.height) / 2600)));
    const cos = Math.cos(BAND_ANGLE);
    const sin = Math.sin(BAND_ANGLE);
    const stars = [];
    while (stars.length < count) {
      let x = Math.random();
      let y = Math.random();
      if (Math.random() < 0.4) {
        const along = rand(-0.8, 0.8);
        const across = bell() * 0.12;
        x = 0.5 + along * cos - across * sin;
        y = 0.5 + along * sin + across * cos;
        if (x < 0 || x > 1 || y < 0 || y > 1) continue;
      }
      const bright = Math.random() < 0.025;
      stars.push({
        x,
        y,
        r: bright ? rand(1.1, 1.7) : rand(0.35, 0.95),
        alpha: bright ? rand(0.8, 1) : rand(0.25, 0.8),
        tint: TINTS[Math.floor(Math.random() * TINTS.length)],
        twinkle: Math.random() < 0.18 ? { speed: rand(0.5, 1.6), phase: rand(0, TAU) } : null,
      });
    }
    return stars;
  }

  const stars = makeStars();
  const twinklers = stars.filter((s) => s.twinkle);
  const clouds = Array.from({ length: 6 }, (_, i) => ({
    along: rand(-0.55, 0.55),
    across: bell() * 0.05,
    size: rand(0.12, 0.28),
    alpha: rand(0.02, 0.045),
    tint: i % 2 ? "150,130,220" : "108,196,220",
  }));

  let w = 0;
  let h = 0;
  let dpr = 1;

  function star(c, s, alpha) {
    const x = s.x * w;
    const y = s.y * h;
    c.globalAlpha = alpha;
    if (s.r > 1) {
      const glow = c.createRadialGradient(x, y, 0, x, y, s.r * 5);
      glow.addColorStop(0, `rgba(${s.tint},0.35)`);
      glow.addColorStop(1, `rgba(${s.tint},0)`);
      c.fillStyle = glow;
      c.fillRect(x - s.r * 5, y - s.r * 5, s.r * 10, s.r * 10);
    }
    c.fillStyle = `rgb(${s.tint})`;
    c.beginPath();
    c.arc(x, y, s.r, 0, TAU);
    c.fill();
  }

  // Everything that doesn't move, painted once per window size.
  function paintBackdrop() {
    backdrop.width = canvas.width;
    backdrop.height = canvas.height;
    const c = backdrop.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const night = c.createLinearGradient(0, 0, 0, h);
    night.addColorStop(0, "#08090d");
    night.addColorStop(0.6, "#0b0e15");
    night.addColorStop(1, "#0f1622");
    c.fillStyle = night;
    c.fillRect(0, 0, w, h);

    // The band and its clouds share the stars' 0..1 space.
    c.setTransform(w * dpr, 0, 0, h * dpr, 0, 0);
    c.translate(0.5, 0.5);
    c.rotate(BAND_ANGLE);
    const glow = (along, across, size, flat, alpha, tint) => {
      c.save();
      c.translate(along, across);
      c.scale(1, flat);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, size);
      g.addColorStop(0, `rgba(${tint},${alpha})`);
      g.addColorStop(1, `rgba(${tint},0)`);
      c.fillStyle = g;
      c.fillRect(-size, -size, size * 2, size * 2);
      c.restore();
    };
    glow(0, 0, 0.8, 0.16, 0.06, "108,196,220");
    for (const cl of clouds) glow(cl.along, cl.across, cl.size, 0.4, cl.alpha, cl.tint);

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const horizon = c.createRadialGradient(w / 2, h * 1.2, 0, w / 2, h * 1.2, Math.max(w, h) * 0.8);
    horizon.addColorStop(0, "rgba(46,84,120,0.28)");
    horizon.addColorStop(1, "rgba(46,84,120,0)");
    c.fillStyle = horizon;
    c.fillRect(0, 0, w, h);

    for (const s of stars) if (!s.twinkle) star(c, s, s.alpha);
  }

  let meteor = null;
  let nextMeteor = rand(4, 10);

  function drawMeteor(t) {
    if (!meteor) {
      if (t < nextMeteor) return;
      const angle = rand(0.3, 0.6);
      const dir = Math.random() < 0.5 ? 1 : -1;
      meteor = {
        x: rand(0.15, 0.85) * w,
        y: rand(0.05, 0.45) * h,
        dx: Math.cos(angle) * dir,
        dy: Math.sin(angle),
        speed: rand(700, 1100),
        length: rand(90, 160),
        born: t,
        life: rand(0.5, 0.9),
      };
    }
    const age = (t - meteor.born) / meteor.life;
    if (age >= 1) {
      meteor = null;
      nextMeteor = t + rand(12, 30);
      return;
    }
    const travelled = (t - meteor.born) * meteor.speed;
    const hx = meteor.x + meteor.dx * travelled;
    const hy = meteor.y + meteor.dy * travelled;
    const tail = Math.min(meteor.length, travelled);
    const trail = ctx.createLinearGradient(hx, hy, hx - meteor.dx * tail, hy - meteor.dy * tail);
    trail.addColorStop(0, "rgba(255,255,255,0.9)");
    trail.addColorStop(1, "rgba(255,255,255,0)");
    // Fades in, then out.
    ctx.globalAlpha = Math.sin(age * Math.PI);
    ctx.strokeStyle = trail;
    ctx.lineWidth = 1.2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - meteor.dx * tail, hy - meteor.dy * tail);
    ctx.stroke();
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(backdrop, 0, 0, w, h);
    for (const s of twinklers) star(ctx, s, s.alpha * (0.6 + 0.4 * Math.sin(t * s.twinkle.speed + s.twinkle.phase)));
    if (!still.matches) drawMeteor(t);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    paintBackdrop();
    draw(performance.now() / 1000);
  }

  let frame = 0;
  let last = 0;
  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (now - last < 1000 / FPS) return;
    last = now;
    draw(now / 1000);
  }

  function start() {
    cancelAnimationFrame(frame);
    if (still.matches) draw(0);
    else frame = requestAnimationFrame(tick);
  }

  let pending = 0;
  window.addEventListener("resize", () => {
    clearTimeout(pending);
    pending = setTimeout(resize, 120);
  });
  still.addEventListener("change", start);
  resize();
  start();
})();
