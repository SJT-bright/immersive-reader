// 资产引用守卫：模块身份唯一 ＋ index.html 引用的每个资源确实存在。
// 起因：2026-10-05 审计发现同一模块被以不同 ?v= 加载成两份实例（settings.js 2.4.0/2.5.1、
// qq-music.js 1.5.0/1.6.1、icons.js 裸路径/1.1.0），而浏览器是按「含 query 的完整 URL」
// 认定 ES 模块身份的。主会话已把模块间版本查询全部移除，本文件负责让它不再回来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = rel => fs.existsSync(path.join(ROOT, rel));

test('js/ 模块之间的 import 一律裸 specifier（不得带 ?v=）', () => {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(x => x.endsWith('.js'))) {
        const src = read('js/' + f);
        for (const m of src.matchAll(/['"]\.\/[A-Za-z0-9_-]+\.js\?v=[^'"]*['"]/g)) {
            offenders.push(`js/${f}:${src.slice(0, m.index).split('\n').length} ${m[0]}`);
        }
    }
    assert.deepEqual(offenders, [], `模块间仍带版本查询：\n${offenders.join('\n')}`);
});

test('tests/ 引用 js 模块也不带 ?v=（与运行时同一身份口径）', () => {
    const offenders = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'tests')).filter(x => x.endsWith('.mjs'))) {
        const src = read('tests/' + f);
        for (const m of src.matchAll(/['"]\.\.\/js\/[A-Za-z0-9_-]+\.js\?v=[^'"]*['"]/g)) offenders.push(`tests/${f} ${m[0]}`);
    }
    assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('index.html 引用的每个本地 css/js 资源都真实存在', () => {
    const html = read('index.html');
    const refs = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"?#]+)(?:\?v=[^"]*)?"/g)].map(m => m[1]);
    assert.ok(refs.length >= 8, `index.html 里只找到 ${refs.length} 条样式/脚本引用，疑似解析失效`);
    const missing = refs.filter(r => !exists(r));
    assert.deepEqual(missing, [], `引用了不存在的资源：${missing.join(', ')}`);
});

test('index.html 的入口版本查询不为空（缓存失效的唯一入口）', () => {
    const html = read('index.html');
    const entries = [...html.matchAll(/(?:href|src)="((?:css|js)\/[^"]+)"/g)].map(m => m[1]);
    const unversioned = entries.filter(r => !r.includes('?v='));
    assert.deepEqual(unversioned, [], `入口资源缺少 ?v=（改了代码但没 bump 就会吃旧缓存）：${unversioned.join(', ')}`);
});

test('main.js 是 index.html 唯一加载的入口脚本', () => {
    const html = read('index.html');
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
    assert.equal(scripts.length, 1, `入口脚本数=${scripts.length}：${scripts.join(', ')}`);
    assert.match(scripts[0], /^js\/main\.js\?v=/);
});
