#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

/**
 * Capture Canva tab data with exactly one reload.
 *
 * Designed for Chrome extension runtime (node_repl browser-client):
 *   const { captureCanvaSingleReload } = await import('./scripts/canva/capture-single-reload-from-tab.mjs');
 *   const summary = await captureCanvaSingleReload({ tab, designId: 'DAHN7DOKt8M' });
 */
export async function captureCanvaSingleReload(options) {
  const {
    tab,
    designId,
    outDir = path.resolve(
      typeof process !== 'undefined' && process?.cwd ? process.cwd() : '.',
      '.tmp',
      'canva-template-json',
      String(designId || 'unknown')
    ),
    postReloadWaitMs = 6000,
    chunkSize = 50000,
  } = options || {};

  if (!tab) throw new Error('Missing required option: tab');
  if (!designId) throw new Error('Missing required option: designId');

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, 'network'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'assets'), { recursive: true });

  const before = {
    capturedAt: new Date().toISOString(),
    url: await tab.url(),
    title: await tab.title(),
  };

  // Exactly one reload for anti-block workflow.
  await tab.reload();
  await tab.playwright.waitForLoadState({ state: 'domcontentloaded', timeoutMs: 90000 });
  if (postReloadWaitMs > 0) {
    await tab.playwright.waitForTimeout(postReloadWaitMs);
  }

  const after = {
    capturedAt: new Date().toISOString(),
    url: await tab.url(),
    title: await tab.title(),
  };

  const outerHtml = await tab.playwright.evaluate(() => document.documentElement.outerHTML);
  const editorFullPath = path.join(outDir, 'editor-page.full.html');
  await fs.writeFile(editorFullPath, outerHtml, 'utf8');

  // `outerHTML` can truncate huge inline bootstrap scripts; extract full script in chunks.
  const totalBootstrapScriptLength = await tab.playwright.evaluate(() => {
    const list = Array.from(document.scripts || []);
    const found = list.find((s) => (s.textContent || '').includes("window['bootstrap'] = JSON.parse("));
    return found ? (found.textContent || '').length : 0;
  });

  const bootstrapScriptPath = path.join(outDir, 'bootstrap-script.full.js');
  const reconstructedHtmlPath = path.join(outDir, 'editor-page.reconstructed.html');
  let hasBootstrapScript = false;
  let savedBootstrapLength = 0;

  await fs.writeFile(bootstrapScriptPath, '', 'utf8');
  if (totalBootstrapScriptLength > 0) {
    hasBootstrapScript = true;
    for (let start = 0; start < totalBootstrapScriptLength; start += chunkSize) {
      const end = Math.min(start + chunkSize, totalBootstrapScriptLength);
      const piece = await tab.playwright.evaluate(
        (arg) => {
          const list = Array.from(document.scripts || []);
          const found = list.find((s) =>
            (s.textContent || '').includes("window['bootstrap'] = JSON.parse(")
          );
          const txt = found ? found.textContent || '' : '';
          return txt.slice(arg.start, arg.end);
        },
        { start, end }
      );
      await fs.appendFile(bootstrapScriptPath, piece, 'utf8');
    }
  }

  const bootstrapScript = fsSync.existsSync(bootstrapScriptPath)
    ? await fs.readFile(bootstrapScriptPath, 'utf8')
    : '';
  savedBootstrapLength = bootstrapScript.length;
  await fs.writeFile(
    reconstructedHtmlPath,
    `<!doctype html><html><head></head><body><script>${bootstrapScript}</script></body></html>`,
    'utf8'
  );

  const rawTokens = outerHtml.split(/["'\s<>]+/g).filter(Boolean);
  const urlsFromHtml = [...new Set(rawTokens.filter((u) => u.startsWith('http://') || u.startsWith('https://')))];
  const apiLikeFromHtml = urlsFromHtml.filter(
    (u) =>
      u.includes('/_ajax/') ||
      u.includes('/designspec/') ||
      u.includes('/api/') ||
      u.includes('media.canva.com') ||
      u.includes('media-public.canva.com') ||
      u.includes('font-public.canva.com')
  );
  await fs.writeFile(
    path.join(outDir, 'network', 'urls-from-html.json'),
    JSON.stringify({ total: urlsFromHtml.length, urls: urlsFromHtml }, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(outDir, 'network', 'api-like-from-html.json'),
    JSON.stringify({ total: apiLikeFromHtml.length, urls: apiLikeFromHtml }, null, 2),
    'utf8'
  );

  const cap = await tab.capabilities.get('pageAssets');
  const inventory = await cap.list();
  await fs.writeFile(path.join(outDir, 'page-assets-inventory.json'), JSON.stringify(inventory, null, 2), 'utf8');

  const bundle = await cap.bundle({
    inventoryId: inventory.id,
    kinds: ['image', 'font', 'stylesheet', 'video'],
  });
  await fs.writeFile(
    path.join(outDir, 'page-assets-bundle-summary.json'),
    JSON.stringify(bundle, null, 2),
    'utf8'
  );

  const bundleDest = path.join(outDir, 'assets', 'page-assets-bundle');
  await fs.rm(bundleDest, { recursive: true, force: true });
  await fs.mkdir(bundleDest, { recursive: true });
  if (bundle?.directoryPath && fsSync.existsSync(bundle.directoryPath)) {
    await fs.cp(bundle.directoryPath, bundleDest, { recursive: true });
  }

  const inlineSvgDir = path.join(outDir, 'assets', 'inline-svgs');
  await fs.mkdir(inlineSvgDir, { recursive: true });
  for (const svg of inventory.inlineSvgs || []) {
    const safe = String(svg.name || svg.id || 'inline').replace(/[^a-zA-Z0-9._-]+/g, '_');
    await fs.writeFile(path.join(inlineSvgDir, `${safe}.svg`), svg.markup || '', 'utf8');
  }

  const consoleLogs = await tab.dev.logs({ limit: 1000 });
  await fs.writeFile(
    path.join(outDir, 'network', 'console-logs.json'),
    JSON.stringify(consoleLogs, null, 2),
    'utf8'
  );

  const summary = {
    designId,
    oneReloadPerformed: true,
    outputDir: outDir,
    page: { before, after },
    files: {
      editorFullHtml: editorFullPath,
      bootstrapScript: bootstrapScriptPath,
      reconstructedHtml: reconstructedHtmlPath,
      urlsFromHtml: path.join(outDir, 'network', 'urls-from-html.json'),
      apiLikeFromHtml: path.join(outDir, 'network', 'api-like-from-html.json'),
      pageAssetsInventory: path.join(outDir, 'page-assets-inventory.json'),
      pageAssetsBundleSummary: path.join(outDir, 'page-assets-bundle-summary.json'),
      bundledAssetsDir: bundleDest,
      inlineSvgDir,
      consoleLogs: path.join(outDir, 'network', 'console-logs.json'),
    },
    counts: {
      urlsFromHtml: urlsFromHtml.length,
      apiLikeFromHtml: apiLikeFromHtml.length,
      assetInventory: inventory.summary?.totalCount ?? 0,
      inlineSvg: inventory.summary?.inlineSvgCount ?? 0,
      bundledDownloaded: bundle.summary?.downloadedCount ?? 0,
      bundledFailed: bundle.summary?.failedCount ?? 0,
      consoleLogs: consoleLogs.length,
      bootstrapScriptLength: savedBootstrapLength,
      bootstrapScriptDetectedLength: totalBootstrapScriptLength,
    },
  };

  await fs.writeFile(
    path.join(outDir, 'single-reload-capture-summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8'
  );

  return summary;
}

if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  console.error(
    'This script is intended to be imported and called from Chrome node_repl with a claimed `tab` object.'
  );
  process.exit(1);
}
