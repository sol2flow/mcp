/*
 * Output for the model: compact Markdown by default, JSON with `response_format: "json"`. At most about 25 000
 * characters per result (MAX_CHARS), with a notice saying what was left out and how to get the rest.
 */

export const MAX_CHARS = 25_000;

export type ResponseFormat = 'markdown' | 'json';

/** Cut long text at a line break before the limit, with a notice. */
export function truncate(text: string, max = MAX_CHARS): string {
  if (text.length <= max) return text;
  const room = max - 200;
  const cut = text.lastIndexOf('\n', room);
  const head = text.slice(0, cut > room / 2 ? cut : room);
  return (
    head +
    `\n\n… truncated: ${text.length - head.length} more characters not shown. Narrow the request (filters, a smaller ` +
    '`limit`) or continue with the cursor.'
  );
}

/**
 * JSON that stays within the limit: an array (the value itself, its `data`, or else its largest array field, such as a
 * board's `tasks`) loses items from the end, and `truncated` says how many were shown (and which field was cut).
 */
export function renderJson(value: unknown, max = MAX_CHARS): string {
  const s = JSON.stringify(value, null, 1);
  if (s.length <= max) return s;
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const field = Array.isArray(value)
    ? null
    : Array.isArray(obj.data)
      ? 'data'
      : Object.keys(obj)
          .filter((k) => Array.isArray(obj[k]))
          .sort((a, b) => JSON.stringify(obj[b]).length - JSON.stringify(obj[a]).length)[0];
  const arr = Array.isArray(value) ? value : field ? (obj[field] as unknown[]) : null;
  if (arr) {
    let n = arr.length;
    while (n > 0) {
      n = Math.floor(n * 0.8);
      const items = arr.slice(0, n);
      const truncated = { ...(field && field !== 'data' ? { field } : {}), shown: n, total: arr.length };
      const out = Array.isArray(value) ? { data: items, truncated } : { ...obj, [field!]: items, truncated };
      const t = JSON.stringify(out, null, 1);
      if (t.length <= max) return t;
    }
  }
  return JSON.stringify({ truncated: true, text: s.slice(0, max - 100) });
}

export function render(format: ResponseFormat | undefined, json: unknown, markdown: () => string): string {
  return format === 'json' ? renderJson(json) : truncate(markdown());
}

export const people = (ps: { name: string; username?: string }[] | undefined) =>
  (ps ?? []).map((p) => (p.username ? `@${p.username}` : p.name)).join(', ');

export const date = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
export const dateTime = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '');

export function duration(sec: number): string {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m}m`;
}

/** "More: pass cursor "…"" when there is a next page. */
export const more = (next: string | null | undefined) =>
  next ? `\n\nMore results: call again with \`cursor: "${next}"\`.` : '';

/** One line per item, or the empty text. */
export const lines = (items: string[], empty: string) => (items.length ? items.join('\n') : empty);
