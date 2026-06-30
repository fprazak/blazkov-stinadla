# 🦔 Stínadla — Záhada hlavolamu

Týmová šifrovací hra (Rychlé šípy / *ježek v kleci*). Týmy zadají vstupní
heslo, vyberou svůj tým a mají **3 pokusy** na uhodnutí závěrečného kódu.
Stav se ukládá do **Firebase Firestore**, takže organizátor vidí pokusy
všech týmů a data přežijí změnu zařízení. `localStorage` slouží jen jako
záloha posledního týmu / hry.

Čistě statická aplikace → běží na **GitHub Pages**.

## 📁 Soubory

| Soubor | Popis |
|---|---|
| `index.html` + `app.js` | hlavní hra (vstup → výběr týmu → pokusy) |
| `seed.html` | založení hry a 6 týmů (chráněno admin heslem) |
| `admin.html` | přehled organizátora (pokusy, historie, stav) |
| `firebase.js` | **Firebase konfigurace — TADY DOPLŇ ÚDAJE** |
| `db.js` | sdílená inicializace Firebase + anonymní přihlášení |
| `styles.css` | atmosférický vzhled (mlha, lucerny, emblém) |
| `firestore.rules` | **ostrá** bezpečnostní pravidla |
| `firestore.rules.seed` | dočasná pravidla pro seedování |

## 🚀 Nastavení (1× na začátku)

### 1. Firebase projekt
1. [console.firebase.google.com](https://console.firebase.google.com) → **Add project**
2. **Build → Firestore Database** → *Create database* (production mode)
3. **Build → Authentication → Sign-in method** → zapni **Anonymous**
4. **⚙ Project settings → Your apps → Web (`</>`)** → zkopíruj `firebaseConfig`

### 2. Doplň `firebase.js`
Nahraď všech 6 `"DOPLNIT"` hodnotami z konzole. (Tyto klíče nejsou tajné,
mohou být veřejně na GitHubu — chrání je Firestore Rules, ne skrytí.)

### 3. Nastav pravidla a naseeduj data
Seedování zakládá hru/týmy, což **ostrá** pravidla zakazují. Postup:

1. **Firestore → Rules** → vlož obsah `firestore.rules.seed` → *Publish*
2. Otevři `seed.html`, heslo **`RychleSipy`**, klikni *Založit hru a týmy*
   → zobrazí se **gameId**
3. **Firestore → Rules** → vlož zpět `firestore.rules` (ostrá) → *Publish*

> Alternativa bez dočasných pravidel: založ hru/týmy ručně ve Firebase
> konzoli podle struktury níže, nebo přes Admin SDK skript.

### 4. Nasaď na GitHub Pages
```bash
echo "# blazkov-stinadla" >> README.md   # už existuje
git init
git add .
git commit -m "Stínadla — Firebase verze"
git branch -M main
git remote add origin https://github.com/fprazak/blazkov-stinadla.git
git push -u origin main
```
Pak na GitHubu: **Settings → Pages → Branch: `main` / root → Save**.
Hra poběží na `https://fprazak.github.io/blazkov-stinadla/`.

## 🗂 Struktura Firestore

```text
games/{gameId}
  title: "Stínadla"
  entryCode: "JEZEK-V-KLECI"
  createdAt, updatedAt

games/{gameId}/teams/{teamId}
  name, finalCode
  attemptsUsed: 0
  solved: false
  solvedAt: null
  createdAt, updatedAt

games/{gameId}/teams/{teamId}/attempts/{attemptId}
  code, correct, createdAt
```

## 🎮 Chování
- Vstupní heslo `JEZEK-V-KLECI` → najde hru podle `entryCode`.
- Výběr týmu → načte stav z Firestore.
- **📍 Geo brána:** tým musí být fyzicky na závěrečném stanovišti — kód jde
  zadat až po ověření polohy (viz níže).
- Každý pokus: zápis do `attempts` + `attemptsUsed += 1`, `updatedAt`.
- Správný kód → `solved = true`, `solvedAt`.
- Max **3 pokusy**; `solved` nebo `attemptsUsed >= 3` = konec.
- Špatný pokus → posměšná „haha" hláška. 😄

## 📍 Kontrola polohy (GPS)
Než tým může zadat závěrečný kód, musí být na místě. Nastavení je nahoře v
[`app.js`](app.js):

```js
const GEO_REQUIRED = true;                 // false = vypne kontrolu (testování)
const TARGET = {
  lat: 49 + 27.36520 / 60,                 // 49°27.36520'N = 49.456087
  lng: 16 + 10.96371 / 60,                 // 16°10.96371'E = 16.182728
};
const GEO_RADIUS_M = 10;                   // povolený poloměr (perimetr)
const GEO_TOLERANCE_M = 5;                 // +-5 m tolerance nepřesnosti GPS
```

- Tým se počítá „na místě", je-li do **~15 m** (10 + 5) od bodu, případně
  pokud to dovolí přesnost GPS hlášená telefonem.
- Vzdálenost se počítá přes **haversine** v metrech.
- Poloha vyžaduje **HTTPS** (GitHub Pages ✓) a souhlas uživatele v prohlížeči.
- Pro jiné stanoviště změň `TARGET` a poloměr. Pro testování v teple dej
  `GEO_REQUIRED = false`.

## 🔐 Hesla v kódu
- Admin (seed + přehled): **`RychleSipy`** (v `seed.html` / `admin.html`).

## ⚠️ Bezpečnostní poznámka
`finalCode` je uložen na týmu a čitelný pro přihlášené — technicky zdatný
tým si může odpověď přečíst z Firestore (cena za validaci na klientovi).
Pro reálnou soutěž přesuň ověření kódu do Cloud Function a `finalCode`
klientům nečti.
