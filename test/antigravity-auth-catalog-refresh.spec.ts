import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { saveAccountSession } from '../src/auth/store.js'
import { catalogStore, accountCatalogStore } from '../src/providers/catalog-store.js'
import { AntigravityAdapter } from '../src/providers/antigravity.js'
import { createFakeConnection } from './fake-connection.js'
import * as plugin from '../src/index.js'

test('Google account changes eagerly rebuild every account catalog without a manual refresh', async t => {
  const home = await mkdtemp(join(tmpdir(), 'google-login-catalog-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const reads: string[] = []
  let generation = 0
  let waitForAbort = false
  const activeSignals: AbortSignal[] = []
  const prototype = AntigravityAdapter.prototype as unknown as {
    fetchCatalog: (account?: string, signal?: AbortSignal) => Promise<unknown[]>
  }
  t.mock.method(prototype, 'fetchCatalog', async (account?: string, signal?: AbortSignal) => {
    reads.push(account!)
    if (waitForAbort) {
      activeSignals.push(signal!)
      return new Promise<unknown[]>((_resolve, reject) => {
        if (signal!.aborted) reject(signal!.reason)
        else signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    }
    return [{ id: account === 'pro' ? `gemini-4-argon-high-${generation}` : 'gemini-4-argon-disabled', name: account }]
  })
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const connection = createFakeConnection()
  ctx.provide('connection', connection.connection)
  let runtime: ReturnType<Context['plugin']> | undefined
  const ua = 'antigravity/hub/2.25.0 (aidev_client; os_type=darwin; arch=arm64; cl=1003475615)'
  const waitFor = async (ready: () => boolean): Promise<void> => {
    const deadline = performance.now() + 5000
    while (!ready() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(ready(), 'background catalog operation completed within five seconds')
  }
  try {
    const expiresAt = Date.now() + 86_400_000
    for (const account of ['pro', 'free']) {
      await saveAccountSession('antigravity', account, {
        accessToken: account, refreshToken: account, expiresAt, projectId: account, account,
      })
    }
    await catalogStore('antigravity').save({ at: Date.now(), models: [{ id: 'stale-default', name: 'Old default' }] })
    await accountCatalogStore('antigravity', 'free').save({ at: Date.now(), models: [{ id: 'stale-free', name: 'Old Free' }] })
    runtime = ctx.plugin(plugin, { providers: ['antigravity'], antigravity: { userAgent: ua }, pool: { enabled: false } })
    await waitFor(() => connection.registered())
    assert.ok(connection.registered())
    await llm.listModels('antigravity')
    reads.length = 0
    const call = () => connection.handler('setDefault', { provider: 'antigravity', account: 'free' }, new AbortController().signal)
    const changed = await call()
    assert.equal(changed.ok, true, JSON.stringify(changed))
    await waitFor(() => reads.length >= 2)
    assert.deepEqual([...reads].sort(), ['free', 'pro'], 'account change refreshes both accounts without a menu or manual refresh')
    assert.deepEqual((await llm.listModels('antigravity')).map(m => m.id).sort(), [
      'gemini-4-argon-disabled', 'gemini-4-argon-high-0',
    ])
    generation++
    reads.length = 0
    await saveAccountSession('antigravity', 'pro', {
      accessToken: 'pro-new', refreshToken: 'pro-new', expiresAt, projectId: 'pro', account: 'pro',
    })
    assert.equal((await connection.handler('setDefault', { provider: 'antigravity', account: 'pro' }, new AbortController().signal)).ok, true)
    await waitFor(() => reads.length >= 2)
    assert.deepEqual([...reads].sort(), ['free', 'pro'])
    assert.deepEqual((await llm.listModels('antigravity')).map(m => m.id).sort(), [
      'gemini-4-argon-disabled', 'gemini-4-argon-high-1',
    ])
    waitForAbort = true
    assert.equal((await call()).ok, true)
    await waitFor(() => activeSignals.length >= 2)
    assert.equal(activeSignals.length, 2)
    await runtime.dispose()
    assert.ok(activeSignals.every(signal => signal.aborted), 'unloading the plugin cancels its pending login refreshes')
  } finally {
    await runtime?.dispose()
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous
    assert.ok(home.startsWith(join(tmpdir(), 'google-login-catalog-')))
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
