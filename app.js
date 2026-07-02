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

  // 3) desetinná dvojice "lat, lng" nebo "lat lng"
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
const compassDir = (deg) => DIRS[Math.round(deg / 22.5) % 16];

// --- stav -------------------------------------------------------------
let state = {
  gameId: null,
  gameTitle: "Stínadla",
  teamId: null,
  team: null,
  lastCapture: null, // poslední nahraná poloha (pro SOS nápovědu)
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
  await ensureAuth(); // neblokuje (otevřená pravidla fungují i bez auth)

  wireEvents();
  await loadGame();
  await tryRestore();
}

function wireEvents() {
  $("btn-login").addEventListener("click", onLogin);
  $("team-pwd").addEventListener("keydown", (e) => { if (e.key === "Enter") onLogin(); });
  $("btn-capture").addEventListener("click", onCapture);
  $("coords-input").addEventListener("keydown", (e) => { if (e.key === "Enter") onCapture(); });
  $("btn-logout").addEventListener("click", logout);
  $("btn-help").addEventListener("click", onHelp);
  $("photo-input").addEventListener("change", onPhoto);
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
  renderTeam();
  await Promise.all([loadTrail(), loadPhotos()]);
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

  if (p.finished) {
    hide("geo-box");
    hide("help-card");
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
  $("point-title").textContent = `Stanoviště ${p.idx + 1} z ${p.points.length}`;

  if (p.isLast) {
    const left = MAX_FINAL_ATTEMPTS - p.attemptsUsed;
    $("point-hint").innerHTML =
      `<strong style="color:var(--gold-bright)">Poslední stanoviště!</strong>
       Vlož souřadnice do ${radius} m od cíle.
       Zbývá <strong>${left}</strong> ${left === 1 ? "pokus" : "pokusy"} — vyber moudře.`;
  } else {
    $("point-hint").innerHTML =
      `Vlož souřadnice nalezeného místa (do ${radius} m od cíle). Pokusy neomezené.`;
  }
}

// --- záznam polohy (ruční vložení souřadnic) -------------------------
async function onCapture() {
  const t = state.team;
  const p = teamProgress(t);
  if (!p.points.length || p.finished || p.locked) { renderTeam(); return; }

  const raw = $("coords-input").value;
  const coords = parseCoords(raw);
  if (!coords) {
    flash("capture-msg", "bad", "Souřadnice se nepodařilo přečíst. Zkus např. <code>49.195869, 16.602122</code>.");
    return;
  }

  const tgt = p.points[p.idx];
  const radius = tgt.radiusM ?? DEFAULT_RADIUS_M;
  const dist = distanceM(coords.lat, coords.lng, tgt.lat, tgt.lng);
  const within = dist <= radius;

  $("btn-capture").disabled = true;
  $("capture-msg").innerHTML = '<div class="spinner"></div>';

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
      if (update.finished) {
        flash("capture-msg", "ok",
          `<span class="haha" style="color:var(--green)">Už jsi objevil, co bylo potřeba.</span>
           Vrať se do tábora! 🏕️ <span class="muted">(${distR} m od cíle)</span>`);
        confetti();
      } else {
        flash("capture-msg", "ok",
          `✓ <strong>Stanoviště ${p.idx + 1} objeveno!</strong> (${distR} m od cíle)<br>
           Pokračuj na stanoviště ${p.idx + 2} z ${p.points.length}.`);
      }
    } else {
      const haha = HAHA[(t.captureCount ?? 0) % HAHA.length];
      if (p.isLast) {
        const left = MAX_FINAL_ATTEMPTS - (p.attemptsUsed + 1);
        flash("capture-msg", "bad",
          left > 0
            ? `<span class="haha">${haha}</span>
               Tato poloha je <strong>${distR} m</strong> od cíle.
               Na poslední stanoviště ${left === 1 ? "zbývá poslední pokus" : `zbývají ${left} pokusy`}!`
            : `<span class="haha">A to byl poslední pokus.</span>
               Tato poloha byla <strong>${distR} m</strong> od cíle. Vrať se do tábora.`);
      } else {
        flash("capture-msg", "bad",
          `<span class="haha">${haha}</span>
           Tato poloha je <strong>${distR} m</strong> od cíle. Zkus jiné souřadnice — pokusy neomezené.`);
      }
    }
  } catch (e) {
    console.error(e);
    flash("capture-msg", "bad", "Záznam se nepodařilo uložit. Zkontroluj připojení / Firestore Rules.");
  } finally {
    $("btn-capture").disabled = false;
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
      const mark = x.within ? `${point}: ✓ objeveno` : `${point}: ${x.distanceM} m daleko`;
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
async function onHelp() {
  const t = state.team;
  const p = teamProgress(t);
  if (!p.points.length || p.finished || p.locked) { clearFlash("help-msg"); return; }

  const last = state.lastCapture;
  if (!last || typeof last.lat !== "number") {
    flash("help-msg", "info",
      `Nejdřív nahraj aspoň jednu polohu (klidně vedle) — pak ti řeknu,
       kterým směrem a jak daleko je stanoviště ${p.idx + 1}.`);
    return;
  }

  const tgt = p.points[p.idx];
  const deg = Math.round(bearingDeg(last.lat, last.lng, tgt.lat, tgt.lng));
  const dist = Math.round(distanceM(last.lat, last.lng, tgt.lat, tgt.lng));
  const dir = compassDir(deg);
  const km = dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : dist + " m";

  $("help-msg").innerHTML = `
    <div class="compass-wrap">
      <div class="compass-dial">
        <span class="n">S</span>
        <svg class="compass-needle" style="transform:rotate(${deg}deg)"
             width="52" height="52" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2 L16 19 L12 15.5 L8 19 Z" fill="#f4c35a" stroke="#d9a441" stroke-width="0.6"/>
          <circle cx="12" cy="12" r="1.6" fill="#0a0c12" stroke="#d9a441" stroke-width="0.8"/>
        </svg>
      </div>
      <div class="compass-info">
        <div class="deg">${deg}° <span style="font-size:1.05rem">${dir}</span></div>
        <div>Vzdušnou čarou <strong>${km}</strong> k stanovišti ${p.idx + 1}.</div>
        <div class="muted" style="font-size:0.82rem;margin-top:4px">
          Nastav buzolu na <strong>${deg}°</strong>, srovnej střelku na
          sever (S) a vyraz ve směru šipky. Počítáno z tvé poslední nahrané polohy.
        </div>
      </div>
    </div>`;

  // poznač si to pro organizátora (nemusí projít — nevadí)
  try {
    await updateDoc(doc(db, "games", state.gameId, "teams", state.teamId), {
      helpCount: (t.helpCount ?? 0) + 1,
      updatedAt: serverTimestamp(),
    });
    state.team.helpCount = (t.helpCount ?? 0) + 1;
  } catch (e) { console.warn("helpCount se nezapsal", e); }
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

    // metadata do Firestore
    await addDoc(collection(db, "games", state.gameId, "teams", state.teamId, "photos"), {
      url,
      path: name,
      pointIndex: Math.min(p.idx, Math.max(p.points.length - 1, 0)),
      createdAt: serverTimestamp(),
    });

    flash("photo-msg", "ok", "✓ Fotka uložena. Kronikář Bratrstva ji už zkoumá. 🐾");
    await loadPhotos();
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
