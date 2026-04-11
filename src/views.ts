export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  strings.forEach((str, i) => {
    out += str;
    if (i < values.length) {
      const v = values[i];
      if (v && typeof v === 'object' && 'raw' in v) {
        out += String((v as { raw: string }).raw);
      } else {
        out += esc(v);
      }
    }
  });
  return out;
}

export function raw(s: string): { raw: string } {
  return { raw: s };
}

export function layout(opts: { title: string; user?: { email: string; studioName: string } | null; body: string }): string {
  const nav = opts.user
    ? html`<a href="/dashboard">Dashboard</a> <span>·</span> <a href="/settings">Settings</a> <span>·</span> <a href="/logout">Logout</a>`
    : html`<a href="/login">Login</a> <span>·</span> <a href="/signup">Sign up</a>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(opts.title)} · Tattoo Studio OS</title>
  <style>
    :root { --bg:#0c0a09; --fg:#fafaf9; --muted:#a8a29e; --accent:#f97316; --card:#1c1917; --border:#292524; }
    * { box-sizing: border-box; }
    body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--fg); margin: 0; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    header { display:flex; align-items:center; justify-content:space-between; padding: 16px 24px; border-bottom: 1px solid var(--border); }
    header .brand { font-weight: 700; }
    header nav { color: var(--muted); font-size: 14px; }
    main { max-width: 880px; margin: 0 auto; padding: 32px 24px; }
    h1 { font-size: 28px; margin: 0 0 16px; }
    h2 { font-size: 20px; margin: 24px 0 8px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin: 16px 0; }
    label { display:block; font-size: 13px; color: var(--muted); margin-top: 12px; }
    input, textarea, select { width:100%; padding:10px 12px; background:#0e0c0a; color:var(--fg); border:1px solid var(--border); border-radius:8px; font:inherit; }
    textarea { min-height: 80px; resize: vertical; }
    button, .btn { display:inline-block; padding:10px 16px; background: var(--accent); color:#fff; border:0; border-radius:8px; font:inherit; cursor:pointer; text-decoration:none; }
    button.secondary, .btn.secondary { background: transparent; border: 1px solid var(--border); color: var(--fg); }
    .muted { color: var(--muted); font-size: 14px; }
    .row { display:flex; gap: 12px; align-items:center; flex-wrap: wrap; }
    .stack > * + * { margin-top: 12px; }
    .pill { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; border:1px solid var(--border); }
    .pill.pending { background:#451a03; border-color:#9a3412; color:#fed7aa; }
    .pill.deposit_paid { background:#1e3a8a; border-color:#1e40af; color:#bfdbfe; }
    .pill.consented { background:#14532d; border-color:#166534; color:#bbf7d0; }
    .pill.completed { background:#581c87; border-color:#6b21a8; color:#e9d5ff; }
    .pill.cancelled { background:#3f3f46; border-color:#52525b; color:#d4d4d8; }
    code { background:#0e0c0a; padding:2px 6px; border-radius:4px; border:1px solid var(--border); font-size: 13px; }
    pre { background:#0e0c0a; padding:12px; border-radius:8px; border:1px solid var(--border); overflow:auto; font-size: 13px; }
    .error { color: #fca5a5; font-size: 14px; }
    .ok { color: #86efac; font-size: 14px; }
  </style>
</head>
<body>
  <header>
    <div class="brand"><a href="/">⚡ ${esc(opts.user?.studioName ?? 'Tattoo Studio OS')}</a></div>
    <nav>${raw(nav).raw}</nav>
  </header>
  <main>${opts.body}</main>
</body>
</html>`;
}
