/** 轻量力导向模拟（d3-force 式，Obsidian 图谱手感）
 *
 * 力学模型：全对斥力（Coulomb）+ 边弹簧（Hooke）+ 弱向心力 + 软碰撞，
 * 速度衰减 + alpha 冷却。拖拽/双击只改 SimNode 的 fx/fy；
 * reheat 加热后周围节点会被真实挤开，冷却后自然静止，不空转烧 CPU。
 */

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 固定坐标（拖拽松手后保持钉住；双击释放回力学） */
  fx: number | null;
  fy: number | null;
  /** 碰撞半径（symbolSize / 2） */
  radius: number;
  /** 被筛掉的节点不参与受力，原地冻结 */
  active: boolean;
}

export interface SimLink {
  source: SimNode;
  target: SimNode;
  distance: number;
  strength: number;
}

const REPULSION = 9200;      // 斥力系数（随距离平方衰减）
const REPULSION_CUT = 380;   // 超过该距离忽略斥力，省算力
const GRAVITY = 0.009;       // 向心系数（轻轻拉向布局原点，防止飞散）
const FRICTION = 0.72;       // 速度保留率（越大越「滑」，越小越「黏」）
const ALPHA_DECAY = 0.032;
const ALPHA_MIN = 0.012;
const TARGET_DECAY = 0.97;   // 加热目标自然回落，拖拽结束较快冷却
const MAX_VELOCITY = 9;
const COLLIDE_PAD = 6;

export class ForceSim {
  alpha = 0;
  private alphaTarget = 0;
  private raf = 0;
  private settled = false;

  constructor(
    private nodes: SimNode[],
    private links: SimLink[],
    private onTick: () => void,
    private onSettle?: () => void,
  ) {}

  /** 加热模拟：alpha 越高节点运动越剧烈 */
  reheat(a = 0.3): void {
    this.alphaTarget = Math.max(this.alphaTarget, a);
    this.alpha = Math.max(this.alpha, a * 0.7);
    this.settled = false;
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private tick = (): void => {
    if (!this.raf) return;
    this.raf = requestAnimationFrame(this.tick);

    this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY;
    this.alphaTarget *= TARGET_DECAY;
    if (this.alpha < ALPHA_MIN && this.alphaTarget < ALPHA_MIN) {
      this.stop();
      this.alpha = 0;
      this.alphaTarget = 0;
      if (!this.settled) {
        this.settled = true;
        this.onSettle?.();
      }
      return;
    }

    const a = this.alpha;
    const ns = this.nodes;

    // 斥力 + 软碰撞
    for (let i = 0; i < ns.length; i++) {
      const na = ns[i];
      if (!na.active) continue;
      for (let j = i + 1; j < ns.length; j++) {
        const nb = ns[j];
        if (!nb.active) continue;
        let dx = nb.x - na.x;
        let dy = nb.y - na.y;
        if (dx === 0 && dy === 0) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        let f = 0;
        if (d < REPULSION_CUT) f += REPULSION / (d * d);
        const minD = na.radius + nb.radius + COLLIDE_PAD;
        if (d < minD) f += (minD - d) * 0.35;
        const fx = (dx / d) * f * a;
        const fy = (dy / d) * f * a;
        na.vx -= fx; na.vy -= fy;
        nb.vx += fx; nb.vy += fy;
      }
    }

    // 弹簧边
    for (const l of this.links) {
      const na = l.source, nb = l.target;
      if (!na.active && !nb.active) continue;
      const dx = nb.x - na.x, dy = nb.y - na.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - l.distance) * l.strength * a;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      if (na.active) { na.vx += fx; na.vy += fy; }
      if (nb.active) { nb.vx -= fx; nb.vy -= fy; }
    }

    // 向心力
    for (const n of ns) {
      if (!n.active) continue;
      n.vx -= n.x * GRAVITY * a;
      n.vy -= n.y * GRAVITY * a;
    }

    // 积分
    for (const n of ns) {
      if (n.fx != null && n.fy != null) {
        n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0;
        continue;
      }
      if (!n.active) { n.vx = 0; n.vy = 0; continue; }
      const v = Math.hypot(n.vx, n.vy);
      if (v > MAX_VELOCITY) {
        n.vx = (n.vx / v) * MAX_VELOCITY;
        n.vy = (n.vy / v) * MAX_VELOCITY;
      }
      n.x += n.vx;
      n.y += n.vy;
      n.vx *= FRICTION;
      n.vy *= FRICTION;
    }

    this.onTick();
  };
}
