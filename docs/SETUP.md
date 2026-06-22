# 📖 מדריך התקנה והגדרה

מדריך מפורט להקמת בוט התראות שבת/חג/ראש חודש/צומות ב‑n8n.

---

## דרישות מוקדמות

- מופע **n8n** פעיל (Cloud או self-hosted).
- חשבון **Gmail** (לשליחת מייל) — אופציונלי אם רוצים רק Telegram.
- בוט **Telegram** + Chat ID.

---

## שלב 1 — ייבוא ה‑Workflow

1. ב‑n8n: לחץ על תפריט `⋯` → **Import from File**.
2. בחר את `workflow/shabbat-chag-notifier.json`.
3. ה‑workflow ייווצר עם 9 nodes. עדיין לא להפעיל — קודם נחבר credentials.

---

## שלב 2 — Credential ל‑Telegram

1. ב‑Telegram, פתח שיחה עם [@BotFather](https://t.me/BotFather) ושלח `/newbot`.
2. עקוב אחר ההוראות וקבל **bot token** (מחרוזת כמו `123456:ABC-DEF...`).
3. ב‑n8n: `Credentials → New → Telegram API` והדבק את הטוקן.
4. בחר את ה‑credential הזה ב‑node `Send Shabbat Telegram`.

### איך משיגים את ה‑Chat ID שלך

1. שלח הודעה כלשהי לבוט שיצרת (חפש אותו לפי השם שבחרת ולחץ Start).
2. פתח בדפדפן (החלף `<TOKEN>` בטוקן שלך):
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
3. חפש בתשובה `"chat":{"id":...}` — המספר הזה הוא ה‑Chat ID.
4. הדבק אותו בשדה **Chat ID** ב‑node `Send Shabbat Telegram`
   (במקום `REPLACE_WITH_YOUR_TELEGRAM_CHAT_ID`).

> 💡 לשליחה לקבוצה: הוסף את הבוט לקבוצה, שלח שם הודעה, וה‑id יהיה מספר **שלילי**.

---

## שלב 3 — Credential ל‑Gmail (אופציונלי)

1. ב‑n8n: `Credentials → New → Gmail OAuth2`.
2. עקוב אחר תהליך ה‑OAuth (צריך Google Cloud project עם Gmail API מופעל —
   ראה [תיעוד n8n](https://docs.n8n.io/integrations/builtin/credentials/google/)).
3. בחר את ה‑credential ב‑node `Send Shabbat Email`.
4. בשדה **To** החלף את `REPLACE_WITH_YOUR_EMAIL@example.com` בכתובת/ות שלך
   (אפשר כמה, מופרדות בפסיק).

> אם אינך רוצה מייל כלל — אפשר למחוק את node `Send Shabbat Email` ולחבר את
> `Should Notify?` ישירות ל‑`Send Shabbat Telegram`.

---

## שלב 4 — הפעלה

הפעל את ה‑workflow (toggle **Active**). מעתה הוא יֵרוץ כל יום ב‑08:00 שעון ישראל.

### בדיקה ידנית

לחץ **Execute Workflow** כדי להריץ עכשיו. שים לב:
- אם **אין** אירוע מחר → ה‑node `Decide and Build Email` יחזיר `shouldNotify: false`
  ולא תישלח הודעה (זו ההתנהגות התקינה).
- כדי לבדוק את העיצוב בלי לחכות לאירוע אמיתי, אפשר להריץ את הקוד מתוך
  `src/code-node.js` עם נתוני דוגמה, או לשנות זמנית את התנאי ב‑`Should Notify?`.

---

## התאמות אישיות

### שינוי שעת ההתראה
ב‑node `Daily Morning Trigger` שנה את `triggerAtHour` / `triggerAtMinute`.

### שינוי מיקום
- **זמני שבת/חג** (אתר ישיבה): ב‑nodes `Fetch ... Times` שנה את הפרמטר `place=`
  ב‑URL לעיר הרצויה (בעברית, מקודד URL).
- **צומות/ראש חודש** (Hebcal): ב‑node `Fetch Jerusalem Fasts` שנה את `geonameid`,
  וב‑`Fetch Efrat Fasts` שנה את `latitude`/`longitude`. רשימת geonameid:
  [GeoNames](https://www.geonames.org).

### שינוי שני המקומות לאחד
אם רוצים רק מיקום אחד, אפשר למחוק את ה‑nodes של המקום השני ולעדכן בהתאם את
`src/code-node.js` (החלקים שמשתמשים ב‑`efTimes` / `efHebcal`).

---

## פתרון תקלות

| תופעה | סיבה אפשרית |
|--------|--------------|
| לא מגיעה הודעת Telegram | Chat ID שגוי, או לא לחצת Start לבוט |
| `defaultData not found in HTML` | אתר ישיבה שינה מבנה — בדוק את ה‑URL/HTML |
| שגיאת OAuth ב‑Gmail | ה‑token פג; חדש את ה‑credential ב‑n8n |
| נשלח בזמן הלא נכון | בדוק את אזור הזמן של מופע ה‑n8n מול `Asia/Jerusalem` |
