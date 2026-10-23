// YouTube's color system.
//
// The old public names (`--yt-spec-call-to-action` …) are no longer defined
// on current YouTube builds. Components read obfuscated per-build tokens such
// as `--t2d807bb79e75606d`, declared with literal values under `[dark]` and
// `[light]`. The hashes change between deploys, so instead of hard-coding
// them we identify each token by its (dark value, light value) signature —
// "the token that is #3ea6ff in dark and #065fd4 in light is call-to-action".

export type TokenRole = 'cta' | 'brand' | 'suggested' | 'baseBg';

/** Legacy/public names, still overridden in case a rollout or component uses them. */
const NAMED: Record<TokenRole, string[]> = {
  cta: ['--yt-spec-call-to-action', '--yt-spec-themed-blue', '--yt-sys-color-baseline--call-to-action'],
  brand: ['--yt-spec-brand-icon-active', '--yt-spec-static-brand-red', '--yt-sys-color-baseline--static-brand-red'],
  suggested: ['--yt-spec-suggested-action', '--yt-sys-color-baseline--suggested-action'],
  baseBg: ['--yt-spec-base-background', '--yt-sys-color-baseline--base-background'],
};

const RED = new Set(['#ff0033', '#ff0000', '#cc0000']);
const SIGNATURES: Record<TokenRole, (dark: string, light: string) => boolean> = {
  // Either half is enough: YouTube also has overlay/inverse link blues that
  // keep #3ea6ff in both themes, and they should follow the accent too.
  cta: (d, l) => d === '#3ea6ff' || l === '#065fd4',
  brand: (d, l) => RED.has(d) && RED.has(l),
  suggested: (d, l) => d === '#263850' && l === '#def1ff',
  baseBg: (d, l) => d === '#0f0f0f' && l === '#ffffff',
};

const HASHED = /^--t[0-9a-f]{16}$/;

function normalize(v: string): string {
  const s = v.trim().toLowerCase();
  return /^#[0-9a-f]{3}$/.test(s) ? '#' + [...s.slice(1)].map((c) => c + c).join('') : s;
}

export type TokenMap = Record<TokenRole, string[]>;

/**
 * Walks YouTube's stylesheets once (a few ms, done in idle time). Stylesheets
 * we can't read (cross-origin) are skipped; the named fallbacks still apply.
 */
export function discoverTokens(): TokenMap {
  const dark = new Map<string, string>();
  const light = new Map<string, string>();

  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const sel = rule.selectorText;
        const target = sel === '[dark]' ? dark : sel === '[light]' ? light : null;
        if (target) {
          const st = rule.style;
          for (let i = 0; i < st.length; i++) {
            const prop = st[i]!;
            if (HASHED.test(prop)) target.set(prop, normalize(st.getPropertyValue(prop)));
          }
        }
      }
      if ('cssRules' in rule && (rule as CSSGroupingRule).cssRules) visit((rule as CSSGroupingRule).cssRules);
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // SecurityError for cross-origin sheets — not where YouTube defines tokens.
    }
  }

  const map: TokenMap = { cta: [...NAMED.cta], brand: [...NAMED.brand], suggested: [...NAMED.suggested], baseBg: [...NAMED.baseBg] };
  for (const [prop, d] of dark) {
    const l = light.get(prop);
    if (l === undefined) continue;
    for (const role of Object.keys(SIGNATURES) as TokenRole[]) {
      if (SIGNATURES[role](d, l)) map[role].push(prop);
    }
  }
  return map;
}

/**
 * Builds the override sheet. Originals are captured on <html> (where YouTube
 * defines them) and the overrides are applied one level down on ytd-app, so
 * `--chroma-mix` can cross-fade between YouTube's color and ours — that is
 * what makes the 600 ms fade back to stock colors on non-video pages possible.
 */
export function buildTokenCss(map: TokenMap): string {
  const capture: string[] = [];
  const accents: string[] = [];
  const tint: string[] = [];
  let n = 0;
  const mixed = (prop: string, ours: string, sink: string[]) => {
    const o = `--chroma-o${n++}`;
    // If YouTube doesn't define this name, fall back to our own color so the
    // mix degrades to "just ours" instead of becoming invalid.
    capture.push(`${o}: var(${prop}, ${ours});`);
    sink.push(`${prop}: color-mix(in oklch, var(${o}), ${ours} var(--chroma-pct)) !important;`);
  };

  for (const p of map.cta) mixed(p, 'var(--chroma-link)', accents);
  for (const p of map.brand) mixed(p, 'var(--chroma-accent)', accents);
  for (const p of map.suggested) {
    mixed(p, 'color-mix(in oklch, var(--chroma-accent) 24%, var(--chroma-page-bg))', accents);
  }
  for (const p of map.baseBg) {
    mixed(p, 'color-mix(in oklch, var(--chroma-page-bg), var(--chroma-bg-tint) 6%)', tint);
  }

  const scope = ':is(ytd-app, ytd-app [dark], ytd-app [light])';
  return [
    `html.chroma-on { ${capture.join(' ')} }`,
    `html.chroma-on.chroma-active.chroma-t-accents ${scope} { ${accents.join(' ')} }`,
    `html.chroma-on.chroma-active.chroma-t-tint:not(.chroma-perf-battery) ${scope} { ${tint.join(' ')} }`,
  ].join('\n');
}
