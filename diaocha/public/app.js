(function () {
  'use strict';
  const S = window.SURVEY;
  const DRAFT_KEY = 'diaocha:draft:v1';
  const CODE_KEY = 'diaocha:code';
  const POS_KEY = 'diaocha:pos';
  const RESULT = S.sections.length; // 虚拟的“结果”页索引

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, attrs, ...children) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  };

  // ---------- state ----------
  const UPDATED_KEY = 'diaocha:draft:updatedAt';
  let answers = loadDraft();
  let pos = Math.min(Number(localStorage.getItem(POS_KEY) || 0), RESULT);
  let saveTimer = null;
  let cloudTimer = null;
  let cloudDirty = false;

  function loadDraft() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch { return {}; }
  }
  const hhmm = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  function saveDraft() {
    clearTimeout(saveTimer);
    const now = Date.now();
    localStorage.setItem(UPDATED_KEY, String(now));
    saveTimer = setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(answers));
      setStatus('已存本机 · ' + hhmm() + (code() ? ' · 云端同步中…' : ' · 设访问码后可同步云端'));
    }, 250);
    cloudDirty = true;
    clearTimeout(cloudTimer);
    cloudTimer = setTimeout(pushCloud, 1500);
  }
  async function pushCloud() {
    if (!code() || !cloudDirty) return;
    const updatedAt = Number(localStorage.getItem(UPDATED_KEY)) || Date.now();
    try {
      await api('/draft', { method: 'PUT', keepalive: true, body: JSON.stringify({ answers, updatedAt, device: navigator.userAgent.slice(0, 80) }) });
      cloudDirty = false;
      setStatus('已存本机并同步云端 · ' + hhmm());
    } catch (e) { setStatus('云端同步失败：' + e.message + '（本机草稿仍在）'); }
  }
  // 离开页面前尽量把最后一笔推上去
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && cloudDirty) pushCloud(); });
  window.addEventListener('pagehide', () => { if (cloudDirty) pushCloud(); });

  async function pullCloud() {
    if (!code()) return;
    try {
      const d = await api('/draft');
      if (!d || !d.answers) return;
      const localAt = Number(localStorage.getItem(UPDATED_KEY)) || 0;
      const localCount = Object.keys(answers).length;
      const cloudCount = Object.keys(d.answers).length;
      if (d.updatedAt <= localAt || JSON.stringify(d.answers) === JSON.stringify(answers)) return;
      const when = new Date(d.updatedAt).toLocaleString('zh-CN');
      if (localCount === 0 || confirm(`云端有一份更新的草稿（${when}，${cloudCount} 项；本机 ${localCount} 项）。用云端草稿覆盖本机？`)) {
        answers = d.answers;
        localStorage.setItem(DRAFT_KEY, JSON.stringify(answers));
        localStorage.setItem(UPDATED_KEY, String(d.updatedAt));
        cloudDirty = false;
        renderSection(pos); refreshProgress();
        setStatus('已从云端恢复草稿 · ' + when);
      }
    } catch (e) { setStatus('读取云端草稿失败：' + e.message); }
  }
  function set(id, value) {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) delete answers[id];
    else answers[id] = value;
    saveDraft();
    refreshProgress();
  }
  const get = (id) => answers[id];

  // ---------- answered detection ----------
  const allQuestions = S.sections.flatMap(sec => sec.questions.map(q => ({ ...q, sectionId: sec.id })));
  function isAnswered(q) {
    const v = answers[q.id];
    if (v == null) return false;
    switch (q.type) {
      case 'multi': return Array.isArray(v) && v.length > 0;
      case 'ratingList': return Object.keys(v).length > 0;
      case 'allocation': return Object.values(v).some(n => n > 0);
      case 'rank': return Array.isArray(v) && v.length > 0;
      case 'options': return (v.names || []).some(n => n && n.trim());
      default: return String(v).trim() !== '';
    }
  }
  function sectionStats(sec) {
    const total = sec.questions.length;
    const done = sec.questions.filter(isAnswered).length;
    return { total, done };
  }
  function refreshProgress() {
    const done = allQuestions.filter(isAnswered).length;
    $('#progress-bar').style.width = (done / allQuestions.length * 100).toFixed(1) + '%';
    document.querySelectorAll('.chip').forEach((c, i) => {
      if (i >= S.sections.length) return;
      const st = sectionStats(S.sections[i]);
      c.classList.toggle('done', st.done === st.total);
      c.classList.toggle('partial', st.done > 0 && st.done < st.total);
    });
    document.querySelectorAll('.q').forEach(node => {
      const q = allQuestions.find(x => x.id === node.dataset.id);
      if (q) node.classList.toggle('answered', isAnswered(q));
    });
  }
  function setStatus(t) { $('#status').textContent = t; }

  // ---------- renderers ----------
  function scaleRow(value, onPick, opts = {}) {
    const row = el('div', { class: 'scale' });
    for (let i = 1; i <= 10; i++) {
      const b = el('button', { type: 'button', class: value === i ? 'on' : '', text: i, onclick: () => {
        const next = value === i ? undefined : i;
        onPick(next);
        row.querySelectorAll('button').forEach((bb, j) => bb.classList.toggle('on', next === j + 1));
        value = next;
      } });
      row.append(b);
    }
    const wrap = el('div', null, row);
    if (opts.low || opts.high) wrap.append(el('div', { class: 'scale-ends' }, el('span', { text: opts.low || '' }), el('span', { text: opts.high || '' })));
    return wrap;
  }

  const R = {
    text(q) {
      return el('input', { type: 'text', value: get(q.id) || '', placeholder: q.placeholder || '', oninput: e => set(q.id, e.target.value) });
    },
    long(q) {
      return el('textarea', { placeholder: q.placeholder || '', oninput: e => set(q.id, e.target.value) }, get(q.id) || '');
    },
    number(q) {
      return el('div', { class: 'number-wrap' },
        el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: get(q.id) ?? '', oninput: e => set(q.id, e.target.value) }),
        q.unit ? el('span', { class: 'unit', text: q.unit }) : null);
    },
    scale(q) {
      const wrap = el('div');
      wrap.append(scaleRow(get(q.id), v => set(q.id, v), q));
      if (q.why) {
        wrap.append(el('div', { class: 'why' }, el('input', { type: 'text', placeholder: '为什么打这个分？', value: get(q.id + '__why') || '', oninput: e => set(q.id + '__why', e.target.value) })));
      }
      return wrap;
    },
    single(q) {
      const wrap = el('div');
      const list = el('div', { class: 'opts' });
      const options = q.allowOther ? [...q.options, '其他'] : q.options;
      const otherInput = q.allowOther ? el('input', { type: 'text', class: 'other-input', placeholder: '请说明', value: get(q.id + '__other') || '', oninput: e => set(q.id + '__other', e.target.value) }) : null;
      const render = () => {
        list.innerHTML = '';
        const cur = get(q.id);
        for (const o of options) {
          list.append(el('button', { type: 'button', class: 'opt' + (cur === o ? ' on' : ''), onclick: () => { set(q.id, cur === o ? undefined : o); render(); } },
            el('span', { class: 'mark', text: cur === o ? '✓' : '' }), el('span', { text: o })));
        }
        if (otherInput) otherInput.style.display = cur === '其他' ? '' : 'none';
      };
      render();
      wrap.append(list);
      if (otherInput) wrap.append(otherInput);
      return wrap;
    },
    multi(q) {
      const wrap = el('div');
      const list = el('div', { class: 'opts' });
      const options = q.allowOther ? [...q.options, '其他'] : q.options;
      const otherInput = q.allowOther ? el('input', { type: 'text', class: 'other-input', placeholder: '请说明', value: get(q.id + '__other') || '', oninput: e => set(q.id + '__other', e.target.value) }) : null;
      const render = () => {
        list.innerHTML = '';
        const cur = get(q.id) || [];
        for (const o of options) {
          const on = cur.includes(o);
          list.append(el('button', { type: 'button', class: 'opt multi' + (on ? ' on' : ''), onclick: () => {
            set(q.id, on ? cur.filter(x => x !== o) : [...cur, o]); render();
          } }, el('span', { class: 'mark', text: on ? '✓' : '' }), el('span', { text: o })));
        }
        if (otherInput) otherInput.style.display = cur.includes('其他') ? '' : 'none';
      };
      render();
      wrap.append(list);
      if (otherInput) wrap.append(otherInput);
      return wrap;
    },
    ratingList(q) {
      const wrap = el('div', { class: 'rl' });
      const cur = { ...(get(q.id) || {}) };
      for (const item of q.items) {
        const val = el('span', { class: 'rl-val', text: cur[item] ? cur[item] + ' 分' : '—' });
        const node = el('div', { class: 'rl-item' }, el('div', { class: 'rl-name' }, el('span', { text: item }), val));
        node.append(scaleRow(cur[item], v => {
          if (v) cur[item] = v; else delete cur[item];
          val.textContent = v ? v + ' 分' : '—';
          set(q.id, Object.keys(cur).length ? { ...cur } : undefined);
        }));
        wrap.append(node);
      }
      return wrap;
    },
    allocation(q) {
      const wrap = el('div', { class: 'alloc' });
      const cur = { ...(get(q.id) || {}) };
      const total = el('div', { class: 'alloc-total' });
      const pcts = {};
      const refresh = () => {
        const sum = Object.values(cur).reduce((a, b) => a + (Number(b) || 0), 0);
        total.className = 'alloc-total ' + (sum === 100 ? 'ok' : sum === 0 ? '' : 'bad');
        total.innerHTML = '';
        total.append(el('span', { text: '合计' }), el('span', { text: sum + '%' + (sum === 100 ? ' ✓' : sum > 100 ? ' 超了' : sum ? ' 还差 ' + (100 - sum) + '%' : '') }));
      };
      for (const item of q.items) {
        const pct = el('span', { class: 'pct', text: (cur[item] || 0) + '%' });
        pcts[item] = pct;
        wrap.append(el('div', { class: 'alloc-row' },
          el('span', { text: item }),
          el('input', { type: 'range', min: 0, max: 100, step: 5, value: cur[item] || 0, oninput: e => {
            const v = Number(e.target.value);
            if (v) cur[item] = v; else delete cur[item];
            pct.textContent = v + '%';
            set(q.id, Object.keys(cur).length ? { ...cur } : undefined);
            refresh();
          } }),
          pct));
      }
      refresh();
      wrap.append(total);
      return wrap;
    },
    rank(q) {
      const wrap = el('div');
      const list = el('div', { class: 'rank' });
      const result = el('div', { class: 'rank-result' });
      const render = () => {
        const cur = get(q.id) || [];
        list.innerHTML = '';
        for (const item of q.items) {
          const idx = cur.indexOf(item);
          list.append(el('button', { type: 'button', class: idx >= 0 ? 'on' : '', onclick: () => {
            set(q.id, idx >= 0 ? cur.filter(x => x !== item) : [...cur, item]); render();
          } }, idx >= 0 ? el('span', { class: 'n', text: idx + 1 }) : null, el('span', { text: item })));
        }
        result.textContent = cur.length ? '当前排序：' + cur.map((x, i) => `${i + 1}.${x}`).join('  ') : '按重要程度依次点击；再点一次可取消。';
      };
      render();
      wrap.append(list, result);
      return wrap;
    },
    options(q) {
      const wrap = el('div');
      const cur = get(q.id) || { names: [], scores: {} };
      cur.names = cur.names || []; cur.scores = cur.scores || {};
      const names = el('div', { class: 'optm-names' });
      const blocks = el('div');
      const commit = () => set(q.id, cur.names.some(n => n && n.trim()) ? JSON.parse(JSON.stringify(cur)) : undefined);
      const renderBlocks = () => {
        blocks.innerHTML = '';
        cur.names.forEach((name, i) => {
          if (!name || !name.trim()) return;
          cur.scores[i] = cur.scores[i] || {};
          const block = el('div', { class: 'optm-block' }, el('h4', { text: `方向 ${i + 1}：${name}` }));
          for (const d of q.dims) {
            const val = el('span', { text: cur.scores[i][d.id] ? cur.scores[i][d.id] + ' 分' : '—' });
            const dim = el('div', { class: 'optm-dim' }, el('div', { class: 'dim-name' }, el('span', { text: d.label }), val));
            dim.append(scaleRow(cur.scores[i][d.id], v => {
              if (v) cur.scores[i][d.id] = v; else delete cur.scores[i][d.id];
              val.textContent = v ? v + ' 分' : '—';
              commit();
            }, d));
            block.append(dim);
          }
          blocks.append(block);
        });
      };
      for (let i = 0; i < 6; i++) {
        names.append(el('input', { type: 'text', placeholder: `方向 ${i + 1}（例如：全职做内容 / 回去上班 / 开一家小公司）`, value: cur.names[i] || '', oninput: e => {
          cur.names[i] = e.target.value; commit();
        }, onblur: renderBlocks }));
      }
      renderBlocks();
      wrap.append(names, el('div', { class: 'q-hint', text: '填完名字后点到别处，下面会出现每个方向的打分。' }), blocks);
      return wrap;
    },
  };

  // ---------- section render ----------
  function renderSection(i) {
    const main = $('#main');
    main.innerHTML = '';
    if (i === RESULT) return renderResult();
    const sec = S.sections[i];
    main.append(el('div', { class: 'section-head' },
      el('div', { class: 'num', text: `${i + 1} / ${S.sections.length}` }),
      el('h2', { text: sec.title }),
      el('p', { text: sec.intro })));
    sec.questions.forEach((q, qi) => {
      const node = el('div', { class: 'q' + (isAnswered(q) ? ' answered' : ''), 'data-id': q.id, id: 'q-' + q.id },
        el('div', { class: 'q-label' }, el('span', { class: 'idx', text: String(qi + 1).padStart(2, '0') }), el('span', { text: q.label })),
        el('div', { class: 'q-body' }, R[q.type](q)));
      main.append(node);
    });
    $('#btn-prev').disabled = i === 0;
    $('#btn-next').textContent = i === S.sections.length - 1 ? '生成结果' : '下一部分';
    document.querySelectorAll('.chip').forEach((c, ci) => c.classList.toggle('active', ci === i));
    window.scrollTo({ top: 0 });
  }

  function renderResult() {
    const main = $('#main');
    const done = allQuestions.filter(isAnswered).length;
    const missing = allQuestions.filter(q => !isAnswered(q));
    const md = buildMarkdown();
    const card = el('div', { class: 'result-card' },
      el('h3', { text: '调查结果' }),
      el('p', { text: '下面是根据你的回答生成的 Markdown。可以直接下载、复制给 AI，或提交到后台保存。' }),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('b', { text: done }), el('span', { text: '已回答' })),
        el('div', { class: 'stat' }, el('b', { text: allQuestions.length - done }), el('span', { text: '未回答' })),
        el('div', { class: 'stat' }, el('b', { text: Math.round(done / allQuestions.length * 100) + '%' }), el('span', { text: '完成度' }))));
    const actions = el('div', { class: 'result-actions' },
      el('button', { class: 'btn primary', text: '下载 .md', onclick: () => download(md) }),
      el('button', { class: 'btn', text: '复制全文', onclick: async () => { await navigator.clipboard.writeText(md); setStatus('已复制到剪贴板'); } }),
      el('button', { class: 'btn', text: '提交到后台', onclick: () => submit(md) }),
      el('button', { class: 'btn ghost', text: '回去继续填', onclick: () => go(0) }));
    card.append(actions);
    if (missing.length) {
      const ml = el('div', { class: 'missing-list' }, `还有 ${missing.length} 题没答：`);
      missing.slice(0, 12).forEach(q => {
        const si = S.sections.findIndex(s => s.id === q.sectionId);
        ml.append(' ', el('a', { href: '#', text: q.label.slice(0, 14) + (q.label.length > 14 ? '…' : ''), onclick: e => { e.preventDefault(); go(si); setTimeout(() => $('#q-' + q.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50); } }), ' ·');
      });
      if (missing.length > 12) ml.append(` 等 ${missing.length} 题`);
      card.append(ml);
    }
    main.append(card, el('pre', { class: 'md', text: md }));
    $('#btn-prev').disabled = false;
    $('#btn-next').textContent = '下载 .md';
    document.querySelectorAll('.chip').forEach((c, ci) => c.classList.toggle('active', ci === RESULT));
    window.scrollTo({ top: 0 });
  }

  // ---------- markdown ----------
  function fmt(q) {
    const v = get(q.id);
    if (!isAnswered(q)) return null;
    const esc = s => String(s).trim();
    switch (q.type) {
      case 'scale': {
        const why = get(q.id + '__why');
        return `**${v}/10**` + (q.low || q.high ? `（${q.low || ''} → ${q.high || ''}）` : '') + (why ? ` —— ${esc(why)}` : '');
      }
      case 'single': {
        const other = get(q.id + '__other');
        return v === '其他' && other ? `其他：${esc(other)}` : esc(v);
      }
      case 'multi': {
        const other = get(q.id + '__other');
        return v.map(x => (x === '其他' && other ? `其他：${esc(other)}` : x)).join('、');
      }
      case 'number': return `${v}${q.unit ? ' ' + q.unit : ''}`;
      case 'long': return '\n\n' + esc(v).split('\n').map(l => '  > ' + l).join('\n');
      case 'ratingList': {
        const rows = q.items.filter(i => v[i]).sort((a, b) => v[b] - v[a]).map(i => `| ${i} | ${v[i]} |`);
        return '\n\n  | 条目 | 分（1–10） |\n  |---|---|\n' + rows.map(r => '  ' + r).join('\n');
      }
      case 'allocation': {
        const rows = q.items.filter(i => v[i]).sort((a, b) => v[b] - v[a]).map(i => `| ${i} | ${v[i]}% |`);
        const sum = Object.values(v).reduce((a, b) => a + b, 0);
        return `\n\n  | 事项 | 占比 |\n  |---|---|\n` + rows.map(r => '  ' + r).join('\n') + `\n  | 合计 | ${sum}% |`;
      }
      case 'rank': return v.map((x, i) => `${i + 1}. ${x}`).join('  ');
      case 'options': {
        const lines = [];
        v.names.forEach((n, i) => {
          if (!n || !n.trim()) return;
          const sc = (v.scores || {})[i] || {};
          const cells = q.dims.map(d => sc[d.id] ?? '—');
          const nums = q.dims.map(d => sc[d.id]).filter(Boolean);
          const avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : '—';
          lines.push(`| ${esc(n)} | ${cells.join(' | ')} | ${avg} |`);
        });
        const head = `| 方向 | ${q.dims.map(d => d.label).join(' | ')} | 均分 |`;
        const sep = `|${'---|'.repeat(q.dims.length + 2)}`;
        return '\n\n' + [head, sep, ...lines].map(l => '  ' + l).join('\n');
      }
      default: return esc(v);
    }
  }

  function buildMarkdown() {
    const now = new Date();
    const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
    const done = allQuestions.filter(isAnswered).length;
    const out = [];
    out.push(`# ${S.title} · ${date}`);
    out.push('');
    out.push(`> ${S.slogan}。填写于 ${now.toLocaleString('zh-CN')}，完成 ${done}/${allQuestions.length} 题（${Math.round(done / allQuestions.length * 100)}%）。题库版本 ${S.version}。`);
    out.push('');
    out.push('## 目录');
    S.sections.forEach((sec, i) => out.push(`${i + 1}. ${sec.title}（${sectionStats(sec).done}/${sec.questions.length}）`));
    out.push('');
    S.sections.forEach((sec, i) => {
      out.push(`## ${i + 1}. ${sec.title}`);
      out.push('');
      let any = false;
      for (const q of sec.questions) {
        const f = fmt(q);
        if (f == null) continue;
        any = true;
        out.push(`- **${q.label}**${f.startsWith('\n') ? f : '：' + f}`);
      }
      if (!any) out.push('_（本部分未填写）_');
      out.push('');
    });
    out.push('## 附：给 AI 的分析提示');
    out.push('');
    out.push('```');
    out.push('以上是我（白豆）做的一份自我调查，目的是想清楚职业发展和个人成长。请你：');
    out.push('1. 先用几句话复述你看到的"我"——事实层面的画像，不要评价。');
    out.push('2. 指出回答之间互相矛盾或不一致的地方（例如价值观排序 vs 时间分配、风险偏好 vs 财务状况）。');
    out.push('3. 用我在"职业选择与意愿"里的打分做一次排除：哪些方向可以直接放弃，为什么。');
    out.push('4. 基于经济部分算一笔账：我的安全垫、底线收入、可以试错的时间窗口。');
    out.push('5. 给出你认为我的两三个真正优势和两三个盲点。');
    out.push('6. 最后给一个 90 天的最小行动计划，每周不超过三件事。');
    out.push('请按"给 AI 的话"部分里我指定的反馈风格来说话，不要重复我说过已经听腻的建议。');
    out.push('```');
    out.push('');
    return out.join('\n');
  }

  function download(md) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/(\d{8})(\d{4})/, '$1-$2');
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `baidou-diaocha-${stamp}.md` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatus('已下载 Markdown');
  }

  // ---------- server ----------
  const code = () => localStorage.getItem(CODE_KEY) || '';
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Access-Code': code(), ...(opts.headers || {}) },
    });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) throw new Error((data && data.message) || `请求失败（${res.status}）`);
    return data;
  }
  async function submit(md) {
    if (!code()) { $('#dlg-settings').showModal(); setStatus('请先在设置里填写访问码'); return; }
    setStatus('提交中…');
    try {
      const done = allQuestions.filter(isAnswered).length;
      const r = await api('/submissions', { method: 'POST', body: JSON.stringify({
        answers, markdown: md,
        meta: { version: S.version, answered: done, total: allQuestions.length, userAgent: navigator.userAgent.slice(0, 120) },
      }) });
      setStatus(`已保存到后台 · ${r.id}`);
    } catch (e) { setStatus('提交失败：' + e.message); }
  }
  async function openHistory() {
    const dlg = $('#dlg-history'); const list = $('#history-list');
    dlg.showModal();
    if (!code()) { list.innerHTML = '<p class="hint bad">请先在设置里填写访问码。</p>'; return; }
    list.innerHTML = '<p class="hint">加载中…</p>';
    try {
      const r = await api('/submissions');
      list.innerHTML = '';
      if (!r.items.length) { list.innerHTML = '<p class="hint">还没有提交记录。</p>'; return; }
      for (const it of r.items) {
        const item = el('div', { class: 'h-item' },
          el('div', { class: 'h-meta' }, el('b', { text: new Date(it.createdAt).toLocaleString('zh-CN') }), el('span', { text: `${it.answered}/${it.total} 题` })),
          el('div', { class: 'h-btns' },
            el('a', { class: 'btn small', href: `/api/submissions/${it.id}.md?code=${encodeURIComponent(code())}`, download: `baidou-diaocha-${it.id}.md`, text: '下载 .md' }),
            el('button', { class: 'btn small', text: '载入为草稿', onclick: async () => {
              if (!confirm('用这次提交的答案覆盖当前本地草稿？')) return;
              const d = await api(`/submissions/${it.id}.json`);
              answers = d.answers || {}; localStorage.setItem(DRAFT_KEY, JSON.stringify(answers));
              dlg.close(); go(0); setStatus('已载入历史答案');
            } }),
            el('button', { class: 'btn small danger', text: '删除', onclick: async () => {
              if (!confirm('删除这条记录？不可恢复。')) return;
              await api(`/submissions/${it.id}`, { method: 'DELETE' }); item.remove();
            } })));
        list.append(item);
      }
    } catch (e) { list.innerHTML = `<p class="hint bad">${e.message}</p>`; }
  }

  // ---------- navigation ----------
  function go(i) {
    pos = Math.max(0, Math.min(RESULT, i));
    localStorage.setItem(POS_KEY, pos);
    renderSection(pos);
    refreshProgress();
  }
  function buildChips() {
    const nav = $('#chips');
    S.sections.forEach((sec, i) => nav.append(el('button', { class: 'chip', onclick: () => go(i) }, el('span', { class: 'dot' }), sec.short)));
    nav.append(el('button', { class: 'chip', onclick: () => go(RESULT) }, '结果'));
  }

  $('#btn-prev').addEventListener('click', () => go(pos - 1));
  $('#btn-next').addEventListener('click', () => pos === RESULT ? download(buildMarkdown()) : go(pos + 1));
  $('#btn-history').addEventListener('click', openHistory);
  $('#btn-close-history').addEventListener('click', () => $('#dlg-history').close());
  $('#btn-settings').addEventListener('click', () => { $('#inp-code').value = code(); $('#code-status').textContent = code() ? '已保存访问码' : '尚未设置'; $('#dlg-settings').showModal(); });
  $('#btn-save-code').addEventListener('click', async () => {
    const v = $('#inp-code').value.trim();
    localStorage.setItem(CODE_KEY, v);
    const st = $('#code-status');
    st.className = 'hint'; st.textContent = '验证中…';
    try {
      await api('/verify', { method: 'POST', body: '{}' });
      st.className = 'hint ok'; st.textContent = '访问码正确，草稿将自动同步到云端';
      await pullCloud();
      if (Object.keys(answers).length) { cloudDirty = true; await pushCloud(); }
    } catch (e) { st.className = 'hint bad'; st.textContent = e.message; }
  });
  $('#btn-clear-draft').addEventListener('click', async () => {
    if (!confirm('清空所有草稿答案？（本机和云端都会清掉，已提交的历史记录不受影响）')) return;
    answers = {}; localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(UPDATED_KEY); cloudDirty = false;
    if (code()) { try { await api('/draft', { method: 'DELETE' }); } catch {} }
    $('#dlg-settings').close(); go(0); setStatus('草稿已清空');
  });

  buildChips();
  go(pos);
  if (code()) pullCloud();
  else if (!Object.keys(answers).length) setStatus('提示：先在右上角 ⚙︎ 填访问码，草稿会边填边同步到云端');
})();
