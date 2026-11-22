// Turns one level's k6 summary + machine monitor + consistency check into a short report, and appends a row to
// tests/load/results/summary.md.   node tests/load/report.mjs <name> <k6 exit code> [abort reason]
import {appendFileSync, existsSync, readFileSync} from 'node:fs';

const [name, rc, abort = ''] = process.argv.slice(2);
const dir = new URL('./results/', import.meta.url);
const read = f => (existsSync(new URL(f, dir)) ? readFileSync(new URL(f, dir), 'utf8') : '');
const sum = JSON.parse(read(`${name}.json`) || '{}');
const check = JSON.parse(read(`${name}.check.json`) || '{}');
const mon = read(`${name}.mon.csv`).trim().split('\n').slice(1).map(l => l.split(',').map(Number));

const M = sum.metrics || {};
const v = (m, k) => M[m]?.values?.[k];
const ms = x => (x === undefined ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
const pct = x => (x === undefined ? '—' : `${(x * 100).toFixed(2)} %`);
const durS = (sum.state?.testRunDurationMs || 0) / 1000;
const appReqs = v('http_reqs{kind:app}', 'count') || 0;
const failedThresholds = Object.entries(M).flatMap(([m, d]) => Object.entries(d.thresholds || {}).filter(([, t]) => !t.ok).map(([e]) => `${m} ${e}`));
const col = i => mon.map(r => r[i]).filter(n => !Number.isNaN(n));
const max = a => (a.length ? Math.max(...a) : 0);
const min = a => (a.length ? Math.min(...a) : 0);

const dataIssues = ['laneCountDrift', 'duplicatePositions', 'cardLaneMismatch', 'revBehind', 'seqGaps', 'duplicateMessages', 'memberCountDrift', 'lostMessages']
  .filter(k => check[k] > 0)
  .map(k => `${k}=${check[k]}`);
const gaps = v('chat_gap', 'count') || 0;
const dups = v('chat_dup', 'count') || 0;
if (gaps) dataIssues.push(`chat_gap(client)=${gaps}`);
if (dups) dataIssues.push(`chat_dup(client)=${dups}`);

const errRate = v('http_req_failed{kind:app}', 'rate');
const p95 = v('http_req_duration{kind:app}', 'p(95)');
const p99 = v('http_req_duration{kind:app}', 'p(99)');
const syncP95 = v('board_sync_ms', 'p(95)');
const chatP95 = v('chat_delivery_ms', 'p(95)');
const reasons = [];
if (abort) reasons.push(`ABORTED (${abort})`);
else if (rc !== '0' && rc !== '99') reasons.push(`k6 exited ${rc}`);
// k6 exits 99 when ANY threshold fails (targets too): the STOP conditions are judged here, from the numbers.
const stopHit = p95 > 3000 || errRate > 0.05;
if (stopHit) reasons.push('stop condition hit');
if (p95 > 500) reasons.push(`p95 ${ms(p95)} > 500 ms`);
if (p99 > 1000) reasons.push(`p99 ${ms(p99)} > 1 s`);
if (errRate > 0.01) reasons.push(`errors ${pct(errRate)} > 1 %`);
if (syncP95 > 6000) reasons.push(`board sync p95 ${ms(syncP95)} > 6 s`);
if (chatP95 > 4000) reasons.push(`chat p95 ${ms(chatP95)} > 4 s`);
if (dataIssues.length) reasons.push(`data: ${dataIssues.join(', ')}`);
const status = abort ? 'ABORTED' : stopHit ? 'STOP' : reasons.length ? 'FAIL' : 'PASS';

const opRows = Object.keys(M)
  .filter(k => k.startsWith('http_reqs{op:'))
  .map(k => {
    const op = k.slice(13, -1);
    const n = v(k, 'count') || 0;
    const f = v(`op_failed{op:${op}}`, 'count') || 0;
    return n ? `| ${op} | ${n} | ${f} | ${ms(v(`http_req_duration{op:${op}}`, 'p(95)'))} |` : null;
  })
  .filter(Boolean);
const epRows = Object.keys(M)
  .filter(k => k.startsWith('http_req_duration{name:') && v(k, 'avg') !== undefined)
  .map(k => `| ${k.slice(23, -1)} | ${ms(v(k, 'med'))} | ${ms(v(k, 'p(95)'))} | ${ms(v(k, 'p(99)'))} | ${ms(v(k, 'max'))} |`);

console.log(`
## ${name}: ${status}
Users (VUs) max ${v('vus_max', 'max') ?? '—'} · duration ${Math.round(durS)} s · app requests ${appReqs} (${(appReqs / (durS || 1)).toFixed(1)}/s avg over the run)
Persistent real-time connections: 0 (the app polls over HTTP; poll requests are op=sync below)

| HTTP (app) | avg | p50 | p90 | p95 | p99 | max | errors |
|---|---|---|---|---|---|---|---|
| all | ${ms(v('http_req_duration{kind:app}', 'avg'))} | ${ms(v('http_req_duration{kind:app}', 'med'))} | ${ms(v('http_req_duration{kind:app}', 'p(90)'))} | ${ms(p95)} | ${ms(p99)} | ${ms(v('http_req_duration{kind:app}', 'max'))} | ${pct(errRate)} |
| sign-in (excluded above) | ${ms(v('http_req_duration{kind:auth}', 'avg'))} | ${ms(v('http_req_duration{kind:auth}', 'med'))} | | ${ms(v('http_req_duration{kind:auth}', 'p(95)'))} | | ${ms(v('http_req_duration{kind:auth}', 'max'))} | ${pct(v('http_req_failed{kind:auth}', 'rate'))} |

| Operation | requests | failed | p95 |
|---|---|---|---|
${opRows.join('\n')}

| Endpoint | p50 | p95 | p99 | max |
|---|---|---|---|---|
${epRows.join('\n')}

Real-time: board sync p50 ${ms(v('board_sync_ms', 'med'))} / p95 ${ms(syncP95)} · chat delivery p50 ${ms(v('chat_delivery_ms', 'med'))} / p95 ${ms(chatP95)} · chat sent ${v('chat_sent_ok', 'count') ?? 0}, received ${v('chat_received', 'count') ?? 0}, gaps ${gaps}, duplicates ${dups} · card writes ok ${v('card_writes_ok', 'count') ?? 0}, lane full ${v('lane_full', 'count') ?? 0}, card already gone (another user archived it: a correct 404, not counted as an error) ${v('card_gone', 'count') ?? 0}
Data check: ${JSON.stringify(check)}
This machine: free memory ${min(col(1))}–${max(col(1))} MB · load1 max ${max(col(3))} · k6 max ${max(col(4))} MB / ${max(col(5))} % CPU · local site (astro dev + workerd) max ${max(col(6))} MB / ${max(col(7))} % CPU
Status: ${status}${reasons.length ? ` (${reasons.join('; ')})` : ''}
Failed thresholds: ${failedThresholds.length ? failedThresholds.join(' | ') : 'none'}
`);

const summary = new URL('summary.md', dir);
if (!existsSync(summary)) appendFileSync(summary, '| Level | VUs | Req/s | HTTP p95 | HTTP p99 | Errors | Chat p95 | Board sync p95 | Data issues | Site CPU max | Status |\n|---|---|---|---|---|---|---|---|---|---|---|\n');
appendFileSync(summary, `| ${name} | ${v('vus_max', 'max') ?? ''} | ${(appReqs / (durS || 1)).toFixed(1)} | ${ms(p95)} | ${ms(p99)} | ${pct(errRate)} | ${ms(chatP95)} | ${ms(syncP95)} | ${dataIssues.join(', ') || 'none'} | ${max(col(7))} % | ${status} |\n`);
