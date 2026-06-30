// Sdílená inicializace Firebase (App + Firestore + Anonymous Auth).
// Importuje se ze všech stránek (index.html, admin.html, seed.html).

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  setDoc,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

import { firebaseConfig } from "./firebase.js";

// --- Kontrola, jestli je config vyplněný --------------------------------
export function configIsFilled() {
  return Object.values(firebaseConfig).every(
    (v) => v && v !== "DOPLNIT"
  );
}

// --- Inicializace -------------------------------------------------------
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Zkusí anonymní přihlášení, ale NEBLOKUJE appku, když selže —
// s otevřenými pravidly (firestore.rules) není auth potřeba.
let authPromise = null;
export function ensureAuth() {
  if (!authPromise) {
    authPromise = new Promise((resolve) => {
      onAuthStateChanged(auth, (user) => { if (user) resolve(user); });
      signInAnonymously(auth).catch((e) => {
        console.warn("Anonymní přihlášení selhalo, pokračuji bez auth (otevřená pravidla):", e?.code || e);
        resolve(null);
      });
    });
  }
  return authPromise;
}

// Re-export Firestore funkcí, ať je ostatní soubory nemusí importovat z CDN.
export {
  db,
  auth,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  updateDoc,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
};
