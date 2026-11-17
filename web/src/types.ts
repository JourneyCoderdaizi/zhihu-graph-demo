/** 图谱数据契约 —— 与 pipeline.py 产出的 graph.json 一一对应 */

export type Badge = 'authority' | 'normal' | 'org';
export type Stance = 'pro' | 'con' | 'conditional';
export type NodeKind = 'question' | 'answer' | 'concept';
export type EdgeType = 'semantic' | 'dispute' | 'concept';

export interface ScenarioDims {
  charge: number;
  mileage: number;
  horizon: number;
  climate: number;
  [k: string]: number;
}

export interface QuestionNode {
  tier?: VisualTier;
  id: string;
  name: string;
  kind: 'question';
  x: number;
  y: number;
  answer_count: number;
  clusters: number;
}

export interface AnswerNode {
  /** v2 升级字段 */
  cis?: number;
  community_id?: number;
  degree?: number;
  tier?: VisualTier;
  stance_llm?: Stance;
  stance_llm_conf?: number;
  dims_llm?: ScenarioDims;
  gem_note?: string;
  id: string;
  name: string;
  kind: 'answer';
  x: number;
  y: number;
  badge: Badge;
  upvotes: number;
  q: number;
  cluster: number;
  stance: Stance;
  stance_conf: number;
  dims: ScenarioDims;
  hidden_gem: boolean;
  gist: string;
  text: string;
  url?: string;
  headline?: string;
  badge_text?: string;
  source_title?: string;
}

export interface ConceptNode {
  tier?: VisualTier;
  id: string;
  name: string;
  kind: 'concept';
  x: number;
  y: number;
  share: number;
  bridge: number;
}

export type GraphNode = QuestionNode | AnswerNode | ConceptNode;

export interface GraphEdge {
  source: string;
  target: string;
  w: number;
  type: EdgeType;
  opposition?: number;
  /** v2：PMI 信息增益与边分级 */
  sig?: number | null;
  etier?: 'strong' | 'mid' | 'weak' | EdgeType;
  visible?: boolean;
}

/** v2：二阶邻域索引，供 Focus+Context 毫秒级高亮 */
export interface FocusEntry {
  d1: string[];
  d2: string[];
}

export interface ClusterInfo {
  cid: string;
  idx: number;
  size: number;
  name: string;
  axis: string;
  keywords: string;
  dims: ScenarioDims;
  stance: Stance;
  stance_share: number;
  rep_author: string;
  members: string[];
}

export interface GraphStats {
  community_count?: number;
  community_agreement?: number;
  visible_edge_ratio?: number;
  cis_t2?: number;
  tiers?: Record<string, number>;
  answers: number;
  edges: number;
  concepts: number;
  hidden: number;
  k: number;
  upvote_reliable: boolean;
  upvote_zero_ratio: number;
}

export interface QuestionGraph {
  qid: string;
  title: string;
  answer_count: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: ClusterInfo[];
  dispute_pair: [string, string];
  dim_keys: string[];
  dim_label: Record<string, string>;
  layout_axes: [string, string];
  stats: GraphStats;
  focus_ctx?: Record<string, FocusEntry>;
}

export interface GraphMeta {
  data_nature: 'live_zhihu' | 'synthetic_demo';
  source?: string;
  disclaimer: string;
  pipeline_note?: string;
}

export interface UpgradeInfo {
  version: string;
  applied: string[];
  cluster_source: string;
  community_source: string;
  note: string;
}

export interface GraphData {
  meta: GraphMeta;
  upgrade?: UpgradeInfo;
  llm?: { enabled: boolean; model?: string; reason?: string };
  seed: number;
  source_corpus?: string;
  questions: QuestionGraph[];
}

/* ---------- 类型守卫 ---------- */

export const isAnswer = (n: GraphNode): n is AnswerNode => n.kind === 'answer';
export const isConcept = (n: GraphNode): n is ConceptNode => n.kind === 'concept';
export const isQuestion = (n: GraphNode): n is QuestionNode => n.kind === 'question';

/* ---------- 主题 ---------- */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** 图表取色板：由 CSS 变量解析而来，供 ECharts 使用 */
export interface ChartPalette {
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
  accentHover: string;
  accentLight: string;
  /** 身份：权威 / 普通 / 机构 —— 黑白灰三级明度，不引入彩色 */
  badgeAuthority: string;
  badgeNormal: string;
  badgeOrg: string;
  /** 被低估高亮描边 */
  gem: string;
  /** 争议边 */
  dispute: string;
  /** 概念桥 */
  concept: string;
  /** 普通语义边 */
  edge: string;
  /** 观点簇序列色（同色系不同明度） */
  clusters: string[];
  /** 视觉层级：L1 核心 / L2 枢纽 / L3 叶节点 */
  l1: string;
  l2: string;
  l3: string;
  l1Text: string;
  l2Text: string;
  l3Text: string;
}

/** 节点视觉层级：L1 核心主题、L2 关键枢纽、L3 边缘叶节点 */
export type VisualTier = 1 | 2 | 3;
