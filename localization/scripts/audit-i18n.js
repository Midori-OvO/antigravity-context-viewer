'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function loadLocalizationConfig(rootDir = ROOT_DIR) {
  const cfgPath = path.join(rootDir, 'localization', 'config.json');
  if (!fs.existsSync(cfgPath)) return { nonTranslatableWhitelist: [] };
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

function extractPanelI18nObject(i18nSource) {
  const startIdx = i18nSource.indexOf('const PANEL_I18N = {');
  if (startIdx === -1) throw new Error('PANEL_I18N definition not found in src/renderer/i18n.js');
  let braceDepth = 0;
  let objStart = -1;
  let objEnd = -1;
  let inStr = null;
  let escaped = false;
  for (let i = startIdx; i < i18nSource.length; i++) {
    const ch = i18nSource[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inStr) {
        inStr = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    if (ch === '/' && i18nSource[i + 1] === '/') {
      const nl = i18nSource.indexOf('\n', i);
      i = nl === -1 ? i18nSource.length : nl;
      continue;
    }
    if (ch === '/' && i18nSource[i + 1] === '*') {
      const endC = i18nSource.indexOf('*/', i + 2);
      i = endC === -1 ? i18nSource.length : endC + 1;
      continue;
    }
    if (ch === '{') {
      if (objStart === -1) objStart = i;
      braceDepth++;
    } else if (ch === '}') {
      braceDepth--;
      if (objStart !== -1 && braceDepth === 0) {
        objEnd = i + 1;
        break;
      }
    }
  }
  if (objStart === -1 || objEnd === -1) throw new Error('Failed to parse PANEL_I18N object boundaries');
  const literal = i18nSource.slice(objStart, objEnd);
  return vm.runInNewContext(`(${literal})`, {});
}

function isPurelyNonTranslatable(text, whitelistSet) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (whitelistSet.has(s)) return true;
  if (/^[\d\s.,:%+\-–—/\\()[\]{}<>|•·⚡⭐◔💬📋💻🖥️⚠️🔗🚀🛡️🧪📁🤖←→▼▲▶▸✓✕×…=~$#@!?*&^]+$/.test(s)) return true;
  if (/^(?:https?:\/\/|mailto:|#[0-9a-f]{3,8}$)/i.test(s)) return true;
  if (/^\{[a-zA-Z0-9_.]+\}$/.test(s)) return true;
  if (/^(?:[A-Z0-9_.-]+|[a-z]+\.[a-z0-9_.-]+)$/.test(s) && !/\s/.test(s) && s.length <= 16) return true;
  return false;
}

function hasEnglishPhrase(text, whitelistSet) {
  const s = String(text || '').replace(/\{[^}]+\}/g, '').replace(/<[^>]+>/g, ' ').trim();
  if (!s || /[\u4e00-\u9fff]/.test(s)) return false;
  if (isPurelyNonTranslatable(s, whitelistSet)) return false;
  const words = s.match(/[A-Za-z]{2,}/g) || [];
  if (words.length === 0) return false;
  if (words.length === 1 && whitelistSet.has(words[0])) return false;
  const nonWhitelisted = words.filter((w) => !whitelistSet.has(w));
  return nonWhitelisted.length > 0;
}

function auditPanelI18n(rootDir, whitelistSet) {
  const i18nPath = path.join(rootDir, 'src', 'renderer', 'i18n.js');
  const src = fs.readFileSync(i18nPath, 'utf8');
  const dict = extractPanelI18nObject(src);

  const missingZh = [];
  const emptyZh = [];
  const untranslatedZh = [];
  for (const [key, val] of Object.entries(dict)) {
    if (!val || typeof val !== 'object') continue;
    const zh = val['zh-CN'];
    const en = val.en;
    if (zh === undefined || zh === null) {
      missingZh.push(key);
    } else if (!String(zh).trim()) {
      emptyZh.push(key);
    } else if (en && String(zh).trim() === String(en).trim() && hasEnglishPhrase(zh, whitelistSet)) {
      untranslatedZh.push({ key, text: zh });
    }
  }

  // Check referenced keys across template.html and src/renderer/*.js
  const undefinedKeys = [];
  const rendererDir = path.join(rootDir, 'src', 'renderer');
  const files = fs.readdirSync(rendererDir).filter((f) => f.endsWith('.js') || f.endsWith('.html'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(rendererDir, file), 'utf8');
    const lines = content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      for (const m of line.matchAll(/\bt\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
        if (!Object.prototype.hasOwnProperty.call(dict, m[1])) {
          undefinedKeys.push({ file: `src/renderer/${file}`, line: idx + 1, key: m[1] });
        }
      }
      for (const m of line.matchAll(/\bdata-i18n(?:-[a-z]+)?="([a-zA-Z0-9_.-]+)"/g)) {
        if (!Object.prototype.hasOwnProperty.call(dict, m[1])) {
          undefinedKeys.push({ file: `src/renderer/${file}`, line: idx + 1, key: m[1] });
        }
      }
    }
  }

  return {
    totalKeys: Object.keys(dict).length,
    missingZh,
    emptyZh,
    untranslatedZh,
    undefinedKeys
  };
}

function scanTemplateHtml(rootDir, whitelistSet) {
  const findings = [];
  const tplPath = path.join(rootDir, 'src', 'renderer', 'template.html');
  const raw = fs.readFileSync(tplPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const attrChecks = [
    { attr: 'title', i18nAttr: 'data-i18n-title' },
    { attr: 'aria-label', i18nAttr: 'data-i18n-aria' },
    { attr: 'placeholder', i18nAttr: 'data-i18n-placeholder' }
  ];

  // Join multi-line opening tags to check attributes across line breaks accurately
  const tagRegex = /<([a-zA-Z0-9-]+)\b([^>]*)>/g;
  const lineStarts = [0];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\n') lineStarts.push(i + 1);
  }
  const offsetToLine = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lineStarts[mid] <= off) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi + 1;
  };

  for (const m of raw.matchAll(tagRegex)) {
    const tagBlock = m[0];
    const attrsText = m[2];
    if (tagBlock.startsWith('<!--')) continue;
    const lineNum = offsetToLine(m.index);
    for (const chk of attrChecks) {
      const am = attrsText.match(new RegExp(`(?:^|\\s)${chk.attr}="([^"]+)"`));
      if (am && !attrsText.includes(chk.i18nAttr) && hasEnglishPhrase(am[1], whitelistSet)) {
        findings.push({
          file: 'src/renderer/template.html',
          line: lineNum,
          kind: `attr:${chk.attr}`,
          text: am[1]
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*<!--/.test(line)) continue;
    if (!line.includes('data-i18n=')) {
      const stripped = line.replace(/<code>[^<]*<\/code>/g, '');
      for (const m of stripped.matchAll(/>([^<>{}&]+)</g)) {
        const txt = m[1].trim();
        if (txt && hasEnglishPhrase(txt, whitelistSet)) {
          findings.push({
            file: 'src/renderer/template.html',
            line: i + 1,
            kind: 'html-text',
            text: txt
          });
        }
      }
    }
  }
  return findings;
}

function scanCliDashboard(rootDir, whitelistSet) {
  const findings = [];
  const cliUiPath = path.join(rootDir, 'meter-cli-ui.js');
  const raw = fs.readFileSync(cliUiPath, 'utf8');
  const startIdx = raw.indexOf('function renderDashboardHtml');
  if (startIdx === -1) return findings;
  const htmlSection = raw.slice(startIdx);
  const lines = htmlSection.split(/\r?\n/);
  const baseLine = raw.slice(0, startIdx).split(/\r?\n/).length - 1;

  let inStyle = false;
  let inScript = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('<style>')) inStyle = true;
    if (line.includes('</style>')) {
      inStyle = false;
      continue;
    }
    if (line.includes('<script>')) inScript = true;
    if (line.includes('</script>')) {
      inScript = false;
      continue;
    }
    if (inStyle || inScript) continue;
    for (const m of line.matchAll(/>([^<>{}$\\]+)</g)) {
      const txt = m[1].replace(/&gt;|&lt;|&amp;/g, '').trim();
      if (txt && hasEnglishPhrase(txt, whitelistSet)) {
        findings.push({
          file: 'meter-cli-ui.js',
          line: baseLine + i + 1,
          kind: 'cli-ui-html',
          text: txt
        });
      }
    }
    for (const attr of ['title', 'aria-label', 'placeholder']) {
      const re = new RegExp(`\\b${attr}="([^"]+)"`);
      const m = line.match(re);
      if (m && hasEnglishPhrase(m[1], whitelistSet)) {
        findings.push({
          file: 'meter-cli-ui.js',
          line: baseLine + i + 1,
          kind: `cli-ui-${attr}`,
          text: m[1]
        });
      }
    }
  }
  return findings;
}

function checkDefaultSimplifiedChinese(rootDir) {
  const errors = [];
  const modCfgPath = path.join(rootDir, 'modules-config.js');
  const modCfgSrc = fs.readFileSync(modCfgPath, 'utf8');
  const chineseBlock = modCfgSrc.match(/chinese:\s*\{([\s\S]*?)\}/);
  if (!chineseBlock) {
    errors.push('modules-config.js: DEFAULT_CONFIG.modules.chinese block not found');
  } else {
    if (!/enabled:\s*true\b/.test(chineseBlock[1])) {
      errors.push('modules-config.js: DEFAULT_CONFIG.modules.chinese.enabled must be true');
    }
    if (!/language:\s*['"]zh-CN['"]/.test(chineseBlock[1])) {
      errors.push("modules-config.js: DEFAULT_CONFIG.modules.chinese.language must be 'zh-CN'");
    }
  }

  const i18nPath = path.join(rootDir, 'src', 'renderer', 'i18n.js');
  const i18nSrc = fs.readFileSync(i18nPath, 'utf8');
  const initFn = i18nSrc.match(/function resolveInitialPanelLanguage\(\)\s*\{([\s\S]*?)\}/);
  if (!initFn) {
    errors.push('src/renderer/i18n.js: resolveInitialPanelLanguage() not found');
  } else {
    if (/resolveHostClientLanguageSignal\s*\(/.test(initFn[1])) {
      errors.push('src/renderer/i18n.js: resolveInitialPanelLanguage() must not fall back to host language signal');
    }
    if (!/['"]zh-CN['"]/.test(initFn[1])) {
      errors.push("src/renderer/i18n.js: resolveInitialPanelLanguage() must default to 'zh-CN'");
    }
  }
  return errors;
}

function checkClientI18nParity(rootDir) {
  const errors = [];
  const pairs = [
    ['i18n/zh-CN.json', 'src/i18n/zh-CN.json'],
    ['i18n/i18n-runtime.js', 'src/i18n/i18n-runtime.js']
  ];
  for (const [a, b] of pairs) {
    const pA = path.join(rootDir, a);
    const pB = path.join(rootDir, b);
    if (!fs.existsSync(pA) || !fs.existsSync(pB)) {
      errors.push(`Missing client i18n file pair: ${a} / ${b}`);
      continue;
    }
    const bufA = fs.readFileSync(pA);
    const bufB = fs.readFileSync(pB);
    if (!bufA.equals(bufB)) {
      errors.push(`Byte mismatch between ${a} and ${b}`);
    }
  }

  const dictPath = path.join(rootDir, 'i18n', 'zh-CN.json');
  if (fs.existsSync(dictPath)) {
    const raw = fs.readFileSync(dictPath);
    if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
      errors.push('i18n/zh-CN.json must not contain UTF-8 BOM');
    }
    try {
      const dict = JSON.parse(raw.toString('utf8'));
      const exactCount = Object.keys(dict.exact || {}).length;
      const coreCount = Object.keys(dict.coreWords || {}).length;
      if (exactCount < 6000) errors.push(`i18n/zh-CN.json exact count too low: ${exactCount}`);
      if (coreCount < 100) errors.push(`i18n/zh-CN.json coreWords count too low: ${coreCount}`);
      for (const key of ['patterns', 'rules']) {
        if (Array.isArray(dict[key])) {
          for (let i = 0; i < dict[key].length; i++) {
            try {
              new RegExp(dict[key][i].regex);
            } catch (e) {
              errors.push(`Invalid regex in ${key}[${i}]: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      errors.push(`Invalid JSON in i18n/zh-CN.json: ${e.message}`);
    }
  }
  return errors;
}

function formatMarkdownReport(result) {
  const lines = [
    '# 汉化全量审计报告 (i18n Audit Report)',
    '',
    `- **PANEL_I18N 词条总数**：${result.panel.totalKeys}`,
    `- **缺失 zh-CN 键**：${result.panel.missingZh.length}`,
    `- **空 zh-CN 译文**：${result.panel.emptyZh.length}`,
    `- **疑似未翻译（zh-CN === en）**：${result.panel.untranslatedZh.length}`,
    `- **未定义 i18n key 引用**：${result.panel.undefinedKeys.length}`,
    `- **template.html 硬编码英文候选**：${result.templateFindings.length}`,
    `- **meter-cli-ui.js 硬编码英文候选**：${result.cliUiFindings.length}`,
    `- **默认简体中文门禁错误**：${result.defaultPolicyErrors.length}`,
    `- **客户端词典与运行时校验错误**：${result.clientParityErrors.length}`,
    ''
  ];

  const appendSection = (title, items, fmt) => {
    if (!items.length) return;
    lines.push(`## ${title} (${items.length})`, '');
    for (const it of items.slice(0, 100)) {
      lines.push(`- ${fmt(it)}`);
    }
    if (items.length > 100) lines.push(`- ... 其余 ${items.length - 100} 条已省略`);
    lines.push('');
  };

  appendSection('默认简体中文门禁错误', result.defaultPolicyErrors, (e) => e);
  appendSection('客户端词典与运行时校验错误', result.clientParityErrors, (e) => e);
  appendSection('缺失 zh-CN 的 Key', result.panel.missingZh, (k) => `\`${k}\``);
  appendSection('空 zh-CN 的 Key', result.panel.emptyZh, (k) => `\`${k}\``);
  appendSection('未定义 i18n Key 引用', result.panel.undefinedKeys, (x) => `\`${x.file}:${x.line}\` -> \`${x.key}\``);
  appendSection('疑似未翻译的 PANEL_I18N 条目', result.panel.untranslatedZh, (x) => `\`${x.key}\`: \`${x.text}\``);
  appendSection('template.html 硬编码英文候选', result.templateFindings, (x) => `\`${x.file}:${x.line}\` [${x.kind}] \`${x.text}\``);
  appendSection('meter-cli-ui.js 硬编码英文候选', result.cliUiFindings, (x) => `\`${x.file}:${x.line}\` [${x.kind}] \`${x.text}\``);

  return lines.join('\n');
}

function runAudit(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : ROOT_DIR;
  const cfg = loadLocalizationConfig(rootDir);
  const whitelistSet = new Set(cfg.nonTranslatableWhitelist || []);

  const panel = auditPanelI18n(rootDir, whitelistSet);
  const templateFindings = scanTemplateHtml(rootDir, whitelistSet);
  const cliUiFindings = scanCliDashboard(rootDir, whitelistSet);
  const defaultPolicyErrors = checkDefaultSimplifiedChinese(rootDir);
  const clientParityErrors = checkClientI18nParity(rootDir);

  const errorCount =
    panel.missingZh.length +
    panel.emptyZh.length +
    panel.undefinedKeys.length +
    panel.untranslatedZh.length +
    templateFindings.length +
    cliUiFindings.length +
    defaultPolicyErrors.length +
    clientParityErrors.length;

  const result = {
    ok: errorCount === 0,
    errorCount,
    panel,
    templateFindings,
    cliUiFindings,
    defaultPolicyErrors,
    clientParityErrors
  };

  if (options.reportPath) {
    const absReport = path.resolve(options.reportPath);
    fs.mkdirSync(path.dirname(absReport), { recursive: true });
    fs.writeFileSync(absReport, formatMarkdownReport(result), 'utf8');
  }

  return result;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const jsonOut = argv.includes('--json');
  const rIdx = argv.indexOf('--report');
  const reportPath = rIdx !== -1 && argv[rIdx + 1] ? argv[rIdx + 1] : null;

  const res = runAudit({ reportPath });
  if (jsonOut) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(
      `[audit-i18n] ok=${res.ok} errors=${res.errorCount} | ` +
      `PANEL_I18N=${res.panel.totalKeys} (missing=${res.panel.missingZh.length}, empty=${res.panel.emptyZh.length}, untranslated=${res.panel.untranslatedZh.length}, undef=${res.panel.undefinedKeys.length}) | ` +
      `template=${res.templateFindings.length} cliUi=${res.cliUiFindings.length} policy=${res.defaultPolicyErrors.length} parity=${res.clientParityErrors.length}`
    );
  }
  if (strict && !res.ok) {
    process.exit(1);
  }
}

module.exports = {
  runAudit,
  extractPanelI18nObject,
  formatMarkdownReport
};
