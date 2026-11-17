import './style.css';
import headUrl from '../assets/kanshan/kanshan-head.png';
import { GraphChart, type FilterState } from './graph';
import { Mascot } from './mascot';
import { initSettings } from './settings';
import { applyTheme, getMode, onThemeChange, readPalette, resolve } from './theme';
import type {
  AnswerNode, ClusterInfo, GraphData, GraphNode, QuestionGraph, ThemeMode,
} from './types';
import { isAnswer, isConcept } from './types';

const BADGE_CN: Record<string, string> = {
  authority: '权威答主', normal: '普通用户', org: '机构号',
};
const STANCE_CN: Record<string, string> = {
  pro: '正方', con: '反方', conditional: '条件派',
};

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

let data: GraphData;
let cur: QuestionGraph;
let chart: GraphChart;
let mascot: Mascot;

const filters: FilterState = {
  badges: new Set(['authority', 'normal', 'org']),
  qual: new Set(),
  hiddenClusters: new Set(),
};

/* ---------- 启动 ---------- */

applyTheme(getMode(), false);
buildNoise();
bootstrap();

async function bootstrap(): Promise<void> {
  const res = await fetch('./data/graph.json');
  data = (await res.json()) as GraphData;

  buildThemeSwitch();

  const sel = $<HTMLSelectElement>('#q-select');
  data.questions.forEach((q) => {
    const o = document.createElement('option');
    o.value = q.qid;
    o.textContent = `${q.title}（${q.answer_count} 个回答）`;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => {
    load(sel.value, true);
    mascot.play('computer', '换个题目看看');
  });

  chart = new GraphChart($('#chart'), openDrawer);
  mascot = new Mascot($('#center'));

  onThemeChange((resolved) => {
    chart.setPalette(readPalette());
    mascot.say(resolved === 'dark' ? '夜间模式' : '日间模式', 1800);
    buildSide();
  });

  buildTabs();
  buildSideToggle();
  initSettings(() => mascot.play('computer', '大模型配置已更新'));
  $<HTMLButtonElement>('#drawer-close-proxy')?.remove();

  load(data.questions[0].qid, true);
  window.setTimeout(() => mascot.play('wave', '观点地图准备好了'), 900);
}

/* ---------- 背景噪点（程序生成，避免外部图片依赖） ---------- */

function buildNoise(): void {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 120 + Math.random() * 135;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const el = $('.page-noise');
  el.style.backgroundImage = `url(${c.toDataURL()})`;
  el.style.backgroundRepeat = 'repeat';
}

/* ---------- 主题切换 ---------- */

const THEME_ICON: Record<ThemeMode, string> = {
  light: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.6M12 19.4V22M2 12h2.6M19.4 12H22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M19.1 4.9l-1.9 1.9M6.8 17.2l-1.9 1.9"/>',
  dark: '<path d="M20.5 14.3A8.5 8.5 0 1 1 9.7 3.5a6.8 6.8 0 0 0 10.8 10.8z"/>',
  system: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20.5h8M12 17.5v3"/>',
};

function buildThemeSwitch(): void {
  const wrap = $('#theme-switch');
  const modes: ThemeMode[] = ['light', 'dark', 'system'];

  modes.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = { light: '浅色', dark: '深色', system: '跟随系统' }[m];
    b.setAttribute('aria-label', b.title);
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.7" stroke-linecap="round">${THEME_ICON[m]}</svg>`;
    b.addEventListener('click', () => {
      applyTheme(m);
      syncThemeSwitch();
      mascot.play('sway');
    });
    wrap.appendChild(b);
  });
  syncThemeSwitch();
}

function syncThemeSwitch(): void {
  const wrap = $('#theme-switch');
  const modes: ThemeMode[] = ['light', 'dark', 'system'];
  const idx = modes.indexOf(getMode());
  wrap.querySelectorAll('button').forEach((b, i) => {
    b.setAttribute('aria-pressed', String(i === idx));
  });
}

/* ---------- 加载某道题 ---------- */

function load(qid: string, intro = false): void {
  cur = data.questions.find((q) => q.qid === qid)!;
  filters.qual.clear();
  filters.hiddenClusters.clear();


  chart.render(cur, readPalette(), filters, intro);
  buildSide();
  if ($('#listview').classList.contains('on')) renderList();
  closeDrawer();
}

const answers = (): AnswerNode[] => cur.nodes.filter(isAnswer);

/* ---------- 侧栏 ---------- */

/** 质量滤镜用的精致线框图标 */
const QUAL_ICON: Record<'high' | 'gem', string> = {
  // 钻石：高质量
  high: '<path d="M6 3h12l3 5.4-9 12.6L3 8.4z"/><path d="M3 8.4h18M9.2 3 7.4 8.4 12 21M14.8 3l1.8 5.4L12 21"/>',
  // 眼睛：被低估
  gem: '<path d="M2.2 12S5.8 5.6 12 5.6 21.8 12 21.8 12 18.2 18.4 12 18.4 2.2 12 2.2 12z"/><circle cx="12" cy="12" r="2.9"/>',
};

function icon(path: string): string {
  return `<span class="q-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg></span>`;
}

function buildSide(): void {
  /* 模块 A：身份属性 —— 横向胶囊切换组，数字弱化 */
  const fb = $('#f-badge');
  fb.innerHTML = '';
  (['authority', 'normal', 'org'] as const).forEach((b) => {
    const n = answers().filter((a) => a.badge === b).length;
    const el = btn('pill', `${BADGE_CN[b]}<i>${n}</i>`);
    el.setAttribute('aria-pressed', String(filters.badges.has(b)));
    el.addEventListener('click', () => {
      filters.badges.has(b) ? filters.badges.delete(b) : filters.badges.add(b);
      el.setAttribute('aria-pressed', String(filters.badges.has(b)));
      applyFilters();
    });
    fb.appendChild(el);
  });

  /* 模块 B：质量滤镜 —— 极简列表 + 线框图标 */
  const fq = $('#f-qual');
  fq.innerHTML = '';
  ([['high', '只看高质量'], ['gem', '只看被低估']] as const).forEach(([k, label]) => {
    const key = k as 'high' | 'gem';
    const el = btn('q-row', `${icon(QUAL_ICON[key])}<span>${label}</span>`);
    el.setAttribute('aria-pressed', String(filters.qual.has(key)));
    el.addEventListener('click', () => {
      filters.qual.has(key) ? filters.qual.delete(key) : filters.qual.add(key);
      el.setAttribute('aria-pressed', String(filters.qual.has(key)));
      if (filters.qual.has('gem')) mascot.play('ball', '这些是被埋没的干货');
      applyFilters();
    });
    fq.appendChild(el);
  });

  /* 模块 C：观点簇 —— 标签云 */
  const fc = $('#f-cluster');
  fc.innerHTML = '';
  cur.clusters.forEach((c: ClusterInfo) => {
    const el = btn('tag-pill',
      `<span class="hash">#</span><b>${c.axis}</b><i>${c.size}</i>`);
    el.title = `${c.keywords} · 代表 ${c.rep_author}`;
    el.setAttribute('aria-pressed', String(!filters.hiddenClusters.has(c.idx)));
    el.addEventListener('click', () => {
      filters.hiddenClusters.has(c.idx)
        ? filters.hiddenClusters.delete(c.idx)
        : filters.hiddenClusters.add(c.idx);
      el.setAttribute('aria-pressed', String(!filters.hiddenClusters.has(c.idx)));
      applyFilters();
    });
    fc.appendChild(el);
  });

  /* 模块 D：被低估的回答 —— 纯留白列表 */
  const gm = $('#gems');
  gm.innerHTML = '';
  const gems = answers().filter((a) => a.hidden_gem).sort((a, b) => b.q - a.q);
  if (!gems.length) {
    gm.innerHTML = cur.stats.upvote_reliable
      ? '<p class="empty-hint">本题未识别到明显的长尾干货。</p>'
      : '<p class="empty-hint">本题赞数字段多数为 0，接口未提供可信赞数，已关闭「被低估」识别。</p>';
  }
  gems.forEach((a) => {
    const el = btn('gem-item',
      `<b>${a.name}</b><span>Q ${a.q.toFixed(2)} · ${a.upvotes} 赞</span>`);
    el.addEventListener('click', () => { openDrawer(a.id); chart.focus(a.id); });
    gm.appendChild(el);
  });
}

function btn(cls: string, html: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.innerHTML = html;
  return b;
}

function row(cls: string, html: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function applyFilters(): void {
  chart.updateFilters(filters);
  if ($('#listview').classList.contains('on')) renderList();
}

/* ---------- 侧栏收起 ---------- */

function buildSideToggle(): void {
  const btn = $<HTMLButtonElement>('#side-toggle');
  const main = document.querySelector('main')!;
  const KEY = 'zhihu-graph-side-collapsed';

  const apply = (collapsed: boolean, animate = true) => {
    main.classList.toggle('side-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
    btn.title = collapsed ? '展开侧栏' : '收起侧栏';
    localStorage.setItem(KEY, collapsed ? '1' : '0');
    // 画布宽度变化后重新贴合视口
    window.setTimeout(() => chart.resize(), animate ? 360 : 0);
  };

  apply(localStorage.getItem(KEY) === '1', false);
  btn.addEventListener('click', () =>
    apply(!main.classList.contains('side-collapsed')));
}

/* ---------- 视图切换 ---------- */

function buildTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab');
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      const graphOn = t.dataset.view === 'graph';
      $('#chart').style.display = graphOn ? '' : 'none';
      $('#listview').classList.toggle('on', !graphOn);
      if (graphOn) chart.resize(); else renderList();
    });
  });
}

function renderList(): void {
  const box = $('#listview');
  const rows = answers().filter((a) => chart.visible(a)).sort((a, b) => b.q - a.q);
  box.innerHTML = rows.length ? '' : '<p class="empty-hint">当前滤镜下没有回答。</p>';
  rows.forEach((a, i) => {
    const el = row('list-row', `
      <div class="head">
        <b>${a.name}</b>
        <span class="tag">${BADGE_CN[a.badge]}</span>
        <span class="tag">${a.upvotes} 赞</span>
        <span class="tag">Q ${a.q.toFixed(2)}</span>
        <span class="tag">${STANCE_CN[a.stance]}</span>
        ${a.hidden_gem ? '<span class="tag strong">被低估</span>' : ''}
      </div>
      <div class="gist">${a.gist}</div>`);
    el.style.borderLeftColor = a.hidden_gem
      ? readPalette().gem : chart.clusterColor(a.cluster);
    el.style.animationDelay = `${Math.min(i * 22, 420)}ms`;
    el.addEventListener('click', () => openDrawer(a.id));
    box.appendChild(el);
  });
}

/* ---------- 抽屉 ---------- */

function openDrawer(id: string): void {
  const node = cur.nodes.find((n: GraphNode) => n.id === id);
  if (!node) return;
  const dw = $('#drawer-inner');
  $('#drawer').classList.add('open');
  window.setTimeout(() => chart.resize(), 340);

  const close = '<button class="drawer-close" id="dw-close" aria-label="关闭">×</button>';

  if (node.kind === 'question') {
    dw.innerHTML = `${close}
      <h2>${cur.title}</h2>
      <div class="sub">${cur.answer_count} 个回答 · 聚成 ${cur.stats.k} 个观点簇</div>
      ${cur.clusters.map((c) => `
        <div class="cmp-card" style="border-left-color:${chart.clusterColor(c.idx)}">
          <b>${c.axis}</b><p>${c.keywords} · ${c.size} 条 · 代表 ${c.rep_author}</p>
        </div>`).join('')}
      ${disclaimer()}`;
  } else if (isConcept(node)) {
    const refs = cur.edges
      .filter((e) => e.source === node.id)
      .map((e) => cur.nodes.find((n) => n.id === e.target))
      .filter((n): n is AnswerNode => !!n && isAnswer(n));
    dw.innerHTML = `${close}
      <h2>概念：${node.name}</h2>
      <div class="sub">被 ${node.share} 条回答引用，跨 ${node.bridge} 个观点簇${
        node.bridge > 1 ? ' · 这是连接不同立场的桥' : ''}</div>
      ${refs.map((r) => `<div class="cmp-card"><b>${r.name}</b><p>${r.gist}</p></div>`).join('')}
      ${disclaimer()}`;
  } else {
    const a = node as AnswerNode;
    const dsp = cur.edges.find((e) => e.type === 'dispute' && (e.source === a.id || e.target === a.id));
    const foeId = dsp ? (dsp.source === a.id ? dsp.target : dsp.source) : null;
    const foe = foeId ? cur.nodes.find((n) => n.id === foeId) : null;
    const clu = cur.clusters.find((c) => c.idx === a.cluster);

    dw.innerHTML = `${close}
      <h2>${a.name}</h2>
      <div class="sub">${BADGE_CN[a.badge]} · ${a.upvotes} 赞 · 所属簇「${clu?.axis ?? '-'}」</div>
      <div class="chips">
        <span class="chip">质量分 ${a.q.toFixed(2)}</span>
        <span class="chip">${STANCE_CN[a.stance]} · 置信 ${a.stance_conf}</span>
        ${a.hidden_gem ? '<span class="chip hi">被低估的长尾干货</span>' : ''}
      </div>
      <h3 style="font-size:10px;letter-spacing:1.3px;text-transform:uppercase;
                 color:var(--text-muted);font-weight:600;margin:4px 0 10px">场景维度</h3>
      ${Object.entries(a.dims).map(([k, v]) =>
        dimBar(cur.dim_label[k] ?? k, v as number)).join('')}
      <div class="drawer-body">${escapeHtml(a.text)}</div>
      ${foe && isAnswer(foe) ? `
        <h3 style="font-size:10px;letter-spacing:1.3px;text-transform:uppercase;
                   color:var(--text-muted);font-weight:600;margin:16px 0 10px">争议对比</h3>
        <div class="cmp-card"><b>${a.name}</b><p>${a.gist}</p></div>
        <div class="cmp-card foe"><b>${foe.name}</b><p>${foe.gist}</p></div>` : ''}
      ${a.url
        ? `<a class="link-out" href="${a.url}" target="_blank" rel="noopener">在知乎打开原文 →</a>`
        : '<p class="empty-hint" style="margin-top:15px">该条无原文链接</p>'}
      ${disclaimer()}`;
  }

  dw.querySelector('#dw-close')?.addEventListener('click', closeDrawer);
  // 维度条宽度延后设置，触发过渡动画
  window.requestAnimationFrame(() => {
    dw.querySelectorAll<HTMLElement>('.dim-bar u').forEach((u) => {
      u.style.width = u.dataset.w ?? '0%';
      u.style.left = u.dataset.l ?? '50%';
    });
  });
}

function dimBar(label: string, v: number): string {
  const pct = Math.abs(v) * 50;
  const left = v >= 0 ? 50 : 50 - pct;
  return `<div class="dim-bar">
    <div class="lb"><span>${label}</span><b>${v >= 0 ? '+' : ''}${v}</b></div>
    <div class="track"><i></i><u data-w="${pct}%" data-l="${left}%" style="width:0;left:50%"></u></div>
  </div>`;
}

function closeDrawer(): void {
  $('#drawer').classList.remove('open');
  window.setTimeout(() => chart.resize(), 340);
}

function disclaimer(): string {
  const live = data.meta.data_nature === 'live_zhihu';
  const extra = cur.stats.upvote_reliable === false
    ? '<br/>注意：本题赞数字段多数为 0，接口未提供可信赞数，已关闭「被低估」识别。' : '';
  return `<div class="disclaimer">${live
    ? '真实数据：知乎开放平台搜索接口返回的社区内容摘要（非完整正文）。身份属性取平台认证徽章与权威等级。'
    : '演示语料：由公开聚合观点改写，非知乎真实抓取数据；答主名与赞数为模拟值。'}${extra}</div>`;
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}


/* ---------- 暴露给自动化校验 ---------- */

declare global {
  interface Window {
    __graph: {
      chart: () => GraphChart;
      cur: () => QuestionGraph;
      data: () => GraphData;
      filters: () => FilterState;
      theme: () => string;
      setTheme: (m: ThemeMode) => void;
      resolved: () => string;
    };
  }
}

window.__graph = {
  chart: () => chart,
  cur: () => cur,
  data: () => data,
  filters: () => filters,
  theme: () => getMode(),
  setTheme: (m) => { applyTheme(m); syncThemeSwitch(); },
  resolved: () => resolve(),
};

// 头像资源在 HTML 中引用
$<HTMLImageElement>('#brand-img').src = headUrl;
