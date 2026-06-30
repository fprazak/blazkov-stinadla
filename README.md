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
| `firestore.rules` | **ostrá** bezpečnostní pravidla |
| `firestore.rules.seed` | dočasná pravidla pro seedování |

## 🎮 Chování
1. Tým zadá své **tajné heslo** → aplikace najde tým ve Firestore podle
   `password`.
2. Tým dojde na místo a klikne **„📍 Zaznamenat polohu"**.
3. Každý záznam (lat, lng, přesnost, vzdálenost, čas) se uloží do
   `captures` jako **stopa** — záznamů může být libovolně mnoho.
4. Když je tým do **perimetru (5 m)** od cíle (s ohledem na přesnost GPS),
   nastaví se `arrived = true`, `arrivedAt`.
5. Organizátor v `admin.html` vidí hesla, stav, nejbližší vzdálenost a
   celou stopu záznamů.

## 🗂 Struktura Firestore

```text
games/{gameId}
  title: "Stínadla"
  target: { lat, lng, radiusM }      // jedno cílové stanoviště
  createdAt, updatedAt

games/{gameId}/teams/{teamId}
  name: "Tým 1"
  password: "VRANA-MLHA-47"          // unikátní přihlašovací heslo
  arrived: false
  arrivedAt: null
  bestDistanceM: null                // nejbližší dosažená vzdálenost
  captureCount: 0
  createdAt, updatedAt

games/{gameId}/teams/{teamId}/captures/{captureId}
  lat, lng, accuracy, distanceM, within, createdAt
```

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
2. **Firestore Database → Create database** (production mode)
3. **Authentication → Get started → Sign-in method → Anonymous → Enable**
4. **Authentication → Settings → Authorized domains** → přidej
   `fprazak.github.io` (jinak Auth na živém webu selže na
   `auth/unauthorized-domain`)
5. Config je už doplněný v `firebase.js`.

### 2. Pravidla + seed
1. **Firestore → Rules** → vlož `firestore.rules.seed` → *Publish*
2. Otevři `seed.html`, heslo `RychleSipy`, *Založit hru a týmy* →
   zobrazí se **gameId** a **hesla týmů**
3. **Firestore → Rules** → vlož zpět `firestore.rules` (ostrá) → *Publish*

### 3. GitHub Pages
Repo veřejné → **Settings → Pages → Branch `main` / root → Save**.
Web poběží na `https://fprazak.github.io/blazkov-stinadla/`.

## ⚠️ Bezpečnostní poznámka
Hesla týmů jsou uložená na dokumentu týmu a pro přihlášené čitelná —
technicky zdatný hráč si je může přečíst z Firestore (cena za přihlášení
bez serveru). Náhodná hesla brání **uhodnutí**, ne přečtení z konzole.
Pro reálnou soutěž přesuň ověření hesla do Cloud Function.
