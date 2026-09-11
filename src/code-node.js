// Core logic for the Shabbat/Chag/Fast/Rosh-Chodesh/National-day notifier.
//
// This is the body of the "Decide and Build Email" Code node in the n8n
// workflow (workflow/shabbat-chag-notifier.json). It runs once per day, reads
// the four upstream HTTP fetches via n8n's $("<node>") accessor, decides which
// event(s) require a notification *today* (for tomorrow), and emits one n8n
// item per notification with: shouldNotify, subject, html (email) and telegram.
//
// No external dependencies and no secrets — credentials live only in the
// Gmail/Telegram nodes, managed encrypted by n8n. See README.md for details.

// ===================== תצורה =====================
// מקור הזמנים הראשי הוא Hebcal (REST API יציב), עם ue=on כדי שהחישוב
// יתחשב בגובה מעל פני הים. אתר ישיבה משמש רק להעשרת זמן רבינו תם,
// ש‑Hebcal אינו מספק בנקודת הקצה הזו.
//
// למה לא אתר ישיבה כמקור ראשי — נבדק 11.9.2026 מול נתונים חיים:
//   1. מערך times שלו מכסה שנה עברית אחת בדיוק. ב‑11.9.2026 השורה
//      האחרונה הייתה 5/9/2026, ולכן בערב ראש השנה הבוט "לא ראה" אירוע
//      ושתק — בלי שגיאה ובלי הודעה. חוזר על עצמו מדי שנה.
//      הפרמטר year= פותר את זה, אבל דורש למשוך שתי שנים עבריות ולמזג.
//   2. ב‑10‑11.9.2026 האתר היה חסום מאחורי Cloudflare והחזיר 403.
//
// דיוק: עם ue=on ההפרש בין Hebcal לאתר ישיבה נמדד כדקה אחת לכל היותר
// (ירושלים 18:14 מול 18:15, אפרת 18:35 מול 18:34 — שבת ראש השנה תשפ"ז).
//
// היסט הדלקת נרות בדקות לפני השקיעה — חייב להתאים לפרמטר b= שב‑URL.
const CANDLE_MIN_JM = 40; // מנהג ירושלים
const CANDLE_MIN_EF = 20; // אומת מול אתר ישיבה — הפרש דקה
// פער בדקות בין המקורות שמעליו מצורפת אזהרה להודעה.
const CROSSCHECK_TOLERANCE_MIN = 3;

const SOURCE_HEBCAL = { id: 'hebcal', label: 'לפי זמני Hebcal' };
const SOURCE_YESHIVA = { id: 'yeshiva', label: 'לפי זמני אתר ישיבה' };
const FALLBACK_NOTE = 'Hebcal לא החזיר זמנים לאירוע הזה — הזמנים לקוחים מאתר ישיבה.';

function decodeJsString(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (seq, c) => {
    if (c[0] === 'u' || c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
    switch (c) {
      case "'": return "'";
      case '"': return '"';
      case '\\': return '\\';
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      default: return c;
    }
  });
}

function extractTimes(html) {
  const m = html.match(/var defaultData = JSON\.parse\((['"])([\s\S]*?)\1\);/);
  if (!m) throw new Error('defaultData not found in HTML');
  const data = JSON.parse(decodeJsString(m[2]));
  return data.times || [];
}

// "D/M/YYYY" -> {y,m,d,key:yyyymmdd int, iso:'YYYY-MM-DD'}
function parseLoazi(s) {
  const [d, m, y] = s.split('/').map(n => parseInt(n, 10));
  return mkDate(y, m, d);
}
function mkDate(y, m, d) {
  const key = y * 10000 + m * 100 + d;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { y, m, d, key, iso };
}
function addDays(dt, n) {
  const base = new Date(Date.UTC(dt.y, dt.m - 1, dt.d));
  base.setUTCDate(base.getUTCDate() + n);
  return mkDate(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}
// minutes-since-midnight from "HH:MM" (or null for '---')
function timeToMin(t) {
  if (!t || t === '---') return null;
  const [h, mi] = t.split(':').map(n => parseInt(n, 10));
  return h * 60 + mi;
}

const CHAG_KEYWORDS = ['חג', 'ראש השנה', 'כיפור', 'סוכות', 'שמחת תורה', 'שמיני עצרת',
  'פסח', 'שבועות', 'יום העצמאות', 'פורים', 'חנוכה', 'של פסח'];
function isChag(text) { return CHAG_KEYWORDS.some(k => text.includes(k)); }

function labelFor(ev) {
  const text = (ev.text || '').trim();
  const isShabbat = ev.hebDate && ev.hebDate.dayOfWeekText === 'שבת';
  if (isShabbat && !isChag(text)) return `שבת פרשת ${text}`;
  return text;
}

function buildBlocks(times) {
  const blocks = [];
  let i = 0;
  while (i < times.length) {
    const start = i;
    while (i + 1 < times.length &&
      (times[i].endTime === '---' || times[i + 1].startTime === '---')) {
      i++;
    }
    blocks.push(times.slice(start, i + 1));
    i++;
  }
  return blocks;
}

function efMapByLoazi(efTimes) {
  const map = {};
  for (const t of efTimes) map[t.loaziDate] = t;
  return map;
}

function firstReal(block, field) {
  for (const ev of block) if (ev[field] && ev[field] !== '---') return ev[field];
  return null;
}
function lastReal(block, field) {
  for (let i = block.length - 1; i >= 0; i--) if (block[i][field] && block[i][field] !== '---') return block[i][field];
  return null;
}

function buildShabbatCandidates(jmTimes, efTimes) {
  const efMap = efMapByLoazi(efTimes);
  const blocks = buildBlocks(jmTimes);
  return blocks.map(block => {
    const firstEv = block[0];
    const lastEv = block[block.length - 1];
    const candleDate = addDays(parseLoazi(firstEv.loaziDate), -1);
    const havdalahDate = parseLoazi(lastEv.loaziDate);
    const efFirst = efMap[firstEv.loaziDate] || {};
    const efLast = efMap[lastEv.loaziDate] || {};
    return {
      kind: 'shabbat',
      names: block.map(labelFor),
      notify: candleDate,
      onsetKey: candleDate.key,
      onsetMin: timeToMin(firstReal(block, 'startTime')) || 0,
      jm: {
        candle: firstReal(block, 'startTime'),
        havdalah: lastReal(block, 'endTime'),
        havdalahRT: lastReal(block, 'endRTTime'),
      },
      ef: {
        candle: efFirst.startTime && efFirst.startTime !== '---' ? efFirst.startTime : firstReal(block, 'startTime'),
        havdalah: efLast.endTime && efLast.endTime !== '---' ? efLast.endTime : null,
        havdalahRT: efLast.endRTTime && efLast.endRTTime !== '---' ? efLast.endRTTime : null,
      },
      hebDateText: `${firstEv.hebDate.dayText} ${firstEv.hebDate.monthText}` +
        (block.length > 1 ? ` – ${lastEv.hebDate.dayText} ${lastEv.hebDate.monthText}` : ''),
      candleDateIso: candleDate.iso,
      havdalahDateIso: havdalahDate.iso,
    };
  });
}

// ============ מקור חלופי: בניית שבתות/חגים מ‑Hebcal ============
// Hebcal מחזיר פריטי candles/havdalah עם שעה מלאה בשדה date. רצף הדלקות
// ללא הבדלה ביניהן הוא בלוק רציף אחד — כך שבת שנכנסת לראש השנה מזוהה
// כאירוע אחד, בדיוק כמו ב‑buildBlocks של אתר ישיבה.

function hebcalItems(hebcal) { return (hebcal && hebcal.items) || []; }

function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return mkDate(y, m, d);
}

function hebcalBlocks(hebcal) {
  const items = hebcalItems(hebcal)
    .filter(it => it.category === 'candles' || it.category === 'havdalah')
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  const blocks = [];
  let cur = null;
  for (const it of items) {
    if (it.category === 'candles') {
      if (!cur) cur = { candles: [], havdalah: null };
      cur.candles.push(it);
    } else if (cur) {
      cur.havdalah = it;
      blocks.push(cur);
      cur = null;
    }
  }
  // בלוק שנחתך בקצה חלון הזמן נזרק — אין לו זמן צאת ולכן אין מה לדווח.
  return blocks;
}

// ימי האירוע עצמם: מיום אחרי ההדלקה הראשונה ועד יום ההבדלה, כולל.
function blockDayIsos(block) {
  const endKey = isoToKey(isoDatePart(block.havdalah.date));
  const out = [];
  let d = addDays(isoToDate(isoDatePart(block.candles[0].date)), 1);
  while (d.key <= endKey) { out.push(d.iso); d = addDays(d, 1); }
  return out;
}

function hebcalNamesFor(hebcal, dayIsos) {
  const items = hebcalItems(hebcal);
  const names = [];
  for (const iso of dayIsos) {
    const sameDay = items.filter(it => isoDatePart(it.date) === iso);
    // yomtov מבדיל יום טוב אמיתי (ראש השנה, פסח) מחנוכה/פורים שאינם חלים כאן.
    const yt = sameDay.find(it => it.category === 'holiday' && it.yomtov === true);
    if (yt) { names.push(yt.hebrew || yt.title); continue; }
    if (dowOfIso(iso) === 6) {
      const par = sameDay.find(it => it.category === 'parashat');
      names.push(par ? `שבת ${par.hebrew || par.title}` : 'שבת');
    }
  }
  return names.length ? names : ['שבת'];
}

function hebcalHebDateText(hebcal, dayIsos) {
  const it = hebcalItems(hebcal)
    .find(x => x.hdate && dayIsos.indexOf(isoDatePart(x.date)) !== -1);
  return it ? hdateToHebText(it.hdate) : '';
}

function buildShabbatCandidatesFromHebcal(jmHebcal, efHebcal) {
  const efByDate = {};
  for (const it of hebcalItems(efHebcal)) {
    if (it.category === 'candles' || it.category === 'havdalah') {
      efByDate[it.category + '|' + isoDatePart(it.date)] = it;
    }
  }
  return hebcalBlocks(jmHebcal).map(block => {
    const firstCandle = block.candles[0];
    const candleIso = isoDatePart(firstCandle.date);
    const candleDate = isoToDate(candleIso);
    const havdalahIso = isoDatePart(block.havdalah.date);
    const dayIsos = blockDayIsos(block);
    const efCandle = efByDate['candles|' + candleIso];
    const efHav = efByDate['havdalah|' + havdalahIso];
    return {
      kind: 'shabbat',
      names: hebcalNamesFor(jmHebcal, dayIsos),
      notify: candleDate,
      onsetKey: candleDate.key,
      onsetMin: timeToMin(isoTimePart(firstCandle.date)) || 0,
      jm: {
        candle: isoTimePart(firstCandle.date),
        havdalah: isoTimePart(block.havdalah.date),
        havdalahRT: null, // Hebcal אינו מספק כאן זמן רבינו תם
      },
      ef: {
        candle: efCandle ? isoTimePart(efCandle.date) : null,
        havdalah: efHav ? isoTimePart(efHav.date) : null,
        havdalahRT: null,
      },
      hebDateText: hebcalHebDateText(jmHebcal, dayIsos),
      candleDateIso: candleIso,
      havdalahDateIso: havdalahIso,
    };
  });
}

// ===== שילוב שני המקורות =====
// אתר ישיבה מחזיר שנה עברית אחת לכל בקשה, ולכן מושכים שתי שנים (הנוכחית
// והבאה) וממזגים — כך אין "חור" בערב ראש השנה כשהשנה מתחלפת.
function mergeYeshivaTimes(htmls) {
  const seen = {};
  const out = [];
  for (const html of htmls) {
    if (!html) continue;
    let rows;
    try { rows = extractTimes(html); } catch (e) { continue; }
    for (const r of rows) {
      if (seen[r.loaziDate]) continue;
      seen[r.loaziDate] = true;
      out.push(r);
    }
  }
  out.sort((a, b) => parseLoazi(a.loaziDate).key - parseLoazi(b.loaziDate).key);
  return out;
}

function minutesApart(a, b) {
  const x = timeToMin(a), y = timeToMin(b);
  if (x === null || y === null) return null;
  return Math.abs(x - y);
}

// Hebcal הוא המקור; מאתר ישיבה לוקחים רק את זמן רבינו תם, ומשווים את
// שאר הזמנים כבדיקת שפיות. פער חריג מסומן בהודעה במקום להיבלע.
function enrichFromYeshiva(hebcalCandidates, yeshivaCandidates) {
  const byDate = {};
  for (const y of yeshivaCandidates) byDate[y.candleDateIso] = y;
  for (const c of hebcalCandidates) {
    const y = byDate[c.candleDateIso];
    if (!y) continue;
    c.jm.havdalahRT = y.jm.havdalahRT || null;
    c.ef.havdalahRT = y.ef.havdalahRT || null;
    const deltas = [
      minutesApart(c.jm.candle, y.jm.candle),
      minutesApart(c.jm.havdalah, y.jm.havdalah),
      minutesApart(c.ef.candle, y.ef.candle),
      minutesApart(c.ef.havdalah, y.ef.havdalah),
    ].filter(d => d !== null);
    if (deltas.length) {
      const worst = Math.max.apply(null, deltas);
      c.crossCheckMaxDelta = worst;
      if (worst > CROSSCHECK_TOLERANCE_MIN) {
        c.crossCheckWarning = `פער של ${worst} דק׳ בין Hebcal לאתר ישיבה — כדאי לאמת ידנית.`;
      }
    }
  }
  return hebcalCandidates;
}

function isoDatePart(iso) { return iso.slice(0, 10); }
function isoTimePart(iso) {
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}
function isoToKey(isoDate) {
  const [y, m, d] = isoDate.split('-').map(n => parseInt(n, 10));
  return y * 10000 + m * 100 + d;
}

function buildFastCandidates(jmHebcal, efHebcal) {
  const jmItems = (jmHebcal && jmHebcal.items) || [];
  const efItems = (efHebcal && efHebcal.items) || [];
  const begins = jmItems.filter(it => it.category === 'zmanim' && it.subcat === 'fast' && /begins/i.test(it.title));
  const ends = jmItems.filter(it => it.category === 'zmanim' && it.subcat === 'fast' && /ends/i.test(it.title));
  const named = jmItems.filter(it => it.category === 'holiday' &&
    (it.subcat === 'fast' || it.subcat === 'major') && !/Erev/i.test(it.title));

  const efBegins = efItems.filter(it => it.category === 'zmanim' && it.subcat === 'fast' && /begins/i.test(it.title));
  const efEnds = efItems.filter(it => it.category === 'zmanim' && it.subcat === 'fast' && /ends/i.test(it.title));
  const efBeginByDate = {}; efBegins.forEach(b => efBeginByDate[isoDatePart(b.date)] = b);
  const efEndByDate = {}; efEnds.forEach(e => efEndByDate[isoDatePart(e.date)] = e);

  return begins.map(b => {
    const beginDate = isoDatePart(b.date);
    const beginKey = isoToKey(beginDate);
    const end = ends
      .filter(e => isoToKey(isoDatePart(e.date)) >= beginKey)
      .sort((x, y) => new Date(x.date) - new Date(y.date))[0];
    const endDate = end ? isoDatePart(end.date) : beginDate;
    const nm = named.find(n => {
      const k = isoToKey(isoDatePart(n.date));
      return k >= beginKey && k <= isoToKey(endDate);
    });
    const ef_b = efBeginByDate[beginDate];
    const ef_e = end ? efEndByDate[isoDatePart(end.date)] : null;
    const [y, m, d] = beginDate.split('-').map(n => parseInt(n, 10));
    const beginMin = (() => { const t = isoTimePart(b.date); return t !== null ? timeToMin(t) : 0; })();
    // הריצה היומית היא בבוקר (אחרי עלות השחר). צום מנהג (י"ז בתמוז, גדליה,
    // י' בטבת, אסתר) מתחיל בעלות השחר — התראה באותו בוקר כבר תאחר, לכן מודיעים
    // יום קודם. צום שמתחיל בערב שלפני (תשעה באב) מתחיל אחרי הבוקר, ולכן התראה
    // באותו בוקר עדיין מגיעה לפני תחילתו.
    const beginsInMorning = beginMin === null || beginMin < 12 * 60;
    const notifyDate = beginsInMorning ? addDays(mkDate(y, m, d), -1) : mkDate(y, m, d);
    return {
      kind: 'fast',
      names: [nm ? (nm.hebrew || nm.title) : (b.hebrew || 'צום')],
      notify: notifyDate,
      onsetKey: beginKey,
      onsetMin: beginMin,
      jm: { begin: isoTimePart(b.date), end: end ? isoTimePart(end.date) : null },
      ef: { begin: ef_b ? isoTimePart(ef_b.date) : isoTimePart(b.date), end: ef_e ? isoTimePart(ef_e.date) : (end ? isoTimePart(end.date) : null) },
      hebDateText: nm ? (nm.hebrew || '') : '',
      fastDateIso: nm ? isoDatePart(nm.date) : beginDate,
    };
  });
}

// ===================== Rosh Chodesh (halachic) =====================
// Verified Hebrew-calendar + molad math (Dershowitz–Reingold).
const HEB_EPOCH = -1373427; // R.D. of 1 Tishrei AM 1
function rcLeap(y) { return ((7 * y + 1) % 19) < 7; }
function rcElapsedDays(year) {
  const m = Math.floor((235 * year - 234) / 19);
  const parts = 12084 + 13753 * m;
  let day = 29 * m + Math.floor(parts / 25920);
  if (((3 * (day + 1)) % 7) < 3) day += 1;
  return day;
}
function rcDelay(year) {
  const a = rcElapsedDays(year - 1), b = rcElapsedDays(year), c = rcElapsedDays(year + 1);
  if (c - b === 356) return 2;
  if (b - a === 382) return 1;
  return 0;
}
function rcNewYear(year) { return HEB_EPOCH + rcElapsedDays(year) + rcDelay(year); }

// english Hebrew-month-name -> civil month index (1=Tishrei), leap-aware
function civilMonthIndex(name, year) {
  name = String(name).trim();
  const leap = rcLeap(year);
  const base = { Tishrei: 1, Cheshvan: 2, Kislev: 3, Tevet: 4, Shevat: 5 };
  if (base[name]) return base[name];
  if (leap) {
    if (name === 'Adar I' || name === 'Adar 1' || name === 'Adar') return 6;
    if (name === 'Adar II' || name === 'Adar 2') return 7;
    const m = { Nisan: 8, Iyar: 9, Iyyar: 9, Sivan: 10, Tamuz: 11, Tammuz: 11, Av: 12, Elul: 13 };
    return m[name] || null;
  }
  if (name === 'Adar' || name === 'Adar I' || name === 'Adar II') return 6;
  const m = { Nisan: 7, Iyar: 8, Iyyar: 8, Sivan: 9, Tamuz: 10, Tammuz: 10, Av: 11, Elul: 12 };
  return m[name] || null;
}
function moladOf(year, civilMonth) {
  const monthsToYear = Math.floor((235 * year - 234) / 19);
  const monthsElapsed = monthsToYear + (civilMonth - 1);
  const parts = 12084 + 13753 * monthsElapsed;
  const day = 29 * monthsElapsed + Math.floor(parts / 25920);
  const chalakimInDay = parts % 25920;
  const moladRD = HEB_EPOCH + day;
  const weekday = ((moladRD % 7) + 7) % 7; // 0=Sunday
  const h = Math.floor(chalakimInDay / 1080);
  const remp = chalakimInDay % 1080;
  const min = Math.floor(remp / 18);
  const chal = remp % 18;
  const civilHour = (18 + h) % 24;
  return { weekday, h, min, chal, civilHour };
}

const HEB_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function dowOfIso(iso) {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
}

// Hebrew numerals (gematria) for day-of-month / year
function hebNumRaw(n) {
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  const huns = ['', 'ק', 'ר', 'ש', 'ת', 'תק', 'תר', 'תש', 'תת', 'תתק'];
  let s = huns[Math.floor(n / 100) % 10] || '';
  const r = n % 100;
  if (r === 15) s += 'טו';
  else if (r === 16) s += 'טז';
  else { s += tens[Math.floor(r / 10)]; s += ones[r % 10]; }
  return s;
}
function withGershayim(s) {
  if (!s) return s;
  if (s.length === 1) return s + '׳';
  return s.slice(0, -1) + '״' + s.slice(-1);
}
function hebDay(n) { return withGershayim(hebNumRaw(n)); }
function hebYear(y) { return 'ה׳' + withGershayim(hebNumRaw(y % 1000)); }

const BIBLICAL_ORD_WORD = ['', 'הראשון', 'השני', 'השלישי', 'הרביעי', 'החמישי', 'השישי',
  'השביעי', 'השמיני', 'התשיעי', 'העשירי', 'האחד־עשר', 'השנים־עשר', 'השלושה־עשר'];

function buildRoshChodeshCandidates(jmHebcal) {
  const items = ((jmHebcal && jmHebcal.items) || [])
    .filter(it => it.category === 'roshchodesh')
    .slice()
    .sort((a, b) => isoToKey(isoDatePart(a.date)) - isoToKey(isoDatePart(b.date)));
  // group consecutive days with the same hebrew name into one RC event (1 or 2 days)
  const groups = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    const k = isoToKey(isoDatePart(it.date));
    if (last && last.name === it.hebrew &&
        k === isoToKey(isoDatePart(last.items[last.items.length - 1].date)) + 1) {
      last.items.push(it);
    } else {
      groups.push({ name: it.hebrew, items: [it] });
    }
  }
  const out = [];
  for (const g of groups) {
    const first = g.items[0];
    const dayOne = g.items.find(it => /^1\s/.test(it.hdate)) || g.items[g.items.length - 1];
    // hdate like "1 Tamuz 5786" / "30 Sivan 5786" / "1 Adar II 5784"
    const parts = dayOne.hdate.trim().split(/\s+/);
    const year = parseInt(parts[parts.length - 1], 10);
    const monthEng = parts.slice(1, parts.length - 1).join(' ');
    const monthHe = (g.name || '').replace(/^ראש חודש\s*/, '').trim();
    const twoDay = g.items.length > 1;

    const dows = g.items.map(it => HEB_DOW[dowOfIso(isoDatePart(it.date))]);
    const hebDates = g.items.map(it => {
      const p = it.hdate.trim().split(/\s+/);
      return hebDay(parseInt(p[0], 10));
    });

    const memo = first.memo || '';
    const daysM = memo.match(/has\s+(\d+)\s+days/i);
    const bibM = memo.match(/(\d+)(?:st|nd|rd|th)\s+month\s+of\s+the\s+biblical/i);
    const ci = civilMonthIndex(monthEng, year);
    const molad = ci ? moladOf(year, ci) : null;

    const yearHe = hebYear(year);
    const spanHe = twoDay
      ? `${hebDates[0]} ב${prevMonthHe(g)} – ${hebDates[1]} ב${monthHe} ${yearHe}`
      : `${hebDates[0]} ב${monthHe} ${yearHe}`;

    // One candidate PER Rosh-Chodesh day; each notifies on the morning before it.
    g.items.forEach((it, i) => {
      const iso = isoDatePart(it.date);
      const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
      out.push({
        kind: 'roshchodesh',
        monthHe,
        names: [`ראש חודש ${monthHe}`],
        notify: addDays(mkDate(y, m, d), -1),
        onsetKey: isoToKey(iso),
        onsetMin: 0,
        twoDay,
        dayIndex: i + 1,
        totalDays: g.items.length,
        thisDow: dows[i],
        thisHebDate: hebDates[i],
        dows,
        hebDates,
        hebDateText: spanHe,
        daysInMonth: daysM ? parseInt(daysM[1], 10) : null,
        biblicalOrd: bibM ? parseInt(bibM[1], 10) : null,
        molad,
        dayIso: iso,
      });
    });
  }
  return out;
}
function prevMonthHe(g) {
  // the outgoing month appears in the "30 X" item hebrew? hebrew name is the incoming month;
  // derive outgoing month from the 30-day item's hdate english -> not available in Hebrew here,
  // so fall back to a transliteration map.
  const dayThirty = g.items.find(it => /^30\s/.test(it.hdate));
  if (!dayThirty) return g.name.replace(/^ראש חודש\s*/, '').trim();
  const p = dayThirty.hdate.trim().split(/\s+/);
  const eng = p.slice(1, p.length - 1).join(' ');
  return HEB_MONTH_NAME[eng] || eng;
}
const HEB_MONTH_NAME = {
  Tishrei: 'תשרי', Cheshvan: 'חשון', Kislev: 'כסלו', Tevet: 'טבת', Shevat: 'שבט',
  "Sh'vat": 'שבט', Adar: 'אדר', 'Adar I': 'אדר א׳', 'Adar II': 'אדר ב׳', Nisan: 'ניסן',
  Iyar: 'אייר', Iyyar: 'אייר', Sivan: 'סיון', Tamuz: 'תמוז', Tammuz: 'תמוז', Av: 'אב', Elul: 'אלול',
};

// ===================== ימים לאומיים (מודרניים) =====================
// Hebcal כבר מחזיר אותם (mod=on ב‑URL): category 'holiday', subcat 'modern'.
// ההתראה נשלחת בבוקר שלפני היום; בימים שנפתחים בטקס ערב (יום השואה, יום
// הזיכרון, יום העצמאות, יום ירושלים) הנוסח מציין שהערב נכנס היום.
const NATIONAL_DAYS = {
  'Yom HaShoah': {
    name: 'יום הזיכרון לשואה ולגבורה', emoji: '🕯️', eveOnset: true,
    desc: 'יום הזיכרון הממלכתי לשואה ולגבורה (כ״ז בניסן). טקס ממלכתי ביד ושם בערב, וצפירת דומייה בשעה 10:00 בבוקר.',
  },
  'Yom HaZikaron': {
    name: 'יום הזיכרון לחללי מערכות ישראל ולנפגעי פעולות האיבה', emoji: '🎗️', eveOnset: true,
    desc: 'יום הזיכרון הממלכתי לחללי מערכות ישראל ולנפגעי פעולות האיבה (ד׳ באייר). צפירה בשעה 20:00 בערב ובשעה 11:00 בבוקר.',
  },
  "Yom HaAtzma'ut": {
    name: 'יום העצמאות', emoji: '🇮🇱', eveOnset: true, greeting: 'חג עצמאות שמח! 🇮🇱',
    desc: 'יום העצמאות של מדינת ישראל (ה׳ באייר). החגיגות נפתחות בערב עם טקס הדלקת המשואות בהר הרצל.',
  },
  'Yom Yerushalayim': {
    name: 'יום ירושלים', emoji: '🦁', eveOnset: true, greeting: 'חג ירושלים שמח!',
    desc: 'יום איחוד ירושלים (כ״ח באייר) — ציון שחרור העיר העתיקה והכותל המערבי במלחמת ששת הימים (תשכ״ז).',
  },
  'Yom HaAliyah': {
    name: 'יום העלייה', emoji: '✈️',
    desc: 'יום ציון חשיבות העלייה לארץ ישראל (י׳ בניסן) — התאריך שבו חצה עם ישראל את הירדן ונכנס לארץ.',
  },
  'Sigd': {
    name: 'חג הסיגד', emoji: '🙏', greeting: 'חג סיגד שמח!',
    desc: 'חגה של קהילת ביתא ישראל — יהדות אתיופיה (כ״ט בחשוון), חמישים יום אחרי יום הכיפורים — יום צום, תפילה וכמיהה לציון.',
  },
  'Herzl Day': {
    name: 'יום הרצל', emoji: '🎩',
    desc: 'יום ממלכתי לציון פועלו וחזונו של בנימין זאב הרצל, חוזה המדינה, ביום הולדתו (י׳ באייר).',
  },
  'Jabotinsky Day': {
    name: 'יום ז׳בוטינסקי', emoji: '🎗️',
    desc: 'יום ממלכתי לציון פועלו וחזונו של זאב ז׳בוטינסקי, ביום פטירתו (כ״ט בתמוז), לפי חוק יום ז׳בוטינסקי התשס״ה.',
  },
  'Yitzhak Rabin Memorial Day': {
    name: 'יום הזיכרון ליצחק רבין', emoji: '🕯️',
    desc: 'יום הזיכרון הממלכתי לראש הממשלה יצחק רבין ז״ל, בתאריך העברי של הירצחו (י״ב בחשוון).',
  },
  'Ben-Gurion Day': {
    name: 'יום בן־גוריון', emoji: '🎗️',
    desc: 'יום ממלכתי לציון פועלו של דוד בן־גוריון, ראש הממשלה הראשון, בתאריך העברי של פטירתו (ו׳ בכסלו).',
  },
  'Family Day': {
    name: 'יום המשפחה', emoji: '👨‍👩‍👧‍👦',
    desc: 'יום המשפחה בישראל (ל׳ בשבט) — יום הולדתה של הנרייטה סאלד, מייסדת "הדסה" ואם עליית הנוער.',
  },
  'Hebrew Language Day': {
    name: 'יום הלשון העברית', emoji: '✍️',
    desc: 'יום הלשון העברית (כ״א בטבת) — יום הולדתו של אליעזר בן־יהודה, מחיה הדיבור העברי.',
  },
};

// התאמה עמידה לשינויי גרשיים/מקפים בכותרות של Hebcal
function normTitle(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
const NATIONAL_BY_NORM = {};
for (const k of Object.keys(NATIONAL_DAYS)) NATIONAL_BY_NORM[normTitle(k)] = NATIONAL_DAYS[k];

// hdate like "29 Tamuz 5786" -> "כ״ט בתמוז ה׳תשפ״ו"
function hdateToHebText(hdate) {
  const p = String(hdate || '').trim().split(/\s+/);
  if (p.length < 3) return '';
  const day = hebDay(parseInt(p[0], 10));
  const eng = p.slice(1, p.length - 1).join(' ');
  const month = HEB_MONTH_NAME[eng] || eng;
  return `${day} ב${month} ${hebYear(parseInt(p[p.length - 1], 10))}`;
}

function buildNationalCandidates(jmHebcal) {
  const items = ((jmHebcal && jmHebcal.items) || [])
    .filter(it => it.category === 'holiday' && it.subcat === 'modern')
    .filter(it => !/school observance/i.test(it.title || ''));
  return items.map(it => {
    const iso = isoDatePart(it.date);
    const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
    const info = NATIONAL_BY_NORM[normTitle(it.title)] || {};
    return {
      kind: 'national',
      names: [info.name || it.hebrew || it.title],
      notify: addDays(mkDate(y, m, d), -1),
      onsetKey: isoToKey(iso),
      onsetMin: 0,
      emoji: info.emoji || '🇮🇱',
      desc: info.desc || '',
      greeting: info.greeting || null,
      eveOnset: !!info.eveOnset,
      thisDow: HEB_DOW[dowOfIso(iso)],
      hebDateText: hdateToHebText(it.hdate),
      dayIso: iso,
    };
  });
}

function nationalLeadLine(c) {
  return c.eveOnset
    ? `הערב ייכנס ${c.names[0]}, שיחול מחר — יום ${c.thisDow}, ${c.hebDateText}.`
    : `מחר, יום ${c.thisDow} (${c.hebDateText}), יחול ${c.names[0]}.`;
}
function isoToLoazi(iso) {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return `${d}.${m}.${y}`;
}

function moladText(m) {
  if (!m) return null;
  const ampm = (() => {
    const h = m.civilHour;
    if (h < 5) return 'לאחר חצות הלילה';
    if (h < 12) return 'בבוקר';
    if (h === 12) return 'בצהריים';
    if (h < 18) return 'אחר הצהריים';
    if (h < 21) return 'בערב';
    return 'בלילה';
  })();
  const hh = String(m.civilHour).padStart(2, '0');
  const mm = String(m.min).padStart(2, '0');
  return `יום ${HEB_DOW[m.weekday]}, בשעה ${hh}:${mm} ו-${m.chal} חלקים (${ampm})`;
}

function rcAnnouncementLine(c) {
  const dayList = c.twoDay
    ? `ביום ${c.dows[0]} וביום ${c.dows[1]}`
    : `ביום ${c.dows[0]}`;
  return `ראש חודש ${c.monthHe} יהיה ${dayList}, הבא עלינו ועל כל ישראל לטובה.`;
}
// Day-specific lead: the notification runs in the MORNING of erev (the day before this RC day).
function rcLeadLine(c) {
  if (c.totalDays === 1) {
    return `הערב נכנס ראש חודש ${c.monthHe}. ראש חודש יחול מחר, ביום ${c.thisDow}.`;
  }
  if (c.dayIndex === 1) {
    return `הערב נכנס ראש חודש ${c.monthHe} — יומו הראשון (מחר, יום ${c.dows[0]}). ראש חודש בן יומיים: יום ${c.dows[0]} ויום ${c.dows[1]}.`;
  }
  return `היום (יום ${c.dows[0]}) יומו הראשון של ראש חודש ${c.monthHe}; הערב נכנס יומו השני (מחר, יום ${c.dows[1]}).`;
}
function rcTitle(c) {
  if (c.totalDays === 2 && c.dayIndex === 2) return `🌙 ראש חודש ${c.monthHe} — לקראת היום השני`;
  return `🌙 ערב ראש חודש ${c.monthHe}`;
}
function rcMonthLine(c) {
  const bits = [];
  if (c.biblicalOrd && BIBLICAL_ORD_WORD[c.biblicalOrd]) {
    bits.push(`חודש ${c.monthHe} — החודש ${BIBLICAL_ORD_WORD[c.biblicalOrd]} למניין חודשי השנה (מניסן)`);
  } else {
    bits.push(`חודש ${c.monthHe}`);
  }
  if (c.daysInMonth) bits.push(`${c.daysInMonth} ימים`);
  bits.push(c.twoDay ? 'ראש חודש בן יומיים' : 'ראש חודש בן יום אחד');
  return bits.join(' · ');
}

// =================== renderers ===================
function renderShabbatHtml(c) {
  const title = c.names.join(' + ');
  const rtRow = (c.jm.havdalahRT || c.ef.havdalahRT)
    ? `<tr><td style="padding:6px 14px;color:#7a8aa0;font-size:13px;">צאת שבת/חג (ר"ת)</td>
         <td style="padding:6px 14px;color:#7a8aa0;font-size:13px;text-align:center;">${c.jm.havdalahRT || '—'}</td>
         <td style="padding:6px 14px;color:#7a8aa0;font-size:13px;text-align:center;">${c.ef.havdalahRT || '—'}</td></tr>`
    : '';
  const banner = noticeHtml(c);
  return baseEmail(`🕯️ ${title}`, c.hebDateText, `
    ${banner}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;">
      <tr style="background:#1b3a5b;color:#fff;">
        <th style="padding:10px 14px;text-align:right;font-size:14px;font-weight:600;">זמן</th>
        <th style="padding:10px 14px;text-align:center;font-size:14px;font-weight:600;">ירושלים</th>
        <th style="padding:10px 14px;text-align:center;font-size:14px;font-weight:600;">אפרת</th>
      </tr>
      <tr style="background:#f4f7fb;">
        <td style="padding:12px 14px;font-weight:600;color:#1b3a5b;">הדלקת נרות / כניסה</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#c0392b;">${c.jm.candle || '—'}</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#c0392b;">${c.ef.candle || '—'}</td>
      </tr>
      <tr>
        <td style="padding:12px 14px;font-weight:600;color:#1b3a5b;">צאת שבת / חג</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#2c5d8f;">${c.jm.havdalah || '—'}</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#2c5d8f;">${c.ef.havdalah || '—'}</td>
      </tr>
      ${rtRow}
    </table>`, { footer: `שבת שלום ומבורך · נשלח אוטומטית ${c.sourceLabel || SOURCE_HEBCAL.label}` });
}

// באנר צהוב רק כשבאמת יש מה לומר: מקור חלופי, או פער חריג בין המקורות.
function noticeHtml(c) {
  const bits = [];
  if (c.sourceNote) bits.push(c.sourceNote);
  if (c.crossCheckWarning) bits.push(c.crossCheckWarning);
  if (!bits.length) return '';
  return `<div style="background:#fff6e5;border:1px solid #f0c674;border-radius:10px;padding:10px 12px;margin-bottom:4px;color:#8a5a00;font-size:13px;line-height:1.55;">⚠️ ${bits.join('<br>')}</div>`;
}

function renderAlertHtml() {
  return baseEmail('⚠️ הבוט לא הצליח להביא זמנים', '', `
    <div style="font-size:15px;line-height:1.7;color:#333;">
      גם אתר ישיבה וגם Hebcal לא החזירו זמני שבת/חג בריצה של היום.<br>
      ייתכן שיש אירוע היום או מחר שלא נשלחה עליו התראה — כדאי לבדוק את הזמנים ידנית.
    </div>`, {
    grad: 'linear-gradient(135deg,#8a3b12,#c0392b)',
    subColor: '#f6d5c8',
    footer: 'התראת תקלה אוטומטית · Shabbat & Chag Times Notifier',
  });
}

function renderAlertTelegram() {
  return [
    '⚠️ <b>הבוט לא הצליח להביא זמנים</b>',
    '',
    'גם אתר ישיבה וגם Hebcal לא החזירו זמני שבת/חג בריצה של היום.',
    'ייתכן שיש אירוע היום או מחר שלא נשלחה עליו התראה — כדאי לבדוק ידנית.',
  ].join('\n');
}

function renderFastHtml(c) {
  return baseEmail(`🕯️ ${c.names[0]}`, c.hebDateText, `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:8px;">
      <tr style="background:#5b3a1b;color:#fff;">
        <th style="padding:10px 14px;text-align:right;font-size:14px;font-weight:600;">זמן הצום</th>
        <th style="padding:10px 14px;text-align:center;font-size:14px;font-weight:600;">ירושלים</th>
        <th style="padding:10px 14px;text-align:center;font-size:14px;font-weight:600;">אפרת</th>
      </tr>
      <tr style="background:#faf6f1;">
        <td style="padding:12px 14px;font-weight:600;color:#5b3a1b;">תחילת הצום</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#c0392b;">${c.jm.begin || '—'}</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#c0392b;">${c.ef.begin || '—'}</td>
      </tr>
      <tr>
        <td style="padding:12px 14px;font-weight:600;color:#5b3a1b;">סיום הצום</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#2c5d8f;">${c.jm.end || '—'}</td>
        <td style="padding:12px 14px;text-align:center;font-size:20px;font-weight:700;color:#2c5d8f;">${c.ef.end || '—'}</td>
      </tr>
    </table>`, { footer: `צום קל ומועיל · נשלח אוטומטית ${c.sourceLabel || SOURCE_HEBCAL.label}` });
}

function renderRoshChodeshHtml(c) {
  const moladHtml = c.molad ? `
      <tr style="background:#f3f1fb;">
        <td style="padding:12px 14px;font-weight:600;color:#3b2f6b;">המולד</td>
        <td style="padding:12px 14px;color:#2c2350;font-size:15px;">${moladText(c.molad)}</td>
      </tr>` : '';
  return baseEmail(rcTitle(c), c.hebDateText, `
    <div style="font-size:17px;line-height:1.7;color:#2c2350;font-weight:700;margin:4px 2px 10px;">
      ${rcLeadLine(c)}
    </div>
    <div style="font-size:15px;line-height:1.7;color:#4a4270;margin:0 2px 14px;">
      ${rcAnnouncementLine(c)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:4px;">
      <tr style="background:#3b2f6b;color:#fff;">
        <th style="padding:10px 14px;text-align:right;font-size:14px;font-weight:600;" colspan="2">פרטי החודש</th>
      </tr>
      <tr style="background:#f3f1fb;">
        <td style="padding:12px 14px;font-weight:600;color:#3b2f6b;width:38%;">החודש הבא</td>
        <td style="padding:12px 14px;color:#2c2350;font-size:15px;">${rcMonthLine(c)}</td>
      </tr>
      <tr>
        <td style="padding:12px 14px;font-weight:600;color:#3b2f6b;">ימי ראש חודש</td>
        <td style="padding:12px 14px;color:#2c2350;font-size:15px;">${c.twoDay ? `${c.hebDates[0]} (יום ${c.dows[0]}) ו-${c.hebDates[1]} (יום ${c.dows[1]})` : `${c.hebDates[0]} (יום ${c.dows[0]})`}</td>
      </tr>
      ${moladHtml}
    </table>
    <div style="font-size:13px;color:#7a748f;margin-top:14px;line-height:1.6;">
      מברכים את החודש בשבת שלפניו (שבת מברכים). חודש טוב ומבורך! 🌱
    </div>`, {
    grad: 'linear-gradient(135deg,#3b2f6b,#5b4b9e)',
    subColor: '#d9d2f0',
    footer: 'חודש טוב ומבורך · נשלח אוטומטית לפי לוח השנה העברי',
  });
}

function renderNationalHtml(c) {
  const descHtml = c.desc ? `
    <div style="font-size:15px;line-height:1.7;color:#2a3b5c;margin:0 2px 14px;">
      ${c.desc}
    </div>` : '';
  const greetHtml = c.greeting ? `
    <div style="font-size:16px;font-weight:700;color:#0038b8;margin-top:14px;text-align:center;">
      ${c.greeting}
    </div>` : '';
  return baseEmail(`${c.emoji} ${c.names[0]}`, c.hebDateText, `
    <div style="font-size:17px;line-height:1.7;color:#1b2b4b;font-weight:700;margin:4px 2px 12px;">
      ${nationalLeadLine(c)}
    </div>
    ${descHtml}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:4px;">
      <tr style="background:#0038b8;color:#fff;">
        <th style="padding:10px 14px;text-align:right;font-size:14px;font-weight:600;" colspan="2">פרטי היום</th>
      </tr>
      <tr style="background:#f0f4fd;">
        <td style="padding:12px 14px;font-weight:600;color:#0038b8;width:38%;">תאריך עברי</td>
        <td style="padding:12px 14px;color:#1b2b4b;font-size:15px;">${c.hebDateText}</td>
      </tr>
      <tr>
        <td style="padding:12px 14px;font-weight:600;color:#0038b8;">תאריך לועזי</td>
        <td style="padding:12px 14px;color:#1b2b4b;font-size:15px;">יום ${c.thisDow}, ${isoToLoazi(c.dayIso)}</td>
      </tr>
    </table>
    ${greetHtml}`, {
    grad: 'linear-gradient(135deg,#0038b8,#3a66c9)',
    subColor: '#cfe0ff',
    footer: 'נשלח אוטומטית לפי הלוח העברי',
  });
}

function renderTelegram(c) {
  if (c.kind === 'alert') return renderAlertTelegram();
  if (c.kind === 'national') {
    const lines = [
      `${c.emoji} <b>${c.names[0]}</b>`,
      c.hebDateText,
      '',
      `<b>${nationalLeadLine(c)}</b>`,
    ];
    if (c.desc) lines.push('', c.desc);
    if (c.greeting) lines.push('', c.greeting);
    lines.push('', 'נשלח אוטומטית לפי הלוח העברי');
    return lines.join('\n');
  }
  if (c.kind === 'roshchodesh') {
    const lines = [
      `${rcTitle(c)}`,
      c.hebDateText,
      '',
      `<b>${rcLeadLine(c)}</b>`,
      '',
      rcAnnouncementLine(c),
      '',
      `📅 ${rcMonthLine(c)}`,
    ];
    if (c.molad) {
      lines.push('', '🌒 <b>המולד</b>', moladText(c.molad));
    }
    lines.push('', 'מברכים את החודש בשבת שלפניו · חודש טוב ומבורך');
    return lines.join('\n');
  }
  const head = `🕯️ <b>${c.names.join(' + ')}</b>` + (c.hebDateText ? `\n${c.hebDateText}` : '');
  if (c.kind === 'fast') {
    return [
      head, '',
      '🟤 <b>תחילת הצום</b>',
      `ירושלים: ${c.jm.begin || '—'}`,
      `אפרת: ${c.ef.begin || '—'}`,
      '',
      '🔵 <b>סיום הצום</b>',
      `ירושלים: ${c.jm.end || '—'}`,
      `אפרת: ${c.ef.end || '—'}`,
      '',
      `צום קל ומועיל · ${c.sourceLabel || SOURCE_HEBCAL.label}`,
    ].join('\n');
  }
  const lines = [
    head, '',
    '🟢 <b>הדלקת נרות / כניסה</b>',
    `ירושלים: ${c.jm.candle || '—'}`,
    `אפרת: ${c.ef.candle || '—'}`,
    '',
    '🔵 <b>צאת שבת / חג</b>',
    `ירושלים: ${c.jm.havdalah || '—'}`,
    `אפרת: ${c.ef.havdalah || '—'}`,
  ];
  if (c.jm.havdalahRT || c.ef.havdalahRT) {
    lines.push(`<i>צאת ר"ת — ירושלים: ${c.jm.havdalahRT || '—'} · אפרת: ${c.ef.havdalahRT || '—'}</i>`);
  }
  if (c.sourceNote) lines.push('', `⚠️ <i>${c.sourceNote}</i>`);
  if (c.crossCheckWarning) lines.push('', `⚠️ <i>${c.crossCheckWarning}</i>`);
  lines.push('', `שבת שלום ומבורך · ${c.sourceLabel || SOURCE_HEBCAL.label}`);
  return lines.join('\n');
}

function baseEmail(title, subtitle, bodyHtml, opts) {
  opts = opts || {};
  const grad = opts.grad || 'linear-gradient(135deg,#1b3a5b,#2c5d8f)';
  const subColor = opts.subColor || '#cdddf0';
  const footer = opts.footer || 'שבת שלום ומבורך · נשלח אוטומטית לפי זמני אתר ישיבה';
  return `<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:'Segoe UI',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(27,58,91,.12);">
        <tr><td style="background:${grad};padding:26px 24px;text-align:center;">
          <div style="font-size:24px;font-weight:700;color:#fff;line-height:1.3;">${title}</div>
          ${subtitle ? `<div style="font-size:15px;color:${subColor};margin-top:6px;">${subtitle}</div>` : ''}
        </td></tr>
        <tr><td style="padding:20px 22px 8px;">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:14px 22px 24px;text-align:center;color:#9aa7b8;font-size:12px;">
          ${footer}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function subjectFor(c) {
  if (c.kind === 'alert') return '⚠️ הבוט לא הצליח להביא זמני שבת/חג';
  if (c.kind === 'national') {
    return c.eveOnset
      ? `${c.names[0]} — הערב ומחר (יום ${c.thisDow})`
      : `${c.names[0]} — מחר, יום ${c.thisDow}`;
  }
  if (c.kind === 'fast') return `${c.names[0]} — זמני הצום (ירושלים ואפרת)`;
  if (c.kind === 'roshchodesh') {
    return (c.totalDays === 2 && c.dayIndex === 2)
      ? `ראש חודש ${c.monthHe} — מחר היום השני (יום ${c.thisDow})`
      : `ערב ראש חודש ${c.monthHe} — מחר יום ${c.thisDow}`;
  }
  return `זמני ${c.names.join(' + ')} — ירושלים ואפרת`;
}
function htmlFor(c) {
  if (c.kind === 'alert') return renderAlertHtml();
  if (c.kind === 'fast') return renderFastHtml(c);
  if (c.kind === 'roshchodesh') return renderRoshChodeshHtml(c);
  if (c.kind === 'national') return renderNationalHtml(c);
  return renderShabbatHtml(c);
}

function buildResults(input) {
  // מקור ראשי: Hebcal. אתר ישיבה משמש להעשרת ר"ת ולהצלבה.
  let shabbatSource = SOURCE_HEBCAL;
  let hebcalShabbat = [];
  try {
    hebcalShabbat = buildShabbatCandidatesFromHebcal(input.jmShabbat, input.efShabbat);
  } catch (e) {
    hebcalShabbat = [];
  }

  let yeshivaShabbat = [];
  try {
    const jmRows = mergeYeshivaTimes(input.jmHtmls || []);
    const efRows = mergeYeshivaTimes(input.efHtmls || []);
    if (jmRows.length) yeshivaShabbat = buildShabbatCandidates(jmRows, efRows);
  } catch (e) {
    yeshivaShabbat = [];
  }

  const today = input.today;
  const dueIn = list => list.filter(c => c.notify.key === today.key);

  // הצלבה: אם מקור אחד מזהה אירוע להיום והשני שותק — הולכים אחרי זה
  // שיש לו נתונים, במקום לשתוק. זה הבאג שהפיל את ערב ראש השנה תשפ"ז.
  let shabbat;
  let sourceNote = null;
  if (dueIn(hebcalShabbat).length > 0 || dueIn(yeshivaShabbat).length === 0) {
    shabbat = enrichFromYeshiva(hebcalShabbat, yeshivaShabbat);
  } else {
    shabbat = yeshivaShabbat;
    shabbatSource = SOURCE_YESHIVA;
    sourceNote = FALLBACK_NOTE;
  }
  const shabbatDown = dueIn(hebcalShabbat).length === 0 && dueIn(yeshivaShabbat).length === 0
    && hebcalShabbat.length === 0 && yeshivaShabbat.length === 0;
  shabbat.forEach(c => {
    c.sourceLabel = shabbatSource.label;
    if (sourceNote) c.sourceNote = sourceNote;
  });

  const fasts = buildFastCandidates(input.jmHebcal, input.efHebcal);
  const rc = buildRoshChodeshCandidates(input.jmHebcal);
  const national = buildNationalCandidates(input.jmHebcal);
  const all = shabbat.concat(fasts).concat(rc).concat(national);
  all.forEach(c => { if (!c.sourceLabel) c.sourceLabel = SOURCE_HEBCAL.label; });

  const dueToday = all.filter(c => c.notify.key === today.key);
  dueToday.sort((a, b) => (a.onsetKey - b.onsetKey) || (a.onsetMin - b.onsetMin));

  // שני המקורות נפלו — שולחים התראת תקלה במקום להיכשל בשקט.
  if (shabbatDown) {
    dueToday.unshift({ kind: 'alert', names: ['תקלה בבוט'], notify: today, onsetKey: today.key, onsetMin: 0 });
  }

  if (dueToday.length === 0) {
    const upcoming = all.filter(c => c.onsetKey >= today.key)
      .sort((a, b) => (a.onsetKey - b.onsetKey) || (a.onsetMin - b.onsetMin))[0];
    return [{
      shouldNotify: false,
      reason: 'no event due today',
      nearest: upcoming ? { kind: upcoming.kind, names: upcoming.names, notify: upcoming.notify.iso } : null,
    }];
  }

  return dueToday.map(chosen => ({
    shouldNotify: true,
    kind: chosen.kind,
    subject: subjectFor(chosen),
    html: htmlFor(chosen),
    telegram: renderTelegram(chosen),
    chosen,
  }));
}

// ===== n8n entry =====
// כל נודי ה‑HTTP מוגדרים עם onError: "continueRegularOutput", כך שמקור שנופל
// (403 של Cloudflare, timeout) מעביר הלאה פריט עם שדה error במקום להפיל את כל
// הריצה. safeNode מחזיר null במקרה כזה, ו‑buildResults מחליט איך להתמודד.
function safeNode(name) {
  try {
    const j = $(name).first().json;
    if (!j || j.error) return null;
    return j;
  } catch (e) {
    return null;
  }
}
function safeHtml(name) {
  const j = safeNode(name);
  return j && typeof j.data === 'string' ? j.data : null;
}

// אתר ישיבה מחזיר שנה עברית אחת לכל בקשה, ולכן מושכים שתי שנים לכל עיר
// וממזגים. בלי זה נוצר "חור" בערב ראש השנה, כשהשנה מתחלפת.
const jmHtmls = [safeHtml("Fetch Jerusalem Times"), safeHtml("Fetch Jerusalem Times (Next Year)")];
const efHtmls = [safeHtml("Fetch Efrat Times"), safeHtml("Fetch Efrat Times (Next Year)")];
const jmHebcal = safeNode("Fetch Jerusalem Fasts");
const efHebcal = safeNode("Fetch Efrat Fasts");
const jmShabbat = safeNode("Fetch Jerusalem Shabbat (Hebcal)");
const efShabbat = safeNode("Fetch Efrat Shabbat (Hebcal)");
const now = $now.setZone("Asia/Jerusalem");
const today = mkDate(now.year, now.month, now.day);
const results = buildResults({ jmHtmls, efHtmls, jmHebcal, efHebcal, jmShabbat, efShabbat, today });
return results.map(r => ({ json: r }));
