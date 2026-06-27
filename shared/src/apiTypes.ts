import { z } from 'zod'
import {
    AttachmentMetadataSchema,
    CodexCollaborationModeSchema,
    DecryptedMessageSchema,
    MachineSchema,
    PermissionModeSchema,
    SessionSchema
} from './schemas'
import { AgentFlavorSchema } from './modes'
import type {
    DecryptedMessage,
    Machine,
    Session
} from './schemas'
import type { SessionSummary } from './sessionSummary'

export const CreateOrLoadSessionRequestSchema = z.object({
    tag: z.string().min(1),
    metadata: z.unknown(),
    agentState: z.unknown().nullable().optional(),
    model: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    effort: z.string().optional()
})

export type CreateOrLoadSessionRequest = z.infer<typeof CreateOrLoadSessionRequestSchema>

export const CreateOrLoadMachineRequestSchema = z.object({
    id: z.string().min(1),
    metadata: z.unknown(),
    runnerState: z.unknown().nullable().optional()
})

export type CreateOrLoadMachineRequest = z.infer<typeof CreateOrLoadMachineRequestSchema>

export const CliMessagesResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        localId: z.string().nullable().optional(),
        content: z.unknown()
    }))
})

export type CliMessagesResponse = z.infer<typeof CliMessagesResponseSchema>

export const CreateSessionResponseSchema = z.object({
    session: SessionSchema
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const CreateMachineResponseSchema = z.object({
    machine: MachineSchema
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const GetSessionResponseSchema = CreateSessionResponseSchema
export type GetSessionResponse = CreateSessionResponse

export type AuthResponse = {
    token: string
    user: {
        id: number
        username?: string
        firstName?: string
        lastName?: string
    }
}

export type SessionsResponse = { sessions: SessionSummary[] }
export type SessionResponse = { session: Session }
export type MessagesResponse = {
    messages: DecryptedMessage[]
    page: {
        limit: number
        nextBeforeSeq: number | null
        nextBeforeAt: number | null
        hasMore: boolean
    }
}

export type MachinesResponse = { machines: Machine[] }

export type SpawnResponse =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; message: string }

export const RunnerImportFlavorSchema = z.enum(['claude', 'codex', 'opencode'])
export type RunnerImportFlavor = z.infer<typeof RunnerImportFlavorSchema>

export const RunnerImportableSessionsRequestSchema = z.object({
    flavor: RunnerImportFlavorSchema.optional().default('claude'),
    refresh: z.boolean().optional().default(false)
})

export type RunnerImportableSessionsRequest = z.infer<typeof RunnerImportableSessionsRequestSchema>

export const RunnerImportableSessionSummarySchema = z.object({
    id: z.string().min(1),
    flavor: RunnerImportFlavorSchema,
    title: z.string().min(1),
    cwd: z.string().nullable().optional(),
    lastUserMessage: z.string().nullable().optional(),
    modifiedAt: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative().optional(),
    byteSize: z.number().int().nonnegative().optional()
})

export type RunnerImportableSessionSummary = z.infer<typeof RunnerImportableSessionSummarySchema>

export const RunnerImportableSessionsResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        sessions: z.array(RunnerImportableSessionSummarySchema),
        cachedAt: z.number().int().nonnegative().optional(),
        refreshing: z.boolean().optional(),
        refreshStartedAt: z.number().int().nonnegative().optional(),
        refreshError: z.string().optional()
    }),
    z.object({
        success: z.literal(false),
        error: z.string()
    })
])

export type RunnerImportableSessionsResponse = z.infer<typeof RunnerImportableSessionsResponseSchema>

export const RunnerImportSessionsRequestSchema = z.object({
    flavor: RunnerImportFlavorSchema.optional().default('claude'),
    sessionIds: z.array(z.string().min(1)).min(1).max(50),
    pageSize: z.number().int().min(1).max(500).optional().default(100)
})

export type RunnerImportSessionsRequest = z.infer<typeof RunnerImportSessionsRequestSchema>

export const RunnerImportedSessionMessageSchema = z.object({
    sourceKey: z.string().min(1),
    createdAt: z.number().int().nonnegative().optional(),
    message: z.object({
        role: z.enum(['user', 'agent']),
        content: z.unknown(),
        meta: z.record(z.string(), z.unknown()).optional()
    })
})

export type RunnerImportedSessionMessage = z.infer<typeof RunnerImportedSessionMessageSchema>

export const RunnerImportedSessionPayloadSchema = RunnerImportableSessionSummarySchema.extend({
    messages: z.array(RunnerImportedSessionMessageSchema)
})

export type RunnerImportedSessionPayload = z.infer<typeof RunnerImportedSessionPayloadSchema>

export const RunnerImportSessionPageRequestSchema = z.object({
    flavor: RunnerImportFlavorSchema.optional().default('claude'),
    sessionId: z.string().min(1),
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional().default(100)
})

export type RunnerImportSessionPageRequest = z.infer<typeof RunnerImportSessionPageRequestSchema>

export const RunnerImportedSessionPageSchema = RunnerImportedSessionPayloadSchema.extend({
    totalMessages: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).nullable().optional(),
    done: z.boolean()
})

export type RunnerImportedSessionPage = z.infer<typeof RunnerImportedSessionPageSchema>

export const RunnerImportSessionPageResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        page: RunnerImportedSessionPageSchema
    }),
    z.object({
        success: z.literal(false),
        error: z.string()
    })
])

export type RunnerImportSessionPageResponse = z.infer<typeof RunnerImportSessionPageResponseSchema>

export const RunnerImportSessionResultSchema = z.object({
    agentSessionId: z.string().min(1),
    hapiSessionId: z.string().optional(),
    created: z.boolean().optional(),
    appendedMessages: z.number().int().nonnegative().optional(),
    skippedMessages: z.number().int().nonnegative().optional(),
    error: z.string().optional()
})

export type RunnerImportSessionResult = z.infer<typeof RunnerImportSessionResultSchema>

export const RunnerImportSessionsResponseSchema = z.union([
    z.object({
        success: z.literal(true),
        importedCount: z.number().int().nonnegative(),
        results: z.array(RunnerImportSessionResultSchema)
    }),
    z.object({
        success: z.literal(false),
        error: z.string()
    })
])

export type RunnerImportSessionsResponse = z.infer<typeof RunnerImportSessionsResponseSchema>

export const SessionPermissionModeRequestSchema = z.object({
    mode: PermissionModeSchema
})

export type SessionPermissionModeRequest = z.infer<typeof SessionPermissionModeRequestSchema>

export const ResumeSessionRequestSchema = z.object({
    permissionMode: PermissionModeSchema.optional()
})

export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>

export const ReopenSessionResponseSchema = z.object({
    ok: z.literal(true),
    sessionId: z.string(),
    resumed: z.boolean(),
    cursorSessionProtocol: z.enum(['acp', 'stream-json']).optional()
})

export type ReopenSessionResponse = z.infer<typeof ReopenSessionResponseSchema>

export const ReopenSessionMissingMetadataResponseSchema = z.object({
    error: z.string(),
    missing: z.array(z.string()).nonempty()
})

export type ReopenSessionMissingMetadataResponse = z.infer<typeof ReopenSessionMissingMetadataResponseSchema>

export const SessionCollaborationModeRequestSchema = z.object({
    mode: CodexCollaborationModeSchema
})

export type SessionCollaborationModeRequest = z.infer<typeof SessionCollaborationModeRequestSchema>

export const SessionModelRequestSchema = z.object({
    model: z.union([
        z.string().trim().min(1),
        z.object({
            provider: z.string().trim().min(1),
            modelId: z.string().trim().min(1),
        }),
    ]).nullable()
})

export type SessionModelRequest = z.infer<typeof SessionModelRequestSchema>

export const SessionModelReasoningEffortRequestSchema = z.object({
    modelReasoningEffort: z.string().trim().min(1).nullable()
})

export type SessionModelReasoningEffortRequest = z.infer<typeof SessionModelReasoningEffortRequestSchema>

export const SessionEffortRequestSchema = z.object({
    effort: z.string().trim().min(1).nullable()
})

export type SessionEffortRequest = z.infer<typeof SessionEffortRequestSchema>

// Fast mode is an explicit two-way choice. `'standard'` (not `null`) is the
// stored sentinel for an explicit Fast-off so it stays distinct from
// "untouched" and survives restart/resume. Reject anything else so stray tier
// strings are never forwarded to the Codex app-server.
export const SessionServiceTierRequestSchema = z.object({
    serviceTier: z.enum(['fast', 'standard'])
})

export type SessionServiceTierRequest = z.infer<typeof SessionServiceTierRequestSchema>

export const RenameSessionRequestSchema = z.object({
    name: z.string().min(1).max(255)
})

export type RenameSessionRequest = z.infer<typeof RenameSessionRequestSchema>

/** Per-session legacy stream-json → ACP migrator request. See tiann/hapi#824. */
export const CursorMigrateToAcpRequestSchema = z.object({
    /** Skip removing the legacy ~/.cursor/chats source store.db even after verify passes. */
    keepSource: z.boolean().optional(),
    /** Allow migrating a session whose lifecycleState === 'running' by archiving it first. */
    forceArchiveRunning: z.boolean().optional(),
    /** Skip the verify-by-prompt step (session/load alone is run). */
    skipVerify: z.boolean().optional()
})

export type CursorMigrateToAcpRequest = z.infer<typeof CursorMigrateToAcpRequestSchema>

export type CursorMigrateOutcome =
    | { ok: true; sessionId: string; acpSessionId: string; replayNotifications: number; durationMs: number; lastUsedModelPreserved: string | null; sourceRemoved: boolean }
    | { ok: false; sessionId: string; reason: CursorMigrateRefusalReason; message: string; durationMs: number }

export type CursorMigrateRefusalReason =
    | 'not_cursor_session'
    | 'already_acp'
    | 'running_refused'
    | 'no_cursor_session_id'
    | 'no_legacy_store_on_disk'
    | 'target_already_exists'
    | 'verify_load_failed'
    | 'verify_prompt_failed'
    | 'metadata_write_failed'
    | 'archive_failed'
    | 'lock_release_timeout'
    | 'acp_transport_active'
    | 'session_resumed_during_migrate'
    | 'legacy_store_modified_during_migrate'
    | 'cross_host_session'
    | 'ambiguous_legacy_store'
    | 'size_mismatch'
    | 'internal_error'

export const UploadFileRequestSchema = z.object({
    filename: z.string().min(1).max(255),
    content: z.string().min(1),
    mimeType: z.string().min(1).max(255)
})

export type UploadFileRequest = z.infer<typeof UploadFileRequestSchema>

export const DeleteUploadRequestSchema = z.object({
    path: z.string().min(1)
})

export type DeleteUploadRequest = z.infer<typeof DeleteUploadRequestSchema>

export const MessagesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    beforeSeq: z.coerce.number().int().min(1).optional(),
    beforeAt: z.coerce.number().int().min(0).optional(),
}).refine((data) => (data.beforeAt === undefined) === (data.beforeSeq === undefined), {
    message: 'beforeAt and beforeSeq must be provided together',
    path: ['beforeAt'],
})

export type MessagesQuery = z.infer<typeof MessagesQuerySchema>

export const SendMessageRequestSchema = z.object({
    text: z.string(),
    localId: z.string().min(1).optional(),
    attachments: z.array(AttachmentMetadataSchema).optional(),
    scheduledAt: z.number().int().positive().nullable().optional()
}).refine(
    (data) => data.scheduledAt == null || typeof data.localId === 'string',
    { message: 'scheduledAt requires localId', path: ['localId'] }
).refine(
    (data) => data.scheduledAt == null || data.scheduledAt <= Date.now() + 7 * 24 * 60 * 60 * 1000,
    { message: 'scheduledAt must be within 7 days from now', path: ['scheduledAt'] }
).refine(
    (data) => data.scheduledAt == null || !data.attachments?.length,
    { message: 'scheduled messages with attachments are not supported', path: ['attachments'] }
)

export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>

export const SpawnSessionRequestSchema = z.object({
    directory: z.string().min(1),
    agent: AgentFlavorSchema.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    modelReasoningEffort: z.string().optional(),
    yolo: z.boolean().optional(),
    sessionType: z.enum(['simple', 'worktree']).optional(),
    worktreeName: z.string().optional()
})

export type SpawnSessionRequest = z.infer<typeof SpawnSessionRequestSchema>

export const MachineListDirectoryRequestSchema = z.object({
    path: z.string().min(1)
})

export type MachineListDirectoryRequest = z.infer<typeof MachineListDirectoryRequestSchema>

export const MachinePathsExistsRequestSchema = z.object({
    paths: z.array(z.string().min(1)).max(1000)
})

export type MachinePathsExistsRequest = z.infer<typeof MachinePathsExistsRequestSchema>

export const AuthRequestSchema = z.union([
    z.object({ initData: z.string() }),
    z.object({ accessToken: z.string() })
])

export type AuthRequest = z.infer<typeof AuthRequestSchema>

export type CommandResponse = {
    success: boolean
    stdout?: string
    stderr?: string
    exitCode?: number
    error?: string
}

export type GitCommandResponse = CommandResponse

export type FileReadResponse = {
    success: boolean
    content?: string
    error?: string
}

export type GeneratedImageResponse = {
    success: boolean
    content?: string
    mimeType?: string
    fileName?: string
    error?: string
}

export type UploadFileResponse = {
    success: boolean
    path?: string
    error?: string
}

export type DeleteUploadResponse = {
    success: boolean
    error?: string
}

export type DirectoryEntry = {
    name: string
    type: 'file' | 'directory' | 'other'
    size?: number
    modified?: number
}

export type ListDirectoryResponse = {
    success: boolean
    entries?: DirectoryEntry[]
    error?: string
}

export type RpcListDirectoryResponse = ListDirectoryResponse

export type MachineDirectoryEntry = DirectoryEntry & {
    isGitRepo?: boolean
}

export type MachineListDirectoryResponse = {
    success: boolean
    entries?: MachineDirectoryEntry[]
    error?: string
}

export type PathExistsResponse = {
    exists: Record<string, boolean>
}

export type MachinePathsExistsResponse = PathExistsResponse

export type CodexModelSummary = {
    id: string
    displayName: string
    isDefault: boolean
    defaultReasoningEffort?: string | null
    supportedReasoningEfforts?: string[]
    /** Service tier ids advertised for this model in the current auth/plan context (e.g. 'fast'). */
    serviceTiers?: string[]
}

export type CodexModelsResponse = {
    success: boolean
    models?: CodexModelSummary[]
    error?: string
}

export type ListCodexModelsResponse = CodexModelsResponse

export type OpencodeModelSummary = {
    modelId: string
    name?: string
}

export type OpencodeModelsResponse = {
    success: boolean
    availableModels?: OpencodeModelSummary[]
    /** CLI `agent --list-models` skus grouped under ACP wire bases for variant pickers. */
    cliModelSkus?: OpencodeModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListOpencodeModelsResponse = OpencodeModelsResponse

export type OpencodeReasoningEffortOption = {
    value: string
    name?: string
}

export type OpencodeReasoningEffortResponse = {
    success: boolean
    options?: OpencodeReasoningEffortOption[]
    currentValue?: string | null
    error?: string
}

export type CursorModelSummary = OpencodeModelSummary

export type CursorModelsResponse = OpencodeModelsResponse

export type ListCursorModelsResponse = CursorModelsResponse

/** Maps thinking levels to provider-specific values. null = unsupported. */
export type PiThinkingLevelMap = Partial<Record<string, string | null>>

export type PiModelSummary = {
    provider: string
    modelId: string
    name?: string
    contextWindow?: number
    /** Whether the model supports reasoning/thinking */
    reasoning?: boolean
    /** Maps Pi thinking levels to provider values; null = unsupported level */
    thinkingLevelMap?: PiThinkingLevelMap
}

export type PiModelsResponse = {
    success: boolean
    availableModels?: PiModelSummary[]
    currentModelId?: string | null
    error?: string
}

export type ListPiModelsResponse = PiModelsResponse

export type PiCommandSummary = {
    name: string
    description?: string
    source: 'extension' | 'prompt' | 'skill'
}

export type PiCommandsResponse = {
    success: boolean
    commands?: PiCommandSummary[]
    error?: string
}

export type SlashCommand = {
    name: string
    description?: string
    source: 'builtin' | 'user' | 'plugin' | 'project'
    content?: string
    pluginName?: string
}

export type SlashCommandsResponse = {
    success: boolean
    commands?: SlashCommand[]
    error?: string
}
