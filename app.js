/* 知乎问答关系图谱 · 前端交互
   数据契约: data/graph.json (由 pipeline.py 离线生成，运行时零 API 调用) */

const C = {
  authority: '#4a9eff', normal: '#8b96a5', org: '#f0883e',
  gem: '#ffd24a', dispute: '#ff6b6b', question: '#ffffff', concept: '#5fd4a8'
};
const BADGE_CN = { authority: '权威答主', normal: '普通用户', org: '机构号' };
const STANCE_CN = { pro: '正方', con: '反方', conditional: '条件派' };

let G = null, Q = null, chart = null;
const state = {
  badge: new Set(['authority', 'normal', 'org']),
  qual: new Set(),          // 'high' | 'gem'
  hiddenClusters: new Set(),
  view: 'graph'
};

/* ---------- 载入 ---------- */
fetch('data/graph.json').then(r => r.json()).then(d => {
  G = d;
  const sel = document.getElementById('qsel');
  d.questions.forEach(q => {
    const o = document.createElement('option');
    o.value = q.qid;
    o.textContent = q.title + `（${q.answer_count} 个回答）`;
    sel.appendChild(o);
  });
  const live = (d.meta || {}).data_nature === 'live_zhihu';
  const sb = document.getElementById('srcbadge');
  sb.textContent = live ? '真实知乎数据' : '演示语料';
  sb.style.color = live ? '#4a9eff' : '#f0883e';
  sb.style.borderColor = live ? 'rgba(74,158,255,.45)' : 'rgba(240,136,62,.4)';
  chart = echarts.init(document.getElementById('chart'), null, { renderer: 'canvas' });
  chart.on('click', p => { if (p.dataType === 'node') openDrawer(p.data.id); });
  window.addEventListener('resize', () => chart && chart.resize());
  load(d.questions[0].qid);
});

document.getElementById('go').onclick = () => load(document.getElementById('qsel').value);
document.getElementById('qsel').onchange = () => load(document.getElementById('qsel').value);

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  state.view = t.dataset.v;
  const isG = state.view === 'graph';
  document.getElementById('chart').style.display = isG ? '' : 'none';
  document.getElementById('listview').style.display = isG ? 'none' : 'block';
  document.getElementById('legend').style.display = isG ? '' : 'none';
  document.getElementById('axishint').style.display = isG ? '' : 'none';
  if (isG) chart.resize(); else renderList();
});

function load(qid) {
  Q = G.questions.find(q => q.qid === qid);
  state.hiddenClusters.clear();
  state.qual.clear();
  document.getElementById('stat').textContent =
    `${Q.stats.answers} 回答 · ${Q.stats.k} 个观点簇 · ${Q.stats.edges} 条关系 · ${Q.stats.hidden} 条被低估`;
  buildSide(); renderLegend(); renderAxisHint(); render();
}

/* ---------- 侧边栏 ---------- */
const answers = () => Q.nodes.filter(n => n.kind === 'answer');

function buildSide() {
  const fb = document.getElementById('f-badge'); fb.innerHTML = '';
  ['authority', 'normal', 'org'].forEach(b => {
    const n = answers().filter(a => a.badge === b).length;
    const el = div('filter' + (state.badge.has(b) ? ' on' : ''),
      `<span class="dot" style="background:${C[b]}"></span>${BADGE_CN[b]}<span class="n">${n}</span>`);
    el.onclick = () => {
      state.badge.has(b) ? state.badge.delete(b) : state.badge.add(b);
      el.classList.toggle('on'); render();
    };
    fb.appendChild(el);
  });

  const fq = document.getElementById('f-qual'); fq.innerHTML = '';
  [['high', '只看高质量（Q 前 30%）', C.authority],
   ['gem', '只看被低估（高质量低赞）', C.gem]].forEach(([k, label, col]) => {
    const el = div('filter', `<span class="dot" style="background:${col}"></span>${label}`);
    el.onclick = () => {
      state.qual.has(k) ? state.qual.delete(k) : state.qual.add(k);
      el.classList.toggle('on'); render();
    };
    fq.appendChild(el);
  });

  const fc = document.getElementById('f-clu'); fc.innerHTML = '';
  Q.clusters.forEach(c => {
    const el = div('clu', `<b>${c.axis}</b><i>${c.keywords} · ${c.size} 条 · 代表 ${c.rep_author}</i>`);
    el.style.borderLeftColor = clusterColor(c.idx);
    el.onclick = () => {
      state.hiddenClusters.has(c.idx) ? state.hiddenClusters.delete(c.idx)
                                      : state.hiddenClusters.add(c.idx);
      el.classList.toggle('off'); render();
    };
    fc.appendChild(el);
  });

  const gm = document.getElementById('gems'); gm.innerHTML = '';
  const gems = answers().filter(a => a.hidden_gem).sort((x, y) => y.q - x.q);
  if (!gems.length) gm.innerHTML = '<i style="color:#8b96a5;font-size:12px">本题无明显长尾干货</i>';
  gems.forEach(a => {
    const el = div('gemitem', `<b>${a.name}</b><i>Q ${a.q.toFixed(2)} · 仅 ${a.upvotes} 赞</i>`);
    el.onclick = () => openDrawer(a.id);
    gm.appendChild(el);
  });
}

function div(cls, html) { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; return d; }

const CLUSTER_COLORS = ['#2f81f7', '#f0883e', '#5fd4a8', '#b07cf0', '#ff6b6b'];
const clusterColor = i => CLUSTER_COLORS[i % CLUSTER_COLORS.length];

/* ---------- 可见性 ---------- */
function qThreshold() {
  const qs = answers().map(a => a.q).sort((a, b) => b - a);
  return qs[Math.max(0, Math.floor(qs.length * 0.3) - 1)] ?? 0;
}
function visible(a) {
  if (!state.badge.has(a.badge)) return false;
  if (state.hiddenClusters.has(a.cluster)) return false;
  if (state.qual.has('gem') && !a.hidden_gem) return false;
  if (state.qual.has('high') && a.q < qThreshold()) return false;
  return true;
}

/* ---------- 图谱 ---------- */
function render() {
  if (state.view === 'list') { renderList(); return; }
  const vis = new Set(answers().filter(visible).map(a => a.id));

  const nodes = [];
  nodes.push({
    id: Q.qid, name: Q.title, kind: 'question',
    symbolSize: 54, x: 0, y: 0,
    itemStyle: { color: '#ffffff', borderColor: '#2f81f7', borderWidth: 3 },
    label: { show: true, position: 'inside', color: '#0d1117',
             fontSize: 11, fontWeight: 'bold',
             formatter: () => '问题' }
  });

  answers().forEach(a => {
    const on = vis.has(a.id);
    // 标签按节点在簇内的左右位置交替放置，减少同侧叠字
    const side = a.x >= 0 ? 'right' : 'left';
    nodes.push({
      id: a.id, name: a.name, kind: 'answer', raw: a,
      x: a.x, y: a.y,
      symbolSize: 16 + a.q * 30,
      itemStyle: {
        color: C[a.badge],
        borderColor: a.hidden_gem ? C.gem : 'rgba(0,0,0,0)',
        borderWidth: a.hidden_gem ? 3.2 : 0,
        opacity: on ? 1 : 0.15
      },
      label: {
        show: a.q > 0.45 || a.hidden_gem, position: side, fontSize: 10.5,
        distance: 7,
        color: on ? '#dbe4ee' : 'rgba(201,212,224,.2)',
        textShadowColor: '#0d1117', textShadowBlur: 4,
        formatter: () => a.name
      }
    });
  });

  Q.nodes.filter(n => n.kind === 'concept').forEach(c => {
    nodes.push({
      id: c.id, name: c.name, kind: 'concept', raw: c,
      x: c.x, y: c.y,
      symbolSize: 9 + c.share * 1.5, symbol: 'diamond',
      itemStyle: { color: C.concept, opacity: c.bridge > 1 ? .95 : .5 },
      label: { show: c.bridge > 1, position: c.x >= 0 ? 'top' : 'bottom', fontSize: 10,
               color: '#5fd4a8', textShadowColor: '#0d1117', textShadowBlur: 4,
               formatter: () => c.name }
    });
  });

  const links = Q.edges.map(e => {
    const on = (vis.has(e.source) || e.source === Q.qid || e.source.includes('-k-')) &&
               (vis.has(e.target) || e.target === Q.qid);
    if (e.type === 'dispute') {
      return { source: e.source, target: e.target, raw: e,
        lineStyle: { color: C.dispute, width: 2.4, type: 'dashed', curveness: .12,
                     opacity: on ? .95 : .1 } };
    }
    if (e.type === 'concept') {
      return { source: e.source, target: e.target, raw: e,
        lineStyle: { color: C.concept, width: .9, opacity: on ? .3 : .05, curveness: 0 } };
    }
    return { source: e.source, target: e.target, raw: e,
      lineStyle: { color: '#3a4659', width: .7 + e.w * 3.2,
                   opacity: on ? .62 : .06, curveness: 0 } };
  });

  // 中心主题节点连到每簇的代表回答，保证"问题 → 观点簇"的起点关系可见
  Q.clusters.forEach(c => {
    const rep = answers().find(a => a.name === c.rep_author);
    if (rep) links.push({ source: Q.qid, target: rep.id,
      lineStyle: { color: clusterColor(c.idx), width: 1.6, opacity: .5, curveness: 0 } });
  });

  // layout:'none' 不会自动适配视口：需按"节点半径 + 标签占位"外扩包围盒再算 center/zoom，
  // 否则最外圈节点与其标签会被画布四边裁切。
  const laid = nodes.filter(n => typeof n.x === 'number');
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  laid.forEach(n => {
    const r = (n.symbolSize || 20) / 2;
    const lab = n.label && n.label.show ? (String(n.name).length * 11 + 14) : 0;
    minX = Math.min(minX, n.x - r - lab);
    maxX = Math.max(maxX, n.x + r + lab);
    minY = Math.min(minY, n.y - r - 14);
    maxY = Math.max(maxY, n.y + r + 14);
  });
  const spanX = Math.max(maxX - minX, 1), spanY = Math.max(maxY - minY, 1);
  const box = chart.getDom();
  const padW = box.clientWidth - 40, padH = box.clientHeight - 40;
  const fitZoom = Math.min(padW / spanX, padH / spanY);

  chart.setOption({
    backgroundColor: '#0d1117',
    tooltip: {
      backgroundColor: 'rgba(21,27,36,.97)', borderColor: '#263041',
      textStyle: { color: '#e6edf3', fontSize: 12 }, extraCssText: 'max-width:300px;white-space:normal',
      formatter: p => {
        if (p.dataType === 'edge') {
          const e = p.data.raw; if (!e) return '';
          if (e.type === 'dispute') return `<b style="color:#ff6b6b">争议边</b><br/>场景取值相反的一对回答<br/>对立度 ${e.opposition}`;
          if (e.type === 'concept') return '概念关联';
          return `语义相似度 ${e.w}<br/><i style="color:#8b96a5">距离越近，观点越相似</i>`;
        }
        const d = p.data;
        if (d.kind === 'question') return `<b>${Q.title}</b><br/>${Q.answer_count} 个回答 · ${Q.stats.k} 个观点簇`;
        if (d.kind === 'concept') return `<b style="color:#5fd4a8">概念：${d.name}</b><br/>被 ${d.raw.share} 条回答引用<br/>跨 ${d.raw.bridge} 个观点簇${d.raw.bridge > 1 ? '（桥节点）' : ''}`;
        const a = d.raw;
        return `<b>${a.name}</b> <span style="color:#8b96a5">${BADGE_CN[a.badge]}</span>`
          + `<br/>${a.upvotes} 赞 · 质量分 ${a.q.toFixed(2)}`
          + (a.hidden_gem ? ' <span style="color:#ffd24a">· 被低估</span>' : '')
          + `<br/><span style="color:#8b96a5">${STANCE_CN[a.stance]}（置信 ${a.stance_conf}）</span>`
          + `<br/><br/>${a.gist}`;
      }
    },
    series: [{
      type: 'graph', layout: 'none', roam: true, draggable: true,
      center: [(minX + maxX) / 2, (minY + maxY) / 2],
      zoom: fitZoom,
      data: nodes, links,
      animation: false,
      emphasis: { focus: 'adjacency', scale: 1.08,
                  lineStyle: { opacity: .95 }, label: { show: true } },
      labelLayout: { hideOverlap: true }
    }]
  }, true);

  // 渲染后按实际像素包围盒做一次精确对齐：把所有节点（含标签占位）压进可视区。
  // setOption 的 zoom/center 受 roam 状态影响，不保证一次到位，故用实测值校正。
  fitToView();
}

function fitToView() {
  const dom = chart.getDom();
  const W = dom.clientWidth, H = dom.clientHeight;
  const data = chart.getOption().series[0].data;
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
  data.forEach(n => {
    if (typeof n.x !== 'number') return;
    const p = chart.convertToPixel({ seriesIndex: 0 }, [n.x, n.y]);
    if (!p) return;
    const rad = (n.symbolSize || 20) / 2;
    const labW = (n.label && n.label.show) ? String(n.name).length * 11 + 16 : 0;
    const left = (n.label && n.label.position === 'left') ? labW : 0;
    const right = (n.label && n.label.position !== 'left') ? labW : 0;
    l = Math.min(l, p[0] - rad - left);
    r = Math.max(r, p[0] + rad + right);
    const labH = (n.label && n.label.show) ? 20 : 4;
    t = Math.min(t, p[1] - rad - labH);
    b = Math.max(b, p[1] + rad + labH);
  });
  if (!isFinite(l)) return;
  // 连线也会越过节点包围盒（曲率 + 中心节点放射边），把边端点一并计入
  const links = chart.getOption().series[0].links || [];
  const byId = {};
  data.forEach(n => { if (typeof n.x === 'number') byId[n.id] = n; });
  links.forEach(e => {
    [e.source, e.target].forEach(id => {
      const n = byId[id];
      if (!n) return;
      const p = chart.convertToPixel({ seriesIndex: 0 }, [n.x, n.y]);
      if (!p) return;
      l = Math.min(l, p[0] - 6); r = Math.max(r, p[0] + 6);
      t = Math.min(t, p[1] - 6); b = Math.max(b, p[1] + 6);
    });
  });
  const pad = 34;
  const scale = Math.min((W - pad * 2) / Math.max(r - l, 1),
                         (H - pad * 2 - 18) / Math.max(b - t, 1));
  // 先缩放到刚好容纳
  chart.dispatchAction({ type: 'graphRoam', zoom: scale,
                         originX: (l + r) / 2, originY: (t + b) / 2 });
  // 缩放会改变像素位置，重测一次包围盒再平移到画布中心
  let l3 = Infinity, r3 = -Infinity, t3 = Infinity, b3 = -Infinity;
  data.forEach(n => {
    if (typeof n.x !== 'number') return;
    const p = chart.convertToPixel({ seriesIndex: 0 }, [n.x, n.y]);
    if (!p) return;
    const rad = (n.symbolSize || 20) / 2;
    const labW = (n.label && n.label.show) ? String(n.name).length * 11 + 16 : 0;
    l3 = Math.min(l3, p[0] - rad - ((n.label && n.label.position === 'left') ? labW : 0));
    r3 = Math.max(r3, p[0] + rad + ((n.label && n.label.position !== 'left') ? labW : 0));
    const labH3 = (n.label && n.label.show) ? 20 : 4;
    t3 = Math.min(t3, p[1] - rad - labH3);
    b3 = Math.max(b3, p[1] + rad + labH3);
  });
  chart.dispatchAction({ type: 'graphRoam',
                         dx: W / 2 - (l3 + r3) / 2, dy: H / 2 - (t3 + b3) / 2 });
}

/* ---------- 列表视图 ---------- */
function renderList() {
  const box = document.getElementById('listview');
  const rows = answers().filter(visible).sort((a, b) => b.q - a.q);
  box.innerHTML = rows.length ? '' : '<p style="color:#8b96a5">当前滤镜下没有回答。</p>';
  rows.forEach(a => {
    const el = div('row' + (a.hidden_gem ? ' gem' : ''),
      `<div class="t"><b>${a.name}</b>
        <span class="tag" style="color:${C[a.badge]}">${BADGE_CN[a.badge]}</span>
        <span class="tag">${a.upvotes} 赞</span>
        <span class="tag">Q ${a.q.toFixed(2)}</span>
        <span class="tag">${STANCE_CN[a.stance]}</span>
        ${a.hidden_gem ? '<span class="tag" style="color:#ffd24a">被低估</span>' : ''}</div>
       <div class="g">${a.gist}</div>`);
    if (!a.hidden_gem) el.style.borderLeftColor = clusterColor(a.cluster);
    el.onclick = () => openDrawer(a.id);
    box.appendChild(el);
  });
}

/* ---------- 抽屉 ---------- */
function openDrawer(id) {
  const dw = document.getElementById('dw');
  const node = Q.nodes.find(n => n.id === id);
  if (!node) return;
  document.getElementById('drawer').classList.add('open');

  if (node.kind === 'question') {
    dw.innerHTML = `<span class="close" onclick="closeDrawer()">×</span>
      <h2>${Q.title}</h2>
      <div class="sub">${Q.answer_count} 个回答 · 聚成 ${Q.stats.k} 个观点簇</div>
      ${Q.clusters.map(c => `<div class="cmpcard" style="margin-bottom:9px;border-left:3px solid ${clusterColor(c.idx)}">
        <b>${c.axis}</b><p>${c.keywords} · ${c.size} 条 · 代表 ${c.rep_author}</p></div>`).join('')}
      ${disclaimerHTML()}`;
    return;
  }

  if (node.kind === 'concept') {
    const refs = Q.edges.filter(e => e.source === node.id)
      .map(e => Q.nodes.find(n => n.id === e.target)).filter(Boolean);
    dw.innerHTML = `<span class="close" onclick="closeDrawer()">×</span>
      <h2 style="color:#5fd4a8">概念：${node.name}</h2>
      <div class="sub">被 ${node.share} 条回答引用，跨 ${node.bridge} 个观点簇
        ${node.bridge > 1 ? '· 这是连接不同立场的桥' : ''}</div>
      ${refs.map(r => `<div class="cmpcard" style="margin-bottom:8px">
        <b>${r.name}</b><p>${r.gist}</p></div>`).join('')}
      ${disclaimerHTML()}`;
    return;
  }

  const a = node;
  const dsp = Q.edges.find(e => e.type === 'dispute' &&
    (e.source === a.id || e.target === a.id));
  const foe = dsp ? Q.nodes.find(n => n.id === (dsp.source === a.id ? dsp.target : dsp.source)) : null;
  const clu = Q.clusters.find(c => c.idx === a.cluster);

  dw.innerHTML = `<span class="close" onclick="closeDrawer()">×</span>
    <h2>${a.name}</h2>
    <div class="sub">${BADGE_CN[a.badge]} · ${a.upvotes} 赞 · 所属簇「${clu ? clu.axis : '-'}」</div>
    <div class="chips">
      <span class="chip">质量分 ${a.q.toFixed(2)}</span>
      <span class="chip">${STANCE_CN[a.stance]} · 置信 ${a.stance_conf}</span>
      ${a.hidden_gem ? '<span class="chip hi">被低估的长尾干货</span>' : ''}
    </div>
    <h3 style="font-size:11px;color:#8b96a5;letter-spacing:1px;margin:4px 0 9px">场景维度</h3>
    ${Object.entries(a.dims).map(([k, v]) => dimBar(G.questions[0].dim_label[k] || k, v)).join('')}
    <div class="body">${a.text}</div>
    ${foe ? `<h3 style="font-size:11px;color:#ff6b6b;letter-spacing:1px;margin:15px 0 9px">争议对比</h3>
      <div class="cmp">
        <div class="cmpcard a"><b>${a.name}</b><p>${a.gist}</p></div>
        <div class="cmpcard b"><b>${foe.name}</b><p>${foe.gist}</p></div>
      </div>` : ''}
    <div style="margin-top:14px">${a.url
      ? `<a href="${a.url}" target="_blank" rel="noopener" style="color:#2f81f7;font-size:12px">→ 在知乎打开原文</a>`
      : '<span style="color:#8b96a5;font-size:12px">该条无原文链接</span>'}</div>
    ${disclaimerHTML()}`;
}
function dimBar(label, v) {
  const pct = Math.abs(v) * 50;
  const left = v >= 0 ? 50 : 50 - pct;
  return `<div class="dimbar"><div class="lb"><span>${label}</span><span>${v >= 0 ? '+' : ''}${v}</span></div>
    <div class="track"><span class="mid"></span>
    <span class="fill" style="left:${left}%;width:${pct}%;background:${v >= 0 ? '#2f81f7' : '#f0883e'}"></span></div></div>`;
}
function disclaimerHTML() {
  const m = G.meta || {};
  const live = m.data_nature === 'live_zhihu';
  const extra = (Q.stats && Q.stats.upvote_reliable === false)
    ? '<br/>注意：本题赞数字段多数为 0，接口未提供可信赞数，已关闭「被低估」识别。'
    : '';
  return `<div class="disclaimer" style="${live
    ? 'background:rgba(47,129,247,.08);border-color:rgba(47,129,247,.35);color:#9db9e0'
    : ''}">${live
      ? '真实数据：知乎开放平台搜索接口返回的社区内容摘要（非完整正文）。身份属性取平台认证徽章与权威等级。'
      : '演示语料：由公开聚合观点改写，非知乎真实抓取数据；答主名与赞数为模拟值。'}${extra}</div>`;
}
function closeDrawer() { document.getElementById('drawer').classList.remove('open'); }

/* ---------- 图例 ---------- */
function renderLegend() {
  document.getElementById('legend').innerHTML =
    `<b>视觉编码</b><br/>
     <span class="k" style="background:${C.authority}"></span>权威答主　
     <span class="k" style="background:${C.normal}"></span>普通用户<br/>
     <span class="k" style="background:${C.org}"></span>机构号　
     <span class="k" style="background:${C.concept}"></span>概念桥<br/>
     <span class="k" style="background:transparent;border:2px solid ${C.gem}"></span>金边 = 高质量低赞<br/>
     节点大小 = 质量分　距离 = 观点相似度<br/>
     <span style="color:${C.dispute}">虚线</span> = 争议边（场景取值相反）`;
}
function renderAxisHint() {
  const L = G.questions[0].dim_label;
  document.getElementById('axishint').innerHTML =
    `<b>布局含义</b><br/>横轴 <em>${L[Q.layout_axes[0]]}</em><br/>纵轴 <em>${L[Q.layout_axes[1]]}</em><br/>
     <span style="font-size:10.5px">同簇聚拢 = 同类场景的人；簇间距离 = 场景差异</span>`;
}
