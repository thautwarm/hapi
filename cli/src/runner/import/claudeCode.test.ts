import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listClaudeCodeImportableSessions, getClaudeCodeSessionImportPage } from './claudeCode'

let tmpRoot: string
let originalClaudeConfigDir: string | undefined

function projectId(cwd: string): string {
    return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function eventLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

async function writeClaudeTranscript(cwd: string, sessionId: string, events: unknown[]): Promise<void> {
    const projectDir = join(tmpRoot, 'projects', projectId(cwd))
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, `${sessionId}.jsonl`), events.map(eventLine).join(''))
}

describe('Claude Code runner import', () => {
    beforeEach(async () => {
        originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
        tmpRoot = await mkdtemp(join(tmpdir(), 'hapi-claude-import-'))
        process.env.CLAUDE_CONFIG_DIR = tmpRoot
    })

    afterEach(async () => {
        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
        }
        await rm(tmpRoot, { recursive: true, force: true })
    })

    it('lists runner-global sessions and reports visible message count', async () => {
        await writeClaudeTranscript('/repo/app', 'repo-session', [
            { type: 'user', uuid: 'u1', sessionId: 'repo-session', cwd: '/repo/app', timestamp: '2026-06-27T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
            { type: 'user', uuid: 'u2', sessionId: 'repo-session', cwd: '/repo/app', timestamp: '2026-06-27T00:00:01.000Z', isMeta: true, message: { role: 'user', content: 'hidden' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'repo-session', cwd: '/repo/app', timestamp: '2026-06-27T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }
        ])
        await writeClaudeTranscript('/private/app', 'private-session', [
            { type: 'user', uuid: 'p1', sessionId: 'private-session', cwd: '/private/app', timestamp: '2026-06-27T00:00:00.000Z', message: { role: 'user', content: 'secret' } }
        ])

        const sessions = await listClaudeCodeImportableSessions()

        expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(['repo-session', 'private-session']))
        const repo = sessions.find((session) => session.id === 'repo-session')
        expect(repo?.messageCount).toBe(2)
        expect(repo?.byteSize).toBeGreaterThan(0)
    })

    it('returns message pages with opaque cursor and preserves repeated identical user text', async () => {
        await writeClaudeTranscript('/repo/app', 'session-1', [
            { type: 'user', uuid: 'u1', sessionId: 'session-1', cwd: '/repo/app', timestamp: '2026-06-27T00:00:00.000Z', message: { role: 'user', content: 'continue' } },
            { type: 'user', uuid: 'u2', sessionId: 'session-1', cwd: '/repo/app', timestamp: '2026-06-27T00:00:01.000Z', message: { role: 'user', content: 'continue' } },
            { type: 'assistant', uuid: 'a1', sessionId: 'session-1', cwd: '/repo/app', timestamp: '2026-06-27T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }
        ])

        const first = await getClaudeCodeSessionImportPage({ flavor: 'claude', sessionId: 'session-1', limit: 1 })
        expect(first.messages).toHaveLength(1)
        expect(first.messages[0].message.content).toEqual({ type: 'text', text: 'continue' })
        expect(first.done).toBe(false)
        expect(first.nextCursor).toBeTruthy()

        const second = await getClaudeCodeSessionImportPage({ flavor: 'claude', sessionId: 'session-1', cursor: first.nextCursor ?? undefined, limit: 10 })
        expect(second.messages.map((message) => message.message.role)).toEqual(['user', 'agent'])
        expect(second.messages[0].message.content).toEqual({ type: 'text', text: 'continue' })
        expect(new Set([first.messages[0].sourceKey, second.messages[0].sourceKey]).size).toBe(2)
        expect(second.done).toBe(true)
    })

    it('imports requested sessions regardless of cwd', async () => {
        await writeClaudeTranscript('/private/app', 'private-session', [
            { type: 'user', uuid: 'p1', sessionId: 'private-session', cwd: '/private/app', timestamp: '2026-06-27T00:00:00.000Z', message: { role: 'user', content: 'secret' } }
        ])

        const page = await getClaudeCodeSessionImportPage({ flavor: 'claude', sessionId: 'private-session', limit: 100 })

        expect(page.id).toBe('private-session')
        expect(page.cwd).toBe('/private/app')
        expect(page.messages).toHaveLength(1)
    })
})
