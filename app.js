// =====================================================================
// STÍNADLA — přihlášení týmu heslem + postupná stanoviště
//
// Každý tým má POSLOUPNOST bodů (points[]). Plní je popořadě:
//  - všechna stanoviště kromě posledního = NEOMEZENÉ pokusy
//  - poslední (finální) stanoviště = max 3 pokusy
// =====================================================================
import {
  db, ensureAuth, configIsFilled,
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp,
  storage, storageRef, uploadBytes, getDownloadURL,
} from "./db.js";

// --- localStorage klíče (jen ZÁLOHA, zdroj pravdy je Firestore) -------
const LS_GAME = "stinadla.gameId";
const LS_TEAM = "stinadla.teamId";

const MAX_FINAL_ATTEMPTS = 3;   // pokusy na POSLEDNÍM stanovišti
const DEFAULT_RADIUS_M = 25;
const HELP_PENALTY_MIN = 5;     // SOS nápověda: +5 min k času
const PHOTO_BONUS_MIN = 2;      // fotka ze stanoviště: −2 min
const CIPHER_BONUS_MIN = 5;     // vyřešená šifra: −5 min

// Parsování ručně vložených souřadnic.
// Přijme desetinné "lat, lng", DMS "49°11.752'N 16°36.127'E"
// i odkaz z Google Maps (@lat,lng nebo q=lat,lng).
function parseCoords(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // 1) Google Maps odkaz: @lat,lng
  let m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2] };
  // q= / query= / ll= / destination=
  m = s.match(/[?&](?:q|query|ll|destination|sll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2] };

  // 2) DMS: stupně + desetinné minuty (+ volitelné vteřiny) + N/S/E/W
  const dmsRe = /(\d+)\s*[°:\s]\s*(\d+(?:\.\d+)?)\s*['′:\s]*\s*(?:(\d+(?:\.\d+)?)\s*["″])?\s*([NSEWnsew])/g;
  const found = [...s.matchAll(dmsRe)];
  if (found.length >= 2) {
    const conv = (p) => {
      let v = parseFloat(p[1]) + parseFloat(p[2]) / 60 + (p[3] ? parseFloat(p[3]) / 3600 : 0);
      const h = p[4].toUpperCase();
      if (h === "S" || h === "W") v = -v;
      return { v, h };
    };
    const a = conv(found[0]), b = conv(found[1]);
    const isLat = (h) => h === "N" || h === "S";
    const lat = isLat(a.h) ? a.v : b.v;
    const lng = isLat(a.h) ? b.v : a.v;
    return { lat, lng };
  }

  // 3) desetinné stupně s hemisférou: "49.1991635N, 16.5911653E"
  //    (formát Mapy.cz) — i s prefixem "N49.199, E16.591"
  let toks = [...s.matchAll(/(\d+(?:\.\d+)?)\s*°?\s*([NSEWnsew])(?![A-Za-z0-9])/g)]
    .map((p) => ({ v: parseFloat(p[1]), h: p[2].toUpperCase() }));
  if (toks.length < 2) {
    toks = [...s.matchAll(/\b([NSEWnsew])\s*°?\s*(\d+(?:\.\d+)?)/g)]
      .map((p) => ({ v: parseFloat(p[2]), h: p[1].toUpperCase() }));
  }
  if (toks.length >= 2) {
    let lat = null, lng = null;
    for (const t of toks) {
      if (t.h === "N") lat = t.v;
      else if (t.h === "S") lat = -t.v;
      else if (t.h === "E") lng = t.v;
      else if (t.h === "W") lng = -t.v;
    }
    if (lat != null && lng != null &&
        Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }

  // 4) desetinná dvojice "lat, lng" nebo "lat lng"
  m = s.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const lat = +m[1], lng = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

// Vzdálenost dvou bodů na Zemi v metrech (haversine).
function distanceM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat), lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Azimut (0–360°, 0 = sever) z bodu A do bodu B.
function bearingDeg(aLat, aLng, bLat, bLng) {
  const toRad = (d) => d * Math.PI / 180, toDeg = (r) => r * 180 / Math.PI;
  const f1 = toRad(aLat), f2 = toRad(bLat), dl = toRad(bLng - aLng);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
// 16-bodová růžice (S = sever, V = východ…)
const DIRS = ["S","SSV","SV","VSV","V","VJV","JV","JJV","J","JJZ","JZ","ZJZ","Z","ZSZ","SZ","SSZ"];
const DIRS_FULL = ["na sever","na severo-severovýchod","na severovýchod","na východo-severovýchod",
  "na východ","na východo-jihovýchod","na jihovýchod","na jiho-jihovýchod",
  "na jih","na jiho-jihozápad","na jihozápad","na západo-jihozápad",
  "na západ","na západo-severozápad","na severozápad","na severo-severozápad"];
const compassDir = (deg) => DIRS[Math.round(deg / 22.5) % 16];
const compassDirFull = (deg) => DIRS_FULL[Math.round(deg / 22.5) % 16];

// Magnetická deklinace v ČR (~5° východně, 2026). Střelka buzoly ukazuje
// k magnetickému severu — šipku i stupně proto posouváme, aby seděly
// při srovnání střelky se severem na displeji.
const DECLINATION_DEG = 5;
const toMagnetic = (trueDeg) => ((trueDeg - DECLINATION_DEG) % 360 + 360) % 360;
// Směr "podle hodin" (sever = 12 hodin) — pro buzoly bez stupnice.
function clockDir(deg) {
  const h = Math.round(deg / 30) % 12;
  return h === 0 ? 12 : h;
}

// --- stav -------------------------------------------------------------
let state = {
  gameId: null,
  gameTitle: "Stínadla",
  teamId: null,
  team: null,
  lastCapture: null,          // poslední nahraná poloha
  photosByPoint: new Set(),   // na kterých stanovištích už je fotka
};

// --- DOM pomocné ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
function flash(slotId, type, html) { $(slotId).innerHTML = `<div class="flash ${type}">${html}</div>`; }
function clearFlash(slotId) { $(slotId).innerHTML = ""; }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Normalizace odpovědí/šifer: velká písmena, bez mezer a diakritiky.
const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .trim().toUpperCase().replace(/\s+/g, "");

// Posměšné "haha" hlášky, když je tým daleko ---------------------------
const HAHA = [
  "Haha! Tady ještě Vontové nevládnou.",
  "Haha! Ježek je pořád daleko v kleci.",
  "Haha! Stínadla jsou jinde, nováčku.",
  "Haha! Široko by ti ukázal správnou uličku.",
  "Haha! Ještě kus cesty dlážděnými ulicemi.",
];

// =====================================================================
// Body a postup týmu
// =====================================================================
// Vrátí pole bodů týmu; zpětně kompatibilní se starým jedno-bodovým
// polem `target`.
function teamPoints(t) {
  if (Array.isArray(t?.points) && t.points.length &&
      typeof t.points[0]?.lat === "number") return t.points;
  if (t?.target && typeof t.target.lat === "number") return [t.target];
  return [];
}

// Kronika a šifry (pole paralelní s points; starší týmy je nemají).
const teamStory = (t) => Array.isArray(t?.story) ? t.story : [];
const teamCiphers = (t) => Array.isArray(t?.ciphers) ? t.ciphers : [];
const cipherIsSolved = (t, i) => !!(t?.cipherSolved && t.cipherSolved[i]);

// Kompletní stav postupu týmu.
function teamProgress(t) {
  const points = teamPoints(t);
  const idx = Math.min(t?.currentPointIndex ?? 0, points.length);
  const finished = t?.finished === true || t?.arrived === true ||
                   (points.length > 0 && idx >= points.length);
  const isLast = !finished && points.length > 0 && idx === points.length - 1;
  const attemptsUsed = t?.finalAttemptsUsed ?? 0;
  const locked = !finished && isLast && attemptsUsed >= MAX_FINAL_ATTEMPTS;
  return { points, idx, finished, isLast, attemptsUsed, locked };
}

// =====================================================================
// START
// =====================================================================
async function init() {
  if (!configIsFilled()) {
    $("config-warn-slot").innerHTML = `<div class="config-warn">
      ⚠️ <strong>Firebase není nastaven.</strong> Doplň <code>firebase.js</code>.</div>`;
  }
  // NIC neblokuje UI: formulář funguje okamžitě
  wireEvents();
  state.gameId = "stinadla";        // pevné id — není třeba čekat na síť
  ensureAuth();                     // volitelné, na pozadí (otevřená pravidla)
  loadGame().catch(console.warn);   // jen titulek hry, na pozadí
  tryRestore();                     // obnova přihlášení hned
}

function wireEvents() {
  $("btn-login").addEventListener("click", onLogin);
  $("team-pwd").addEventListener("keydown", (e) => { if (e.key === "Enter") onLogin(); });
  $("btn-capture").addEventListener("click", onCapture);
  $("coords-input").addEventListener("keydown", (e) => { if (e.key === "Enter") onCapture(); });
  $("btn-logout").addEventListener("click", logout);
  $("btn-help").addEventListener("click", onHelp);
  $("btn-sos-send").addEventListener("click", onHelpSubmit);
  $("sos-coords").addEventListener("keydown", (e) => { if (e.key === "Enter") onHelpSubmit(); });
  $("photo-input").addEventListener("change", onPhoto);
  $("btn-cipher").addEventListener("click", onCipher);
  $("cipher-answer").addEventListener("keydown", (e) => { if (e.key === "Enter") onCipher(); });
}

// --- najdi hru (přednostně pevné id "stinadla") -----------------------
async function loadGame() {
  let gameDoc = null;
  const fixed = await getDoc(doc(db, "games", "stinadla"));
  if (fixed.exists()) {
    gameDoc = { id: fixed.id, data: () => fixed.data() };
  } else {
    const snap = await getDocs(collection(db, "games"));
    if (snap.empty) {
      flash("login-msg", "bad", 'Žádná hra zatím neexistuje. Spusť <a class="back-link" href="seed.html">seed.html</a>.');
      return;
    }
    gameDoc = snap.docs.find((d) => (d.data().title || "") === "Stínadla") || snap.docs[0];
  }
  state.gameId = gameDoc.id;
  state.gameTitle = gameDoc.data().title || "Stínadla";
  localStorage.setItem(LS_GAME, state.gameId);
}

// =====================================================================
// Přihlášení týmu heslem
// =====================================================================
async function onLogin() {
  if (!state.gameId) { await loadGame(); if (!state.gameId) return; }
  const pwd = $("team-pwd").value.trim();
  if (!pwd) { flash("login-msg", "bad", "Zadej heslo týmu."); return; }

  $("btn-login").disabled = true;
  $("login-msg").innerHTML = '<div class="spinner"></div>';
  try {
    const q = query(
      collection(db, "games", state.gameId, "teams"),
      where("password", "==", pwd),
      limit(1)
    );
    const snap = await getDocs(q);
    if (snap.empty) {
      flash("login-msg", "bad", "Takové heslo žádný tým nemá. Zkus to znovu.");
      return;
    }
    const d = snap.docs[0];
    state.teamId = d.id;
    state.team = { id: d.id, ...d.data() };
    localStorage.setItem(LS_TEAM, d.id);
    clearFlash("login-msg");
    openTeam();
  } catch (e) {
    console.error(e);
    flash("login-msg", "bad", "Chyba při přihlášení. Zkontroluj připojení a Firestore Rules.");
  } finally {
    $("btn-login").disabled = false;
  }
}

function logout() {
  localStorage.removeItem(LS_TEAM);
  state.teamId = null;
  state.team = null;
  $("team-pwd").value = "";
  clearFlash("login-msg");
  clearFlash("capture-msg");
  hide("screen-team");
  show("screen-login");
}

// =====================================================================
// Tým — obrazovka se záznamem polohy
// =====================================================================
async function openTeam() {
  hide("screen-login");
  show("screen-team");
  renderTeam(); // první rychlé vykreslení
  await Promise.all([loadTrail(), loadPhotos()]);
  renderTeam(); // znovu s načtenými fotkami (foto brána)
}

// --- vykreslení kroků trasy (①—②—③) ---------------------------------
function renderSteps(p) {
  const el = $("steps");
  if (!p.points.length) { el.innerHTML = ""; return; }
  let html = "";
  p.points.forEach((_, j) => {
    const done = j < p.idx || p.finished;
    const now = !p.finished && j === p.idx;
    if (j > 0) html += `<div class="step-line ${j <= p.idx || p.finished ? "done" : ""}"></div>`;
    html += `<div class="step ${done ? "done" : now ? "now" : ""}"
              title="Stanoviště ${j + 1}${j === p.points.length - 1 ? " (finální)" : ""}">
              ${done ? "✓" : j + 1}</div>`;
  });
  el.innerHTML = html;
}

function renderTeam() {
  const t = state.team;
  $("team-name").textContent = t.name || t.id;
  $("game-title").textContent = state.gameTitle;

  const p = teamProgress(t);
  renderSteps(p);
  hide("arrived-banner");
  hide("locked-banner");
  show("geo-box");
  show("help-card");
  show("photo-card");
  $("capture-form").classList.remove("hidden");

  if (!p.points.length) {
    hide("geo-box");
    hide("help-card");
    $("capture-form").classList.add("hidden");
    flash("capture-msg", "bad", "Tento tým nemá nastavená stanoviště. Kontaktuj organizátora.");
    return;
  }

  renderKronika(p);

  if (p.finished) {
    hide("geo-box");
    hide("help-card");
    hide("cipher-card");
    $("capture-form").classList.add("hidden");
    show("arrived-banner");
    $("arrived-banner").innerHTML =
      `✓ <strong>Už jsi objevil, co bylo potřeba. Vrať se do tábora!</strong> 🏕️
       <span class="muted">(${p.points.length}/${p.points.length} stanovišť)</span>`;
    return;
  }

  if (p.locked) {
    hide("geo-box");
    hide("help-card");
    hide("cipher-card");
    $("capture-form").classList.add("hidden");
    show("locked-banner");
    $("locked-banner").innerHTML =
      `<span class="haha">Konec hry pro tento tým.</span>
       Všechny <strong>${MAX_FINAL_ATTEMPTS} pokusy</strong> na posledním stanovišti jsou pryč.
       Stínadla si svá tajemství nechávají pro sebe. Vrať se do tábora.`;
    return;
  }

  const tgt = p.points[p.idx];
  const radius = Math.round(tgt.radiusM ?? DEFAULT_RADIUS_M);
  const isSecondToLast = p.points.length >= 2 && p.idx === p.points.length - 2;
  $("point-title").textContent = `Stanoviště ${p.idx + 1} z ${p.points.length}`;

  const hasPhotoHere = state.photosByPoint.has(p.idx);
  let hint = "";

  if (isSecondToLast) {
    hint += `<div style="color:var(--blood);font-weight:700;margin-bottom:6px">
      ⚠️ Toto stanoviště smí plnit POUZE VEDOUCÍ SÁM! Pokud budou pomáhat
      děti, tým se propadá na poslední místo.</div>`;
  }
  if (p.isLast) {
    const left = MAX_FINAL_ATTEMPTS - p.attemptsUsed;
    hint += `<strong style="color:var(--gold-bright)">Poslední stanoviště!</strong>
       Vlož souřadnice do ${radius} m od cíle.
       Zbývá <strong>${left}</strong> ${left === 1 ? "pokus" : "pokusy"} — vyber moudře.`;
  } else {
    hint += `Vlož souřadnice nalezeného místa (do ${radius} m od cíle). Pokusy neomezené.`;
  }
  if (!hasPhotoHere) {
    hint += `<div style="color:var(--gold-bright);margin-top:6px">
      📸 Nejdřív nahraj fotku týmu z tohohle stanoviště — bez ní souřadnice nejdou odeslat.</div>`;
  }
  $("point-hint").innerHTML = hint;
  $("btn-capture").disabled = !hasPhotoHere;

  renderCipher(p);
}

// --- šifra aktuálního stanoviště --------------------------------------
function renderCipher(p) {
  const t = state.team;
  const c = teamCiphers(t)[p.idx];
  if (!c || !c.q) { hide("cipher-card"); return; }
  show("cipher-card");
  $("cipher-point").textContent = `${p.idx + 1}`;
  $("cipher-q").textContent = c.q;
  if (cipherIsSolved(t, p.idx)) {
    $("cipher-form").classList.add("hidden");
    flash("cipher-msg", "ok", `✓ Vyřešeno! Bonus <strong>−${CIPHER_BONUS_MIN} minut</strong> z času.`);
  } else {
    $("cipher-form").classList.remove("hidden");
    clearFlash("cipher-msg");
  }
}

async function onCipher() {
  const t = state.team;
  const p = teamProgress(t);
  const c = teamCiphers(t)[p.idx];
  if (!c || cipherIsSolved(t, p.idx)) return;
  const guess = ($("cipher-answer").value || "").trim();
  if (!guess) return;

  const ok = norm(guess) === norm(c.a);
  if (!ok) {
    flash("cipher-msg", "bad", "Špatně. Rozhlédni se po stanovišti pořádně a zkus to znovu. 🙃");
    return;
  }
  try {
    await updateDoc(doc(db, "games", state.gameId, "teams", state.teamId), {
      [`cipherSolved.${p.idx}`]: true,
      updatedAt: serverTimestamp(),
    });
    state.team.cipherSolved = { ...(t.cipherSolved || {}), [p.idx]: true };
    $("cipher-answer").value = "";
    renderCipher(p);
    confetti();
  } catch (e) {
    console.error(e);
    flash("cipher-msg", "bad", "Odpověď se nepodařilo uložit — zkontroluj připojení.");
  }
}

// --- kronika: odemčené texty stanovišť ---------------------------------
function renderKronika(p) {
  const story = teamStory(state.team);
  const unlockedTo = p.finished ? p.points.length : p.idx; // splněná stanoviště
  const items = [];
  for (let i = 0; i < unlockedTo; i++) {
    if (story[i]) items.push(
      `<div class="kronika-item"><span class="kn">Stanoviště ${i + 1}</span>${escapeHtml(story[i])}</div>`);
  }
  if (!items.length) { hide("kronika-wrap"); return; }
  show("kronika-wrap");
  $("kronika").innerHTML = items.join("");
}

// --- záznam polohy (ruční vložení souřadnic) -------------------------
async function onCapture() {
  const t = state.team;
  const p = teamProgress(t);
  if (!p.points.length || p.finished || p.locked) { renderTeam(); return; }

  // povinná fotka ze stanoviště před zadáním souřadnic
  if (!state.photosByPoint.has(p.idx)) {
    flash("capture-msg", "bad",
      `📸 Nejdřív nahrajte <strong>fotku týmu z tohohle stanoviště</strong> (níže) —
       teprve pak jde zadat souřadnice. Bonus: −${PHOTO_BONUS_MIN} min z času!`);
    return;
  }

  const raw = $("coords-input").value;
  const coords = parseCoords(raw);
  if (!coords) {
    if (/goo\.gl|maps\.app/i.test(raw)) {
      flash("capture-msg", "bad",
        `Zkrácený odkaz z mobilních Map bohužel souřadnice neobsahuje. 🙈<br>
         <strong>Udělej to takhle:</strong> podrž prst na místě v mapě (spadne špendlík)
         a nahoře se objeví souřadnice — ty zkopíruj sem
         (např. <code>49.199138, 16.591262</code>).`);
    } else {
      flash("capture-msg", "bad", "Souřadnice se nepodařilo přečíst. Zkus např. <code>49.195869, 16.602122</code>.");
    }
    return;
  }

  const tgt = p.points[p.idx];
  const radius = tgt.radiusM ?? DEFAULT_RADIUS_M;
  const dist = distanceM(coords.lat, coords.lng, tgt.lat, tgt.lng);
  const within = dist <= radius;

  $("btn-capture").disabled = true;
  $("capture-msg").innerHTML = '<div class="spinner"></div>';

  // předchozí pokus na TOMHLE stanovišti (pro přihořívá/samá voda)
  const prevDist = (state.lastCapture && (state.lastCapture.pointIndex ?? 0) === p.idx && !state.lastCapture.within)
    ? state.lastCapture.distanceM : null;

  try {
    const teamRef = doc(db, "games", state.gameId, "teams", state.teamId);

    // 1) zapiš bod do stopy (captures)
    await addDoc(collection(teamRef, "captures"), {
      lat: coords.lat, lng: coords.lng,
      source: "manual",
      pointIndex: p.idx,
      distanceM: Math.round(dist),
      within,
      createdAt: serverTimestamp(),
    });

    // 2) aktualizuj tým
    const update = {
      captureCount: (t.captureCount ?? 0) + 1,
      updatedAt: serverTimestamp(),
    };
    if (!t.startedAt) update.startedAt = serverTimestamp(); // start časomíry
    if (within) {
      const nextIdx = p.idx + 1;
      update.currentPointIndex = nextIdx;
      update.bestDistanceM = null; // nové stanoviště, nová "nejblíž"
      if (nextIdx >= p.points.length) {
        update.finished = true;
        update.finishedAt = serverTimestamp();
      }
    } else {
      const prevBest = t.bestDistanceM;
      update.bestDistanceM = prevBest == null
        ? Math.round(dist) : Math.min(prevBest, Math.round(dist));
      if (p.isLast) update.finalAttemptsUsed = p.attemptsUsed + 1;
    }
    await updateDoc(teamRef, update);

    // 3) obnov stav z Firestore
    const fresh = await getDoc(teamRef);
    state.team = { id: fresh.id, ...fresh.data() };

    renderTeam();
    await loadTrail();
    clearFlash("help-msg"); // nová poloha → stará nápověda už neplatí

    const distR = Math.round(dist);
    if (within) {
      $("coords-input").value = "";
      const story = teamStory(state.team)[p.idx];
      const storyHtml = story
        ? `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed rgba(217,164,65,0.3)">
             📜 <em>${escapeHtml(story)}</em></div>` : "";
      if (update.finished) {
        flash("capture-msg", "ok",
          `<span class="haha" style="color:var(--green)">Už jsi objevil, co bylo potřeba.</span>
           Vrať se do tábora! 🏕️ <span class="muted">(${distR} m od cíle)</span>${storyHtml}`);
        confetti();
      } else {
        flash("capture-msg", "ok",
          `✓ <strong>Stanoviště ${p.idx + 1} objeveno!</strong> (${distR} m od cíle)<br>
           Pokračuj na stanoviště ${p.idx + 2} z ${p.points.length}.${storyHtml}`);
        confetti();
      }
    } else {
      // přihořívá / samá voda — srovnání s minulým pokusem na tomto stanovišti
      let teplota = "";
      if (prevDist != null) {
        const diff = prevDist - distR;
        if (diff > 5) teplota = `<div style="color:var(--gold-bright);margin-top:6px">🔥 <strong>Přihořívá!</strong> O ${diff} m blíž než minule.</div>`;
        else if (diff < -5) teplota = `<div style="color:#9fc6e8;margin-top:6px">🧊 <strong>Samá voda…</strong> O ${-diff} m dál než minule!</div>`;
        else teplota = `<div class="muted" style="margin-top:6px">😐 Zhruba stejně daleko jako minule.</div>`;
      }
      // přesný směr z místa, které tým právě zadal, k cíli (na buzolu)
      const magB = Math.round(toMagnetic(bearingDeg(coords.lat, coords.lng, tgt.lat, tgt.lng)));
      const smer = `Od zadaného místa je cíl <strong>${distR} m</strong> daleko,
        azimut <strong>${magB}°</strong> ${compassDir(magB)} <span class="muted">(na buzolu)</span>.`;
      const haha = HAHA[(t.captureCount ?? 0) % HAHA.length];
      if (p.isLast) {
        const left = MAX_FINAL_ATTEMPTS - (p.attemptsUsed + 1);
        flash("capture-msg", "bad",
          left > 0
            ? `<span class="haha">${haha}</span>
               ${smer}${teplota}
               <div style="margin-top:6px">Na poslední stanoviště ${left === 1 ? "zbývá poslední pokus" : `zbývají ${left} pokusy`}!</div>`
            : `<span class="haha">A to byl poslední pokus.</span>
               Tato poloha byla <strong>${distR} m</strong> od cíle. Vrať se do tábora.`);
      } else {
        flash("capture-msg", "bad",
          `<span class="haha">${haha}</span>
           ${smer}${teplota}`);
      }
    }
  } catch (e) {
    console.error(e);
    flash("capture-msg", "bad", "Záznam se nepodařilo uložit. Zkontroluj připojení / Firestore Rules.");
  } finally {
    // znovu povolit jen pokud je na aktuálním stanovišti fotka a hra běží
    const pp = teamProgress(state.team);
    $("btn-capture").disabled = pp.finished || pp.locked || !state.photosByPoint.has(pp.idx);
  }
}

// --- načti stopu (captures) tohoto týmu ------------------------------
async function loadTrail() {
  try {
    const snap = await getDocs(query(
      collection(db, "games", state.gameId, "teams", state.teamId, "captures"),
      orderBy("createdAt", "desc")
    ));
    if (snap.empty) {
      state.lastCapture = null;
      $("trail").innerHTML = '<p class="muted">Zatím žádný záznam. Stínadla čekají…</p>';
      return;
    }
    state.lastCapture = snap.docs[0].data(); // desc → první = nejnovější
    let html = "";
    snap.docs.forEach((d) => {
      const x = d.data();
      const t = x.createdAt?.toDate ? x.createdAt.toDate() : null;
      const time = t ? t.toLocaleString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
      const cls = x.within ? "a-ok" : "a-bad";
      const point = `S${(x.pointIndex ?? 0) + 1}`;
      const mark = x.source === "sos"
        ? `${point}: 🆘 SOS (${x.distanceM} m od cíle)`
        : x.within ? `${point}: ✓ objeveno` : `${point}: ${x.distanceM} m daleko`;
      html += `<div class="trail-row">
        <span class="${cls}">${mark}</span>
        <span class="muted">${time}</span>
      </div>`;
    });
    $("trail").innerHTML = html;
  } catch (e) {
    console.warn(e);
    $("trail").innerHTML = '<p class="muted">Stopu se nepodařilo načíst.</p>';
  }
}

// =====================================================================
// 🆘 SOS nápověda — vzdálenost + azimut k dalšímu stanovišti
// =====================================================================
// Klik na „Poradit směr" → otevře formulář pro AKTUÁLNÍ polohu týmu.
function onHelp() {
  const t = state.team;
  const p = teamProgress(t);
  if (!p.points.length || p.finished || p.locked) { clearFlash("help-msg"); return; }
  $("sos-form").classList.toggle("hidden");
  clearFlash("help-msg");
  if (!$("sos-form").classList.contains("hidden")) $("sos-coords").focus();
}

// Odeslání SOS: uloží polohu týmu (vidí ji admin na mapě), přičte +5 min
// a ukáže přesný azimut + vzdálenost z TÉTO polohy.
async function onHelpSubmit() {
  const t = state.team;
  const p = teamProgress(t);
  if (!p.points.length || p.finished || p.locked) { renderTeam(); return; }

  const raw = $("sos-coords").value;
  const coords = parseCoords(raw);
  if (!coords) {
    flash("help-msg", "bad",
      /goo\.gl|maps\.app/i.test(raw)
        ? `Zkrácený odkaz souřadnice neobsahuje — podrž prst na místě v mapě a zkopíruj souřadnice.`
        : `Souřadnice se nepodařilo přečíst. Zkus např. <code>49.195869, 16.602122</code>.`);
    return;
  }

  const tgt = p.points[p.idx];
  const dist = Math.round(distanceM(coords.lat, coords.lng, tgt.lat, tgt.lng));
  $("btn-sos-send").disabled = true;
  $("help-msg").innerHTML = '<div class="spinner"></div>';

  try {
    const teamRef = doc(db, "games", state.gameId, "teams", state.teamId);
    // 1) ulož SOS polohu do stopy (admin ji vidí na mapě jako 🆘)
    await addDoc(collection(teamRef, "captures"), {
      lat: coords.lat, lng: coords.lng,
      source: "sos",
      pointIndex: p.idx,
      distanceM: dist,
      within: false, // SOS není pokus o check-in
      createdAt: serverTimestamp(),
    });
    // 2) penalizace +5 min + trigger živého adminu
    const update = {
      helpCount: (t.helpCount ?? 0) + 1,
      captureCount: (t.captureCount ?? 0) + 1,
      updatedAt: serverTimestamp(),
    };
    if (!t.startedAt) update.startedAt = serverTimestamp();
    await updateDoc(teamRef, update);
    state.team.helpCount = (t.helpCount ?? 0) + 1;
    state.team.captureCount = (t.captureCount ?? 0) + 1;

    $("sos-coords").value = "";
    $("sos-form").classList.add("hidden");
    await loadTrail();
    showHelpCompass(coords, tgt, dist, p);
  } catch (e) {
    console.error(e);
    flash("help-msg", "bad", "SOS se nepodařilo odeslat. Zkontroluj připojení.");
  } finally {
    $("btn-sos-send").disabled = false;
  }
}

function showHelpCompass(from, tgt, dist, p) {
  const trueDeg = bearingDeg(from.lat, from.lng, tgt.lat, tgt.lng);
  const magDeg = Math.round(toMagnetic(trueDeg)); // pro srovnání se střelkou
  const km = dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : dist + " m";
  const radius = tgt.radiusM ?? DEFAULT_RADIUS_M;
  const closeNote = dist <= radius
    ? `<div class="flash ok" style="margin-top:10px">🎯 Podle odeslané polohy jste
       <strong>přímo u cíle</strong> (${dist} m)! Nahrajte fotku a zadejte souřadnice
       přes „Ověřit a uložit polohu".</div>` : "";

  $("help-msg").innerHTML = `
    <div class="compass-wrap">
      <div class="compass-dial big">
        <span class="cd cd-n">S</span><span class="cd cd-e">V</span>
        <span class="cd cd-s">J</span><span class="cd cd-w">Z</span>
        <svg class="compass-needle" style="transform:rotate(${magDeg}deg)"
             width="64" height="64" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 1.5 L16 19 L12 15.5 L8 19 Z" fill="#f4c35a" stroke="#d9a441" stroke-width="0.6"/>
          <circle cx="12" cy="12" r="1.6" fill="#0a0c12" stroke="#d9a441" stroke-width="0.8"/>
        </svg>
      </div>
      <div class="compass-info">
        <div class="deg">${compassDirFull(magDeg)}</div>
        <div>Vzdušnou čarou <strong>${km}</strong> k stanovišti ${p.idx + 1}.</div>
      </div>
    </div>
    <ol class="help-steps">
      <li>Polož <strong>buzolu vedle telefonu</strong>.</li>
      <li>Otáčej se i s telefonem, dokud <strong>střelka buzoly nemíří stejně
          jako S na ciferníku</strong> (nahoru na displeji).</li>
      <li>Vyraz <strong>ve směru zlaté šipky</strong>. Je to zhruba směr
          „na ${clockDir(magDeg)} ${(h => h === 1 ? "hodinu" : h >= 2 && h <= 4 ? "hodiny" : "hodin")(clockDir(magDeg))}" (sever = 12).</li>
    </ol>
    <p class="muted" style="font-size:0.78rem;margin:8px 0 0">
      Máš-li na buzole stupnici: azimut <strong>${magDeg}°</strong>
      (už přepočtený pro střelku). Počítáno z právě odeslané polohy —
      po přesunu pošli novou (další +${HELP_PENALTY_MIN} min).
    </p>${closeNote}`;
}

// =====================================================================
// 📸 Fotka z místa (Firebase Storage)
// =====================================================================
// Zmenší fotku (max 1600 px, JPEG) — šetří mobilní data i úložiště.
async function compressImage(file, maxDim = 1600, quality = 0.82) {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch (e) {
    console.warn("komprese selhala, nahrávám originál", e);
    return file;
  }
}

async function onPhoto(e) {
  const file = e.target.files?.[0];
  e.target.value = ""; // ať jde vybrat stejný soubor znovu
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    flash("photo-msg", "bad", "Tohle není obrázek. Zkus fotku. 📷");
    return;
  }
  const t = state.team;
  const p = teamProgress(t);

  $("photo-msg").innerHTML = '<div class="spinner"></div><p class="muted center">Nahrávám fotku do Stínadel…</p>';
  try {
    const blob = await compressImage(file);
    const name = `photos/${state.gameId}/${state.teamId}/${Date.now()}.jpg`;
    const ref = storageRef(storage, name);
    await uploadBytes(ref, blob, { contentType: "image/jpeg" });
    const url = await getDownloadURL(ref);

    const photoIdx = Math.min(p.idx, Math.max(p.points.length - 1, 0));
    // metadata do Firestore
    await addDoc(collection(db, "games", state.gameId, "teams", state.teamId, "photos"), {
      url,
      path: name,
      pointIndex: photoIdx,
      createdAt: serverTimestamp(),
    });
    // photoCount na týmu (bonus −2 min/stanoviště + trigger živého adminu)
    const firstHere = !state.photosByPoint.has(photoIdx);
    try {
      await updateDoc(doc(db, "games", state.gameId, "teams", state.teamId), {
        photoCount: (t.photoCount ?? 0) + 1,
        updatedAt: serverTimestamp(),
      });
      state.team.photoCount = (t.photoCount ?? 0) + 1;
    } catch (e) { console.warn(e); }

    state.photosByPoint.add(photoIdx);
    flash("photo-msg", "ok",
      firstHere
        ? `✓ Fotka uložena — <strong>−${PHOTO_BONUS_MIN} min</strong> z času! Teď můžete zadat souřadnice. 🐾`
        : "✓ Fotka uložena. Kronikář Bratrstva ji už zkoumá. 🐾");
    await loadPhotos();
    renderTeam(); // odemkne tlačítko souřadnic
  } catch (err) {
    console.error(err);
    flash("photo-msg", "bad",
      `Fotku se nepodařilo nahrát. Zkontroluj připojení — a organizátor musí mít
       ve Firebase otevřená <strong>Storage Rules</strong> (viz README).`);
  }
}

async function loadPhotos() {
  try {
    const snap = await getDocs(query(
      collection(db, "games", state.gameId, "teams", state.teamId, "photos"),
      orderBy("createdAt", "desc")
    ));
    state.photosByPoint = new Set(snap.docs.map((d) => d.data().pointIndex ?? 0));
    if (snap.empty) { $("photos").innerHTML = ""; return; }
    $("photos").innerHTML = snap.docs.map((d) => {
      const x = d.data();
      return `<a href="${x.url}" target="_blank" rel="noopener">
        <img src="${x.url}" alt="fotka týmu" loading="lazy" />
        <span class="ptag">S${(x.pointIndex ?? 0) + 1}</span>
      </a>`;
    }).join("");
  } catch (e) {
    console.warn("fotky se nenačetly", e);
  }
}

// =====================================================================
// Obnova přihlášení ze zálohy
// =====================================================================
async function tryRestore() {
  const teamId = localStorage.getItem(LS_TEAM);
  if (!teamId || !state.gameId) return;
  try {
    const snap = await getDoc(doc(db, "games", state.gameId, "teams", teamId));
    if (!snap.exists()) { localStorage.removeItem(LS_TEAM); return; }
    state.teamId = teamId;
    state.team = { id: snap.id, ...snap.data() };
    openTeam();
  } catch (e) { console.warn("restore failed", e); }
}

// --- konfety ----------------------------------------------------------
function confetti() {
  const colors = ["#d9a441", "#f4c35a", "#5fae6b", "#b23a35", "#e8e2d0"];
  for (let i = 0; i < 70; i++) {
    const s = document.createElement("div");
    s.className = "spark";
    s.style.left = ((i * 53) % 100) + "vw";
    s.style.background = colors[i % colors.length];
    const dur = 2.4 + ((i * 37) % 18) / 10;
    const delay = ((i * 17) % 12) / 10;
    s.style.animationDuration = dur + "s";
    s.style.animationDelay = delay + "s";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), (dur + delay) * 1000 + 200);
  }
}

init();
