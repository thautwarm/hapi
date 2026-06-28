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
    summary?: RunnerImportableSessionSummary
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
    iterate: (...params: unknown[]) => IterableIterator<unknown>
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
    source: StorageSource
    totalMessages: number
    totalParts?: number
    messageFileCount?: number
}

type OpencodeImportCursorBase = {
    v: 1
    sessionId: string
    totalMessages: number
    title: string
    cwd: string | null
    lastUserMessage: string | null
    modifiedAt: number
    byteSize: number
}

type OpencodeImportCursor = OpencodeImportCursorBase & (
    | {
        source: 'database'
        nextPartOffset: number
        nextMessageOffset: number
        totalParts: number
    }
    | {
        source: 'files'
        nextMessageIndex: number
        nextPartIndex: number
        nextPartMessageOffset: number
        messageFileCount: number
    }
)

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
        const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>
        if (parsed.v !== 1) return null
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null
        if (parsed.source !== 'database' && parsed.source !== 'files') return null
        if (typeof parsed.totalMessages !== 'number' || !Number.isInteger(parsed.totalMessages) || parsed.totalMessages < 0) return null
        if (typeof parsed.title !== 'string' || !parsed.title) return null
        if (parsed.cwd !== null && typeof parsed.cwd !== 'string') return null
        if (parsed.lastUserMessage !== null && typeof parsed.lastUserMessage !== 'string') return null
        if (typeof parsed.modifiedAt !== 'number' || !Number.isInteger(parsed.modifiedAt) || parsed.modifiedAt < 0) return null
        if (typeof parsed.byteSize !== 'number' || !Number.isInteger(parsed.byteSize) || parsed.byteSize < 0) return null

        const base: OpencodeImportCursorBase = {
            v: 1,
            sessionId: parsed.sessionId,
            totalMessages: parsed.totalMessages,
            title: parsed.title,
            cwd: parsed.cwd ?? null,
            lastUserMessage: parsed.lastUserMessage ?? null,
            modifiedAt: parsed.modifiedAt,
            byteSize: parsed.byteSize
        }

        if (parsed.source === 'database') {
            if (typeof parsed.nextPartOffset !== 'number' || !Number.isInteger(parsed.nextPartOffset) || parsed.nextPartOffset < 0) return null
            if (typeof parsed.nextMessageOffset !== 'number' || !Number.isInteger(parsed.nextMessageOffset) || parsed.nextMessageOffset < 0) return null
            if (typeof parsed.totalParts !== 'number' || !Number.isInteger(parsed.totalParts) || parsed.totalParts < 0) return null
            return {
                ...base,
                source: 'database',
                nextPartOffset: parsed.nextPartOffset,
                nextMessageOffset: parsed.nextMessageOffset,
                totalParts: parsed.totalParts
            }
        }

        if (typeof parsed.nextMessageIndex !== 'number' || !Number.isInteger(parsed.nextMessageIndex) || parsed.nextMessageIndex < 0) return null
        if (typeof parsed.nextPartIndex !== 'number' || !Number.isInteger(parsed.nextPartIndex) || parsed.nextPartIndex < 0) return null
        if (typeof parsed.nextPartMessageOffset !== 'number' || !Number.isInteger(parsed.nextPartMessageOffset) || parsed.nextPartMessageOffset < 0) return null
        if (typeof parsed.messageFileCount !== 'number' || !Number.isInteger(parsed.messageFileCount) || parsed.messageFileCount < 0) return null
        return {
            ...base,
            source: 'files',
            nextMessageIndex: parsed.nextMessageIndex,
            nextPartIndex: parsed.nextPartIndex,
            nextPartMessageOffset: parsed.nextPartMessageOffset,
            messageFileCount: parsed.messageFileCount
        }
    } catch {
        return null
    }
}

function databaseCursorFromLoaded(
    loaded: OpencodeLoadedSession,
    nextPartOffset: number,
    nextMessageOffset: number
): string {
    if (loaded.totalParts === undefined) throw new Error('Invalid OpenCode database import cursor')
    return encodeCursor({
        v: 1,
        sessionId: loaded.summary.id,
        source: 'database',
        nextPartOffset,
        nextMessageOffset,
        totalParts: loaded.totalParts,
        totalMessages: loaded.totalMessages,
        title: loaded.summary.title,
        cwd: loaded.summary.cwd ?? null,
        lastUserMessage: loaded.summary.lastUserMessage ?? null,
        modifiedAt: loaded.summary.modifiedAt,
        byteSize: loaded.summary.byteSize ?? 0
    })
}

function fileCursorFromLoaded(
    loaded: OpencodeLoadedSession,
    nextMessageIndex: number,
    nextPartIndex: number,
    nextPartMessageOffset: number
): string {
    if (loaded.messageFileCount === undefined) throw new Error('Invalid OpenCode file import cursor')
    return encodeCursor({
        v: 1,
        sessionId: loaded.summary.id,
        source: 'files',
        nextMessageIndex,
        nextPartIndex,
        nextPartMessageOffset,
        messageFileCount: loaded.messageFileCount,
        totalMessages: loaded.totalMessages,
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

type OpencodeScanOptions = {
    limit: number
    startPartOffset: number
    startMessageOffset: number
    knownTotalMessages?: number
    knownTotalParts?: number
    summaryOverride?: RunnerImportableSessionSummary
}

type OpencodeDatabasePageResult = {
    loaded: OpencodeLoadedSession
    messages: RunnerImportedSessionMessage[]
    nextPartOffset: number
    nextMessageOffset: number
    done: boolean
}

type OpencodeFilePageOptions = {
    limit: number
    nextMessageIndex: number
    nextPartIndex: number
    nextPartMessageOffset: number
    knownTotalMessages?: number
    knownMessageFileCount?: number
    summaryOverride?: RunnerImportableSessionSummary
}

type OpencodeFilePageResult = {
    loaded: OpencodeLoadedSession
    messages: RunnerImportedSessionMessage[]
    nextMessageIndex: number
    nextPartIndex: number
    nextPartMessageOffset: number
    done: boolean
}

type PageCollectState = {
    limit: number
    messages: RunnerImportedSessionMessage[]
    nextPartOffset: number
    nextMessageOffset: number
    sealed: boolean
}

type DbPartWithMessageRow = DbPartRow & {
    message_data: string | null
    message_time_created: number | null
    message_time_updated: number | null
}

function makePageCollectState(options: OpencodeScanOptions): PageCollectState {
    return {
        limit: options.limit,
        messages: [],
        nextPartOffset: options.startPartOffset,
        nextMessageOffset: options.startMessageOffset,
        sealed: false
    }
}

function appendMessagesToPage(
    state: PageCollectState,
    messages: RunnerImportedSessionMessage[],
    nextPartOffset: number,
    nextMessageOffset: number
): void {
    if (state.sealed || messages.length === 0) return

    const remaining = state.limit - state.messages.length
    state.messages.push(...messages.slice(0, remaining))
    if (messages.length > remaining) {
        state.nextPartOffset = nextPartOffset - 1
        state.nextMessageOffset = nextMessageOffset + remaining
        state.sealed = true
        return
    }

    state.nextPartOffset = nextPartOffset
    state.nextMessageOffset = 0
    if (state.messages.length === state.limit) {
        state.sealed = true
    }
}

function userTextFromImported(message: RunnerImportedSessionMessage): string | null {
    if (message.message.role !== 'user') return null
    const content = asRecord(message.message.content)
    return content?.type === 'text' && typeof content.text === 'string' && content.text.trim()
        ? content.text
        : null
}

function updateLastUserMessage(
    current: string | null,
    messages: RunnerImportedSessionMessage[]
): string | null {
    let next = current
    for (const message of messages) {
        const text = userTextFromImported(message)
        if (text) next = truncateForSummary(text, 200)
    }
    return next
}

function buildLoadedSessionFromScan(options: {
    candidate: OpencodeSessionCandidate
    source: StorageSource
    byteSize: number
    totalMessages: number
    totalParts?: number
    messageFileCount?: number
    lastUserMessage: string | null
    summaryOverride?: RunnerImportableSessionSummary
}): OpencodeLoadedSession | null {
    if (options.totalMessages === 0) return null

    const baseSummary: RunnerImportableSessionSummary = options.summaryOverride ?? {
        id: options.candidate.id,
        flavor: 'opencode',
        title: titleFromParts(options.candidate.cwd, options.candidate.id, options.lastUserMessage),
        cwd: options.candidate.cwd,
        lastUserMessage: options.lastUserMessage,
        modifiedAt: options.candidate.modifiedAt,
        messageCount: options.totalMessages,
        byteSize: options.byteSize
    }

    return {
        summary: {
            ...baseSummary,
            messageCount: options.totalMessages,
            byteSize: options.byteSize
        },
        source: options.source,
        totalMessages: options.totalMessages,
        totalParts: options.totalParts,
        messageFileCount: options.messageFileCount
    }
}

function finalizeScanResult(
    loaded: OpencodeLoadedSession,
    state: PageCollectState | null
): OpencodeDatabasePageResult {
    if (!state) {
        return {
            loaded,
            messages: [],
            nextPartOffset: 0,
            nextMessageOffset: 0,
            done: true
        }
    }

    return {
        loaded,
        messages: state.messages,
        nextPartOffset: state.nextPartOffset,
        nextMessageOffset: state.nextMessageOffset,
        done: state.nextPartOffset >= (loaded.totalParts ?? 0) && state.nextMessageOffset === 0
    }
}

function databasePartToImported(
    candidate: OpencodeSessionCandidate,
    row: DbPartWithMessageRow
): RunnerImportedSessionMessage[] {
    const part = parseJsonRecord(row.data)
    if (!part) return []

    const messageInfo = parseJsonRecord(row.message_data ?? '') ?? {}
    const role = getString(messageInfo.role)
    const partId = getString(part.id) ?? row.id
    const messageId = getString(part.messageID) ?? getString(part.messageId) ?? row.message_id

    return convertPart({
        sessionId: candidate.id,
        source: 'database',
        messageId,
        role,
        partId,
        part: { ...part, id: partId, messageID: messageId, sessionID: row.session_id },
        createdAt: partTimestamp(part, Math.max(0, Math.floor(
            row.time_created
            ?? row.message_time_created
            ?? row.message_time_updated
            ?? candidate.modifiedAt
        )))
    })
}

async function scanDatabaseSession(
    candidate: OpencodeSessionCandidate,
    options?: OpencodeScanOptions
): Promise<OpencodeDatabasePageResult | null> {
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

        const scanCandidate: OpencodeSessionCandidate = {
            ...candidate,
            cwd: sessionRow.directory ?? candidate.cwd,
            modifiedAt: Math.max(0, Math.floor(sessionRow.time_updated ?? candidate.modifiedAt))
        }
        const byteSize = options?.summaryOverride?.byteSize ?? await databaseByteSize()
        const state = options ? makePageCollectState(options) : null

        const countRow = db.prepare('SELECT COUNT(*) AS count FROM part WHERE session_id = ?').get(candidate.id) as { count: number } | undefined
        const actualTotalParts = Math.max(0, Math.floor(countRow?.count ?? 0))
        if (options?.knownTotalParts !== undefined && actualTotalParts !== options.knownTotalParts) {
            throw new Error('OpenCode session changed; refresh and retry')
        }

        let totalMessages = options?.knownTotalMessages ?? 0
        let lastUserMessage = options?.summaryOverride?.lastUserMessage ?? null
        let partOffset = options?.summaryOverride ? options.startPartOffset : 0

        const rows = db.prepare(`
            SELECT
                part.id,
                part.message_id,
                part.session_id,
                part.time_created,
                part.time_updated,
                part.data,
                message.data AS message_data,
                message.time_created AS message_time_created,
                message.time_updated AS message_time_updated
            FROM part
            LEFT JOIN message
                ON message.id = part.message_id
                AND message.session_id = part.session_id
            WHERE part.session_id = ?
            ORDER BY part.time_created ASC, part.id ASC
            LIMIT -1 OFFSET ?
        `)

        for (const rawRow of rows.iterate(candidate.id, partOffset)) {
            if (state?.sealed && options?.summaryOverride) break
            const row = rawRow as DbPartWithMessageRow
            const currentPartOffset = partOffset
            partOffset += 1

            const imported = databasePartToImported(scanCandidate, row)
            if (options?.knownTotalMessages === undefined) totalMessages += imported.length
            if (!options?.summaryOverride) {
                lastUserMessage = updateLastUserMessage(lastUserMessage, imported)
            }

            if (state) {
                if (!state.sealed) {
                    if (imported.length === 0) {
                        state.nextPartOffset = currentPartOffset + 1
                        state.nextMessageOffset = 0
                    }
                    const startMessageOffset = currentPartOffset === state.nextPartOffset
                        ? state.nextMessageOffset
                        : 0
                    if (startMessageOffset > imported.length) {
                        throw new Error('OpenCode session changed; refresh and retry')
                    }
                    appendMessagesToPage(
                        state,
                        imported.slice(startMessageOffset),
                        currentPartOffset + 1,
                        startMessageOffset
                    )
                }
                if (
                    state.sealed
                    && options?.summaryOverride
                ) {
                    break
                }
            }
        }

        const loaded = buildLoadedSessionFromScan({
            candidate: scanCandidate,
            source: 'database',
            byteSize,
            totalMessages,
            totalParts: actualTotalParts,
            lastUserMessage,
            summaryOverride: options?.summaryOverride
        })
        return loaded ? finalizeScanResult(loaded, state) : null
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to load OpenCode database session', { sessionId: candidate.id, error })
        if (options) throw error
        return null
    } finally {
        db.close()
    }
}

async function loadDatabaseSession(candidate: OpencodeSessionCandidate): Promise<OpencodeLoadedSession | null> {
    return (await scanDatabaseSession(candidate))?.loaded ?? null
}

async function findSessionInfoCandidate(sessionId: string): Promise<OpencodeSessionCandidate | null> {
    const candidates = await listFileSessionCandidates()
    return candidates.find((candidate) => candidate.id === sessionId) ?? null
}

function fileMessageDir(sessionId: string): string {
    return join(opencodeStorageDir(), 'message', sessionId)
}

async function listFileMessagePaths(sessionId: string): Promise<string[]> {
    return await listJsonFiles(fileMessageDir(sessionId))
}

async function readFileMessageMetadata(
    filePath: string,
    candidate: OpencodeSessionCandidate
): Promise<{
    id: string | null
    role: string | null
    createdAt: number
    byteSize: number
}> {
    const stats = await readMtimeAndSize(filePath)
    const info = await readJsonRecord(filePath)
    const time = asRecord(info?.time)
    return {
        id: getString(info?.id) ?? filenameToId(filePath),
        role: getString(info?.role),
        createdAt: Math.max(0, Math.floor(time ? getNumber(time.created) ?? stats?.mtime ?? candidate.modifiedAt : stats?.mtime ?? candidate.modifiedAt)),
        byteSize: stats?.size ?? 0
    }
}

async function listPartFilesForMessageId(messageId: string): Promise<string[]> {
    return await listJsonFiles(join(opencodeStorageDir(), 'part', messageId))
}

async function loadSortedPartRecords(
    partFiles: string[],
    candidate: OpencodeSessionCandidate,
    includeSize: boolean
): Promise<{ parts: Array<{ filePath: string; part: Record<string, unknown> | null; stats: { mtime: number; size: number } | null }>; byteSize: number }> {
    const parts: Array<{ filePath: string; part: Record<string, unknown> | null; stats: { mtime: number; size: number } | null }> = []
    let byteSize = 0
    for (const partPath of partFiles) {
        const part = await readJsonRecord(partPath)
        const stats = await readMtimeAndSize(partPath)
        if (includeSize && stats) byteSize += stats.size
        parts.push({ filePath: partPath, part, stats })
    }
    parts.sort((a, b) => {
        const left = a.part ? partTimestamp(a.part, a.stats?.mtime ?? candidate.modifiedAt) : (a.stats?.mtime ?? candidate.modifiedAt)
        const right = b.part ? partTimestamp(b.part, b.stats?.mtime ?? candidate.modifiedAt) : (b.stats?.mtime ?? candidate.modifiedAt)
        return left - right
    })
    return { parts, byteSize }
}

async function loadFileSession(candidate: OpencodeSessionCandidate): Promise<OpencodeLoadedSession | null> {
    const messageFiles = await listFileMessagePaths(candidate.id)
    let byteSize = candidate.byteSize
    let totalMessages = 0
    let lastUserMessage: string | null = null

    for (const filePath of messageFiles) {
        const metadata = await readFileMessageMetadata(filePath, candidate)
        byteSize += metadata.byteSize
        const messageId = metadata.id
        if (!messageId) continue

        const partFiles = await listPartFilesForMessageId(messageId)
        const { parts, byteSize: partByteSize } = await loadSortedPartRecords(partFiles, candidate, true)
        byteSize += partByteSize

        for (const item of parts) {
            if (!item.part) continue

            const partId = getString(item.part.id) ?? filenameToId(item.filePath) ?? hashForKey(item.filePath)
            const partMessageId = getString(item.part.messageID) ?? getString(item.part.messageId) ?? messageId
            const imported = convertPart({
                sessionId: candidate.id,
                source: 'files',
                messageId: partMessageId,
                role: metadata.role,
                partId,
                part: { ...item.part, id: partId, messageID: partMessageId, sessionID: candidate.id },
                createdAt: partTimestamp(item.part, item.stats?.mtime ?? metadata.createdAt)
            })

            totalMessages += imported.length
            lastUserMessage = updateLastUserMessage(lastUserMessage, imported)
        }
    }

    return buildLoadedSessionFromScan({
        candidate,
        source: 'files',
        byteSize,
        totalMessages,
        messageFileCount: messageFiles.length,
        lastUserMessage,
        summaryOverride: undefined
    })
}

async function scanFileSessionPage(
    candidate: OpencodeSessionCandidate,
    options: OpencodeFilePageOptions
): Promise<OpencodeFilePageResult | null> {
    const messageFiles = await listFileMessagePaths(candidate.id)
    if (options.knownMessageFileCount !== undefined && messageFiles.length !== options.knownMessageFileCount) {
        throw new Error('OpenCode session changed; refresh and retry')
    }

    const pageMessages: RunnerImportedSessionMessage[] = []
    let byteSize = options.summaryOverride?.byteSize ?? candidate.byteSize
    let totalMessages = options.knownTotalMessages ?? 0
    let lastUserMessage = options.summaryOverride?.lastUserMessage ?? null
    let nextMessageIndex = options.nextMessageIndex
    let nextPartIndex = options.nextPartIndex
    let nextPartMessageOffset = options.nextPartMessageOffset
    let sealed = false

    outer:
    for (let messageIndex = 0; messageIndex < messageFiles.length; messageIndex += 1) {
        if (options.summaryOverride && messageIndex < options.nextMessageIndex) {
            continue
        }

        const metadata = await readFileMessageMetadata(messageFiles[messageIndex], candidate)
        if (!options.summaryOverride) byteSize += metadata.byteSize
        const messageId = metadata.id
        if (!messageId) {
            if (!sealed && messageIndex >= options.nextMessageIndex) {
                nextMessageIndex = messageIndex + 1
                nextPartIndex = 0
                nextPartMessageOffset = 0
            }
            continue
        }

        const partFiles = await listPartFilesForMessageId(messageId)
        const startPartIndex = options.summaryOverride && messageIndex === options.nextMessageIndex
            ? options.nextPartIndex
            : 0
        if (startPartIndex > partFiles.length) {
            throw new Error('OpenCode session changed; refresh and retry')
        }

        const { parts, byteSize: partByteSize } = await loadSortedPartRecords(partFiles, candidate, !options.summaryOverride)
        if (!options.summaryOverride) byteSize += partByteSize

        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            if (partIndex < startPartIndex) continue

            const item = parts[partIndex]
            let imported: RunnerImportedSessionMessage[] = []
            if (item.part) {
                const partId = getString(item.part.id) ?? filenameToId(item.filePath) ?? hashForKey(item.filePath)
                const partMessageId = getString(item.part.messageID) ?? getString(item.part.messageId) ?? messageId
                imported = convertPart({
                    sessionId: candidate.id,
                    source: 'files',
                    messageId: partMessageId,
                    role: metadata.role,
                    partId,
                    part: { ...item.part, id: partId, messageID: partMessageId, sessionID: candidate.id },
                    createdAt: partTimestamp(item.part, item.stats?.mtime ?? metadata.createdAt)
                })
            }

            if (options.knownTotalMessages === undefined) totalMessages += imported.length
            if (!options.summaryOverride) {
                lastUserMessage = updateLastUserMessage(lastUserMessage, imported)
            }

            if (!sealed) {
                const startMessageOffset = messageIndex === options.nextMessageIndex && partIndex === options.nextPartIndex
                    ? options.nextPartMessageOffset
                    : 0
                if (startMessageOffset > imported.length) {
                    throw new Error('OpenCode session changed; refresh and retry')
                }
                const pageImported = imported.slice(startMessageOffset)
                const remaining = options.limit - pageMessages.length
                pageMessages.push(...pageImported.slice(0, remaining))

                if (pageImported.length > remaining) {
                    nextMessageIndex = messageIndex
                    nextPartIndex = partIndex
                    nextPartMessageOffset = startMessageOffset + remaining
                    sealed = true
                } else if (partIndex + 1 < parts.length) {
                    nextMessageIndex = messageIndex
                    nextPartIndex = partIndex + 1
                    nextPartMessageOffset = 0
                } else {
                    nextMessageIndex = messageIndex + 1
                    nextPartIndex = 0
                    nextPartMessageOffset = 0
                }
                if (pageMessages.length >= options.limit) {
                    sealed = true
                }
            }

            if (sealed && options.summaryOverride) {
                break outer
            }
        }

        if (!sealed && messageIndex >= options.nextMessageIndex) {
            nextMessageIndex = messageIndex + 1
            nextPartIndex = 0
            nextPartMessageOffset = 0
        }
    }

    const loaded = buildLoadedSessionFromScan({
        candidate,
        source: 'files',
        byteSize,
        totalMessages,
        messageFileCount: messageFiles.length,
        lastUserMessage,
        summaryOverride: options.summaryOverride
    })
    if (!loaded) return null

    return {
        loaded,
        messages: pageMessages,
        nextMessageIndex,
        nextPartIndex,
        nextPartMessageOffset,
        done: nextMessageIndex >= messageFiles.length
    }
}

async function loadOpencodeSession(candidate: OpencodeSessionCandidate): Promise<OpencodeLoadedSession | null> {
    if (candidate.source === 'database') {
        return await loadDatabaseSession(candidate)
    }
    return await loadFileSession(candidate)
}

async function findOpencodeCandidateForImport(sessionId: string, source?: StorageSource): Promise<OpencodeSessionCandidate | null> {
    if (!source || source === 'database') {
        const dbCandidate = (await listDatabaseSessionCandidates()).find((candidate) => candidate.id === sessionId)
        if (dbCandidate) return dbCandidate
    }

    if (!source || source === 'files') {
        return await findSessionInfoCandidate(sessionId)
    }

    return null
}

async function getDatabaseOpencodeSessionPage(
    candidate: OpencodeSessionCandidate,
    options: OpencodeScanOptions
): Promise<RunnerImportedSessionPage> {
    const scan = await scanDatabaseSession(candidate, options)
    if (!scan) {
        throw new Error('OpenCode session not found on runner')
    }
    return {
        ...scan.loaded.summary,
        totalMessages: scan.loaded.totalMessages,
        messages: scan.messages,
        nextCursor: scan.done ? null : databaseCursorFromLoaded(scan.loaded, scan.nextPartOffset, scan.nextMessageOffset),
        done: scan.done
    }
}

async function getFileOpencodeSessionPage(
    candidate: OpencodeSessionCandidate,
    options: OpencodeFilePageOptions
): Promise<RunnerImportedSessionPage> {
    const scan = await scanFileSessionPage(candidate, options)
    if (!scan) {
        throw new Error('OpenCode session not found on runner')
    }
    return {
        ...scan.loaded.summary,
        totalMessages: scan.loaded.totalMessages,
        messages: scan.messages,
        nextCursor: scan.done ? null : fileCursorFromLoaded(
            scan.loaded,
            scan.nextMessageIndex,
            scan.nextPartIndex,
            scan.nextPartMessageOffset
        ),
        done: scan.done
    }
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
    options: OpencodeImportOptions = {}
): Promise<RunnerImportedSessionPage> {
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT

    if (request.cursor) {
        const cursor = decodeCursor(request.cursor)
        if (!cursor || cursor.sessionId !== request.sessionId) {
            throw new Error('Invalid import cursor')
        }
        const candidate = await findOpencodeCandidateForImport(cursor.sessionId, cursor.source)
        if (!candidate) {
            throw new Error('OpenCode session not found on runner')
        }

        const summaryOverride: RunnerImportableSessionSummary = {
            id: cursor.sessionId,
            flavor: 'opencode',
            title: cursor.title,
            cwd: cursor.cwd,
            lastUserMessage: cursor.lastUserMessage,
            modifiedAt: cursor.modifiedAt,
            messageCount: cursor.totalMessages,
            byteSize: cursor.byteSize
        }

        if (cursor.source === 'database') {
            return await getDatabaseOpencodeSessionPage(candidate, {
                limit,
                startPartOffset: cursor.nextPartOffset,
                startMessageOffset: cursor.nextMessageOffset,
                knownTotalMessages: cursor.totalMessages,
                knownTotalParts: cursor.totalParts,
                summaryOverride
            })
        }

        return await getFileOpencodeSessionPage(candidate, {
            limit,
            nextMessageIndex: cursor.nextMessageIndex,
            nextPartIndex: cursor.nextPartIndex,
            nextPartMessageOffset: cursor.nextPartMessageOffset,
            knownTotalMessages: cursor.totalMessages,
            knownMessageFileCount: cursor.messageFileCount,
            summaryOverride
        })
    }

    const candidate = await findOpencodeCandidateForImport(request.sessionId)
    if (!candidate) {
        throw new Error('OpenCode session not found on runner')
    }
    const cachedSummary = options.summary?.id === request.sessionId && options.summary.flavor === 'opencode'
        ? options.summary
        : undefined

    if (candidate.source === 'database') {
        return await getDatabaseOpencodeSessionPage(candidate, {
            limit,
            startPartOffset: 0,
            startMessageOffset: 0,
            knownTotalMessages: cachedSummary?.messageCount,
            summaryOverride: cachedSummary
        })
    }

    return await getFileOpencodeSessionPage(candidate, {
        limit,
        nextMessageIndex: 0,
        nextPartIndex: 0,
        nextPartMessageOffset: 0,
        knownTotalMessages: cachedSummary?.messageCount,
        summaryOverride: cachedSummary
    })
}
