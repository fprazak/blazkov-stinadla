# 🦔 Stínadla — Záhada hlavolamu

Týmová terénní hra (Rychlé šípy / *ježek v kleci*). Každý tým se přihlásí
**vlastním tajným heslem**, dojde na **závěrečné stanoviště** a **zaznamená
svou polohu** (GPS). Když je do **5 m** od cíle, je „na místě". Všechny
záznamy se ukládají do **Firebase Firestore**, takže organizátor vidí stopu
i příchody všech týmů a data přežijí změnu zařízení. `localStorage` slouží
jen jako záloha přihlášeného týmu.

Čistě statická aplikace → běží na **GitHub Pages**.

## 📁 Soubory

| Soubor | Popis |
|---|---|
| `index.html` + `app.js` | hra: přihlášení heslem → záznam polohy (GPS stopa) |
| `seed.html` | založení hry + 6 týmů s náhodnými hesly (admin heslo) |
| `admin.html` | přehled organizátora (hesla, příchody, stopa) |
| `firebase.js` | Firebase konfigurace |
| `db.js` | sdílená inicializace Firebase + anonymní přihlášení |
| `styles.css` | atmosférický vzhled (mlha, lucerny, emblém) |
| `firestore.rules` | **otevřená** pravidla (read/write pro kohokoli) |
| `storage.rules` | **otevřená** pravidla pro Storage (fotky týmů) |

## 🎮 Chování
1. Tým zadá své **tajné heslo** → aplikace najde tým ve Firestore podle
   `password`.
2. Každý tým má **vlastní trasu stanovišť** (`points[]`), plní je
   **popořadě**. Na všechna stanoviště kromě posledního má **neomezené
   pokusy**; na **poslední (finální) jen 3 pokusy**.
3. Tým **ručně vloží souřadnice** nalezeného místa (zkopíruje z mapy/GPS)
   a klikne **„Ověřit a uložit polohu"**. Porovná se s **aktuálním
   stanovištěm**. Poloha se nebere z telefonu. Přijímá desetinné
   (`49.19, 16.60`), DMS (`49°11.752'N 16°36.127'E`) i odkaz z Google Maps.
4. Každý záznam (lat, lng, stanoviště, vzdálenost, čas) se uloží do
   `captures` jako **stopa**.
5. Trefa do perimetru → posun na další stanoviště; po posledním
   `finished = true`, `finishedAt` a hláška *„Vrať se do tábora"*.
6. **📸 Fotky:** tým může na každém místě nahrát fotku (Firebase Storage,
   zmenšená na max 1600 px). Fotky vidí tým i organizátor.
7. **🆘 Ztraceni?** Tlačítko „Poradit směr" ukáže z poslední nahrané
   polohy **azimut na buzolu** (0° = sever), směr růžice (S/SV/V…) a
   vzdálenost vzdušnou čarou k dalšímu stanovišti. Počet použití vidí
   organizátor.
8. Organizátor v `admin.html` vidí **mapu** (stanoviště všech tras +
   nahrané polohy týmů), hesla, postup, fotky, azimut na buzolu
   k dalšímu cíli a celou stopu.

## 🗂 Struktura Firestore

```text
games/{gameId}
  title: "Stínadla"
  createdAt, updatedAt
  (pevné id "stinadla"; cíl je per-tým, ne na hře)

games/{gameId}/teams/{teamId}
  name: "Tým 1"
  password: "VRANA-MLHA-47"          // unikátní přihlašovací heslo
  points: [{ lat, lng, radiusM }, …] // TRASA týmu, poslední = finální
  currentPointIndex: 0               // které stanoviště právě plní
  finalAttemptsUsed: 0               // pokusy na posledním stanovišti (max 3)
  finished: false
  finishedAt: null
  bestDistanceM: null                // nejblíž k aktuálnímu stanovišti
  captureCount: 0
  createdAt, updatedAt

games/{gameId}/teams/{teamId}/captures/{captureId}
  lat, lng, source: "manual", pointIndex, distanceM, within, createdAt
```
(Starý formát s jedním `target` je stále podporovaný — bere se jako trasa
s jedním, tedy finálním, stanovištěm.)

## 🔐 Hesla
- **Admin** (seed + přehled): `RychleSipy` — v `seed.html` a `admin.html`
  na řádku `const ADMIN_PASSWORD = "RychleSipy";`.
- **Týmy:** každý tým má **vlastní náhodné heslo** (např. `VRANA-MLHA-47`),
  které vygeneruje `seed.html`. Hesla se zobrazí po seedování a kdykoli
  v `admin.html` — odtud je rozdáš týmům.

## 📍 Cílové stanoviště (GPS)
- Výchozí cíl: **49°27.36520'N, 16°10.96371'E** → `49.456087, 16.182728`.
- Perimetr: **5 m** (lze změnit v `seed.html` před seedováním, nebo přímo
  v dokumentu hry ve Firestore — pole `target`).
- Vzdálenost se počítá přes **haversine**; tým se počítá „na místě", je-li
  do perimetru, případně to dovolí přesnost GPS hlášená telefonem.
- Poloha vyžaduje **HTTPS** (GitHub Pages ✓) a souhlas v prohlížeči.
- 5 m je pro mobilní GPS přísné — když týmy „nedosáhnou" i když stojí na
  místě, zvedni perimetr (např. na 10–15 m).

## 🚀 Nastavení

### 1. Firebase projekt
1. [console.firebase.google.com](https://console.firebase.google.com) → projekt
2. **Firestore Database → Create database**
3. **Firestore → Rules** → vlož obsah `firestore.rules` (otevřená) → *Publish*
4. **Build → Storage → Get started**, pak **Storage → Rules** → vlož obsah
   `storage.rules` (otevřená) → *Publish* — bez toho nejde nahrávat fotky
5. Config je už doplněný v `firebase.js`.

> Anonymní přihlášení je volitelné — s otevřenými pravidly appka funguje
> i bez něj a není potřeba řešit Authorized domains. Pokud Anonymous Auth
> zapneš, appka ho použije; pokud ne, jede dál bez auth.

### 2. Setup (seed.html)
Otevři `seed.html`, heslo `RychleSipy`. Přidej řádky týmů — u každého
**název** + **trasu stanovišť** (jeden bod na řádek, poslední = finální;
souřadnice / odkaz z mapy). Perimetr je společný. Klikni *Vytvořit hru a
týmy* → vygenerují se **hesla** (zobrazí se v tabulce, rozdej je týmům).
Zaškrtnuté „smazat existující týmy" = čistý start.

### 3. GitHub Pages
Repo veřejné → **Settings → Pages → Branch `main` / root → Save**.
Web poběží na `https://fprazak.github.io/blazkov-stinadla/`.

## ⚠️ Bezpečnostní poznámka
Pravidla v `firestore.rules` jsou **otevřená** — kdokoli s odkazem na
projekt může číst, měnit i mazat všechna data (včetně hesel týmů).
Pro jednorázovou hru je to v pohodě. Pro ostrý/dlouhodobý provoz nahraď
pravidly, která vyžadují auth a omezují zápis, a ověření hesla přesuň do
Cloud Function.
