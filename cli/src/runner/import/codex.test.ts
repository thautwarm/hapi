import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getCodexSessionImportPage, listCodexImportableSessions } from './codex'

let tmpRoot: string
let originalCodexHome: string | undefined

function eventLine(value: unknown): string {
    return `${JSON.stringify(value)}\n`
}

async function writeCodexTranscript(relativePath: string, events: unknown[]): Promise<void> {
    const filePath = join(tmpRoot, 'sessions', relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, events.map(eventLine).join(''))
}

describe('Codex runner import', () => {
    beforeEach(async () => {
        originalCodexHome = process.env.CODEX_HOME
        tmpRoot = await mkdtemp(join(tmpdir(), 'hapi-codex-import-'))
        process.env.CODEX_HOME = tmpRoot
    })

    afterEach(async () => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME
        } else {
            process.env.CODEX_HOME = originalCodexHome
        }
        await rm(tmpRoot, { recursive: true, force: true })
    })

    it('lists runner-global Codex sessions and ignores synthetic user messages', async () => {
        await writeCodexTranscript('2026/06/27/session-a.jsonl', [
            { type: 'session_meta', timestamp: '2026-06-27T00:00:00.000Z', payload: { id: 'codex-a', cwd: '/repo/app' } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nsecret prompt' }] } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello codex' }] } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } }
        ])
        await writeCodexTranscript('2026/06/27/session-b.jsonl', [
            { type: 'session_meta', timestamp: '2026-06-27T00:01:00.000Z', payload: { id: 'codex-b', cwd: '/private/app' } },
            { type: 'event_msg', timestamp: '2026-06-27T00:01:01.000Z', payload: { type: 'user_message', message: 'private question' } }
        ])

        const sessions = await listCodexImportableSessions()

        expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(['codex-a', 'codex-b']))
        const codexA = sessions.find((session) => session.id === 'codex-a')
        expect(codexA?.cwd).toBe('/repo/app')
        expect(codexA?.messageCount).toBe(2)
        expect(codexA?.lastUserMessage).toBe('hello codex')
        const codexB = sessions.find((session) => session.id === 'codex-b')
        expect(codexB?.messageCount).toBe(1)
        expect(codexB?.lastUserMessage).toBe('private question')
    })

    it('returns pages with opaque cursor and preserves repeated identical user text', async () => {
        await writeCodexTranscript('2026/06/27/session-a.jsonl', [
            { type: 'session_meta', timestamp: '2026-06-27T00:00:00.000Z', payload: { id: 'codex-a', cwd: '/repo/app' } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:02.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }
        ])

        const first = await getCodexSessionImportPage({ flavor: 'codex', sessionId: 'codex-a', limit: 1 })
        expect(first.messages).toHaveLength(1)
        expect(first.messages[0].message.content).toEqual({ type: 'text', text: 'continue' })
        expect(first.nextCursor).toBeTruthy()
        expect(first.done).toBe(false)

        const second = await getCodexSessionImportPage({ flavor: 'codex', sessionId: 'codex-a', cursor: first.nextCursor ?? undefined, limit: 10 })
        expect(second.messages.map((message) => message.message.role)).toEqual(['user', 'agent'])
        expect(second.messages[0].message.content).toEqual({ type: 'text', text: 'continue' })
        expect(new Set([first.messages[0].sourceKey, second.messages[0].sourceKey]).size).toBe(2)
        expect(second.done).toBe(true)
    })

    it('prefers Codex response_item chat records over mirrored event_msg records', async () => {
        await writeCodexTranscript('2026/06/27/session-dual.jsonl', [
            { type: 'session_meta', timestamp: '2026-06-27T00:00:00.000Z', payload: { id: 'codex-dual', cwd: '/repo/app' } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } },
            { type: 'event_msg', timestamp: '2026-06-27T00:00:01.000Z', payload: { type: 'user_message', message: 'hello' } },
            { type: 'event_msg', timestamp: '2026-06-27T00:00:02.000Z', payload: { type: 'agent_message', message: 'hi' } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:03.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] } },
            { type: 'event_msg', timestamp: '2026-06-27T00:00:03.000Z', payload: { type: 'user_message', message: 'continue' } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:04.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] } },
            { type: 'event_msg', timestamp: '2026-06-27T00:00:04.000Z', payload: { type: 'user_message', message: 'continue' } }
        ])

        const sessions = await listCodexImportableSessions()
        expect(sessions.find((session) => session.id === 'codex-dual')?.messageCount).toBe(4)

        const page = await getCodexSessionImportPage({ flavor: 'codex', sessionId: 'codex-dual', limit: 20 })

        expect(page.totalMessages).toBe(4)
        expect(page.messages.map((message) => message.message.role)).toEqual(['user', 'agent', 'user', 'user'])
        expect(page.messages.some((message) => message.sourceKey.includes(':event_msg:user_message'))).toBe(false)
        expect(page.messages.some((message) => message.sourceKey.includes(':event_msg:agent_message'))).toBe(false)
        expect(page.messages.filter((message) => message.message.role === 'user').map((message) => {
            const content = message.message.content as { text?: unknown }
            return content.text
        })).toEqual(['hello', 'continue', 'continue'])
        expect(page.done).toBe(true)
    })

    it('skips Codex subagent transcripts', async () => {
        await writeCodexTranscript('2026/06/27/subagent.jsonl', [
            { type: 'session_meta', timestamp: '2026-06-27T00:00:00.000Z', payload: { id: 'subagent', cwd: '/repo/app', source: { subagent: true } } },
            { type: 'response_item', timestamp: '2026-06-27T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hidden' }] } }
        ])

        const sessions = await listCodexImportableSessions()

        expect(sessions).toEqual([])
    })
})
