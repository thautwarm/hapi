import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

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
const JSONL_READ_CHUNK_SIZE = 64 * 1024
const CODEX_HEAD_SCAN_LINE_LIMIT = 200

type CodexImportOptions = {
    maxFiles?: number
}

type CodexSessionFile = {
    rootIndex: number
    rootPath: string
    relativePath: string
    filePath: string
    sessionIdHint: string | null
    modifiedAt: number
    byteSize: number
}

type SummaryWithFile = {
    file: CodexSessionFile
    summary: RunnerImportableSessionSummary
    responseItemMirrorKeys: Set<string>
}

type JsonlLine = {
    text: string
    startOffset: number
    nextOffset: number
}

type CodexRecord = Record<string, unknown> & {
    type: string
}

type CodexHeadMetadata = {
    sessionId: string | null
    cwd: string | null
    firstUserMessage: string | null
    isSubagent: boolean
}

type CodexChatMirror = {
    role: 'user' | 'assistant'
    text: string
    createdAt: number
}

type CodexImportCursor = {
    v: 1
    sessionId: string
    rootIndex: number
    relativePath: string
    nextOffset: number
    totalMessages: number
    title: string
    cwd: string | null
    lastUserMessage: string | null
    modifiedAt: number
    byteSize: number
}

function expandHomePath(pathValue: string): string {
    return pathValue.replace(/^~(?=$|[\\/])/, homedir())
}

function codexHome(): string {
    const configured = process.env.CODEX_HOME?.trim()
    return configured
        ? resolve(expandHomePath(configured))
        : join(homedir(), '.codex')
}

function codexSessionRoots(): string[] {
    return [join(codexHome(), 'sessions')]
}

function isSafeRelativePath(value: string): boolean {
    if (!value || value.includes('\0') || isAbsolute(value)) return false
    if (!value.toLowerCase().endsWith('.jsonl')) return false
    const parts = value.split(/[\\/]+/)
    return parts.every(
        (part) => part.length > 0 && part !== '.' && part !== '..'
    )
}

function encodeCursor(cursor: CodexImportCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')
}

function decodeCursor(value: string): CodexImportCursor | null {
    try {
        const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized.padEnd(
            normalized.length + ((4 - (normalized.length % 4)) % 4),
            '='
        )
        const parsed = JSON.parse(
            Buffer.from(padded, 'base64').toString('utf8')
        ) as Partial<CodexImportCursor>
        if (parsed.v !== 1) return null
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId)
            return null
        if (
            typeof parsed.rootIndex !== 'number' ||
            !Number.isInteger(parsed.rootIndex) ||
            parsed.rootIndex < 0
        )
            return null
        if (
            typeof parsed.relativePath !== 'string' ||
            !isSafeRelativePath(parsed.relativePath)
        )
            return null
        if (
            typeof parsed.nextOffset !== 'number' ||
            !Number.isInteger(parsed.nextOffset) ||
            parsed.nextOffset < 0
        )
            return null
        if (
            typeof parsed.totalMessages !== 'number' ||
            !Number.isInteger(parsed.totalMessages) ||
            parsed.totalMessages < 0
        )
            return null
        if (typeof parsed.title !== 'string' || !parsed.title) return null
        if (parsed.cwd !== null && typeof parsed.cwd !== 'string') return null
        if (
            parsed.lastUserMessage !== null &&
            typeof parsed.lastUserMessage !== 'string'
        )
            return null
        if (
            typeof parsed.modifiedAt !== 'number' ||
            !Number.isInteger(parsed.modifiedAt) ||
            parsed.modifiedAt < 0
        )
            return null
        if (
            typeof parsed.byteSize !== 'number' ||
            !Number.isInteger(parsed.byteSize) ||
            parsed.byteSize < 0
        )
            return null
        return {
            v: 1,
            sessionId: parsed.sessionId,
            rootIndex: parsed.rootIndex,
            relativePath: parsed.relativePath,
            nextOffset: parsed.nextOffset,
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

function cursorFromSummary(
    file: CodexSessionFile,
    summary: RunnerImportableSessionSummary,
    nextOffset: number
): string {
    return encodeCursor({
        v: 1,
        sessionId: summary.id,
        rootIndex: file.rootIndex,
        relativePath: file.relativePath,
        nextOffset,
        totalMessages: summary.messageCount ?? 0,
        title: summary.title,
        cwd: summary.cwd ?? null,
        lastUserMessage: summary.lastUserMessage ?? null,
        modifiedAt: summary.modifiedAt,
        byteSize: summary.byteSize ?? file.byteSize
    })
}

async function* readJsonlLines(
    filePath: string,
    startOffset = 0
): AsyncGenerator<JsonlLine> {
    const handle = await open(filePath, 'r')
    try {
        let nextReadOffset = startOffset
        let pending = Buffer.alloc(0)
        let pendingStartOffset = startOffset
        const buffer = Buffer.alloc(JSONL_READ_CHUNK_SIZE)

        while (true) {
            const { bytesRead } = await handle.read(
                buffer,
                0,
                buffer.length,
                nextReadOffset
            )
            if (bytesRead === 0) break

            const chunk = Buffer.concat([
                pending,
                buffer.subarray(0, bytesRead)
            ])
            const chunkStartOffset = pendingStartOffset
            nextReadOffset += bytesRead

            let lineStartIndex = 0
            for (let index = 0; index < chunk.length; index += 1) {
                if (chunk[index] !== 0x0a) continue
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

async function collectCodexJsonlFiles(
    rootPath: string,
    directory: string,
    rootIndex: number,
    files: CodexSessionFile[]
): Promise<void> {
    let entries: Array<{
        name: string
        isDirectory(): boolean
        isFile(): boolean
    }>
    try {
        entries = (await readdir(directory, { withFileTypes: true })) as Array<{
            name: string
            isDirectory(): boolean
            isFile(): boolean
        }>
    } catch {
        return
    }

    await Promise.all(
        entries.map(async (entry) => {
            const fullPath = join(directory, entry.name)
            if (entry.isDirectory()) {
                await collectCodexJsonlFiles(
                    rootPath,
                    fullPath,
                    rootIndex,
                    files
                )
                return
            }

            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jsonl'))
                return
            const relativePath = relative(rootPath, fullPath)
            if (!isSafeRelativePath(relativePath)) return

            try {
                const s = await stat(fullPath)
                if (!s.isFile()) return
                files.push({
                    rootIndex,
                    rootPath,
                    relativePath,
                    filePath: fullPath,
                    sessionIdHint: inferSessionIdFromFileName(fullPath),
                    modifiedAt: Math.max(0, Math.floor(s.mtimeMs)),
                    byteSize: Math.max(0, Math.floor(s.size))
                })
            } catch {
                // Ignore files that disappear while scanning.
            }
        })
    )
}

async function collectCodexSessionFiles(): Promise<CodexSessionFile[]> {
    const files: CodexSessionFile[] = []
    const roots = codexSessionRoots()

    await Promise.all(
        roots.map(async (rootPath, rootIndex) => {
            await collectCodexJsonlFiles(rootPath, rootPath, rootIndex, files)
        })
    )

    return files.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

async function fileFromCursor(
    cursor: CodexImportCursor
): Promise<CodexSessionFile | null> {
    const rootPath = codexSessionRoots()[cursor.rootIndex]
    if (!rootPath) return null
    if (!isSafeRelativePath(cursor.relativePath)) return null
    const filePath = join(rootPath, cursor.relativePath)

    try {
        const s = await stat(filePath)
        if (!s.isFile()) return null
        return {
            rootIndex: cursor.rootIndex,
            rootPath,
            relativePath: cursor.relativePath,
            filePath,
            sessionIdHint: inferSessionIdFromFileName(filePath),
            modifiedAt: Math.max(0, Math.floor(s.mtimeMs)),
            byteSize: Math.max(0, Math.floor(s.size))
        }
    } catch {
        return null
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function parseCodexRecord(line: string): CodexRecord | null {
    try {
        const parsed = JSON.parse(line)
        const record = asRecord(parsed)
        if (
            !record ||
            typeof record.type !== 'string' ||
            record.type.length === 0
        )
            return null
        return record as CodexRecord
    } catch {
        // Codex can leave partial trailing lines during writes; skip them.
        return null
    }
}

function extractCodexText(value: unknown): string {
    if (typeof value === 'string') {
        return value.trim()
    }
    if (Array.isArray(value)) {
        return value
            .map((item) => {
                const record = asRecord(item)
                if (record?.type === 'text' && typeof record.text === 'string')
                    return record.text
                if (
                    record?.type === 'input_text' &&
                    typeof record.text === 'string'
                )
                    return record.text
                if (
                    record?.type === 'output_text' &&
                    typeof record.text === 'string'
                )
                    return record.text
                return null
            })
            .filter((part): part is string => Boolean(part))
            .join(' ')
            .trim()
    }
    const record = asRecord(value)
    if (record?.type === 'text' && typeof record.text === 'string')
        return record.text.trim()
    if (record?.type === 'input_text' && typeof record.text === 'string')
        return record.text.trim()
    if (record?.type === 'output_text' && typeof record.text === 'string')
        return record.text.trim()
    return ''
}

function shouldIgnoreSyntheticUserMessage(text: string): boolean {
    const normalized = text.trim()
    return (
        normalized.startsWith('# AGENTS.md instructions') ||
        normalized.startsWith('<environment_context>')
    )
}

function inferSessionIdFromFileName(filePath: string): string | null {
    const match =
        /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(
            filePath
        )
    return match?.[1] ?? null
}

function parseCodexFunctionArguments(value: unknown): unknown {
    if (typeof value !== 'string') {
        return value
    }

    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return value
    }

    try {
        return JSON.parse(trimmed)
    } catch {
        return value
    }
}

function extractCodexToolCallId(
    payload: Record<string, unknown>
): string | null {
    const candidates = ['call_id', 'callId', 'tool_call_id', 'toolCallId', 'id']
    for (const key of candidates) {
        const value = payload[key]
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
    }
    return null
}

function extractCodexChangedTitle(record: CodexRecord): string | null {
    if (record.type === 'response_item') {
        const payload = asRecord(record.payload)
        if (
            payload?.type === 'function_call' &&
            payload.name === 'change_title'
        ) {
            const argumentsText =
                typeof payload.arguments === 'string' ? payload.arguments : null
            if (!argumentsText) return null
            try {
                const parsedArguments = JSON.parse(argumentsText) as {
                    title?: unknown
                }
                return typeof parsedArguments.title === 'string' &&
                    parsedArguments.title.trim()
                    ? parsedArguments.title.trim()
                    : null
            } catch {
                return null
            }
        }
    }

    if (record.type === 'event_msg') {
        const payload = asRecord(record.payload)
        if (payload?.type === 'mcp_tool_call_end') {
            const invocation = asRecord(payload.invocation)
            const argumentsRecord = asRecord(invocation?.arguments)
            if (
                invocation?.tool === 'change_title' &&
                typeof argumentsRecord?.title === 'string' &&
                argumentsRecord.title.trim()
            ) {
                return argumentsRecord.title.trim()
            }
        }
    }

    return null
}

function isSubagentSource(value: unknown): boolean {
    const record = asRecord(value)
    return record
        ? Object.prototype.hasOwnProperty.call(record, 'subagent')
        : false
}

function extractUserTextFromCodexRecord(record: CodexRecord): string | null {
    const payload = asRecord(record.payload)
    if (!payload) return null

    if (record.type === 'event_msg' && payload.type === 'user_message') {
        const text =
            asString(payload.message) ??
            asString(payload.text) ??
            asString(payload.content)
        if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
        return text
    }

    if (
        record.type === 'response_item' &&
        payload.type === 'message' &&
        payload.role === 'user'
    ) {
        const text = extractCodexText(payload.content)
        if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
        return text
    }

    return null
}

async function readCodexHeadMetadata(
    file: CodexSessionFile
): Promise<CodexHeadMetadata | null> {
    let linesRead = 0
    let sessionId: string | null = file.sessionIdHint
    let cwd: string | null = null
    let firstUserMessage: string | null = null
    let isSubagent = false

    try {
        for await (const line of readJsonlLines(file.filePath)) {
            linesRead += 1
            if (linesRead > CODEX_HEAD_SCAN_LINE_LIMIT) break

            const record = parseCodexRecord(line.text)
            if (!record) continue

            if (record.type === 'session_meta') {
                const payload = asRecord(record.payload)
                if (payload) {
                    if (isSubagentSource(payload.source)) {
                        isSubagent = true
                        break
                    }
                    if (
                        !sessionId &&
                        typeof payload.id === 'string' &&
                        payload.id.trim()
                    ) {
                        sessionId = payload.id.trim()
                    }
                    if (
                        !cwd &&
                        typeof payload.cwd === 'string' &&
                        payload.cwd.trim()
                    ) {
                        cwd = payload.cwd.trim()
                    }
                }
            }

            if (!firstUserMessage) {
                const text = extractUserTextFromCodexRecord(record)
                if (text) firstUserMessage = text
            }
        }
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to read Codex session head', {
            filePath: file.filePath,
            error
        })
        return null
    }

    return {
        sessionId,
        cwd,
        firstUserMessage,
        isSubagent
    }
}

function eventTimestampMs(record: CodexRecord, fallback: number): number {
    if (typeof record.timestamp === 'string') {
        const parsed = Date.parse(record.timestamp)
        if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed)
    }
    return fallback
}

function hashForKey(value: unknown): string {
    return createHash('sha1')
        .update(JSON.stringify(value))
        .digest('hex')
        .slice(0, 12)
}

function codexSourceKey(
    file: CodexSessionFile,
    sessionId: string,
    record: CodexRecord,
    lineOffset: number
): string {
    const payload = asRecord(record.payload)
    const itemType = typeof payload?.type === 'string' ? payload.type : 'event'
    const payloadId = payload ? extractCodexToolCallId(payload) : null
    const fileKey = hashForKey(`${file.rootIndex}:${file.relativePath}`)
    return `codex:${sessionId}:${fileKey}:${lineOffset}:${record.type}:${itemType}${payloadId ? `:${payloadId}` : ''}`
}

function stableCodexItemId(sourceKey: string): string {
    return `codex-import-${hashForKey(sourceKey)}`
}

function normalizeCodexMirrorText(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function codexChatMirrorKey(chat: CodexChatMirror): string | null {
    const text = normalizeCodexMirrorText(chat.text)
    if (!text) return null
    return `${chat.role}:${chat.createdAt}:${hashForKey(text)}`
}

function extractCodexChatMirror(
    record: CodexRecord,
    fallbackCreatedAt: number
): CodexChatMirror | null {
    const payload = asRecord(record.payload)
    if (!payload) return null

    const createdAt = eventTimestampMs(record, fallbackCreatedAt)

    if (record.type === 'event_msg') {
        if (payload.type === 'user_message') {
            const text =
                asString(payload.message) ??
                asString(payload.text) ??
                asString(payload.content)
            if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
            return { role: 'user', text, createdAt }
        }

        if (payload.type === 'agent_message') {
            const text = asString(payload.message)
            return text ? { role: 'assistant', text, createdAt } : null
        }

        return null
    }

    if (
        record.type === 'response_item' &&
        payload.type === 'message' &&
        (payload.role === 'user' || payload.role === 'assistant')
    ) {
        const text = extractCodexText(payload.content)
        if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
        return { role: payload.role, text, createdAt }
    }

    return null
}

async function collectCodexResponseItemMirrorKeys(
    file: CodexSessionFile
): Promise<Set<string>> {
    const keys = new Set<string>()

    for await (const line of readJsonlLines(file.filePath)) {
        const record = parseCodexRecord(line.text)
        if (!record || record.type !== 'response_item') continue
        const mirror = extractCodexChatMirror(record, file.modifiedAt)
        const key = mirror ? codexChatMirrorKey(mirror) : null
        if (key) keys.add(key)
    }

    return keys
}

function isMirroredCodexEventMessage(
    record: CodexRecord,
    responseItemMirrorKeys: Set<string>,
    fallbackCreatedAt: number
): boolean {
    if (record.type !== 'event_msg') return false
    if (responseItemMirrorKeys.size === 0) return false

    const payload = asRecord(record.payload)
    if (payload?.type !== 'user_message' && payload?.type !== 'agent_message')
        return false

    const mirror = extractCodexChatMirror(record, fallbackCreatedAt)
    const key = mirror ? codexChatMirrorKey(mirror) : null
    return key ? responseItemMirrorKeys.has(key) : false
}

function buildImportedUserMessage(
    sourceKey: string,
    createdAt: number,
    text: string
): RunnerImportedSessionMessage {
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

function buildImportedAgentMessage(
    sourceKey: string,
    createdAt: number,
    data: unknown
): RunnerImportedSessionMessage {
    return {
        sourceKey,
        createdAt,
        message: {
            role: 'agent',
            content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data },
            meta: { sentFrom: 'cli', importSourceKey: sourceKey }
        }
    }
}

function convertCodexRecordToImportedMessage(
    file: CodexSessionFile,
    record: CodexRecord,
    sessionId: string,
    fallbackCreatedAt: number,
    lineOffset: number
): RunnerImportedSessionMessage | null {
    const payload = asRecord(record.payload)
    if (!payload) return null

    const sourceKey = codexSourceKey(file, sessionId, record, lineOffset)
    const createdAt = eventTimestampMs(record, fallbackCreatedAt)
    const id = stableCodexItemId(sourceKey)

    if (record.type === 'event_msg') {
        const eventType = asString(payload.type)
        if (!eventType) return null

        if (eventType === 'user_message') {
            const text =
                asString(payload.message) ??
                asString(payload.text) ??
                asString(payload.content)
            if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
            return buildImportedUserMessage(sourceKey, createdAt, text)
        }

        if (eventType === 'agent_message') {
            const message = asString(payload.message)
            return message
                ? buildImportedAgentMessage(sourceKey, createdAt, {
                      type: 'message',
                      message,
                      id
                  })
                : null
        }

        if (eventType === 'agent_reasoning') {
            const message = asString(payload.text) ?? asString(payload.message)
            return message
                ? buildImportedAgentMessage(sourceKey, createdAt, {
                      type: 'reasoning',
                      message,
                      id
                  })
                : null
        }

        if (eventType === 'agent_reasoning_delta') {
            const delta =
                asString(payload.delta) ??
                asString(payload.text) ??
                asString(payload.message)
            return delta
                ? buildImportedAgentMessage(sourceKey, createdAt, {
                      type: 'reasoning-delta',
                      delta
                  })
                : null
        }

        if (eventType === 'token_count') {
            const info = asRecord(payload.info)
            return info
                ? buildImportedAgentMessage(sourceKey, createdAt, {
                      type: 'token_count',
                      info,
                      id
                  })
                : null
        }

        return null
    }

    if (record.type === 'response_item') {
        const itemType = asString(payload.type)
        if (!itemType) return null

        if (itemType === 'message') {
            const role = asString(payload.role)
            const text = extractCodexText(payload.content)
            if (!text || shouldIgnoreSyntheticUserMessage(text)) return null
            if (role === 'user') {
                return buildImportedUserMessage(sourceKey, createdAt, text)
            }
            if (role === 'assistant') {
                return buildImportedAgentMessage(sourceKey, createdAt, {
                    type: 'message',
                    message: text,
                    id
                })
            }
            return null
        }

        if (itemType === 'function_call') {
            const name = asString(payload.name)
            const callId = extractCodexToolCallId(payload)
            if (!name || !callId) return null
            return buildImportedAgentMessage(sourceKey, createdAt, {
                type: 'tool-call',
                name,
                callId,
                input: parseCodexFunctionArguments(payload.arguments),
                id
            })
        }

        if (itemType === 'function_call_output') {
            const callId = extractCodexToolCallId(payload)
            if (!callId) return null
            return buildImportedAgentMessage(sourceKey, createdAt, {
                type: 'tool-call-result',
                callId,
                output: payload.output,
                id
            })
        }
    }

    return null
}

function truncateForSummary(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function titleFromSummaryParts(options: {
    cwd: string | null
    sessionId: string
    changedTitle: string | null
    firstUserMessage: string | null
    lastUserMessage: string | null
}): string {
    const title =
        options.changedTitle ??
        options.firstUserMessage ??
        options.lastUserMessage ??
        (options.cwd ? basename(options.cwd) : null) ??
        options.sessionId.slice(0, 8)
    return truncateForSummary(title, 80) || options.sessionId.slice(0, 8)
}

async function scanCodexSessionSummary(
    file: CodexSessionFile
): Promise<SummaryWithFile | null> {
    const head = await readCodexHeadMetadata(file)
    if (!head || head.isSubagent) return null
    const sessionId = head.sessionId ?? file.sessionIdHint
    if (!sessionId) return null

    let cwd = head.cwd
    let changedTitle: string | null = null
    let lastUserMessage: string | null = null
    let messageCount = 0
    let responseItemMirrorKeys = new Set<string>()

    try {
        responseItemMirrorKeys = await collectCodexResponseItemMirrorKeys(file)

        for await (const line of readJsonlLines(file.filePath)) {
            const record = parseCodexRecord(line.text)
            if (!record) continue

            if (record.type === 'session_meta') {
                const payload = asRecord(record.payload)
                if (
                    typeof payload?.cwd === 'string' &&
                    payload.cwd.trim() &&
                    payload.cwd.trim() !== cwd
                ) {
                    cwd = payload.cwd.trim()
                }
            }

            const title = extractCodexChangedTitle(record)
            if (title) changedTitle = title

            if (
                isMirroredCodexEventMessage(
                    record,
                    responseItemMirrorKeys,
                    file.modifiedAt
                )
            ) {
                continue
            }

            const imported = convertCodexRecordToImportedMessage(
                file,
                record,
                sessionId,
                file.modifiedAt,
                line.startOffset
            )
            if (!imported) continue
            messageCount += 1
            if (imported.message.role === 'user') {
                const content = imported.message.content as {
                    type?: unknown
                    text?: unknown
                }
                if (
                    content.type === 'text' &&
                    typeof content.text === 'string' &&
                    content.text.trim()
                ) {
                    lastUserMessage = truncateForSummary(
                        content.text.trim(),
                        200
                    )
                }
            }
        }
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to scan Codex session file', {
            filePath: file.filePath,
            error
        })
        return null
    }

    if (messageCount === 0) return null

    return {
        file,
        responseItemMirrorKeys,
        summary: {
            id: sessionId,
            flavor: 'codex',
            title: titleFromSummaryParts({
                cwd,
                sessionId,
                changedTitle,
                firstUserMessage: head.firstUserMessage,
                lastUserMessage
            }),
            cwd,
            lastUserMessage,
            modifiedAt: file.modifiedAt,
            messageCount,
            byteSize: file.byteSize
        }
    }
}

async function verifyCursorFile(
    file: CodexSessionFile,
    sessionId: string
): Promise<boolean> {
    const head = await readCodexHeadMetadata(file)
    if (!head || head.isSubagent) return false
    if ((head.sessionId ?? file.sessionIdHint) !== sessionId) return false
    return true
}

async function findCodexSessionForImport(
    sessionId: string
): Promise<SummaryWithFile | null> {
    const files = await collectCodexSessionFiles()
    const directMatches = files.filter(
        (file) => file.sessionIdHint === sessionId
    )
    const candidates = directMatches.length > 0 ? directMatches : files

    for (const file of candidates) {
        const scanned = await scanCodexSessionSummary(file)
        if (scanned?.summary.id === sessionId) return scanned
    }

    return null
}

async function readCodexSessionMessagePage(
    file: CodexSessionFile,
    summary: RunnerImportableSessionSummary,
    offset: number,
    limit: number,
    responseItemMirrorKeys: Set<string>
): Promise<{
    messages: RunnerImportedSessionMessage[]
    nextOffset: number
    done: boolean
}> {
    const messages: RunnerImportedSessionMessage[] = []
    let nextOffset = offset

    try {
        for await (const line of readJsonlLines(file.filePath, offset)) {
            nextOffset = line.nextOffset
            const record = parseCodexRecord(line.text)
            if (!record) continue
            if (
                isMirroredCodexEventMessage(
                    record,
                    responseItemMirrorKeys,
                    file.modifiedAt
                )
            ) {
                continue
            }
            const imported = convertCodexRecordToImportedMessage(
                file,
                record,
                summary.id,
                file.modifiedAt,
                line.startOffset
            )
            if (!imported) continue
            messages.push(imported)
            if (messages.length >= limit) break
        }
    } catch (error) {
        logger.debug('[RUNNER IMPORT] Failed to read Codex session page', {
            filePath: file.filePath,
            offset,
            error
        })
        throw error
    }

    return {
        messages,
        nextOffset,
        done: nextOffset >= file.byteSize
    }
}

export async function listCodexImportableSessions(
    options: CodexImportOptions = {}
): Promise<RunnerImportableSessionSummary[]> {
    const maxSessions = options.maxFiles ?? DEFAULT_MAX_LISTED_SESSIONS
    const files = await collectCodexSessionFiles()
    const summaries: RunnerImportableSessionSummary[] = []
    const seenSessionIds = new Set<string>()

    for (const file of files) {
        const scanned = await scanCodexSessionSummary(file)
        if (!scanned) continue
        if (seenSessionIds.has(scanned.summary.id)) continue
        seenSessionIds.add(scanned.summary.id)
        summaries.push(scanned.summary)
        if (summaries.length >= maxSessions) break
    }

    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export async function getCodexSessionImportPage(
    request: RunnerImportSessionPageRequest,
    options: CodexImportOptions = {}
): Promise<RunnerImportedSessionPage> {
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT

    if (request.cursor) {
        const cursor = decodeCursor(request.cursor)
        if (!cursor || cursor.sessionId !== request.sessionId) {
            throw new Error('Invalid import cursor')
        }

        const file = await fileFromCursor(cursor)
        if (!file) throw new Error('Codex session transcript no longer exists')
        if (cursor.nextOffset > file.byteSize)
            throw new Error(
                'Codex session transcript changed; refresh and retry'
            )
        if (!(await verifyCursorFile(file, cursor.sessionId))) {
            throw new Error(
                'Codex session transcript changed; refresh and retry'
            )
        }

        const summary: RunnerImportableSessionSummary = {
            id: cursor.sessionId,
            flavor: 'codex',
            title: cursor.title,
            cwd: cursor.cwd,
            lastUserMessage: cursor.lastUserMessage,
            modifiedAt: file.modifiedAt,
            messageCount: cursor.totalMessages,
            byteSize: file.byteSize
        }
        const responseItemMirrorKeys =
            await collectCodexResponseItemMirrorKeys(file)
        const page = await readCodexSessionMessagePage(
            file,
            summary,
            cursor.nextOffset,
            limit,
            responseItemMirrorKeys
        )
        return {
            ...summary,
            totalMessages: cursor.totalMessages,
            messages: page.messages,
            nextCursor: page.done
                ? null
                : cursorFromSummary(file, summary, page.nextOffset),
            done: page.done
        }
    }

    const scanned = await findCodexSessionForImport(request.sessionId)
    if (!scanned) {
        throw new Error('Codex session not found on runner')
    }

    const page = await readCodexSessionMessagePage(
        scanned.file,
        scanned.summary,
        0,
        limit,
        scanned.responseItemMirrorKeys
    )
    return {
        ...scanned.summary,
        totalMessages: scanned.summary.messageCount ?? 0,
        messages: page.messages,
        nextCursor: page.done
            ? null
            : cursorFromSummary(scanned.file, scanned.summary, page.nextOffset),
        done: page.done
    }
}
