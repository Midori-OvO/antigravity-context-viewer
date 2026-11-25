'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_DICT_PATH = path.join(ROOT_DIR, 'i18n', 'zh-CN.json');
const MIRROR_DICT_PATH = path.join(ROOT_DIR, 'src', 'i18n', 'zh-CN.json');
const OVERRIDE_PATH = path.join(ROOT_DIR, 'localization', 'overrides', 'client-zh-CN.json');
const CONFIG_PATH = path.join(ROOT_DIR, 'localization', 'config.json');

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'antigravity-context-viewer-l10n-sync' };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} when fetching ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function parseUpstreamDictionarySource(sourceText) {
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: () => ({}),
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  vm.runInNewContext(sourceText, sandbox, { timeout: 5000 });
  const exported = mod.exports && Object.keys(mod.exports).length > 0 ? mod.exports : sandbox.module.exports;
  if (!exported || typeof exported !== 'object') {
    throw new Error('Upstream dictionary.js did not export a valid object');
  }
  const exact = exported.dictionary || exported.exact || exported.EXACT_DICTIONARY || {};
  const coreWords = exported.coreWords || exported.CORE_WORDS || {};
  const patterns = Array.isArray(exported.patterns) ? exported.patterns : [];
  const selfHealMap = exported.selfHealMap || exported.SELF_HEAL_MAP || {};
  return { exact, coreWords, patterns, selfHealMap };
}

function validateRegexList(list, label) {
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item.regex !== 'string') {
      throw new Error(`Invalid ${label}[${i}]: missing regex string`);
    }
    new RegExp(item.regex);
  }
}

function mergePatternArrays(baseList = [], incomingList = [], overrideList = []) {
  const map = new Map();
  for (const list of [baseList, incomingList, overrideList]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item.regex !== 'string') continue;
      map.set(item.regex, { ...item });
    }
  }
  return Array.from(map.values());
}

function mergeDictionaries(existingDict, upstreamDict, overrideDict) {
  const merged = { ...existingDict };
  merged.exact = {
    ...(existingDict.exact || {}),
    ...(upstreamDict.exact || {}),
    ...(overrideDict.exact || {})
  };
  merged.coreWords = {
    ...(existingDict.coreWords || {}),
    ...(upstreamDict.coreWords || {}),
    ...(overrideDict.coreWords || {})
  };
  merged.selfHealMap = {
    ...(existingDict.selfHealMap || {}),
    ...(upstreamDict.selfHealMap || {}),
    ...(overrideDict.selfHealMap || {})
  };
  merged.patterns = mergePatternArrays(
    existingDict.patterns || [],
    upstreamDict.patterns || [],
    overrideDict.patterns || []
  );
  if (Array.isArray(merged.rules)) {
    validateRegexList(merged.rules, 'rules');
  }
  validateRegexList(merged.patterns, 'patterns');
  return merged;
}

async function resolveUpstreamSource(options = {}) {
  if (options.localFile) {
    const absPath = path.resolve(options.localFile);
    return {
      tag: options.tag || 'local',
      source: fs.readFileSync(absPath, 'utf8')
    };
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const repo = cfg.upstreamDictRepo || 'antigravity-cn-community/Antigravity-Chinese-Localization';
  let tag = options.tag;
  if (!tag) {
    const relJson = await fetchText(`https://api.github.com/repos/${repo}/releases/latest`);
    const rel = JSON.parse(relJson);
    tag = rel.tag_name;
    if (!tag) throw new Error(`Failed to resolve latest release tag for ${repo}`);
  }
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/src/dictionary.js`;
  const source = await fetchText(rawUrl);
  return { tag, source };
}

async function syncUpstreamDict(options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : ROOT_DIR;
  const targetPrimary = options.targetPrimary || path.join(rootDir, 'i18n', 'zh-CN.json');
  const targetMirror = options.targetMirror || path.join(rootDir, 'src', 'i18n', 'zh-CN.json');
  const overridePath = options.overridePath || OVERRIDE_PATH;
  const configPath = options.configPath || CONFIG_PATH;

  const existing = JSON.parse(fs.readFileSync(targetPrimary, 'utf8'));
  const override = fs.existsSync(overridePath)
    ? JSON.parse(fs.readFileSync(overridePath, 'utf8'))
    : { exact: {}, coreWords: {}, patterns: [], selfHealMap: {} };

  const { tag, source } = await resolveUpstreamSource(options);
  const upstream = parseUpstreamDictionarySource(source);
  const merged = mergeDictionaries(existing, upstream, override);

  const prevExactCount = Object.keys(existing.exact || {}).length;
  const nextExactCount = Object.keys(merged.exact || {}).length;
  const prevCoreCount = Object.keys(existing.coreWords || {}).length;
  const nextCoreCount = Object.keys(merged.coreWords || {}).length;

  const serialized = JSON.stringify(merged, null, 2) + '\n';
  if (!options.dryRun) {
    fs.writeFileSync(targetPrimary, serialized, 'utf8');
    fs.writeFileSync(targetMirror, serialized, 'utf8');
    if (options.updateConfig && tag && tag !== 'local' && fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.upstreamDictVersion = tag;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }
  }

  return {
    tag,
    dryRun: Boolean(options.dryRun),
    prevExactCount,
    nextExactCount,
    addedExact: nextExactCount - prevExactCount,
    prevCoreCount,
    nextCoreCount,
    addedCore: nextCoreCount - prevCoreCount,
    upstreamExactCount: Object.keys(upstream.exact || {}).length,
    upstreamCoreCount: Object.keys(upstream.coreWords || {}).length
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--local-file' && argv[i + 1]) opts.localFile = argv[++i];
    else if (a === '--tag' && argv[i + 1]) opts.tag = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--update-config') opts.updateConfig = true;
  }
  return opts;
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  syncUpstreamDict(opts)
    .then((res) => {
      console.log(
        `[sync-upstream-dict] tag=${res.tag} dryRun=${res.dryRun} ` +
        `exact: ${res.prevExactCount} -> ${res.nextExactCount} (+${res.addedExact}) | ` +
        `coreWords: ${res.prevCoreCount} -> ${res.nextCoreCount} (+${res.addedCore})`
      );
    })
    .catch((err) => {
      console.error('[sync-upstream-dict] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  parseUpstreamDictionarySource,
  mergeDictionaries,
  syncUpstreamDict
};
