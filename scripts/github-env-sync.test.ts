import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper, no types
import * as lib from './github-env-sync.lib.mjs';

describe('github-env-sync', () => {
  it('classifies secrets vs variables', () => {
    expect(lib.classifyKey('JWT_SECRET', 'dev')).toEqual({ kind: 'secret', name: 'JWT_SECRET', shared: false });
    expect(lib.classifyKey('CORS_ORIGINS', 'dev')).toEqual({ kind: 'variable', name: 'CORS_ORIGINS', shared: false });
    expect(lib.classifyKey('NOPE', 'dev')).toBeNull();
  });

  it('appends _PROD for prod stage keys only', () => {
    expect(lib.classifyKey('DATABASE_URL', 'prod').name).toBe('DATABASE_URL_PROD');
    expect(lib.classifyKey('APP_URL', 'prod').name).toBe('APP_URL_PROD');
    expect(lib.classifyKey('APP_URL_PROD', 'prod').name).toBe('APP_URL_PROD');
    expect(lib.classifyKey('APP_URL', 'dev').name).toBe('APP_URL');
  });

  it('keeps shared (VAPID) names un-suffixed in prod', () => {
    expect(lib.classifyKey('VAPID_PRIVATE_KEY', 'prod')).toEqual({ kind: 'secret', name: 'VAPID_PRIVATE_KEY', shared: true });
    expect(lib.classifyKey('VAPID_PUBLIC_KEY', 'prod').name).toBe('VAPID_PUBLIC_KEY');
  });

  it('parses dotenv and dry-run lines never contain values', () => {
    const env = lib.parseDotenv('# c\nJWT_SECRET="s3cr3t-value"\nAPP_URL=https://x.test # note\nALERT_EMAIL=   # comment only\nFOO=1\n');
    expect(env.APP_URL).toBe('https://x.test');
    const { plan, unknown } = lib.buildPlan(env, 'prod');
    expect(unknown).toEqual(['FOO']);
    const lines = plan.map(lib.formatPlanLine).join('\n');
    expect(lines).not.toContain('s3cr3t-value');
    expect(lines).not.toContain('https://x.test');
    expect(lines).toContain('JWT_SECRET_PROD');
    expect(lines).toContain('ALERT_EMAIL_PROD  empty');
  });

  it('derives owner/name from git remotes', () => {
    expect(lib.repoFromRemote('https://github.com/sale-shubham/bids-api.git\n')).toBe('sale-shubham/bids-api');
    expect(lib.repoFromRemote('git@github.com:a/b.git')).toBe('a/b');
  });
});
