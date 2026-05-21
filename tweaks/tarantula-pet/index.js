const TWEAK_ID = "com.l1uyun.tarantula-pet";
const STYLE_ID = "codexpp-tarantula-pet-style";
const ROOT_ID = "codexpp-tarantula-pet";

const DEFAULT_CONFIG = {
  enabled: true,
  size: 132,
  homeToCursorScreen: true,
};

let cleanup = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(current, target, amount) {
  return current + (target - current) * amount;
}

function angleDelta(target, current) {
  return ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
}

function normalizeAngle(value) {
  return ((value % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function readConfig(api) {
  return {
    enabled: api.storage.get("enabled", DEFAULT_CONFIG.enabled),
    size: api.storage.get("size", DEFAULT_CONFIG.size),
    homeToCursorScreen: api.storage.get("homeToCursorScreen", DEFAULT_CONFIG.homeToCursorScreen),
  };
}

function injectStyle() {
  let style = document.getElementById(STYLE_ID);
  if (style) return style;
  style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      z-index: 2147483000;
      left: 0;
      top: 0;
      width: var(--tarantula-size, 132px);
      height: var(--tarantula-size, 132px);
      pointer-events: none;
      transform-origin: 50% 52%;
      contain: layout paint style;
      user-select: none;
    }
    #${ROOT_ID}.codexpp-tarantula-hidden {
      display: none;
    }
    #${ROOT_ID} .codexpp-tarantula-body {
      width: 100%;
      height: 100%;
      border-radius: 999px;
      background:
        radial-gradient(circle at 57% 48%, rgba(78, 50, 30, 0.96) 0 16%, transparent 17%),
        radial-gradient(circle at 40% 49%, rgba(38, 25, 16, 0.98) 0 20%, transparent 21%),
        radial-gradient(circle at 48% 48%, rgba(118, 82, 48, 0.74) 0 27%, transparent 28%),
        radial-gradient(circle at 50% 50%, rgba(24, 16, 10, 0.98) 0 33%, transparent 34%);
      filter: drop-shadow(0 9px 8px rgba(0, 0, 0, 0.23));
      position: relative;
      transform-origin: 50% 52%;
    }
    #${ROOT_ID} .codexpp-tarantula-body::before,
    #${ROOT_ID} .codexpp-tarantula-body::after {
      content: "";
      position: absolute;
      left: 49%;
      top: 51%;
      width: 92%;
      height: 92%;
      transform: translate(-50%, -50%);
      background:
        linear-gradient(18deg, transparent 0 42%, rgba(52, 32, 19, 0.98) 43% 49%, rgba(143, 93, 47, 0.55) 50% 53%, transparent 54%),
        linear-gradient(-18deg, transparent 0 42%, rgba(52, 32, 19, 0.98) 43% 49%, rgba(143, 93, 47, 0.55) 50% 53%, transparent 54%),
        linear-gradient(42deg, transparent 0 40%, rgba(45, 28, 17, 0.96) 41% 47%, rgba(130, 82, 42, 0.5) 48% 51%, transparent 52%),
        linear-gradient(-42deg, transparent 0 40%, rgba(45, 28, 17, 0.96) 41% 47%, rgba(130, 82, 42, 0.5) 48% 51%, transparent 52%);
      opacity: 0.95;
      z-index: -1;
    }
    #${ROOT_ID} .codexpp-tarantula-body::after {
      transform: translate(-50%, -50%) rotate(90deg);
      opacity: 0.82;
    }
  `;
  document.head.appendChild(style);
  return style;
}

function createPet() {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("aria-hidden", "true");

  const body = document.createElement("div");
  body.className = "codexpp-tarantula-body";
  root.appendChild(body);
  document.body.appendChild(root);
  return { root, body };
}

function viewportRect() {
  return {
    left: 8,
    top: 8,
    right: window.innerWidth - 8,
    bottom: window.innerHeight - 8,
  };
}

function chooseBehavior(state, now, config) {
  if (config.homeToCursorScreen && state.pointerActive && Math.hypot(state.pointerX - state.x, state.pointerY - state.y) > Math.max(window.innerWidth, window.innerHeight) * 0.42) {
    state.behavior = "home";
    state.behaviorUntil = now + 1600 + Math.random() * 1200;
    return;
  }

  const roll = Math.random();
  if (roll < 0.42) {
    state.behavior = "pause";
    state.behaviorUntil = now + 900 + Math.random() * 2200;
    state.targetSpeed = 0;
  } else if (roll < 0.64) {
    state.behavior = "probe";
    state.behaviorUntil = now + 500 + Math.random() * 1200;
    state.targetSpeed = 4 + Math.random() * 8;
    state.heading = normalizeAngle(state.heading + (Math.random() - 0.5) * 0.9);
  } else {
    state.behavior = "creep";
    state.behaviorUntil = now + 1100 + Math.random() * 2600;
    state.targetSpeed = 12 + Math.random() * 18;
    state.heading = normalizeAngle(state.heading + (Math.random() - 0.5) * 0.55);
  }
}

function updateMotion(state, now, dt, config) {
  const bounds = viewportRect();
  const half = state.size / 2;
  const minX = bounds.left + half;
  const minY = bounds.top + half;
  const maxX = bounds.right - half;
  const maxY = bounds.bottom - half;

  if (now >= state.behaviorUntil) chooseBehavior(state, now, config);

  if (state.behavior === "home" && state.pointerActive) {
    const dx = state.pointerX - state.x;
    const dy = state.pointerY - state.y;
    const desired = Math.atan2(dy, dx);
    state.heading = normalizeAngle(state.heading + angleDelta(desired, state.heading) * Math.min(1, dt * 1.8));
    state.targetSpeed = 20;
  }

  let wallTurnX = 0;
  let wallTurnY = 0;
  const margin = Math.max(70, state.size * 0.8);
  if (state.x < minX + margin) wallTurnX += (minX + margin - state.x) / margin;
  if (state.x > maxX - margin) wallTurnX -= (state.x - (maxX - margin)) / margin;
  if (state.y < minY + margin) wallTurnY += (minY + margin - state.y) / margin;
  if (state.y > maxY - margin) wallTurnY -= (state.y - (maxY - margin)) / margin;
  if (wallTurnX || wallTurnY) {
    const desired = Math.atan2(wallTurnY, wallTurnX);
    state.heading = normalizeAngle(state.heading + angleDelta(desired, state.heading) * Math.min(1, dt * 2.2));
  }

  if (state.pointerActive) {
    const dx = state.x - state.pointerX;
    const dy = state.y - state.pointerY;
    const distance = Math.hypot(dx, dy);
    if (distance < state.size * 1.25 && state.behavior !== "home") {
      const desired = Math.atan2(dy, dx);
      state.heading = normalizeAngle(state.heading + angleDelta(desired, state.heading) * Math.min(1, dt * 2.6));
      state.targetSpeed = Math.max(state.targetSpeed, 16);
      state.behavior = "creep";
      state.behaviorUntil = Math.max(state.behaviorUntil, now + 900);
    }
  }

  const jitter = Math.sin(now * 0.0017 + state.seed) * 0.18;
  state.heading = normalizeAngle(state.heading + jitter * dt * (state.behavior === "probe" ? 0.9 : 0.25));

  const speedScale = state.behavior === "pause" ? 0.04 : state.behavior === "probe" ? 0.26 : 1;
  const targetSpeed = state.targetSpeed * speedScale;
  state.speed = lerp(state.speed, targetSpeed, Math.min(1, dt * 2.1));
  state.vx = lerp(state.vx, Math.cos(state.heading) * state.speed, Math.min(1, dt * 2.5));
  state.vy = lerp(state.vy, Math.sin(state.heading) * state.speed * 0.72, Math.min(1, dt * 2.5));

  state.x = clamp(state.x + state.vx * dt, minX, maxX);
  state.y = clamp(state.y + state.vy * dt, minY, maxY);
  state.gait = (state.gait + dt * (state.behavior === "home" ? 0.82 : state.behavior === "creep" ? 0.48 : state.behavior === "probe" ? 0.12 : 0.04)) % 1;
}

function renderPet(root, body, state, config) {
  root.classList.toggle("codexpp-tarantula-hidden", !config.enabled);
  root.style.setProperty("--tarantula-size", `${state.size}px`);
  root.style.transform = `translate3d(${(state.x - state.size / 2).toFixed(2)}px, ${(state.y - state.size / 2).toFixed(2)}px, 0) rotate(${state.heading.toFixed(4)}rad)`;

  const wave = Math.sin(state.gait * Math.PI * 2);
  const posture = state.behavior === "pause" ? 0.02 : state.behavior === "probe" ? 0.08 : 0.22;
  const rotate = wave * posture;
  const scaleX = 1 + Math.abs(wave) * (state.behavior === "pause" ? 0.0005 : 0.002);
  const scaleY = 1 - Math.abs(wave) * (state.behavior === "pause" ? 0.0004 : 0.0015);
  body.style.transform = `rotate(${rotate.toFixed(3)}deg) scale(${scaleX.toFixed(4)}, ${scaleY.toFixed(4)})`;
  body.dataset.behavior = state.behavior;
}

function renderSettings(api, config, applyConfig) {
  return (root) => {
    root.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "flex flex-col gap-3";

    const title = document.createElement("div");
    title.className = "text-base font-medium text-token-text-primary";
    title.textContent = "Tarantula Pet";
    wrap.appendChild(title);

    const card = document.createElement("div");
    card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
    card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";

    const enabledRow = row("Enabled", "Show the tarantula pet overlay.", toggle(config.enabled, (value) => {
      config.enabled = value;
      api.storage.set("enabled", value);
      applyConfig();
    }));
    card.appendChild(enabledRow);

    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "84";
    sizeInput.max = "180";
    sizeInput.value = String(config.size);
    sizeInput.addEventListener("input", () => {
      config.size = Number(sizeInput.value);
      api.storage.set("size", config.size);
      applyConfig();
    });
    card.appendChild(row("Size", "Default is intentionally small so it does not block clicks.", sizeInput));

    card.appendChild(row("Follow cursor screen", "When far away, bias movement toward the cursor area.", toggle(config.homeToCursorScreen, (value) => {
      config.homeToCursorScreen = value;
      api.storage.set("homeToCursorScreen", value);
      applyConfig();
    })));

    wrap.appendChild(card);
    root.appendChild(wrap);
  };
}

function row(labelText, descText, control) {
  const rowEl = document.createElement("div");
  rowEl.className = "flex items-center justify-between gap-4 p-3";
  const left = document.createElement("div");
  left.className = "flex min-w-0 flex-col gap-1";
  const label = document.createElement("div");
  label.className = "min-w-0 text-sm text-token-text-primary";
  label.textContent = labelText;
  const desc = document.createElement("div");
  desc.className = "text-token-text-secondary min-w-0 text-sm";
  desc.textContent = descText;
  left.append(label, desc);
  rowEl.append(left, control);
  return rowEl;
}

function toggle(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className = "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.className = "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
    pill.className = "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 ease-out h-5 w-8 " + (on ? "bg-token-charts-blue" : "bg-token-foreground/20");
    knob.style.transform = on ? "translateX(14px)" : "translateX(2px)";
  };
  apply(initial);
  btn.appendChild(pill);
  btn.addEventListener("click", () => {
    const next = btn.getAttribute("aria-checked") !== "true";
    apply(next);
    onChange(next);
  });
  return btn;
}

module.exports = {
  start(api) {
    if (cleanup) cleanup();
    const style = injectStyle();
    const pet = createPet();
    const config = readConfig(api);
    const state = {
      size: config.size,
      x: Math.max(120, window.innerWidth - 220),
      y: Math.max(120, window.innerHeight - 220),
      vx: 0,
      vy: 0,
      speed: 0,
      targetSpeed: 0,
      heading: Math.PI,
      gait: Math.random(),
      behavior: "pause",
      behaviorUntil: performance.now() + 1200,
      pointerX: 0,
      pointerY: 0,
      pointerActive: false,
      seed: Math.random() * 1000,
    };
    let frame = 0;
    let stopped = false;
    let last = performance.now();

    const applyConfig = () => {
      state.size = Number(config.size) || DEFAULT_CONFIG.size;
      renderPet(pet.root, pet.body, state, config);
    };

    const onPointerMove = (event) => {
      state.pointerX = event.clientX;
      state.pointerY = event.clientY;
      state.pointerActive = true;
    };
    const onResize = () => {
      const bounds = viewportRect();
      state.x = clamp(state.x, bounds.left + state.size / 2, bounds.right - state.size / 2);
      state.y = clamp(state.y, bounds.top + state.size / 2, bounds.bottom - state.size / 2);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("resize", onResize);

    function tick(now) {
      if (stopped) return;
      const dt = Math.min(0.12, Math.max(0.016, (now - last) / 1000));
      last = now;
      updateMotion(state, now, dt, config);
      renderPet(pet.root, pet.body, state, config);
      frame = window.requestAnimationFrame(tick);
    }

    api.settings.register({
      id: "tarantula-pet",
      title: "Tarantula Pet",
      description: "Quiet stop-probe-creep desktop pet.",
      render: renderSettings(api, config, applyConfig),
    });

    applyConfig();
    frame = window.requestAnimationFrame(tick);
    api.log.info("tarantula pet started");

    cleanup = () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      pet.root.remove();
      style.remove();
      cleanup = null;
    };
  },
  stop() {
    if (cleanup) cleanup();
  },
};
