// ==UserScript==
// @name         币安三角套利计算器(内存优化版)
// @namespace    https://binance.com
// @version      3.0
// @description  低内存/低CPU, 防抖节流, 自动清理资源, 吃单+挂单双策略, 无内存泄漏
// @author       Custom
// @match        *://*.binance.com/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置 ====================
    const STORAGE_VARS = 'binance_calc_variables';
    const STORAGE_EXPR = 'binance_calc_expression';
    const STORAGE_TRI = 'binance_calc_triangular';
    const UPDATE_DEBOUNCE = 100; // 核心防抖：100ms更新一次，大幅降性能消耗
    const MAX_RECONNECT_COUNT = 5; // WebSocket最大重连次数，防止无限重连

    // ==================== 样式 ====================
    GM_addStyle(`
        #calc-panel {position:fixed;top:100px;right:20px;width:460px;background:#1f2937;color:#f3f4f6;border-radius:12px;box-shadow:0 8px 20px rgba(0,0,0,0.4);font-family:monospace;font-size:13px;z-index:999999;overflow:hidden;display:flex;flex-direction:column;resize:both;min-width:400px;}
        .calc-header{background:#0f172a;padding:8px 12px;cursor:move;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155;user-select:none;}
        .calc-header span{font-weight:bold;color:#60a5fa;}
        .calc-close{background:#ef4444;border:none;color:white;width:22px;height:22px;border-radius:4px;cursor:pointer;font-size:12px;}
        .calc-content{padding:12px;display:flex;flex-direction:column;gap:12px;}
        .variables-section,.expression-section,.triangular-section{background:#111827;border-radius:8px;padding:8px;}
        .section-title{font-weight:bold;margin-bottom:8px;color:#9ca3af;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;}
        .section-title .toggle-icon{font-size:14px;transition:transform 0.2s;}
        .section-title.collapsed .toggle-icon{transform:rotate(-90deg);}
        .section-content{overflow:hidden;transition:max-height 0.2s ease-out;}
        .section-content.collapsed{max-height:0;padding:0;margin:0;}
        .var-list{max-height:150px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:8px;}
        .var-item{background:#1f2937;border-radius:6px;padding:6px;display:flex;align-items:center;gap:6px;font-size:12px;}
        .var-name{font-weight:bold;min-width:40px;color:#fbbf24;}
        .var-desc{flex:1;color:#d1d5db;font-size:11px;}
        .var-remove{background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;}
        .add-var-form,.tri-form{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;align-items:center;}
        .add-var-form input,.add-var-form select,.tri-form input,.tri-form select{background:#374151;border:1px solid #4b5563;color:white;border-radius:4px;padding:4px 6px;font-size:11px;}
        .add-var-form .symbol-input,.tri-form .symbol-input{width:90px;}
        .btn{background:#3b82f6;border:none;color:white;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;}
        .btn:hover{background:#2563eb;}
        .expr-input{width:100%;background:#374151;border:1px solid #4b5563;color:white;border-radius:6px;padding:6px;font-family:monospace;font-size:13px;box-sizing:border-box;}
        .result{margin-top:8px;background:#0f172a;border-radius:6px;padding:8px;text-align:right;font-size:16px;font-weight:bold;color:#10b981;word-break:break-all;}
        .result-label{font-size:11px;color:#9ca3af;margin-right:6px;}
        .error-msg{color:#ef4444;font-size:11px;margin-top:4px;text-align:right;}
        .tri-result{margin-top:8px;background:#0f172a;border-radius:6px;padding:8px;font-size:12px;}
        .tri-strategy{margin:6px 0;padding:6px;border-radius:4px;}
        .tri-strategy.profitable{background:rgba(16,185,129,0.2);border-left:3px solid #10b981;}
        .tri-strategy.normal{background:rgba(239,68,68,0.1);border-left:3px solid #ef4444;}
        .tri-rule{font-size:10px;color:#60a5fa;margin-top:2px;}
    `);

    // ==================== 工具函数：防抖（核心优化） ====================
    function debounce(func, delay) {
        let timer = null;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => func.apply(this, args), delay);
        };
    }

    // ==================== 安全计算 ====================
    function safeEval(expr, variables) {
        let replaced = expr;
        for (const [name, value] of Object.entries(variables)) replaced = replaced.replace(new RegExp(`\\b${name}\\b`, 'g'), value);
        if (!/^[\d+\-*/()\s.]+$/.test(replaced)) return { error: '非法字符' };
        try {
            const result = Function(`'use strict';return (${replaced})`)();
            return isNaN(result) || !isFinite(result) ? { error: '无效结果' } : { value: result };
        } catch (e) {
            return { error: '计算错误' };
        }
    }

    // ==================== 全局变量 ====================
    let variables = [], currentPrices = {}, wsConnections = {};
    let triConfig = { market: 'spot', symbolAB: '', symbolBC: '', symbolAC: '' };
    let triPrices = { ab: { bid: null, ask: null }, bc: { bid: null, ask: null }, ac: { bid: null, ask: null } };
    let triWs = { ab: null, bc: null, ac: null };
    let reconnectCount = {};

    function getWsBase(market) { return market === 'spot' ? 'wss://stream.binance.com/ws/' : 'wss://fstream.binance.com/ws/'; }

    // ==================== WebSocket 优化版订阅 ====================
    function subscribeVariable(varObj) {
        const key = varObj.name;
        if (wsConnections[key]) { wsConnections[key].close(); delete wsConnections[key]; }
        
        const symbol = varObj.symbol.toLowerCase();
        const stream = varObj.priceType === 'latest' ? `${symbol}@aggTrade` : `${symbol}@bookTicker`;
        const ws = new WebSocket(`${getWsBase(varObj.market)}${stream}`);

        ws.onmessage = debounce((e) => {
            try {
                const data = JSON.parse(e.data);
                let p = null;
                if (varObj.priceType === 'latest') p = parseFloat(data.p);
                else if (varObj.priceType === 'bid1') p = parseFloat(data.b);
                else p = parseFloat(data.a);
                if (!isNaN(p)) {
                    currentPrices[key] = p;
                    updateAll();
                }
            } catch(_) {}
        }, UPDATE_DEBOUNCE);

        ws.onclose = () => {
            reconnectCount[key] = (reconnectCount[key] || 0) + 1;
            if (reconnectCount[key] <= MAX_RECONNECT_COUNT && variables.some(v => v.name === key)) {
                setTimeout(() => subscribeVariable(varObj), 3000);
            }
        };
        wsConnections[key] = ws;
    }

    // ==================== 统一更新（防抖） ====================
    const updateAll = debounce(() => {
        renderVariableList();
        updateResult();
        updateTriangularResult();
    }, UPDATE_DEBOUNCE);

    // ==================== 变量管理 ====================
    function saveVariables() { localStorage.setItem(STORAGE_VARS, JSON.stringify(variables)); }
    function loadVariables() {
        const s = localStorage.getItem(STORAGE_VARS);
        if (!s) return;
        try { variables = JSON.parse(s); variables.forEach(subscribeVariable); } catch(_) {}
    }

    function addVariable(name, market, symbol, priceType) {
        if (!/^[a-zA-Z_]\w*$/.test(name) || variables.some(v => v.name === name)) return false;
        const v = { name, market, symbol: symbol.toUpperCase(), priceType };
        variables.push(v); subscribeVariable(v); saveVariables(); updateAll();
        return true;
    }

    function removeVariable(name) {
        variables = variables.filter(v => v.name !== name);
        if (wsConnections[name]) { wsConnections[name].close(); delete wsConnections[name]; }
        delete currentPrices[name]; saveVariables(); updateAll();
    }

    function renderVariableList() {
        const el = document.querySelector('.var-list');
        if (!el) return;
        el.innerHTML = variables.length === 0 ? '<div style="text-align:center;color:#9ca3af;">暂无变量</div>' : variables.map(v => {
            const p = currentPrices[v.name]?.toFixed(4) || '--';
            const t = v.priceType === 'latest' ? '最新' : v.priceType === 'bid1' ? '买一' : '卖一';
            return `<div class="var-item"><span class="var-name">${v.name}</span><span class="var-desc">${v.symbol}(${v.market})${t}</span><span style="color:#fbbf24;">${p}</span><button class="var-remove" data-name="${v.name}">✖</button></div>`;
        }).join('');
        document.querySelectorAll('.var-remove').forEach(btn => btn.onclick = () => removeVariable(btn.dataset.name));
    }

    // ==================== 表达式计算 ====================
    function saveExpression(e) { localStorage.setItem(STORAGE_EXPR, e); }
    function loadExpression() { return localStorage.getItem(STORAGE_EXPR) || ''; }
    function updateResult() {
        const i = document.querySelector('#calc-expr'), r = document.querySelector('#calc-result'), e = document.querySelector('#calc-error');
        if (!i || !r) return;
        const v = i.value.trim(); saveExpression(v);
        if (!v) { r.textContent = '等待输入'; e && (e.textContent = ''); return; }
        const vals = {}, miss = [];
        variables.forEach(k => currentPrices[k.name] ? vals[k.name] = currentPrices[k.name] : miss.push(k.name));
        if (miss.length) { r.textContent = '--'; e && (e.textContent = `缺失: ${miss.join(',')}`); return; }
        const res = safeEval(v, vals);
        res.error ? (r.textContent = '--', e && (e.textContent = res.error)) : (r.textContent = res.value.toFixed(8), e && (e.textContent = ''));
    }

    // ==================== 三角套利（防抖+正确公式） ====================
    function saveTri() { localStorage.setItem(STORAGE_TRI, JSON.stringify(triConfig)); }
    function loadTri() {
        const s = localStorage.getItem(STORAGE_TRI);
        if (!s) return;
        try { triConfig = JSON.parse(s); subscribeTri(); } catch(_) {}
    }

    function subscribeTri() {
        Object.values(triWs).forEach(ws => ws && ws.close());
        triWs = { ab: null, bc: null, ac: null };
        const sub = (sym, type) => {
            if (!sym) return;
            const ws = new WebSocket(`${getWsBase(triConfig.market)}${sym.toLowerCase()}@bookTicker`);
            ws.onmessage = debounce(e => {
                try {
                    const d = JSON.parse(e.data);
                    triPrices[type] = { bid: parseFloat(d.b), ask: parseFloat(d.a) };
                    updateAll();
                } catch(_) {}
            }, UPDATE_DEBOUNCE);
            triWs[type] = ws;
        };
        sub(triConfig.symbolAB, 'ab');
        sub(triConfig.symbolBC, 'bc');
        sub(triConfig.symbolAC, 'ac');
    }

    const updateTriangularResult = debounce(() => {
        const el = document.querySelector('#tri-result');
        if (!el) return;
        const { ab, bc, ac } = triPrices;
        if (!ab.bid || !bc.bid || !ac.bid) { el.innerHTML = '<div style="color:#9ca3af;">等待价格...</div>'; return; }

        const taker1 = (ab.bid * bc.bid) / ac.ask;
        const taker2 = (ac.bid * ab.bid) / bc.ask;
        const maker1 = (ab.ask * bc.bid) / ac.ask;
        const maker2 = (ac.ask * ab.bid) / bc.ask;

        el.innerHTML = `
            <div style="font-weight:bold;color:#fbbf24;">📊 全吃单套利</div>
            <div class="tri-strategy ${taker1>1?'profitable':'normal'}">A→B→C→A | ${taker1.toFixed(6)} ${taker1>1?'✅套利':'❌无机会'}</div>
            <div class="tri-strategy ${taker2>1?'profitable':'normal'}">A→C→B→A | ${taker2.toFixed(6)} ${taker2>1?'✅套利':'❌无机会'}</div>
            <div style="height:1px;background:#374151;margin:8px 0;"></div>
            <div style="font-weight:bold;color:#10b981;">🎯 挂单套利(1挂2吃)</div>
            <div class="tri-strategy ${maker1>1?'profitable':'normal'}">挂A→B | ${maker1.toFixed(6)} ${maker1>1?'✅套利':'❌无机会'}<div class="tri-rule">卖一挂单 + 两步吃单</div></div>
            <div class="tri-strategy ${maker2>1?'profitable':'normal'}">挂A→C | ${maker2.toFixed(6)} ${maker2>1?'✅套利':'❌无机会'}<div class="tri-rule">卖一挂单 + 两步吃单</div></div>
        `;
    }, UPDATE_DEBOUNCE);

    // ==================== 面板创建 ====================
    function createPanel() {
        const old = document.getElementById('calc-panel');
        old && old.remove();

        const panel = document.createElement('div');
        panel.id = 'calc-panel';
        panel.innerHTML = `
            <div class="calc-header"><span>🔢 套利计算器(低耗版)</span><button class="calc-close">×</button></div>
            <div class="calc-content">
                <div class="variables-section">
                    <div class="section-title" data-target="vars-content">📌 变量定义 <span class="toggle-icon">▼</span></div>
                    <div class="section-content" id="vars-content">
                        <div class="var-list"></div>
                        <div class="add-var-form"><input id="var-name" placeholder="变量名" style="width:70px;"><select id="var-market"><option value="spot">现货</option><option value="futures">合约</option></select><input id="var-symbol" placeholder="交易对" class="symbol-input"><select id="var-price-type"><option value="latest">最新价</option><option value="bid1">买一价</option><option value="ask1">卖一价</option></select><button class="btn" id="add-var">添加</button></div>
                    </div>
                </div>
                <div class="expression-section">
                    <div class="section-title" data-target="expr-content">📝 表达式 <span class="toggle-icon">▼</span></div>
                    <div class="section-content" id="expr-content"><input id="calc-expr" class="expr-input" placeholder="a/b-c"><div class="result"><span class="result-label">结果=</span><span id="calc-result">等待输入</span></div><div id="calc-error" class="error-msg"></div></div>
                </div>
                <div class="triangular-section">
                    <div class="section-title" data-target="tri-content">🔺 三角套利 <span class="toggle-icon">▼</span></div>
                    <div class="section-content" id="tri-content">
                        <div class="tri-form"><select id="tri-market"><option value="spot">现货</option><option value="futures">合约</option></select><input id="tri-ab" placeholder="AB交易对" class="symbol-input"><input id="tri-bc" placeholder="BC交易对" class="symbol-input"><input id="tri-ac" placeholder="AC交易对" class="symbol-input"><button class="btn" id="tri-apply">分析</button></div>
                        <div id="tri-result" class="tri-result"></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        // 拖拽
        let drag = false, x, y, l, t;
        panel.querySelector('.calc-header').onmousedown = e => { drag = true; x = e.clientX; y = e.clientY; const r = panel.getBoundingClientRect(); l = r.left; t = r.top; e.preventDefault(); };
        document.onmousemove = e => drag && (panel.style.left = Math.max(0, l + e.clientX - x) + 'px', panel.style.top = Math.max(0, t + e.clientY - y) + 'px', panel.style.right = 'auto');
        document.onmouseup = () => drag = false;

        // 关闭：彻底清理所有资源（防内存泄漏）
        panel.querySelector('.calc-close').onclick = () => {
            Object.values(wsConnections).forEach(ws => ws.close());
            Object.values(triWs).forEach(ws => ws && ws.close());
            variables = []; currentPrices = {}; wsConnections = {}; triWs = {};
            panel.remove();
        };

        // 折叠
        document.querySelectorAll('.section-title').forEach(t => {
            const c = document.getElementById(t.dataset.target);
            t.onclick = () => { c.classList.toggle('collapsed'); t.classList.toggle('collapsed'); };
        });

        // 事件
        panel.querySelector('#add-var').onclick = () => {
            const n = panel.querySelector('#var-name').value.trim(), m = panel.querySelector('#var-market').value,  = panel.querySelector('#var-symbol').value.trim(), p = panel.querySelector('#var-price-type').value;
            n &&  && addVariable(n,m,,p) && (panel.querySelector('#var-name').value='', panel.querySelector('#var-symbol').value='');
        };
        panel.querySelector('#calc-expr').oninput = updateAll;
        panel.querySelector('#tri-apply').onclick = () => {
            triConfig = { market: panel.querySelector('#tri-market').value, symbolAB: panel.querySelector('#tri-ab').value.trim().toUpperCase(), symbolBC: panel.querySelector('#tri-bc').value.trim().toUpperCase(), symbolAC: panel.querySelector('#tri-ac').value.trim().toUpperCase() };
            saveTri(); subscribeTri();
        };

        // 加载数据
        loadVariables();
        panel.querySelector('#calc-expr').value = loadExpression();
        loadTri();
        updateAll();
    }

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', createPanel) : createPanel();
})();
