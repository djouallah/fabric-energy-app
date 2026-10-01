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
 * SAS tokens with the narrowest scope that works: read-only on the data/ folder (latest.txt + the
 * .duckdb files), create/write on one query-log CSV. Long-ish lifetime so browsers can cache them
 * and call these functions about once an hour, not per request.
 *
 * ONELAKE_FILES_URL (rayfin secret): https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Files
 * The data workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 */

type StorageCtx = RayfinContext<BlankAppSchema, AudienceType.Storage>;

const SAS_VERSION = '2022-11-02';
const SAS_LIFETIME_MS = 55 * 60 * 1000;   // OneLake caps SAS and delegation keys at 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Query-log files the dashboard writes (see site/app.js): session_<id>.csv / query_log_<stamp>.csv
const LOG_NAME = /^(session|query_log)_[\w.-]{1,96}\.csv$/;

interface DelegationKey {
  oid: string; tid: string; start: string; expiry: string; service: string; version: string; value: string;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function filesBase(ctx: StorageCtx): URL {
  return new URL(ctx.Secrets.ONELAKE_FILES_URL.replace(/\/+$/, ''));
}

// Window for both the delegation key and the SAS: now-skew .. +55 min, never past the
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

// User-delegation SAS query string for one file (sr=b) or one folder (sr=d) under the Files base.
function signSas(base: URL, relPath: string, resource: 'b' | 'd', permissions: string, key: DelegationKey, start: Date, expiry: Date): string {
  const blobPath = decodeURIComponent(`${base.pathname}/${relPath}`);
  const st = iso(start);
  const se = iso(expiry);
  const stringToSign = [
    permissions, st, se, `/blob/onelake${blobPath}`,
    key.oid, key.tid, key.start, key.expiry, key.service, key.version,
    '', '', '', '',          // saoid, suoid, scid, sip (unsupported by OneLake)
    'https', SAS_VERSION, resource,
    '', '',                  // snapshot time, encryption scope
    '', '', '', '', '',      // rscc, rscd, rsce, rscl, rsct
  ].join('\n');
  const sig = createHmac('sha256', Buffer.from(key.value, 'base64')).update(stringToSign, 'utf8').digest('base64');
  const query = new URLSearchParams({
    sp: permissions, st, se, skoid: key.oid, sktid: key.tid, skt: key.start, ske: key.expiry,
    sks: key.service, skv: key.version, spr: 'https', sv: SAS_VERSION, sr: resource,
    // Folder SAS: depth = folders below the workspace (container), e.g. <lh>.Lakehouse/Files/data -> 3
    ...(resource === 'd' ? { sdd: String(blobPath.split('/').filter(Boolean).length - 1) } : {}),
    sig,
  });
  return query.toString();
}

/** Read-only SAS for the data/ folder: the browser reads data/latest.txt and the .duckdb with it. */
udf.func(
  'getDataSas',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>): Promise<{ baseUrl: string; sas: string; expiresOn: string }> => {
    const token = ctx.Tokens.Storage;
    const base = filesBase(ctx);
    const { start, expiry } = sasWindow(token);
    const key = await getDelegationKey(base, token, start, expiry);
    return { baseUrl: `${base}/data`, sas: signSas(base, 'data', 'd', 'r', key, start, expiry), expiresOn: iso(expiry) };
  },
  [],
);

/** Create/overwrite SAS URL (Blob endpoint) for one query-log CSV under query_logs/data/. */
udf.func(
  'getLogUploadUrl',
  async (name: string, ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>): Promise<{ url: string; expiresOn: string }> => {
    if (!LOG_NAME.test(name)) throw new Error('invalid query-log file name');
    const token = ctx.Tokens.Storage;
    const base = filesBase(ctx);
    const { start, expiry } = sasWindow(token);
    const key = await getDelegationKey(base, token, start, expiry);
    const sas = signSas(base, `query_logs/data/${name}`, 'b', 'cw', key, start, expiry);
    // Single PUT needs the Blob host.
    const url = `${base.origin.replace('.dfs.', '.blob.')}${base.pathname}/query_logs/data/${name}?${sas}`;
    return { url, expiresOn: iso(expiry) };
  },
  [],
);
