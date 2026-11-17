import * as echarts from 'echarts';
import type {
  AnswerNode, ChartPalette, ClusterInfo, GraphNode, QuestionGraph,
} from './types';
import { isAnswer, isConcept } from './types';
import { alpha } from './theme';
import { ForceSim } from './force';
import type { SimLink, SimNode } from './force';

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
  /** 力导向模拟：节点位置的唯一事实来源，ECharts 只负责渲染 */
  private sim: ForceSim | null = null;
  private simById = new Map<string, SimNode>();
  private nodeOpts: any[] = [];
  private linkOpts: any[] = [];
  private prevVis: Set<string> | null = null;
  private fitOnSettle = false;
  private dragMoved = 0;
  private suppressClickUntil = 0;
  /** 拖拽节点或平移画布期间为 true：抑制 hover Focus 与 tooltip */
  private pointerBusy = false;

  constructor(
    dom: HTMLElement,
    private onPick: (id: string) => void,
    private onDispute: (a: string, b: string) => void,
  ) {
    this.chart = echarts.init(dom, undefined, { renderer: 'canvas' });
    this.chart.on('click', (p: any) => {
      // 拖拽松手后同一拍内的 click 不触发详情打开
      if (Date.now() < this.suppressClickUntil) return;
      if (p.dataType === 'node' && p.data?.id) {
        this.onPick(p.data.id);
      } else if (p.dataType === 'edge' && p.data?.raw?.type === 'dispute') {
        this.onDispute(p.data.raw.source, p.data.raw.target);
      }
    });
    // 自研拖拽：按住节点即钉住并加热模拟，周围节点被真实挤开
    this.chart.on('mousedown', (p: any) => {
      if (p.dataType === 'node' && p.data?.id) this.beginDrag(p.data.id, p.event);
    });
    // 空白处按下 = 平移画布。ECharts roam 的 pan 与节点拖拽会争抢同一手势
    //（画布反向跟动导致节点「粘手」），因此 roam 只留缩放，平移自己实现。
    this.chart.getZr().on('mousedown', (e: any) => {
      if (e.target) return;   // 落在节点/边上，交给 beginDrag / click
      this.beginPan(e);
    });
    // 双击释放钉住的节点，让它回到力学系统中
    this.chart.on('dblclick', (p: any) => {
      if (p.dataType !== 'node' || !p.data?.id) return;
      const n = this.simById.get(p.data.id);
      if (n && n.fx != null && p.data.kind !== 'question') {
        n.fx = null;
        n.fy = null;
        this.sim?.reheat(0.4);
      }
    });
    // v2 Focus+Context：hover 时用后端预计算的二阶邻域做分级高亮
    // Focus 防抖：鼠标快速扫过时不触发，避免高频重绘造成闪烁
    this.chart.on('mouseover', (p: any) => {
      if (this.pointerBusy) return;   // 拖拽/平移中不做 Focus，避免闪烁
      if (p.dataType !== 'node' || !p.data?.id) return;
      const id = p.data.id;
      window.clearTimeout(this.focusTimer);
      window.clearTimeout(this.unfocusTimer);
      if (this.focused === id) return;
      this.focusTimer = window.setTimeout(() => this.applyFocus(id), FOCUS_ENTER_MS);
    });
    this.chart.on('mouseout', (p: any) => {
      if (this.pointerBusy) return;
      if (p.dataType !== 'node') return;
      window.clearTimeout(this.focusTimer);
      window.clearTimeout(this.unfocusTimer);
      // 离开也延迟，避免节点间移动时反复明暗跳动
      this.unfocusTimer = window.setTimeout(() => this.clearFocus(), FOCUS_LEAVE_MS);
    });
    // 容器尺寸由侧栏/抽屉/视图切换共同影响；用 ResizeObserver 统一接管。
    // 尺寸动画（侧栏 340ms）期间会连续触发，防抖到「最后一次变化后」再处理：
    // 隐藏时量到 0 宽不处理，动画结束若节点被裁出画布才重新贴合视口，
    // 用户手动缩放过的视角在容器变大时不会被重置。
    let resizeTimer = 0;
    new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        this.resizeOnly();
        this.fitIfCropped();
      }, 140);
    }).observe(dom);
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
          x: n.x, y: n.y,
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
          x: n.x, y: n.y,
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
          x: n.x, y: n.y,
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
            color: pal.dispute, width: 2.2, type: 'dashed',
            curveness: 0, opacity: live ? 0.8 : 0.04,
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

    // 力学模拟是位置的唯一事实来源：重绘时沿用上次的物理位置，
    // 主题/筛选切换不会把节点瞬移回后端预计算坐标
    for (const o of nodes) {
      const s = this.simById.get(o.id);
      if (s) { o.x = s.x; o.y = s.y; }
      o.cursor = 'grab';
    }
    this.nodeOpts = nodes;
    this.linkOpts = links;

    // 筛选/主题复用同一份预计算坐标：保留用户当前缩放与平移，避免视角被重置
    const prev = ((this.chart.getOption() as any)?.series?.[0] ?? null) as any;
    const keepView = !intro && prev && prev.zoom != null
      ? { zoom: prev.zoom, center: prev.center ?? undefined }
      : {};

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
        // 布局由前端力导向模拟驱动（force.ts）：节点持续受力，
        // 拖拽/筛选/换题都会真实地加热重排，而非一次性静态排版。
        layout: 'none',
        roam: 'scale',   // 只留滚轮缩放；平移由 beginPan 实现，与节点拖拽互不干扰
        draggable: false,   // 拖拽由自研 beginDrag 接管，避免双份处理
        ...keepView,
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

    // 记录无 Focus 时的基线样式：hover 结束只做透明度还原，绝不重建布局
    this.baseStyles = {
      nodes: Object.fromEntries(nodes.map((n) => [
        n.id,
        { itemStyle: { ...n.itemStyle }, label: { ...(n.label ?? {}) } },
      ])),
      links: links.map((l) => ({ ...l.lineStyle })),
    };

    // 渲染后贴合一次视口；力学稳定后再贴合一次，补偿 settle 漂移
    window.clearTimeout(this.fitTimer);
    if (intro) {
      this.fitTimer = window.setTimeout(() => this.fitToView(), 60);
      this.playIntro();
    }
    this.buildSim(intro);
  }

  /**
   * 以当前可见性重建力学系统。
   * 换题时从初始坐标大幅加热（intro 爆发式展开），
   * 筛选可见性变化时轻微加热让可见节点重新散开，
   * 纯主题切换只给一点余温，几乎不动。
   */
  private buildSim(intro: boolean): void {
    const q = this.q;
    this.sim?.stop();
    const visIds = new Set(
      q.nodes.filter(isAnswer).filter((a) => this.visible(a)).map((a) => a.id),
    );

    const nodes: SimNode[] = [];
    for (const o of this.nodeOpts) {
      let n = this.simById.get(o.id);
      if (!n) {
        const jx = intro ? (Math.random() - 0.5) * 70 : 0;
        const jy = intro ? (Math.random() - 0.5) * 70 : 0;
        n = {
          id: o.id,
          x: o.x + jx, y: o.y + jy,
          vx: 0, vy: 0,
          fx: null, fy: null,
          radius: (typeof o.symbolSize === 'number' ? o.symbolSize : 16) / 2,
          active: true,
        };
        this.simById.set(o.id, n);
      }
      n.radius = (typeof o.symbolSize === 'number' ? o.symbolSize : 16) / 2;
      // 中心问题始终钉在布局原点，作为全图的引力锚
      if (o.kind === 'question' && n.fx == null) { n.fx = o.x; n.fy = o.y; }
      n.active = o.kind !== 'answer' || visIds.has(o.id);
      nodes.push(n);
    }

    const links: SimLink[] = [];
    for (const l of this.linkOpts) {
      const a = this.simById.get(l.source);
      const b = this.simById.get(l.target);
      if (!a || !b) continue;
      const raw = l.raw;
      let distance = 190, strength = 0.05;
      if (!raw) { distance = 260; strength = 0.018; }            // 问题 → 簇代表
      else if (raw.type === 'dispute') { distance = 350; strength = 0.008; }
      else if (raw.type === 'concept') { distance = 125; strength = 0.05; }
      else if (raw.etier === 'strong') { distance = 150; strength = 0.11; }
      else if (raw.etier === 'mid') { distance = 195; strength = 0.06; }
      else if (raw.etier === 'weak') { distance = 235; strength = 0.02; }
      links.push({ source: a, target: b, distance, strength });
    }

    const visChanged = !this.prevVis
      || visIds.size !== this.prevVis.size
      || [...visIds].some((id) => !this.prevVis!.has(id));
    this.prevVis = visIds;
    this.fitOnSettle = intro;

    this.sim = new ForceSim(nodes, links, () => this.simTick(), () => {
      // 冷却后恢复动画开关，并补偿性贴合一次视口
      this.chart.setOption({
        animation: true,
        animationDuration: 380,
        animationEasing: 'cubicOut',
        animationDurationUpdate: 380,
        animationEasingUpdate: 'cubicInOut',
      });
      if (this.fitOnSettle) {
        this.fitOnSettle = false;
        this.fitToView();
      }
    });

    if (intro) this.sim.reheat(0.9);
    else if (visChanged) this.sim.reheat(0.32);
    else this.sim.reheat(0.12);
  }

  /** 每帧把物理位置写回 ECharts（全量 data 按索引合并，样式不动） */
  private simTick(): void {
    const dom = this.chart.getDom();
    if (!dom.clientWidth || !dom.clientHeight) return;   // 列表视图下不渲染
    if (!this.sim) return;
    for (const o of this.nodeOpts) {
      const n = this.simById.get(o.id);
      if (!n) continue;
      o.x = n.x;
      o.y = n.y;
    }
    this.chart.setOption({
      animation: false,
      series: [{ data: this.nodeOpts }],
    });
  }

  /** 自研节点拖拽：按住即钉住、局部加热，松手保持位置，拖动不触发点击 */
  private beginDrag(id: string, ev: any): void {
    const n = this.simById.get(id);
    if (!n || !ev) return;
    this.dragMoved = 0;
    this.pointerBusy = true;
    const dom = this.chart.getDom();
    dom.style.cursor = 'grabbing';
    this.chart.dispatchAction({ type: 'hideTip' });

    // 记录指针与节点中心的偏移，拖动时节点不跳变到指针正下方
    let offX = 0, offY = 0;
    try {
      const pt = this.chart.convertFromPixel(
        { seriesIndex: 0 }, [ev.offsetX ?? 0, ev.offsetY ?? 0]) as any;
      if (pt && isFinite(pt[0]) && isFinite(pt[1])) {
        offX = n.x - pt[0];
        offY = n.y - pt[1];
      }
    } catch { /* 转换失败就按节点中心拖 */ }

    const move = (e: MouseEvent) => {
      const rect = dom.getBoundingClientRect();
      let pt: number[] | null = null;
      try {
        pt = this.chart.convertFromPixel({ seriesIndex: 0 },
          [e.clientX - rect.left, e.clientY - rect.top]) as any;
      } catch { return; }
      if (!pt || !isFinite(pt[0]) || !isFinite(pt[1])) return;
      this.dragMoved++;
      n.fx = pt[0] + offX;
      n.fy = pt[1] + offY;
      // 拖动时温和加热即可，避免邻居被推得太猛显得「搅」
      this.sim?.reheat(0.22);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dom.style.cursor = '';
      this.pointerBusy = false;
      if (this.dragMoved > 3) this.suppressClickUntil = Date.now() + 250;
      this.sim?.reheat(0.12);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  /** 空白处按下拖动 = 平移画布 */
  private beginPan(ev: any): void {
    const dom = this.chart.getDom();
    const s0: any = (this.chart.getOption() as any)?.series?.[0] ?? {};
    const c0: number[] = Array.isArray(s0.center) ? [...s0.center] : [0, 0];
    const startX = ev.offsetX ?? 0, startY = ev.offsetY ?? 0;
    // ECharts graph 的 View 存在基准倍率（像素/布局 ≈ 1.25 × zoom），
    // 直接用 zoom 换算会少移 25% —— 画布「跟不上手」。实测比例最稳妥。
    let scale = s0.zoom ?? 1;
    try {
      const a = this.chart.convertToPixel({ seriesIndex: 0 }, c0 as any) as any;
      const b = this.chart.convertToPixel({ seriesIndex: 0 }, [c0[0] + 100, c0[1]] as any) as any;
      if (a && b && isFinite(b[0] - a[0]) && b[0] !== a[0]) {
        scale = (b[0] - a[0]) / 100;
      }
    } catch { /* 失败退回 zoom 近似 */ }
    this.pointerBusy = true;
    dom.style.cursor = 'grabbing';
    this.chart.dispatchAction({ type: 'hideTip' });

    const move = (e: MouseEvent) => {
      const rect = dom.getBoundingClientRect();
      const dx = (e.clientX - rect.left) - startX;
      const dy = (e.clientY - rect.top) - startY;
      this.chart.setOption({
        animation: false,   // 平移必须逐帧跟手，不能带补间动画
        series: [{ center: [c0[0] - dx / scale, c0[1] - dy / scale] }],
      });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      dom.style.cursor = '';
      this.pointerBusy = false;
      // 平移结束时模拟多半处于冷却态，这里把动画开关还原
      this.chart.setOption({
        animation: true,
        animationDuration: 380,
        animationEasing: 'cubicOut',
        animationDurationUpdate: 380,
        animationEasingUpdate: 'cubicInOut',
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  private tooltip(p: any): string {
    const pal = this.pal;
    const muted = `color:${pal.textMuted}`;
    if (p.dataType === 'edge') {
      const e = p.data?.raw;
      if (!e) return '';
      if (e.type === 'dispute') {
        return `<b>争议边</b><br/><span style="${muted}">场景取值相反的一对回答</span><br/>对立度 ${e.opposition ?? '-'}<br/><span style="${muted}">点击查看正反对比</span>`;
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
      + `<br/><br/><span style="${muted}">${a.gist}</span>`
      + `<br/><br/><span style="${muted}">拖拽可固定位置 · 双击释放</span>`;
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

  /**
   * 把当前可见节点收进视口。
   *
   * 直接用 convertToPixel 实测「布局坐标 → 像素」的投影关系，再按比例反推 zoom，
   * 并把包围盒像素中心反投回布局坐标作为 center —— 这样不依赖 ECharts 内部
   * zoom 的基准倍率（graph 的 View 基准并非 1:1），也不会出现「算出来贴合、
   * 实际上下被裁掉」的偏差。
   */
  fitToView(): void {
    const dom = this.chart.getDom();
    const W = dom.clientWidth, H = dom.clientHeight;
    if (!W || !H) return;
    const opt: any = this.chart.getOption();
    const data: any[] = opt?.series?.[0]?.data ?? [];
    const zoomCur = opt?.series?.[0]?.zoom ?? 1;
    if (!data.length) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of data) {
      if (n.itemStyle?.opacity === 0.1) continue;   // 被筛掉的节点不参与取景
      let px: number[] | null = null;
      try {
        px = this.chart.convertToPixel({ seriesIndex: 0 }, [n.x, n.y]) as any;
      } catch {
        return;
      }
      if (!px || !isFinite(px[0]) || !isFinite(px[1])) return;
      minX = Math.min(minX, px[0]);
      maxX = Math.max(maxX, px[0]);
      minY = Math.min(minY, px[1]);
      maxY = Math.max(maxY, px[1]);
    }
    if (!isFinite(minX)) return;

    // 屏幕像素留白：节点半径 + 右侧/下方标签的占位
    const padX = 76, padY = 58;
    const availW = W - padX * 2, availH = H - padY * 2;
    const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
    const ratio = Math.min(availW / spanX, availH / spanY);
    const zoom = Math.min(Math.max(zoomCur * ratio, 0.15), 4);
    if (!isFinite(zoom) || zoom <= 0) return;

    const mid = [(minX + maxX) / 2, (minY + maxY) / 2];
    let center: number[] | null = null;
    try {
      center = this.chart.convertFromPixel({ seriesIndex: 0 }, mid as any) as any;
    } catch {
      center = null;
    }
    if (!center || !isFinite(center[0]) || !isFinite(center[1])) return;

    this.chart.setOption({
      series: [{ zoom, center }],
      animationDurationUpdate: 220,
      animationEasingUpdate: 'cubicOut',
    });
  }

  /** 尺寸变化只重算画布，不改变用户当前视角 */
  private resizeOnly(): void {
    const dom = this.chart.getDom();
    if (!dom.clientWidth || !dom.clientHeight) return;
    this.chart.resize();
  }

  /**
   * 画布尺寸变化后只在「节点确实被裁出可视区」时重新贴合。
   * 这样侧栏展开能救回被裁掉的节点，而单纯放大窗口不会打断用户的缩放。
   */
  private fitIfCropped(): void {
    const dom = this.chart.getDom();
    const W = dom.clientWidth, H = dom.clientHeight;
    if (!W || !H) return;
    const nodes: any[] = ((this.chart.getOption() as any)?.series?.[0]?.data ?? []);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    try {
      for (const n of nodes) {
        if (n.itemStyle?.opacity === 0.1) continue;   // 被筛掉的节点不参与判定
        const px = this.chart.convertToPixel({ seriesIndex: 0 }, [n.x, n.y]);
        if (!px || !isFinite(px[0]) || !isFinite(px[1])) return;
        const r = (typeof n.symbolSize === 'number' ? n.symbolSize : 20) / 2 + 10;
        minX = Math.min(minX, px[0] - r);
        maxX = Math.max(maxX, px[0] + r);
        minY = Math.min(minY, px[1] - r);
        maxY = Math.max(maxY, px[1] + r);
      }
    } catch {
      return;
    }
    if (!isFinite(minX)) return;
    // 允许少量出血，超出即视为被裁，重新贴合一次
    const bleed = 24;
    if (minX < -bleed || maxX > W + bleed || minY < -bleed || maxY > H + bleed) {
      this.fitToView();
    }
  }

  resize(): void {
    this.resizeOnly();
    this.fitToView();
  }

  /** 供自动化校验使用：基于固定布局坐标 */
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
