// "Format a number" of the Manipulate Text block: 1,249 / 1.2K / 1st /
// words / Roman numerals / binary / hex, in English or German.

import { GraphError } from './interpreter.js';

export type NumberStyle = 'grouped' | 'compact' | 'ordinal' | 'words' | 'roman' | 'binary' | 'hex';
export type NumberLocale = 'en' | 'de';

/** Largest whole number the integer styles accept (words, binary, hex). */
const MAX_WHOLE = Number.MAX_SAFE_INTEGER;

/** Reads "1249", " 1249.5 ", "-3" and also "1,249" (en) or "1.249,5" (de). */
export function parseNumber(text: string, locale: NumberLocale): number {
  let t = text.trim().replace(/[\s_']/g, '');
  if (/^-?\d{1,3}([.,]\d{3})+([.,]\d+)?$/.test(t)) {
    const group = locale === 'de' ? '.' : ',';
    t = t.split(group).join('');
  }
  if (locale === 'de') t = t.replace(',', '.');
  const n = t === '' ? NaN : Number(t);
  if (!Number.isFinite(n)) throw new GraphError('error.run.not_a_number', { field: 'input', value: text });
  return n;
}

export function formatNumber(value: number, style: NumberStyle, locale: NumberLocale, decimals: number | null): string {
  switch (style) {
    case 'grouped':
      return new Intl.NumberFormat(locale, decimals === null ? { maximumFractionDigits: 20 } : { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
    case 'compact':
      return compact(value, locale, decimals ?? 1);
    case 'ordinal':
      return ordinal(whole(value), locale);
    case 'words':
      return words(value, locale);
    case 'roman':
      return roman(whole(value));
    case 'binary':
      return radix(whole(value), 2);
    case 'hex':
      return radix(whole(value), 16).toUpperCase();
    default:
      throw new GraphError('error.run.unsupported_operation', { value: style });
  }
}

function whole(value: number): number {
  const n = Math.trunc(value);
  if (Math.abs(n) > MAX_WHOLE) throw new GraphError('error.run.number_out_of_range', { value: String(value), min: String(-MAX_WHOLE), max: String(MAX_WHOLE) });
  return n;
}

function radix(n: number, base: number): string {
  return (n < 0 ? '-' : '') + Math.abs(n).toString(base);
}

// K, M, B, T for both languages (what people expect in Discord), the decimal sign of the language.
function compact(value: number, locale: NumberLocale, decimals: number): string {
  const units: [number, string][] = [[1, ''], [1e3, 'K'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']];
  const abs = Math.abs(value);
  let i = units.length - 1;
  while (i > 0 && abs < units[i]![0]) i--;
  let shown = Number((abs / units[i]![0]).toFixed(decimals));
  // Rounding may reach the next unit: 999,950 is 1M, not 1000K.
  if (shown >= 1000 && i < units.length - 1) shown = Number((abs / units[++i]![0]).toFixed(decimals));
  const text = new Intl.NumberFormat(locale, { maximumFractionDigits: decimals, useGrouping: false }).format(shown);
  return (value < 0 && shown !== 0 ? '-' : '') + text + units[i]![1];
}

function ordinal(n: number, locale: NumberLocale): string {
  if (locale === 'de') return `${n}.`;
  const a = Math.abs(n);
  const suffix = a % 100 >= 11 && a % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][a % 10] ?? 'th');
  return `${n}${suffix}`;
}

function roman(n: number): string {
  if (n < 1 || n > 3999) throw new GraphError('error.run.number_out_of_range', { value: String(n), min: '1', max: '3999' });
  const table: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of table) while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
}

// ---------- words ----------

const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion'];

const DE_ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const DE_TENS = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
// German scales above a thousand are nouns: "eine Million", "zwei Millionen".
const DE_SCALES: [string, string][] = [['', ''], ['tausend', 'tausend'], ['Million', 'Millionen'], ['Milliarde', 'Milliarden'], ['Billion', 'Billionen'], ['Billiarde', 'Billiarden']];

function words(value: number, locale: NumberLocale): string {
  const n = whole(value);
  const minus = value < 0 ? 'minus ' : '';
  let out = locale === 'de' ? deWhole(Math.abs(n)) : enWhole(Math.abs(n));
  // Decimals digit by digit: "point four two", "Komma vier zwei".
  const frac = String(value).split('.')[1];
  if (frac && !String(value).includes('e')) {
    const ones = locale === 'de' ? DE_ONES : EN_ONES;
    out += (locale === 'de' ? ' Komma ' : ' point ') + [...frac].map((d) => ones[Number(d)]).join(' ');
  }
  return minus + out;
}

function groups(n: number): number[] {
  const out: number[] = [];
  do {
    out.push(n % 1000);
    n = Math.floor(n / 1000);
  } while (n > 0);
  return out;
}

function enBelow1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`);
    n %= 100;
  }
  if (n >= 20) parts.push(EN_TENS[Math.floor(n / 10)]! + (n % 10 ? `-${EN_ONES[n % 10]}` : ''));
  else if (n > 0) parts.push(EN_ONES[n]!);
  return parts.join(' ');
}

function enWhole(n: number): string {
  if (n === 0) return EN_ONES[0]!;
  const g = groups(n);
  const parts: string[] = [];
  for (let i = g.length - 1; i >= 0; i--) if (g[i]) parts.push(enBelow1000(g[i]!) + (EN_SCALES[i] ? ` ${EN_SCALES[i]}` : ''));
  return parts.join(' ');
}

// A final 1 is "eins" (hunderteins), before "und", "hundert" or "tausend" it is "ein".
function deBelow1000(n: number, final: boolean): string {
  let out = '';
  if (n >= 100) {
    out += `${Math.floor(n / 100) === 1 ? 'ein' : DE_ONES[Math.floor(n / 100)]}hundert`;
    n %= 100;
  }
  if (n === 1) return out + (final ? 'eins' : 'ein');
  if (n === 0 || n < 20) return out + (n ? DE_ONES[n] : '');
  const one = n % 10;
  return out + (one ? `${one === 1 ? 'ein' : DE_ONES[one]}und` : '') + DE_TENS[Math.floor(n / 10)];
}

function deWhole(n: number): string {
  if (n === 0) return DE_ONES[0]!;
  const g = groups(n);
  const big: string[] = [];
  let small = '';
  for (let i = g.length - 1; i >= 0; i--) {
    const v = g[i]!;
    if (!v) continue;
    if (i >= 2) big.push(`${v === 1 ? 'eine' : deBelow1000(v, false)} ${v === 1 ? DE_SCALES[i]![0] : DE_SCALES[i]![1]}`);
    else if (i === 1) small += `${v === 1 ? 'ein' : deBelow1000(v, false)}tausend`;
    else small += deBelow1000(v, true);
  }
  if (small) big.push(small);
  return big.join(' ');
}
