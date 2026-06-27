import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { isClaudeChatVisibleMessage } from '@hapi/protocol/messages'
import type {
    RunnerImportableSessionSummary,
    RunnerImportedSessionMessage,
    RunnerImportedSessionPage,
    RunnerImportSessionPageRequest
} from '@hapi/protocol'

import { RawJSONLinesSchema, type RawJSONLines } from '@/claude/types'
import { logger } from '@/ui/logger'

const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation'
])

const SYSTEM_INJECTION_PREFIXES = [
    '<task-notification>',
    '<command-name>',
    '<local-command-caveat>',
    '<system-reminder>'
]

const DEFAULT_MAX_LISTED_SESSIONS = 500
const DEFAULT_PAGE_LIMIT = 100
const JSONL_READ_CHUNK_SIZE = 64 * 1024

type ClaudeCodeImportOptions = {
    maxFiles?: number
}

type ClaudeSessionFile = {
    filePath: string
    projectName: string
    fileName: string
    sessionId: string
    modifiedAt: number
    byteSize: number
}

type SummaryWithFile = {
    file: ClaudeSessionFile
    summary: RunnerImportableSessionSummary
}

type JsonlLine = {
    text: string
    startOffset: number
    nextOffset: number
}

type ClaudeImportCursor = {
    v: 1
    sessionId: string
    projectName: string
    fileName: string
    nextOffset: number
    totalMessages: number
    title: string
    cwd: string | null
    lastUserMessage: string | null
    modifiedAt: number
    byteSize: number
}

function claudeProjectsDir(): string {
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    return join(claudeConfigDir, 'projects')
}

function claudeProjectId(workingDirectory: string): string {
    return resolve(workingDirectory).replace(/[^a-zA-Z0-9]/g, '-')
}

function isSafePathName(value: string): boolean {
    return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\')
}

function encodeCursor(cursor: ClaudeImportCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
}

function decodeCursor(value: string): ClaudeImportCursor | null {
    try {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=')
        const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Partial<ClaudeImportCursor>
        if (parsed.v !== 1) return null
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
        if (typeof parsed.projectName !== 'string' || !isSafePathName(parsed.projectName)) return null
        if (typeof parsed.fileName !== 'string' || !isSafePathName(parsed.fileName) || !parsed.fileName.endsWith('.jsonl')) return null
        const nextOffset = parsed.nextOffset
        const totalMessages = parsed.totalMessages
        const modifiedAt = parsed.modifiedAt
        const byteSize = parsed.byteSize
        if (typeof nextOffset !== 'number' || !Number.isInteger(nextOffset) || nextOffset < 0) return null
        if (typeof totalMessages !== 'number' || !Number.isInteger(totalMessages) || totalMessages < 0) return null
        if (typeof parsed.title !== 'string' || !parsed.title) return null
        if (parsed.cwd !== null && typeof parsed.cwd !== 'string') return null
        if (parsed.lastUserMessage !== null && typeof parsed.lastUserMessage !== 'string') return null
        if (typeof modifiedAt !== 'number' || !Number.isInteger(modifiedAt) || modifiedAt < 0) return null
        if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize < 0) return null
        return {
            v: 1,
            sessionId: parsed.sessionId,
            projectName: parsed.projectName,
            fileName: parsed.fileName,
            nextOffset,
            totalMessages,
            title: parsed.title,
            cwd: parsed.cwd ?? null,
            lastUserMessage: parsed.lastUserMessage ?? null,
            modifiedAt,
            byteSize
        }
    } catch {
        return null
    }
}

function cursorFromSummary(file: ClaudeSessionFile, summary: RunnerImportableSessionSummary, nextOffset: number): string {
    return encodeCursor({
        v: 1,
        sessionId: summary.id,
        projectName: file.projectName,
        fileName: file.fileName,
        nextOffset,
        totalMessages: summary.messageCount ?? 0,
        title: summary.title,
        cwd: summary.cwd ?? null,
        lastUserMessage: summary.lastUserMessage ?? null,
        modifiedAt: summary.modifiedAt,
        byteSize: summary.byteSize ?? file.byteSize
    })
}

async function* readJsonlLines(filePath: string, startOffset = 0): AsyncGenerator<JsonlLine> {
    const handle = await open(filePath, 'r')
    try {
        let nextReadOffset = startOffset
        let pending = Buffer.alloc(0)
        let pendingStartOffset = startOffset
        const buffer = Buffer.alloc(JSONL_READ_CHUNK_SIZE)

        while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, nextReadOffset)
            if (bytesRead === 0) break

            const chunk = Buffer.concat([pending, buffer.subarray(0, bytesRead)])
            const chunkStartOffset = pendingStartOffset
            nextReadOffset += bytesRead

            let lineStartIndex = 0
            for (let index = 0; index < chunk.length; index += 1) {
                if (chunk[index] !== 0x0A) continue
                const lineBuffer = chunk.subarray(lineStartIndex, index)
                const start = chunkStartOffset + lineStartIndex
                const next = chunkStartOffset + index + 1
                const text = lineBuffer.toString('utf8').trim()
                if (text) yield { text, startOffset: start, nextOffset: next }
                lineStartIndex = index + 1
            }

            pending = chunk.subarray(lineStartIndex)
            pendingStartOffset = chunkStartOffset + lineStartIndex
        }

        if (pending.length > 0) {
            const text = pending.toString('utf8').trim()
            if (text) {
                yield {
                    text,
                    startOffset: pendingStartOffset,
                    nextOffset: pendingStartOffset + pending.length
                }
            }
        }
    } finally {
        await handle.close()
    }
}

async function collectClaudeSessionFiles(): Promise<ClaudeSessionFile[]> {
    const root = claudeProjectsDir()
    let projects: Array<{ name: string; isDirectory(): boolean }>
    try {
        projects = await readdir(root, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Claude projects directory not readable', { root, error })
        return []
    }

    const files: ClaudeSessionFile[] = []
    await Promise.all(projects.map(async (project) => {
        if (!project.isDirectory()) return
        if (!isSafePathName(project.name)) return
        const projectDir = join(root, project.name)
        let entries: Array<{ name: string; isFile(): boolean }>
        try {
            entries = await readdir(projectDir, { withFileTypes: true }) as Array<{ name: string; isFile(): boolean }>
        } catch {
            return
        }

        await Promise.all(entries.map(async (entry) => {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !isSafePathName(entry.name)) return
            const filePath = join(projectDir, entry.name)
            try {
                const s = await stat(filePath)
                files.push({
                    filePath,
                    projectName: project.name,
                    fileName: entry.name,
                    sessionId: entry.name.slice(0, -'.jsonl'.length),
                    modifiedAt: Math.max(0, Math.floor(s.mtimeMs)),
                    byteSize: Math.max(0, Math.floor(s.size))
                })
            } catch {
                // Ignore files that disappear while scanning.
            }
        }))
    }))

    return files.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

async function fileFromCursor(cursor: ClaudeImportCursor): Promise<ClaudeSessionFile | null> {
    const filePath = join(claudeProjectsDir(), cursor.projectName, cursor.fileName)
    try {
        const s = await stat(filePath)
        if (!s.isFile()) return null
        return {
            filePath,
            projectName: cursor.projectName,
            fileName: cursor.fileName,
            sessionId: cursor.fileName.slice(0, -'.jsonl'.length),
            modifiedAt: Math.max(0, Math.floor(s.mtimeMs)),
            byteSize: Math.max(0, Math.floor(s.size))
        }
    } catch {
        return null
    }
}

function parseClaudeEvent(line: string): RawJSONLines | null {
    try {
        const raw = JSON.parse(line) as Record<string, unknown>
        if (typeof raw.type === 'string' && INTERNAL_CLAUDE_EVENT_TYPES.has(raw.type)) return null
        const parsed = RawJSONLinesSchema.safeParse(raw)
        return parsed.success ? parsed.data : null
    } catch {
        // Claude Code can leave partial trailing lines during writes; skip them.
        return null
    }
}

function extractRawUserTextContent(content: unknown): string | null {
    if (typeof content === 'string') {
        return content
    }

    if (!Array.isArray(content)) {
        return null
    }

    const parts = content
        .map((block) => {
            if (!block || typeof block !== 'object' || Array.isArray(block)) return null
            const record = block as Record<string, unknown>
            return record.type === 'text' && typeof record.text === 'string'
                ? record.text
                : null
        })
        .filter((text): text is string => text !== null)

    return parts.length > 0 ? parts.join('\n') : null
}

function isExternalUserMessage(body: RawJSONLines): body is Extract<RawJSONLines, { type: 'user' }> {
    if (body.type !== 'user') return false
    const text = extractRawUserTextContent(body.message.content)
    if (text === null) return false
    if (body.isSidechain === true) return false
    if (body.isMeta === true) return false

    const trimmed = text.trimStart()
    for (const prefix of SYSTEM_INJECTION_PREFIXES) {
        if (trimmed.startsWith(prefix)) return false
    }
    return true
}

function eventTimestampMs(event: RawJSONLines, fallback: number): number {
    if (typeof event.timestamp === 'string') {
        const parsed = Date.parse(event.timestamp)
        if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
    }
    return fallback
}

function hashForKey(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function eventSourceKey(sessionId: string, event: RawJSONLines, lineOffset: number): string {
    if (event.type === 'summary') {
        return `claude:${sessionId}:summary:${event.leafUuid}:${hashForKey(event.summary)}`
    }

    return `claude:${sessionId}:${event.type}:${event.uuid ?? `offset-${lineOffset}`}`
}

function convertEventToImportedMessage(
    event: RawJSONLines,
    sessionId: string,
    fallbackCreatedAt: number,
    lineOffset: number
): RunnerImportedSessionMessage | null {
    if (event.type === 'summary') return null
    if (event.isMeta === true) return null
    if (event.isCompactSummary === true) return null
    if (!isClaudeChatVisibleMessage({ type: event.type, subtype: event.type === 'system' ? event.subtype : undefined })) {
        return null
    }

    const sourceKey = eventSourceKey(sessionId, event, lineOffset)
    const createdAt = eventTimestampMs(event, fallbackCreatedAt)
    if (isExternalUserMessage(event)) {
        const text = extractRawUserTextContent(event.message.content)
        if (!text || !text.trim()) return null
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

    return {
        sourceKey,
        createdAt,
        message: {
            role: 'agent',
            content: { type: 'output', data: event },
            meta: { sentFrom: 'cli', importSourceKey: sourceKey }
        }
    }
}

function truncateForSummary(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

async function scanClaudeSessionSummary(file: ClaudeSessionFile): Promise<SummaryWithFile | null> {
    let sessionId = file.sessionId
    let cwd: string | null = null
    let lastUserMessage: string | null = null
    let summaryText: string | null = null
    let messageCount = 0

    try {
        for await (const line of readJsonlLines(file.filePath)) {
            const event = parseClaudeEvent(line.text)
            if (!event) continue

            if (typeof event.sessionId === 'string' && event.sessionId.trim()) {
                sessionId = event.sessionId.trim()
            }

            if (typeof event.cwd === 'string' && event.cwd.trim() && event.cwd.trim() !== cwd) {
                cwd = event.cwd.trim()
            }

            if (event.type === 'summary' && event.summary.trim()) {
                summaryText = event.summary.trim()
                continue
            }

            const imported = convertEventToImportedMessage(event, sessionId, file.modifiedAt, line.startOffset)
            if (!imported) continue
            messageCount += 1
            if (imported.message.role === 'user') {
                const content = imported.message.content as { type?: unknown; text?: unknown }
                if (content.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
                    lastUserMessage = truncateForSummary(content.text.trim(), 200)
                }
            }
        }
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to scan Claude session file', { filePath: file.filePath, error })
        return null
    }

    if (messageCount === 0) return null

    const title = truncateForSummary(
        lastUserMessage
        ?? summaryText
        ?? (cwd ? basename(cwd) : '')
        ?? sessionId,
        80
    ) || sessionId

    return {
        file,
        summary: {
            id: sessionId,
            flavor: 'claude',
            title,
            cwd,
            lastUserMessage,
            modifiedAt: file.modifiedAt,
            messageCount,
            byteSize: file.byteSize
        }
    }
}

async function findClaudeSessionForImport(
    sessionId: string
): Promise<SummaryWithFile | null> {
    const files = await collectClaudeSessionFiles()
    const directMatches = files.filter((file) => file.sessionId === sessionId)
    const candidates = directMatches.length > 0 ? directMatches : files

    for (const file of candidates) {
        const scanned = await scanClaudeSessionSummary(file)
        if (scanned?.summary.id === sessionId) return scanned
        if (directMatches.length > 0) break
    }

    return null
}

async function readClaudeSessionMessagePage(
    file: ClaudeSessionFile,
    summary: RunnerImportableSessionSummary,
    offset: number,
    limit: number
): Promise<{ messages: RunnerImportedSessionMessage[]; nextOffset: number; done: boolean }> {
    const messages: RunnerImportedSessionMessage[] = []
    let nextOffset = offset

    try {
        for await (const line of readJsonlLines(file.filePath, offset)) {
            nextOffset = line.nextOffset
            const event = parseClaudeEvent(line.text)
            if (!event) continue
            const imported = convertEventToImportedMessage(event, summary.id, file.modifiedAt, line.startOffset)
            if (!imported) continue
            messages.push(imported)
            if (messages.length >= limit) break
        }
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to read Claude session page', { filePath: file.filePath, offset, error })
        throw error
    }

    return {
        messages,
        nextOffset,
        done: nextOffset >= file.byteSize
    }
}

export async function listClaudeCodeImportableSessions(
    options: ClaudeCodeImportOptions = {}
): Promise<RunnerImportableSessionSummary[]> {
    const maxSessions = options.maxFiles ?? DEFAULT_MAX_LISTED_SESSIONS
    const files = await collectClaudeSessionFiles()
    const summaries: RunnerImportableSessionSummary[] = []

    for (const file of files) {
        const scanned = await scanClaudeSessionSummary(file)
        if (!scanned) continue
        summaries.push(scanned.summary)
        if (summaries.length >= maxSessions) break
    }

    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function getClaudeCodeSessionImportPage(
    request: RunnerImportSessionPageRequest,
    options: ClaudeCodeImportOptions = {}
): Promise<RunnerImportedSessionPage> {
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT

    if (request.cursor) {
        const cursor = decodeCursor(request.cursor)
        if (!cursor || cursor.sessionId !== request.sessionId) {
            throw new Error('Invalid import cursor')
        }

        const file = await fileFromCursor(cursor)
        if (!file) throw new Error('Claude Code session transcript no longer exists')
        if (cursor.nextOffset > file.byteSize) throw new Error('Claude Code session transcript changed; refresh and retry')
        const summary: RunnerImportableSessionSummary = {
            id: cursor.sessionId,
            flavor: 'claude',
            title: cursor.title,
            cwd: cursor.cwd,
            lastUserMessage: cursor.lastUserMessage,
            modifiedAt: file.modifiedAt,
            messageCount: cursor.totalMessages,
            byteSize: file.byteSize
        }
        const page = await readClaudeSessionMessagePage(file, summary, cursor.nextOffset, limit)
        return {
            ...summary,
            totalMessages: cursor.totalMessages,
            messages: page.messages,
            nextCursor: page.done ? null : cursorFromSummary(file, summary, page.nextOffset),
            done: page.done
        }
    }

    const scanned = await findClaudeSessionForImport(request.sessionId)
    if (!scanned) {
        throw new Error('Claude Code session not found on runner')
    }

    const page = await readClaudeSessionMessagePage(scanned.file, scanned.summary, 0, limit)
    return {
        ...scanned.summary,
        totalMessages: scanned.summary.messageCount ?? 0,
        messages: page.messages,
        nextCursor: page.done ? null : cursorFromSummary(scanned.file, scanned.summary, page.nextOffset),
        done: page.done
    }
}
