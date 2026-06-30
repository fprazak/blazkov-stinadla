// =====================================================================
// STÍNADLA — hlavní logika hry
// =====================================================================
import {
  db, ensureAuth, configIsFilled,
  collection, doc, getDoc, getDocs, addDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp,
} from "./db.js";

// --- localStorage klíče (jen ZÁLOHA, zdroj pravdy je Firestore) -------
const LS_GAME = "stinadla.gameId";
const LS_TEAM = "stinadla.teamId";

const MAX_ATTEMPTS = 3;

// --- GEO: závěrečné stanoviště ---------------------------------------
// Cílový bod: 49°27.36520'N, 16°10.96371'E (stupně + desetinné minuty).
const GEO_REQUIRED = true;          // false = vypne kontrolu polohy (na testování)
const TARGET = {
  lat: 49 + 27.36520 / 60,          // = 49.45608667
  lng: 16 + 10.96371 / 60,          // = 16.18272850
  label: "49°27.36520'N, 16°10.96371'E",
};
const GEO_RADIUS_M = 10;            // povolený poloměr (perimetr) v metrech
const GEO_TOLERANCE_M = 5;          // +-5 m tolerance pro nepřesnost GPS
const GEO_ALLOW_M = GEO_RADIUS_M + GEO_TOLERANCE_M; // efektivně do 15 m

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

// --- stav v paměti ----------------------------------------------------
let state = {
  gameId: null,
  gameTitle: "",
  teamId: null,
  team: null, // celý dokument týmu
  locationVerified: false, // splnil tým geo bránu v této relaci?
};

// --- pomocné DOM ------------------------------------------------------
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

function flash(slotId, type, html) {
  $(slotId).innerHTML = `<div class="flash ${type}">${html}</div>`;
}
function clearFlash(slotId) { $(slotId).innerHTML = ""; }

// Posměšné "haha" hlášky při špatném pokusu ----------------------------
const HAHA = [
  "Haha! To by Široko nedal ani omylem.",
  "Haha! Ježek se v kleci jen pousmál.",
  "Haha! Vontové se chechtají ze stínů.",
  "Haha! Tenhle kód patří do kanálů Stínadel.",
  "Haha! Mažňák by se za tebe styděl.",
  "Haha! Skoro… ale Stínadla nejsou pro každého.",
  "Haha! Bratrstvo kočičí pracky kroutí hlavou.",
  "Haha! Zkus to znovu, nováčku z Druhé strany.",
];
function randomHaha() {
  // bez Math.random závislosti na čase — vybíráme podle počtu pokusů
  const i = (state.team?.attemptsUsed ?? 0) % HAHA.length;
  return HAHA[i];
}

// --- normalizace kódu (necitlivé na velikost/mezery) ------------------
const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, "");

// =====================================================================
// START
// =====================================================================
async function init() {
  if (!configIsFilled()) {
    $("config-warn-slot").innerHTML = `
      <div class="config-warn">
        ⚠️ <strong>Firebase není nastaven.</strong> Otevři soubor
        <code>firebase.js</code> a doplň údaje z Firebase konzole
        (apiKey, projectId, …). Do té doby hra neuloží žádná data.
      </div>`;
  }

  try {
    await ensureAuth(); // anonymní přihlášení
  } catch (e) {
    flash("entry-msg", "bad", "Nepodařilo se přihlásit k Firebase. Zkontroluj, že je v konzoli zapnutý <strong>Anonymous Auth</strong>.");
    console.error(e);
  }

  wireEvents();
  await tryRestore(); // pokusíme se obnovit poslední hru/tým ze zálohy
}

function wireEvents() {
  $("btn-entry").addEventListener("click", onEnterCode);
  $("entry-code").addEventListener("keydown", (e) => { if (e.key === "Enter") onEnterCode(); });

  $("back-to-entry").addEventListener("click", () => goto("entry"));
  $("back-to-teams").addEventListener("click", () => goto("teams"));

  $("btn-attempt").addEventListener("click", onAttempt);
  $("final-code").addEventListener("keydown", (e) => { if (e.key === "Enter") onAttempt(); });

  $("btn-geo").addEventListener("click", verifyLocation);
}

// --- přepínání obrazovek ---------------------------------------------
function goto(screen) {
  hide("screen-entry"); hide("screen-teams"); hide("screen-play");
  show(`screen-${screen}`);
}

// =====================================================================
// KROK 1 — vstupní kód → najdi hru podle entryCode
// =====================================================================
async function onEnterCode() {
  const code = norm($("entry-code").value);
  if (!code) { flash("entry-msg", "bad", "Zadej vstupní heslo."); return; }
  clearFlash("entry-msg");
  $("btn-entry").disabled = true;
  $("entry-msg").innerHTML = '<div class="spinner"></div>';

  try {
    const q = query(collection(db, "games"), where("entryCode", "==", code), limit(1));
    const snap = await getDocs(q);
    if (snap.empty) {
      flash("entry-msg", "bad", "Takové heslo ve Stínadlech neplatí. Zkus to znovu.");
      return;
    }
    const gameDoc = snap.docs[0];
    state.gameId = gameDoc.id;
    state.gameTitle = gameDoc.data().title || "Stínadla";
    localStorage.setItem(LS_GAME, state.gameId);
    clearFlash("entry-msg");
    await loadTeams();
  } catch (e) {
    console.error(e);
    flash("entry-msg", "bad", "Chyba při hledání hry. Zkontroluj připojení a Firestore Rules.");
  } finally {
    $("btn-entry").disabled = false;
  }
}

// =====================================================================
// KROK 2 — výběr týmu
// =====================================================================
async function loadTeams() {
  $("game-title").textContent = state.gameTitle;
  const grid = $("team-grid");
  grid.innerHTML = '<div class="spinner"></div>';
  goto("teams");

  const teamsCol = collection(db, "games", state.gameId, "teams");
  const snap = await getDocs(teamsCol);

  // seřadíme podle jména
  const teams = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "cs"));

  grid.innerHTML = "";
  teams.forEach((t) => {
    const used = t.attemptsUsed ?? 0;
    const solved = !!t.solved;
    const locked = solved || used >= MAX_ATTEMPTS;
    const tile = document.createElement("div");
    tile.className = "team-tile" + (solved ? " is-solved" : locked ? " is-locked" : "");
    let badge = `<div class="tmeta">${used}/${MAX_ATTEMPTS} pokusů</div>`;
    if (solved) badge += `<div class="badge">✓ Vyřešeno</div>`;
    else if (locked) badge += `<div class="badge" style="color:var(--blood)">✕ Bez pokusů</div>`;
    tile.innerHTML = `<div class="tname">${escapeHtml(t.name || t.id)}</div>${badge}`;
    tile.addEventListener("click", () => selectTeam(t.id));
    grid.appendChild(tile);
  });

  if (teams.length === 0) {
    grid.innerHTML = '<p class="muted center">Tato hra zatím nemá žádné týmy. Spusť <a class="back-link" href="seed.html">seed.html</a>.</p>';
  }
}

// =====================================================================
// KROK 3 — načti stav týmu a otevři hru
// =====================================================================
async function selectTeam(teamId) {
  state.teamId = teamId;
  state.locationVerified = false; // při výběru týmu vyžadujeme novou kontrolu polohy
  localStorage.setItem(LS_TEAM, teamId);
  await refreshTeam();
  renderPlay();
  goto("play");
}

async function refreshTeam() {
  const ref = doc(db, "games", state.gameId, "teams", state.teamId);
  const snap = await getDoc(ref);
  state.team = snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

function renderPlay() {
  const t = state.team;
  if (!t) { goto("teams"); return; }

  $("play-team-name").textContent = t.name || t.id;
  const used = t.attemptsUsed ?? 0;
  const solved = !!t.solved;

  // pečetě pokusů
  const seals = $("attempts-seals").children;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    seals[i].className = "seal";
    if (solved && i < used) seals[i].classList.add("ok");
    else if (i < used) seals[i].classList.add("used");
  }

  clearFlash("play-msg");
  const remaining = MAX_ATTEMPTS - used;

  if (solved) {
    $("geo-gate").classList.add("hidden");
    showWin(t);
    return;
  }
  if (used >= MAX_ATTEMPTS) {
    $("geo-gate").classList.add("hidden");
    $("play-form").classList.add("hidden");
    flash("play-msg", "bad",
      `<span class="haha">Konec hry pro tento tým.</span>
       Všechny <strong>3 pokusy</strong> jsou pryč. Stínadla si svá tajemství nechávají pro sebe.`);
    return;
  }

  // GEO BRÁNA: bez ověřené polohy nelze zadat kód
  if (GEO_REQUIRED && !state.locationVerified) {
    $("geo-gate").classList.remove("hidden");
    $("play-form").classList.add("hidden");
    $("btn-geo").disabled = false;
    clearFlash("play-msg");
    flash("play-msg", "info", `Zbývají ti <strong>${remaining}</strong> ${pokusySlovo(remaining)}. Nejdřív se přesuň na závěrečné stanoviště a ověř polohu.`);
    return;
  }

  // může hrát
  $("geo-gate").classList.add("hidden");
  $("play-form").classList.remove("hidden");
  $("geo-ok-badge").classList.toggle("hidden", !GEO_REQUIRED);
  $("final-code").value = "";
  $("btn-attempt").disabled = false;
  flash("play-msg", "info", `Zbývají ti <strong>${remaining}</strong> ${pokusySlovo(remaining)}.`);
}

function pokusySlovo(n) {
  return n === 1 ? "pokus" : n < 5 ? "pokusy" : "pokusů";
}

// =====================================================================
// GEO BRÁNA — ověření polohy přes navigator.geolocation
// =====================================================================
function verifyLocation() {
  if (!("geolocation" in navigator)) {
    flash("geo-msg", "bad", "Tento prohlížeč neumí zjistit polohu.");
    return;
  }
  $("btn-geo").disabled = true;
  $("geo-msg").innerHTML = '<div class="spinner"></div><p class="muted center">Zjišťuji polohu…</p>';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const dist = distanceM(latitude, longitude, TARGET.lat, TARGET.lng);
      const distR = Math.round(dist);
      // tým je „na místě", pokud je do povoleného poloměru,
      // nebo pokud to umožní nepřesnost GPS (accuracy)
      const within = dist <= GEO_ALLOW_M || (dist - (accuracy || 0)) <= GEO_RADIUS_M;

      if (within) {
        state.locationVerified = true;
        flash("geo-msg", "ok", `✓ Jsi na místě! (cca ${distR} m od cíle)`);
        // krátká pauza, ať si hráč všimne potvrzení
        setTimeout(() => renderPlay(), 600);
      } else {
        $("btn-geo").disabled = false;
        flash("geo-msg", "bad",
          `<span class="haha">Ještě ne!</span>
           Jsi <strong>cca ${distR} m</strong> od závěrečného stanoviště
           (přesnost GPS ±${Math.round(accuracy || 0)} m).
           Přibliž se a zkus to znovu.`);
      }
    },
    (err) => {
      $("btn-geo").disabled = false;
      let msg = "Polohu se nepodařilo zjistit.";
      if (err.code === err.PERMISSION_DENIED)
        msg = "Přístup k poloze byl zamítnut. Povol polohu v prohlížeči a zkus to znovu.";
      else if (err.code === err.POSITION_UNAVAILABLE)
        msg = "Poloha není dostupná. Jdi prosím ven s lepším signálem GPS.";
      else if (err.code === err.TIMEOUT)
        msg = "Zjišťování polohy trvalo moc dlouho. Zkus to znovu.";
      flash("geo-msg", "bad", msg);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

// --- odeslání pokusu --------------------------------------------------
async function onAttempt() {
  const t = state.team;
  if (!t) return;

  // bezpečnostní kontroly i na klientovi
  if (t.solved) { renderPlay(); return; }
  if ((t.attemptsUsed ?? 0) >= MAX_ATTEMPTS) { renderPlay(); return; }

  const guess = norm($("final-code").value);
  if (!guess) { flash("play-msg", "bad", "Zadej kód."); return; }

  $("btn-attempt").disabled = true;
  $("play-msg").innerHTML = '<div class="spinner"></div>';

  const correct = guess === norm(t.finalCode);
  const newUsed = (t.attemptsUsed ?? 0) + 1;

  try {
    const teamRef = doc(db, "games", state.gameId, "teams", state.teamId);

    // 1) zapiš pokus do podkolekce attempts
    await addDoc(collection(teamRef, "attempts"), {
      code: $("final-code").value.trim(),
      correct,
      createdAt: serverTimestamp(),
    });

    // 2) aktualizuj tým
    const update = {
      attemptsUsed: newUsed,
      updatedAt: serverTimestamp(),
    };
    if (correct) {
      update.solved = true;
      update.solvedAt = serverTimestamp();
    }
    await updateDoc(teamRef, update);

    // 3) znovu načti pravdivý stav z Firestore
    await refreshTeam();

    // pečetě
    const seals = $("attempts-seals").children;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      seals[i].className = "seal";
      if (i < (state.team.attemptsUsed ?? 0)) seals[i].classList.add(correct && state.team.solved ? "ok" : "used");
    }

    if (correct) {
      showWin(state.team);
    } else if ((state.team.attemptsUsed ?? 0) >= MAX_ATTEMPTS) {
      $("play-form").classList.add("hidden");
      flash("play-msg", "bad",
        `<span class="haha">${randomHaha()}</span>
         A to byl <strong>poslední pokus</strong>. Stínadla zůstávají záhadou.`);
    } else {
      const remaining = MAX_ATTEMPTS - (state.team.attemptsUsed ?? 0);
      $("final-code").value = "";
      $("btn-attempt").disabled = false;
      flash("play-msg", "bad",
        `<span class="haha">${randomHaha()}</span>
         Špatný kód. Zbývá ${remaining} ${remaining === 1 ? "pokus" : "pokusy"}.`);
    }
  } catch (e) {
    console.error(e);
    $("btn-attempt").disabled = false;
    flash("play-msg", "bad", "Pokus se nepodařilo uložit. Zkontroluj připojení / Firestore Rules.");
  }
}

// --- vítězná obrazovka ------------------------------------------------
function showWin(t) {
  $("play-form").classList.add("hidden");
  $("play-msg").innerHTML = `
    <div class="win">
      <div style="font-size:2.4rem">🏆</div>
      <p class="muted">Závěrečný kód rozluštěn!</p>
      <div class="final">${escapeHtml(t.finalCode || "")}</div>
      <p>Tým <strong>${escapeHtml(t.name || t.id)}</strong> rozluštil záhadu hlavolamu.<br>
      Ježek je z klece venku! 🦔</p>
    </div>`;
  confetti();
}

// =====================================================================
// Obnova ze zálohy (localStorage) — pohodlí, ne zdroj pravdy
// =====================================================================
async function tryRestore() {
  const gameId = localStorage.getItem(LS_GAME);
  const teamId = localStorage.getItem(LS_TEAM);
  if (!gameId) return;

  try {
    const gameSnap = await getDoc(doc(db, "games", gameId));
    if (!gameSnap.exists()) { localStorage.removeItem(LS_GAME); return; }
    state.gameId = gameId;
    state.gameTitle = gameSnap.data().title || "Stínadla";

    if (teamId) {
      const teamSnap = await getDoc(doc(db, "games", gameId, "teams", teamId));
      if (teamSnap.exists()) {
        flash("entry-msg", "info",
          `Pokračovat jako <strong>${escapeHtml(teamSnap.data().name || teamId)}</strong>?
           <button id="resume-btn" class="btn ghost" style="margin-top:10px">Pokračovat</button>`);
        $("resume-btn").addEventListener("click", () => selectTeam(teamId));
      }
    }
  } catch (e) {
    console.warn("restore failed", e);
  }
}

// =====================================================================
// Drobnosti
// =====================================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function confetti() {
  const colors = ["#d9a441", "#f4c35a", "#5fae6b", "#b23a35", "#e8e2d0"];
  for (let i = 0; i < 70; i++) {
    const s = document.createElement("div");
    s.className = "spark";
    const left = (i * 53) % 100;            // deterministicky, bez Math.random
    const dur = 2.4 + ((i * 37) % 18) / 10; // 2.4–4.2s
    const delay = ((i * 17) % 12) / 10;     // 0–1.2s
    s.style.left = left + "vw";
    s.style.background = colors[i % colors.length];
    s.style.animationDuration = dur + "s";
    s.style.animationDelay = delay + "s";
    document.body.appendChild(s);
    setTimeout(() => s.remove(), (dur + delay) * 1000 + 200);
  }
}

init();
