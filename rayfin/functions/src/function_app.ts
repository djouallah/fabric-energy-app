import { createHmac } from 'node:crypto';

import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/*
 * The browser never receives the app identity's storage token (that token carries the owner's
 * full OneLake access). These functions use it server-side and hand back OneLake user-delegation
 * SAS URLs scoped to a single file, with the narrowest permission and a short lifetime.
 *
 * ONELAKE_FILES_URL (rayfin secret): https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Files
 * The data workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 */

type Ctx = RayfinContext<BlankAppSchema, AudienceType.Storage>;

const SAS_VERSION = '2022-11-02';
const SAS_LIFETIME_MS = 15 * 60 * 1000;   // OneLake caps SAS and delegation keys at 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Query-log files the dashboard writes (see site/app.js): session_<id>.csv / query_log_<stamp>.csv
const LOG_NAME = /^(session|query_log)_[\w.-]{1,96}\.csv$/;

interface DelegationKey {
  oid: string; tid: string; start: string; expiry: string; service: string; version: string; value: string;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function filesBase(ctx: Ctx): URL {
  return new URL(ctx.Secrets.ONELAKE_FILES_URL.replace(/\/+$/, ''));
}

// Window for both the delegation key and the SAS: now-skew .. +15 min, never past the
// storage token's own expiry (OneLake rejects a key that outlives the token that requested it).
function sasWindow(token: string): { start: Date; expiry: Date } {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
  const now = Date.now();
  const tokenExpiry = payload.exp ? payload.exp * 1000 - 60 * 1000 : Infinity;
  return { start: new Date(now - CLOCK_SKEW_MS), expiry: new Date(Math.min(now + SAS_LIFETIME_MS, tokenExpiry)) };
}

async function getDelegationKey(base: URL, token: string, start: Date, expiry: Date): Promise<DelegationKey> {
  const host = base.host.replace('.dfs.', '.blob.');
  const res = await fetch(`https://${host}/?restype=service&comp=userdelegationkey`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-ms-version': SAS_VERSION, 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${iso(start)}</Start><Expiry>${iso(expiry)}</Expiry></KeyInfo>`,
  });
  const xml = await res.text();
  const tag = (name: string): string => {
    const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
    if (!m) throw new Error(`OneLake user delegation key request failed (HTTP ${res.status})`);
    return m[1];
  };
  return {
    oid: tag('SignedOid'), tid: tag('SignedTid'), start: tag('SignedStart'), expiry: tag('SignedExpiry'),
    service: tag('SignedService'), version: tag('SignedVersion'), value: tag('Value'),
  };
}

// Blob-scoped (sr=b) user-delegation SAS for one file under the Files base.
function signFileSas(base: URL, relPath: string, permissions: string, key: DelegationKey, start: Date, expiry: Date): string {
  const blobPath = decodeURIComponent(`${base.pathname}/${relPath}`);
  const st = iso(start);
  const se = iso(expiry);
  const stringToSign = [
    permissions, st, se, `/blob/onelake${blobPath}`,
    key.oid, key.tid, key.start, key.expiry, key.service, key.version,
    '', '', '', '',          // saoid, suoid, scid, sip (unsupported by OneLake)
    'https', SAS_VERSION, 'b',
    '', '',                  // snapshot time, encryption scope
    '', '', '', '', '',      // rscc, rscd, rsce, rscl, rsct
  ].join('\n');
  const sig = createHmac('sha256', Buffer.from(key.value, 'base64')).update(stringToSign, 'utf8').digest('base64');
  const query = new URLSearchParams({
    sp: permissions, st, se, skoid: key.oid, sktid: key.tid, skt: key.start, ske: key.expiry,
    sks: key.service, skv: key.version, spr: 'https', sv: SAS_VERSION, sr: 'b', sig,
  });
  return `${base.origin}${base.pathname}/${relPath}?${query}`;
}

/** Read-only SAS URL for the current dashboard database (resolved from data/latest.txt). */
udf.func(
  'getDataUrl',
  async (ctx: Ctx): Promise<{ file: string; url: string; expiresOn: string }> => {
    const token = ctx.Tokens.Storage;
    const base = filesBase(ctx);
    const latest = await fetch(`${base}/data/latest.txt`, { headers: { Authorization: `Bearer ${token}` } });
    const file = latest.ok ? (await latest.text()).trim() : '';
    if (!/^[\w.-]+\.duckdb$/.test(file)) throw new Error(`data/latest.txt is missing or invalid (HTTP ${latest.status})`);
    const { start, expiry } = sasWindow(token);
    const key = await getDelegationKey(base, token, start, expiry);
    return { file, url: signFileSas(base, `data/${file}`, 'r', key, start, expiry), expiresOn: iso(expiry) };
  },
  [],
);

/** Create/overwrite SAS URL (Blob endpoint) for one query-log CSV under query_logs/data/. */
udf.func(
  'getLogUploadUrl',
  async (name: string, ctx: Ctx): Promise<{ url: string; expiresOn: string }> => {
    if (!LOG_NAME.test(name)) throw new Error('invalid query-log file name');
    const token = ctx.Tokens.Storage;
    const base = filesBase(ctx);
    const { start, expiry } = sasWindow(token);
    const key = await getDelegationKey(base, token, start, expiry);
    const url = signFileSas(base, `query_logs/data/${name}`, 'cw', key, start, expiry)
      .replace('.dfs.fabric.microsoft.com', '.blob.fabric.microsoft.com');   // single PUT needs the Blob host
    return { url, expiresOn: iso(expiry) };
  },
  [],
);
