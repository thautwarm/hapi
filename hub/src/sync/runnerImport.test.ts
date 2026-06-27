import { describe, expect, it } from 'bun:test'
import type { RunnerImportedSessionPage, RunnerImportSessionPageRequest, RunnerImportSessionPageResponse } from '@hapi/protocol/apiTypes'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function makeEngine(): { store: Store; engine: SyncEngine } {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        { of: () => ({ to: () => ({ emit() {} }) }) } as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    return { store, engine }
}

function page(options: {
    sessionId: string
    messages: RunnerImportedSessionPage['messages']
    flavor?: RunnerImportedSessionPage['flavor']
    done?: boolean
    nextCursor?: string | null
}): RunnerImportedSessionPage {
    return {
        id: options.sessionId,
        flavor: options.flavor ?? 'claude',
        title: `Imported ${options.flavor ?? 'claude'} session`,
        cwd: '/repo',
        lastUserMessage: 'continue',
        modifiedAt: 1_780_000_000_000,
        messageCount: options.messages.length,
        byteSize: 1234,
        totalMessages: options.messages.length,
        messages: options.messages,
        nextCursor: options.nextCursor ?? null,
        done: options.done ?? true
    }
}

function userMessage(sourceKey: string, text: string, createdAt = 1_780_000_000_000): RunnerImportedSessionPage['messages'][number] {
    return {
        sourceKey,
        createdAt,
        message: {
            role: 'user',
            content: { type: 'text', text },
            meta: { sentFrom: 'cli', importSourceKey: sourceKey }
        }
    }
}

describe('runner session import', () => {
    it('pulls import pages from runner and preserves repeated identical user text with distinct source keys', async () => {
        const { store, engine } = makeEngine()
        try {
            engine.getOrCreateMachine('machine-1', { host: 'runner', platform: 'linux', happyCliVersion: 'test' }, null, 'default')

            const calls: RunnerImportSessionPageRequest[] = []
            ;(engine as unknown as { rpcGateway: { getImportableAgentSessionPage: (machineId: string, request: RunnerImportSessionPageRequest) => Promise<RunnerImportSessionPageResponse> } }).rpcGateway.getImportableAgentSessionPage = async (_machineId, request) => {
                calls.push(request)
                if (!request.cursor) {
                    return { success: true, page: page({ sessionId: request.sessionId, messages: [userMessage('k1', 'continue')], done: false, nextCursor: 'c2' }) }
                }
                return { success: true, page: page({ sessionId: request.sessionId, messages: [userMessage('k2', 'continue', 1_780_000_000_100)], done: true }) }
            }

            const result = await engine.importRunnerAgentSessions('machine-1', 'default', {
                flavor: 'claude',
                sessionIds: ['claude-session-1'],
                pageSize: 1
            })

            expect(result.success).toBe(true)
            if (!result.success) return
            expect(calls.map((call) => call.cursor ?? null)).toEqual([null, 'c2'])
            expect(result.results[0].appendedMessages).toBe(2)

            const imported = engine.getSessionsByNamespace('default').find((session) => session.metadata?.claudeSessionId === 'claude-session-1')
            expect(imported).toBeDefined()
            if (!imported) return
            const messages = store.messages.getAllMessages(imported.id)
            expect(messages).toHaveLength(2)
            expect(messages.map((message) => (message.content as { content: { text: string } }).content.text)).toEqual(['continue', 'continue'])
        } finally {
            engine.stop()
        }
    })

    it('skips duplicate source keys on re-import but not same text with new source key', async () => {
        const { store, engine } = makeEngine()
        try {
            engine.getOrCreateMachine('machine-1', { host: 'runner', platform: 'linux', happyCliVersion: 'test' }, null, 'default')
            ;(engine as unknown as { rpcGateway: { getImportableAgentSessionPage: () => Promise<RunnerImportSessionPageResponse> } }).rpcGateway.getImportableAgentSessionPage = async () => ({
                success: true,
                page: page({
                    sessionId: 'claude-session-1',
                    messages: [
                        userMessage('k1', 'continue'),
                        userMessage('k2', 'continue', 1_780_000_000_100)
                    ],
                    done: true
                })
            })

            await engine.importRunnerAgentSessions('machine-1', 'default', { flavor: 'claude', sessionIds: ['claude-session-1'], pageSize: 100 })
            const second = await engine.importRunnerAgentSessions('machine-1', 'default', { flavor: 'claude', sessionIds: ['claude-session-1'], pageSize: 100 })

            expect(second.success).toBe(true)
            if (!second.success) return
            expect(second.results[0].appendedMessages).toBe(0)
            expect(second.results[0].skippedMessages).toBe(2)

            const imported = engine.getSessionsByNamespace('default').find((session) => session.metadata?.claudeSessionId === 'claude-session-1')
            expect(imported).toBeDefined()
            if (!imported) return
            expect(store.messages.getAllMessages(imported.id)).toHaveLength(2)
        } finally {
            engine.stop()
        }
    })

    it('rejects import when any matching same-origin Hapi session is active, even with an inactive duplicate', async () => {
        const { store, engine } = makeEngine()
        try {
            engine.getOrCreateMachine('machine-1', { host: 'runner', platform: 'linux', happyCliVersion: 'test' }, null, 'default')
            const active = engine.getOrCreateSession('active-claude', { path: '/repo', host: 'runner', flavor: 'claude', claudeSessionId: 'claude-session-1' }, null, 'default')
            engine.handleSessionAlive({ sid: active.id, time: Date.now(), thinking: false })
            const inactive = engine.getOrCreateSession('inactive-claude', { path: '/repo', host: 'runner', flavor: 'claude', claudeSessionId: 'claude-session-1' }, null, 'default')

            ;(engine as unknown as { rpcGateway: { getImportableAgentSessionPage: () => Promise<RunnerImportSessionPageResponse> } }).rpcGateway.getImportableAgentSessionPage = async () => ({
                success: true,
                page: page({ sessionId: 'claude-session-1', messages: [userMessage('k1', 'hello')], done: true })
            })

            const result = await engine.importRunnerAgentSessions('machine-1', 'default', { flavor: 'claude', sessionIds: ['claude-session-1'], pageSize: 100 })

            expect(result.success).toBe(true)
            if (!result.success) return
            expect(result.results[0].error ?? '').toContain('active')
            expect(store.messages.getAllMessages(active.id)).toHaveLength(0)
            expect(store.messages.getAllMessages(inactive.id)).toHaveLength(0)
        } finally {
            engine.stop()
        }
    })



    it('stores Codex runner imports with codexSessionId metadata', async () => {
        const { store, engine } = makeEngine()
        try {
            engine.getOrCreateMachine('machine-1', { host: 'runner', platform: 'linux', happyCliVersion: 'test' }, null, 'default')
            ;(engine as unknown as { rpcGateway: { getImportableAgentSessionPage: () => Promise<RunnerImportSessionPageResponse> } }).rpcGateway.getImportableAgentSessionPage = async () => ({
                success: true,
                page: page({
                    sessionId: 'codex-session-1',
                    flavor: 'codex',
                    messages: [userMessage('ck1', 'hello codex')],
                    done: true
                })
            })

            const result = await engine.importRunnerAgentSessions('machine-1', 'default', { flavor: 'codex', sessionIds: ['codex-session-1'], pageSize: 100 })

            expect(result.success).toBe(true)
            if (!result.success) return
            expect(result.results[0].appendedMessages).toBe(1)
            const imported = engine.getSessionsByNamespace('default').find((session) => session.metadata?.codexSessionId === 'codex-session-1')
            expect(imported).toBeDefined()
            if (!imported) return
            expect(imported.metadata?.flavor).toBe('codex')
            expect(imported.metadata?.claudeSessionId).toBeUndefined()
            expect(store.messages.getAllMessages(imported.id)).toHaveLength(1)
        } finally {
            engine.stop()
        }
    })



    it('stores OpenCode runner imports with opencodeSessionId metadata', async () => {
        const { store, engine } = makeEngine()
        try {
            engine.getOrCreateMachine('machine-1', { host: 'runner', platform: 'linux', happyCliVersion: 'test' }, null, 'default')
            ;(engine as unknown as { rpcGateway: { getImportableAgentSessionPage: () => Promise<RunnerImportSessionPageResponse> } }).rpcGateway.getImportableAgentSessionPage = async () => ({
                success: true,
                page: page({
                    sessionId: 'opencode-session-1',
                    flavor: 'opencode',
                    messages: [userMessage('ok1', 'hello opencode')],
                    done: true
                })
            })

            const result = await engine.importRunnerAgentSessions('machine-1', 'default', { flavor: 'opencode', sessionIds: ['opencode-session-1'], pageSize: 100 })

            expect(result.success).toBe(true)
            if (!result.success) return
            expect(result.results[0].appendedMessages).toBe(1)
            const imported = engine.getSessionsByNamespace('default').find((session) => session.metadata?.opencodeSessionId === 'opencode-session-1')
            expect(imported).toBeDefined()
            if (!imported) return
            expect(imported.metadata?.flavor).toBe('opencode')
            expect(imported.metadata?.claudeSessionId).toBeUndefined()
            expect(imported.metadata?.codexSessionId).toBeUndefined()
            expect(store.messages.getAllMessages(imported.id)).toHaveLength(1)
        } finally {
            engine.stop()
        }
    })

    it('returns a per-session error when runner cannot provide a requested page', async () => {
        const { engine } = makeEngine()
        try {
            engine.getOrCreateMachine('machine-1', { host: 'runner', platform: 'linux', happyCliVersion: 'test' }, null, 'default')
            ;(engine as unknown as { rpcGateway: { getImportableAgentSessionPage: () => Promise<RunnerImportSessionPageResponse> } }).rpcGateway.getImportableAgentSessionPage = async () => ({
                success: false,
                error: 'Claude Code session not found on runner'
            })

            const result = await engine.importRunnerAgentSessions('machine-1', 'default', { flavor: 'claude', sessionIds: ['missing'], pageSize: 100 })

            expect(result.success).toBe(true)
            if (!result.success) return
            expect(result.importedCount).toBe(0)
            expect(result.results).toEqual([{ agentSessionId: 'missing', error: 'Claude Code session not found on runner' }])
        } finally {
            engine.stop()
        }
    })
})
