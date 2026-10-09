#!/usr/bin/env node
// dsh 手动直装器：绕开 npm arborist（鸿蒙本机 resolve 阶段静默卡死），
// 从 registry 元数据递归解析依赖图 + tarball 直装进 node_modules。
// 用法: node dsh-manual-install.mjs <版本>       例: node dsh-manual-install.mjs 0.1.0-rc.8
// 依赖既有 node_modules 作基线：spec 未变的包保留已装版本，仅装变更/新增的。
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const VERSION = process.argv[2];
if (!VERSION) { console.error('用法: node dsh-manual-install.mjs <版本>'); process.exit(1); }
// 目标 node_modules：默认 ~/dsh-test，可用 DSH_NODE_MODULES 指向隔离目录做探针安装。
const NM = process.env.DSH_NODE_MODULES || join(homedir(), 'dsh-test', 'node_modules');
const REG = 'https://registry.npmjs.org';
const UA = 'manual-dsh-installer';
const TIMEOUT_MS = 60000;

const enc = (name) => name.replace(/\//g, '%2f');
async function getManifest(name) {
  const res = await fetch(`${REG}/${enc(name)}`, {
    headers: { 'accept': 'application/vnd.npm.install-v1+json', 'user-agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`manifest ${name} HTTP ${res.status}`);
  return res.json();
}
// 解析版本为 5 元组 [maj,min,pa,stage,pre]：alpha=1 / rc=2 / 正式版=3，同数字段下预发布号按 pre 比较，
// 使 alpha < rc < 正式版（npm 语义），且 dsh-v0.1.2-alpha.2 这类 alpha 预发布也能参与排序与范围匹配。
const numsOf = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|rc)\.(\d+))?$/.exec(String(v).trim());
  return m ? [+m[1], +m[2], +m[3], m[4] === 'alpha' ? 1 : m[4] === 'rc' ? 2 : 3, +(m[5] || 0)] : null;
};
// 比较 [maj,min,pa,stage,pre]
function cmpNums(a, b) { for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; }
// npm 语义的范围判定：^ 在 0.x 上锁定次版本、0.0.x 上锁定补丁版本。
// 直装器旧实现只比较主版本，导致 ^0.1.6 被误判满足 0.2.x，跨 0.1↔0.2 的升级/回滚全部失效。
function rangeAllows(r, q) {
  if (!r || !q) return false;
  if (r.kind === 'unknown') return true;
  if (!r.nums) return false;
  const R = r.nums;
  if (cmpNums(q, R) < 0) return false;
  if (r.kind === 'exact') return cmpNums(q, R) === 0;
  if (r.kind === '~') return q[0] === R[0] && q[1] === R[1];
  if (r.kind === '^') {
    if (R[0] !== 0) return q[0] === R[0];
    if (R[1] !== 0) return q[0] === 0 && q[1] === R[1];
    return q[0] === 0 && q[1] === 0 && q[2] === R[2];
  }
  return true;
}
// 解析 range：支持 精确 / ^x.y.z[-alpha|rc.n] / ~x.y.z[-alpha|rc.n] / ^4 / ~4.1 等简写；
// 无法解析的（>=、||、@^4 等）标为 unknown → 已装有则不重装，缺失则装最高版本。
function parseRange(spec) {
  if (spec.startsWith('@')) spec = spec.slice(1);
  if (/^(\d+\.\d+\.\d+)/.test(spec)) return { kind: 'exact', nums: numsOf(spec) };
  if (spec[0] === '^' || spec[0] === '~') {
    const base = spec.slice(1).match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(alpha|rc)\.(\d+))?/);
    if (base) {
      return { kind: spec[0], nums: [+base[1], +(base[2] || 0), +(base[3] || 0), base[4] === 'alpha' ? 1 : base[4] === 'rc' ? 2 : 3, +(base[5] || 0)] };
    }
  }
  return { kind: 'unknown', nums: null };
}
// spec 下可用的最高版本；unknown 范围取全版本最高（best effort）
function pickVersion(m, spec) {
  if (m.versions[spec]) return spec;
  const r = parseRange(spec);
  let best = null;
  for (const v of Object.keys(m.versions)) {
    const q = numsOf(v);
    if (!q) continue;
    if (!rangeAllows(r, q)) continue;
    if (r.kind === 'exact') return v;
    if (!best || cmpNums(q, best.q) > 0) best = { v, q };
  }
  return best ? best.v : null;
}
// optionalDependencies 的平台门控（npm 同款：os/cpu 不匹配则跳过）
function platformMatch(vm) {
  const os = vm.os, cpu = vm.cpu;
  if (Array.isArray(os) && os.length && !os.includes(process.platform)) return false;
  if (Array.isArray(cpu) && cpu.length && !cpu.includes(process.arch)) return false;
  return true;
}
function installedVersion(name) {
  try { return JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8')).version || ''; }
  catch { return ''; }
}
function installedDeps(name) {
  try {
    const p = JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8'));
    // 0.1.2-alpha.x 起官方大量把核心子包迁到 peerDependencies（dsh-util-time / dsh-attachment / dsh-llm 等），
    // 直装器若只走 dependencies/optionalDependencies 会漏装 peer，导致启动报
    // "Cannot find package '@deepseek-ai/dsh-util-time'" 与 "does not provide an export named ..."。
    // 因此把非 optional 的 peerDependencies 也并入解析图（optional 的 peer 按 optionalDependencies 语义处理）。
    const meta = p.peerDependenciesMeta || {};
    const peers = {};
    for (const [pn, ps] of Object.entries(p.peerDependencies || {})) {
      if (meta[pn] && meta[pn].optional) continue;
      peers[pn] = ps;
    }
    return { deps: p.dependencies || {}, optional: p.optionalDependencies || {}, peers };
  } catch { return { deps: {}, optional: {}, peers: {} }; }
}
async function downloadTarball(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`tarball HTTP ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// 下载+解压包到 node_modules/<name>；返回实际版本
async function installPackage(name, version) {
  const m = await getManifest(name);
  const ver = pickVersion(m, version) || version;
  const dist = m.versions[ver].dist;
  const work = join(NM, '.manual-' + name.replace(/\//g, '_'));
  try {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const tgz = join(work, 'p.tgz');
    writeFileSync(tgz, await downloadTarball(dist.tarball));
    const ex = join(work, 'x');
    mkdirSync(ex, { recursive: true });
    const t = spawnSync('tar', ['-xzf', tgz, '-C', ex], { encoding: 'utf8' });
    if (t.status !== 0) throw new Error(`tar 解压失败 ${name}: ${t.stderr}`);
    const dest = join(NM, name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    const src = join(ex, 'package');
    spawnSync('mv', [src, dest], { encoding: 'utf8' });
    rmSync(work, { recursive: true, force: true });
    console.log(`  ✓ ${name}@${ver}`);
    return ver;
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
}

async function main() {
  const target = '@deepseek-ai/dsh';
  const m = await getManifest(target);
  if (!m.versions[VERSION]) throw new Error(`版本 ${VERSION} 不存在于 ${target}`);

  const seen = new Set();
  const queue = [{ name: target, spec: VERSION, optional: false }];
  let installed = 0, kept = 0, skipped = 0;

  while (queue.length) {
    const { name, spec, optional } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);

    const cur = installedVersion(name);
    if (cur && satisfies(cur, spec)) {
      kept++;
    } else if (optional) {
      // 平台门控：os/cpu 不匹配的 optional 包跳过（不装即不下载）
      const om = await getManifest(name).catch(() => null);
      const ov = om && pickVersion(om, spec);
      if (!om || !ov || !platformMatch(om.versions[ov])) { skipped++; continue; }
      await installPackage(name, ov);
      installed++;
    } else {
      const pm = await getManifest(name);
      const pv = pickVersion(pm, spec);
      if (!pv) throw new Error(`无法解析版本范围: ${spec} (${name})`);
      await installPackage(name, pv);
      installed++;
    }

    const { deps, optional: opt, peers } = installedDeps(name);
    for (const [dn, ds] of Object.entries(deps)) if (!seen.has(dn)) queue.push({ name: dn, spec: ds, optional: false });
    for (const [dn, ds] of Object.entries(opt)) if (!seen.has(dn)) queue.push({ name: dn, spec: ds, optional: true });
    for (const [dn, ds] of Object.entries(peers)) if (!seen.has(dn)) queue.push({ name: dn, spec: ds, optional: false });
  }

  // 主包可能因 satisfies 误判被 keep，强制校验真实版本
  const final = installedVersion(target);
  console.log(`闭包遍历 ${seen.size} 包: 新装/覆盖 ${installed}, 保留基线 ${kept}, 平台跳过 ${skipped}`);
  console.log(`node_modules/@deepseek-ai/dsh = ${final}`);
  if (final !== VERSION) { console.error('主包版本不符!'); process.exit(1); }
}
// 判断已装 cur 是否满足 spec；unknown 范围视为已满足（保留现有，避免误降级）
function satisfies(cur, spec) {
  if (!cur) return false;
  if (spec === cur) return true;
  const r = parseRange(spec);
  const c = numsOf(cur);
  if (!r || !c) return false;
  return rangeAllows(r, c);
}
main().then(() => process.exit(0)).catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
