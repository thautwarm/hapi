import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getOpencodeSessionImportPage, listOpencodeImportableSessions } from './opencode'

let tmpRoot: string
let originalXdgDataHome: string | undefined

async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(value))
}

async function writeFileStorageSession(sessionId: string, cwd: string): Promise<void> {
    const storage = join(tmpRoot, 'opencode', 'storage')
    await writeJson(join(storage, 'session', 'default', `${sessionId}.json`), {
        id: sessionId,
        directory: cwd,
        time: { created: 1_780_000_000_000, updated: 1_780_000_000_300 }
    })
    await writeJson(join(storage, 'message', sessionId, 'm1.json'), {
        id: 'm1',
        sessionID: sessionId,
        role: 'user',
        time: { created: 1_780_000_000_000 }
    })
    await writeJson(join(storage, 'part', 'm1', 'p1.json'), {
        id: 'p1',
        type: 'text',
        messageID: 'm1',
        sessionID: sessionId,
        text: 'continue',
        time: { created: 1_780_000_000_000 }
    })
    await writeJson(join(storage, 'message', sessionId, 'm2.json'), {
        id: 'm2',
        sessionID: sessionId,
        role: 'user',
        time: { created: 1_780_000_000_100 }
    })
    await writeJson(join(storage, 'part', 'm2', 'p2.json'), {
        id: 'p2',
        type: 'text',
        messageID: 'm2',
        sessionID: sessionId,
        text: 'continue',
        time: { created: 1_780_000_000_100 }
    })
    await writeJson(join(storage, 'message', sessionId, 'm3.json'), {
        id: 'm3',
        sessionID: sessionId,
        role: 'assistant',
        time: { created: 1_780_000_000_200 }
    })
    await writeJson(join(storage, 'part', 'm3', 'p3.json'), {
        id: 'p3',
        type: 'text',
        messageID: 'm3',
        sessionID: sessionId,
        text: 'done',
        time: { created: 1_780_000_000_200 }
    })
}

async function writeToolFileStorageSession(sessionId: string, cwd: string): Promise<void> {
    const storage = join(tmpRoot, 'opencode', 'storage')
    await writeJson(join(storage, 'session', 'default', `${sessionId}.json`), {
        id: sessionId,
        directory: cwd,
        time: { created: 1_780_000_000_000, updated: 1_780_000_000_100 }
    })
    await writeJson(join(storage, 'message', sessionId, 'm1.json'), {
        id: 'm1',
        sessionID: sessionId,
        role: 'assistant',
        time: { created: 1_780_000_000_000 }
    })
    await writeJson(join(storage, 'part', 'm1', 'p1.json'), {
        id: 'p1',
        type: 'tool',
        messageID: 'm1',
        sessionID: sessionId,
        tool: 'bash',
        callID: 'call-1',
        state: {
            status: 'completed',
            input: { command: 'echo hi' },
            output: 'hi'
        },
        time: { created: 1_780_000_000_000 }
    })
}

describe('OpenCode runner import', () => {
    beforeEach(async () => {
        originalXdgDataHome = process.env.XDG_DATA_HOME
        tmpRoot = await mkdtemp(join(tmpdir(), 'hapi-opencode-import-'))
        process.env.XDG_DATA_HOME = tmpRoot
    })

    afterEach(async () => {
        if (originalXdgDataHome === undefined) {
            delete process.env.XDG_DATA_HOME
        } else {
            process.env.XDG_DATA_HOME = originalXdgDataHome
        }
        await rm(tmpRoot, { recursive: true, force: true })
    })

    it('lists runner-global OpenCode file-storage sessions', async () => {
        await writeFileStorageSession('opencode-a', '/repo/app')

        const sessions = await listOpencodeImportableSessions()

        expect(sessions).toHaveLength(1)
        expect(sessions[0]).toMatchObject({
            id: 'opencode-a',
            flavor: 'opencode',
            cwd: '/repo/app',
            messageCount: 3,
            lastUserMessage: 'continue'
        })
    })

    it('returns pages with opaque cursor and preserves repeated identical user text', async () => {
        await writeFileStorageSession('opencode-a', '/repo/app')

        const first = await getOpencodeSessionImportPage({ flavor: 'opencode', sessionId: 'opencode-a', limit: 1 })
        expect(first.messages).toHaveLength(1)
        expect(first.messages[0].message.content).toEqual({ type: 'text', text: 'continue' })
        expect(first.done).toBe(false)
        expect(first.nextCursor).toBeTruthy()

        const second = await getOpencodeSessionImportPage({ flavor: 'opencode', sessionId: 'opencode-a', cursor: first.nextCursor ?? undefined, limit: 10 })
        expect(second.messages.map((message) => message.message.role)).toEqual(['user', 'agent'])
        expect(second.messages[0].message.content).toEqual({ type: 'text', text: 'continue' })
        expect(new Set([first.messages[0].sourceKey, second.messages[0].sourceKey]).size).toBe(2)
        expect(second.done).toBe(true)
    })

    it('splits multi-message OpenCode parts across pages without duplicating them', async () => {
        await writeToolFileStorageSession('opencode-tool', '/repo/app')

        const first = await getOpencodeSessionImportPage({ flavor: 'opencode', sessionId: 'opencode-tool', limit: 1 })
        expect(first.messages).toHaveLength(1)
        expect((first.messages[0].message.content as { data?: { type?: string } }).data?.type).toBe('tool-call')
        expect(first.done).toBe(false)
        expect(first.nextCursor).toBeTruthy()

        const second = await getOpencodeSessionImportPage({ flavor: 'opencode', sessionId: 'opencode-tool', cursor: first.nextCursor ?? undefined, limit: 1 })
        expect(second.messages).toHaveLength(1)
        expect((second.messages[0].message.content as { data?: { type?: string } }).data?.type).toBe('tool-call-result')
        expect(second.done).toBe(true)
    })
})
