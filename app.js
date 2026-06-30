// =====================================================================
// STÍNADLA — přihlášení týmu heslem + záznam polohy (GPS stopa)
// =====================================================================
import {
  db, ensureAuth, configIsFilled,
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp,
} from "./db.js";

// --- localStorage klíče (jen ZÁLOHA, zdroj pravdy je Firestore) -------
const LS_GAME = "stinadla.gameId";
const LS_TEAM = "stinadla.teamId";

// --- GEO: závěrečné stanoviště (fallback, pokud hra nemá target) ------
// Cílový bod: 49°27.36520'N, 16°10.96371'E (stupně + desetinné minuty).
const FALLBACK_TARGET = {
  lat: 49 + 27.36520 / 60,   // = 49.45608667
  lng: 16 + 10.96371 / 60,   // = 16.18272850
  radiusM: 5,                // perimetr 5 m
};

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

// --- stav -------------------------------------------------------------
let state = {
  gameId: null,
  gameTitle: "Stínadla",
  target: FALLBACK_TARGET,
  teamId: null,
  team: null,
};

// --- DOM pomocné ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");
function flash(slotId, type, html) { $(slotId).innerHTML = `<div class="flash ${type}">${html}</div>`; }
function clearFlash(slotId) { $(slotId).innerHTML = ""; }
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, "");
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const meters = (n) => (n == null ? "—" : `${Math.round(n)} m`);

// Posměšné "haha" hlášky, když je tým daleko ---------------------------
const HAHA = [
  "Haha! Tady ještě Vontové nevládnou.",
  "Haha! Ježek je pořád daleko v kleci.",
  "Haha! Stínadla jsou jinde, nováčku.",
  "Haha! Široko by ti ukázal správnou uličku.",
  "Haha! Ještě kus cesty dlážděnými ulicemi.",
];

// =====================================================================
// START
// =====================================================================
async function init() {
  if (!configIsFilled()) {
    $("config-warn-slot").innerHTML = `<div class="config-warn">
      ⚠️ <strong>Firebase není nastaven.</strong> Doplň <code>firebase.js</code>.</div>`;
  }
  try {
    await ensureAuth();
  } catch (e) {
    console.error(e);
    flash("login-msg", "bad", "Nepodařilo se přihlásit k Firebase. Zkontroluj, že je v konzoli zapnutý <strong>Anonymous Auth</strong> a že je doména povolená.");
    return;
  }

  wireEvents();
  await loadGame();
  await tryRestore();
}

function wireEvents() {
  $("btn-login").addEventListener("click", onLogin);
  $("team-pwd").addEventListener("keydown", (e) => { if (e.key === "Enter") onLogin(); });
  $("btn-capture").addEventListener("click", onCapture);
  $("btn-logout").addEventListener("click", logout);
}

// --- najdi (jedinou) hru ----------------------------------------------
async function loadGame() {
  const snap = await getDocs(collection(db, "games"));
  if (snap.empty) {
    flash("login-msg", "bad", 'Žádná hra zatím neexistuje. Spusť <a class="back-link" href="seed.html">seed.html</a>.');
    return;
  }
  // pokud je víc her, vezmi tu s titulem Stínadla, jinak první
  const gameDoc = snap.docs.find((d) => (d.data().title || "") === "Stínadla") || snap.docs[0];
  state.gameId = gameDoc.id;
  const g = gameDoc.data();
  state.gameTitle = g.title || "Stínadla";
  if (g.target && typeof g.target.lat === "number") {
    state.target = {
      lat: g.target.lat,
      lng: g.target.lng,
      radiusM: g.target.radiusM ?? FALLBACK_TARGET.radiusM,
    };
  }
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
  await loadTrail();
}

function renderTeam() {
  const t = state.team;
  $("team-name").textContent = t.name || t.id;
  $("game-title").textContent = state.gameTitle;
  $("radius-label").textContent = Math.round(state.target.radiusM);

  if (t.arrived) {
    show("arrived-banner");
    $("arrived-banner").innerHTML =
      `✓ <strong>Stanoviště splněno!</strong> Tým dorazil na místo${t.bestDistanceM != null ? ` (nejblíž ${meters(t.bestDistanceM)})` : ""}.`;
  } else {
    hide("arrived-banner");
  }
}

// --- záznam polohy (ruční vložení souřadnic) -------------------------
async function onCapture() {
  const raw = $("coords-input").value;
  const coords = parseCoords(raw);
  if (!coords) {
    flash("capture-msg", "bad", "Souřadnice se nepodařilo přečíst. Zkus např. <code>49.195869, 16.602122</code>.");
    return;
  }
  const dist = distanceM(coords.lat, coords.lng, state.target.lat, state.target.lng);
  const within = dist <= state.target.radiusM;

  $("btn-capture").disabled = true;
  $("capture-msg").innerHTML = '<div class="spinner"></div>';
  await saveCapture(coords.lat, coords.lng, dist, within);
}

async function saveCapture(lat, lng, dist, within) {
  const t = state.team;
  try {
    const teamRef = doc(db, "games", state.gameId, "teams", state.teamId);

    // 1) zapiš bod do stopy (captures)
    await addDoc(collection(teamRef, "captures"), {
      lat, lng,
      source: "manual",
      distanceM: Math.round(dist),
      within,
      createdAt: serverTimestamp(),
    });

    // 2) aktualizuj tým (jen povolené klíče dle rules)
    const prevBest = t.bestDistanceM;
    const newBest = prevBest == null ? Math.round(dist) : Math.min(prevBest, Math.round(dist));
    const update = {
      captureCount: (t.captureCount ?? 0) + 1,
      bestDistanceM: newBest,
      updatedAt: serverTimestamp(),
    };
    if (within && !t.arrived) {
      update.arrived = true;
      update.arrivedAt = serverTimestamp();
    }
    await updateDoc(teamRef, update);

    // 3) obnov stav z Firestore
    const fresh = await getDoc(teamRef);
    state.team = { id: fresh.id, ...fresh.data() };

    renderTeam();
    await loadTrail();

    const distR = Math.round(dist);
    if (within) {
      flash("capture-msg", "ok", `✓ Sedí! (${distR} m od cíle) Stanoviště splněno.`);
      $("coords-input").value = "";
      if (update.arrived) confetti();
    } else {
      const haha = HAHA[(t.captureCount ?? 0) % HAHA.length];
      flash("capture-msg", "bad",
        `<span class="haha">${haha}</span>
         Tato poloha je <strong>${distR} m</strong> od cíle. Zkus jiné souřadnice.`);
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
    if (snap.empty) { $("trail").innerHTML = '<p class="muted">Zatím žádný záznam.</p>'; return; }
    let html = "";
    snap.docs.forEach((d, i) => {
      const x = d.data();
      const t = x.createdAt?.toDate ? x.createdAt.toDate() : null;
      const time = t ? t.toLocaleString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
      const cls = x.within ? "a-ok" : "a-bad";
      const mark = x.within ? "✓ na místě" : `${x.distanceM} m daleko`;
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
