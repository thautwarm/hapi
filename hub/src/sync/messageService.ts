import {
    HAPI_SESSION_EXPORT_SCHEMA_VERSION,
    SESSION_EXPORT_MESSAGE_LIMIT,
    type HapiSessionExportResult
} from '@hapi/protocol/sessionExport'
import type { MessageStagePageSummary, MessageStageSummary, MessageStagesResponse, MessagesResponse } from '@hapi/protocol/apiTypes'
import type { AttachmentMetadata, DecryptedMessage, Session } from '@hapi/protocol/types'
import {
    isClaudeChatVisibleMessage,
    isRedundantGoalStatusEventContent,
    unwrapRoleWrappedRecordEnvelope
} from '@hapi/protocol/messages'
import { isObject } from '@hapi/protocol'
import type { Server } from 'socket.io'
import { randomUUID } from 'node:crypto'
import type { Store, CancelQueuedMessageResult } from '../store'
import { EventPublisher } from './eventPublisher'

type StoredMessageForDelivery = ReturnType<Store['messages']['getMessages']>[number]

type InternalMessageStage = MessageStageSummary & {
    endExclusiveSeq: number | null
    endExclusiveAt: number | null
}

type InternalMessageStagesResponse = Omit<MessageStagesResponse, 'stages'> & {
    stages: InternalMessageStage[]
}

const DEFAULT_MESSAGE_STAGES_PER_PAGE = 8
const MAX_STAGE_TITLE_LENGTH = 96

function isWebVisibleStoredMessage(message: StoredMessageForDelivery): boolean {
    return !isRedundantGoalStatusEventContent(message.content)
}

function toDecryptedMessage(message: StoredMessageForDelivery): DecryptedMessage {
    return {
        id: message.id,
        seq: message.seq,
        localId: message.localId,
        content: message.content,
        createdAt: message.createdAt,
        invokedAt: message.invokedAt,
        scheduledAt: message.scheduledAt
    }
}

function toVisibleDecryptedMessages(messages: StoredMessageForDelivery[]): DecryptedMessage[] {
    return messages.filter(isWebVisibleStoredMessage).map(toDecryptedMessage)
}

function getMessagePositionAt(message: StoredMessageForDelivery): number {
    return message.invokedAt ?? message.createdAt
}

function compareStoredMessagesByPosition(a: StoredMessageForDelivery, b: StoredMessageForDelivery): number {
    const at = getMessagePositionAt(a) - getMessagePositionAt(b)
    return at !== 0 ? at : a.seq - b.seq
}

function normalizeStageTitle(value: string): string | null {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length === 0) {
        return null
    }
    if (normalized.length <= MAX_STAGE_TITLE_LENGTH) {
        return normalized
    }
    return `${normalized.slice(0, MAX_STAGE_TITLE_LENGTH - 3).trimEnd()}...`
}

function extractUserMessageText(content: unknown): string | null {
    if (typeof content === 'string') {
        return normalizeStageTitle(content)
    }

    if (Array.isArray(content)) {
        const text = content
            .map((item) => {
                if (!isObject(item) || item.type !== 'text' || typeof item.text !== 'string') {
                    return null
                }
                return item.text
            })
            .filter((value): value is string => value !== null)
            .join(' ')
        return normalizeStageTitle(text)
    }

    if (isObject(content) && content.type === 'text' && typeof content.text === 'string') {
        return normalizeStageTitle(content.text)
    }

    return null
}

function extractUserStageTitle(message: StoredMessageForDelivery): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record?.role !== 'user') {
        return null
    }
    return extractUserMessageText(record.content) ?? 'User message'
}

function normalizeStagesPerPage(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_MESSAGE_STAGES_PER_PAGE
    }
    return Math.max(1, Math.min(50, Math.trunc(value)))
}

function makePageSummaries(stages: readonly InternalMessageStage[]): MessageStagePageSummary[] {
    const byPage = new Map<number, InternalMessageStage[]>()
    for (const stage of stages) {
        const pageStages = byPage.get(stage.page) ?? []
        pageStages.push(stage)
        byPage.set(stage.page, pageStages)
    }

    return Array.from(byPage.entries())
        .sort(([left], [right]) => left - right)
        .map(([page, pageStages]) => ({
            page,
            displayTitle: pageStages[0]?.displayTitle ?? `Page ${page}`,
            stageIds: pageStages.map((stage) => stage.id),
            messageCount: pageStages.reduce((sum, stage) => sum + stage.messageCount, 0)
        }))
}

function toPublicStage(stage: InternalMessageStage): MessageStageSummary {
    return {
        id: stage.id,
        displayTitle: stage.displayTitle,
        page: stage.page,
        startMessageId: stage.startMessageId,
        targetMessageId: stage.targetMessageId,
        startSeq: stage.startSeq,
        startAt: stage.startAt,
        endSeq: stage.endSeq,
        endAt: stage.endAt,
        messageCount: stage.messageCount
    }
}

function isQueuedUserMessage(message: StoredMessageForDelivery): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    return record?.role === 'user' && message.invokedAt === null
}

function isExportVisibleStoredMessage(message: StoredMessageForDelivery): boolean {
    if (!isWebVisibleStoredMessage(message) || isQueuedUserMessage(message)) {
        return false
    }

    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (record?.role !== 'agent') {
        return true
    }

    if (!isObject(record.content) || record.content.type !== 'output') {
        return true
    }

    const data = isObject(record.content.data) ? record.content.data : null
    if (!data) {
        return true
    }

    if (Boolean(data.isMeta) || Boolean(data.isCompactSummary)) {
        return false
    }

    return isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })
}

export class MessageService {
    /** One scheduled-matured SSE per localId per hub process (cleared on cancel/consume paths here). */
    private readonly scheduledMatureNotifiedLocalIds = new Set<string>()

    constructor(
        private readonly store: Store,
        private readonly io: Server,
        private readonly publisher: EventPublisher,
        private readonly onSessionActivity?: (sessionId: string, updatedAt: number) => void
    ) {
    }

    private forgetScheduledMatureNotified(localIds: Iterable<string>): void {
        for (const localId of localIds) {
            this.scheduledMatureNotifiedLocalIds.delete(localId)
        }
    }

    getMessages(sessionId: string, limit: number = 200): DecryptedMessage[] {
        const stored = this.store.messages.getMessages(sessionId, limit)
        return toVisibleDecryptedMessages(stored)
    }

    private buildMessageStages(
        sessionId: string,
        stagesPerPageInput?: number
    ): InternalMessageStagesResponse {
        const stagesPerPage = normalizeStagesPerPage(stagesPerPageInput)
        const userRows = this.store.messages.getUserMessagesByPosition(sessionId)
            .filter(isWebVisibleStoredMessage)
            .filter((row) => extractUserStageTitle(row) !== null)
            .sort(compareStoredMessagesByPosition)

        const firstVisible = this.store.messages.getFirstMessagesByPosition(sessionId, 500)
            .filter(isWebVisibleStoredMessage)[0] ?? null
        const starts = [...userRows]
        if (
            firstVisible
            && (
                starts.length === 0
                || compareStoredMessagesByPosition(firstVisible, starts[0]) < 0
            )
        ) {
            starts.unshift(firstVisible)
        }
        const stages: InternalMessageStage[] = []

        for (let index = 0; index < starts.length; index += 1) {
            const row = starts[index]
            const next = starts[index + 1] ?? null
            const start = { at: getMessagePositionAt(row), seq: row.seq }
            const endExclusive = next
                ? { at: getMessagePositionAt(next), seq: next.seq }
                : null
            const title = extractUserStageTitle(row)
            const last = this.store.messages.getLastMessageByPositionRange(sessionId, start, endExclusive)
            if (!last) {
                continue
            }
            const messageCount = this.store.messages.countMessagesByPositionRange(sessionId, start, endExclusive)
            stages.push({
                id: title !== null ? `stage:${row.id}` : `stage:intro:${row.id}`,
                displayTitle: title ?? 'Session start',
                page: Math.floor(stages.length / stagesPerPage) + 1,
                startMessageId: row.id,
                targetMessageId: title !== null ? `user-text:${row.id}` : null,
                startSeq: row.seq,
                startAt: start.at,
                endSeq: last.seq,
                endAt: getMessagePositionAt(last),
                endExclusiveSeq: endExclusive?.seq ?? null,
                endExclusiveAt: endExclusive?.at ?? null,
                messageCount
            })
        }

        const pages = makePageSummaries(stages)
        return {
            stagesPerPage,
            totalStages: stages.length,
            totalPages: Math.ceil(stages.length / stagesPerPage),
            stages,
            pages
        }
    }

    getMessageStages(
        sessionId: string,
        options: { stagesPerPage?: number } = {}
    ): MessageStagesResponse {
        const { stages, ...rest } = this.buildMessageStages(sessionId, options.stagesPerPage)
        return {
            ...rest,
            stages: stages.map(toPublicStage)
        }
    }

    getMessagesStagePage(
        sessionId: string,
        options: { stagePage: number; stagesPerPage?: number }
    ): MessagesResponse {
        const { stages, pages, stagesPerPage, totalPages, totalStages } = this.buildMessageStages(
            sessionId,
            options.stagesPerPage
        )
        if (totalStages === 0) {
            return {
                messages: [],
                page: {
                    limit: 0,
                    nextBeforeSeq: null,
                    nextBeforeAt: null,
                    hasMore: false,
                    stagePage: {
                        currentPage: 0,
                        totalPages: 0,
                        stagesPerPage,
                        stageIds: [],
                        stages: [],
                        messageStageIds: {}
                    }
                }
            }
        }

        const requestedPage = Number.isFinite(options.stagePage)
            ? Math.trunc(options.stagePage)
            : totalPages
        const currentPage = Math.max(1, Math.min(totalPages, requestedPage))
        const pageStages = stages.filter((stage) => stage.page === currentPage)
        const firstStage = pageStages[0] ?? null
        const lastStage = pageStages[pageStages.length - 1] ?? null
        const endExclusive = lastStage && lastStage.endExclusiveAt !== null && lastStage.endExclusiveSeq !== null
            ? { at: lastStage.endExclusiveAt, seq: lastStage.endExclusiveSeq }
            : null
        const rows = firstStage
            ? this.store.messages.getMessagesByPositionRange(
                sessionId,
                { at: firstStage.startAt, seq: firstStage.startSeq },
                endExclusive
            ).filter(isWebVisibleStoredMessage).sort(compareStoredMessagesByPosition)
            : []
        const messageStageIds: Record<string, string> = {}
        for (const row of rows) {
            const rowAt = getMessagePositionAt(row)
            const stage = pageStages.find((candidate) => {
                if (rowAt < candidate.startAt || (rowAt === candidate.startAt && row.seq < candidate.startSeq)) {
                    return false
                }
                if (candidate.endExclusiveAt === null || candidate.endExclusiveSeq === null) {
                    return true
                }
                return rowAt < candidate.endExclusiveAt
                    || (rowAt === candidate.endExclusiveAt && row.seq < candidate.endExclusiveSeq)
            })
            if (stage) {
                messageStageIds[row.id] = stage.id
            }
        }
        const oldest = rows[0] ?? null

        return {
            messages: toVisibleDecryptedMessages(rows),
            page: {
                limit: rows.length,
                nextBeforeSeq: oldest?.seq ?? null,
                nextBeforeAt: oldest ? getMessagePositionAt(oldest) : null,
                hasMore: currentPage > 1,
                stagePage: {
                    currentPage,
                    totalPages: pages.length,
                    stagesPerPage,
                    stageIds: pageStages.map((stage) => stage.id),
                    stages: pageStages.map(toPublicStage),
                    messageStageIds
                }
            }
        }
    }

    getSessionExport(
        sessionId: string,
        session: Session,
        limit: number = SESSION_EXPORT_MESSAGE_LIMIT
    ): HapiSessionExportResult {
        const messages = this.store.messages.getAllMessages(sessionId)
            .filter(isExportVisibleStoredMessage)
            .sort((a, b) => {
                const aAt = a.invokedAt ?? a.createdAt
                const bAt = b.invokedAt ?? b.createdAt
                return aAt !== bAt ? aAt - bAt : a.seq - b.seq
            })
            .map(toDecryptedMessage)

        if (messages.length > limit) {
            return {
                type: 'too-large',
                count: messages.length,
                limit
            }
        }

        return {
            type: 'success',
            payload: {
                schemaVersion: HAPI_SESSION_EXPORT_SCHEMA_VERSION,
                exportedAt: Date.now(),
                session,
                messages
            }
        }
    }

    getMessagesPage(
        sessionId: string,
        options: { limit: number; before?: { at: number; seq: number } | null }
    ): {
        messages: DecryptedMessage[]
        page: {
            limit: number
            nextBeforeSeq: number | null
            nextBeforeAt: number | null
            hasMore: boolean
        }
    } {
        let before = options.before ?? undefined
        let pageRows = this.store.messages.getMessagesByPosition(sessionId, options.limit, before)

        // Latest-page request (no cursor): also include uninvoked local user messages
        // out-of-band, so refresh / secondary clients can still see queued rows even
        // when their position key (createdAt) places them outside the latest page.
        // The cursor stays anchored to pageRows so out-of-band rows don't affect
        // pagination of older pages.
        let queuedRows = before === undefined
            ? this.store.messages.getUninvokedLocalMessages(sessionId)
            : []

        let byId = new Map<string, typeof pageRows[number]>()
        for (const row of pageRows) byId.set(row.id, row)
        for (const row of queuedRows) byId.set(row.id, row)

        let stored = [...byId.values()].sort((a, b) => {
            const at = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
            return at !== 0 ? at : a.seq - b.seq
        })

        let messages = toVisibleDecryptedMessages(stored)

        // The cursor is the oldest row in the actual position-ordered page (pageRows[0]).
        // Out-of-band queued rows are not part of the cursor — they are pinned to
        // every latest-page response.
        let oldest = pageRows[0] ?? null
        let oldestSeq: number | null = oldest?.seq ?? null
        let oldestPositionAt: number | null = oldest
            ? oldest.invokedAt ?? oldest.createdAt
            : null

        let hasMore = oldestSeq !== null && oldestPositionAt !== null
            && this.store.messages.getMessagesByPosition(
                sessionId,
                1,
                { at: oldestPositionAt, seq: oldestSeq }
            ).length > 0

        while (messages.length === 0 && hasMore && oldestSeq !== null && oldestPositionAt !== null) {
            before = { at: oldestPositionAt, seq: oldestSeq }
            pageRows = this.store.messages.getMessagesByPosition(sessionId, options.limit, before)
            queuedRows = []

            byId = new Map<string, typeof pageRows[number]>()
            for (const row of pageRows) byId.set(row.id, row)
            for (const row of queuedRows) byId.set(row.id, row)

            stored = [...byId.values()].sort((a, b) => {
                const at = (a.invokedAt ?? a.createdAt) - (b.invokedAt ?? b.createdAt)
                return at !== 0 ? at : a.seq - b.seq
            })
            messages = toVisibleDecryptedMessages(stored)

            oldest = pageRows[0] ?? null
            oldestSeq = oldest?.seq ?? null
            oldestPositionAt = oldest
                ? oldest.invokedAt ?? oldest.createdAt
                : null
            hasMore = oldestSeq !== null && oldestPositionAt !== null
                && this.store.messages.getMessagesByPosition(
                    sessionId,
                    1,
                    { at: oldestPositionAt, seq: oldestSeq }
                ).length > 0
        }

        return {
            messages,
            page: {
                limit: options.limit,
                nextBeforeSeq: oldestSeq,
                nextBeforeAt: oldestPositionAt,
                hasMore
            }
        }
    }

    /** CLI reconnect backfill — excludes future-scheduled rows so the runner does
     *  not consume them ahead of their scheduled_at.  See messages.ts:getDeliverableMessagesAfter. */
    getDeliverableMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number; now: number }): DecryptedMessage[] {
        const stored = this.store.messages.getDeliverableMessagesAfter(
            sessionId,
            options.afterSeq,
            options.now,
            options.limit
        )
        return stored.map((message) => ({
            id: message.id,
            seq: message.seq,
            localId: message.localId,
            content: message.content,
            createdAt: message.createdAt,
            invokedAt: message.invokedAt,
            scheduledAt: message.scheduledAt
        }))
    }

    async cancelQueuedMessage(
        sessionId: string,
        messageId: string
    ): Promise<CancelQueuedMessageResult> {
        // Phase 1: look up the row WITHOUT deleting it.
        // This lets us ask the CLI first and only DELETE if the CLI confirms removal.
        const lookup = this.store.messages.lookupQueuedMessage(sessionId, messageId)

        if (lookup.status === 'absent') {
            // Row not found — already cancelled or wrong id.
            return { status: 'cancelled', localId: null }
        }

        if (lookup.status === 'invoked') {
            // DB row already has invoked_at — CLI consumed it before we arrived.
            // Return the full invoked row so the web client can restore authoritative
            // state (with correct invokedAt) instead of a stale queued snapshot.
            return lookup
        }

        // Phase 2: row is still queued.  Ask the CLI whether it already shifted the item
        // (race window between collectBatch() shift and messages-consumed ack).
        const { localId, resolvedId, scheduledAt } = lookup

        if (!localId) {
            // No localId — row exists but has no cancel path; treat as cancelled.
            this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            this.publisher.emit({ type: 'message-cancelled', sessionId, messageId })
            return { status: 'cancelled', localId: null }
        }

        // Phase 2b: future-scheduled messages were never emitted to the CLI, so they
        // are not in the CLI's in-memory queue.  Asking the CLI whether it can remove
        // the item would always return 'not-found', which the normal ack path
        // misinterprets as "CLI already consumed it" and stamps invoked_at.
        // Short-circuit: delete the row directly without a CLI ack round-trip.
        //
        // Single event loop turn: the scheduledAt > now check and the
        // deleteQueuedMessageById call execute atomically with no await between
        // them, so the offline-CLI path's re-check pattern is unnecessary here.
        // The offline path needs the re-check because it awaits the
        // markInvoked between the lookup and the delete.
        const now = Date.now()
        if (scheduledAt !== null && scheduledAt > now) {
            this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            this.forgetScheduledMatureNotified([localId])
            this.publisher.emit({
                type: 'message-cancelled',
                sessionId,
                messageId,
                localId,
            })
            return { status: 'cancelled', localId }
        }

        // Phase 2a: if no CLI socket is currently in the session room, the CLI is
        // offline and there is nobody to ack with.  Delete the row immediately so a
        // later CLI reconnect cannot pick it up via seq-backfill and re-enqueue the
        // cancelled message.
        //
        // TOCTOU note: deleteQueuedMessageById already has an invoked_at IS NULL guard,
        // so if a CLI socket joins between the cliCount read and the DELETE and wins the
        // race by calling markMessagesInvoked first, the DELETE becomes a no-op.
        // We re-read the row after the delete to detect that case and handle it exactly
        // like Race-B (ack returned removed:false).
        const roomName = `session:${sessionId}`
        const cliCount = this.io.of('/cli').adapter.rooms.get(roomName)?.size ?? 0
        if (cliCount === 0) {
            this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
            // Re-check: if CLI joined and invoked the message between our cliCount read
            // and the DELETE, the delete was a no-op and the row now has invoked_at set.
            const recheck = this.store.messages.lookupQueuedMessage(sessionId, resolvedId)
            if (recheck.status === 'invoked') {
                // CLI beat us — treat identically to Race-B (ack returned not-found).
                this.forgetScheduledMatureNotified([localId])
                this.publisher.emit({
                    type: 'messages-consumed',
                    sessionId,
                    localIds: [localId],
                    invokedAt: recheck.message.invokedAt!,
                })
                return recheck
            }
            // Row is gone (absent) — clean cancel.
            this.forgetScheduledMatureNotified([localId])
            this.publisher.emit({
                type: 'message-cancelled',
                sessionId,
                messageId,
                localId,
            })
            return { status: 'cancelled', localId }
        }

        const ackResult = await this.requestCliCancelAck(sessionId, localId, messageId, 500)

        if (ackResult === 'not-found' || ackResult === 'timeout') {
            // CLI could not remove the item — it was already shift()-ed or CLI is
            // offline.  Stamp invoked_at immediately so the message lands in the thread
            // as 'sent' instead of disappearing.  The agent's later assistant message
            // (if it produced one) joins the same thread normally.
            const invokedAt = Date.now()
            try {
                this.store.messages.markMessagesInvoked(sessionId, [localId], invokedAt)
            } catch (err) {
                console.error('cancelQueuedMessage: markMessagesInvoked failed', err)
                // DB write failed — let the HTTP 500 surface to the caller.
                throw err
            }
            this.forgetScheduledMatureNotified([localId])
            // Notify all SSE subscribers (other open tabs) that this queued row is now
            // invoked so they remove it from the floating bar.  Without this emit, only
            // the tab that sent the DELETE request learns about the status change via the
            // HTTP response; every other subscriber keeps the row in the queued bar until
            // a refresh or a later event.  Mirrors the identical publish in the normal
            // CLI-driven path (sessionHandlers.ts messages-consumed handler).
            this.publisher.emit({
                type: 'messages-consumed',
                sessionId,
                localIds: [localId],
                invokedAt,
            })
            // Re-fetch the single row via lookupQueuedMessage to avoid the 200-row
            // pagination cap of getMessages.  After markMessagesInvoked the row will
            // have invoked_at set, so lookupQueuedMessage returns status='invoked'.
            const recheck = this.store.messages.lookupQueuedMessage(sessionId, localId)
            if (recheck.status === 'invoked') {
                return recheck
            }
            // Row absent from DB after markMessagesInvoked — edge case, treat as cancelled
            return { status: 'cancelled', localId }
        }

        // Phase 3: CLI confirmed removal.  Now DELETE the DB row and broadcast SSE.
        this.store.messages.deleteQueuedMessageById(sessionId, resolvedId)
        this.forgetScheduledMatureNotified([localId])
        this.publisher.emit({
            type: 'message-cancelled',
            sessionId,
            messageId
        })

        return { status: 'cancelled', localId }
    }

    /**
     * Ask the CLI (via socket.io ack) whether it removed the in-memory queue item.
     * Returns 'removed', 'not-found', or 'timeout'.
     *
     * Re-uses the existing 'update' event channel with a cancel-queued-message body,
     * matching the ack pattern already used by rpcGateway
     * (socket.timeout(ms).emitWithAck / BroadcastOperator.timeout(ms).emit + ack cb).
     */
    private requestCliCancelAck(
        sessionId: string,
        localId: string,
        messageId: string,
        timeoutMs: number
    ): Promise<'removed' | 'not-found' | 'timeout'> {
        return new Promise((resolve) => {
            const room = this.io.of('/cli').to(`session:${sessionId}`)
            // socket.io v4 BroadcastOperator: .timeout(ms).emit(event, data, ackCb)
            // ack signature: (err: Error | null, responses: T[])
            room.timeout(timeoutMs).emit(
                'update',
                {
                    id: randomUUID(),
                    seq: 0,
                    createdAt: Date.now(),
                    body: {
                        t: 'cancel-queued-message' as const,
                        sid: sessionId,
                        messageId,
                        localId
                    }
                },
                (err: Error | null, responses: Array<{ removed: boolean }>) => {
                    // Check responses before err: in a reconnect overlap or any room with
                    // multiple CLI sockets, Socket.IO may set err (one socket timed out)
                    // while still delivering successful responses from the sockets that did
                    // ack. Any confirmed removal wins over the partial timeout.
                    const removed = responses?.some((r) => r.removed === true) ?? false
                    if (removed) {
                        resolve('removed')
                        return
                    }
                    if (err) {
                        resolve('timeout')
                        return
                    }
                    resolve('not-found')
                }
            )
        })
    }

    async sendMessage(
        sessionId: string,
        payload: {
            text: string
            localId?: string | null
            attachments?: AttachmentMetadata[]
            sentFrom?: 'telegram-bot' | 'webapp'
            scheduledAt?: number | null
        }
    ): Promise<void> {
        // Defence-in-depth invariant for non-REST callers (Telegram bot, MCP,
        // internal callers).  Attachment paths live under the CLI session's
        // upload directory which `cleanupUploadDir` purges on session end; a
        // mature scheduled emit after the CLI exits would dereference deleted
        // files via the @path attachment formatter.  REST already rejects this
        // combination at the Zod layer, but enforcing it here keeps the rule in
        // one structural place — same pattern as `addMessage`'s scheduledAt +
        // !localId throw.
        if (payload.scheduledAt != null && (payload.attachments?.length ?? 0) > 0) {
            throw new Error('sendMessage: scheduled messages with attachments are not supported')
        }

        const sentFrom = payload.sentFrom ?? 'webapp'

        const content = {
            role: 'user',
            content: {
                type: 'text',
                text: payload.text,
                attachments: payload.attachments
            },
            meta: {
                sentFrom
            }
        }

        const msg = this.store.messages.addMessage(
            sessionId,
            content,
            payload.localId ?? undefined,
            payload.scheduledAt ?? null
        )
        this.onSessionActivity?.(sessionId, msg.createdAt)

        // Only emit to CLI if the message is not scheduled for the future.
        // Mature or non-scheduled messages go through immediately; future scheduled
        // messages wait for the 5-second tick in releaseMatureScheduledMessages.
        // Re-measure Date.now() after addMessage to avoid a TOCTOU window where
        // the pre-insert `now` capture could misclassify a borderline scheduledAt
        // as future when it has already become past by the time we check.
        const isFutureScheduled = msg.scheduledAt !== null && msg.scheduledAt > Date.now()
        if (!isFutureScheduled) {
            const update = {
                id: msg.id,
                seq: msg.seq,
                createdAt: msg.createdAt,
                body: {
                    t: 'new-message' as const,
                    sid: sessionId,
                    message: {
                        id: msg.id,
                        seq: msg.seq,
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        content: msg.content
                    }
                }
            }
            this.io.of('/cli').to(`session:${sessionId}`).emit('update', update)
        }

        // Always emit message-received to Web SSE so the floating bar renders.
        this.publisher.emit({
            type: 'message-received',
            sessionId,
            message: {
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                content: msg.content,
                createdAt: msg.createdAt,
                invokedAt: msg.invokedAt,
                scheduledAt: msg.scheduledAt
            }
        })
    }

    /**
     * Force-invoke all immediate-queued messages for a session at session end.
     *
     * Called by sessionHandlers when the CLI sends 'session-end', so that
     * the floating bar is cleared without leaving queued rows pinned forever.
     *
     * **All scheduled rows are intentionally skipped** (mature or future).  The
     * mature-scan path (releaseMatureScheduledMessages) is the sole emit channel
     * for scheduled rows and relies on the CLI ack to write invoked_at; if this
     * sweep stamped a mature scheduled row, a subsequent re-attach would never
     * see the row in the next mature-scan tick and the user's prompt would be
     * silently dropped.  See HAPI Bot R4 finding.
     *
     * Returns the list of localIds that were stamped and the invokedAt timestamp,
     * or null if no messages needed sweeping.
     */
    sweepImmediateQueuedOnSessionEnd(
        sessionId: string,
        invokedAt: number
    ): { localIds: string[]; invokedAt: number } | null {
        const queued = this.store.messages.getImmediateQueuedLocalMessages(sessionId)
        const localIds = queued
            .map((m) => m.localId)
            .filter((id): id is string => typeof id === 'string')
        if (localIds.length === 0) return null
        this.store.messages.markMessagesInvoked(sessionId, localIds, invokedAt)
        this.forgetScheduledMatureNotified(localIds)
        this.publisher.emit({ type: 'messages-consumed', sessionId, localIds, invokedAt })
        return { localIds, invokedAt }
    }

    /** Called by the hub 5-second tick (syncEngine.expireInactive).
     *
     * Finds all scheduled messages whose scheduled_at <= now and emits them to
     * the CLI via socket.io.  Does NOT call markMessagesInvoked — the CLI ack
     * (messages-consumed) handles that.  This means a message is re-emitted on
     * each tick until the CLI acks it, which is the correct behaviour for hub
     * restart scenarios (pitfall #2 guard).
     *
     * Race window with cancel: this tick widens the cancel race to 5 s for
     * scheduled messages (vs near-zero for immediate-queued ones).  If the CLI
     * has already shift()-ed the row when cancel arrives, cancelQueuedMessage
     * gets 'not-found' from the CLI ack and stamps invoked_at (PR #568 contract
     * preserved).  Web client surfaces this as 'sent' in the thread.
     * See messageService.test.ts "cancel × mature race" for the documented
     * expected behaviour. */
    releaseMatureScheduledMessages(now: number): void {
        const mature = this.store.messages.getMatureScheduledMessages(now)
        const maturedSessionIds = new Set<string>()
        for (const msg of mature) {
            const localId = msg.localId
            if (typeof localId === 'string' && !this.scheduledMatureNotifiedLocalIds.has(localId)) {
                this.scheduledMatureNotifiedLocalIds.add(localId)
                maturedSessionIds.add(msg.sessionId)
            }
            const update = {
                id: msg.id,
                seq: msg.seq,
                createdAt: msg.createdAt,
                body: {
                    t: 'new-message' as const,
                    sid: msg.sessionId,
                    message: {
                        id: msg.id,
                        seq: msg.seq,
                        createdAt: msg.createdAt,
                        localId: msg.localId,
                        content: msg.content
                    }
                }
            }
            this.io.of('/cli').to(`session:${msg.sessionId}`).emit('update', update)
            // NOTE: do NOT call markMessagesInvoked here (pitfall #2).
            // CLI ack (messages-consumed) will handle invoked_at stamping.
        }
        for (const sessionId of maturedSessionIds) {
            this.publisher.emit({ type: 'scheduled-matured', sessionId })
        }
    }
}
