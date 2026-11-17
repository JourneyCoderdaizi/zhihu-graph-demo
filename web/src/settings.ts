/** 大模型设置面板：本机保存配置，并生成可直接粘贴的环境变量 */

const KEY = 'zhihu-graph-llm-cfg';

export interface LLMConfig {
  base: string;
  key: string;
  model: string;
  emb: string;
}

const EMPTY: LLMConfig = { base: '', key: '', model: '', emb: '' };

const PRESETS: Record<string, Partial<LLMConfig>> = {
  deepseek: {
    base: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    emb: '',
  },
  qwen: {
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    emb: 'text-embedding-v3',
  },
  openai: {
    base: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    emb: 'text-embedding-3-small',
  },
  ollama: {
    base: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    emb: 'nomic-embed-text',
  },
};

/** 6 个 LLM 杠杆点，用于展示当前配置能解锁哪些能力 */
const CAPS: { id: string; name: string; need: 'chat' | 'emb' }[] = [
  { id: 'L1', name: '语义向量化', need: 'emb' },
  { id: 'L2', name: '场景维度打标', need: 'chat' },
  { id: 'L3', name: '立场判定', need: 'chat' },
  { id: 'L4', name: '观点簇命名', need: 'chat' },
  { id: 'L5', name: '被低估解释', need: 'chat' },
  { id: 'L6', name: '全文要点抽取', need: 'chat' },
];

export function loadConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...(JSON.parse(raw) as Partial<LLMConfig>) };
  } catch {
    return { ...EMPTY };
  }
}

function saveConfig(c: LLMConfig): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}

function mask(k: string): string {
  if (!k) return '';
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}****${k.slice(-4)}`;
}

export function initSettings(onChange?: (c: LLMConfig) => void): void {
  const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
  const mask$ = $<HTMLDivElement>('#settings-mask');
  const btn = $<HTMLButtonElement>('#settings-btn');
  const base = $<HTMLInputElement>('#cfg-base');
  const key = $<HTMLInputElement>('#cfg-key');
  const model = $<HTMLInputElement>('#cfg-model');
  const emb = $<HTMLInputElement>('#cfg-emb');
  const status = $<HTMLParagraphElement>('#settings-status');
  const caps = $<HTMLDivElement>('#settings-caps');
  const env = $<HTMLPreElement>('#cfg-env');

  const fill = (c: LLMConfig) => {
    base.value = c.base;
    key.value = c.key;
    model.value = c.model;
    emb.value = c.emb;
  };

  const current = (): LLMConfig => ({
    base: base.value.trim(),
    key: key.value.trim(),
    model: model.value.trim(),
    emb: emb.value.trim(),
  });

  const refresh = () => {
    const c = current();
    const chatOk = !!(c.base && c.key && c.model);
    const embOk = chatOk && !!c.emb;

    status.textContent = chatOk
      ? `已配置 ${c.model}（Key ${mask(c.key)}）`
      : '未配置 —— 所有 LLM 能力降级回规则实现，管线不会中断';
    status.classList.toggle('on', chatOk);
    btn.classList.toggle('on', chatOk);

    caps.innerHTML = CAPS.map((cap) => {
      const on = cap.need === 'emb' ? embOk : chatOk;
      return `<div class="cap-row${on ? ' on' : ''}">
        <span class="cap-dot"></span><b>${cap.id}</b>${cap.name}
        <span style="margin-left:auto;font-size:11px">${
          on ? '可用' : cap.need === 'emb' ? '需 Embedding 模型' : '需 Key'}</span>
      </div>`;
    }).join('');

    if (chatOk) {
      const lines = [
        `export LLM_BASE_URL=${c.base}`,
        `export LLM_API_KEY=${c.key}`,
        `export LLM_MODEL=${c.model}`,
      ];
      if (c.emb) lines.push(`export LLM_EMB_MODEL=${c.emb}`);
      env.textContent = lines.join('\n');
      env.hidden = false;
    } else {
      env.hidden = true;
    }
  };

  fill(loadConfig());
  refresh();

  const open = () => { mask$.hidden = false; refresh(); };
  const close = () => { mask$.hidden = true; };

  btn.addEventListener('click', open);
  $('#settings-close').addEventListener('click', close);
  mask$.addEventListener('click', (e) => { if (e.target === mask$) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !mask$.hidden) close();
  });

  [base, key, model, emb].forEach((el) =>
    el.addEventListener('input', refresh));

  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = PRESETS[b.dataset.preset ?? ''];
      if (!p) return;
      const c = current();
      fill({ ...c, ...p });   // 保留已填的 Key
      refresh();
    });
  });

  $('#cfg-save').addEventListener('click', () => {
    const c = current();
    saveConfig(c);
    refresh();
    onChange?.(c);
    const b = $<HTMLButtonElement>('#cfg-save');
    const old = b.textContent;
    b.textContent = '已保存';
    window.setTimeout(() => { b.textContent = old; }, 1400);
  });

  $('#cfg-clear').addEventListener('click', () => {
    localStorage.removeItem(KEY);
    fill({ ...EMPTY });
    refresh();
    onChange?.({ ...EMPTY });
  });
}
