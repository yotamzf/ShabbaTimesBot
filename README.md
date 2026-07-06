# 🕯️ Shabbat & Chag Times Notifier — בוט התראות שבת, חג, ראש חודש, צומות וימים לאומיים

בוט אוטומציה ב‑[n8n](https://n8n.io) ששולח **התראה מעוצבת בעברית** ב‑**Telegram** וב‑**Gmail**
בבוקר שלפני כל אירוע הלכתי — **בלי חילול שבת/חג** — עם כל הזמנים החשובים עבור
**ירושלים** ו**אפרת**.

הבוט מזהה ושולח התראות עבור:

| סוג אירוע | מה נשלח |
|-----------|----------|
| 🕯️ **שבת** | הדלקת נרות / כניסת שבת, צאת שבת, צאת ר"ת |
| 🎉 **חג** | כניסת החג, צאת החג, צאת ר"ת |
| 🌙 **ראש חודש** | באיזה יום/ימים יחול, שם החודש, מספר ימי החודש, זמן המולד המדויק |
| 🟤 **צום** | תחילת הצום וסיום הצום |
| 🇮🇱 **יום לאומי** | תאריך עברי ולועזי + הסבר קצר על היום (ראו רשימה למטה) |

### הימים הלאומיים הנתמכים

יום השואה 🕯️ · יום הזיכרון לחללי מערכות ישראל 🎗️ · יום העצמאות 🇮🇱 · יום ירושלים 🦁 ·
יום העלייה ✈️ · חג הסיגד 🙏 · יום הרצל 🎩 · יום ז׳בוטינסקי 🎗️ · יום הזיכרון ליצחק רבין 🕯️ ·
יום בן־גוריון 🎗️ · יום המשפחה 👨‍👩‍👧‍👦 · יום הלשון העברית ✍️

הימים מגיעים מ‑Hebcal (`mod=on`), כך שגם יום מודרני חדש שיתווסף שם בעתיד יישלח
אוטומטית (עם השם העברי של Hebcal, בלי תיאור מותאם).

> ⏰ ההתראה נשלחת **בבוקר שלפני** האירוע (ברירת מחדל 08:00, שעון ישראל), כך שלעולם
> אין שליחה בשבת או בחג עצמם.

---

## 📐 ארכיטקטורה

```
┌──────────────────────┐
│ Daily Morning Trigger│  ⏰ כל יום ב‑08:00 (Asia/Jerusalem)
└──────────┬───────────┘
           ▼
┌──────────────────────┐   ┌──────────────────────┐
│ Fetch Jerusalem Times│   │   Fetch Efrat Times   │  🌐 yeshiva.org.il
└──────────┬───────────┘   └──────────┬───────────┘     (זמני שבת/חג, HTML)
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│ Fetch Jerusalem Fasts│   │   Fetch Efrat Fasts   │  🌐 hebcal.com API
└──────────┬───────────┘   └──────────┬───────────┘     (צומות + ראש חודש, JSON)
           ▼
┌──────────────────────┐
│ Decide and Build Email│  🧠 כל הלוגיקה: זיהוי האירוע של מחר + בניית ההודעה
└──────────┬───────────┘     (src/code-node.js)
           ▼
┌──────────────────────┐
│     Should Notify?    │  ❓ יש אירוע שצריך להתריע עליו היום?
└──────────┬───────────┘
           ▼ (true)
┌──────────────────────┐   ┌──────────────────────┐
│   Send Shabbat Email  │──▶│  Send Shabbat Telegram│  📧 + 💬
└──────────────────────┘   └──────────────────────┘
```

### מקורות הנתונים
- **זמני שבת/חג** — נשאבים מאתר [ישיבה](https://www.yeshiva.org.il) (HTML), עבור ירושלים ואפרת.
- **צומות, ראש חודש וימים לאומיים** — מ‑[Hebcal REST API](https://www.hebcal.com/home/195/jewish-calendar-rest-api) (JSON).
- **זמן המולד** — מחושב מקומית בקוד באמצעות חשבון הלוח העברי (אלגוריתם Dershowitz–Reingold),
  כך שאין תלות בשירות חיצוני עבור נתון זה.

> כל קריאות ה‑HTTP הן **לקריאה בלבד (GET)** מ‑APIs ציבוריים — הבוט אינו כותב נתונים החוצה
> מלבד ההתראה ל‑Telegram/Gmail שלך.

---

## 📁 מבנה הריפו

```
.
├── README.md                          ← הקובץ הזה
├── .gitignore                         ← מונע העלאת סודות בטעות
├── workflow/
│   └── shabbat-chag-notifier.json     ← ה‑workflow לייבוא ל‑n8n (מנוקה מנתונים אישיים)
├── src/
│   └── code-node.js                   ← הלוגיקה המלאה של node ה‑Code (מתועדת)
└── docs/
    └── SETUP.md                       ← מדריך התקנה והגדרה מפורט
```

---

## 🚀 התקנה מהירה

1. **ייבוא ה‑workflow** — ב‑n8n: `Workflows → Import from File` ובחר את
   `workflow/shabbat-chag-notifier.json`.
2. **חיבור Credentials** (ראו פירוט ב‑[`docs/SETUP.md`](docs/SETUP.md)):
   - חבר חשבון **Gmail (OAuth2)** ל‑node `Send Shabbat Email`.
   - חבר **Telegram Bot** (טוקן מ‑[@BotFather](https://t.me/BotFather)) ל‑node `Send Shabbat Telegram`.
3. **החלף את ערכי ה‑placeholder** (ראו טבלה למטה).
4. **הפעל** את ה‑workflow (Active).

### ערכי placeholder שצריך להחליף

| מיקום | Placeholder | מה לשים |
|-------|-------------|----------|
| `Send Shabbat Email` → To | `REPLACE_WITH_YOUR_EMAIL@example.com` | כתובת/ות המייל שלך |
| `Send Shabbat Telegram` → Chat ID | `REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID` | ה‑Chat ID שלך ([איך משיגים](docs/SETUP.md)) |
| Gmail credential | `REPLACE_WITH_GMAIL_CREDENTIAL_ID` | נבחר אוטומטית כשתחבר credential ב‑UI |
| Telegram credential | `REPLACE_WITH_TELEGRAM_CREDENTIAL_ID` | נבחר אוטומטית כשתחבר credential ב‑UI |

> מדריך מלא, כולל איך להחליף מיקום (ירושלים/אפרת → עיר אחרת) ואיך לשנות את שעת
> ההתראה — ב‑[`docs/SETUP.md`](docs/SETUP.md).

---

## 🔒 אבטחה ופרטיות

ריפו זה **נוקה במכוון** מכל מידע אישי לפני ההעלאה:

- ❌ אין **טוקנים** (Telegram bot token, Gmail OAuth) — אלה נשמרים מוצפנים ב‑n8n בלבד.
- ❌ אין **סיסמאות** או credential secrets.
- ❌ אין **כתובות מייל** אמיתיות או **Chat ID** אישי — הוחלפו ב‑placeholders.
- ✅ `.gitignore` חוסם העלאה של `.env`, `secrets.json`, ותיקיית `.n8n/`.

אם אתה מבצע fork או תורם לפרויקט — **לעולם אל תכניס credentials אמיתיים** לקבצי ה‑JSON
או לקוד. n8n מנהל אותם בנפרד ובצורה מוצפנת.

### Git hooks שחוסמים הדלפת סודות

הריפו כולל hooks (ב‑`.githooks/`) שסורקים אוטומטית לפני כל `commit` ו‑`push` ומכשילים
את הפעולה אם מתגלה סוד או מידע אישי (כתובת gmail אמיתית, Telegram bot token, Chat ID,
`token`/`api_key`/`password` וכו'). placeholders בסגנון `REPLACE_WITH_...` / `@example.com`
מותרים. כדי להפעיל אותם לאחר clone, הרץ פעם אחת:

```bash
git config core.hooksPath .githooks
```

---

## 🛠️ פיתוח

הלוגיקה כולה נמצאת ב‑`src/code-node.js` ומשמשת כ‑Code node יחיד ב‑n8n.
היא כתובה ב‑JavaScript סטנדרטי ללא תלויות חיצוניות, וכוללת:

- **`extractTimes`** — חילוץ זמני שבת/חג מתוך ה‑HTML של אתר ישיבה.
- **`buildShabbatCandidates`** — בניית אירועי שבת/חג עם זמני שני המקומות.
- **`buildFastCandidates`** — זיהוי צומות (תחילה/סיום) מתוך Hebcal.
- **`buildRoshChodeshCandidates`** — זיהוי ראש חודש + חישוב מולד מדויק.
- **`buildNationalCandidates`** — זיהוי ימים לאומיים (subcat `modern` של Hebcal) + תיאורים בעברית (`NATIONAL_DAYS`).
- **`renderTelegram` / `renderShabbatHtml` / ...** — עיצוב ההודעות (Telegram HTML + מייל HTML).
- **`buildResults`** — בוחר את האירוע/ים שצריך להתריע עליהם *היום* (לקראת מחר).

מכיוון שהקובץ עומד בפני עצמו, אפשר לבדוק את הפונקציות גם מחוץ ל‑n8n על ידי קריאה
לפונקציות עם נתוני דוגמה.

---

## 📄 רישיון

MIT — ראו [`LICENSE`](LICENSE).
