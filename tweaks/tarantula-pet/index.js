const TWEAK_ID = "com.l1uyun.tarantula-pet";
const STYLE_ID = "codexpp-tarantula-pet-style";
const ROOT_ID = "codexpp-tarantula-pet";
const SPRITESHEET_ASSET = "./assets/spritesheet.png";
const HIDDEN_NATIVE_ATTR = "data-codexpp-tarantula-hidden-native";

const DEFAULT_CONFIG = {
  enabled: true,
  size: 132,
  homeToCursorScreen: true,
};

const FRAME_COLUMNS = 8;
const FRAME_ROWS = 9;
const CELL_W = 192;
const CELL_H = 208;
const TWO_PI = Math.PI * 2;

let cleanup = null;
let mainSpritesheetFileUrl = null;
const cdpAttachedWebContentsIds = new Set();
const hiddenNativeArtifacts = new Map();

function isAvatarOverlayWindow() {
  const href = window.location?.href || "";
  const route = (() => {
    try {
      return new URL(href).searchParams.get("initialRoute") || "";
    } catch {
      return "";
    }
  })();
  if (route === "/avatar-overlay" || href.includes("initialRoute=%2Favatar-overlay")) return true;
  return window.innerWidth <= 520 && window.innerHeight <= 520;
}

function removeExistingPetDom() {
  for (const existing of Array.from(document.querySelectorAll(`#${ROOT_ID}`))) {
    existing.remove();
  }
  for (const existing of Array.from(document.querySelectorAll(".codexpp-tarantula-body, .codexpp-tarantula-sprite"))) {
    if (!existing.closest(`#${ROOT_ID}`)) existing.remove();
  }
  for (const existingStyle of Array.from(document.querySelectorAll(`#${STYLE_ID}`))) {
    existingStyle.remove();
  }
}

function restoreNativeAvatarArtifacts() {
  for (const [element, previous] of hiddenNativeArtifacts) {
    if (!element.isConnected) continue;
    element.style.visibility = previous.visibility;
    element.style.pointerEvents = previous.pointerEvents;
    element.style.opacity = previous.opacity;
    element.removeAttribute(HIDDEN_NATIVE_ATTR);
  }
  hiddenNativeArtifacts.clear();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(current, target, amount) {
  return current + (target - current) * amount;
}

function normalizeAngle(value) {
  return ((value % TWO_PI) + TWO_PI) % TWO_PI;
}

function normalizeSignedAngle(value) {
  return ((((value + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

function angleDelta(target, current) {
  return normalizeSignedAngle(target - current);
}

function cssPx(value) {
  const rounded = Math.round((Number(value) || 0) * 1000) / 1000;
  return `${Object.is(rounded, -0) ? 0 : rounded}px`;
}

function readConfig(api) {
  return {
    enabled: api.storage.get("enabled", DEFAULT_CONFIG.enabled) !== false,
    size: api.storage.get("size", DEFAULT_CONFIG.size),
    homeToCursorScreen: api.storage.get("homeToCursorScreen", DEFAULT_CONFIG.homeToCursorScreen),
  };
}

function broadcastConfig(api, config) {
  try {
    api.ipc.send("tarantula-config-changed", {
      enabled: config.enabled,
      size: config.size,
      homeToCursorScreen: config.homeToCursorScreen,
    });
  } catch {}
}

function injectStyle() {
  let style = document.getElementById(STYLE_ID);
  if (style) return style;
  style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${ROOT_ID} {
      position: fixed;
      z-index: 20;
      left: 0;
      top: 0;
      width: var(--tarantula-width, 122px);
      height: var(--tarantula-size, 132px);
      pointer-events: none;
      transform-origin: 50% 52%;
      contain: layout paint style;
      user-select: none;
      background: transparent !important;
      border: 0 !important;
      outline: 0 !important;
      box-shadow: none !important;
    }
    #${ROOT_ID}.codexpp-tarantula-hidden {
      display: none;
    }
    #${ROOT_ID} .codexpp-tarantula-body,
    #${ROOT_ID} .codexpp-tarantula-sprite {
      width: 100%;
      height: 100%;
      background-color: transparent;
      background-repeat: no-repeat;
      background-position: 0 0;
      background-size: auto;
      border: 0 !important;
      outline: 0 !important;
      box-shadow: none !important;
      transform: translate3d(0, 0, 0);
    }
    #${ROOT_ID} .codexpp-tarantula-body {
      filter: drop-shadow(0 8px 7px rgba(0, 0, 0, 0.22));
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
  const sprite = document.createElement("div");
  sprite.className = "codexpp-tarantula-sprite";
  body.appendChild(sprite);
  root.appendChild(body);
  document.body.appendChild(root);
  return { root, body, sprite };
}

function installSpritesheetDiagnostics(src, api) {
  const image = new Image();
  image.addEventListener("load", () => {
    api.log.info("tarantula spritesheet loaded", {
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      cellWidth: Math.round(image.naturalWidth / FRAME_COLUMNS),
      cellHeight: Math.round(image.naturalHeight / FRAME_ROWS),
      srcKind: src.startsWith("data:") ? "data" : src.startsWith("file:") ? "file" : "other",
    });
  }, { once: true });
  image.addEventListener("error", () => {
    api.log.error("tarantula spritesheet failed", {
      srcKind: src.startsWith("data:") ? "data" : src.startsWith("file:") ? "file" : "other",
      srcPrefix: src.slice(0, 96),
    });
  }, { once: true });
  image.src = src;
}

function applyRendererSpritesheet(src, api) {
  if (!src) return () => {};
  const assetSource = src.startsWith("data:") ? "renderer-data-url" : "renderer-url";
  let appliedSprite = null;
  let diagnosticsInstalled = false;
  let lastMissingLogAt = 0;
  let lastAppliedLogAt = 0;

  const apply = () => {
    const root = document.getElementById(ROOT_ID);
    const sprite = root?.querySelector(".codexpp-tarantula-sprite");
    if (!(sprite instanceof HTMLElement)) {
      const now = Date.now();
      if (now - lastMissingLogAt > 5000) {
        lastMissingLogAt = now;
        api.log.info("tarantula renderer waiting for official pet DOM", {
          hasRoot: !!root,
          assetSource,
        });
      }
      return false;
    }

    const existingBackground = sprite.style.backgroundImage || "";
    const alreadyApplied = appliedSprite === sprite && existingBackground.includes("data:");
    if (!alreadyApplied) {
      sprite.style.backgroundImage = "url(" + JSON.stringify(src) + ")";
      appliedSprite = sprite;
    }

    if (!diagnosticsInstalled) {
      diagnosticsInstalled = true;
      installSpritesheetDiagnostics(src, api);
    }

    const now = Date.now();
    if (!alreadyApplied && now - lastAppliedLogAt > 2500) {
      lastAppliedLogAt = now;
      api.log.info("tarantula renderer sprite atlas applied", {
        assetSource,
        hasRoot: !!root,
        hasSprite: true,
      });
    }
    return true;
  };

  apply();

  const observer = new MutationObserver(() => {
    apply();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const timer = window.setInterval(apply, 750);

  return () => {
    window.clearInterval(timer);
    observer.disconnect();
  };
}

function isLikelyNativeAvatarArtifact(element) {
  if (!(element instanceof HTMLElement)) return false;
  const petRoot = document.getElementById(ROOT_ID);
  if (element === petRoot || element.closest(`#${ROOT_ID}`)) return false;
  if (element.closest("[role='button'], button, input, textarea, select")) return false;

  const text = (element.textContent || "").trim();
  if (text.length > 0) return false;
  if (element.classList.contains("codex-avatar-root")) return true;
  if (element.querySelector?.(".codex-avatar-root")) return false;

  const rect = element.getBoundingClientRect();
  if (rect.width < 72 || rect.height < 72 || rect.width > 240 || rect.height > 240) return false;
  if (rect.bottom > window.innerHeight - 48) return false;

  const computed = window.getComputedStyle(element);
  const isRotated = computed.transform && computed.transform !== "none";
  const looksSquare = Math.abs(rect.width - rect.height) <= Math.max(18, Math.min(rect.width, rect.height) * 0.18);
  const hasVisibleBox =
    computed.borderTopStyle !== "none" ||
    computed.borderRightStyle !== "none" ||
    computed.borderBottomStyle !== "none" ||
    computed.borderLeftStyle !== "none" ||
    computed.outlineStyle !== "none" ||
    computed.backgroundColor !== "rgba(0, 0, 0, 0)" ||
    computed.backgroundImage !== "none";

  return looksSquare && hasVisibleBox && isRotated;
}

function hideNativeAvatarArtifacts() {
  if (!isAvatarOverlayWindow()) return 0;
  let count = 0;
  for (const element of Array.from(document.body.querySelectorAll("*"))) {
    if (!isLikelyNativeAvatarArtifact(element)) continue;
    if (!hiddenNativeArtifacts.has(element)) {
      hiddenNativeArtifacts.set(element, {
        visibility: element.style.visibility,
        pointerEvents: element.style.pointerEvents,
        opacity: element.style.opacity,
      });
    }
    element.style.opacity = "0";
    element.setAttribute(HIDDEN_NATIVE_ATTR, "true");
    count += 1;
  }
  return count;
}

function viewportRect() {
  return {
    left: 8,
    top: 8,
    right: window.innerWidth - 8,
    bottom: window.innerHeight - 8,
  };
}

function workAreaForPoint(point, screenApi) {
  return screenApi.getDisplayNearestPoint(point).workArea;
}

function windowCenter(bounds) {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function sameWorkArea(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function windowSizeChanged(a, b) {
  return a.width !== b.width || a.height !== b.height;
}

function unionWorkArea(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clampCenterToArea(center, area, width, height, padding = 8) {
  const halfW = Math.max(1, width / 2);
  const halfH = Math.max(1, height / 2);
  return {
    x: clamp(center.x, area.x + halfW + padding, area.x + area.width - halfW - padding),
    y: clamp(center.y, area.y + halfH + padding, area.y + area.height - halfH - padding),
  };
}

function makeInitialMainMotion(bounds, screenApi) {
  const center = windowCenter(bounds);
  const area = workAreaForPoint(center, screenApi);
  const clamped = clampCenterToArea(center, area, bounds.width, bounds.height, 8);
  return {
    x: clamped.x,
    y: clamped.y,
    vx: 0,
    vy: 0,
    speed: 0,
    targetSpeed: 9,
    heading: Math.random() * TWO_PI,
    headingGoal: Math.random() * TWO_PI,
    nextIntentAt: Date.now() + 800,
    nextPauseAt: Date.now() + 6000 + Math.random() * 8000,
    pauseUntil: 0,
    mode: "crawl",
    gait: Math.random(),
    lastMoveAt: 0,
  };
}

function findAvatarOverlayWindow(BrowserWindow) {
  return findAvatarOverlayWindows(BrowserWindow)[0] || null;
}

function findAvatarOverlayWindows(BrowserWindow) {
  return BrowserWindow.getAllWindows().filter((win) => {
    if (!win || win.isDestroyed()) return false;
    const url = win.webContents?.getURL?.() || "";
    return url.includes("initialRoute=%2Favatar-overlay") || url.includes("initialRoute=/avatar-overlay");
  });
}

function hasPotentialAvatarOverlayWindow(BrowserWindow) {
  return BrowserWindow.getAllWindows().some((win) => {
    if (!win || win.isDestroyed()) return false;
    const url = win.webContents?.getURL?.() || "";
    if (url.includes("initialRoute=%2Favatar-overlay") || url.includes("initialRoute=/avatar-overlay")) return true;
    if (url && !url.startsWith("app://-")) return false;
    const bounds = win.getBounds?.();
    if (!bounds) return false;
    return bounds.width >= 300 && bounds.width <= 560 && bounds.height >= 260 && bounds.height <= 560;
  });
}

function closeExtraAvatarOverlayWindows(BrowserWindow, api) {
  const overlays = findAvatarOverlayWindows(BrowserWindow);
  if (overlays.length <= 1) return overlays;
  const [keeper, ...extras] = overlays;
  for (const extra of extras) {
    try {
      api.log.warn("tarantula closing duplicate avatar overlay", {
        webContentsId: extra.webContents?.id ?? null,
      });
      extra.close();
    } catch (error) {
      api.log.warn("tarantula duplicate avatar overlay close failed", error);
    }
  }
  return [keeper];
}

function isCodexMainWindow(win) {
  if (!win || win.isDestroyed()) return false;
  const webContents = win.webContents;
  const url = webContents?.getURL?.() || "";
  if (url.includes("initialRoute=%2Favatar-overlay") || url.includes("initialRoute=/avatar-overlay")) return false;
  if (url && !url.startsWith("app://-")) return false;
  const bounds = win.getBounds?.();
  if (!bounds) return false;
  return bounds.width >= 760 && bounds.height >= 520;
}

function findCodexMainWindow(BrowserWindow) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (isCodexMainWindow(win)) return win;
  }
  return null;
}

function codexMainWindowReady(BrowserWindow) {
  const win = findCodexMainWindow(BrowserWindow);
  if (!win) return false;
  const url = win.webContents?.getURL?.() || "";
  return url.startsWith("app://-");
}

function requestCodexAvatarOverlay(api, screenApi) {
  const cursor = screenApi.getCursorScreenPoint();
  const area = workAreaForPoint(cursor, screenApi);
  const size = Math.round(DEFAULT_CONFIG.size * 2.7);
  const width = size;
  const height = Math.round(size * 0.9);
  const center = clampCenterToArea(
    { x: area.x + area.width * 0.56, y: area.y + area.height * 0.58 },
    area,
    width,
    height,
    24,
  );
  return api.codex?.createWindow({
    route: "/avatar-overlay",
    appearance: "avatarOverlay",
    hostId: "local",
    show: true,
    bounds: {
      x: Math.round(center.x - width / 2),
      y: Math.round(center.y - height / 2),
      width,
      height,
    },
  });
}

function updateMainWindowMotion(state, dt, screenApi, bounds) {
  const now = Date.now();
  const previousMode = state.mode || "crawl";
  const cursor = screenApi.getCursorScreenPoint();
  const currentArea = workAreaForPoint({ x: state.x, y: state.y }, screenApi);
  const cursorArea = workAreaForPoint(cursor, screenApi);
  const sameDisplay = sameWorkArea(currentArea, cursorArea);
  const motionArea = sameDisplay ? currentArea : unionWorkArea(currentArea, cursorArea);
  const margin = 72;
  const minX = currentArea.x + bounds.width / 2 + margin;
  const maxX = currentArea.x + currentArea.width - bounds.width / 2 - margin;
  const minY = currentArea.y + bounds.height / 2 + margin;
  const maxY = currentArea.y + currentArea.height - bounds.height / 2 - margin;

  if (now >= state.nextIntentAt) {
    state.nextIntentAt = now + 700 + Math.random() * 1900;
    state.headingGoal = normalizeAngle(state.headingGoal + (Math.random() - 0.5) * 0.7);
    state.targetSpeed = 6 + Math.random() * 10;
  }

  if (now >= state.nextPauseAt) {
    state.pauseUntil = now + 600 + Math.random() * 1900;
    state.nextPauseAt = now + 7000 + Math.random() * 13000;
  }

  if (!sameDisplay) {
    const dx = cursorArea.x + cursorArea.width * 0.5 - state.x;
    const dy = cursorArea.y + cursorArea.height * 0.55 - state.y;
    state.headingGoal = Math.atan2(dy, dx);
    state.targetSpeed = 34;
    state.pauseUntil = 0;
    state.mode = "home";
  } else if (now < state.pauseUntil) {
    const remainingPauseMs = state.pauseUntil - now;
    state.mode = remainingPauseMs < 450 ? "probe" : "freeze";
    state.targetSpeed = 0;
  } else {
    state.mode = "crawl";
  }
  applyModeTransitionDamping(state, previousMode);

  let steerX = 0;
  let steerY = 0;
  if (sameDisplay && state.x < minX) steerX += (minX - state.x) / margin;
  if (sameDisplay && state.x > maxX) steerX -= (state.x - maxX) / margin;
  if (sameDisplay && state.y < minY) steerY += (minY - state.y) / margin;
  if (sameDisplay && state.y > maxY) steerY -= (state.y - maxY) / margin;
  if (sameDisplay && (Math.abs(steerX) > 0.02 || Math.abs(steerY) > 0.02)) {
    state.headingGoal = Math.atan2(steerY, steerX);
    state.targetSpeed = Math.max(state.targetSpeed, 11);
  }

  const mdx = state.x - cursor.x;
  const mdy = state.y - cursor.y;
  const mouseDistance = Math.hypot(mdx, mdy);
  if (sameDisplay && mouseDistance < 110 && mouseDistance > 1) {
    const influence = (110 - mouseDistance) / 110;
    state.headingGoal = normalizeAngle(Math.atan2(mdy, mdx) + (Math.random() - 0.5) * 0.25);
    state.targetSpeed = Math.max(state.targetSpeed, 10 + influence * 9);
    if (mouseDistance < 58) state.pauseUntil = 0;
  }

  state.heading = turnToward(state.heading, normalizeAngle(state.headingGoal), dt * 0.75, dt);
  const targetSpeed = state.mode === "freeze" || state.mode === "probe" ? 0 : state.targetSpeed;
  state.speed = lerp(state.speed, targetSpeed, Math.min(1, dt * 1.2));
  state.vx = lerp(state.vx, Math.cos(state.heading) * state.speed, Math.min(1, dt * 1.4));
  state.vy = lerp(state.vy, Math.sin(state.heading) * state.speed * 0.8, Math.min(1, dt * 1.4));
  const nextCenter = { x: state.x + state.vx * dt, y: state.y + state.vy * dt };
  const clamped = clampCenterToArea(
    nextCenter,
    motionArea,
    bounds.width,
    bounds.height,
    8,
  );
  const distance = Math.hypot(clamped.x - state.x, clamped.y - state.y);
  state.x = clamped.x;
  state.y = clamped.y;
  state.gait = advanceGait(state.gait, state.mode, state.speed, distance, dt);
}

function applyModeTransitionDamping(state, previousMode) {
  if (previousMode === state.mode) return;
  if (state.mode !== "freeze" && state.mode !== "probe") return;
  state.targetSpeed = 0;
  state.speed = Math.min(state.speed, state.mode === "probe" ? 1.2 : 2.4);
  state.vx *= 0.18;
  state.vy *= 0.18;
}

function turnToward(current, target, amount, dt) {
  const maxTurn = Math.max(0.004, dt * 0.45);
  const step = clamp(angleDelta(target, current) * Math.min(1, amount), -maxTurn, maxTurn);
  return normalizeAngle(current + step);
}

function gaitRate(behavior, speed) {
  if (behavior === "freeze" || behavior === "pause") return 0.006;
  if (behavior === "probe") return 0.06;
  if (behavior === "home") return clamp(speed / 58, 0.12, 0.36);
  return clamp(speed / 62, 0.08, 0.24);
}

function advanceGait(gait, behavior, speed, distance, dt) {
  const current = Number.isFinite(gait) ? gait : 0;
  if (speed < 0.35 && distance < 0.05) return current;
  const stride = behavior === "home" ? 68 : 56;
  const distancePhase = Math.max(0, distance) / stride;
  const timePhase = Math.max(0, dt) * gaitRate(behavior, speed);
  const phase = behavior === "freeze" || behavior === "pause"
    ? Math.max(distancePhase, timePhase * 0.35)
    : Math.max(distancePhase, timePhase);
  return (current + phase) % 1;
}

function directionRow(heading, speed) {
  if (speed < 0.35) return 0;
  return (Math.round(normalizeSignedAngle(heading) / (Math.PI / 4)) + 8) % 8 + 1;
}

function spriteRow(state) {
  if (state.mode === "freeze" || state.mode === "pause" || state.mode === "probe" || state.speed < 0.35) {
    return 0;
  }
  return directionRow(state.heading, state.speed);
}

function frameColumn(state) {
  const gait = Number.isFinite(state.gait) ? state.gait : 0;
  if (state.mode === "freeze" || state.mode === "probe" || state.behavior === "pause" || state.speed < 0.35) {
    return Math.floor(gait * 4) % 4;
  }
  return Math.floor(gait * 8) % 8;
}

function frameBackgroundSize(frameWidth, frameHeight) {
  return `${cssPx(frameWidth * FRAME_COLUMNS)} ${cssPx(frameHeight * FRAME_ROWS)}`;
}

function petCenterTransform(viewportWidth, viewportHeight, width, height) {
  return `translate3d(${cssPx((viewportWidth - width) / 2)}, ${cssPx((viewportHeight - height) / 2)}, 0)`;
}

function backgroundPosition(column, row, frameWidth = CELL_W, frameHeight = CELL_H) {
  const safeColumn = clamp(Math.round(Number(column) || 0), 0, FRAME_COLUMNS - 1);
  const safeRow = clamp(Math.round(Number(row) || 0), 0, FRAME_ROWS - 1);
  return `${cssPx(-safeColumn * frameWidth)} ${cssPx(-safeRow * frameHeight)}`;
}

function renderPet(root, body, sprite, state, config) {
  root.classList.toggle("codexpp-tarantula-hidden", !config.enabled);
  root.style.setProperty("--tarantula-size", `${state.size}px`);
  root.style.setProperty("--tarantula-width", `${state.width}px`);
  root.style.width = `${state.width}px`;
  root.style.height = `${state.size}px`;
  root.style.left = "0px";
  root.style.top = "0px";
  root.style.transform = petCenterTransform(window.innerWidth, window.innerHeight, state.width, state.size);

  const row = spriteRow(state);
  const column = frameColumn(state);
  sprite.style.backgroundSize = frameBackgroundSize(state.width, state.size);
  sprite.style.backgroundPosition = backgroundPosition(column, row, state.width, state.size);
  const bob = bodyBob(state.gait, state.speed, state.mode || state.behavior);
  body.style.transform = `translate3d(0, ${bob.toFixed(2)}px, 0)`;
  body.dataset.behavior = state.mode || state.behavior;
  body.dataset.directionRow = String(row);
  body.dataset.frameColumn = String(column);
  body.dataset.gait = Number.isFinite(state.gait) ? state.gait.toFixed(3) : "0.000";
}

function bodyBob(gait, speed, behavior) {
  if (speed < 0.35) return 0;
  const phase = Number.isFinite(gait) ? gait : 0;
  const amplitude = behavior === "home" ? 0.36 : 0.26;
  return Math.sin(phase * TWO_PI * 2) * amplitude;
}

function desiredPetWindowSize(config) {
  const size = Math.round((Number(config.size) || DEFAULT_CONFIG.size) * 2.7);
  return {
    width: size,
    height: Math.round(size * 0.9),
  };
}

function petSizeFromWindowBounds(bounds, config) {
  const fallbackSize = Number(config.size) || DEFAULT_CONFIG.size;
  const size = clamp(Math.round((Number(bounds.height) || fallbackSize * 2.7) / 2.7), 72, 260);
  return {
    size,
    frameWidth: size * (CELL_W / CELL_H),
  };
}

function mainSpritesheetSrc(api) {
  if (mainSpritesheetFileUrl) return mainSpritesheetFileUrl;
  try {
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const file = path.join(__dirname, "assets", "spritesheet.png");
    mainSpritesheetFileUrl = pathToFileURL(file).href;
  } catch (error) {
    api.log.warn("tarantula main spritesheet file url failed; using packaged asset path", error);
    mainSpritesheetFileUrl = "";
  }
  return mainSpritesheetFileUrl;
}

function mainPetInstallScript(spriteSrc, config) {
  const initialSize = Number(config.size) || DEFAULT_CONFIG.size;
  return `
    (() => {
      const ROOT_ID = ${JSON.stringify(ROOT_ID)};
      const STYLE_ID = ${JSON.stringify(STYLE_ID)};
      const spriteSrc = ${JSON.stringify(spriteSrc)};
      document.documentElement.style.background = "transparent";
      document.documentElement.style.overflow = "hidden";
      if (!document.body) {
        return {
          hasRoot: false,
          hasSprite: false,
          backgroundImage: "",
          hiddenCount: 0,
          bodyChildCount: 0,
          rootWidth: "",
          rootHeight: "",
          reason: "missing-body"
        };
      }
      document.body.style.margin = "0";
      document.body.style.width = "100vw";
      document.body.style.height = "100vh";
      document.body.style.overflow = "hidden";
      document.body.style.background = "transparent";
      const isLikelyNativeAvatarArt = (element, petRoot) => {
        if (!(element instanceof HTMLElement)) return false;
        if (element === petRoot || element.closest("#" + ROOT_ID)) return false;
        if (element.closest("[role='button'], button, input, textarea, select")) return false;
        const text = (element.textContent || "").trim();
        if (text.length > 0) return false;
        if (element.classList.contains("codex-avatar-root")) return true;
        if (element.querySelector && element.querySelector(".codex-avatar-root")) return false;
        const rect = element.getBoundingClientRect();
        if (rect.width < 72 || rect.height < 72 || rect.width > 240 || rect.height > 240) return false;
        if (rect.bottom > window.innerHeight - 48) return false;
        const computed = window.getComputedStyle(element);
        const isRotated = computed.transform && computed.transform !== "none";
        const looksSquare = Math.abs(rect.width - rect.height) <= Math.max(18, Math.min(rect.width, rect.height) * 0.18);
        const hasVisibleBox =
          computed.borderTopStyle !== "none" ||
          computed.borderRightStyle !== "none" ||
          computed.borderBottomStyle !== "none" ||
          computed.borderLeftStyle !== "none" ||
          computed.outlineStyle !== "none" ||
          computed.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          computed.backgroundImage !== "none";
        return looksSquare && hasVisibleBox && isRotated;
      };
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = ${JSON.stringify(`
        html, body {
          background: transparent !important;
          overflow: hidden !important;
        }
        #${ROOT_ID} {
          position: fixed;
          left: 0;
          top: 0;
          z-index: 20;
          width: var(--tarantula-width, 122px);
          height: var(--tarantula-size, 132px);
          pointer-events: none;
          transform-origin: 50% 52%;
          contain: layout paint style;
          user-select: none;
          background: transparent !important;
          border: 0 !important;
          outline: 0 !important;
          box-shadow: none !important;
        }
        #${ROOT_ID}.codexpp-tarantula-hidden {
          display: none;
        }
        #${ROOT_ID} .codexpp-tarantula-body,
        #${ROOT_ID} .codexpp-tarantula-sprite {
          width: 100%;
          height: 100%;
          background-color: transparent;
          background-repeat: no-repeat;
          background-position: 0 0;
          background-size: auto;
          border: 0 !important;
          outline: 0 !important;
          box-shadow: none !important;
          transform: translate3d(0, 0, 0);
        }
        #${ROOT_ID} .codexpp-tarantula-body {
          filter: drop-shadow(0 8px 7px rgba(0, 0, 0, 0.22));
        }
      `)};
      let root = document.getElementById(ROOT_ID);
      let createdRoot = false;
      if (!root) {
        createdRoot = true;
        root = document.createElement("div");
        root.id = ROOT_ID;
        root.setAttribute("aria-hidden", "true");
        const body = document.createElement("div");
        body.className = "codexpp-tarantula-body";
        const sprite = document.createElement("div");
        sprite.className = "codexpp-tarantula-sprite";
        body.appendChild(sprite);
        root.appendChild(body);
        document.body.appendChild(root);
      }
      let hiddenCount = 0;
      for (const element of Array.from(document.body.querySelectorAll("*"))) {
        if (!isLikelyNativeAvatarArt(element, root)) continue;
        element.style.opacity = "0";
        element.setAttribute(${JSON.stringify(HIDDEN_NATIVE_ATTR)}, "true");
        hiddenCount += 1;
      }
      const preservedTextCount = Array.from(document.body.querySelectorAll("*")).filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.closest("#" + ROOT_ID)) return false;
        return (element.textContent || "").trim().length > 0 && getComputedStyle(element).opacity !== "0";
      }).length;
      const preservedInteractiveCount = document.body.querySelectorAll("[role='button'], button, input, textarea, select").length;
      const sprite = root.querySelector(".codexpp-tarantula-sprite");
      const existingBackground = sprite ? (sprite.style.backgroundImage || "") : "";
      if (sprite && spriteSrc && !existingBackground.includes("data:")) {
        sprite.style.backgroundImage = "url(" + JSON.stringify(spriteSrc) + ")";
      }
      window.__codexppTarantulaUpdate = (payload = {}) => {
        root.classList.toggle("codexpp-tarantula-hidden", payload.enabled === false);
        const size = Number(payload.size || ${initialSize});
        const width = Number(payload.frameWidth || size * ${CELL_W / CELL_H});
        root.style.setProperty("--tarantula-size", size + "px");
        root.style.setProperty("--tarantula-width", width + "px");
        root.style.width = width + "px";
        root.style.height = size + "px";
        root.style.left = "0px";
        root.style.top = "0px";
        root.style.transform = "translate3d(" + ((window.innerWidth - width) / 2).toFixed(3) + "px, " + ((window.innerHeight - size) / 2).toFixed(3) + "px, 0)";
        const spriteNode = root.querySelector(".codexpp-tarantula-sprite");
        const bodyNode = root.querySelector(".codexpp-tarantula-body");
        if (spriteNode) {
          spriteNode.style.backgroundSize = payload.backgroundSize || ((width * ${FRAME_COLUMNS}) + "px " + (size * ${FRAME_ROWS}) + "px");
          spriteNode.style.backgroundPosition = payload.backgroundPosition || "0px 0px";
        }
        if (bodyNode) {
          bodyNode.style.transform = "translate3d(0, " + Number(payload.bob || 0).toFixed(2) + "px, 0)";
          bodyNode.dataset.behavior = payload.mode || "";
          bodyNode.dataset.directionRow = String(payload.row || 0);
          bodyNode.dataset.frameColumn = String(payload.column || 0);
          bodyNode.dataset.gait = Number(payload.gait || 0).toFixed(3);
        }
      };
      if (createdRoot) {
        window.__codexppTarantulaUpdate({ size: ${initialSize}, enabled: ${config.enabled !== false} });
      }
      return {
        hasRoot: !!root,
        hasSprite: !!sprite,
        existingBackground,
        backgroundImage: sprite ? sprite.style.backgroundImage : "",
        backgroundSize: sprite ? getComputedStyle(sprite).backgroundSize : "",
        backgroundPosition: sprite ? getComputedStyle(sprite).backgroundPosition : "",
        hiddenCount,
        bodyChildCount: document.body.children.length,
        rootWidth: root.style.width,
        rootHeight: root.style.height,
        rootLeft: root.style.left,
        rootTop: root.style.top,
        rootTransform: root.style.transform,
        preservedTextCount,
        preservedInteractiveCount
      };
    })();
  `;
}

function timeoutPromise(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function evaluateInOfficialOverlay(win, api, script, label) {
  if (!win || win.isDestroyed()) return null;
  const webContents = win.webContents;
  if (!webContents || webContents.isDestroyed?.()) return null;
  const debug = webContents.debugger;
  if (debug && typeof debug.attach === "function" && typeof debug.sendCommand === "function") {
    try {
      if (!debug.isAttached()) {
        debug.attach("1.3");
        cdpAttachedWebContentsIds.add(webContents.id);
      }
      return timeoutPromise(
        debug.sendCommand("Runtime.evaluate", {
          expression: script,
          awaitPromise: false,
          returnByValue: true,
        }).then((result) => {
          if (result?.exceptionDetails) {
            throw new Error(`${label} exception: ${result.exceptionDetails.text || "unknown"}`);
          }
          return result?.result?.value ?? null;
        }),
        1400,
        label,
      );
    } catch (error) {
      api.log.warn("tarantula official overlay CDP evaluation unavailable", {
        label,
        message: String(error?.message || error),
      });
    }
  }
  try {
    return timeoutPromise(webContents.executeJavaScript(script, true), 1400, label);
  } catch (error) {
    api.log.warn("tarantula official overlay JavaScript evaluation failed", {
      label,
      message: String(error?.message || error),
    });
    return null;
  }
}

function detachOfficialOverlayDebuggers(BrowserWindow) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    const webContents = win.webContents;
    if (!webContents || webContents.isDestroyed?.()) continue;
    if (!cdpAttachedWebContentsIds.has(webContents.id)) continue;
    try {
      if (webContents.debugger?.isAttached?.()) webContents.debugger.detach();
    } catch {}
    cdpAttachedWebContentsIds.delete(webContents.id);
  }
}

function ensureMainInjectedPet(win, api, config) {
  return evaluateInOfficialOverlay(
    win,
    api,
    mainPetInstallScript(mainSpritesheetSrc(api), config),
    "tarantula main pet injection",
  )?.catch((error) => {
    api.log.warn("tarantula main pet injection failed", error);
    return null;
  });
}

function updateMainInjectedPet(win, state, config, petSize = null) {
  if (!win || win.isDestroyed()) return;
  const webContents = win.webContents;
  if (!webContents || webContents.isDestroyed?.()) return;
  const row = spriteRow(state);
  const column = frameColumn(state);
  const size = petSize?.size || Number(config.size) || DEFAULT_CONFIG.size;
  const frameWidth = petSize?.frameWidth || size * (CELL_W / CELL_H);
  const payload = {
    enabled: config.enabled,
    size,
    frameWidth,
    mode: state.mode,
    row,
    column,
    gait: Number.isFinite(state.gait) ? state.gait : 0,
    backgroundSize: frameBackgroundSize(frameWidth, size),
    backgroundPosition: backgroundPosition(column, row, frameWidth, size),
    bob: bodyBob(state.gait, state.speed, state.mode),
  };
  evaluateInOfficialOverlay(
    win,
    { log: { warn: () => {} } },
    `window.__codexppTarantulaUpdate && window.__codexppTarantulaUpdate(${JSON.stringify(payload)});`,
    "tarantula main pet update",
  )?.catch(() => {});
}

function startMain(api) {
  let electron;
  try {
    electron = require("electron");
  } catch (error) {
    api.log.error("tarantula main motion unavailable: electron module is missing", error);
    return;
  }
  const { app, BrowserWindow, screen } = electron;
  let stopped = false;
  let state = null;
  let last = Date.now();
  let lastLog = 0;
  let lastWaitingLog = 0;
  let lastInjectionAt = 0;
  let lastInjectedWebContentsId = null;
  let lastInjectionOkLogAt = 0;
  let lastMainDomUpdateAt = 0;
  let lastBounds = null;
  let resizeHoldUntil = 0;
  let codexOverlayRequestInFlight = false;
  let lastCodexOverlayRequestAt = 0;
  let firstMainReadyAt = 0;
  const offConfigChanged = api.ipc.on("tarantula-config-changed", (payload) => {
    if (!payload || typeof payload !== "object") return;
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed()) continue;
      win.webContents?.send?.(`codexpp:${TWEAK_ID}:tarantula-config-changed`, payload);
    }
  });
  const tick = () => {
    if (stopped) return;
    if (!app.isReady()) return;
    const now = Date.now();
    const config = readConfig(api);
    const [nativeOverlay] = closeExtraAvatarOverlayWindows(BrowserWindow, api);
    let win = nativeOverlay;
    if (!win) {
      const mainReady = codexMainWindowReady(BrowserWindow);
      if (mainReady && !firstMainReadyAt) firstMainReadyAt = now;
      if (mainReady && now - lastWaitingLog > 10000) {
        lastWaitingLog = now;
        api.log.info("tarantula waiting for native avatar overlay");
      }
      if (
        mainReady &&
        api.codex?.createWindow &&
        !hasPotentialAvatarOverlayWindow(BrowserWindow) &&
        now - firstMainReadyAt > 4000 &&
        !codexOverlayRequestInFlight &&
        now - lastCodexOverlayRequestAt > 10000
      ) {
        codexOverlayRequestInFlight = true;
        lastCodexOverlayRequestAt = now;
        requestCodexAvatarOverlay(api, screen)
          ?.then(() => {
            api.log.info("tarantula requested Codex avatar overlay");
          })
          ?.catch((error) => {
            api.log.warn("tarantula Codex avatar overlay request failed", error);
          })
          ?.finally(() => {
            codexOverlayRequestInFlight = false;
          });
      }
      return;
    }
    if (win.isDestroyed()) return;
    const dt = Math.min(0.12, Math.max(0.016, (now - last) / 1000));
    last = now;
    const currentBounds = win.getBounds();
    const petSize = petSizeFromWindowBounds(currentBounds, config);
    const bounds = currentBounds;
    if (!state) state = makeInitialMainMotion(bounds, screen);
    const userResized = lastBounds && windowSizeChanged(lastBounds, currentBounds);
    if (userResized) {
      resizeHoldUntil = now + 450;
      Object.assign(state, windowCenter(currentBounds), { vx: 0, vy: 0, speed: 0 });
    }
    const resizeHeld = now < resizeHoldUntil;
    if (!resizeHeld) updateMainWindowMotion(state, dt, screen, bounds);
    const next = {
      x: Math.round(state.x - bounds.width / 2),
      y: Math.round(state.y - bounds.height / 2),
      width: currentBounds.width,
      height: currentBounds.height,
    };
    if (!resizeHeld && (
      Math.abs(next.x - currentBounds.x) >= 1 ||
      Math.abs(next.y - currentBounds.y) >= 1 ||
      Math.abs(next.width - currentBounds.width) >= 1 ||
      Math.abs(next.height - currentBounds.height) >= 1
    )) {
      win.setBounds(next, false);
    }
    lastBounds = win.getBounds();
    const webContentsId = win.webContents?.id ?? null;
    if (webContentsId !== lastInjectedWebContentsId || now - lastInjectionAt > 1500) {
      lastInjectedWebContentsId = webContentsId;
      lastInjectionAt = now;
      ensureMainInjectedPet(win, api, config)?.then((result) => {
        if (!result || now - lastInjectionOkLogAt <= 10000) return;
        lastInjectionOkLogAt = now;
        api.log.info("tarantula main pet injection ok", {
          webContentsId,
          hasRoot: result.hasRoot,
          hasSprite: result.hasSprite,
          hiddenCount: result.hiddenCount,
          backgroundImagePrefix: String(result.backgroundImage || "").slice(0, 48),
          backgroundSize: result.backgroundSize,
          backgroundPosition: result.backgroundPosition,
          rootWidth: result.rootWidth,
          rootHeight: result.rootHeight,
          rootLeft: result.rootLeft,
          rootTop: result.rootTop,
          rootTransform: result.rootTransform,
          preservedTextCount: result.preservedTextCount,
          preservedInteractiveCount: result.preservedInteractiveCount,
        });
      });
    }
    if (now - lastMainDomUpdateAt > 90) {
      lastMainDomUpdateAt = now;
      updateMainInjectedPet(win, state, config, petSize);
    }
    try {
      win.webContents.send(`codexpp:${TWEAK_ID}:tarantula-window-move`, {
        heading: state.heading,
        speed: state.speed,
        mode: state.mode,
        x: state.x,
        y: state.y,
      });
    } catch {}
    if (now - lastLog > 10000) {
      lastLog = now;
      api.log.info("tarantula biomimetic window motion", {
        host: "codex-avatar-overlay",
        mode: state.mode,
        speed: Number(state.speed.toFixed(2)),
        x: Math.round(state.x),
        y: Math.round(state.y),
      });
    }
  };
  const timer = setInterval(tick, 50);
  cleanup = () => {
    stopped = true;
    clearInterval(timer);
    offConfigChanged();
    detachOfficialOverlayDebuggers(BrowserWindow);
    cleanup = null;
  };
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

    card.appendChild(row("Enabled", "Show the tarantula pet overlay.", toggle(config.enabled, (value) => {
      config.enabled = value;
      api.storage.set("enabled", value);
      applyConfig();
      broadcastConfig(api, config);
    })));

    const sizeInput = document.createElement("input");
    sizeInput.type = "range";
    sizeInput.min = "84";
    sizeInput.max = "220";
    sizeInput.value = String(config.size);
    sizeInput.addEventListener("input", () => {
      config.size = Number(sizeInput.value);
      api.storage.set("size", config.size);
      applyConfig();
      broadcastConfig(api, config);
    });
    card.appendChild(row("Size", "Uses the Rebuild tarantula crawl atlas.", sizeInput));

    card.appendChild(row("Follow cursor screen", "When far away, bias movement toward the cursor area.", toggle(config.homeToCursorScreen, (value) => {
      config.homeToCursorScreen = value;
      api.storage.set("homeToCursorScreen", value);
      applyConfig();
      broadcastConfig(api, config);
    })));

    wrap.appendChild(card);
    root.appendChild(wrap);
  };
}

function registerSettings(api, config, applyConfig) {
  if (!api.settings || typeof api.settings.register !== "function") return null;
  return api.settings.register({
    id: "tarantula-pet",
    title: "Tarantula Pet",
    description: "Quiet atlas-based tarantula crawl.",
    render: renderSettings(api, config, applyConfig),
  });
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

async function resolveRendererSpritesheet(api) {
  if (api.fs && typeof api.fs.readAsset === "function") {
    return api.fs.readAsset(SPRITESHEET_ASSET);
  }
  api.log.warn("tarantula renderer asset API unavailable", {
    asset: SPRITESHEET_ASSET,
  });
  return null;
}

module.exports = {
  async start(api) {
    if (api.process === "main") {
      startMain(api);
      return;
    }
    if (cleanup) cleanup();
    removeExistingPetDom();
    const config = readConfig(api);
    let applyConfig = () => {};
    const settingsHandle = registerSettings(api, config, () => applyConfig());
    if (!isAvatarOverlayWindow()) {
      api.log.info("tarantula pet skipped outside avatar overlay", {
        href: window.location?.href,
        width: window.innerWidth,
        height: window.innerHeight,
      });
      cleanup = () => {
        settingsHandle?.unregister?.();
        cleanup = null;
      };
      return;
    }

    // The main process owns avatar overlay motion and gait; the renderer only
    // keeps native Codex status/interaction layers available.
    const rendererSpritesheet = await resolveRendererSpritesheet(api);
    const stopRendererSpritesheet = applyRendererSpritesheet(rendererSpritesheet, api);
    let hiddenCount = hideNativeAvatarArtifacts();
    const observer = new MutationObserver(() => {
      hiddenCount += hideNativeAvatarArtifacts();
    });

    applyConfig = () => {
      const root = document.getElementById(ROOT_ID);
      if (root) root.classList.toggle("codexpp-tarantula-hidden", !config.enabled);
    };

    const offConfigChanged = api.ipc.on("tarantula-config-changed", (payload) => {
      if (!payload || typeof payload !== "object") return;
      Object.assign(config, payload);
      applyConfig();
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    const hideTimer = window.setInterval(() => {
      hiddenCount += hideNativeAvatarArtifacts();
    }, 500);

    applyConfig();
    api.log.info("tarantula avatar overlay renderer bridge started", {
      hiddenNativeArtifacts: hiddenCount,
      enabled: config.enabled,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      href: window.location?.href,
      atlas: `${FRAME_COLUMNS}x${FRAME_ROWS}`,
    });

    cleanup = () => {
      stopRendererSpritesheet();
      window.clearInterval(hideTimer);
      observer.disconnect();
      offConfigChanged();
      settingsHandle?.unregister?.();
      restoreNativeAvatarArtifacts();
      cleanup = null;
    };
  },
  stop() {
    if (cleanup) cleanup();
  },
};

module.exports._test = {
  backgroundPosition,
  advanceGait,
  bodyBob,
  frameBackgroundSize,
  petCenterTransform,
  directionRow,
  spriteRow,
  frameColumn,
  applyModeTransitionDamping,
  gaitRate,
  isAvatarOverlayWindow,
  sameWorkArea,
  turnToward,
  unionWorkArea,
};
