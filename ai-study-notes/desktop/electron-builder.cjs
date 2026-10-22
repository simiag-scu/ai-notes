const { execFileSync } = require('node:child_process');
const path = require('node:path');
module.exports = {
  appId: 'local.shiye.study-notes',
  productName: '拾页',
  artifactName: 'Shiye-${version}-mac-${arch}.${ext}',
  asar: true,
  npmRebuild: false,
  extraResources: [
    { from: path.join(__dirname, '../docs/third-party'), to: 'third-party-licenses' },
    { from: path.join(__dirname, '../THIRD_PARTY_NOTICES.md'), to: 'THIRD_PARTY_NOTICES.md' },
  ],
  afterPack: context => { execFileSync('/usr/bin/xattr', ['-cr', path.join(context.appOutDir, '拾页.app')]); },
  files: ['desktop/**', 'server/**', 'core/**', 'web/**', 'obsidian/**', 'dist/shiye-extension.zip', 'dist/shiye-obsidian.zip', 'package.json', 'node_modules/undici/**', '!desktop/package*.json', '!desktop/electron-builder.cjs', '!desktop/create-icon.cjs'],
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.education', icon: 'build/icon.icns', identity: process.env.SHIYE_SIGN_IDENTITY || '-', hardenedRuntime: !!process.env.SHIYE_SIGN_IDENTITY, notarize: process.env.SHIYE_NOTARIZE === '1', minimumSystemVersion: '13.0.0', darkModeSupport: false, extendInfo: { CFBundleDisplayName: '拾页', NSHumanReadableCopyright: '拾页 · AI 对话与学习笔记', LSApplicationCategoryType: 'public.app-category.education' } },
  dmg: { title: '拾页 ${version}', icon: 'build/icon.icns', sign: false, window: { width: 560, height: 380 }, contents: [{ x: 160, y: 175, type: 'file' }, { x: 400, y: 175, type: 'link', path: '/Applications' }] },
  publish: null
};
