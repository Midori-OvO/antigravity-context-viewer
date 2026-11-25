'use strict';
process.noAsar = true;
process.env.AG_METER_TEST_MODE = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const crypto = require('crypto');
const { builtinAsar } = require('../asar-engine');
const { install } = require('../install');
const { restore } = require('../restore');
const { DEFAULT_CONFIG, loadModulesConfig, inspectDiskModules } = require('../modules-config');
const { createI18nEngine } = require('../i18n/i18n-runtime');
const { runAudit } = require('./scripts/audit-i18n');
const { mergeDictionaries, parseUpstreamDictionarySource } = require('./scripts/sync-upstream-dict');
const { renderDashboardHtml } = require('../meter-cli-ui');

function makeMockDom() {
  const mkNode = (nodeType, tagName, opts = {}) => {
    const attrs = new Map(Object.entries(opts.attrs || {}));
    return {
      nodeType,
      tagName: tagName ? tagName.toUpperCase() : null,
      id: opts.id || '',
      className: opts.className || '',
      nodeValue: opts.nodeValue ?? '',
      children: [],
      childNodes: [],
      firstChild: null,
      lastChild: null,
      nextSibling: null,
      previousSibling: null,
      parentElement: null,
      parentNode: null,
      isContentEditable: Boolean(opts.isContentEditable),
      style: {},
      get textContent() {
        if (this.nodeType === 3) return this.nodeValue;
        return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
      },
      get innerText() {
        return this.textContent;
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      closest(selList) {
        const sels = String(selList || '').split(',').map((s) => s.trim()).filter(Boolean);
        let cur = this.nodeType === 1 ? this : this.parentElement;
        while (cur && cur.nodeType === 1) {
          for (const s of sels) {
            if (s.startsWith('#') && cur.id === s.slice(1)) return cur;
            if (s.startsWith('.') && cur.className.split(/\s+/).includes(s.slice(1))) return cur;
            if (/^[a-z]+$/i.test(s) && cur.tagName === s.toUpperCase()) return cur;
            const am = s.match(/^([a-z]+)?\[([^=\]]+)(?:="([^"]*)")?\]$/i);
            if (am) {
              const [, tg, at, vl] = am;
              if ((!tg || cur.tagName === tg.toUpperCase()) && cur.hasAttribute(at)) {
                if (vl === undefined || cur.getAttribute(at) === vl) return cur;
              }
            }
          }
          cur = cur.parentElement;
        }
        return null;
      },
      appendChild(c) {
        c.parentElement = this;
        c.parentNode = this;
        c.previousSibling = this.lastChild;
        if (this.lastChild) this.lastChild.nextSibling = c;
        else this.firstChild = c;
        this.lastChild = c;
        this.childNodes.push(c);
        if (c.nodeType === 1) this.children.push(c);
        return c;
      }
    };
  };
  const body = mkNode(1, 'BODY');
  return {
    body,
    el: (tag, opts = {}) => mkNode(1, tag, opts),
    text: (val) => mkNode(3, null, { nodeValue: val })
  };
}

test('默认配置策略: 客户端汉化默认开启且目标语言为 zh-CN', () => {
  assert.equal(DEFAULT_CONFIG.modules.chinese.enabled, true);
  assert.equal(DEFAULT_CONFIG.modules.chinese.language, 'zh-CN');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-l10n-cfg-'));
  try {
    const cfg = loadModulesConfig({ stateDir: tmpDir, allowLegacyMigration: false });
    assert.equal(cfg.modules.chinese.enabled, true);
    assert.equal(cfg.modules.chinese.language, 'zh-CN');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('面板默认语言策略: 英文宿主信号下默认仍为 zh-CN，显式切换英文/繁体有效', () => {
  const i18nCode = fs.readFileSync(path.join(ROOT_DIR, 'src', 'renderer', 'i18n.js'), 'utf8');
  const wrapped = `${i18nCode}\n;({ resolveInitialPanelLanguage, normalizePanelLanguage, getPanelLanguage });`;

  const res = vm.runInNewContext(wrapped, {
    window: {
      __AGY_I18N_CONFIG__: { enabled: false, language: 'en' }
    },
    document: {
      documentElement: {
        lang: 'en',
        getAttribute: () => 'en'
      }
    }
  });
  assert.equal(res.resolveInitialPanelLanguage(), 'zh-CN');
  assert.equal(res.getPanelLanguage(), 'zh-CN');

  const resExplicitEn = vm.runInNewContext(wrapped, {
    window: {
      __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN' },
      __AGContextMeterSettings: { uiPreferences: { panelLanguage: 'en' } }
    },
    document: { documentElement: { lang: 'zh-CN', getAttribute: () => 'zh-CN' } }
  });
  assert.equal(resExplicitEn.resolveInitialPanelLanguage(), 'en');
});

test('Issue #118 回归: 对话内工具步骤动作标签精确放行汉化，同时正文/Markdown/代码块/工具输出严格隔离', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'zh-CN.json'), 'utf8'));
  const rtSrc = fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'i18n-runtime.js'), 'utf8');
  const d = makeMockDom();

  const assistantBox = d.el('div', { attrs: { 'data-testid': 'assistant-message', 'data-role': 'assistant' } });
  const stepPillLabels = ['Ran', 'Analyzed', 'Edited', 'Viewed', 'Searched', 'Explored'];
  const pillTextNodes = {};
  for (const label of stepPillLabels) {
    const pill = d.el('span', { className: 'step-action-label' });
    const tn = d.text(label);
    pill.appendChild(tn);
    assistantBox.appendChild(pill);
    pillTextNodes[label] = tn;
  }

  // Protected siblings inside assistant message
  const mdBody = d.el('div', { className: 'markdown-body' });
  const mdPara = d.el('p');
  const mdText = d.text('Ran');
  mdPara.appendChild(mdText);
  mdBody.appendChild(mdPara);
  assistantBox.appendChild(mdBody);

  const codeEl = d.el('code');
  const codeText = d.text('Analyzed');
  codeEl.appendChild(codeText);
  assistantBox.appendChild(codeEl);

  const preEl = d.el('pre');
  const preText = d.text('Edited');
  preEl.appendChild(preText);
  assistantBox.appendChild(preEl);

  const thoughtEl = d.el('div', { className: 'thought-content' });
  const thoughtText = d.text('Viewed');
  thoughtEl.appendChild(thoughtText);
  assistantBox.appendChild(thoughtEl);

  const toolOut = d.el('div', { attrs: { 'data-testid': 'tool-output' } });
  const toolText = d.text('Searched');
  toolOut.appendChild(toolText);
  assistantBox.appendChild(toolOut);

  d.body.appendChild(assistantBox);

  const sandbox = {
    window: {
      __AGY_I18N_CONFIG__: { enabled: true, language: 'zh-CN', brandTitle: 'english' },
      __AGY_I18N_DATA__: dict
    },
    document: { documentElement: d.body, body: d.body, readyState: 'complete' },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1
  };
  sandbox.window.document = sandbox.document;
  vm.runInNewContext(rtSrc, sandbox);
  sandbox.window.__AGY_RUN_FULL_SCAN__();

  assert.equal(pillTextNodes.Ran.nodeValue, '已运行');
  assert.equal(pillTextNodes.Analyzed.nodeValue, '已分析');
  assert.equal(pillTextNodes.Edited.nodeValue, '已编辑');
  assert.equal(pillTextNodes.Viewed.nodeValue, '已查看');
  assert.equal(pillTextNodes.Searched.nodeValue, '已搜索');
  assert.equal(pillTextNodes.Explored.nodeValue, '已探索');

  assert.equal(mdText.nodeValue, 'Ran');
  assert.equal(codeText.nodeValue, 'Analyzed');
  assert.equal(preText.nodeValue, 'Edited');
  assert.equal(thoughtText.nodeValue, 'Viewed');
  assert.equal(toolText.nodeValue, 'Searched');
});

test('CLI 网页看板 HTML 标题与主要标签为简体中文', () => {
  const html = renderDashboardHtml({});
  assert.match(html, /<title>Antigravity CLI 看板/);
  assert.doesNotMatch(html, /<title>Antigravity CLI Dashboard/);
});

test('全量汉化审计门禁 (audit-i18n) 严格模式通过', () => {
  const res = runAudit({ rootDir: ROOT_DIR });
  assert.equal(res.ok, true, `审计发现 ${res.errorCount} 项错误`);
  assert.equal(res.defaultPolicyErrors.length, 0);
  assert.equal(res.clientParityErrors.length, 0);
});

test('三向词典合并保持 ContextMeter 专用译法优先且幂等', () => {
  const existing = {
    exact: { Customizations: '自定义扩展', ExistingOnly: '仅本地' },
    coreWords: { settings: '设置' },
    patterns: [],
    selfHealMap: {}
  };
  const upstreamSrc = `module.exports = {
    dictionary: { Customizations: '定制', Marketplace: '市场', NewKey: '新词条' },
    coreWords: { settings: '设定', workspace: '工作区' }
  };`;
  const upstream = parseUpstreamDictionarySource(upstreamSrc);
  const override = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, 'localization', 'overrides', 'client-zh-CN.json'), 'utf8')
  );
  const merged = mergeDictionaries(existing, upstream, override);
  assert.equal(merged.exact.Customizations, '自定义扩展');
  assert.equal(merged.exact.Marketplace, '插件市场');
  assert.equal(merged.exact.ExistingOnly, '仅本地');
  assert.equal(merged.exact.NewKey, '新词条');
  assert.equal(merged.exact.Ran, '已运行');
  const engine = createI18nEngine(merged);
  assert.equal(engine.translate('Customizations'), '自定义扩展');
});

test('Antigravity 2.35.2 宿主安装/卸载闭环兼容与 PR #86 新增词条翻译', async () => {
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'i18n', 'zh-CN.json'), 'utf8'));
  const engine = createI18nEngine(dict);
  const troubleshootingRes = engine.translate('See our troubleshooting guide for more help.');
  assert.ok(troubleshootingRes && /[\u4e00-\u9fff]/.test(troubleshootingRes), 'PR #86 疑难解答链接应完成汉化');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-2352-compat-'));
  const stateDir = path.join(tmpRoot, 'state');
  const hostSrcDir = path.join(tmpRoot, 'host-src');
  const hostAsar = path.join(tmpRoot, 'app.asar');
  const prevEnv = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = stateDir;

  try {
    fs.mkdirSync(path.join(hostSrcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(hostSrcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.35.2' }));
    fs.writeFileSync(
      path.join(hostSrcDir, 'dist', 'utils.js'),
      '"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager) {\n    void loadHubWindowUrl(win, url, { skipBootstrapMint });\n}\n'
    );
    fs.writeFileSync(path.join(hostSrcDir, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n');
    await builtinAsar.createPackageWithOptions(hostSrcDir, hostAsar, {});
    const cleanOrigSha = crypto.createHash('sha256').update(fs.readFileSync(hostAsar)).digest('hex');

    await install({ path: hostAsar, noHotInject: true });
    const diskOn = inspectDiskModules(hostAsar, { forceRefresh: true });
    assert.equal(diskOn.meterReady, true);
    assert.equal(diskOn.chineseReady, true);
    assert.equal(diskOn.chineseStatus, 'ready');

    await restore({ path: hostAsar });
    const restoredSha = crypto.createHash('sha256').update(fs.readFileSync(hostAsar)).digest('hex');
    assert.equal(restoredSha, cleanOrigSha);
    const diskOff = inspectDiskModules(hostAsar, { forceRefresh: true });
    assert.equal(diskOff.meter, false);
    assert.equal(diskOff.chinese, false);
  } finally {
    if (prevEnv !== undefined) process.env.AG_METER_STATE_DIR = prevEnv;
    else delete process.env.AG_METER_STATE_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cli.js install 对未显式配置过的旧版上游 modules.json 自动启用汉化，显式关闭则保留关闭', async () => {
  const { execFileSync } = require('child_process');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-cli-install-zh-'));
  const stateDir = path.join(tmpRoot, 'state');
  const hostSrcDir = path.join(tmpRoot, 'host-src');
  const hostAsar = path.join(tmpRoot, 'app.asar');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(hostSrcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(hostSrcDir, 'package.json'), JSON.stringify({ name: 'antigravity', version: '2.35.2' }));
    fs.writeFileSync(
      path.join(hostSrcDir, 'dist', 'utils.js'),
      '"use strict";\nfunction setupNodeWrapper(env) {}\nfunction createWindow(url, storageManager) {\n    void loadHubWindowUrl(win, url, { skipBootstrapMint });\n}\n'
    );
    fs.writeFileSync(path.join(hostSrcDir, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n');
    await builtinAsar.createPackageWithOptions(hostSrcDir, hostAsar, {});

    // Case 1: Untouched upstream default (enabled: false, lastUpdated: null) -> auto-enabled
    fs.writeFileSync(
      path.join(stateDir, 'modules.json'),
      JSON.stringify({
        schemaVersion: '0.8.8',
        modules: {
          meter: { enabled: true },
          chinese: { enabled: false, language: 'en', brandTitle: 'english', desktopOnly: true, lastUpdated: null }
        }
      }),
      'utf8'
    );
    execFileSync(process.execPath, [path.join(ROOT_DIR, 'cli.js'), 'install', '--path', hostAsar, '--state-dir', stateDir, '--disk-only'], {
      cwd: ROOT_DIR,
      env: { ...process.env, AG_METER_TEST_MODE: '1', AG_METER_STATE_DIR: stateDir },
      encoding: 'utf8'
    });
    const cfgAfter = loadModulesConfig({ stateDir });
    assert.equal(cfgAfter.modules.chinese.enabled, true);
    assert.equal(cfgAfter.modules.chinese.language, 'zh-CN');
    const diskOn = inspectDiskModules(hostAsar, { forceRefresh: true });
    assert.equal(diskOn.chineseReady, true);

    // Case 2: Explicitly disabled (lastUpdated != null) -> stays disabled
    fs.writeFileSync(
      path.join(stateDir, 'modules.json'),
      JSON.stringify({
        schemaVersion: '0.8.8',
        modules: {
          meter: { enabled: true },
          chinese: { enabled: false, language: 'en', brandTitle: 'english', desktopOnly: true, lastUpdated: '2026-11-25T00:00:00.000Z' }
        }
      }),
      'utf8'
    );
    execFileSync(process.execPath, [path.join(ROOT_DIR, 'cli.js'), 'install', '--path', hostAsar, '--state-dir', stateDir, '--disk-only'], {
      cwd: ROOT_DIR,
      env: { ...process.env, AG_METER_TEST_MODE: '1', AG_METER_STATE_DIR: stateDir },
      encoding: 'utf8'
    });
    const cfgExplicitOff = loadModulesConfig({ stateDir });
    assert.equal(cfgExplicitOff.modules.chinese.enabled, false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
