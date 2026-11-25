'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'localization', 'config.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'antigravity-context-viewer-l10n-sync' };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    }).on('error', reject);
  });
}

async function checkUpdates() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const pluginRepo = cfg.upstreamPluginRepo || 'elviscjn-cjn/antigravity-context-viewer';
  const dictRepo = cfg.upstreamDictRepo || 'antigravity-cn-community/Antigravity-Chinese-Localization';

  const [pluginRel, dictRel] = await Promise.all([
    fetchJson(`https://api.github.com/repos/${pluginRepo}/releases/latest`),
    fetchJson(`https://api.github.com/repos/${dictRepo}/releases/latest`)
  ]);

  const currentPlugin = String(cfg.upstreamPluginVersion || '').replace(/^v/, '');
  const latestPlugin = String(pluginRel.tag_name || '').replace(/^v/, '');
  const currentDict = String(cfg.upstreamDictVersion || '');
  const latestDict = String(dictRel.tag_name || '');

  return {
    plugin: {
      repo: pluginRepo,
      current: `v${currentPlugin}`,
      latest: `v${latestPlugin}`,
      hasUpdate: Boolean(latestPlugin && latestPlugin !== currentPlugin)
    },
    dict: {
      repo: dictRepo,
      current: currentDict,
      latest: latestDict,
      hasUpdate: Boolean(latestDict && latestDict !== currentDict)
    }
  };
}

if (require.main === module) {
  checkUpdates()
    .then((res) => {
      console.log(`[sync-upstream] Plugin: ${res.plugin.current} -> ${res.plugin.latest} (update=${res.plugin.hasUpdate})`);
      console.log(`[sync-upstream] Dict:   ${res.dict.current} -> ${res.dict.latest} (update=${res.dict.hasUpdate})`);
      if (res.plugin.hasUpdate || res.dict.hasUpdate) {
        console.log('\n建议升级步骤:');
        if (res.plugin.hasUpdate) {
          console.log('  1. git fetch upstream && git checkout main && git merge --ff-only upstream/main');
          console.log('  2. git checkout zh-cn && git merge main');
        }
        if (res.dict.hasUpdate) {
          console.log(`  3. node localization/scripts/sync-upstream-dict.js --tag ${res.dict.latest} --update-config`);
        }
        console.log('  4. npm run build:renderer && node localization/scripts/audit-i18n.js --strict --report localization/audit-report.md');
        console.log('  5. npm test && node --test localization/l10n-regression.test.js');
      }
    })
    .catch((err) => {
      console.error('[sync-upstream] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { checkUpdates };
