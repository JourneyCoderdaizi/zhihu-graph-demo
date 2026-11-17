import type { ChartPalette, ResolvedTheme, ThemeMode } from './types';

const STORAGE_KEY = 'zhihu-graph-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

type Listener = (resolved: ResolvedTheme, mode: ThemeMode) => void;

let mode: ThemeMode = readStored();
const listeners = new Set<Listener>();

function readStored(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function resolve(m: ThemeMode = mode): ResolvedTheme {
  if (m === 'system') return media.matches ? 'dark' : 'light';
  return m;
}

export function getMode(): ThemeMode {
  return mode;
}

/** 应用主题。切换时加一层全局过渡类，让颜色平滑渐变而非突兀跳变。 */
export function applyTheme(next: ThemeMode, animate = true): void {
  mode = next;
  localStorage.setItem(STORAGE_KEY, next);
  const resolved = resolve(next);

  const root = document.documentElement;
  if (animate) {
    root.classList.add('theming');
    window.setTimeout(() => root.classList.remove('theming'), 400);
  }
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;

  listeners.forEach((fn) => fn(resolved, next));
}

export function onThemeChange(fn: Listener): void {
  listeners.add(fn);
}

// 跟随系统时，系统主题变化要实时反映
media.addEventListener('change', () => {
  if (mode === 'system') applyTheme('system');
});

/* ---------- CSS 变量 -> 图表取色板 ---------- */

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** 读取当前主题下的调色板。主题切换后需重新调用，确保图表随之更新。 */
export function readPalette(): ChartPalette {
  return {
    bg: cssVar('--bg'),
    surface: cssVar('--surface'),
    text: cssVar('--text'),
    textMuted: cssVar('--text-muted'),
    border: cssVar('--border'),
    accent: cssVar('--accent'),
    accentHover: cssVar('--accent-hover'),
    accentLight: cssVar('--accent-light'),
    badgeAuthority: cssVar('--ink-1'),
    badgeNormal: cssVar('--ink-2'),
    badgeOrg: cssVar('--ink-3'),
    gem: cssVar('--gem'),
    dispute: cssVar('--dispute'),
    concept: cssVar('--concept'),
    edge: cssVar('--edge'),
    clusters: [
      cssVar('--cluster-1'),
      cssVar('--cluster-2'),
      cssVar('--cluster-3'),
      cssVar('--cluster-4'),
      cssVar('--cluster-5'),
    ],
    l1: cssVar('--l1'),
    l2: cssVar('--l2'),
    l3: cssVar('--l3'),
    l1Text: cssVar('--l1-text'),
    l2Text: cssVar('--l2-text'),
    l3Text: cssVar('--l3-text'),
  };
}

/** 把 hex/rgb 颜色加上透明度，供 ECharts 的边与弱化态使用 */
export function alpha(color: string, a: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    const full = hex.length === 3 ? hex.split('').map((x) => x + x).join('') : hex;
    const n = parseInt(full, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map((x) => parseFloat(x));
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}
