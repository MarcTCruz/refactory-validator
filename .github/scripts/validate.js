#!/usr/bin/env node
import { getQuickJS } from 'quickjs-emscripten';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { pathToFileURL } from 'url';

const REPO = 'MarcTCruz/refactory-validator';

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

async function apiFetch(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json'
    }
  });
  return res;
}

async function fetchChangedForks(lastRunAt) {
  const changed = [];
  let page = 1;
  const cutoff = new Date(lastRunAt);
  while (true) {
    const res = await apiFetch(`/repos/${REPO}/forks?sort=newest&per_page=100&page=${page}`);
    if (!res.ok) break;
    const forks = await res.json();
    if (forks.length === 0) break;
    for (const fork of forks) {
      if (new Date(fork.pushed_at) < cutoff) return changed;
      changed.push(fork.owner.login);
    }
    page++;
  }
  return changed;
}

async function fetchSolution(owner, exerciseId) {
  const url = `https://raw.githubusercontent.com/${owner}/refactory-validator/main/solutions/${exerciseId}.js`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

export async function gradeExercise(QuickJS, code, testDef) {
  const vm = QuickJS.newContext();
  try {
    const defineResult = vm.evalCode(code);
    if (defineResult.error) {
      vm.dump(defineResult.error);
      defineResult.error.dispose();
      return 'fail';
    }
    defineResult.value.dispose();

    for (const tc of testDef.testCases) {
      const args = tc.input.map(v => JSON.stringify(v)).join(', ');
      const callResult = vm.evalCode(`JSON.stringify(${testDef.functionName}(${args}))`);
      if (callResult.error) {
        vm.dump(callResult.error);
        callResult.error.dispose();
        return 'fail';
      }
      const raw = vm.dump(callResult.value);
      callResult.value.dispose();
      let actual;
      try { actual = JSON.parse(raw); } catch { actual = raw; }
      if (!deepEqual(actual, tc.expected)) return 'fail';
    }
    return 'pass';
  } finally {
    vm.dispose();
  }
}

async function main() {
  const metaPath = '_meta/last_run.json';
  let lastRunAt = '1970-01-01T00:00:00Z';
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    lastRunAt = meta.last_run_at;
  }

  process.stderr.write(`Last run: ${lastRunAt}\n`);
  const users = await fetchChangedForks(lastRunAt);
  process.stderr.write(`${users.length} fork(s) changed since last run\n`);

  if (users.length === 0) {
    writeFileSync(metaPath, JSON.stringify({ last_run_at: new Date().toISOString() }, null, 2));
    return;
  }

  const QuickJS = await getQuickJS();
  const exerciseIds = readdirSync('exercises');
  const testsVersion = readFileSync('.git/HEAD', 'utf-8').trim();

  mkdirSync('results', { recursive: true });

  for (const user of users) {
    const exercises = {};
    for (const exerciseId of exerciseIds) {
      const testPath = join('exercises', exerciseId, 'tests.json');
      if (!existsSync(testPath)) continue;

      const code = await fetchSolution(user, exerciseId);
      if (!code) continue;

      const testDef = JSON.parse(readFileSync(testPath, 'utf-8'));
      const solutionHash = `sha256:${createHash('sha256').update(code).digest('hex')}`;
      const status = await gradeExercise(QuickJS, code, testDef);
      exercises[exerciseId] = { status, verified_at: new Date().toISOString(), solutionHash };
    }

    if (Object.keys(exercises).length > 0) {
      const result = { user, verified_at: new Date().toISOString(), tests_version: testsVersion, exercises };
      writeFileSync(join('results', `${user}.json`), JSON.stringify(result, null, 2));
      const passed = Object.values(exercises).filter(e => e.status === 'pass').length;
      process.stderr.write(`${user}: ${passed}/${Object.keys(exercises).length} passed\n`);
    }
  }

  writeFileSync(metaPath, JSON.stringify({ last_run_at: new Date().toISOString() }, null, 2));
}

// Run the fork-scan only when executed directly (node validate.js), not when
// gradeExercise is imported by the trainer's sandbox-parity check.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main().catch(err => { console.error(err); process.exit(1); });
