import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
    AGENT_MESSAGE_PAYLOAD_TYPE,
    type RunnerImportableSessionSummary,
    type RunnerImportedSessionMessage,
    type RunnerImportedSessionPage,
    type RunnerImportSessionPageRequest
} from '@hapi/protocol'

import { logger } from '@/ui/logger'

const DEFAULT_MAX_LISTED_SESSIONS = 500
const DEFAULT_PAGE_LIMIT = 100

type StorageSource = 'database' | 'files'

type OpencodeImportOptions = {
    maxFiles?: number
}

type DbSessionRow = {
    id: string
    directory: string | null
    time_created: number | null
    time_updated: number | null
}

type DbMessageRow = {
    id: string
    session_id: string
    time_created: number | null
    time_updated: number | null
    data: string
}

type DbPartRow = {
    id: string
    message_id: string
    session_id: string
    time_created: number | null
    time_updated: number | null
    data: string
}

type SqliteStatement = {
    all: (...params: unknown[]) => unknown[]
    get: (...params: unknown[]) => unknown
}

type SqliteDatabase = {
    prepare: (sql: string) => SqliteStatement
    close: () => void
}

type OpencodeSessionCandidate = {
    id: string
    source: StorageSource
    cwd: string | null
    createdAt: number
    modifiedAt: number
    byteSize: number
}

type OpencodeLoadedSession = {
    summary: RunnerImportableSessionSummary
    messages: RunnerImportedSessionMessage[]
    source: StorageSource
}

type OpencodeImportCursor = {
    v: 1
    sessionId: string
    source: StorageSource
    afterSourceKey: string | null
    totalMessages: number
    title: string
    cwd: string | null
    lastUserMessage: string | null
    modifiedAt: number
    byteSize: number
}

type ParsedSessionInfo = {
    id: string | null
    directory: string | null
    timeCreated: number | null
    timeUpdated: number | null
}

type PartContext = {
    sessionId: string
    source: StorageSource
    messageId: string
    role: string | null
    partId: string
    part: Record<string, unknown>
    createdAt: number
}

function opencodeDataHome(): string {
    return process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
}

function opencodeStorageDir(): string {
    return join(opencodeDataHome(), 'opencode', 'storage')
}

function opencodeDatabasePath(): string {
    return join(opencodeDataHome(), 'opencode', 'opencode.db')
}

function encodeCursor(cursor: OpencodeImportCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
}

function decodeCursor(value: string): OpencodeImportCursor | null {
    try {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=')
        const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Partial<OpencodeImportCursor>
        if (parsed.v !== 1) return null
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
        if (parsed.source !== 'database' && parsed.source !== 'files') return null
        if (parsed.afterSourceKey !== null && typeof parsed.afterSourceKey !== 'string') return null
        if (typeof parsed.totalMessages !== 'number' || !Number.isInteger(parsed.totalMessages) || parsed.totalMessages < 0) return null
        if (typeof parsed.title !== 'string' || !parsed.title) return null
        if (parsed.cwd !== null && typeof parsed.cwd !== 'string') return null
        if (parsed.lastUserMessage !== null && typeof parsed.lastUserMessage !== 'string') return null
        if (typeof parsed.modifiedAt !== 'number' || !Number.isInteger(parsed.modifiedAt) || parsed.modifiedAt < 0) return null
        if (typeof parsed.byteSize !== 'number' || !Number.isInteger(parsed.byteSize) || parsed.byteSize < 0) return null
        return {
            v: 1,
            sessionId: parsed.sessionId,
            source: parsed.source,
            afterSourceKey: parsed.afterSourceKey ?? null,
            totalMessages: parsed.totalMessages,
            title: parsed.title,
            cwd: parsed.cwd ?? null,
            lastUserMessage: parsed.lastUserMessage ?? null,
            modifiedAt: parsed.modifiedAt,
            byteSize: parsed.byteSize
        }
    } catch {
        return null
    }
}

function cursorFromLoaded(loaded: OpencodeLoadedSession, afterSourceKey: string | null): string {
    return encodeCursor({
        v: 1,
        sessionId: loaded.summary.id,
        source: loaded.source,
        afterSourceKey,
        totalMessages: loaded.summary.messageCount ?? loaded.messages.length,
        title: loaded.summary.title,
        cwd: loaded.summary.cwd ?? null,
        lastUserMessage: loaded.summary.lastUserMessage ?? null,
        modifiedAt: loaded.summary.modifiedAt,
        byteSize: loaded.summary.byteSize ?? 0
    })
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function getString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function getNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (!trimmed) return value
    if ((!trimmed.startsWith('{') || !trimmed.endsWith('}')) && (!trimmed.startsWith('[') || !trimmed.endsWith(']'))) {
        return value
    }
    try {
        return JSON.parse(trimmed)
    } catch {
        return value
    }
}

function hashForKey(value: unknown): string {
    return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

function stableItemId(sourceKey: string): string {
    return `opencode-import-${hashForKey(sourceKey)}`
}

function truncateForSummary(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function titleFromParts(cwd: string | null, sessionId: string, lastUserMessage: string | null): string {
    return truncateForSummary(lastUserMessage ?? (cwd ? basename(cwd) : sessionId), 80) || sessionId
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
    try {
        return asRecord(JSON.parse(raw))
    } catch {
        return null
    }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
    try {
        return parseJsonRecord(await readFile(filePath, 'utf8'))
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to read OpenCode JSON file', { filePath, error })
        return null
    }
}

async function readMtimeAndSize(filePath: string): Promise<{ mtime: number; size: number } | null> {
    try {
        const s = await stat(filePath)
        return {
            mtime: Math.max(0, Math.floor(s.mtimeMs)),
            size: Math.max(0, Math.floor(s.size))
        }
    } catch {
        return null
    }
}

async function safeReadDir(dirPath: string): Promise<Dirent[]> {
    try {
        return await readdir(dirPath, { withFileTypes: true })
    } catch {
        return []
    }
}

async function listJsonFiles(dirPath: string): Promise<string[]> {
    const entries = await safeReadDir(dirPath)
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => join(dirPath, entry.name))
        .sort((a, b) => a.localeCompare(b))
}

async function listSessionInfoFiles(): Promise<string[]> {
    const sessionRoot = join(opencodeStorageDir(), 'session')
    const entries = await safeReadDir(sessionRoot)
    const results: string[] = []
    for (const entry of entries) {
        if (!entry.isDirectory()) continue
        results.push(...await listJsonFiles(join(sessionRoot, entry.name)))
    }
    return results.sort((a, b) => a.localeCompare(b))
}

function filenameToId(filePath: string): string | null {
    if (!filePath.endsWith('.json')) return null
    const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
    const name = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
    return name.slice(0, -5) || null
}

function parseSessionInfo(record: Record<string, unknown> | null): ParsedSessionInfo | null {
    if (!record) return null
    const time = asRecord(record.time)
    return {
        id: getString(record.id),
        directory: getString(record.directory),
        timeCreated: time ? getNumber(time.created) : null,
        timeUpdated: time ? getNumber(time.updated) : null
    }
}

async function openDatabase(): Promise<SqliteDatabase | null> {
    try {
        const sqlite = await import('bun:sqlite') as {
            Database: new (path: string, options?: { readonly?: boolean }) => SqliteDatabase
        }
        return new sqlite.Database(opencodeDatabasePath(), { readonly: true })
    } catch (error) {
        logger.debug('[RUNNER IMPORT] OpenCode database not readable', { databasePath: opencodeDatabasePath(), error })
        return null
    }
}

async function databaseByteSize(): Promise<number> {
    return (await readMtimeAndSize(opencodeDatabasePath()))?.size ?? 0
}

async function listDatabaseSessionCandidates(maxRows = DEFAULT_MAX_LISTED_SESSIONS * 4): Promise<OpencodeSessionCandidate[]> {
    const db = await openDatabase()
    if (!db) return []
    try {
        const rows = db.prepare(`
            SELECT id, directory, time_created, time_updated
            FROM session
            ORDER BY time_updated DESC, time_created DESC
            LIMIT ?
        `).all(maxRows) as DbSessionRow[]
        const byteSize = await databaseByteSize()
        return rows
            .filter((row) => typeof row.id === 'string' && row.id.length > 0)
            .map((row) => ({
                id: row.id,
                source: 'database' as const,
                cwd: row.directory ?? null,
                createdAt: Math.max(0, Math.floor(row.time_created ?? row.time_updated ?? 0)),
                modifiedAt: Math.max(0, Math.floor(row.time_updated ?? row.time_created ?? Date.now())),
                byteSize
            }))
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to list OpenCode database sessions', { error })
        return []
    } finally {
        db.close()
    }
}

async function listFileSessionCandidates(): Promise<OpencodeSessionCandidate[]> {
    const files = await listSessionInfoFiles()
    const candidates: OpencodeSessionCandidate[] = []
    for (const filePath of files) {
        const info = parseSessionInfo(await readJsonRecord(filePath))
        const stats = await readMtimeAndSize(filePath)
        const id = info?.id ?? filenameToId(filePath)
        if (!id) continue
        candidates.push({
            id,
            source: 'files',
            cwd: info?.directory ?? null,
            createdAt: Math.max(0, Math.floor(info?.timeCreated ?? stats?.mtime ?? 0)),
            modifiedAt: Math.max(0, Math.floor(info?.timeUpdated ?? stats?.mtime ?? info?.timeCreated ?? Date.now())),
            byteSize: stats?.size ?? 0
        })
    }
    return candidates.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

async function collectOpencodeSessionCandidates(): Promise<OpencodeSessionCandidate[]> {
    const databaseCandidates = await listDatabaseSessionCandidates()
    const fileCandidates = await listFileSessionCandidates()
    const result = new Map<string, OpencodeSessionCandidate>()
    for (const candidate of databaseCandidates) {
        result.set(candidate.id, candidate)
    }
    for (const candidate of fileCandidates) {
        if (!result.has(candidate.id)) result.set(candidate.id, candidate)
    }
    return Array.from(result.values()).sort((a, b) => b.modifiedAt - a.modifiedAt)
}

function textPartToImported(ctx: PartContext): RunnerImportedSessionMessage | null {
    const text = getString(ctx.part.text)
    if (!text) return null
    const sourceKey = `opencode:${ctx.sessionId}:message:${ctx.messageId}:part:${ctx.partId}:text`
    if (ctx.role === 'user') {
        return {
            sourceKey,
            createdAt: ctx.createdAt,
            message: {
                role: 'user',
                content: { type: 'text', text },
                meta: { sentFrom: 'cli', importSourceKey: sourceKey }
            }
        }
    }

    return {
        sourceKey,
        createdAt: ctx.createdAt,
        message: {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'message', message: text, id: stableItemId(sourceKey) }
            },
            meta: { sentFrom: 'cli', importSourceKey: sourceKey }
        }
    }
}

function parseToolCall(part: Record<string, unknown>): { callId: string; name: string; input: unknown; status?: string } | null {
    const state = asRecord(part.state)
    const name = getString(part.tool) || getString(part.name) || (state ? getString(state.tool) || getString(state.name) : null)
    const callId = getString(part.callID)
        || getString(part.callId)
        || getString(part.id)
        || getString(part.tool_call_id)
        || getString(part.toolCallId)
    if (!name || !callId) return null
    const status = state ? getString(state.status) ?? undefined : undefined
    const input = parseMaybeJson(state?.input ?? state?.raw ?? part.input ?? part.args ?? part.arguments ?? part.raw)
    return { callId, name, input, status }
}

function parseToolResult(part: Record<string, unknown>): { callId: string; output: unknown; isError?: boolean } | null {
    const callId = getString(part.callID)
        || getString(part.callId)
        || getString(part.tool_call_id)
        || getString(part.toolCallId)
        || getString(part.id)
    if (!callId) return null

    const state = asRecord(part.state)
    if (getString(part.type) === 'tool' && state) {
        const status = getString(state.status)
        if (status === 'completed') {
            return {
                callId,
                output: {
                    content: state.output ?? state.title,
                    metadata: state.metadata,
                    title: state.title,
                    attachments: state.attachments
                }
            }
        }
        if (status === 'error') {
            return {
                callId,
                output: {
                    content: state.error,
                    isError: true
                },
                isError: true
            }
        }
        return null
    }

    if (!('content' in part) && !('output' in part) && !('metadata' in part) && !('is_error' in part)) return null
    return {
        callId,
        output: {
            content: part.content ?? part.output,
            metadata: part.metadata,
            isError: part.is_error
        },
        isError: part.is_error === true
    }
}

function toolPartToImported(ctx: PartContext): RunnerImportedSessionMessage[] {
    const messages: RunnerImportedSessionMessage[] = []
    const toolCall = parseToolCall(ctx.part)
    if (toolCall) {
        const sourceKey = `opencode:${ctx.sessionId}:message:${ctx.messageId}:part:${ctx.partId}:tool-call`
        messages.push({
            sourceKey,
            createdAt: ctx.createdAt,
            message: {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        name: toolCall.name,
                        callId: toolCall.callId,
                        input: toolCall.input,
                        status: toolCall.status,
                        id: stableItemId(sourceKey)
                    }
                },
                meta: { sentFrom: 'cli', importSourceKey: sourceKey }
            }
        })
    }

    const toolResult = parseToolResult(ctx.part)
    if (toolResult) {
        const sourceKey = `opencode:${ctx.sessionId}:message:${ctx.messageId}:part:${ctx.partId}:tool-result`
        messages.push({
            sourceKey,
            createdAt: ctx.createdAt,
            message: {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call-result',
                        callId: toolResult.callId,
                        output: toolResult.output,
                        is_error: toolResult.isError,
                        id: stableItemId(sourceKey)
                    }
                },
                meta: { sentFrom: 'cli', importSourceKey: sourceKey }
            }
        })
    }

    return messages
}

function partTimestamp(part: Record<string, unknown>, fallback: number): number {
    const time = asRecord(part.time)
    return Math.max(0, Math.floor(time ? getNumber(time.created) ?? getNumber(time.start) ?? fallback : fallback))
}

function convertPart(ctx: PartContext): RunnerImportedSessionMessage[] {
    const partType = getString(ctx.part.type)
    if (partType === 'text') {
        const imported = textPartToImported(ctx)
        return imported ? [imported] : []
    }
    if (partType === 'tool') {
        return toolPartToImported(ctx)
    }
    return []
}

function buildLoadedSession(
    candidate: OpencodeSessionCandidate,
    messages: RunnerImportedSessionMessage[],
    byteSize: number
): OpencodeLoadedSession | null {
    if (messages.length === 0) return null
    let lastUserMessage: string | null = null
    for (const message of messages) {
        if (message.message.role !== 'user') continue
        const content = asRecord(message.message.content)
        if (content?.type === 'text' && typeof content.text === 'string' && content.text.trim()) {
            lastUserMessage = truncateForSummary(content.text, 200)
        }
    }

    const summary: RunnerImportableSessionSummary = {
        id: candidate.id,
        flavor: 'opencode',
        title: titleFromParts(candidate.cwd, candidate.id, lastUserMessage),
        cwd: candidate.cwd,
        lastUserMessage,
        modifiedAt: candidate.modifiedAt,
        messageCount: messages.length,
        byteSize
    }
    return { summary, messages, source: candidate.source }
}

async function loadDatabaseSession(candidate: OpencodeSessionCandidate): Promise<OpencodeLoadedSession | null> {
    const db = await openDatabase()
    if (!db) return null
    try {
        const sessionRow = db.prepare(`
            SELECT id, directory, time_created, time_updated
            FROM session
            WHERE id = ?
            LIMIT 1
        `).get(candidate.id) as DbSessionRow | null
        if (!sessionRow) return null

        const messages = db.prepare(`
            SELECT id, session_id, time_created, time_updated, data
            FROM message
            WHERE session_id = ?
            ORDER BY time_created ASC, id ASC
        `).all(candidate.id) as DbMessageRow[]
        const parts = db.prepare(`
            SELECT id, message_id, session_id, time_created, time_updated, data
            FROM part
            WHERE session_id = ?
            ORDER BY time_created ASC, id ASC
        `).all(candidate.id) as DbPartRow[]

        const roles = new Map<string, string>()
        const messageCreatedAt = new Map<string, number>()
        for (const row of messages) {
            const info = parseJsonRecord(row.data) ?? {}
            const role = getString(info.role)
            if (role) roles.set(row.id, role)
            messageCreatedAt.set(row.id, Math.max(0, Math.floor(row.time_created ?? row.time_updated ?? candidate.modifiedAt)))
        }

        const imported: RunnerImportedSessionMessage[] = []
        for (const row of parts) {
            const part = parseJsonRecord(row.data)
            if (!part) continue
            const partId = getString(part.id) ?? row.id
            const messageId = getString(part.messageID) ?? getString(part.messageId) ?? row.message_id
            imported.push(...convertPart({
                sessionId: candidate.id,
                source: 'database',
                messageId,
                role: roles.get(messageId) ?? null,
                partId,
                part: { ...part, id: partId, messageID: messageId, sessionID: row.session_id },
                createdAt: partTimestamp(part, Math.max(0, Math.floor(row.time_created ?? messageCreatedAt.get(messageId) ?? candidate.modifiedAt)))
            }))
        }

        return buildLoadedSession({
            ...candidate,
            cwd: sessionRow.directory ?? candidate.cwd,
            modifiedAt: Math.max(0, Math.floor(sessionRow.time_updated ?? candidate.modifiedAt))
        }, imported, await databaseByteSize())
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to load OpenCode database session', { sessionId: candidate.id, error })
        return null
    } finally {
        db.close()
    }
}

async function findSessionInfoCandidate(sessionId: string): Promise<OpencodeSessionCandidate | null> {
    const candidates = await listFileSessionCandidates()
    return candidates.find((candidate) => candidate.id === sessionId) ?? null
}

async function loadFileSession(candidate: OpencodeSessionCandidate): Promise<OpencodeLoadedSession | null> {
    const messageDir = join(opencodeStorageDir(), 'message', candidate.id)
    const messageFiles = await listJsonFiles(messageDir)
    const roles = new Map<string, string>()
    const messageCreatedAt = new Map<string, number>()
    let byteSize = candidate.byteSize

    for (const filePath of messageFiles) {
        const stats = await readMtimeAndSize(filePath)
        if (stats) byteSize += stats.size
        const info = await readJsonRecord(filePath)
        const messageId = getString(info?.id) ?? filenameToId(filePath)
        if (!messageId) continue
        const role = getString(info?.role)
        if (role) roles.set(messageId, role)
        const time = asRecord(info?.time)
        messageCreatedAt.set(messageId, Math.max(0, Math.floor(time ? getNumber(time.created) ?? stats?.mtime ?? candidate.modifiedAt : stats?.mtime ?? candidate.modifiedAt)))
    }

    const imported: RunnerImportedSessionMessage[] = []
    for (const filePath of messageFiles) {
        const messageId = filenameToId(filePath)
        if (!messageId) continue
        const partDir = join(opencodeStorageDir(), 'part', messageId)
        const partFiles = await listJsonFiles(partDir)
        const parts: Array<{ filePath: string; part: Record<string, unknown>; stats: { mtime: number; size: number } | null }> = []
        for (const partPath of partFiles) {
            const part = await readJsonRecord(partPath)
            if (!part) continue
            const stats = await readMtimeAndSize(partPath)
            if (stats) byteSize += stats.size
            parts.push({ filePath: partPath, part, stats })
        }
        parts.sort((a, b) => partTimestamp(a.part, a.stats?.mtime ?? candidate.modifiedAt) - partTimestamp(b.part, b.stats?.mtime ?? candidate.modifiedAt))
        for (const item of parts) {
            const partId = getString(item.part.id) ?? filenameToId(item.filePath) ?? hashForKey(item.filePath)
            const partMessageId = getString(item.part.messageID) ?? getString(item.part.messageId) ?? messageId
            imported.push(...convertPart({
                sessionId: candidate.id,
                source: 'files',
                messageId: partMessageId,
                role: roles.get(partMessageId) ?? null,
                partId,
                part: { ...item.part, id: partId, messageID: partMessageId, sessionID: candidate.id },
                createdAt: partTimestamp(item.part, item.stats?.mtime ?? messageCreatedAt.get(partMessageId) ?? candidate.modifiedAt)
            }))
        }
    }

    return buildLoadedSession(candidate, imported, byteSize)
}

async function loadOpencodeSession(candidate: OpencodeSessionCandidate): Promise<OpencodeLoadedSession | null> {
    if (candidate.source === 'database') {
        return await loadDatabaseSession(candidate)
    }
    return await loadFileSession(candidate)
}

async function findOpencodeSessionForImport(sessionId: string, source?: StorageSource): Promise<OpencodeLoadedSession | null> {
    if (!source || source === 'database') {
        const dbCandidate = (await listDatabaseSessionCandidates()).find((candidate) => candidate.id === sessionId)
        if (dbCandidate) {
            const loaded = await loadDatabaseSession(dbCandidate)
            if (loaded) return loaded
        }
    }

    if (!source || source === 'files') {
        const fileCandidate = await findSessionInfoCandidate(sessionId)
        if (fileCandidate) return await loadFileSession(fileCandidate)
    }

    return null
}

export async function listOpencodeImportableSessions(
    options: OpencodeImportOptions = {}
): Promise<RunnerImportableSessionSummary[]> {
    const maxSessions = options.maxFiles ?? DEFAULT_MAX_LISTED_SESSIONS
    const candidates = await collectOpencodeSessionCandidates()
    const summaries: RunnerImportableSessionSummary[] = []
    for (const candidate of candidates) {
        const loaded = await loadOpencodeSession(candidate)
        if (!loaded) continue
        summaries.push(loaded.summary)
        if (summaries.length >= maxSessions) break
    }
    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function getOpencodeSessionImportPage(
    request: RunnerImportSessionPageRequest,
    _options: OpencodeImportOptions = {}
): Promise<RunnerImportedSessionPage> {
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT
    let loaded: OpencodeLoadedSession | null
    let afterSourceKey: string | null = null

    if (request.cursor) {
        const cursor = decodeCursor(request.cursor)
        if (!cursor || cursor.sessionId !== request.sessionId) {
            throw new Error('Invalid import cursor')
        }
        loaded = await findOpencodeSessionForImport(cursor.sessionId, cursor.source)
        afterSourceKey = cursor.afterSourceKey
    } else {
        loaded = await findOpencodeSessionForImport(request.sessionId)
    }

    if (!loaded) {
        throw new Error('OpenCode session not found on runner')
    }

    let startIndex = 0
    if (afterSourceKey) {
        const index = loaded.messages.findIndex((message) => message.sourceKey === afterSourceKey)
        if (index < 0) throw new Error('OpenCode session changed; refresh and retry')
        startIndex = index + 1
    }

    const messages = loaded.messages.slice(startIndex, startIndex + limit)
    const nextIndex = startIndex + messages.length
    const done = nextIndex >= loaded.messages.length
    const nextAfterSourceKey = messages.length > 0 ? messages[messages.length - 1].sourceKey : afterSourceKey

    return {
        ...loaded.summary,
        totalMessages: loaded.messages.length,
        messages,
        nextCursor: done ? null : cursorFromLoaded(loaded, nextAfterSourceKey),
        done
    }
}
