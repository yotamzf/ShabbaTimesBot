# CLAUDE.md — הנחיות לעבודה על הריפו הזה

פרויקט: בוט n8n להתראות שבת/חג/ראש חודש/צומות ב‑Telegram וב‑Gmail.
הקוד הראשי הוא ה‑Code node שב‑`src/code-node.js`, וה‑workflow לייבוא ב‑`workflow/shabbat-chag-notifier.json`.

## 🔒 כלל אבטחה (חובה — לפני כל commit/push)

**לעולם אין לכתוב לריפו מידע רגיש.** לפני כל העלאה, ודא שאין:

- **טוקנים / מפתחות** — Telegram bot token, Gmail OAuth, API keys, refresh tokens.
- **סיסמאות** או credential secrets מכל סוג.
- **מידע אישי (PII)** — כתובות מייל אמיתיות, Telegram Chat ID, שמות, טלפונים,
  כתובות מגורים מדויקות.
- קבצי סודות — `.env`, `secrets.json`, `credentials.json`, תיקיית `.n8n/`
  (כבר חסומים ב‑`.gitignore`).

במקום ערכים אמיתיים השתמש ב‑placeholders בסגנון `REPLACE_WITH_...`.
קרדנשלים של n8n נשמרים מוצפנים בתוך n8n בלבד — אף פעם לא בקוד או ב‑JSON.

### לפני push — הרץ סריקה

```bash
grep -rniE "@gmail\.com|[0-9]{8,}:[A-Za-z0-9_-]{30,}|bot[0-9]{6,}:|chat[_ ]?id" . --exclude-dir=.git
```

אם משהו חוזר — עצור ונקה לפני ה‑push.

## ⚠️ כלל n8n חי

- העותק שב‑n8n הוא ה‑production. עבודה על הריפו היא **לתיעוד בלבד** ואינה משנה
  את ה‑workflow החי, אלא אם מבקשים במפורש.
- אין להריץ `update_workflow` / `archive_workflow` על ה‑workflow החי בלי אישור מפורש.
- כשמסנכרנים שינוי מהריפו ל‑n8n — לשמור על המייל/Chat ID/קרדנשלים האמיתיים שב‑n8n,
  ולא להחליף אותם ב‑placeholders.

## סגנון

- הקוד ב‑`src/code-node.js` חף מתלויות חיצוניות (רץ בתוך Code node של n8n) — לשמור כך.
- הודעות והערות בעברית במקומות הרלוונטיים, בהתאם לקוד הקיים.
