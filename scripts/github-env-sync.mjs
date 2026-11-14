// Push a dotenv file to GitHub Actions secrets/variables for deploy_serverless.yml.
//
//   npm run env:sync -- deploy/dev.env  --stage dev  [--repo owner/name] [--dry-run]
//   npm run env:sync -- deploy/prod.env --stage prod [--dry-run]
//
// Needs the `gh` CLI logged in. Values go to `gh` on stdin only - never argv, never
// printed. Empty values are skipped (nothing on GitHub is ever deleted).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { buildPlan, formatPlanLine, parseDotenv, repoFromRemote } from './github-env-sync.lib.mjs';

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    'usage: node scripts/github-env-sync.mjs <dotenv-file> --stage dev|prod [--repo owner/name] [--dry-run]'
  );
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
const valueFlags = new Set(['--stage', '--repo']);
const positional = [];
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (valueFlags.has(args[i])) opts[args[i]] = args[++i];
  else if (args[i].startsWith('--')) opts[args[i]] = true;
  else positional.push(args[i]);
}
const file = positional[0];
const dryRun = opts['--dry-run'] === true;
const stage = opts['--stage'];
if (!file) usage('missing dotenv file');
if (stage !== 'dev' && stage !== 'prod') usage('--stage must be dev or prod');

let repo = opts['--repo'];
if (!repo) {
  try {
    repo = repoFromRemote(execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }));
  } catch {
    /* fall through */
  }
}
if (!repo) usage('could not detect repo; pass --repo owner/name');

const { plan, unknown } = buildPlan(parseDotenv(readFileSync(file, 'utf8')), stage);
if (unknown.length) console.warn(`ignored unknown keys: ${unknown.join(', ')}`);

console.log(`${dryRun ? '[dry-run] ' : ''}repo ${repo}, stage ${stage}, ${plan.length} keys`);
let failed = 0;
for (const item of plan) {
  console.log(formatPlanLine(item));
  if (dryRun || item.empty) continue;
  // No --body: gh reads the value from stdin, keeping it off the process list.
  const r = spawnSync('gh', [item.kind === 'secret' ? 'secret' : 'variable', 'set', item.name, '-R', repo], {
    input: item.value,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    failed++;
    console.error(`  failed to set ${item.name}: ${(r.stderr || '').split('\n')[0]}`);
  }
}
process.exit(failed ? 1 : 0);
