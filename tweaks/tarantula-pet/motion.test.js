const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const TWO_PI = Math.PI * 2;
const tweakDir = __dirname;
const indexPath = path.join(tweakDir, "index.js");
const indexText = fs.readFileSync(indexPath, "utf8");
const manifestText = fs.readFileSync(path.join(tweakDir, "manifest.json"), "utf8");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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

function applyModeTransitionDamping(state, previousMode) {
  if (previousMode === state.mode) return;
  if (state.mode !== "freeze" && state.mode !== "probe") return;
  state.targetSpeed = 0;
  state.speed = Math.min(state.speed, state.mode === "probe" ? 1.2 : 2.4);
  state.vx *= 0.18;
  state.vy *= 0.18;
}

function directionRow(heading, speed) {
  if (speed < 0.8) return 0;
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
  if (state.mode === "freeze" || state.mode === "probe" || state.speed < 0.35) return Math.floor(gait * 4) % 4;
  return Math.floor(gait * 8) % 8;
}

function cssPx(value) {
  const rounded = Math.round((Number(value) || 0) * 1000) / 1000;
  return `${Object.is(rounded, -0) ? 0 : rounded}px`;
}

function frameBackgroundSize(frameWidth, frameHeight) {
  return `${cssPx(frameWidth * 8)} ${cssPx(frameHeight * 9)}`;
}

function petCenterTransform(viewportWidth, viewportHeight, width, height) {
  return `translate3d(${cssPx((viewportWidth - width) / 2)}, ${cssPx((viewportHeight - height) / 2)}, 0)`;
}

function backgroundPosition(column, row, frameWidth = 192, frameHeight = 208) {
  const safeColumn = clamp(Math.round(Number(column) || 0), 0, 7);
  const safeRow = clamp(Math.round(Number(row) || 0), 0, 8);
  return `${cssPx(-safeColumn * frameWidth)} ${cssPx(-safeRow * frameHeight)}`;
}

function isAvatarOverlayWindowLike(href, width, height) {
  const route = (() => {
    try {
      return new URL(href).searchParams.get("initialRoute") || "";
    } catch {
      return "";
    }
  })();
  if (route === "/avatar-overlay" || href.includes("initialRoute=%2Favatar-overlay")) return true;
  return width <= 520 && height <= 520;
}

test("uses the old tarantula atlas instead of a continuously transformed single frame", () => {
  assert.ok(indexText.includes('SPRITESHEET_ASSET = "./assets/spritesheet.png"'));
  assert.ok(indexText.includes("const CELL_W = 192;"));
  assert.ok(indexText.includes("const CELL_H = 208;"));
  assert.doesNotMatch(indexText, /TARANTULA_DATA_URL/);
  assert.doesNotMatch(indexText, /body\.style\.transform = `rotate/);
  assert.doesNotMatch(indexText, /scale\(\$\{/);
});

test("Rebuild crawl atlas stays below the runtime data URL limit", () => {
  const assetPath = path.join(tweakDir, "assets", "spritesheet.png");
  const bytes = fs.statSync(assetPath).size;
  assert.ok(bytes > 700_000);
  assert.ok(bytes < 1024 * 1024);
});

test("renderer sprite loading uses the PlusPlus asset API instead of sandbox-blocked file URLs", () => {
  assert.ok(indexText.includes("function resolveRendererSpritesheet"));
  assert.ok(indexText.includes("api.fs.readAsset"));
  assert.ok(indexText.includes("tarantula renderer asset API unavailable"));
  assert.doesNotMatch(indexText, /SPRITESHEET_FILE_URL/);
  assert.doesNotMatch(indexText, /AppData\/Roaming\/codex-plusplus/);
  assert.doesNotMatch(indexText, /asset API unavailable; using file asset path/);
});

test("avatar overlay detection follows the route before window size", () => {
  assert.ok(indexText.includes('route === "/avatar-overlay"'));
  assert.equal(isAvatarOverlayWindowLike("app://-/index.html?initialRoute=%2Favatar-overlay", 1920, 1040), true);
  assert.equal(isAvatarOverlayWindowLike("app://-/index.html", 356, 320), true);
  assert.equal(isAvatarOverlayWindowLike("app://-/index.html", 1920, 1040), false);
});

test("angleDelta takes the short path across the -pi/pi boundary", () => {
  const current = Math.PI - 0.03;
  const target = -Math.PI + 0.03;
  assert.ok(Math.abs(angleDelta(target, current)) < 0.08);
});

test("turnToward caps per-frame rotation to avoid twitching", () => {
  const current = 0;
  const target = Math.PI;
  const next = turnToward(current, target, 1, 1 / 60);
  assert.ok(Math.abs(angleDelta(next, current)) <= 0.008);
});

test("gait rates stay slow enough for a calm tarantula crawl", () => {
  assert.equal(gaitRate("freeze", 20), 0.006);
  assert.equal(gaitRate("probe", 20), 0.06);
  assert.ok(gaitRate("crawl", 12) >= 0.08);
  assert.ok(gaitRate("crawl", 12) <= 0.24);
  assert.ok(gaitRate("home", 18) <= 0.36);
});

test("direction rows map movement to the eight crawl rows and idle stays on row zero", () => {
  assert.equal(directionRow(0, 0.2), 0);
  assert.equal(directionRow(0, 5), 1);
  assert.equal(directionRow(Math.PI / 2, 5), 3);
  assert.equal(directionRow(Math.PI, 5), 5);
  assert.equal(directionRow(-Math.PI / 2, 5), 7);
});

test("freeze and probe states use posture frames instead of directional crawl rows", () => {
  assert.equal(spriteRow({ mode: "freeze", heading: Math.PI / 2, speed: 12 }), 0);
  assert.equal(spriteRow({ mode: "probe", heading: Math.PI, speed: 4 }), 0);
  assert.equal(spriteRow({ mode: "crawl", heading: Math.PI / 2, speed: 5 }), 3);
  assert.equal(frameColumn({ mode: "probe", speed: 4, gait: 0.9 }), 3);
  assert.ok(indexText.includes("function spriteRow"));
  assert.ok(indexText.includes("const row = spriteRow(state);"));
});

test("entering freeze or probe damps velocity so pause states do not slide", () => {
  const state = { mode: "freeze", targetSpeed: 14, speed: 14, vx: 10, vy: -8 };
  applyModeTransitionDamping(state, "crawl");
  assert.equal(state.targetSpeed, 0);
  assert.ok(state.speed <= 2.4);
  assert.ok(Math.abs(state.vx) <= 1.8);
  assert.ok(Math.abs(state.vy) <= 1.44);
  const motionBody = indexText.slice(
    indexText.indexOf("function updateMainWindowMotion"),
    indexText.indexOf("function turnToward"),
  );
  assert.ok(indexText.includes("function applyModeTransitionDamping"));
  assert.ok(motionBody.includes("const previousMode = state.mode || \"crawl\";"));
  assert.ok(motionBody.includes("state.mode = remainingPauseMs < 450 ? \"probe\" : \"freeze\";"));
  assert.ok(motionBody.includes("applyModeTransitionDamping(state, previousMode);"));
  assert.ok(motionBody.includes('state.mode === "freeze" || state.mode === "probe" ? 0 : state.targetSpeed'));
});

test("slow crawl still advances all gait columns", () => {
  const seen = new Set();
  for (let gait = 0; gait < 1; gait += 0.0625) {
    seen.add(frameColumn({ mode: "crawl", speed: 1.2, gait }));
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("main-process gait advances from real movement so legs do not slide on a static frame", () => {
  let gait = 0;
  const seen = new Set();
  for (let i = 0; i < 80; i += 1) {
    gait = advanceGait(gait, "crawl", 12, 0.2, 1 / 20);
    seen.add(frameColumn({ mode: "crawl", speed: 12, gait }));
  }
  const mainMotionBody = indexText.slice(
    indexText.indexOf("function updateMainWindowMotion"),
    indexText.indexOf("function turnToward"),
  );
  assert.ok(seen.size >= 5);
  assert.ok(indexText.includes("gait: Math.random()"));
  assert.ok(indexText.includes("state.gait = advanceGait(state.gait, state.mode, state.speed, distance, dt);"));
  assert.ok(indexText.includes("gait: Number.isFinite(state.gait) ? state.gait : 0"));
  assert.ok(indexText.includes("bodyNode.dataset.gait = Number(payload.gait || 0).toFixed(3);"));
  assert.doesNotMatch(mainMotionBody, /state\.gait = \(state\.gait \+ dt \* gaitRate\(state\.mode \|\| state\.behavior, state\.speed\)\) % 1;/);
});

test("avatar overlay renderer does not race the main-process gait writer", () => {
  const rendererBody = indexText.slice(
    indexText.indexOf("async start(api)"),
    indexText.indexOf("stop()"),
  );
  assert.ok(indexText.includes("main process owns avatar overlay motion and gait"));
  assert.doesNotMatch(rendererBody, /window\.requestAnimationFrame\(tick\)/);
  assert.doesNotMatch(rendererBody, /state\.gait = \(state\.gait \+ dt \* gaitRate/);
  assert.doesNotMatch(rendererBody, /renderPet\(pet\.root, pet\.body, pet\.sprite, state, config\);\s*frame =/);
});

test("avatar overlay renderer only supplies a data atlas to the official pet DOM", () => {
  const rendererBody = indexText.slice(
    indexText.indexOf("async start(api)"),
    indexText.indexOf("stop()"),
  );
  assert.ok(indexText.includes("function applyRendererSpritesheet"));
  assert.ok(rendererBody.includes("const rendererSpritesheet = await resolveRendererSpritesheet(api);"));
  assert.ok(rendererBody.includes("applyRendererSpritesheet(rendererSpritesheet, api);"));
  assert.ok(indexText.includes('sprite.style.backgroundImage = "url(" + JSON.stringify(src) + ")";'));
  assert.ok(indexText.includes('const assetSource = src.startsWith("data:") ? "renderer-data-url" : "renderer-url";'));
  assert.doesNotMatch(rendererBody, /createPet\(/);
  assert.doesNotMatch(rendererBody, /root\.style\.transform = petCenterTransform/);
});

test("renderer atlas bridge keeps watching official DOM rebuilds", () => {
  const bridgeBody = indexText.slice(
    indexText.indexOf("function applyRendererSpritesheet"),
    indexText.indexOf("function isLikelyNativeAvatarArtifact"),
  );
  assert.ok(bridgeBody.includes("let appliedSprite = null;"));
  assert.ok(bridgeBody.includes("const alreadyApplied = appliedSprite === sprite && existingBackground.includes(\"data:\");"));
  assert.ok(bridgeBody.includes("observer.observe(document.documentElement, { childList: true, subtree: true });"));
  assert.ok(bridgeBody.includes("const timer = window.setInterval(apply, 750);"));
  assert.doesNotMatch(bridgeBody, /if \(apply\(\)\) return \(\) => \{\};/);
  assert.doesNotMatch(bridgeBody, /observer\.disconnect\(\);\s*\}\s*, 250\)/);
});

test("main process window crawl bridge is present", () => {
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.scope, "both");
  assert.ok(manifest.permissions.includes("codex.windows"));
  assert.ok(indexText.includes("startMain"));
  assert.ok(indexText.includes("tarantula-window-move"));
  assert.ok(indexText.includes('require("electron")'));
  assert.ok(indexText.includes("BrowserWindow.getAllWindows"));
  assert.ok(indexText.includes("setBounds"));
});

test("Codex avatar overlay is the only pet host so native pet interactions remain available", () => {
  assert.doesNotMatch(indexText, /ownedOverlayFallback/);
  assert.match(indexText, /let win = nativeOverlay;/);
  assert.ok(indexText.includes("tarantula waiting for native avatar overlay"));
});

test("Codex-registered avatar overlay request uses the official pet host", () => {
  assert.ok(indexText.includes("function requestCodexAvatarOverlay"));
  assert.ok(indexText.includes("api.codex?.createWindow"));
  assert.ok(indexText.includes('route: "/avatar-overlay"'));
  assert.ok(indexText.includes('appearance: "avatarOverlay"'));
  assert.ok(indexText.includes("codexOverlayRequestInFlight"));
  assert.ok(indexText.includes("tarantula requested Codex avatar overlay"));
});

test("Codex-registered avatar overlay request uses an initial size and receives injected pet DOM", () => {
  assert.ok(indexText.includes("function desiredPetWindowSize"));
  assert.ok(indexText.includes("requestCodexAvatarOverlay"));
  assert.ok(indexText.includes("bounds: {"));
  assert.ok(indexText.includes("width,"));
  assert.ok(indexText.includes("height,"));
  assert.ok(indexText.includes("function ensureMainInjectedPet"));
  assert.ok(indexText.includes("function updateMainInjectedPet"));
  assert.ok(indexText.includes("function evaluateInOfficialOverlay"));
  assert.ok(indexText.includes('debug.sendCommand("Runtime.evaluate"'));
  assert.ok(indexText.includes("__codexppTarantulaUpdate"));
  assert.ok(indexText.includes("isLikelyNativeAvatarArt"));
});

test("main injected DOM reports observable state instead of returning a blind true", () => {
  assert.ok(indexText.includes("tarantula main pet injection ok"));
  assert.ok(indexText.includes("hasRoot: !!root"));
  assert.ok(indexText.includes("hasSprite: !!sprite"));
  assert.ok(indexText.includes("backgroundImage: sprite ? sprite.style.backgroundImage : \"\""));
  assert.ok(indexText.includes("backgroundSize: sprite ? getComputedStyle(sprite).backgroundSize : \"\""));
  assert.ok(indexText.includes("backgroundPosition: sprite ? getComputedStyle(sprite).backgroundPosition : \"\""));
  assert.ok(indexText.includes("rootTransform: root.style.transform"));
  assert.ok(indexText.includes("preservedTextCount"));
  assert.ok(indexText.includes("preservedInteractiveCount"));
  assert.ok(indexText.includes("hiddenCount"));
  assert.doesNotMatch(indexText, /window\.__codexppTarantulaUpdate\(\{ size: \$\{initialSize\}, enabled: \$\{config\.enabled !== false\} \}\);\s*true;/);
});

test("periodic main reinjection does not reset the crawl frame to idle", () => {
  const installBody = indexText.slice(
    indexText.indexOf("function mainPetInstallScript"),
    indexText.indexOf("function timeoutPromise"),
  );
  const guardIndex = installBody.indexOf("if (createdRoot) {");
  const initialUpdateIndex = installBody.indexOf("window.__codexppTarantulaUpdate({ size:");
  assert.ok(installBody.includes("let createdRoot = false;"));
  assert.ok(guardIndex > 0);
  assert.ok(initialUpdateIndex > guardIndex);
  assert.ok(initialUpdateIndex - guardIndex < 80);
});

test("main injection keeps the script small and preserves renderer-loaded data atlas", () => {
  assert.ok(indexText.includes("pathToFileURL"));
  assert.doesNotMatch(indexText, /readFileSync\(file\)\.toString\("base64"\)/);
  assert.doesNotMatch(indexText, /data:image\/png;base64/);
  assert.ok(indexText.includes("existingBackground"));
  assert.ok(indexText.includes("data:"));
  assert.ok(indexText.includes('reason: "missing-body"'));
});

test("duplicate official avatar overlays are collapsed instead of requesting more windows", () => {
  assert.ok(indexText.includes("function findAvatarOverlayWindows"));
  assert.ok(indexText.includes("function closeExtraAvatarOverlayWindows"));
  assert.ok(indexText.includes("tarantula closing duplicate avatar overlay"));
  assert.ok(indexText.includes("hasPotentialAvatarOverlayWindow"));
});

test("official overlay injection is bounded and debugger sessions are cleaned up", () => {
  assert.ok(indexText.includes("function timeoutPromise"));
  assert.ok(indexText.includes("tarantula main pet injection"));
  assert.ok(indexText.includes("timed out after"));
  assert.ok(indexText.includes("function detachOfficialOverlayDebuggers"));
  assert.ok(indexText.includes("webContents.debugger.detach()"));
});

test("native overlay pet art is hidden narrowly while official status text and controls stay visible", () => {
  assert.ok(indexText.includes('element.style.opacity = "0"'));
  assert.ok(indexText.includes("previous.opacity"));
  assert.ok(indexText.includes("if (text.length > 0) return false;"));
  const rendererHideBody = indexText.slice(
    indexText.indexOf("function isLikelyNativeAvatarArtifact"),
    indexText.indexOf("function hideNativeAvatarArtifacts"),
  );
  const mainHideBody = indexText.slice(
    indexText.indexOf("const isLikelyNativeAvatarArt ="),
    indexText.indexOf("let style = document.getElementById(STYLE_ID);", indexText.indexOf("const isLikelyNativeAvatarArt =")),
  );
  assert.ok(rendererHideBody.indexOf('element.classList.contains("codex-avatar-root")') < rendererHideBody.indexOf("rect.width < 72"));
  assert.ok(mainHideBody.indexOf('element.classList.contains("codex-avatar-root")') < mainHideBody.indexOf("rect.width < 72"));
  assert.ok(indexText.includes("z-index: 20;"));
  assert.doesNotMatch(indexText, /z-index:\s*2147483000/);
  assert.ok(indexText.includes("preservedTextCount"));
  assert.ok(indexText.includes("preservedInteractiveCount"));
  assert.doesNotMatch(indexText, /body > \*:not\(#codexpp-tarantula-pet\)/);
  assert.doesNotMatch(indexText, /data-codexpp-tarantula-hidden-page/);
  assert.doesNotMatch(indexText, /element\.style\.pointerEvents = "none";/);
});

test("pet dimensions are explicit pixels, not unsupported calc multiplication", () => {
  assert.ok(indexText.includes("--tarantula-width"));
  assert.ok(indexText.includes("root.style.width"));
  assert.ok(indexText.includes("root.style.height"));
  assert.doesNotMatch(indexText, /calc\(var\(--tarantula-size[^)]*\*/);
});

test("plugin-owned overlay host code is absent", () => {
  assert.doesNotMatch(indexText, /function createTarantulaOverlayWindow/);
  assert.doesNotMatch(indexText, /function findPluginOwnedOverlayWindow/);
  assert.doesNotMatch(indexText, /codexppTarantula=1/);
  assert.doesNotMatch(indexText, /tarantula owned overlay created/);
  assert.doesNotMatch(indexText, /OWNED_OVERLAY_FALLBACK_DELAY_MS/);
});

test("settings register in the normal renderer before avatar overlay DOM injection is skipped", () => {
  assert.ok(indexText.includes("function registerSettings"));
  const startBody = indexText.slice(indexText.indexOf("async start(api)"));
  const registerIndex = startBody.indexOf("const settingsHandle = registerSettings(api, config");
  const overlaySkipIndex = startBody.indexOf("if (!isAvatarOverlayWindow())");
  assert.ok(registerIndex > 0);
  assert.ok(overlaySkipIndex > 0);
  assert.ok(registerIndex < overlaySkipIndex);
  assert.ok(indexText.includes("settingsHandle?.unregister?.()"));
});

test("settings changes broadcast config to avatar overlay renderers", () => {
  assert.ok(indexText.includes("function broadcastConfig"));
  assert.ok(indexText.includes('api.ipc.send("tarantula-config-changed"'));
  assert.ok(indexText.includes('api.ipc.on("tarantula-config-changed"'));
  assert.ok(indexText.includes("Object.assign(config, payload);"));
});

test("window lookup never treats arbitrary small Codex windows as avatar overlays", () => {
  assert.match(indexText, /function findAvatarOverlayWindow\(BrowserWindow\)/);
  assert.ok(indexText.includes("initialRoute=%2Favatar-overlay"));
  assert.doesNotMatch(indexText, /bounds\.width <= 540 && bounds\.height <= 540/);
});

test("main process is the only owner of screen position", () => {
  assert.doesNotMatch(indexText, /const WINDOW_[WH]\s*=/);
  assert.doesNotMatch(indexText, /function updateMotion/);
  assert.doesNotMatch(indexText, /function chooseBehavior/);
  assert.match(indexText, /function updateMainWindowMotion\(state, dt, screenApi, bounds\)/);
  assert.match(indexText, /state\.gait = advanceGait\(state\.gait, state\.mode, state\.speed, distance, dt\);/);
});

test("cross-screen homing uses a continuous union work area instead of current-display clamping", () => {
  assert.ok(indexText.includes("function unionWorkArea"));
  assert.ok(indexText.includes("const motionArea = sameDisplay ? currentArea : unionWorkArea(currentArea, cursorArea);"));
  assert.ok(indexText.includes("clampCenterToArea("));
  assert.doesNotMatch(indexText, /state\.x = clamp\(state\.x \+ state\.vx \* dt, currentArea\.x/);
  assert.doesNotMatch(indexText, /state\.y = clamp\(state\.y \+ state\.vy \* dt, currentArea\.y/);
});

test("sprite atlas frames are cropped by display-frame pixels, not atlas percentages", () => {
  const size = 132;
  const width = size * (192 / 208);
  assert.equal(frameBackgroundSize(width, size), "974.769px 1188px");
  assert.equal(backgroundPosition(0, 0, width, size), "0px 0px");
  assert.equal(backgroundPosition(7, 8, width, size), "-852.923px -1056px");
  assert.equal(backgroundPosition(3, 4, width, size), "-365.538px -528px");
  assert.ok(indexText.includes("function frameBackgroundSize"));
  assert.ok(indexText.includes("sprite.style.backgroundSize = frameBackgroundSize(state.width, state.size);"));
  assert.ok(indexText.includes("backgroundSize: frameBackgroundSize(frameWidth, size)"));
  assert.doesNotMatch(indexText, /\$\{FRAME_COLUMNS \* 100\}%/);
  assert.doesNotMatch(indexText, /background:\s*transparent no-repeat 0 0 \//);
});

test("official avatar overlay centers the complete pet without stacking CSS centering transforms", () => {
  const size = 132;
  const width = size * (192 / 208);
  assert.equal(petCenterTransform(356, 320, width, size), "translate3d(117.077px, 94px, 0)");
  assert.ok(indexText.includes("function petCenterTransform"));
  assert.ok(indexText.includes("root.style.left = \"0px\";"));
  assert.ok(indexText.includes("root.style.top = \"0px\";"));
  assert.ok(indexText.includes("root.style.transform = petCenterTransform(window.innerWidth, window.innerHeight, state.width, state.size);"));
  assert.ok(indexText.includes("root.style.transform = \"translate3d(\" + ((window.innerWidth - width) / 2).toFixed(3) + \"px, \" + ((window.innerHeight - size) / 2).toFixed(3) + \"px, 0)\";"));
  assert.doesNotMatch(indexText, /left:\s*50%;/);
  assert.doesNotMatch(indexText, /top:\s*50%;/);
  assert.doesNotMatch(indexText, /translate3d\(-50%, -50%, 0\)/);
});

test("main process preserves manual official avatar overlay resizing", () => {
  assert.ok(indexText.includes("function petSizeFromWindowBounds"));
  assert.ok(indexText.includes("const petSize = petSizeFromWindowBounds(currentBounds, config);"));
  assert.ok(indexText.includes("const size = petSize?.size || Number(config.size) || DEFAULT_CONFIG.size;"));
  assert.ok(indexText.includes("const frameWidth = petSize?.frameWidth || size * (CELL_W / CELL_H);"));
  assert.ok(indexText.includes("updateMainInjectedPet(win, state, config, petSize);"));
  assert.ok(indexText.includes("width: currentBounds.width"));
  assert.ok(indexText.includes("height: currentBounds.height"));
  assert.doesNotMatch(indexText, /const desiredSize = desiredPetWindowSize\(config\);\s*const currentBounds/s);
  assert.doesNotMatch(indexText, /width:\s*desiredSize\.width,\s*height:\s*desiredSize\.height/s);
});

test("main motion pauses while the official overlay is being resized", () => {
  assert.ok(indexText.includes("let resizeHoldUntil = 0;"));
  assert.ok(indexText.includes("const userResized = lastBounds && windowSizeChanged(lastBounds, currentBounds);"));
  assert.ok(indexText.includes("resizeHoldUntil = now + 450;"));
  assert.ok(indexText.includes("Object.assign(state, windowCenter(currentBounds), { vx: 0, vy: 0, speed: 0 });"));
  assert.ok(indexText.includes("const resizeHeld = now < resizeHoldUntil;"));
  assert.ok(indexText.includes("if (!resizeHeld) updateMainWindowMotion(state, dt, screen, bounds);"));
  assert.ok(indexText.includes("if (!resizeHeld && ("));
  assert.ok(indexText.includes("lastBounds = win.getBounds();"));
});
