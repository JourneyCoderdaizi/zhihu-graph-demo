import * as echarts from 'echarts';
import type {
  AnswerNode, ChartPalette, ClusterInfo, GraphNode, QuestionGraph,
} from './types';
import { isAnswer, isConcept } from './types';
import { alpha } from './theme';

export interface FilterState {
  badges: Set<string>;
  qual: Set<'high' | 'gem'>;
  hiddenClusters: Set<number>;
}

/** Focus 进入/离开延迟与过渡时长：慢一点才不刺眼 */
const FOCUS_ENTER_MS = 180;
const FOCUS_LEAVE_MS = 260;
const FOCUS_FADE_MS = 420;

const BADGE_CN: Record<string, string> = {
  authority: '权威答主', normal: '普通用户', org: '机构号',
};
const STANCE_CN: Record<string, string> = {
  pro: '正方', con: '反方', conditional: '条件派',
};

export class GraphChart {
  private chart: echarts.ECharts;
  private q!: QuestionGraph;
  private pal!: ChartPalette;
  private filters!: FilterState;
  private pulseTimer = 0;
  private fitTimer = 0;
  private focused: string | null = null;
  private focusTimer = 0;
  /** draw() 时记录的基线样式，用于 Focus 结束后平滑还原 */
  private baseStyles: {
    nodes: Record<string, { itemStyle: any; label: any }>;
    links: any[];
  } | null = null;
  private unfocusTimer = 0;
  private introDone = false;

  constructor(dom: HTMLElement, private onPick: (id: string) => void) {
    this.chart = echarts.init(dom, undefined, { renderer: 'canvas' });
    this.chart.on('click', (p: any) => {
      if (p.dataType === 'node' && p.data?.id) this.onPick(p.data.id);
    });
    // v2 Focus+Context：hover 时用后端预计算的二阶邻域做分级高亮
    // Focus 防抖：鼠标快速扫过时不触发，避免高频重绘造成闪烁
    this.chart.on('mouseover', (p: any) => {
      if (p.dataType !== 'node' || !p.data?.id) return;
      const id = p.data.id;
      window.clearTimeout(this.focusTimer);
      window.clearTimeout(this.unfocusTimer);
      if (this.focused === id) return;
      this.focusTimer = window.setTimeout(() => this.applyFocus(id), FOCUS_ENTER_MS);
    });
    this.chart.on('mouseout', (p: any) => {
      if (p.dataType !== 'node') return;
      window.clearTimeout(this.focusTimer);
      window.clearTimeout(this.unfocusTimer);
      // 离开也延迟，避免节点间移动时反复明暗跳动
      this.unfocusTimer = window.setTimeout(() => this.clearFocus(), FOCUS_LEAVE_MS);
    });
    window.addEventListener('resize', () => {
      this.chart.resize();
      this.fitToView();
    });
  }

  clusterColor(i: number): string {
    return this.pal.clusters[i % this.pal.clusters.length];
  }

  private qThreshold(): number {
    const qs = this.q.nodes.filter(isAnswer).map((a) => a.q).sort((x, y) => y - x);
    return qs[Math.max(0, Math.floor(qs.length * 0.3) - 1)] ?? 0;
  }

  visible(a: AnswerNode): boolean {
    const f = this.filters;
    if (!f.badges.has(a.badge)) return false;
    if (f.hiddenClusters.has(a.cluster)) return false;
    if (f.qual.has('gem') && !a.hidden_gem) return false;
    if (f.qual.has('high') && a.q < this.qThreshold()) return false;
    return true;
  }

  /** 全量重绘（切换问题或主题时） */
  render(q: QuestionGraph, pal: ChartPalette, filters: FilterState, intro = false): void {
    this.q = q;
    this.pal = pal;
    this.filters = filters;
    this.introDone = !intro;
    this.draw(intro);
  }

  /** 仅更新滤镜视觉态，不重建布局 —— 保证筛选过渡平滑 */
  updateFilters(filters: FilterState): void {
    this.filters = filters;
    this.draw(false);
  }

  setPalette(pal: ChartPalette): void {
    this.pal = pal;
    this.draw(false);
  }

  /** 节点视觉层级：L1 核心主题 / L2 关键枢纽 / L3 边缘叶节点
   *
   * 依据度数与质量分划分，形成"中心紧实、边缘发散"的恒星系结构。
   */
  private tierOf(n: GraphNode, degree: Map<string, number>): 1 | 2 | 3 {
    // v2：优先采用后端 CIS 复合影响力算出的分层
    // (PageRank + 语义独特性 + 质量分 + 互动熵)，高频低质不再喧宾夺主。
    const backend = (n as any).tier;
    if (backend === 1 || backend === 2 || backend === 3) return backend;

    // 后端字段缺失时回退到原规则，保证兼容未升级的 graph.json
    if (n.kind === 'question') return 1;
    const d = degree.get(n.id) ?? 0;
    if (isAnswer(n)) {
      if (d >= 7 || n.q >= 0.78 || n.hidden_gem) return 2;
      return 3;
    }
    return isConcept(n) && n.bridge >= 3 ? 2 : 3;
  }

  private degreeMap(q: QuestionGraph): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of q.edges) {
      m.set(e.source, (m.get(e.source) ?? 0) + 1);
      m.set(e.target, (m.get(e.target) ?? 0) + 1);
    }
    return m;
  }

  private draw(intro: boolean): void {
    const q = this.q;
    const pal = this.pal;
    const vis = new Set(q.nodes.filter(isAnswer).filter((a) => this.visible(a)).map((a) => a.id));
    const degree = this.degreeMap(q);

    const nodes: any[] = [];

    for (const n of q.nodes) {
      const tier = this.tierOf(n, degree);
      const tierColor = tier === 1 ? pal.l1 : tier === 2 ? pal.l2 : pal.l3;
      const tierText = tier === 1 ? pal.l1Text : tier === 2 ? pal.l2Text : pal.l3Text;

      if (n.kind === 'question') {
        // L1 核心：最大实心圆 + 最大加粗字
        nodes.push({
          id: n.id, name: n.name, kind: 'question', raw: n, tier,
          symbolSize: 60,
          itemStyle: { color: pal.l1, borderWidth: 0 },
          label: {
            show: true, position: 'bottom', distance: 11,
            color: pal.l1Text, fontSize: 13, fontWeight: 'bold',
            textShadowColor: pal.bg, textShadowBlur: 9,
            formatter: () => '问题',
          },
          z: 20,
        });
      } else if (isAnswer(n)) {
        const on = vis.has(n.id);
        const base = tier === 2 ? 19 : 10;
        nodes.push({
          id: n.id, name: n.name, kind: 'answer', raw: n, tier,
          symbolSize: base + n.q * (tier === 2 ? 25 : 12),
          itemStyle: {
            color: tierColor,
            borderColor: n.hidden_gem ? pal.gem : 'transparent',
            borderWidth: n.hidden_gem ? 2.3 : 0,
            opacity: on ? 1 : 0.1,
            shadowBlur: tier === 2 ? 14 : 0,
            shadowColor: alpha(tierColor, 0.32),
          },
          label: {
            // L3 叶节点默认不显示标签，hover 才亮，消除画面噪声
            show: tier <= 2 && (n.q > 0.4 || n.hidden_gem),
            position: 'right', distance: 7,
            fontSize: tier === 2 ? 11.5 : 10,
            fontWeight: tier === 2 ? 600 : 400,
            color: on ? tierText : alpha(pal.textMuted, 0.18),
            textShadowColor: pal.bg, textShadowBlur: 7,
            formatter: () => n.name,
          },
          z: tier === 2 ? 12 : 6,
        });
      } else if (isConcept(n)) {
        nodes.push({
          id: n.id, name: n.name, kind: 'concept', raw: n, tier,
          symbolSize: (tier === 2 ? 10 : 6) + n.share * 0.85,
          itemStyle: { color: tierColor, opacity: tier === 2 ? 0.88 : 0.42 },
          label: {
            show: tier === 2,
            position: 'top', distance: 6,
            fontSize: 10.5,
            color: tierText,
            textShadowColor: pal.bg, textShadowBlur: 8,
            formatter: () => n.name,
          },
          z: tier === 2 ? 10 : 4,
        });
      }
    }

    const links: any[] = q.edges.map((e) => {
      const live = (vis.has(e.source) || e.source === q.qid || e.source.includes('-k-')) &&
                   (vis.has(e.target) || e.target === q.qid);
      if (e.type === 'dispute') {
        return {
          source: e.source, target: e.target, raw: e,
          lineStyle: {
            color: pal.dispute, width: 1.5, type: 'dashed',
            curveness: 0, opacity: live ? 0.72 : 0.04,
          },
          z: 3,
        };
      }
      // v2：按 PMI 信息增益分级 —— 强边粗亮、中边细、弱边默认隐藏(hover 显形)
      const isConceptEdge = e.type === 'concept';
      const et = e.etier;
      let width = isConceptEdge ? 0.6 : 0.7;
      let base = isConceptEdge ? 0.16 : 0.26;
      if (et === 'strong') { width = 1.5; base = 0.5; }
      else if (et === 'mid') { width = 0.8; base = 0.24; }
      else if (et === 'weak') { width = 0.5; base = 0.0; }  // 隐藏，hover 才显
      return {
        source: e.source, target: e.target, raw: e,
        lineStyle: {
          color: pal.edge, width, curveness: 0,
          opacity: live ? base : 0.02,
        },
        z: et === 'strong' ? 2 : 1,
      };
    });

    // 中心问题 -> 每簇代表回答：最紧的一档
    for (const c of q.clusters) {
      const rep = q.nodes.filter(isAnswer).find((a) => a.name === c.rep_author);
      if (rep) {
        links.push({
          source: q.qid, target: rep.id,
          lineStyle: { color: pal.edge, width: 1, opacity: 0.36, curveness: 0 },
          z: 2,
        });
      }
    }

    this.chart.setOption({
      backgroundColor: 'transparent',
      animation: true,
      animationDuration: intro ? 760 : 380,
      animationEasing: 'cubicOut',
      animationDurationUpdate: 380,
      animationEasingUpdate: 'cubicInOut',
      tooltip: {
        backgroundColor: pal.surface,
        borderColor: pal.border,
        borderWidth: 1,
        padding: [9, 12],
        textStyle: { color: pal.text, fontSize: 12 },
        extraCssText: 'max-width:300px;white-space:normal;border-radius:12px;'
          + `box-shadow:0 8px 28px ${alpha('#000000', 0.32)}`,
        formatter: (p: any) => this.tooltip(p),
      },
      series: [{
        type: 'graph',
        // 力导向：向心引力把边缘节点拉向中心，斥力与分级边长形成恒星系结构
        layout: 'force',
        roam: true,
        draggable: true,
        force: {
          initLayout: 'circular',
          // 斥力提供"碰撞体积"效果，边长分级形成中心紧实、边缘发散
          repulsion: 120,
          gravity: 0.16,
          edgeLength: [40, 110],
          friction: 0.16,
          layoutAnimation: true,
        },
        data: nodes,
        links,
        // Focus & Dim：hover 时非相关元素降到 0.1，相关连线变亮加粗
        emphasis: {
          focus: 'adjacency',
          scale: 1.12,
          lineStyle: { color: pal.l1, opacity: 1, width: 1.8 },
          label: { show: true, fontWeight: 600, color: pal.l1Text, fontSize: 12 },
          itemStyle: { shadowBlur: 22, shadowColor: alpha(pal.l1, 0.42) },
        },
        blur: {
          itemStyle: { opacity: 0.1 },
          lineStyle: { opacity: 0.02 },
          label: { opacity: 0.1 },
        },
        labelLayout: { hideOverlap: true },
      }],
    }, true);

    // 力导向需要时间收敛；收敛后固定坐标并贴合视口，避免持续漂移造成越界
    window.clearTimeout(this.fitTimer);
    this.fitTimer = window.setTimeout(() => this.fitToView(), intro ? 1900 : 1200);

    if (intro) this.playIntro();
  }

  private tooltip(p: any): string {
    const pal = this.pal;
    const muted = `color:${pal.textMuted}`;
    if (p.dataType === 'edge') {
      const e = p.data?.raw;
      if (!e) return '';
      if (e.type === 'dispute') {
        return `<b>争议边</b><br/><span style="${muted}">场景取值相反的一对回答</span><br/>对立度 ${e.opposition ?? '-'}`;
      }
      if (e.type === 'concept') return `<span style="${muted}">概念关联</span>`;
      return `语义相似度 ${e.w}<br/><span style="${muted}">距离越近，观点越相似</span>`;
    }
    const d = p.data;
    if (!d) return '';
    if (d.kind === 'question') {
      return `<b>${this.q.title}</b><br/><span style="${muted}">${this.q.answer_count} 个回答 · ${this.q.stats.k} 个观点簇</span>`;
    }
    if (d.kind === 'concept') {
      const c = d.raw;
      return `<b>概念：${c.name}</b><br/><span style="${muted}">被 ${c.share} 条回答引用 · 跨 ${c.bridge} 个簇${c.bridge > 1 ? '（桥节点）' : ''}</span>`;
    }
    const a = d.raw as AnswerNode;
    return `<b>${a.name}</b> <span style="${muted}">${BADGE_CN[a.badge]}</span>`
      + `<br/>${a.upvotes} 赞 · 质量分 ${a.q.toFixed(2)}`
      + (a.hidden_gem ? ` · <b>被低估</b>` : '')
      + `<br/><span style="${muted}">${STANCE_CN[a.stance]}（置信 ${a.stance_conf}）</span>`
      + `<br/><br/><span style="${muted}">${a.gist}</span>`;
  }

  /** 入场：节点由中心扩散 + 一次涟漪脉冲 */
  private playIntro(): void {
    if (this.introDone) return;
    this.introDone = true;
    window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      const gems = this.q.nodes.filter(isAnswer).filter((a) => a.hidden_gem);
      if (!gems.length) return;
      this.chart.dispatchAction({
        type: 'highlight', seriesIndex: 0,
        dataIndex: gems.map((g) => this.q.nodes.findIndex((n) => n.id === g.id)),
      });
      window.setTimeout(() => {
        this.chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
      }, 900);
    }, 820);
  }

  /** Focus+Context：一阶邻域全亮、二阶半亮、其余压到 0.06
   *
   * 用后端 focus_ctx 预计算索引，前端零图遍历，hover 响应为常数时间。
   */
  private applyFocus(id: string): void {
    const fc = this.q.focus_ctx?.[id];
    if (!fc) return;   // 索引缺失时交给 ECharts 原生 adjacency
    const d1 = new Set(fc.d1);
    const d2 = new Set(fc.d2);
    const opt: any = this.chart.getOption();
    const data: any[] = opt.series[0].data;
    const next = data.map((n: any) => {
      const own = n.id === id;
      const lvl = own ? 1 : d1.has(n.id) ? 0.92 : d2.has(n.id) ? 0.4 : 0.06;
      return {
        ...n,
        itemStyle: { ...n.itemStyle, opacity: lvl },
        label: { ...n.label, show: own || d1.has(n.id) ? true : n.label?.show,
                 opacity: lvl < 0.3 ? 0.08 : 1 },
      };
    });
    const links: any[] = opt.series[0].links.map((l: any) => {
      const touch = l.source === id || l.target === id;
      const near = d1.has(l.source) && d1.has(l.target);
      return {
        ...l,
        lineStyle: {
          ...l.lineStyle,
          color: touch ? this.pal.l1 : l.lineStyle.color,
          width: touch ? 1.9 : l.lineStyle.width,
          opacity: touch ? 1 : near ? 0.22 : 0.02,
        },
      };
    });
    // 用动画过渡而非瞬时切换，透明度渐变不刺眼
    this.chart.setOption({
      series: [{
        data: next, links,
        animation: true,
        animationDuration: 0,
        animationDurationUpdate: FOCUS_FADE_MS,
        animationEasingUpdate: 'cubicOut',
      }],
    });
    this.focused = id;
  }

  private clearFocus(): void {
    if (!this.focused) return;
    this.focused = null;
    // 全量 draw 会重置布局并瞬时跳变；这里只把样式渐变回基线
    const opt: any = this.chart.getOption();
    const base = this.baseStyles;
    if (!base) { this.draw(false); return; }
    const data: any[] = opt.series[0].data.map((n: any) => {
      const b = base.nodes[n.id];
      return b ? { ...n, itemStyle: { ...b.itemStyle }, label: { ...b.label } } : n;
    });
    const links: any[] = opt.series[0].links.map((l: any, i: number) => {
      const b = base.links[i];
      return b ? { ...l, lineStyle: { ...b } } : l;
    });
    this.chart.setOption({
      series: [{
        data, links,
        animation: true,
        animationDuration: 0,
        animationDurationUpdate: FOCUS_FADE_MS,
        animationEasingUpdate: 'cubicOut',
      }],
    });
  }

  focus(id: string): void {
    const idx = this.q.nodes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    this.chart.dispatchAction({ type: 'downplay', seriesIndex: 0 });
    this.chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: idx });
  }

  /** 冻结后按布局坐标直接解析 zoom/center，避免 graphRoam 相对倍率累乘失控 */
  fitToView(): void {
    const dom = this.chart.getDom();
    const W = dom.clientWidth, H = dom.clientHeight;
    if (!W || !H) return;
    const model: any = (this.chart as any).getModel?.();
    const series = model?.getSeriesByIndex?.(0);
    const graph = series?.getGraph?.();
    if (!graph) return;

    // 以布局坐标系为基准统计包围盒（含标签占位，按当前 zoom 折算回布局单位）
    const opt: any = this.chart.getOption();
    const curZoom = opt?.series?.[0]?.zoom ?? 1;
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    graph.eachNode((node: any) => {
      const lay = node.getLayout?.();
      if (!lay) return;
      const item = node.getModel?.();
      const size = item?.get?.(['symbolSize']) ?? 20;
      const rad = (typeof size === 'number' ? size : 20) / 2;
      const show = item?.get?.(['label', 'show']);
      const labW = show ? String(node.name ?? '').length * 11 + 16 : 0;
      const labH = show ? 20 : 4;
      // 节点半径与标签是屏幕像素量，换算到布局单位
      const k = curZoom || 1;
      l = Math.min(l, lay[0] - rad / k);
      r = Math.max(r, lay[0] + (rad + labW) / k);
      t = Math.min(t, lay[1] - (rad + labH) / k);
      b = Math.max(b, lay[1] + (rad + labH) / k);
    });
    if (!isFinite(l)) return;

    const padX = 42, padY = 56;
    const zoom = Math.min(
      (W - padX * 2) / Math.max(r - l, 1),
      (H - padY * 2) / Math.max(b - t, 1),
    );
    if (!isFinite(zoom) || zoom <= 0) return;
    this.chart.setOption({
      series: [{ zoom, center: [(l + r) / 2, (t + b) / 2] }],
    });
  }

  resize(): void {
    this.chart.resize();
    this.fitToView();
  }

  /** 供自动化校验使用：基于力导向实时坐标 */
  debugBounds(): { overflow: number; margins: Record<string, number>; nodes: number } {
    const dom = this.chart.getDom();
    const W = dom.clientWidth, H = dom.clientHeight;
    const model: any = (this.chart as any).getModel?.();
    const series = model?.getSeriesByIndex?.(0);
    const graph = series?.getGraph?.();
    const view: any = (this.chart as any).getViewOfSeriesModel?.(series);
    const grp = view?.group;
    let over = 0, count = 0;
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    graph?.eachNode((node: any) => {
      const lay = node.getLayout?.();
      if (!lay || !grp) return;
      count++;
      const p = grp.transformCoordToGlobal(lay[0], lay[1]);
      const item = node.getModel?.();
      const size = item?.get?.(['symbolSize']) ?? 20;
      const rad = (typeof size === 'number' ? size : 20) / 2;
      const showLabel = item?.get?.(['label', 'show']);
      const labW = showLabel ? String(node.name ?? '').length * 11 + 16 : 0;
      const labH = showLabel ? 20 : 4;
      const L = p[0] - rad, R = p[0] + rad + labW;
      const T = p[1] - rad - labH, B = p[1] + rad + labH;
      l = Math.min(l, L); r = Math.max(r, R);
      t = Math.min(t, T); b = Math.max(b, B);
      if (L < 0 || R > W || T < 0 || B > H) over++;
    });
    return {
      overflow: over,
      nodes: count,
      margins: {
        top: Math.round(t), bottom: Math.round(H - b),
        left: Math.round(l), right: Math.round(W - r),
      },
    };
  }

  clusterOf(c: ClusterInfo): string { return this.clusterColor(c.idx); }
  nodes(): GraphNode[] { return this.q.nodes; }
}
